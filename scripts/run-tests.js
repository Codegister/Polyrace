#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const bundlePath = path.join(repoRoot, "main.bundle.js");
const bundle = fs.readFileSync(bundlePath, "utf8");

const tests = [];

function addTest(name, fn) {
  tests.push({ name, fn });
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listTrackFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".track"))
    .map((entry) => entry.name);
}

addTest("Required build artifacts exist", () => {
  ["index.html", "main.bundle.js", "error_screen.bundle.js"].forEach((file) => {
    const exists = fs.existsSync(path.join(repoRoot, file));
    ensure(exists, `Expected ${file} to exist`);
  });
});

addTest("Official and community track directories contain tracks", () => {
  const officialDir = path.join(repoRoot, "tracks", "official");
  const communityDir = path.join(repoRoot, "tracks", "community");
  [officialDir, communityDir].forEach((dir) => {
    ensure(fs.existsSync(dir), `Missing directory: ${dir}`);
  });
  const officialTracks = listTrackFiles(officialDir);
  const communityTracks = listTrackFiles(communityDir);
  ensure(
    officialTracks.length > 0,
    "tracks/official must contain at least one .track file"
  );
  ensure(
    communityTracks.length > 0,
    "tracks/community must contain at least one .track file"
  );
});

addTest("Dynamic track loader present", () => {
  ensure(
    bundle.includes('trackDirectoryLoader("tracks/official/"') &&
      bundle.includes('trackDirectoryLoader("tracks/community/"'),
    "Dynamic track loader helper not found in bundle"
  );
});

addTest("Leaderboard fetch uses null verified flag", () => {
  const callSignature =
    '.getLeaderboard(EC(this, $T, "f").getCurrentUserProfile().tokenHash, EC(this, YT, "f"), r, n, null)';
  ensure(
    bundle.includes(callSignature),
    "Leaderboard fetch should pass null for verified filter"
  );
});

addTest("HTML Unblocked Games host allowed", () => {
  ensure(
    bundle.includes("htmlunblockedgames\\.github\\.io"),
    "Authorized host list is missing htmlunblockedgames.github.io"
  );
});

addTest("Game API is served from our own origin", () => {
  ensure(
    !bundle.includes("polytrack-backend.htmlunblockedgames.workers.dev"),
    "The client bundle must not hard-code the third-party backend host"
  );
  ensure(
    bundle.includes('\"/api/\"'),
    "Client bundle should default to the same-origin /api/ path"
  );
});

addTest("Backend base resolves to the proxy or the public backend by host", () => {
  const src = fs.readFileSync(path.join(repoRoot, "api-base.js"), "utf8");
  const sandbox = { location: { hostname: "htmlunblockedgames.github.io" } };
  vm.runInNewContext(src, sandbox);

  const resolve = sandbox.__POLYTRACK_RESOLVE_API_BASE__;
  ensure(
    typeof resolve === "function",
    "api-base.js must expose __POLYTRACK_RESOLVE_API_BASE__ for tests"
  );
  ensure(
    resolve("htmlunblockedgames.github.io") ===
      "https://polytrack-backend.htmlunblockedgames.workers.dev/",
    "GitHub Pages has no /api/ proxy, so it must use the public backend"
  );
  ensure(resolve("localhost") === "/api/", "Local development must keep the /api/ proxy");
  ensure(
    resolve("site-e4b041c1ac354d00b91adf711e469db5.freebuff.page") === "/api/",
    "Freebuff Sites runs the Worker, so it must use the same-origin proxy"
  );
  ensure(resolve("") === "/api/", "An unknown/empty host must keep the current default");
  ensure(
    sandbox.__POLYTRACK_API_BASE__ ===
      "https://polytrack-backend.htmlunblockedgames.workers.dev/",
    "Loading the script must set __POLYTRACK_API_BASE__ from location.hostname"
  );
});

addTest("Static-host API fallback is wired into the page and bundle", () => {
  const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  ensure(html.includes('src="./api-base.js"'), "index.html must load api-base.js");
  ensure(
    html.indexOf("./api-base.js") < html.indexOf("./main.bundle.js"),
    "api-base.js must be loaded before main.bundle.js"
  );
  ensure(
    bundle.includes('window.__POLYTRACK_API_BASE__ || "/api/"'),
    "main.bundle.js must resolve the API base at runtime"
  );
});

addTest("Worker proxies /api to the backend", () => {
  const worker = fs.readFileSync(path.join(repoRoot, "worker", "index.js"), "utf8");
  ensure(
    worker.includes('url.pathname.startsWith("/api/")') &&
      worker.includes("export default"),
    "Worker should route /api/ through the proxy before fetching assets"
  );
});

addTest("Page exposes title, description and readable text", () => {
  const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  ensure(
    /<title>[^<]*PolyTrack[^<]*<\/title>/i.test(html),
    "index.html needs a PolyTrack <title>"
  );
  ensure(
    /<meta\s+name="description"\s+content="[^"]{40,}"/i.test(html),
    "index.html needs a substantive meta description"
  );
  ensure(/<html lang="en">/i.test(html), "index.html should declare a language");
  ensure(
    /<h1>PolyTrack<\/h1>/.test(html),
    "index.html should contain visible page text for classifiers to read"
  );
});

addTest("Repo docs inside shipped directories are not published", () => {
  const buildScript = fs.readFileSync(path.join(repoRoot, "scripts", "build-site.js"), "utf8");
  ensure(
    /\.\(md\|markdown\)/i.test(buildScript),
    "build-site.js must filter Markdown out of copied directories"
  );

  // When a build is present, assert the real output carries no docs. This is
  // what caught `tracks/README.md` being served on the live origin.
  const distDir = path.join(repoRoot, "dist");
  if (fs.existsSync(distDir)) {
    const stray = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(md|markdown)$/i.test(entry.name)) stray.push(path.relative(distDir, full));
      }
    };
    walk(distDir);
    ensure(stray.length === 0, `dist/ publishes docs: ${stray.join(", ")}`);
  }
});

addTest("Leaderboard verified-state UI removed", () => {
  ensure(
    !bundle.includes('.button.only-verified') &&
      !bundle.includes('verified-state pending'),
    "Leaderboard verified UI remnants still found"
  );
});

(async () => {
  let passed = 0;
  for (const test of tests) {
    try {
      await test.fn();
      console.log(`✔ ${test.name}`);
      passed += 1;
    } catch (err) {
      console.error(`✘ ${test.name}`);
      console.error(err.message || err);
      process.exitCode = 1;
      break;
    }
  }
  if (passed === tests.length) {
    console.log(`\nAll ${passed} tests passed.`);
  } else {
    console.log(`\n${passed} of ${tests.length} tests passed.`);
  }
})();
