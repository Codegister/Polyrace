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

addTest("Adaptive render scale is shipped and wired before the game", () => {
  const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  ensure(html.includes('src="./perf.js"'), "index.html must load perf.js");
  ensure(
    html.indexOf("./perf.js") < html.indexOf("./main.bundle.js"),
    "perf.js must load before the game reads the pixel ratio"
  );
  const buildScript = fs.readFileSync(
    path.join(repoRoot, "scripts", "build-site.js"),
    "utf8"
  );
  ensure(buildScript.includes('"perf.js"'), "build-site.js must publish perf.js");
});

addTest("Adaptive render scale ladder and thresholds are sane", () => {
  const src = fs.readFileSync(path.join(repoRoot, "perf.js"), "utf8");
  const sandbox = {};
  vm.runInNewContext(src, sandbox);
  const helpers = sandbox.__POLYTRACK_PERF__;
  ensure(helpers, "perf.js must expose __POLYTRACK_PERF__ for tests");

  // A 3x phone still caps at 2x; the ladder only ever descends, ends at the
  // floor, and a low-density screen is left alone at the top.
  const ladder = helpers.buildLadder(3);
  ensure(ladder[0] === helpers.MAX_RATIO, `ladder top: ${ladder[0]}`);
  ensure(
    ladder[ladder.length - 1] >= helpers.MIN_RATIO - 0.001,
    `ladder floor: ${ladder[ladder.length - 1]}`
  );
  for (let i = 1; i < ladder.length; i++) {
    ensure(ladder[i] < ladder[i - 1], "the ladder must descend");
  }
  ensure(helpers.buildLadder(1)[0] === 1, "native ratio is kept when it is already low");

  ensure(helpers.classify(40) === "slow", "40 ms frames are slow");
  ensure(helpers.classify(16.7) === "fast", "60 Hz frames are fast");
  ensure(helpers.classify(20) === "ok", "in-between frames change nothing");

  // It must react to the first bad window but take many clean windows (and a
  // pause after stepping down) before it climbs back.
  ensure(helpers.SLOW_WINDOWS === 1, `slow windows: ${helpers.SLOW_WINDOWS}`);
  ensure(helpers.FAST_WINDOWS >= 6, `fast windows: ${helpers.FAST_WINDOWS}`);
  ensure(
    helpers.FAST_WINDOWS > helpers.SLOW_WINDOWS * 4,
    "recovery must be slower than reaction"
  );
  ensure(helpers.WARMUP_MS <= 3000, `warm-up: ${helpers.WARMUP_MS}`);
  ensure(
    helpers.RECOVER_HOLD_MS >= helpers.WINDOW_MS,
    "the recovery hold must cover at least one window"
  );
  ensure(
    helpers.VERY_SLOW_FRAME_MS > helpers.SLOW_FRAME_MS,
    "the very-slow threshold must sit above the slow one"
  );
  ensure(helpers.classify(22) === "slow", "22 ms frames are starting to stutter");
  ensure(helpers.classify(60) === "slow", "collapsed frames are slow");
});

addTest("Adaptive render scale shows an indicator while it reduces resolution", () => {
  const src = fs.readFileSync(path.join(repoRoot, "perf.js"), "utf8");
  ensure(src.includes('var INDICATOR_ID = "perf-indicator"'), "indicator id is missing");
  ensure(
    src.includes('"Resolution " + percent + "%"'),
    "indicator text is missing"
  );
  ensure(src.includes("pointer-events:none"), "the indicator must never take input");
  ensure(
    src.includes("index === 0 || !enabled || passthrough"),
    "the indicator must be hidden at the native ratio"
  );
  ensure(src.includes("updateIndicator();"), "the indicator must follow ratio changes");
  const sandbox = {};
  vm.runInNewContext(src, sandbox);
  ensure(
    sandbox.__POLYTRACK_PERF__.INDICATOR_ID === "perf-indicator",
    "the indicator id must be exported for tests"
  );
});

addTest("Track streaming is shipped and wired before the game", () => {
  const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  ensure(html.includes('src="./track-stream.js"'), "index.html must load track-stream.js");
  ensure(
    html.indexOf("./track-stream.js") < html.indexOf("./main.bundle.js"),
    "track-stream.js must load before the bundle that calls into it"
  );
  const buildScript = fs.readFileSync(
    path.join(repoRoot, "scripts", "build-site.js"),
    "utf8"
  );
  ensure(
    buildScript.includes('"track-stream.js"'),
    "build-site.js must publish track-stream.js"
  );
});

