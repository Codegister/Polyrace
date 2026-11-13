/* PolyTrack adaptive render resolution.
 *
 * The game draws at `devicePixelRatio * RenderScale` and recomputes that value
 * every frame (main.bundle.js reads window.devicePixelRatio while rendering),
 * so the pixel ratio is the largest single lever on how much GPU work a frame
 * costs: every extra pixel pays for the sky/clouds shader, shadows and MSAA
 * coverage. On an iPad (device pixel ratio 2) or any high-density screen that
 * is a lot of pixels to shade sixty times a second, and a long race on a big
 * track keeps the GPU hot until the device starts throttling. Frame times creep
 * up, the physics worker then packs more car updates into each frame, and the
 * game spirals down into stutter while still asking for a resolution the
 * device cannot sustain.
 *
 * This governor watches real frame pacing and, when frames stay too slow,
 * lowers the effective pixel ratio a step at a time. The game picks the new
 * value up on its next frame, so nothing has to be reloaded, patched or
 * restarted. When frames are comfortable again the ratio walks back up to the
 * device's native value, so the picture is only softer while the device
 * actually needs it.
 *
 * Deliberately conservative:
 *   - nothing changes during the first seconds, while shaders and models are
 *     still being uploaded;
 *   - a window needs a real sample count before it can trigger a step, so
 *     loading hitches, hidden tabs and a single long frame are ignored;
 *   - one long window only steps down once, and only a sustained run of fast
 *     windows steps back up;
 *   - the ratio never exceeds the device's real pixel ratio and never goes
 *     below MIN_RATIO;
 *   - if the browser refuses to let the property be shadowed, the script does
 *     nothing at all.
 *
 * Debug from the console: PolyTrackPerf.ratio, PolyTrackPerf.nativeRatio,
 * PolyTrackPerf.ladder, PolyTrackPerf.state, PolyTrackPerf.disable(). There is
 * deliberately no way to force a ratio above the device's native one.
 */
