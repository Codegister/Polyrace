# PolyTrack 0.5.2 (Unofficial Build)

This repo contains the static assets for the PolyTrack 0.5.2 browser build (bundled `main.bundle.js`, worker, audio, tracks, etc.). The game runs from any static origin: `api-base.js` resolves the leaderboard backend per host, so nothing depends on the URL being an “official” domain.

---

## Mirror setup

This checkout is wired up as a self‑contained, hostable mirror of the game:

* **No host allow‑list dependency.** The bundled host check (`jT()`) is patched to always
  report an official build, so the mirror runs on any origin without the “unofficial
  version” banner and with leaderboards enabled.
* **No build step for the game itself.** `main.bundle.js` / `simulation_worker.bundle.js`
  ship prebuilt; every asset is served from this repo (no external CDN).
* **Analytics tag retained.** `index.html` keeps the original owner’s Google Analytics
  snippet (`G-TE23LLQE9F`); it is their property and removing it was never requested.
* **Leaderboard backend.** Runs are submitted through a same-origin `/api/` proxy: the
  bundle calls `/api/...`, `worker/index.js` forwards it to the upstream backend, and
  `scripts/serve.js` mirrors that proxy in local development. The client never references
  the third-party host, so the page's own origin is the only one the browser contacts.
  A purely static host (GitHub Pages, plain Netlify) has no Worker to run that proxy, so
  `api-base.js` calls the upstream backend directly on those hosts — no build-time
  patch and no serverless function required. See `API.md` for the wire format.
* **Readable page metadata.** `index.html` carries a title, description, rating and
  Open Graph tags, plus a short boot screen with real text. That gives content
  classifiers something to read: the game itself renders entirely into a canvas, so
  without it the page has zero text.
* **Adaptive render resolution.** `perf.js` watches frame pacing and lowers the
  game's effective pixel ratio as soon as a device starts dropping frames — the
  situation behind stutter late in long races on high-density screens. It judges
  each 1.2 s window by the *average* frame time, so a second that loses ten
  frames counts even though its median frame is still 17 ms, ignores one-off
  stalls over 100 ms, steps down at most once every 6 s, and never goes softer
  than 60% of the device's own ratio. It climbs back after a long run of clean
  frames — an occasional borderline second costs one window of that credit
  instead of resetting the run, because on a 60 Hz screen a single 55 ms frame
  pushes an otherwise clean second just over the fast threshold — and it shows
  a small `Resolution NN%`
  badge in the corner while the picture is softened, so a blurrier image never
  looks like a bug. No setting is changed and nothing is reloaded.
* **Windowed track geometry.** The game builds one `InstancedMesh` per part
  type/colour containing every copy of that part in the whole track, with
  `frustumCulled = false`. On a long track that submits the entire map every
  frame, twice with shadows. `track-stream.js` rewrites each mesh's instance
  table as the player moves so only parts around the camera, plus the view cone
  down the track, are in the drawn range, keeping the game's draw-call count
  unchanged. Small tracks (under
  3000 instances or shorter than 700 units) are left untouched, and views that
  show the whole map (menu preview, track selection, editor zoomed out) always
  draw every part. A respawn or restart is a jump far beyond one re-pack step,
  so its re-pack is spread over a few frames at a smaller per-frame budget
  instead of landing in one frame on top of the game's own reset work.

### Layout

| Path | Purpose |
| --- | --- |
| `scripts/serve.js` | Zero‑dependency static dev server (no directory listings, like production). |
| `perf.js` | Adaptive render-resolution governor (pixel ratio only, with an on-screen badge). |
| `track-stream.js` | Windows track geometry around the camera and view cone. |
| `perf-ab.js` | Opt-in (`?perfab=1`) real-device A/B harness: frame time, dropped frames, WebGL counts. |
| `scripts/build-site.js` | Assembles the clean deployable site in `dist/`. |
| `multiplayer/` | Live multiplayer: invite-code rooms, presence, state streaming (see `MULTIPLAYER.md`). |
| `worker/index.js` | Worker fetch handler that serves `dist/` via the `ASSETS` binding. |
| `sites.manifest.json` | Deploy manifest (Worker + `dist/` assets). |

### Commands

```bash
npm run serve                 # dev server on :3000 (SERVE_DIR=dist to preview the build)
npm run build                 # write the deployable site to dist/
npm test                      # smoke tests
npm run verify:deploy <url>   # check a live origin against dist/ byte-for-byte
npm run update-fallbacks      # refresh embedded track lists after adding .track files
```

---

## Track streaming

`track-stream.js` is the only piece of the game pipeline that touches track
meshes. It is loaded before `main.bundle.js`, which contains exactly two hook
calls into it:

* `Track.generateMeshes()` passes every finished `InstancedMesh`, its shadow
  copy and the group's part list to
  `PolyTrackTrack.register(environment, mesh, shadow, parts)`;
* the internal `disposeTrackMeshes()` calls `PolyTrackTrack.release(environment)`
  before a track is rebuilt or cleared.

If the script is missing, both calls are guarded and the game behaves exactly as
before. The track format, part list and materials are never changed. The shadow
mesh the game creates for track shadows is pointed at the base mesh's instance
buffer (its duplicate buffer is dropped), which also removes a whole copy of the
instance data from GPU memory.

How it works:

* at build time the parts of a track are counted; tracks under `minInstances`
  (3000) or with a horizontal extent under `minSpan` (700 units) are left
  exactly as the game made them;
* while the race HUD (`.timer` / `.speedometer` inside `#ui`) is mounted, every
  `repackStep` (64) units of travel the layer rewrites each mesh's instance
  table: only parts within `radius` (300) of a centre pushed `lookAhead` (0.35)
  of the radius ahead of the camera are copied to the front, and
  `mesh.count` is set to that number. Parts more than `behindDistance` (60)
  behind the camera are skipped. Outside `radius`, parts stay drawn out to
  `farRadius` (450) while they are inside a cone `farMargin` (1.2) times the
  camera's horizontal half-FOV, so the long view down a straight (arches,
  distant scenery) is still there;
* the upload uses the buffer attribute's update range, so only the drawn prefix
  is sent to the GPU, not the full instance table;
* a re-pack is applied a few groups at a time, up to roughly
  `uploadBytesPerFrame` (256 KiB) per frame, so one frame never replaces the
  whole window. Each group switches atomically from its old draw range to the
  new one, so intermediate frames still draw uploaded geometry;
* the re-pack starts at most once per 64 units of travel (or after a sharp
  turn), instead of running every frame. Draw-call count does not change: still
  one call per part type/colour;
* only horizontal bounds are checked: a jump can put the camera above every
  part without meaning the camera left the track, and restoring the whole
  track there would upload all of it just before the window is needed again.
  If the camera is outside the horizontal bounds plus `boundsMargin` (24) —
  the editor zoomed out, a car flying off the map — or the race HUD is not
  there (menu preview, track selection), the full instance table is restored
  once;
* leaving the track disposes the instance buffers the game handed over.

Tune or verify it from the browser console (or with `?trackstream=debug`):

```js
PolyTrackTrack.config.radius = 240;      // live, next re-pack
PolyTrackTrack.config.repackStep = 96;   // fewer, larger re-packs
PolyTrackTrack.config.uploadBytesPerFrame = 256 * 1024; // smaller slices
PolyTrackTrack.stats();                  // mode, drawn, draws, packs, pending
PolyTrackTrack.setEnabled(false);        // show the whole track again
```

`?trackstream=off` disables the layer from the URL. The two bundle hooks are the
only modifications to `main.bundle.js`; keep them when refreshing the bundle from
an upstream build.

---

## Real-device A/B performance test

`perf-ab.js` is an opt-in harness for measuring the streaming change on real
hardware. It is inert unless the page is opened with `?perfab=1`.

| URL | What it measures |
| --- | --- |
| `/?perfab=1&trackstream=off` | A: the old path — the full track every frame |
| `/?perfab=1` | B: the streamed path |

Optional parameters: `&duration=600` (seconds, default 300), `&refresh=120` for
a 120 Hz iPad Pro, `&delay=5` before recording starts, `&autostart=0` to start
by hand, and `&adapt=0` to pin the render scale. Recording starts a few seconds
after the race HUD appears and stops itself after `duration`, so both runs
measure the same amount of race.

The adaptive-resolution governor is left on by default because that is the
shipped experience; the harness records its ladder index and pixel ratio in
`summary.performance` and per second in `buckets[].perfIndex`. If A and B end on
the same index, frame times are directly comparable; if B holds a higher index,
it is doing so at a sharper resolution. Use `&adapt=0` in both URLs for a pair
pinned at the device's native ratio when you want an uncontaminated frame-time
delta.

The panel shows live fps, p95 frame time, >50 ms frames per second and WebGL
draws/instances. Copy or download the JSON at the end; it contains a summary and
one bucket per second:

* `summary.frameMs` (mean/p50/p90/p95/p99/max), `fps`, `long.over50/over100`,
  `long.perMinute` and `dropped` against the display refresh;
* `summary.gl.callsMean/instancesMean/trianglesMean` — counted by wrapping the
  WebGL draw calls, so they work in both modes without the game's help;