addTest("Track streaming hooks are installed in the game bundle", () => {
  ensure(
    bundle.split('window.PolyTrackTrack.register(').length === 2,
    "the bundle must call PolyTrackTrack.register exactly once"
  );
  ensure(
    bundle.split('window.PolyTrackTrack.release(').length === 2,
    "the bundle must call PolyTrackTrack.release exactly once"
  );
  ensure(
    bundle.includes("const streamed = !!(window.PolyTrackTrack &&"),
    "the register hook must be optional so the unmodified game still runs"
  );
  ensure(
    bundle.includes("window.PolyTrackTrack && window.PolyTrackTrack.release"),
    "the release hook must be optional so the unmodified game still runs"
  );
});

addTest("Perf A/B harness is shipped, opt-in and loaded before the game", () => {
  const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  ensure(html.includes('src="./perf-ab.js"'), "index.html must load perf-ab.js");
  ensure(
    html.indexOf("./perf-ab.js") < html.indexOf("./main.bundle.js"),
    "perf-ab.js must load before the game creates its WebGL context"
  );
  const buildScript = fs.readFileSync(
    path.join(repoRoot, "scripts", "build-site.js"),
    "utf8"
  );
  ensure(
    buildScript.includes('"perf-ab.js"'),
    "build-site.js must publish perf-ab.js"
  );
  const src = fs.readFileSync(path.join(repoRoot, "perf-ab.js"), "utf8");
  ensure(src.includes("perfab"), "the harness must be behind ?perfab=1");
  ensure(
    src.includes("if (!enabled) return;"),
    "the harness must be inert without its URL flag"
  );
});

addTest("Perf A/B metrics are computed correctly and require no DOM", () => {
  const src = fs.readFileSync(path.join(repoRoot, "perf-ab.js"), "utf8");
  const sandbox = {
    location: { search: "?perfab=1&trackstream=off&duration=600&refresh=120" }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);
  const api = sandbox.PolyTrackPerfAB;
  ensure(api, "the harness must expose PolyTrackPerfAB when enabled");
  ensure(api.label === "off", `label: ${api.label}`);
  ensure(api.config.duration === 600, `duration: ${api.config.duration}`);
  ensure(api.config.refresh === 120, `refresh: ${api.config.refresh}`);
  ensure(api._percentile([10, 20, 30, 40], 50) === 25, "p50 interpolation");
  ensure(api._percentile([5], 95) === 5, "single sample percentile");

  const summary = api._summarize([16, 16, 17, 120], 4000, 60, null);
  ensure(summary.frames === 4, `frames: ${summary.frames}`);
  ensure(summary.fps === 1, `fps: ${summary.fps}`);
  ensure(summary.long.over50 === 1 && summary.long.over100 === 1, "long frames");
  ensure(summary.long.perMinute === 15, `long/min: ${summary.long.perMinute}`);
  ensure(summary.dropped.expected === 240, "expected vsync ticks");
  ensure(summary.dropped.count === 236, `dropped: ${summary.dropped.count}`);
  ensure(summary.frameMs.max === 120, `max: ${summary.frameMs.max}`);
  ensure(summary.frameMs.p95 > 17 && summary.frameMs.p95 < 120, "p95 in range");

  const off = { location: { search: "?trackstream=off" } };
  off.window = off;
  vm.runInNewContext(src, off);
  ensure(off.PolyTrackPerfAB === undefined, "no API without ?perfab=1");
});

