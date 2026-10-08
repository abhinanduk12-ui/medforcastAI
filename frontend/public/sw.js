/* MedForecast AI service worker (hand-written, no build step).
 *
 * Strategy
 *   /_next/static/*, /icons/*, manifest  -> cache-first (immutable, hashed)
 *   page navigations                     -> network-first, fallback to cached page, then /offline
 *   GET /api/* in API_ALLOW              -> stale-while-revalidate (max age), per user+store cache
 *   /api/auth/me                         -> network-first, cache only as offline fallback
 *   everything else (POST/PUT/PATCH/DELETE, login/logout, other APIs, cross-origin) -> not touched
 *
 * Privacy: API caches are keyed by the signed-in user and selected store (the app posts
 * {type:"SET_USER", key}). Until a key is known nothing from /api is cached. On logout the app
 * posts {type:"LOGOUT"} and every API cache is deleted. A 401/403 also wipes the user's API cache.
 *
 * The pure routing helpers live in MF_SW (exported for node unit tests via module.exports).
 */

var MF_SW = (function () {
  var VERSION = "v1";
  var PREFIX = "mf-";
  var STATIC_CACHE = PREFIX + "static-" + VERSION;
  var PAGES_CACHE = PREFIX + "pages-" + VERSION;
  var API_PREFIX = PREFIX + "api-" + VERSION + "-";
  var META_CACHE = PREFIX + "meta";
  var OFFLINE_URL = "/offline";
  var PRECACHE = [
    OFFLINE_URL,
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/maskable-192.png",
    "/icons/icon.svg",
  ];
  /** Read endpoints that are useful offline (path prefixes, matched on segment boundaries). */
  var API_ALLOW = ["/api/medicines", "/api/pos/catalog", "/api/stock/items", "/api/overview", "/api/auth/me"];
  var API_NEVER = ["/api/auth/login", "/api/auth/logout"];
  var NETWORK_FIRST_API = ["/api/auth/me"];
  /** Session-changing writes: the SW drops its user key the moment one is sent (see "auth-change"). */
  var AUTH_CHANGE = ["/api/auth/login", "/api/auth/logout", "/api/auth/store"];
  var API_MAX_AGE_MS = 24 * 60 * 60 * 1000; // older cached API data is discarded, never served
  var PAGES_MAX_ENTRIES = 40;

  function matchPrefix(path, list) {
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (path === p || path.indexOf(p + "/") === 0) return true;
    }
    return false;
  }

  /**
   * Decide how a request is handled.
   * @param {{method:string, url:string, mode?:string, destination?:string}} req
   * @param {string} origin  the SW origin
   * @returns {"static"|"page"|"api-swr"|"api-network-first"|"auth-change"|"bypass"}
   *   "auth-change" = a non-GET login/logout/store-switch: passed through untouched, but the SW stops
   *   serving/storing API data until the app posts the new user+store key (no cross-user/store reuse).
   */
  function classify(req, origin) {
    var method = (req.method || "GET").toUpperCase();
    var u;
    try { u = new URL(req.url, origin); } catch (e) { return "bypass"; }
    if (u.origin !== origin) return "bypass";
    var path = u.pathname;
    if (method !== "GET") return matchPrefix(path, AUTH_CHANGE) ? "auth-change" : "bypass";
    if (path === "/sw.js") return "bypass";
    if (path.indexOf("/api/") === 0) {
      if (matchPrefix(path, API_NEVER)) return "bypass";
      if (!matchPrefix(path, API_ALLOW)) return "bypass";
      if (u.search.indexOf("_nocache") >= 0) return "bypass";
      return matchPrefix(path, NETWORK_FIRST_API) ? "api-network-first" : "api-swr";
    }
    if (path.indexOf("/_next/static/") === 0 || path.indexOf("/icons/") === 0 || path === "/manifest.webmanifest") return "static";
    if (path.indexOf("/_next/") === 0) return "bypass"; // HMR, data, image optimiser
    if (req.mode === "navigate" || req.destination === "document") return "page";
    return "bypass";
  }

  /** Only plain, successful, same-origin responses that do not forbid storage are cached. */
  function isCacheableResponse(res) {
    if (!res || res.status !== 200) return false;
    if (res.type && res.type !== "basic" && res.type !== "default") return false;
    var cc = (res.headers && res.headers.get && res.headers.get("Cache-Control")) || "";
    // "private" is fine for a per-user cache; "no-store" is a hard stop.
    return !/no-store/i.test(cc);
  }

  function isFresh(cachedAtMs, nowMs, maxAgeMs) {
    var t = Number(cachedAtMs);
    if (!isFinite(t) || t <= 0) return false;
    var age = nowMs - t;
    return age >= 0 && age <= (maxAgeMs == null ? API_MAX_AGE_MS : maxAgeMs);
  }

  /** User/store key -> cache name (sanitised; null when no user is known). */
  function apiCacheName(userKey) {
    if (userKey == null || userKey === "") return null;
    var k = String(userKey).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
    return API_PREFIX + k;
  }

  /** Which existing caches to delete on activate / user change. */
  function cachesToDelete(names, currentApiCache) {
    var keep = [STATIC_CACHE, PAGES_CACHE, META_CACHE];
    if (currentApiCache) keep.push(currentApiCache);
    return names.filter(function (n) { return n.indexOf(PREFIX) === 0 && keep.indexOf(n) < 0; });
  }

  /** Static asset URLs referenced by an HTML document (to precache the offline page's chunks). */
  function extractAssetUrls(html) {
    var out = [];
    var re = /(?:src|href)=["'](\/_next\/static\/[^"'?#]+)["']/g;
    var m;
    while ((m = re.exec(html))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
    return out;
  }

  return {
    VERSION: VERSION, STATIC_CACHE: STATIC_CACHE, PAGES_CACHE: PAGES_CACHE, META_CACHE: META_CACHE,
    API_PREFIX: API_PREFIX, OFFLINE_URL: OFFLINE_URL, PRECACHE: PRECACHE, API_ALLOW: API_ALLOW,
    API_MAX_AGE_MS: API_MAX_AGE_MS, PAGES_MAX_ENTRIES: PAGES_MAX_ENTRIES,
    classify: classify, isCacheableResponse: isCacheableResponse, isFresh: isFresh,
    apiCacheName: apiCacheName, cachesToDelete: cachesToDelete, extractAssetUrls: extractAssetUrls,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = MF_SW;
} else {
  (function (sw) {
    var userKey = null; // "<userId>:<storeId>" posted by the app
    var CACHED_AT = "X-MF-Cached-At";

    function loadUserKey() {
      if (userKey !== null) return Promise.resolve(userKey);
      return caches.open(MF_SW.META_CACHE)
        .then(function (c) { return c.match("/__mf/user"); })
        .then(function (r) { return r ? r.text() : ""; })
        // a LOGOUT/auth-change that landed while we were reading wins over the persisted value
        .then(function (t) { if (userKey === null) userKey = t || ""; return userKey; })
        .catch(function () { if (userKey === null) userKey = ""; return userKey; });
    }

    function saveUserKey(key) {
      userKey = key || "";
      return caches.open(MF_SW.META_CACHE).then(function (c) {
        return c.put("/__mf/user", new Response(userKey, { headers: { "Content-Type": "text/plain" } }));
      });
    }

    function deleteApiCaches(except) {
      return caches.keys().then(function (names) {
        return Promise.all(names
          .filter(function (n) { return n.indexOf(MF_SW.API_PREFIX) === 0 && n !== except; })
          .map(function (n) { return caches.delete(n); }));
      });
    }

    function stamp(res) {
      return res.blob().then(function (body) {
        var h = new Headers(res.headers);
        h.set(CACHED_AT, String(Date.now()));
        return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
      });
    }

    function trim(cacheName, max) {
      return caches.open(cacheName).then(function (c) {
        return c.keys().then(function (keys) {
          if (keys.length <= max) return;
          return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return c.delete(k); }));
        });
      });
    }

    sw.addEventListener("install", function (event) {
      event.waitUntil(caches.open(MF_SW.STATIC_CACHE).then(function (cache) {
        return Promise.all(MF_SW.PRECACHE.map(function (url) {
          return fetch(url, { cache: "reload", credentials: "same-origin" }).then(function (res) {
            if (!res.ok) return;
            var copy = res.clone();
            var put = cache.put(url, res);
            if (url !== MF_SW.OFFLINE_URL) return put;
            // also precache the JS/CSS chunks the offline page needs
            return Promise.all([put, copy.text().then(function (html) {
              var assets = MF_SW.extractAssetUrls(html);
              return Promise.all(assets.map(function (a) { return cache.add(a).catch(function () {}); }));
            })]);
          }).catch(function () { /* best effort: a missing asset must not block install */ });
        }));
      }));
      // No skipWaiting here: the app shows "Update available - reload" and posts SKIP_WAITING.
    });

    sw.addEventListener("activate", function (event) {
      event.waitUntil(loadUserKey().then(function (key) {
        return caches.keys().then(function (names) {
          var del = MF_SW.cachesToDelete(names, MF_SW.apiCacheName(key));
          return Promise.all(del.map(function (n) { return caches.delete(n); }));
        });
      }).then(function () { return sw.clients.claim(); }));
    });

    sw.addEventListener("message", function (event) {
      var data = event.data || {};
      if (data.type === "SKIP_WAITING") { sw.skipWaiting(); return; }
      if (data.type === "LOGOUT" || data.type === "CLEAR_API") {
        event.waitUntil(saveUserKey("").then(function () { return deleteApiCaches(null); }).then(function () {
          if (event.source && event.source.postMessage) event.source.postMessage({ type: "API_CLEARED" });
        }));
        return;
      }
      if (data.type === "SET_USER") {
        var key = typeof data.key === "string" ? data.key : "";
        event.waitUntil(loadUserKey().then(function (prev) {
          if (prev === key) return;
          return saveUserKey(key).then(function () { return deleteApiCaches(MF_SW.apiCacheName(key)); });
        }));
      }
    });

    function staticFirst(req) {
      return caches.open(MF_SW.STATIC_CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (MF_SW.isCacheableResponse(res)) cache.put(req, res.clone());
            return res;
          });
        });
      });
    }

    function pageNetworkFirst(event) {
      var req = event.request;
      return fetch(req).then(function (res) {
        if (MF_SW.isCacheableResponse(res)) {
          var copy = res.clone();
          event.waitUntil(caches.open(MF_SW.PAGES_CACHE)
            .then(function (c) { return c.put(req, copy); })
            .then(function () { return trim(MF_SW.PAGES_CACHE, MF_SW.PAGES_MAX_ENTRIES); }));
        }
        return res;
      }).catch(function () {
        return caches.open(MF_SW.PAGES_CACHE).then(function (c) { return c.match(req, { ignoreSearch: true }); })
          .then(function (hit) { return hit || caches.match(MF_SW.OFFLINE_URL); })
          .then(function (hit) {
            return hit || new Response("<h1>You are offline</h1>", { status: 503, headers: { "Content-Type": "text/html" } });
          });
      });
    }

    function freshCached(cache, req) {
      return cache.match(req).then(function (hit) {
        if (!hit) return null;
        if (MF_SW.isFresh(hit.headers.get(CACHED_AT), Date.now())) return hit;
        return cache.delete(req).then(function () { return null; });
      });
    }

    function networkAndStore(cacheName, req) {
      return fetch(req).then(function (res) {
        if (res.status === 401) { // signed out / session expired: forget the user, not just the data
          return saveUserKey("").then(function () { return deleteApiCaches(null); })
            .then(function () { return res; }, function () { return res; });
        }
        if (res.status === 403) {
          return deleteApiCaches(null).then(function () { return res; }, function () { return res; });
        }
        if (!MF_SW.isCacheableResponse(res)) return res;
        var copy = res.clone();
        return stamp(copy).then(function (stamped) {
          return caches.open(cacheName).then(function (c) {
            // the user may have changed while the request was in flight
            return loadUserKey().then(function (k) { if (MF_SW.apiCacheName(k) === cacheName) return c.put(req, stamped); });
          });
        }).then(function () { return res; }, function () { return res; });
      });
    }

    function offlineJson() {
      return new Response(JSON.stringify({ detail: "You are offline and this data is not cached on this device." }), {
        status: 503, headers: { "Content-Type": "application/json", "X-MF-Offline": "1" },
      });
    }

    function api(event, networkFirst) {
      var req = event.request;
      return loadUserKey().then(function (key) {
        var name = MF_SW.apiCacheName(key);
        if (!name) return fetch(req).catch(function () { return offlineJson(); }); // unknown user: never cache
        return caches.open(name).then(function (cache) {
          if (networkFirst) {
            return networkAndStore(name, req).catch(function () {
              return freshCached(cache, req).then(function (hit) { return hit || offlineJson(); });
            });
          }
          return freshCached(cache, req).then(function (hit) {
            var network = networkAndStore(name, req);
            if (hit) {
              event.waitUntil(network.catch(function () {}));
              return hit;
            }
            return network.catch(function () { return offlineJson(); });
          });
        });
      });
    }

    sw.addEventListener("fetch", function (event) {
      var kind = MF_SW.classify(event.request, sw.location.origin);
      if (kind === "bypass") return;
      if (kind === "auth-change") {
        // Not intercepted (the request goes to the network as-is). Drop the key synchronously so
        // every API request after this one bypasses the cache until SET_USER arrives.
        var isStore = new URL(event.request.url).pathname.indexOf("/api/auth/store") === 0;
        userKey = "";
        event.waitUntil(saveUserKey("").then(function () { return isStore ? null : deleteApiCaches(null); }).catch(function () {}));
        return;
      }
      if (kind === "static") event.respondWith(staticFirst(event.request));
      else if (kind === "page") event.respondWith(pageNetworkFirst(event));
      else if (kind === "api-swr") event.respondWith(api(event, false));
      else if (kind === "api-network-first") event.respondWith(api(event, true));
    });
  })(self);
}
