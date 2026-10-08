"use client";

import { useEffect, useRef, useState } from "react";
import { CameraOff } from "lucide-react";
import { Modal, ghostBtn } from "@/components/auth/Modal";

type Detected = { rawValue: string };
type Detector = { detect: (src: CanvasImageSource) => Promise<Detected[]> };
type DetectorCtor = { new (opts?: { formats?: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };

export function cameraScanSupported(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
}

/** Camera barcode scanning via the BarcodeDetector API (feature-detected; Chrome/Edge on Android & ChromeOS, Safari 17+ partly). */
export function CameraScanner({ open, onClose, onCode }: { open: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const cbRef = useRef(onCode);
  useEffect(() => { cbRef.current = onCode; }, [onCode]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (!cameraScanSupported()) {
      setError("Camera scanning is not supported in this browser. Use a USB/Bluetooth scanner (it types the code + Enter into the barcode box) or type the code.");
      return;
    }
    let stream: MediaStream | null = null;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
        const supported = (await Ctor.getSupportedFormats?.()) ?? [];
        const want = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"].filter((f) => !supported.length || supported.includes(f));
        const det = new Ctor({ formats: want });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stop || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stop || !video.current) return;
          try {
            const res = await det.detect(video.current);
            const code = res.find((r) => r.rawValue)?.rawValue;
            if (code) { cbRef.current(code.trim()); return; }
          } catch { /* frame not ready */ }
          timer = setTimeout(tick, 180);
        };
        void tick();
      } catch (e) {
        setError(`Could not start the camera: ${(e as Error)?.message ?? e}. Check the browser's camera permission (it needs HTTPS or localhost).`);
      }
    })();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Scan with camera" sub="Hold the barcode inside the frame. It adds to the bill automatically." width={480}>
      {error ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-sunken px-5 py-8 text-center">
          <CameraOff className="h-6 w-6 text-ink-3" aria-hidden />
          <p className="text-[13px] leading-relaxed text-ink-2" role="alert">{error}</p>
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-2xl bg-black">
          <video ref={video} className="aspect-[4/3] w-full object-cover" muted playsInline aria-label="Camera preview" />
          <div className="pointer-events-none absolute inset-x-10 top-1/2 h-24 -translate-y-1/2 rounded-xl border-2 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
        </div>
      )}
      <div className="mt-4 flex justify-end"><button className={ghostBtn} onClick={onClose}>Close</button></div>
    </Modal>
  );
}
