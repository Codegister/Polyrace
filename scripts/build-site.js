#!/usr/bin/env node
/* eslint-disable no-console */
// Assemble a clean, deployable static site in `dist/`.
//
// Only runtime game assets are copied (never scripts, docs, git metadata or
// the deploy manifest), so the uploaded bundle contains nothing but the game.

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "dist");

// Top-level entries that make up the shipped game.
const PUBLIC_ENTRIES = [
  "index.html",
  "api-base.js",
  "main.bundle.js",
  "simulation_worker.bundle.js",
  "error_screen.bundle.js",
  "manifest.json",
  "favicon.ico",
  "multiplayer",
  "forced_square.json",
  "forced_square.woff2",
  "audio",
  "images",
  "lib",
  "models",
  "tracks",
];

// Docs that live inside a shipped directory (e.g. `tracks/README.md`) are
// working notes for the repo, not runtime assets, and must not be published.
function isRuntimeAsset(src) {
  return !/\.(md|markdown)$/i.test(src);
}

function copyEntry(entry) {
  const src = path.join(repoRoot, entry);
  const dest = path.join(outDir, entry);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required asset: ${entry}`);
  }
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true, filter: (s) => isRuntimeAsset(s) });
    return;
  }
  fs.copyFileSync(src, dest);
}

function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const entry of PUBLIC_ENTRIES) {
    copyEntry(entry);
  }

  const files = [];
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else files.push(path.relative(outDir, full));
    }
  };
  walk(outDir);

  const bytes = files.reduce((sum, rel) => sum + fs.statSync(path.join(outDir, rel)).size, 0);
  console.log(`Built dist/ with ${files.length} files (${(bytes / 1048576).toFixed(2)} MiB).`);

  // Freebuff Sites caps an upload at 1000 files / 10 MiB. Other hosts (GitHub
  // Pages, Cloudflare Pages, Netlify) allow far more, so this is only a warning
  // unless STRICT_SIZE=1 is set for a Sites deploy.
  const overHostLimit = files.length > 1000 || bytes > 10 * 1048576;
  if (overHostLimit) {
    const msg =
      `dist/ is ${files.length} files / ${(bytes / 1048576).toFixed(2)} MiB, over the ` +
      "Freebuff Sites limit of 1000 files / 10 MiB.";
    if (process.env.STRICT_SIZE === "1") throw new Error(msg);
    console.warn(`WARNING: ${msg} Use another host, or trim assets.`);
  }
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