addTest("Track streaming windows instances, restores full views and releases", () => {
  const src = fs.readFileSync(path.join(repoRoot, "track-stream.js"), "utf8");
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.requestAnimationFrame = function () {};
  sandbox.setInterval = function () {};
  vm.runInNewContext(src, sandbox);
  const api = sandbox.PolyTrackTrack;
  ensure(api && typeof api.register === "function", "track-stream.js must expose the API");
  ensure(api.version === 2, `API version: ${api.version}`);
  ensure(api.config.radius > 0, "a streaming radius is required");
  ensure(
    api.config.farRadius >= api.config.radius,
    "the far cone must reach at least as far as the near radius"
  );
  ensure(api.config.farMargin >= 1, "the far cone must not be narrower than the view");
  ensure(api.config.repackStep > 0, "a repack step is required");
  ensure(api.config.behindDistance < api.config.radius, "behind distance must be small");
  ensure(api.config.minInstances > 0, "a small-track threshold is required");
  ensure(api.config.minSpan > 0, "a small-track span threshold is required");
  ensure(api.config.requireRaceHud === true, "streaming must wait for the race HUD");

  class FakeAttribute {
    constructor(count) {
      this.array = new Float32Array(count * 16);
      this.needsUpdate = false;
      this.updateRanges = [];
    }
    addUpdateRange(start, count) {
      this.updateRanges.push({ start, count });
    }
    clearUpdateRanges() {
      this.updateRanges.length = 0;
    }
  }
  class FakeMesh {
    constructor(count) {
      this.isInstancedMesh = true;
      this.geometry = {};
      this.material = {};
      this.count = count;
      this.visible = true;
      this.instanceMatrix = new FakeAttribute(count);
    }
    dispose() {
      this.disposed = true;
    }
  }
  class FakeShadow extends FakeMesh {}

  function makeParts(count, spacing, x, y) {
    const parts = [];
    for (let i = 0; i < count; i++) {
      const e = new Float32Array(16);
      e[0] = e[5] = e[10] = e[15] = 1;
      e[12] = x || 0;
      e[13] = y || 0;
      e[14] = i * spacing;
      parts.push({ matrix: { elements: e } });
    }
    return parts;
  }
  function makeScene() {
    return {
      items: [],
      add(o) {
        this.items.push(o);
      },
      remove(o) {
        const i = this.items.indexOf(o);
        if (i !== -1) this.items.splice(i, 1);
      }
    };
  }
  function cameraAt(x, y, z) {
    return {
      position: {
        x,
        y,
        z,
        clone() {
          return { x, y, z };
        }
      },
      getWorldDirection(v) {
        v.x = 0;
        v.y = 0;
        v.z = -1;
        return v;
      }
    };
  }

  const scene = makeScene();
  const env = { scene };
  const parts = makeParts(4000, 5);
  const base = new FakeMesh(parts.length);
  const shadow = new FakeShadow(parts.length);
  ensure(api.register(env, base, shadow, parts) === true, "a large track must be accepted");
  ensure(
    shadow.instanceMatrix === base.instanceMatrix,
    "the shadow mesh must share the base instance buffer"
  );
  api.finalize(env);

  let state = api.stats(env);
  ensure(state.eligible === true, "the large track must be eligible");
  ensure(state.mode === "originals", `initial mode: ${state.mode}`);
  ensure(state.drawn === 4000, `initial drawn: ${state.drawn}`);
  ensure(state.draws === 1, "draw calls must stay one per part group");
  ensure(scene.items.length === 2, "both game meshes must stay in the scene");

  // Menu / track selection: no HUD, so the whole track stays drawn.
  sandbox.document = { querySelector: () => null };
  api.update(env, cameraAt(0, 0, 0));
  ensure(api.stats(env).drawn === 4000, "previews must keep the whole track");

  // Race HUD: only the window is left in the draw range.
  sandbox.document = { querySelector: () => ({}) };
  api.update(env, cameraAt(0, 0, 0));
  state = api.stats(env);
  ensure(state.mode === "windowed", `streaming mode: ${state.mode}`);
  ensure(state.drawn > 0 && state.drawn < 4000, `window drawn: ${state.drawn}`);
  ensure(
    base.count === state.drawn && shadow.count === state.drawn,
    "both mesh counts must follow the window"
  );
  ensure(base.instanceMatrix.needsUpdate === true, "the window must be uploaded");
  ensure(
    base.instanceMatrix.updateRanges.length === 1 &&
      base.instanceMatrix.updateRanges[0].count === state.drawn * 16,
    "only the window prefix may be uploaded"
  );
  const nearDrawn = state.drawn;

  // A few units without a repack must not rewrite the window.
  api.update(env, cameraAt(0, 0, 8));
  ensure(api.stats(env).drawn === nearDrawn, "small moves must not repack");

  // The window follows the camera to the far end of the track.
  api.update(env, cameraAt(0, 0, 19995));
  const far = api.stats(env);
  ensure(far.drawn > 0 && far.drawn < 4000, `far drawn: ${far.drawn}`);
  ensure(far.drawn !== nearDrawn, "the window must move with the camera");

  // Height is not part of the bounds: a jump above the track must keep the
  // window instead of restoring (and uploading) the whole track mid-race.
  api.update(env, cameraAt(0, 1000, 0));
  ensure(api.stats(env).mode === "windowed", "a jump must not restore the track");

  // Leaving the track horizontally restores every instance.
  api.update(env, cameraAt(5000, 0, 0));
  const all = api.stats(env);
  ensure(all.mode === "originals", `full mode: ${all.mode}`);
  ensure(all.drawn === 4000, `restored drawn: ${all.drawn}`);
  ensure(base.count === 4000 && shadow.count === 4000, "full counts must be restored");

  // A small track is never eligible and never touched.
  const smallScene = makeScene();
  const smallEnv = { scene: smallScene };
  const smallParts = makeParts(40, 5);
  const smallMesh = new FakeMesh(40);
  ensure(api.register(smallEnv, smallMesh, null, smallParts) === true, "small tracks register");
  api.finalize(smallEnv);
  const small = api.stats(smallEnv);
  ensure(small.eligible === false, "small tracks must not stream");
  ensure(small.drawn === 40, `small drawn: ${small.drawn}`);
  ensure(smallMesh.count === 40, "small tracks keep every instance");
  ensure(smallScene.items.length === 1, "small tracks keep the game mesh");

  // Beyond the near radius, only the forward view cone is kept.
  api.config.radius = 1;
  api.config.farRadius = 800;
  api.config.behindDistance = 0;
  api.config.minInstances = 100;
  api.config.minSpan = 100;
  const coneParts = makeParts(400, 5, 0, 0).map((part, i) => {
    part.matrix.elements[14] = -1000 + i * 5;
    return part;
  });
  const coneScene = makeScene();
  const coneEnv = { scene: coneScene };
  const coneMesh = new FakeMesh(coneParts.length);
  api.register(coneEnv, coneMesh, null, coneParts);
  api.finalize(coneEnv);
  api.update(coneEnv, cameraAt(0, 0, 0));
  const cone = api.stats(coneEnv);
  ensure(cone.eligible === true, "the cone track must be eligible");
  ensure(cone.drawn > 0 && cone.drawn < 400, `cone drawn: ${cone.drawn}`);
  let coneMin = Infinity;
  let coneMax = -Infinity;
  for (let i = 0; i < coneMesh.count; i++) {
    const z = coneMesh.instanceMatrix.array[i * 16 + 14];
    if (z < coneMin) coneMin = z;
    if (z > coneMax) coneMax = z;
  }
  ensure(coneMax <= 0.001, `nothing behind the camera may be drawn: ${coneMax}`);
  ensure(coneMin >= -800.001, `the cone must stop at farRadius: ${coneMin}`);
  api.release(coneEnv);

  // A re-pack is applied in slices, so no single frame replaces the whole
  // window; counts and the drawn total stay consistent while it is in flight.
  const spreadScene = makeScene();
  const spreadEnv = { scene: spreadScene };
  const spreadPartsA = makeParts(2000, 5);
  const spreadPartsB = makeParts(2000, 5, 40, 0);
  const spreadMeshA = new FakeMesh(2000);
  const spreadMeshB = new FakeMesh(2000);
  api.register(spreadEnv, spreadMeshA, null, spreadPartsA);
  api.register(spreadEnv, spreadMeshB, null, spreadPartsB);
  api.finalize(spreadEnv);
  api.update(spreadEnv, cameraAt(0, 0, 0), false);
  ensure(api.stats(spreadEnv).mode === "windowed", "the spread test starts windowed");
  const uploadBudget = api.config.uploadBytesPerFrame;
  api.config.uploadBytesPerFrame = 1;
  api.update(spreadEnv, cameraAt(0, 0, 4000), true);
  let spread = api.stats(spreadEnv);
  ensure(spread.pending === 1, `a budgeted pack must leave work pending: ${spread.pending}`);
  ensure(
    spread.drawn === spreadMeshA.count + spreadMeshB.count,
    "drawn must match the groups already switched"
  );
  let spreadFrames = 0;
  while (api.stats(spreadEnv).pending > 0 && spreadFrames < 10) {
    api.update(spreadEnv, cameraAt(0, 0, 4000), true);
    spreadFrames += 1;
  }
  spread = api.stats(spreadEnv);
  ensure(spread.pending === 0, "the spread pack must finish");
  ensure(
    spread.drawn === spreadMeshA.count + spreadMeshB.count,
    "drawn must match counts after the spread pack"
  );
  ensure(spread.packs >= 2, `packs must be counted: ${spread.packs}`);
  api.config.uploadBytesPerFrame = uploadBudget;
  api.release(spreadEnv);

  api.release(env);
  ensure(scene.items.length === 0, "release must detach every mesh from the scene");
  ensure(api.stats(env) === null, "release must forget the track");
  api.release(smallEnv);
  ensure(smallScene.items.length === 0, "release must detach small tracks too");
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
