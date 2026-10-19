# Multiplayer

Live multiplayer for the PolyTrack 0.5.2 mirror: host a race, share a 5-character
invite code, and race the same track together.

Status: **transport, lobby, presence, host-start and state streaming are
implemented and tested. In-world opponent cars are not rendered yet** — see
[Remaining work](#remaining-work) for exactly what is missing and why it is not
shipped half-finished.

> **Cross-device play needs an Ably key.** Without one the only transport is
> `BroadcastChannel`, which reaches tabs of *one* browser and nothing else. Two
> players on two machines therefore never appear in each other's roster: the
> code is accepted, the lobby opens, and the room stays empty. See
> [Enabling real online play](#enabling-real-online-play-ably).

## What works today

- Invite-code rooms (5 characters, `0`/`1` excluded so codes can be spoken).
- Deterministic host assignment (lowest player id wins) with automatic handover
  when the host leaves.
- Presence with heartbeats; a peer that stops sending is dropped after 7 s.
- Capacity of 16 players, matching PolyTrack 0.6.0's published limit.
- Live state streaming at 12.5 Hz per player: position, orientation, speed,
  checkpoint index, brake lights.
- **Host Start Race**: the host's `start` message puts every peer on the chosen
  track by driving the game's own track screen (Play → matching card). Only the
  host can start, and only once a track is chosen.
- Two transports:
  - `local` — `BroadcastChannel` between tabs/windows of the same browser.
    Works with no account, no key, no network.
  - `ably` — WebSocket pub/sub for real internet play (needs a key, below).
- `window.PolyTrackNet.remoteCars()` — the data contract the renderer consumes.
- Native-looking menu tile, Join/Host dialogs and lobby (see [UI](#ui)).
- Host settings (mode, player cap, track) broadcast from the host and clamped to
  2-16 players.

## UI

The multiplayer screens are built to match the game's own menus: the menu
entry reuses the native `button button-image` tile (200x200, 96px icon, 27px
label) and the dialogs use the game's design tokens from `main.bundle.js`
(`--surface-color`, `--button-color`, ForcedSquare, clipped parallelograms) via
`multiplayer/ui.css`.

Screens:

- **Main menu** — a globe icon labelled *Multiplayer* inserted immediately before
  *Play*, and the car-customisation tile relabelled *Garage*. The *Profile* tile
  is hidden (`hideProfileTile: false` reverts it) so the menu shows the five
  tiles from the reference layout; profiles moved into the Garage.
- **Garage** — the game's own customisation screen, plus a profile header: the
  current nickname in a tab under the tool bar, and a *Switch Profile* button on
  the right. The nickname is read from the game's profile storage
  (`polytrack_v4_prod_user_<slot>`, with the slot key parsed tolerantly and a
  fallback to the first filled slot). *Switch Profile* first activates the game's
  own Profile tile (the screen the old Profile button showed) and raises that
  screen above the garage; if the game does not produce it — its handler builds
  the screen inside an async callback that never resolves from here — we open an
  equivalent *Profiles* dialog of our own instead. Choosing a slot writes
  `polytrack_v4_prod_user_slot` exactly as the game does (`JSON.stringify`) and
  reloads, so the game boots into that profile. Either way the garage steps
  aside and comes back afterwards.
- **Join Multiplayer Game** — invite-code field, `Back`, `Host`, and a `Join`
  button that stays disabled until the code is complete.
- **Host Multiplayer Game** — Casual/Competitive mode, a 2-16 player slider, and
  a Select Track tile that opens the **game's real track screen** (the Play menu)
  rather than a re-implementation. That gives real track previews, every
  category including custom tracks, and the search box for free. Card clicks are
  intercepted in the capture phase so the game never starts the race; the
  chosen title is mapped back to a file name through
  `multiplayer/tracks.json` (custom tracks keep their displayed name). Backing
  out returns to the host dialog.
- **Lobby** — invite code, mode/player/track summary, roster with live speeds.
- **In-race chip** — small top-right status with the room code and peer speeds.

Note: the track picker is the game's own screen, so previews, category tabs and
search are the real ones. The one piece it cannot do is start the race from
here — selection only records the host's advertised track.

## Playing right now (same browser, two tabs)

1. `npm run build && SERVE_DIR=dist npm run serve`
2. Open <http://localhost:3000> in two tabs.
3. In the first: **Multiplayer → Host**. A code appears, e.g. `K7QP2`.
4. In the second: type the code → **Join with code**.
5. Both tabs now list each other with live speed.

Two windows of the same browser are one transport domain, so this proves the
protocol end to end but not real internet play.

## Enabling real online play (Ably)

1. Create an Ably app and an API key scoped to **publish/subscribe on
   `polytrack-mp:*` only**. Treat it as public — it ships to the browser.
2. The browser SDK is already vendored at `multiplayer/vendor/ably.min.js`
   (Ably JS 2.29.0, Apache-2.0) and is loaded lazily, only when a key is set. To
   update it:

   ```bash
   curl -sSL -o multiplayer/vendor/ably.min.js https://unpkg.com/ably@2/build/ably.min.js
   ```

3. Put the key in `multiplayer/config.js`:

   ```js
   window.POLYTRACK_MP_CONFIG = { ablyKey: "YOUR_KEY", maxPlayers: 16 };
   ```

4. `npm run build` and redeploy.

Without a key the lobby shows `Same-browser tabs only until an Ably key is
configured.` and uses the tab transport, so an unconfigured deployment degrades
instead of failing — but players on different devices will not see each other.

## How it hooks into the closed 0.5.2 build

Nothing in `main.bundle.js` was modified for multiplayer. The game runs all
physics in a worker created as `new Worker("simulation_worker.bundle.js")`, and
`multiplayer/shim.js` wraps the `Worker` constructor **before** the game loads,
giving a read-only view of both message directions.

Reverse-engineered message contract (`simulation_worker.bundle.js`):

| type | name | direction | payload |
| --- | --- | --- | --- |
| 3 | CreateCar | page → worker | car setup |
| 4 | DeleteCar | page → worker | car id |
| 5 | StartCar | page → worker | car id |
| 6 | ControlCar | page → worker | car id + inputs |
| 7 | PauseCar | page → worker | car id |
| 8 | VerifyResult | worker → page | verification |
| 9 | DeterminismResult | worker → page | determinism |
| 10 | UpdateResult | worker → page | `carStates[]` |

Each `carStates` entry (the exact shape, from the worker's own state builder):

```js
{
  id, frames, speedKmh, hasStarted, finishFrames, nextCheckpointIndex,
  hasCheckpointToRespawnAt,
  position: { x, y, z },
  quaternion: { x, y, z, w },
  collisionImpulses, wheelContact[4], wheelSuspensionLength[4],
  wheelSuspensionVelocity[4], wheelRotation[4], wheelDeltaRotation[4],
  wheelSkidInfo[4], wheelPosition[4], wheelQuaternion[4],
  brakeLightEnabled, controls
}
```

The local car is identified by the id the page uses in `ControlCar` messages,
so no guessing is needed.

## Remaining work

Opponent cars need to be added to the game's own render loop. The 0.5.2 build
supports this — the simulation facade exposes `createCar`, `controlCar`,
`deleteCar` and `startCar`, ghost cars are constructed as
`new GhostCar(null, startTransform, recording, null, …deps)` inside the ghost
manager, and the scene walks a `carEntries` array calling `entry.car.update()`.
All of that lives in Closure-minified module scopes with no exported handles
(the only global the bundle leaks is `window.__THREE__`).

Doing it therefore requires a small, surgical patch to `main.bundle.js` that
exposes the ghost-car constructor plus its five dependencies and the car-entry
array on `window`. That patch has not been written and shipped because:

- it cannot be exercised without a real browser, and there is no browser
  automation in this environment;
- a patch that throws at race start would break the game for every visitor of
  the public deployment, which is a worse outcome than shipping no cars.

The plan is to add it behind a config flag (`inWorldCars: false` by default),
validate it in two local windows, then enable it. Each remote player's state is
already available in the exact form the renderer needs, so no netcode changes
are required for that step.

Not implemented, and out of scope for a 0.5.2 mirror: voice chat, matchmaking,
and the ranking/scoring rules of 0.6.0's sessions.
