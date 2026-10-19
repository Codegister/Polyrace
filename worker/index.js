// Cloudflare Worker entrypoint for the PolyTrack mirror.
//
// Static game assets are served from the Workers Assets binding. The one
// dynamic route is `/api/*`, a same-origin proxy to the leaderboard/user
// backend: the browser never talks to the third-party host directly, so the
// page's own origin is the only one a network filter sees.

const API_ORIGIN = "https://polytrack-backend.htmlunblockedgames.workers.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return proxyApi(request, url);
    }
    return env.ASSETS.fetch(request);
  },
};

async function proxyApi(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const target = API_ORIGIN + url.pathname.slice("/api".length) + url.search;
  const headers = new Headers(request.headers);
  // Hop-by-hop and platform headers must not be forwarded upstream.
  for (const name of ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-real-ip"]) {
    headers.delete(name);
  }

  const init = { method: request.method, headers, redirect: "follow" };
  if (request.method === "POST") {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return new Response("Upstream unavailable", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const out = new Headers(upstream.headers);
  // fetch() already decoded the body, so the original encoding headers no
  // longer describe it.
  out.delete("content-encoding");
  out.delete("content-length");
  out.set("cache-control", "no-store");

  return new Response(upstream.body, { status: upstream.status, headers: out });
}
