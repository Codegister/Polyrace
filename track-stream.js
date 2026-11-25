/* PolyTrack track streaming.
 *
 * The game builds a track as one InstancedMesh per part type and colour
 * (main.bundle.js, Track.generateMeshes), containing every copy of that part
 * in the whole track. Those meshes are added with `frustumCulled = false`, so
 * on a long track every part - including all parts behind the camera and on
 * the far side of the map - is submitted every frame, and the shadow pass
 * submits all of it a second time. That is a constant per-frame cost, not a
 * one-off load cost, which is what makes a long race degrade as the device
 * heats up and throttles.
 *
 * This layer windows those instanced meshes instead of splitting them into
 * more meshes. Every frame it checks how far the camera has moved; when it has
 * moved far enough it rewrites each mesh's instance table so that only parts
 * inside a radius around the camera are in the drawn range, then sets
 * `mesh.count` to that number and uploads only that prefix of the buffer. The
 * draw-call count stays exactly what the game had (one per part type/colour),
 * while the vertex and shadow work falls to the parts the player can actually
 * be near. Because the instances are only re-packed every REPACK_STEP units,
 * the CPU cost is a short, bounded burst instead of extra work every frame.
 *
 * The window is pushed forward along the camera direction (LOAD_AHEAD), so the
 * road ahead is kept before the player reaches it, and parts more than
 * BEHIND_DISTANCE behind the camera are dropped. Outside the near radius, parts
 * still count as visible out to FAR_RADIUS when they are inside a cone a little
 * wider than the camera's horizontal FOV: that keeps the long view down the
 * track (an arch, a straight, distant scenery) that a plain radius would cut
 * off. Everything is rebuilt from the track's own part list, which the game
 * already keeps in memory, so this layer allocates no second copy of the track.
 *
 * The shadow copy the game makes for track shadows shares the base mesh's
 * instance buffer (and its own duplicate buffer is dropped), so the window
 * costs nothing extra there.
 *
 * Safety:
 *   - small tracks (under MIN_INSTANCES parts, or shorter than MIN_SPAN) are
 *     left exactly as the game built them;
 *   - windowing only runs while the race HUD is mounted; the menu preview and
 *     the track-selection preview always show the whole track;
 *   - if the camera leaves the track's bounds (editor zoomed out, car flying
 *     off the edge) the full instance table is restored;
 *   - if the game does not publish a track, or streaming is disabled, nothing
 *     is changed;
 *   - every failure falls back to the full track, and all errors stay here.
 *
 * Tuning / verifying from the browser console:
 *   PolyTrackTrack.config                 live knobs
 *   PolyTrackTrack.stats()                mode, instances, drawn, draws
 *   PolyTrackTrack.setEnabled(false)      restore the whole track
 *   ?trackstream=off / ?trackstream=debug in the URL
 */