(function (global) {
  "use strict";

  var MIN_RATIO = 0.7;
  var MAX_RATIO = 2;
  var STEP_FACTOR = 0.85;

  var WINDOW_MS = 2000;
  var WARMUP_MS = 5000;
  var MIN_FRAMES = 12;
  var MAX_FRAME_MS = 250;

  var SLOW_FRAME_MS = 23; // ~43 fps or worse
  var VERY_SLOW_FRAME_MS = 40; // ~25 fps: take a bigger step
  var FAST_FRAME_MS = 17.5; // ~57 fps: comfortably vsynced at 60 Hz
  var SLOW_WINDOWS = 2;
  var FAST_WINDOWS = 6;

  /** Descending ratios from `max` down to MIN_RATIO, one step at a time. */
  function buildLadder(max) {
    var top = Math.min(max, MAX_RATIO);
    var ladder = [top];
    var ratio = top;
    while (ratio > MIN_RATIO + 0.001) {
      ratio = Math.max(MIN_RATIO, ratio * STEP_FACTOR);
      ladder.push(Math.round(ratio * 100) / 100);
    }
    return ladder;
  }

  function classify(medianMs) {
    if (medianMs > SLOW_FRAME_MS) return "slow";
    if (medianMs < FAST_FRAME_MS) return "fast";
    return "ok";
  }

  // Exposed so the test suite can check the ladder and thresholds without a
  // browser (the same pattern as api-base.js).
  global.__POLYTRACK_PERF__ = {
    buildLadder: buildLadder,
    classify: classify,
    MIN_RATIO: MIN_RATIO,
    MAX_RATIO: MAX_RATIO,
    SLOW_FRAME_MS: SLOW_FRAME_MS,
    FAST_FRAME_MS: FAST_FRAME_MS,
    WINDOW_MS: WINDOW_MS,
    MIN_FRAMES: MIN_FRAMES,
  };

  var doc = global.document;
  if (!doc || typeof global.requestAnimationFrame !== "function") return;

  var nativeRatio =
    typeof global.devicePixelRatio === "number" && isFinite(global.devicePixelRatio)
      ? global.devicePixelRatio
      : 1;
  if (!(nativeRatio > 0)) nativeRatio = 1;

  var ladder = buildLadder(nativeRatio);
  var index = 0;
  var enabled = true;
  var passthrough = false;

  // Shadowing the property is what lets the game see a lower ratio without any
  // change to the bundle. Browsers that do not allow it (or a page that already
  // redefined it) simply keep the native resolution.
  try {
    Object.defineProperty(global, "devicePixelRatio", {
      configurable: true,
      enumerable: true,
      get: function () {
        return passthrough ? nativeRatio : ladder[index];
      },
    });
  } catch (err) {
    return;
  }

  var now =
    typeof global.performance === "object" && global.performance && typeof global.performance.now === "function"
      ? function () {
          return global.performance.now();
        }
      : function () {
          return Date.now();
        };

  var samples = [];
  var windowStart = 0;
  var lastFrame = 0;
  var slowWindows = 0;
  var fastWindows = 0;
  var startedAt = now();

  function median(values) {
    var sorted = values.slice().sort(function (a, b) {
      return a - b;
    });
    var middle = sorted.length >> 1;
    if (sorted.length % 2) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function resetWindow(at) {
    samples.length = 0;
    windowStart = at;
    slowWindows = 0;
    fastWindows = 0;
  }

  function stepDown(amount) {
    var next = Math.min(ladder.length - 1, index + amount);
    if (next === index) return;
    index = next;
    slowWindows = 0;
  }

  function stepUp() {
    if (index === 0) return;
    index -= 1;
    fastWindows = 0;
  }

  function evaluate(at) {
    var count = samples.length;
    var medianMs = count > 0 ? median(samples) : 0;
    samples.length = 0;
    windowStart = at;

    // Too few frames means the tab was hidden or the device is so far behind
    // that the ratio is not the problem; never react to that.
    if (count < MIN_FRAMES) {
      slowWindows = 0;
      fastWindows = 0;
      return;
    }

    var verdict = classify(medianMs);
    if (verdict === "slow") {
      slowWindows += 1;
      fastWindows = 0;
    } else if (verdict === "fast") {
      fastWindows += 1;
      slowWindows = 0;
    } else {
      slowWindows = 0;
      fastWindows = 0;
    }

    if (slowWindows >= SLOW_WINDOWS) {
      stepDown(medianMs > VERY_SLOW_FRAME_MS ? 2 : 1);
    } else if (fastWindows >= FAST_WINDOWS) {
      stepUp();
    }
  }

  function frame(timestamp) {
    global.requestAnimationFrame(frame);
    if (!enabled) return;

    var at = typeof timestamp === "number" && isFinite(timestamp) ? timestamp : now();

    if (doc.hidden) {
      lastFrame = 0;
      if (windowStart !== 0) resetWindow(at);
      return;
    }

    if (lastFrame !== 0) {
      var delta = at - lastFrame;
      if (delta > 0 && delta <= MAX_FRAME_MS) samples.push(delta);
    }
    lastFrame = at;

    if (windowStart === 0) {
      if (at - startedAt >= WARMUP_MS) resetWindow(at);
      return;
    }
    if (at - windowStart >= WINDOW_MS) evaluate(at);
  }

  global.requestAnimationFrame(frame);

  global.PolyTrackPerf = {
    get ratio() {
      return ladder[index];
    },
    get nativeRatio() {
      return nativeRatio;
    },
    get ladder() {
      return ladder.slice();
    },
    get index() {
      return index;
    },
    // Exposed for support/debugging: what the governor saw in the last pass.
    get state() {
      return {
        samples: samples.length,
        windowMs: windowStart === 0 ? 0 : Math.round(now() - windowStart),
        slowWindows: slowWindows,
        fastWindows: fastWindows,
        enabled: enabled,
      };
    },
    /** Stops adapting and hands the device's real pixel ratio back. */
    disable: function () {
      enabled = false;
      passthrough = true;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