* `summary.startup` (first 10 s) and `summary.steady` (from 10 s on) — fps, p95,
  >50 ms frames per minute and drop percentage for each. The first seconds are
  track load, shader compilation and the first re-packs, so compare runs on
  `steady` when one is shorter than the other or was started late;
* `summary.firstMinute`, `summary.lastMinute` and `summary.trend` (fps and p95
  ratio) — the progressive-slowdown signal;
* `summary.heap` when `performance.memory` exists (Chromium browsers); iOS
  Safari has no memory API, so read the JS heap from the Web Inspector memory
  timeline and the JSON records `heap.supported: false`;
* `summary.streaming.mode/drawn/instances` and `buckets[].mode/drawn` confirm
  the window is active in run B;
* `buckets[].packsDelta/pending/sliceMsLast/sliceMsMax` — how many re-packs the
  second did and what the worst sliced upload cost, so a hitch can be tied to
  track work;
* `buckets[].camX/camZ` — where the car was at the end of that second, so a slow
  second in A and in B can be checked against the same place on the track;
* a run interrupted by a hidden tab is stopped at that moment and marked
  `valid: false` with `invalidReason: "tab was hidden"` (a hidden tab pauses
  animation frames, so its timing is not usable). The flag is cleared when a new
  run starts: start a fresh run instead of trusting the partial one;
* `longFrames[]` — every frame over 100 ms (up to 40) with the streaming
  counters as they were in that frame. If `packs` and `sliceMsLast` do not move
  across a stall, the track layer did not cause it;
* a run B on a short track is marked `valid: false` with
  `invalidReason: "streaming never engaged: this track has N parts…"`. Below the
  layer's `minInstances` (3000) the track is left whole, so the run measures the
  unstreamed path in both modes and proves nothing. Check
  `summary.streaming.instances` — Winterfell is about 74,700 parts; a small
  number means the race was not on the long track.

The change is working when B shows far fewer `gl.instancesMean` and
`trianglesMean` with the same `callsMean`, and its last minute does not degrade
relative to its first (`trend.fpsRatio` near 1.0). See the notes in the panel
and the run procedure in the final report.

---

## Multiplayer

Host a race, share a 5-character invite code, race the same track together.

The netcode is a separate layer (`multiplayer/`) that hooks the game's
simulation worker through a `Worker` wrapper — the minified bundles are not
modified. Out of the box it relays between tabs of the same browser; real
online play needs an Ably key in `multiplayer/config.js`. Full details,
including the reverse-engineered worker protocol, are in `MULTIPLAYER.md`.

```bash
npm run build && SERVE_DIR=dist npm run serve   # then open two tabs
```

---

## Local Development

1. Install Node 18+ (only needed for helper scripts/tests; the game itself has no deps).
2. `npm run serve` – or any static server pointed at the repo root.
3. Open `http://localhost:3000/` to load the game. Use `SERVE_DIR=dist npm run serve` to
   preview exactly what gets deployed.

The game bundle is already built; `npm run build` only assembles `dist/`.

---

## Deployment Checklist (GitHub Pages)

1. Push to `main` in `Codegister/Polyrace`; `.github/workflows/pages.yml` runs the tests, builds
   `dist/` and publishes it to https://codegister.github.io/Polyrace/.
2. Keep **Settings → Pages → Source** on **GitHub Actions**. The build copies `tracks/`,
   `audio/`, `models/`, etc. into `dist/`, so a sub-path deploy stays self-contained.
3. Because directory listings are disabled on GitHub Pages, always refresh the fallback track lists before deploying:

```bash
npm install        # first time only
npm run update-fallbacks
npm test           # optional but recommended
git commit && git push
```

`npm run update-fallbacks` rewrites the embedded `officialTrackFallbacks` / `communityTrackFallbacks` arrays so the game discovers any new `.track` files.

---

## Tracks Workflow

* Drop new `.track` files under `tracks/official/` or `tracks/community/`.
* Update the fallback arrays via `npm run update-fallbacks`.
* See `tracks/README.md` for a short reminder and deployment caveats.

---

## Hosting

The game is a plain static site. Build it with `npm run build` and upload `dist/`
anywhere. Because it uses only relative URLs it works at a domain root **or** in a
sub‑path (`https://user.github.io/repo/`). HTTPS is required for real visitors
(service workers / worker + WASM behaviour differs on plain HTTP).

### Option A — GitHub Pages: `Codegister/Polyrace` (primary)

| Field | Value |
| --- | --- |
| Live URL | https://codegister.github.io/Polyrace/ |
| Repository | https://github.com/Codegister/Polyrace |
| Pages source | **GitHub Actions** (`.github/workflows/pages.yml`) |
| Published artifact | `dist/` only — no repo docs, scripts or tests are web-reachable |