(function (global) {
  "use strict";

  var CONFIG = {
    enabled: true,
    // Parts within this distance of the window centre are drawn.
    radius: 300,
    // Beyond that circle, parts are still drawn out to this distance when they
    // are inside the camera's view cone, so distant track and scenery that is
    // actually on screen (through an arch, down a straight) does not pop out.
    farRadius: 450,
    // How much wider than the camera's horizontal half-FOV the far cone is.
    farMargin: 1.2,
    // Push the window centre this fraction of radius along the camera's
    // forward direction, so the road ahead is packed before it is reached.
    lookAhead: 0.35,
    // Parts further than this behind the camera plane are dropped.
    behindDistance: 60,
    // Re-pack once the camera has moved this many units (or turned sharply).
    repackStep: 64,
    // A single-frame move this long is a respawn, a race restart or a jump,
    // not driving: the whole window becomes invalid at once, and on a real
    // device the re-pack lands in the same frame as the game's own reset work.
    jumpStep: 320,
    // After such a jump the re-pack is spread with this budget first, so the
    // burst does not stack on top of the reset, then finishes at the normal
    // uploadBytesPerFrame. 0 keeps the normal budget.
    jumpBytesPerFrame: 64 * 1024,
    // How many frames keep that smaller budget after a jump.
    jumpSettleFrames: 6,
    // A re-pack replaces every drawn instance table, which used to mean one
    // multi-megabyte upload in a single frame (the hitch felt at some points).
    // Spread it over frames: each frame re-packs groups until it has queued
    // about this many bytes. 0 sends the whole window in one frame.
    uploadBytesPerFrame: 256 * 1024,
    // Tracks with fewer instances than this are left untouched.
    minInstances: 3000,
    // Tracks whose horizontal extent is below this are left untouched too.
    minSpan: 700,
    // How far outside the track's horizontal (x/z) bounds the camera may be
    // before the full track is restored. Height is deliberately ignored: a
    // jump lifts the camera above every part, and restoring the whole track
    // there would upload all of it just before the window is needed again.
    boundsMargin: 24,
    // Only window instances while the game's race HUD is on screen.
    requireRaceHud: true,
    debug: false
  };

  var states = new WeakMap();
  var allStates = [];

  function now() {
    return global.performance && global.performance.now
      ? global.performance.now()
      : Date.now();
  }

  function isNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function log() {
    if (!CONFIG.debug || !global.console) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[PolyTrackTrack]");
    console.log.apply(console, args);
  }

  function readUrlFlags() {
    try {
      var search = (global.location && global.location.search) || "";
      if (/(?:^\?|&)trackstream=off(?:&|$)/.test(search)) CONFIG.enabled = false;
      if (/(?:^\?|&)trackstream=debug(?:&|$)/.test(search)) CONFIG.debug = true;
    } catch (err) {
      /* no location (worker/tests) */
    }
  }

  function hasRaceHud() {
    if (!CONFIG.requireRaceHud) return true;
    if (!global.document || !global.document.querySelector) return true;
    try {
      return !!global.document.querySelector(
        "#ui .timer, #ui .speedometer, #ui .checkpoint-speed"
      );
    } catch (err) {
      return true;
    }
  }

  function stateFor(env) {
    var state = states.get(env);
    if (state) return state;
    state = {
      env: env,
      scene: env.scene,
      groups: [],
      built: false,
      disposed: false,
      eligible: false,
      mode: "originals",
      total: 0,
      drawn: 0,
      draws: 0,
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
      finalized: false,
      job: null,
      packs: 0,
      sliceMsLast: 0,
      sliceMsMax: 0,
      settleFrames: 0,
      lastCamera: null,
      lastPackX: null,
      lastPackZ: null,
      lastForwardX: 0,
      lastForwardZ: 0,
      lastHudCheck: -Infinity,
      hud: true
    };
    states.set(env, state);
    allStates.push(state);
    return state;
  }

  function partElements(part) {
    return part && part.matrix && part.matrix.elements
      ? part.matrix.elements
      : null;
  }

  function groupBounds(parts) {
    var box = {
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity
    };
    for (var i = 0; i < parts.length; i++) {
      var e = partElements(parts[i]);
      if (!e) continue;
      var x = e[12];
      var y = e[13];
      var z = e[14];
      if (!isNumber(x) || !isNumber(y) || !isNumber(z)) continue;
      if (x < box.minX) box.minX = x;
      if (y < box.minY) box.minY = y;
      if (z < box.minZ) box.minZ = z;
      if (x > box.maxX) box.maxX = x;
      if (y > box.maxY) box.maxY = y;
      if (z > box.maxZ) box.maxZ = z;
    }
    return box;
  }

  function distanceSqToBox(box, x, y, z) {
    var dx = 0;
    var dy = 0;
    var dz = 0;
    if (x < box.minX) dx = box.minX - x;
    else if (x > box.maxX) dx = x - box.maxX;
    if (y < box.minY) dy = box.minY - y;
    else if (y > box.maxY) dy = y - box.maxY;
    if (z < box.minZ) dz = box.minZ - z;
    else if (z > box.maxZ) dz = z - box.maxZ;
    return dx * dx + dy * dy + dz * dz;
  }

  function computeStats(state) {
    var total = 0;
    var minX = Infinity;
    var minY = Infinity;
    var minZ = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var maxZ = -Infinity;
    for (var g = 0; g < state.groups.length; g++) {
      var group = state.groups[g];
      group.box = groupBounds(group.parts);
      total += group.parts.length;
      var b = group.box;
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.minZ < minZ) minZ = b.minZ;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
      if (b.maxZ > maxZ) maxZ = b.maxZ;
    }
    state.total = total;
    state.drawn = total;
    state.draws = state.groups.length;
    state.minX = minX;
    state.minY = minY;
    state.minZ = minZ;
    state.maxX = maxX;
    state.maxY = maxY;
    state.maxZ = maxZ;
  }

  function setCount(state, group, count) {
    group.mesh.count = count;
    if (group.shadow) group.shadow.count = count;
  }

  function upload(state, group, count) {
    var attribute = group.mesh.instanceMatrix;
    if (!attribute) return;
    attribute.clearUpdateRanges();
    if (count > 0) attribute.addUpdateRange(0, count * 16);
    attribute.needsUpdate = true;
  }

  function restoreAll(state, reason) {
    state.job = null;
    if (state.mode === "originals" && state.drawn === state.total) return;
    var drawn = 0;
    for (var g = 0; g < state.groups.length; g++) {
      var group = state.groups[g];
      var parts = group.parts;
      var draw = group.mesh.instanceMatrix.array;
      for (var i = 0; i < parts.length; i++) {
        var e = partElements(parts[i]);
        if (!e) continue;
        draw.set(e, i * 16);
      }
      setCount(state, group, parts.length);
      upload(state, group, parts.length);
      drawn += parts.length;
    }
    state.mode = "originals";
    state.drawn = drawn;
    state.lastPackX = null;
    state.lastPackZ = null;
    log("whole track restored", reason || "", drawn, "instances");
  }

  // Freeze the camera state a re-pack works from, so a pack spread over
  // several frames stays consistent while the camera keeps moving.
  function packParams(state, camera) {
    var position = camera.position;
    if (!position) return null;
    var radius = Math.max(1, CONFIG.radius);
    var farRadius = Math.max(radius, CONFIG.farRadius);
    // Horizontal half-FOV, widened a little so turning inside a repack step
    // does not uncover culled geometry at the screen edge.
    var halfFov = Math.PI / 3;
    if (
      isNumber(camera.fov) &&
      camera.fov > 0 &&
      isNumber(camera.aspect) &&
      camera.aspect > 0
    ) {
      halfFov = Math.atan(
        Math.tan((camera.fov * Math.PI) / 360) * camera.aspect
      );
    }
    var farAngle = Math.max(0.35, Math.min(1.45, halfFov * CONFIG.farMargin));
    var forwardX = 0;
    var forwardZ = 0;
    if (typeof camera.getWorldDirection === "function") {
      var forward = state.forward || (state.forward = position.clone());
      camera.getWorldDirection(forward);
      var length = Math.sqrt(forward.x * forward.x + forward.z * forward.z);
      if (length > 0.0001) {
        forwardX = forward.x / length;
        forwardZ = forward.z / length;
      }
    }
    if (forwardX === 0 && forwardZ === 0) {
      forwardX = 0;
      forwardZ = -1;
    }
    var shift = radius * CONFIG.lookAhead;
    return {
      positionX: position.x,
      positionZ: position.z,
      cx: position.x + forwardX * shift,
      cy: position.y,
      cz: position.z + forwardZ * shift,
      radius2: radius * radius,
      farRadius2: farRadius * farRadius,
      cosFar: Math.cos(farAngle),
      forwardX: forwardX,
      forwardZ: forwardZ,
      behind: CONFIG.behindDistance
    };
  }

  // Re-pack one part group against a frozen camera snapshot. Returns the number
  // of instances left in its draw range; count and upload always move together,
  // so a drawn range never points at data the GPU has not received.
  function packGroup(state, group, p) {
    var parts = group.parts;
    var draw = group.mesh.instanceMatrix.array;
    // whole group out of range: no per-instance work at all
    if (
      group.box &&
      group.box.minX !== Infinity &&
      distanceSqToBox(group.box, p.cx, p.cy, p.cz) > p.farRadius2
    ) {
      setCount(state, group, 0);
      return 0;
    }
    var write = 0;
    for (var i = 0; i < parts.length; i++) {
      var e = partElements(parts[i]);
      if (!e) continue;
      var x = e[12];
      var y = e[13];
      var z = e[14];
      var dx = x - p.cx;
      var dy = y - p.cy;
      var dz = z - p.cz;
      var distance2 = dx * dx + dy * dy + dz * dz;
      if (distance2 > p.farRadius2) continue;
      if (distance2 > p.radius2) {
        // Outside the near circle: keep only what is inside the forward
        // cone, so the distance the player can see is still drawn.
        var hx = x - p.positionX;
        var hz = z - p.positionZ;
        var hLength = Math.sqrt(hx * hx + hz * hz);
        if (hLength < 0.001) continue;
        if ((hx * p.forwardX + hz * p.forwardZ) / hLength < p.cosFar) continue;
      }
      if (p.behind > 0) {
        // Horizontal distance behind the camera plane.
        var back =
          (x - p.positionX) * p.forwardX + (z - p.positionZ) * p.forwardZ;
        if (back < -p.behind) continue;
      }
      draw.set(e, write * 16);
      write += 1;
    }
    setCount(state, group, write);
    if (write > 0) upload(state, group, write);
    return write;
  }

  // Per-frame re-pack budget: the normal one, cut to the settle budget while a
  // jump's re-pack is still being spread out.
  function budgetFor(state) {
    var budget =
      CONFIG.uploadBytesPerFrame > 0 ? CONFIG.uploadBytesPerFrame : Infinity;
    if (state.settleFrames > 0 && CONFIG.jumpBytesPerFrame > 0) {
      budget = Math.min(budget, CONFIG.jumpBytesPerFrame);
    }
    return budget;
  }

  function beginPack(state, camera, spread) {
    var p = packParams(state, camera);
    if (!p) return;
    state.packs += 1;
    var drawn = 0;
    for (var i = 0; i < state.groups.length; i++) {
      drawn += state.groups[i].mesh.count;
    }
    state.drawn = drawn;
    state.mode = "windowed";
    state.job = { p: p, index: 0 };
    state.lastPackX = p.positionX;
    state.lastPackZ = p.positionZ;
    state.lastForwardX = p.forwardX;
    state.lastForwardZ = p.forwardZ;
    state.lastPackCamera = camera;
    pump(state, spread ? budgetFor(state) : Infinity);
  }

  // Apply the pending re-pack a few groups at a time, so a long track never
  // replaces its whole instance window (and uploads several megabytes) in a
  // single frame. Each group switches atomically from its old window to the
  // new one, so intermediate frames always draw uploaded geometry.
  function pump(state, budgetBytes) {
    var job = state.job;
    if (!job) return;
    var started = now();
    var spent = 0;
    var p = job.p;
    var groups = state.groups;
    while (job.index < groups.length) {
      var group = groups[job.index];
      var before = group.mesh.count;
      var write = packGroup(state, group, p);
      state.drawn += write - before;
      job.index += 1;
      spent += write * 64;
      if (spent >= budgetBytes) break;
    }
    var slice = now() - started;
    state.sliceMsLast = slice;
    if (slice > state.sliceMsMax) state.sliceMsMax = slice;
    if (state.settleFrames > 0) state.settleFrames -= 1;
    if (job.index >= groups.length) {
      state.job = null;
      log("window packed", state.drawn, "of", state.total, "instances");
    }
  }

  function cameraOf(state) {
    var camera = state.env && state.env.camera ? state.env.camera : null;
    if (camera && camera.position) return camera;
    return state.lastCamera;
  }

  function updateState(state, camera, spread) {
    if (!CONFIG.enabled || !state || !state.built || !state.eligible) return;
    camera = camera || cameraOf(state);
    if (!camera || !camera.position) return;
    state.lastCamera = camera;

    var position = camera.position;
    if (!isNumber(position.x) || !isNumber(position.y) || !isNumber(position.z)) {
      return;
    }

    var tick = now();
    // While the HUD is missing (menu, track selection) re-check every frame so
    // a race that starts is picked up immediately; while it is present only
    // refresh occasionally.
    if (!state.hud || tick - state.lastHudCheck > 1000) {
      state.hud = hasRaceHud();
      state.lastHudCheck = tick;
    }
    if (!state.hud) {
      restoreAll(state, "no race HUD");
      return;
    }

    // Horizontal bounds only: a jump can lift the camera above every part,
    // and that must not restore (and upload) the whole track mid-race.
    var margin = Math.max(0, CONFIG.boundsMargin);
    var inside =
      state.minX !== Infinity &&
      position.x >= state.minX - margin &&
      position.x <= state.maxX + margin &&
      position.z >= state.minZ - margin &&
      position.z <= state.maxZ + margin;
    if (!inside) {
      restoreAll(state, "camera outside track bounds");
      return;
    }

    var step = Math.max(1, CONFIG.repackStep);
    var moved2 =
      state.lastPackX === null
        ? Infinity
        : (position.x - state.lastPackX) * (position.x - state.lastPackX) +
          (position.z - state.lastPackZ) * (position.z - state.lastPackZ);
    var moved = moved2 >= step * step;
    // Far beyond a re-pack step in a single frame: a respawn, a restart or a
    // jump emptied the window, and the re-pack must not burst into one frame.
    var jump = Math.max(step * 4, CONFIG.jumpStep);
    var jumped = moved2 >= jump * jump;
    if (!moved && state.mode === "windowed") {
      // A sharp turn changes what "ahead" means even without moving.
      if (typeof camera.getWorldDirection === "function") {
        var forward = position.clone();
        camera.getWorldDirection(forward);
        var length = Math.sqrt(
          forward.x * forward.x + forward.z * forward.z
        );
        if (length > 0.0001) {
          var dot =
            (forward.x / length) * state.lastForwardX +
            (forward.z / length) * state.lastForwardZ;
          if (dot < 0.4) moved = true;
        }
      }
    }
    var spreading = spread === true && state.mode === "windowed";
    // A re-pack already under way keeps going: it was frozen a moment ago, and
    // restarting it would scan every group again from the first one. Only a
    // jump makes its frozen window useless.
    if (state.job && !jumped) {
      pump(state, spreading ? budgetFor(state) : Infinity);
      return;
    }
    if (moved || state.mode !== "windowed") {
      if (jumped && CONFIG.jumpSettleFrames > 0) {
        state.settleFrames = CONFIG.jumpSettleFrames;
      }
      beginPack(state, camera, spreading);
    } else {
      pump(state, spreading ? budgetFor(state) : Infinity);
    }
  }

  function register(env, mesh, shadow, parts) {
    if (!CONFIG.enabled) return false;
    if (!env || !env.scene || !mesh || !mesh.isInstancedMesh) return false;
    if (!mesh.instanceMatrix || !mesh.instanceMatrix.array) return false;
    if (!parts || !parts.length) return false;
    try {
      var state = stateFor(env);
      // The shadow mesh the game just built copies the same matrices; let it
      // share the base buffer instead of keeping (and uploading) a duplicate.
      if (shadow && shadow.instanceMatrix) {
        shadow.instanceMatrix = mesh.instanceMatrix;
        shadow.count = mesh.count;
      }
      var group = {
        mesh: mesh,
        shadow: shadow || null,
        parts: parts,
        box: null
      };
      env.scene.add(mesh);
      if (shadow) env.scene.add(shadow);
      state.groups.push(group);
      if (!state.built) {
        state.built = true;
        // The game registers all groups in one turn; compute stats on the next
        // frame so every group is counted.
        if (typeof global.requestAnimationFrame === "function") {
          global.requestAnimationFrame(function () {
            finalize(state);
          });
        } else {
          finalize(state);
        }
      }
      return true;
    } catch (err) {
      // Undo a partial add; the caller will add the game's own mesh.
      try {
        env.scene.remove(mesh);
        if (shadow) env.scene.remove(shadow);
      } catch (cleanupError) {
        /* best effort */
      }
      log("could not register track", err);
      return false;
    }
  }

  function finalize(state) {
    if (!state || state.disposed || state.finalized) return;
    state.finalized = true;
    computeStats(state);
    var span = Math.max(state.maxX - state.minX, state.maxZ - state.minZ);
    state.eligible =
      CONFIG.enabled &&
      state.total >= CONFIG.minInstances &&
      isNumber(span) &&
      span >= CONFIG.minSpan;
    if (!state.eligible) {
      log("track kept whole", state.total, "instances");
      return;
    }
    state.mode = "originals";
    startTicker();
    log("track eligible for streaming", state.total, "instances");
    var camera = cameraOf(state);
    if (camera) updateState(state, camera, false);
  }

  function release(env) {
    var state = states.get(env);
    if (!state) return;
    state.disposed = true;
    try {
      for (var i = 0; i < state.groups.length; i++) {
        var group = state.groups[i];
        env.scene.remove(group.mesh);
        if (group.shadow) env.scene.remove(group.shadow);
        if (group.mesh.instanceMatrix) group.mesh.dispose();
      }
    } catch (err) {
      log("release failed", err);
    }
    states.delete(env);
    var index = allStates.indexOf(state);
    if (index !== -1) allStates.splice(index, 1);
    log("released track", state.total, "instances");
  }

  function stats(env) {
    var list = env ? [states.get(env)] : allStates;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var state = list[i];
      if (!state) continue;
      out.push({
        mode: state.mode,
        eligible: state.eligible,
        instances: state.total,
        drawn: state.drawn,
        draws: state.draws,
        groups: state.groups.length,
        radius: CONFIG.radius,
        step: CONFIG.repackStep,
        packs: state.packs,
        pending: state.job ? state.groups.length - state.job.index : 0,
        sliceMsLast: Math.round(state.sliceMsLast * 100) / 100,
        sliceMsMax: Math.round(state.sliceMsMax * 100) / 100,
        bounds: {
          min: { x: state.minX, y: state.minY, z: state.minZ },
          max: { x: state.maxX, y: state.maxY, z: state.maxZ }
        },
        camera: state.lastPackCamera
          ? {
              x: state.lastPackCamera.position.x,
              y: state.lastPackCamera.position.y,
              z: state.lastPackCamera.position.z
            }
          : null
      });
    }
    return env ? out[0] || null : out;
  }

  var ticker = null;
  function startTicker() {
    if (ticker || typeof global.requestAnimationFrame !== "function") return;
    var frame = function () {
      if (!allStates.length) {
        ticker = null;
        return;
      }
      ticker = global.requestAnimationFrame(frame);
      for (var i = 0; i < allStates.length; i++) {
        updateState(allStates[i], null, true);
      }
    };
    ticker = global.requestAnimationFrame(frame);
  }

  readUrlFlags();

  global.PolyTrackTrack = {
    version: 2,
    config: CONFIG,
    register: register,
    release: release,
    // `spread` applies the re-pack a few groups per call (the frame ticker
    // passes true); without it the whole window is applied at once.
    update: function (env, camera, spread) {
      var state = states.get(env);
      if (state) updateState(state, camera, spread === true);
    },
    // Tests/debug: compute eligibility now instead of on the next frame.
    finalize: function (env) {
      var state = states.get(env);
      if (state) finalize(state);
    },
    stats: stats,
    setEnabled: function (enabled) {
      CONFIG.enabled = !!enabled;
      for (var i = 0; i < allStates.length; i++) {
        if (enabled) updateState(allStates[i], null);
        else restoreAll(allStates[i], "disabled");
      }
    }
  };
})(typeof window !== "undefined" ? window : this);
