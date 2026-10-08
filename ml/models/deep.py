"""SeasonalGRU - a deep global forecaster.

Architecture (per row = medicine x origin x horizon):
  * GRU encoder over the last 16 weeks: scaled units, category demand, store traffic,
    the medicine's seasonal index for each week, and a padding mask.
  * Entity embeddings for medicine, category and dosage form (lets the network learn
    similarity between medicines - Rossmann-style tabular deep learning).
  * Known-future covariates for the target week: season one-hot, week-of-year, festival
    intensity, horizon, and the target-season index.
  * MLP head -> softplus rate, multiplied by the medicine's scale; trained with Poisson NLL.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import torch
from torch import nn

from .. import config as C
from ..device import torch_device
from ..features import SEASON_MODE

FUTURE = ["woy_sin", "woy_cos", "fest_onam", "fest_vishu", "fest_xmas", "target_curve_mult", "curve_shift"]
if SEASON_MODE == "both":   # legacy step-function season inputs alongside the smooth curves
    FUTURE += ["target_med_season_idx", "target_cat_season_idx", "season_shift"]
STATIC = ["log_price", "rx_share", "momentum", "cat_momentum", "nz_8"]


class SeasonalGRU(nn.Module):
    def __init__(self, n_med, n_cat, n_form, n_future, n_static, hidden=48):
        super().__init__()
        self.gru = nn.GRU(5, hidden, num_layers=2, batch_first=True, dropout=0.1)
        self.e_med = nn.Embedding(n_med, 6)
        self.drop_emb = nn.Dropout(0.3)
        self.e_cat = nn.Embedding(n_cat, 6)
        self.e_form = nn.Embedding(n_form, 4)
        self.e_h = nn.Embedding(C.HORIZON + 1, 4)
        self.e_season = nn.Embedding(len(C.SEASON_ORDER), 4)
        d = hidden + 6 + 6 + 4 + 4 + 4 + n_future + n_static
        self.head = nn.Sequential(
            nn.Linear(d, 128), nn.GELU(), nn.Dropout(0.25),
            nn.Linear(128, 64), nn.GELU(),
            nn.Linear(64, 1),
        )

    def forward(self, seq, med, cat, form, h, season, fut, stat):
        _, hN = self.gru(seq)
        z = torch.cat([hN[-1], self.drop_emb(self.e_med(med)), self.e_cat(cat), self.e_form(form), self.e_h(h),
                       self.e_season(season), fut, stat], dim=1)
        return nn.functional.softplus(self.head(z)).squeeze(1)


class DeepForecaster:
    name = "Deep SeasonalGRU"

    def __init__(self, n_med, n_cat, n_form, epochs=12, lr=1e-3, batch=1024):
        self.device = torch.device(torch_device())
        torch.manual_seed(C.SEED)
        np.random.seed(C.SEED)
        if self.device.type == "cuda":
            torch.cuda.manual_seed_all(C.SEED)
            torch.backends.cudnn.deterministic = True    # reproducible GRU kernels
            torch.backends.cudnn.benchmark = False
        else:
            torch.set_num_threads(max(1, torch.get_num_threads()))
        self.net = SeasonalGRU(n_med, n_cat, n_form, len(FUTURE), len(STATIC)).to(self.device)
        self.epochs, self.lr, self.batch = epochs, lr, batch
        self.history: list[dict] = []
        self.best_epoch = epochs

    def _tensors(self, rows: pd.DataFrame, seq: np.ndarray, scale: np.ndarray):
        # The whole dataset fits in GPU memory (~60 MB), so it is moved once instead of per batch.
        tensor = lambda a: torch.from_numpy(np.array(a, copy=True)).to(self.device)
        stat = rows[STATIC].to_numpy(dtype=np.float32)
        return dict(
            seq=tensor(seq),
            med=tensor(rows["med"].to_numpy(np.int64)),
            cat=tensor(rows["category_code"].to_numpy(np.int64)),
            form=tensor(rows["form_code"].to_numpy(np.int64)),
            h=tensor(rows["h"].to_numpy(np.int64)),
            # Smooth mode: the season embedding gets a constant index, so it cannot reintroduce a step.
            season=tensor(rows["season_code"].to_numpy(np.int64) if SEASON_MODE == "both" else np.zeros(len(rows), np.int64)),
            fut=tensor(rows[FUTURE].to_numpy(dtype=np.float32)),
            stat=tensor(np.nan_to_num(stat)),
            scale=tensor(scale[rows["med"].to_numpy()].astype(np.float32)),
        )

    def _predict_t(self, t, idx=None):
        keys = ["seq", "med", "cat", "form", "h", "season", "fut", "stat"]
        args = [t[k] if idx is None else t[k][idx] for k in keys]
        sc = t["scale"] if idx is None else t["scale"][idx]
        return self.net(*args) * sc

    def fit(self, rows, seq, scale, val=None, fixed_epochs: int | None = None):
        t = self._tensors(rows, seq, scale)
        y = torch.from_numpy(np.array(rows["y"].to_numpy(np.float32), copy=True)).to(self.device)
        v = None
        if val is not None:
            vrows, vseq = val
            v = (self._tensors(vrows, vseq, scale), vrows["y"].to_numpy())
        opt = torch.optim.AdamW(self.net.parameters(), lr=self.lr, weight_decay=1e-2)
        epochs = fixed_epochs or self.epochs
        sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=self.lr, total_steps=epochs * (len(y) // self.batch + 1))
        loss_fn = nn.PoissonNLLLoss(log_input=False, full=False)
        g = torch.Generator().manual_seed(C.SEED)
        best, best_state = np.inf, None
        for ep in range(1, epochs + 1):
            self.net.train()
            perm = torch.randperm(len(y), generator=g).to(self.device)
            tot = torch.zeros((), device=self.device)   # summed on-device: no per-batch GPU sync
            for i in range(0, len(y), self.batch):
                b = perm[i: i + self.batch]
                pred = self._predict_t(t, b)
                loss = loss_fn(pred + 1e-6, y[b])
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.net.parameters(), 1.0)
                opt.step()
                sched.step()
                tot += loss.detach() * len(b)
            rec = {"epoch": ep, "train_poisson_nll": float(tot.item()) / len(y)}
            if v is not None:
                p = self._eval(v[0])
                wape = np.abs(p - v[1]).sum() / max(v[1].sum(), 1e-9)
                rec["val_wape"] = float(wape)
                if wape < best:
                    best, self.best_epoch = wape, ep
                    best_state = {k: x.clone() for k, x in self.net.state_dict().items()}
            self.history.append(rec)
        if best_state is not None:
            self.net.load_state_dict(best_state)
        return self

    def _eval(self, t):
        self.net.eval()
        with torch.no_grad():
            return self._predict_t(t).cpu().numpy()

    def predict(self, rows, seq, scale):
        return np.clip(self._eval(self._tensors(rows, seq, scale)), 0, None)
