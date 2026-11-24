// Cloudflare Worker entrypoint for the PolyTrack mirror.
//
// Static game assets are served from the Workers Assets binding. The one
// dynamic route is `/api/*`, a same-origin proxy to the leaderboard/user
// backend: the browser never talks to the third-party host directly, so the
// page's own origin is the only one a network filter sees.
//
// The proxy is also the leaderboard's origin-side guard:
//   - reads keep the caller's verification filter (see leaderboard-policy.mjs;
//     the shared backend has no verification data, so all rows is the default),
//   - uploads are checked against their own recording before being forwarded,
//   - rows listed in leaderboard-quarantine.mjs are never served.

import {
  sanitizeLeaderboardSearch,
  validateLeaderboardUpload,
  filterLeaderboardPayload,
  parseQuarantine,
} from "./leaderboard-policy.mjs";
import quarantineRows from "./leaderboard-quarantine.mjs";

const API_ORIGIN = "https://polytrack-backend.htmlunblockedgames.workers.dev";
const QUARANTINED = parseQuarantine(quarantineRows);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return proxyApi(request, url);
    }
    return env.ASSETS.fetch(request);
  },
};

function textResponse(status, body, extraHeaders) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function proxyApi(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return textResponse(405, "Method Not Allowed");
  }

  const isLeaderboard = url.pathname === "/api/leaderboard";
  const isRead = request.method === "GET" || request.method === "HEAD";
  const policyHeaders = {};

  // Normalise the verification filter: absent means the full list, because the
  // backend reports no verified rows; an explicit true is passed through.
  let search = url.search;
  if (isLeaderboard && isRead) {
    const sanitized = sanitizeLeaderboardSearch(url.search);
    // URLSearchParams.toString() omits the leading "?".
    search = "?" + sanitized.toString();
    policyHeaders["x-leaderboard-filter"] = sanitized.get("onlyVerified");
  }

  const target = API_ORIGIN + url.pathname.slice("/api".length) + search;
  const headers = new Headers(request.headers);
  // Hop-by-hop and platform headers must not be forwarded upstream.
  for (const name of ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-real-ip"]) {
    headers.delete(name);
  }

  const init = { method: request.method, headers, redirect: "follow" };
  if (request.method === "POST") {
    const body = await request.arrayBuffer();
    if (isLeaderboard && body.byteLength > 0) {
      const verdict = await validateLeaderboardUpload(
        new URLSearchParams(new TextDecoder().decode(body))
      );
      if (!verdict.ok) {
        return textResponse(400, `Rejected by leaderboard policy: ${verdict.reason}`, policyHeaders);
      }
    }
    init.body = body;
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return textResponse(502, "Upstream unavailable");
  }

  const out = new Headers(upstream.headers);
  // fetch() already decoded the body, so the original encoding headers no
  // longer describe it.
  out.delete("content-encoding");
  out.delete("content-length");
  out.set("cache-control", "no-store");
  for (const [name, value] of Object.entries(policyHeaders)) out.set(name, value);

  if (isLeaderboard && isRead && QUARANTINED.size > 0) {
    try {
      const payload = await upstream.json();
      const filtered = filterLeaderboardPayload(payload, QUARANTINED);
      out.set("x-leaderboard-quarantined", String(filtered.removed));
      out.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(filtered.payload), { status: upstream.status, headers: out });
    } catch {
      // Not JSON (or already consumed): fall through to the raw body.
      return new Response(JSON.stringify({ total: 0, entries: [], userEntry: null }), {
        status: 502,
        headers: out,
      });
    }
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}
