#!/usr/bin/env node
/* eslint-disable no-console */
// Verify a deployed origin serves exactly the contents of `dist/`.
//
// Usage: node scripts/verify-deploy.js <origin>
//
// Checks, in order:
//   1. Every file in dist/ responds 200 (or 307 -> "/" for index.html) and its
//      body is byte-for-byte identical to the local copy.
//   2. Key asset directories report the MIME types the game needs.
//   3. Repo-only files (docs, scripts, deploy manifest) are NOT reachable.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const origin = (process.argv[2] || "").replace(/\/+$/, "");
if (!origin) {
  console.error("Usage: node scripts/verify-deploy.js <origin>");
  process.exit(2);
}

const distDir = path.resolve(__dirname, "..", "dist");

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function fetchBody(url) {
  const res = await fetch(url, { redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, type: res.headers.get("content-type") || "" };
}

let failures = 0;
const fail = (msg) => {
  console.log(`✘ ${msg}`);
  failures += 1;
};

(async () => {
  const files = walk(distDir).sort();
  console.log(`Verifying ${files.length} files against ${origin}\n`);

  // 1 + 2. Every file present, byte-identical, sensible MIME type.
  const mismatches = [];
  for (const rel of files) {
    const local = fs.readFileSync(path.join(distDir, rel));
    let remote;
    try {
      remote = await fetchBody(`${origin}/${rel}`);
    } catch (err) {
      fail(`${rel}: request failed (${err.message})`);
      continue;
    }
    const isIndexAlias = rel === "index.html" && remote.status === 307;
    if (remote.status !== 200 && !isIndexAlias) {
      fail(`${rel}: HTTP ${remote.status}`);
      continue;
    }
    // `/index.html` 307s to `/`, and a redirect response carries no body or
    // content-type, so grade the final response instead.
    const final = isIndexAlias ? await fetchBody(`${origin}/`) : remote;
    if (sha256(final.buf) !== sha256(local)) {
      mismatches.push(rel);
      continue;
    }
    if (/\.(wasm|glb|ogg|woff2|js|html|json|track)$/.test(rel)) {
      const ok =
        (rel.endsWith(".wasm") && /application\/wasm/.test(final.type)) ||
        (rel.endsWith(".glb") && /gltf-binary/.test(final.type)) ||
        (rel.endsWith(".ogg") && /audio\//.test(final.type)) ||
        (rel.endsWith(".woff2") && /font\/woff2/.test(final.type)) ||
        (rel.endsWith(".js") && /javascript/.test(final.type)) ||
        (rel.endsWith(".html") && /text\/html/.test(final.type)) ||
        (rel.endsWith(".json") && /json/.test(final.type)) ||
        (rel.endsWith(".track") && /octet-stream|track|json/.test(final.type));
      if (!ok) fail(`${rel}: unexpected content-type "${final.type}"`);
    }
  }
  if (mismatches.length) fail(`byte mismatch in ${mismatches.length} file(s): ${mismatches.slice(0, 5).join(", ")}`);
  else console.log(`✔ all ${files.length} files byte-identical`);

  // 3. Nothing outside dist/ is exposed.
  // `tracks/README.md` is checked explicitly: it lives inside a shipped
  // directory, so a naive top-level-only scan misses it (it was live once).
  const forbidden = [
    "sites.manifest.json",
    "scripts/build-site.js",
    "scripts/verify-deploy.js",
    "package.json",
    "README.md",
    "API.md",
    "worker/index.js",
    ".gitignore",
    ".github/workflows/pages.yml",
    "tracks/README.md",
    "tracks/readme.md",
  ];
  for (const rel of forbidden) {
    const res = await fetch(`${origin}/${rel}`, { redirect: "manual" });
    if (res.status !== 404) fail(`leaked non-public path /${rel} (HTTP ${res.status})`);
  }
  console.log("✔ no non-public paths exposed");

  console.log(failures === 0 ? "\nDeployment verified." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
