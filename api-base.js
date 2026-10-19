/* PolyTrack backend base URL resolver.
 *
 * The Freebuff Sites deployment runs `worker/index.js`, which serves an `/api/`
 * proxy from the page's own origin, so the browser never contacts the
 * third-party backend host directly.
 *
 * A plain static host cannot do that. GitHub Pages (this repo's primary public
 * home), Netlify, Vercel and Cloudflare Pages only serve files, so `/api/...`
 * would 404 and the leaderboard, user profile and recordings would break. On
 * those hosts the game talks to the public backend directly instead.
 *
 * Resolution order:
 *   1. `window.__POLYTRACK_API_BASE__`, if a page set it explicitly beforehand.
 *   2. `/api/` on hosts that run our Worker, plus local development.
 *   3. the public backend everywhere else (static hosts).
 */
(function (global) {
  var PUBLIC_API = "https://polytrack-backend.htmlunblockedgames.workers.dev/";

  // Hosts whose own origin serves the `/api/` proxy from worker/index.js.
  var PROXY_HOST = /(^|\.)freebuff\.page$/i;
  // Local development: scripts/serve.js proxies `/api/` as well.
  var LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i;

  function resolveApiBase(hostname) {
    var host = hostname || "";
    // An empty hostname (file://) keeps the same-origin default rather than
    // inventing a cross-origin backend.
    if (!host || PROXY_HOST.test(host) || LOCAL_HOST.test(host)) return "/api/";
    return PUBLIC_API;
  }

  // Exposed so the test suite can check the mapping without a browser.
  global.__POLYTRACK_RESOLVE_API_BASE__ = resolveApiBase;

  if (!global.__POLYTRACK_API_BASE__) {
    global.__POLYTRACK_API_BASE__ = resolveApiBase(global.location && global.location.hostname);
  }
})(typeof window !== "undefined" ? window : globalThis);
