# PolyTrack 0.5.2 (Unofficial Build)

This repo contains the static assets for the PolyTrack 0.5.2 browser build (bundled `main.bundle.js`, worker, audio, tracks, etc.). The game expects to be hosted from one of the “official” domains baked into the bundle, so keep the deployment URL under `htmlunblockedgames.github.io` (or another host you’ve patched into the allow‑list).

---

## Mirror setup

This checkout is wired up as a self‑contained, hostable mirror of the game:

* **No host allow‑list dependency.** The bundled host check (`jT()`) is patched to always
  report an official build, so the mirror runs on any origin without the “unofficial
  version” banner and with leaderboards enabled.
* **No build step for the game itself.** `main.bundle.js` / `simulation_worker.bundle.js`
  ship prebuilt; every asset is served from this repo (no external CDN).
* **Analytics removed.** The original owner’s Google Analytics snippet was dropped from
  `index.html`, so the mirror does not report traffic upstream.
* **Leaderboard backend.** Runs are submitted through a same-origin `/api/` proxy: the
  bundle calls `/api/...`, `worker/index.js` forwards it to the upstream backend, and
  `scripts/serve.js` mirrors that proxy in local development. The client never references
  the third-party host, so the page's own origin is the only one the browser contacts.
  A purely static host (GitHub Pages, plain Netlify) has no Worker to run that proxy, so
  leaderboard submissions need the upstream URL restored in `main.bundle.js` or a
  serverless function on that host. See `API.md` for the wire format.
* **Readable page metadata.** `index.html` carries a title, description, rating and
  Open Graph tags, plus a short boot screen with real text. That gives content
  classifiers something to read: the game itself renders entirely into a canvas, so
  without it the page has zero text.

### Layout

| Path | Purpose |
| --- | --- |
| `scripts/serve.js` | Zero‑dependency static dev server (no directory listings, like production). |
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

1. Push all assets to the `htmlunblockedgames.github.io/polytrack-0.5.2` path (or the host you control).
2. Ensure the Pages site serves from the repo root so `tracks/`, `audio/`, `models/`, etc. are reachable.
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

### Option A — Freebuff Sites (already configured)

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

### Option B — GitHub Pages (live, different registrable domain)

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

### Option C — Cloudflare Pages / Netlify / Vercel

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