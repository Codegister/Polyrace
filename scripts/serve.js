#!/usr/bin/env node
/* eslint-disable no-console */
// Zero-dependency static server for local PolyTrack development.
//
// It intentionally mirrors production behaviour: the repo root is served at
// "/", but sub-directories are NOT listed (they 404). That forces the game to
// use its embedded `officialTrackFallbacks` / `communityTrackFallbacks` arrays,
// exactly like GitHub Pages / Cloudflare Assets do.
//
// Usage: node scripts/serve.js [port]
//   port defaults to PORT env or 3000
//   SERVE_DIR selects the directory to serve (relative to the repo root);
//   point it at `dist` to preview exactly what gets deployed.

const http = require("http");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const serveRoot = path.resolve(repoRoot, process.env.SERVE_DIR || ".");
const port = Number(process.argv[2] || process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".track": "application/octet-stream",
  ".map": "application/json; charset=utf-8",
};

function send(res, status, body, headers) {
  res.writeHead(status, headers);
  res.end(body);
}

// The browser calls the leaderboard backend through `/api/` (see
// worker/index.js). Mirror that proxy locally so the game behaves the same,
// including the origin-side leaderboard policy the Worker applies.
const API_ORIGIN = "https://polytrack-backend.htmlunblockedgames.workers.dev";
const policyPromise = import(
  require("url").pathToFileURL(path.join(__dirname, "..", "worker", "leaderboard-policy.mjs")).href
);
const quarantinePromise = import(
  require("url").pathToFileURL(path.join(__dirname, "..", "worker", "leaderboard-quarantine.mjs")).href
);

function proxyApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const isLeaderboard = url.pathname === "/api/leaderboard";
  const isRead = req.method === "GET" || req.method === "HEAD";
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("error", () =>
    send(res, 400, "Bad Request", { "content-type": "text/plain; charset=utf-8" })
  );
  req.on("end", async () => {
    try {
      const [policy, quarantineModule] = await Promise.all([policyPromise, quarantinePromise]);
      const quarantined = policy.parseQuarantine(quarantineModule.default);
      const body = Buffer.concat(chunks);

      let search = url.search;
      if (isLeaderboard && isRead) {
        // URLSearchParams.toString() omits the leading "?".
        search = "?" + policy.sanitizeLeaderboardSearch(url.search).toString();
      }

      if (isLeaderboard && req.method === "POST") {
        const verdict = await policy.validateLeaderboardUpload(
          new URLSearchParams(body.toString("utf8"))
        );
        if (!verdict.ok) {
          return send(res, 400, `Rejected by leaderboard policy: ${verdict.reason}`, {
            "content-type": "text/plain; charset=utf-8",
          });
        }
      }

      const target = API_ORIGIN + url.pathname.slice("/api".length) + search;
      const headers = {};
      if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "POST" ? body : undefined,
        redirect: "follow",
      });

      if (isLeaderboard && isRead && quarantined.size > 0) {
        const payload = JSON.parse(await upstream.text());
        const filtered = policy.filterLeaderboardPayload(payload, quarantined);
        const filteredBody = Buffer.from(JSON.stringify(filtered.payload));
        res.writeHead(upstream.status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": filteredBody.length,
          "x-leaderboard-quarantined": String(filtered.removed),
        });
        return res.end(filteredBody);
      }

      const responseBody = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": responseBody.length,
      });
      res.end(responseBody);
    } catch (err) {
      send(res, 502, `Upstream unavailable: ${err.message}`, {
        "content-type": "text/plain; charset=utf-8",
      });
    }
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return send(res, 400, "Bad Request");
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return proxyApi(req, res);
  }

  const target = path.join(serveRoot, path.normalize(pathname));
  // Prevent path traversal outside the served root.
  if (target !== serveRoot && !target.startsWith(serveRoot + path.sep)) {
    return send(res, 403, "Forbidden");
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat) {
      return send(res, 404, "Not Found", { "content-type": "text/plain; charset=utf-8" });
    }

    let filePath = target;
    if (stat.isDirectory()) {
      // Only the site root auto-serves index.html; sub-directories 404 like a
      // real static host without directory listings.
      if (pathname !== "/") {
        return send(res, 404, "Not Found", { "content-type": "text/plain; charset=utf-8" });
      }
      filePath = path.join(target, "index.html");
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const stream = fs.createReadStream(filePath);
    stream.on("error", () =>
      send(res, 404, "Not Found", { "content-type": "text/plain; charset=utf-8" })
    );
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-cache",
      "cross-origin-resource-policy": "cross-origin",
    });
    stream.pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`PolyTrack mirror serving ${serveRoot} at http://${host}:${port}/`);
});