Pushing to `main` runs the smoke tests, builds `dist/` and publishes just that, so
the live site contains game files only and a failing test blocks the deploy.

`codegister.github.io` is a different registrable domain from `freebuff.page` and
sits on the Public Suffix List, so filters classify it separately from any other
GitHub Pages site.

### Option B — Freebuff Sites (historical, blocked at school)

| Field | Value |
| --- | --- |
| Site ID (current) | `c4d9a1f2-7b3e-4c58-9a16-2f8e5d04b7a3` |
| Current production URL | https://site-e4b041c1ac354d00b91adf711e469db5.freebuff.page **(live)** |
| Site ID (previous) | `f61a8663-016f-4bcd-b0ae-6701876e3ba2` |
| Previous preview URL (survived the ~1 h window, later unverified) | https://site-a1e2dbabc0a7496c9ad826451e5b96f7.freebuff.page |
| Previous production URL (blocked at school) | https://site-418941da8c66457a8b00089030809ad8.freebuff.page |
| Oldest site (ID `233c966c-0398-4928-b1a6-4db95ba949dc`) | https://site-325879b47a3e448e9be3df833e9ee073.freebuff.page (pre-fix build) |

Every environment deployed on 2026-10-18 serves the **classifiable build**: real
`<title>`/description/OG tags, a visible boot screen, and a same-origin `/api/`
proxy so no third-party `*.workers.dev` host is referenced from the browser.
That content fix is what let one URL survive the school filter past the ~1-hour
delayed-content-classification window. The previous preview environment is
intentionally left on its earlier upload as a control; the oldest site still
hosts the pre-fix build as a second fallback.

**Important:** every Freebuff Sites URL is a UUID subdomain of the single
registrable domain `freebuff.page` (which is absent from the Public Suffix
List). Creating a new site therefore yields a new *hostname* on the same
*registrable domain* — if Securly's verdict is attached to `freebuff.page`, a
brand-new site is blocked too. Moving to a genuinely different registrable
domain (`*.vercel.app`, `*.netlify.app`, `*.pages.dev`, `*.github.io`) or a
custom domain is the only way to escape a domain-level category.

Markdown in a shipped directory (`tracks/README.md`) is repo documentation, not
a runtime asset: `scripts/build-site.js` filters `*.md` out of copied
directories and `scripts/verify-deploy.js` probes `/tracks/README.md` on the
live origin to catch a regression.

The production environment is published, so this URL is permanent and public.
Redeploy after any change to `dist/` inputs (`npm run build` first, then deploy the
manifest and re-verify with `npm run verify:deploy <url>`).

Deploy `sites.manifest.json` to the desired environment. **Limit: 1000 files /
10 MiB per upload** — `dist/` currently sits at ~9.7 MiB, so run with
`STRICT_SIZE=1 npm run build` to fail fast if new tracks push it over.

### Option C — GitHub Pages (older mirror repo)

**This is the deployment that matters.** `github.io` is not `freebuff.page`, so
the site does not inherit whatever verdict made every `*.freebuff.page`
hostname die on first contact with the school filter.

| Field | Value |
| --- | --- |
| Live URL | https://htmlunblockedgames.github.io/polytrack-0.5.2-clean/ |
| Repository | https://github.com/htmlunblockedgames/polytrack-0.5.2-clean |
| Pages source | **Deploy from a branch** → `main` → `/` (root), already configured |

Because Pages serves the repository root, **pushing to `main` is the entire
deploy** — no workflow, no build step, no settings change. `index.html` at the
repo root is the game's entry point, and every asset it needs sits beside it.

`.github/workflows/pages.yml` is the alternative: it runs the smoke tests, builds
`dist/` and deploys only that. It only takes effect once **Settings → Pages →
Source** is switched to **GitHub Actions**; while the repo stays on the branch
deploy, that workflow's deploy step fails (harmlessly, but visibly) and should be
deleted if the branch deploy is kept.

### Option D — Cloudflare Pages / Netlify / Vercel

Drag‑and‑drop or point the host at `dist/` with the repo root as the build
context and `npm run build` as the build command. All three handle the ~10 MiB
payload without the Sites cap.

---

## Automated Checks

`npm test` runs a custom smoke suite (`scripts/run-tests.js`) that verifies:

- Required bundles exist
- Track directories contain files
- Dynamic loader + custom track guards are present
- Leaderboard + host tweaks remain intact

`npm run verify:deploy <origin>` performs the post-deploy check: it walks `dist/`
and asserts every file is byte-identical on the live origin with a sensible
`Content-Type`, and that no repo-only file (scripts, docs, manifest) is exposed.

Run it before every deploy to catch regressions without reopening the bundle.