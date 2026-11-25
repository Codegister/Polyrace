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
 * Asymmetric on purpose: it reacts quickly to a drop (one slow window is
 * enough, a very slow one takes a double step) but recovers slowly, because a
 * device that was struggling a moment ago usually still is. The window is short
 * (0.7 s) and the slow threshold sits just above vsync (19 ms, ~52 fps) so a
 * 45-50 fps spell is caught inside the second it happens instead of falling in
 * the dead band between "ok" and "slow". While the ratio is
 * reduced a small badge in the corner says so, so a softer picture never looks
 * like a bug.
 *
 * Deliberately careful:
 *   - nothing changes during the first seconds, while shaders and models are
 *     still being uploaded;
 *   - a window needs a real sample count before it can trigger a step, so
 *     loading hitches, hidden tabs and a single long frame are ignored;
 *   - only a sustained run of fast windows steps back up, and never within
 *     RECOVER_HOLD_MS of a step down;
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

  var WINDOW_MS = 700;
  var WARMUP_MS = 2500;
  var MIN_FRAMES = 8;
  var MAX_FRAME_MS = 250;

  var SLOW_FRAME_MS = 19; // ~52 fps: a 45-50 fps spell must not look "ok"
  var VERY_SLOW_FRAME_MS = 33; // ~30 fps: take a bigger step
  var FAST_FRAME_MS = 17.2; // essentially vsynced at 60 Hz
  var SLOW_WINDOWS = 1; // react to the first bad window
  var FAST_WINDOWS = 16; // ~11 s of clean frames before it climbs back
  var RECOVER_HOLD_MS = 4000; // never climb back straight after a step down

  var INDICATOR_ID = "perf-indicator";

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
    VERY_SLOW_FRAME_MS: VERY_SLOW_FRAME_MS,
    FAST_FRAME_MS: FAST_FRAME_MS,
    WINDOW_MS: WINDOW_MS,
    WARMUP_MS: WARMUP_MS,
    MIN_FRAMES: MIN_FRAMES,
    SLOW_WINDOWS: SLOW_WINDOWS,
    FAST_WINDOWS: FAST_WINDOWS,
    RECOVER_HOLD_MS: RECOVER_HOLD_MS,
    INDICATOR_ID: INDICATOR_ID,
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
  var holdUntil = 0;

  // The badge only exists while the ratio is reduced, and it never takes input.
  var indicator = null;
  var indicatorText = "";

  function ensureIndicator() {
    if (indicator) return indicator;
    if (!doc.body || typeof doc.createElement !== "function") return null;
    var el = doc.createElement("div");
    el.id = INDICATOR_ID;
    el.setAttribute("role", "status");
    el.style.cssText =
      "position:fixed;" +
      "top:calc(8px + env(safe-area-inset-top, 0px));" +
      "left:calc(8px + env(safe-area-inset-left, 0px));" +
      "z-index:50;" +
      "margin:0;padding:3px 7px;border-radius:5px;" +
      "background:rgba(10,10,20,0.6);" +
      "color:#fff;" +
      "font:11px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif;" +
      "letter-spacing:0.02em;" +
      "white-space:nowrap;" +
      "opacity:0;transition:opacity 0.25s ease;" +
      "pointer-events:none;user-select:none;";
    doc.body.appendChild(el);
    indicator = el;
    return el;
  }

  function updateIndicator() {
    if (index === 0 || !enabled || passthrough) {
      if (indicator) indicator.style.opacity = "0";
      return;
    }
    var el = ensureIndicator();
    if (!el) return;
    // Relative to the device's own ratio, so 100% means "as sharp as ever".
    var percent = Math.round((ladder[index] / nativeRatio) * 100);
    var text = "Resolution " + percent + "%";
    if (text !== indicatorText) {
      indicatorText = text;
      el.textContent = text;
    }
    el.style.opacity = "1";
  }

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

  function stepDown(amount, at) {
    var next = Math.min(ladder.length - 1, index + amount);
    if (next === index) return;
    index = next;
    slowWindows = 0;
    fastWindows = 0;
    holdUntil = at + RECOVER_HOLD_MS;
    updateIndicator();
  }

  function stepUp() {
    if (index === 0) return;
    index -= 1;
    fastWindows = 0;
    updateIndicator();
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
      // A step down buys the device breathing room; do not spend it again on
      // the very next window, or a borderline device would see-saw.
      if (at < holdUntil) fastWindows = 0;
      else fastWindows += 1;
      slowWindows = 0;
    } else {
      slowWindows = 0;
      fastWindows = 0;
    }

    if (slowWindows >= SLOW_WINDOWS) {
      stepDown(medianMs > VERY_SLOW_FRAME_MS ? 2 : 1, at);
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
      return passthrough ? nativeRatio : ladder[index];
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
      index = 0;
      updateIndicator();
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
