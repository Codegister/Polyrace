/* PolyTrack real-device A/B performance harness.
 *
 * Inert unless the page is opened with ?perfab=1. It adds a small panel that
 * records, once per second while a race is running:
 *
 *   - frame time (mean / p50 / p95 / p99 / max) from requestAnimationFrame,
 *   - frames rendered and frames dropped against the display refresh,
 *   - long frames (>50 ms, >100 ms),
 *   - WebGL draws, instanced instances and triangles per frame (the work the
 *     track-stream layer removes), and
 *   - JS heap when the browser exposes performance.memory (Chrome/Edge; iOS
 *     Safari has no API for this, see README).
 *
 * Usage (on the device):
 *   ?perfab=1&trackstream=off   ... A: looping/old path
 *   ?perfab=1                   ... B: streamed track
 *   ?perfab=1&refresh=120       ... iPad Pro (ProMotion)
 *   ?perfab=1&duration=600      ... 10 minute run (default 300 s)
 *
 * Recording starts by itself a few seconds after the race HUD appears and stops
 * after `duration` seconds, so the same amount of race is measured in both
 * runs. Copy or download the JSON at the end. The panel never listens for keys
 * and does not touch the game.
 */
(function (global) {
  "use strict";

  var CONFIG = {
    duration: 300,
    refresh: 60,
    startDelay: 3,
    autostart: true,
    sampleMs: 250
  };

  function readInt(value, fallback, min, max) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  var search = "";
  try {
    search = (global.location && global.location.search) || "";
  } catch (err) {
    search = "";
  }
  var enabled = /(?:^\?|&)perfab(?:=|&|$)/.test(search);
  var raw = (global.location && global.location.search) || "";

  function param(name) {
    var match = new RegExp("[?&]" + name + "=([^&]*)").exec(raw);
    return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
  }

  CONFIG.duration = readInt(param("duration"), CONFIG.duration, 10, 3600);
  CONFIG.refresh = readInt(param("refresh"), CONFIG.refresh, 20, 240);
  CONFIG.startDelay = readInt(param("delay"), CONFIG.startDelay, 0, 120);
  CONFIG.autostart = param("autostart") !== "0";
  CONFIG.adaptive = param("adapt") !== "0";
  var label = /(?:^\?|&)trackstream=off(?:&|$)/.test(search) ? "off" : "on";

  /* ------------------------------------------------------------------ */
  /* WebGL counters: independent of the game and of track-stream.        */
  /* ------------------------------------------------------------------ */
  var gl = { calls: 0, instances: 0, triangles: 0 };

  function wrapDraw(proto, name, countArg, instancesArg) {
    if (!proto || typeof proto[name] !== "function") return;
    var original = proto[name];
    proto[name] = function () {
      var args = arguments;
      gl.calls++;
      var count = args[countArg] || 0;
      if (instancesArg >= 0) {
        var n = args[instancesArg] || 0;
        gl.instances += n;
        gl.triangles += (count / 3) * n;
      } else {
        gl.triangles += count / 3;
      }
      return original.apply(this, args);
    };
  }

  function instrumentWebGL() {
    var protos = [];
    if (global.WebGL2RenderingContext) {
      protos.push(global.WebGL2RenderingContext.prototype);
    }
    if (global.WebGLRenderingContext) {
      protos.push(global.WebGLRenderingContext.prototype);
    }
    for (var i = 0; i < protos.length; i++) {
      if (protos[i].__polytrackPerfWrapped) continue;
      protos[i].__polytrackPerfWrapped = true;
      wrapDraw(protos[i], "drawElementsInstanced", 1, 4);
      wrapDraw(protos[i], "drawArraysInstanced", 2, 3);
      wrapDraw(protos[i], "drawElements", 1, -1);
      wrapDraw(protos[i], "drawArrays", 2, -1);
    }
  }

  function takeGl() {
    var snapshot = {
      calls: gl.calls,
      instances: gl.instances,
      triangles: Math.round(gl.triangles)
    };
    gl.calls = 0;
    gl.instances = 0;
    gl.triangles = 0;
    return snapshot;
  }

  /* ------------------------------------------------------------------ */
  /* Measurement                                                         */
  /* ------------------------------------------------------------------ */
  var run = null;
  var rafId = 0;
  var startedOnce = false;
  var hudSince = 0;
  var lastTs = 0;
  var hidden = false;
  var api = {
    version: 1,
    config: CONFIG,
    label: label,
    start: startRun,
    stop: function () {
      finish("manual");
    },
    exportJSON: exportJSON,
    summary: function () {
      return run ? summarize() : null;
    },
    _percentile: percentile,
    _summarize: summarizeDurations
  };

  if (!enabled) return;
  api.config.adaptive = CONFIG.adaptive;
  if (!CONFIG.adaptive) {
    // Fixed pixel ratio in both runs, so frame time is comparable. The
    // governor is on by default because that is the shipped experience; it is
    // recorded per second either way.
    try {
      if (global.PolyTrackPerf && global.PolyTrackPerf.disable) {
        global.PolyTrackPerf.disable();
      }
    } catch (err) {
      /* governor absent */
    }
  }
  global.PolyTrackPerfAB = api;
  if (!global.document || !global.document.createElement) return;

  instrumentWebGL();

  function now() {
    return global.performance && global.performance.now
      ? global.performance.now()
      : Date.now();
  }

  function sorted(values) {
    return values.slice().sort(function (a, b) {
      return a - b;
    });
  }

  function percentile(values, p) {
    if (!values || !values.length) return 0;
    var s = sorted(values);
    var index = ((s.length - 1) * p) / 100;
    var low = Math.floor(index);
    var high = Math.ceil(index);
    if (low === high) return s[low];
    return s[low] + (s[high] - s[low]) * (index - low);
  }

  function mean(values) {
    if (!values.length) return 0;
    var total = 0;
    for (var i = 0; i < values.length; i++) total += values[i];
    return total / values.length;
  }

  function round(n, digits) {
    var factor = Math.pow(10, digits || 0);
    return Math.round(n * factor) / factor;
  }

  function jitterStats(durations, elapsedMs, refresh, extras) {
    var s = sorted(durations);
    var frames = durations.length;
    var expected = Math.round((elapsedMs / 1000) * refresh);
    var long50 = 0;
    var long100 = 0;
    for (var i = 0; i < durations.length; i++) {
      if (durations[i] > 50) long50++;
      if (durations[i] > 100) long100++;
    }
    return {
      durationMs: Math.round(elapsedMs),
      frames: frames,
      fps: elapsedMs > 0 ? round((frames * 1000) / elapsedMs, 1) : 0,
      frameMs: {
        mean: round(mean(durations), 2),
        p50: round(percentile(s, 50), 2),
        p90: round(percentile(s, 90), 2),
        p95: round(percentile(s, 95), 2),
        p99: round(percentile(s, 99), 2),
        max: round(s.length ? s[s.length - 1] : 0, 2)
      },
      long: {
        over50: long50,
        over100: long100,
        perMinute: elapsedMs > 0 ? round((long50 * 60000) / elapsedMs, 1) : 0
      },
      dropped: {
        refresh: refresh,
        expected: expected,
        count: Math.max(0, expected - frames),
        pct:
          expected > 0
            ? round((Math.max(0, expected - frames) * 100) / expected, 2)
            : 0
      },
      gl: extras && extras.gl ? extras.gl : null
    };
  }

  function summarizeDurations(durations, elapsedMs, refresh, extras) {
    return jitterStats(durations, elapsedMs, refresh || 60, extras);
  }

  function statsSnapshot() {
    try {
      var track = global.PolyTrackTrack;
      if (!track || typeof track.stats !== "function") return null;
      var list = track.stats();
      var state = list && list[0];
      if (!state) return null;
      return {
        mode: state.mode,
        eligible: state.eligible,
        instances: state.instances,
        drawn: state.drawn,
        draws: state.draws,
        radius: state.radius,
        farRadius: track.config && track.config.farRadius
      };
    } catch (err) {
      return null;
    }
  }

  function perfSnapshot() {
    try {
      var perf = global.PolyTrackPerf;
      if (!perf) return null;
      return {
        index: typeof perf.index === "number" ? perf.index : null,
        ratio: typeof perf.ratio === "number" ? round(perf.ratio, 2) : null,
        enabled: !!(perf.state && perf.state.enabled)
      };
    } catch (err) {
      return null;
    }
  }

  function heapMB() {
    try {
      var memory = global.performance && global.performance.memory;
      if (!memory || !isFinite(memory.usedJSHeapSize)) return null;
      return round(memory.usedJSHeapSize / 1048576, 1);
    } catch (err) {
      return null;
    }
  }

  function percentileOfFrameTimes(values, p) {
    return round(percentile(values, p), 2);
  }

  function startRun() {
    if (run && run.running) return;
    run = {
      running: true,
      startedAt: new Date().toISOString(),
      startedMs: now(),
      firstFrameTs: 0,
      lastFrameTs: 0,
      frames: 0,
      durations: [],
      buckets: [],
      bucket: null,
      bucketStart: 0,
      bucketDurations: [],
      bucketFrames: 0,
      bucketLong50: 0,
      bucketLong100: 0,
      bucketDrops: 0,
      bucketCalls: 0,
      bucketInstances: 0,
      bucketTriangles: 0,
      bucketInstancesMax: 0,
      glCalls: 0,
      glInstances: 0,
      glTriangles: 0,
      glInstancesMax: 0,
      heapStart: heapMB(),
      heapEnd: null,
      perfStart: perfSnapshot(),
      sawHud: false,
      invalid: null,
      streaming: null,
      track: null
    };
    startedOnce = true;
    takeGl();
    lastTs = 0;
    if (!rafId) rafId = global.requestAnimationFrame(frame);
    updatePanel();
    setStatus("running", "recording…");
  }

  function finish(reason) {
    if (!run || !run.running) return;
    run.running = false;
    run.stoppedReason = reason;
    run.stoppedAt = new Date().toISOString();
    var elapsed = run.lastFrameTs - run.firstFrameTs;
    run.elapsedMs = Math.max(0, elapsed);
    run.heapEnd = heapMB();
    if (reason === "tab hidden" || hidden) run.invalid = "tab was hidden";
    else if (!run.sawHud) run.invalid = "no race HUD during run";
    else if (reason === "left race") run.invalid = "race ended during run";
    run.summary = summarize();
    run.streaming = statsSnapshot();
    lastPaint = 0;
    updatePanel();
    setStatus(
      run.invalid ? "invalid: " + run.invalid : "done",
      run.invalid ? "re-run this session" : "copy the JSON"
    );
  }

  function summarize() {
    var summary = jitterStats(run.durations, run.elapsedMs, CONFIG.refresh, {
      gl: {
        callsMean: round(run.glCalls / Math.max(1, run.frames), 1),
        instancesMean: round(run.glInstances / Math.max(1, run.frames), 1),
        instancesMax: run.glInstancesMax,
        trianglesMean: round(run.glTriangles / Math.max(1, run.frames), 1)
      }
    });
    summary.streaming = statsSnapshot();
    summary.track = run.track || statsSnapshot();
    summary.performance = {
      governor: CONFIG.adaptive ? "on" : "pinned",
      indexStart: run.perfStart ? run.perfStart.index : null,
      indexEnd: perfSnapshot() ? perfSnapshot().index : null,
      ratioStart: run.perfStart ? run.perfStart.ratio : null,
      ratioEnd: perfSnapshot() ? perfSnapshot().ratio : null
    };
    summary.heap = {
      supported: run.heapStart !== null,
      startMB: run.heapStart,
      endMB: run.heapEnd,
      deltaMB:
        run.heapStart !== null && run.heapEnd !== null
          ? round(run.heapEnd - run.heapStart, 1)
          : null
    };
    summary.firstMinute = windowStats(1, 60);
    summary.lastMinute = windowStats(
      Math.max(1, CONFIG.duration - 60),
      CONFIG.duration
    );
    if (summary.firstMinute && summary.lastMinute) {
      summary.trend = {
        fpsRatio:
          summary.firstMinute.fps > 0
            ? round(summary.lastMinute.fps / summary.firstMinute.fps, 3)
            : null,
        p95Ratio:
          summary.firstMinute.p95 > 0
            ? round(summary.lastMinute.p95 / summary.firstMinute.p95, 3)
            : null
      };
    }
    return summary;
  }

  function windowStats(fromSec, toSec) {
    if (!run.buckets.length) return null;
    var frames = 0;
    var duration = 0;
    var long50 = 0;
    var drops = 0;
    var p95 = 0;
    var heap = null;
    for (var i = 0; i < run.buckets.length; i++) {
      var b = run.buckets[i];
      if (b.t <= fromSec || b.t > toSec + 0.001) continue;
      frames += b.frames;
      duration += b.durMs;
      long50 += b.long50;
      drops += b.drop;
      if (b.p95 > p95) p95 = b.p95;
      if (b.heapMB !== null && heap === null) heap = b.heapMB;
    }
    if (!duration) return null;
    return {
      frames: frames,
      durationMs: Math.round(duration),
      fps: round((frames * 1000) / duration, 1),
      p95: round(p95, 2),
      long50PerMin: round((long50 * 60000) / duration, 1),
      dropPct: round((drops * 100) / Math.max(1, duration / 1000 * CONFIG.refresh), 2),
      heapMB: heap
    };
  }

  function frame(ts) {
    rafId = global.requestAnimationFrame(frame);
    if (!run || !run.running) {
      lastTs = ts;
      takeGl();
      return;
    }
    var glThisFrame = takeGl();
    if (!run.firstFrameTs) {
      run.firstFrameTs = ts;
      run.bucketStart = ts;
      run.lastFrameTs = ts;
      run.lastTs = ts;
      return;
    }
    var dt = ts - (run.lastFrameTs || ts);
    run.lastFrameTs = ts;
    if (dt <= 0) return;
    run.frames++;
    run.durations.push(dt);
    run.glCalls += glThisFrame.calls;
    run.glInstances += glThisFrame.instances;
    run.glTriangles += glThisFrame.triangles;
    if (glThisFrame.instances > run.glInstancesMax) {
      run.glInstancesMax = glThisFrame.instances;
    }

    if (!run.bucket) {
      run.bucket = {
        start: ts,
        frames: 0,
        durations: [],
        long50: 0,
        long100: 0,
        calls: 0,
        instances: 0,
        triangles: 0,
        instancesMax: 0,
        heapMB: heapMB(),
        drawn: null
      };
    }
    run.bucket.frames++;
    run.bucket.durations.push(dt);
    if (dt > 50) run.bucket.long50++;
    if (dt > 100) run.bucket.long100++;
    run.bucket.calls += glThisFrame.calls;
    run.bucket.instances += glThisFrame.instances;
    run.bucket.triangles += glThisFrame.triangles;
    if (glThisFrame.instances > run.bucket.instancesMax) {
      run.bucket.instancesMax = glThisFrame.instances;
    }

    var bucketElapsed = ts - run.bucket.start;
    if (bucketElapsed >= 1000) {
      closeBucket(ts);
    }
    updatePanel();

    var elapsed = ts - run.firstFrameTs;
    if (elapsed >= CONFIG.duration * 1000) finish("duration");
  }

  function closeBucket(ts) {
    var b = run.bucket;
    var durMs = ts - b.start;
    if (durMs <= 0 || !b.frames) {
      run.bucket = null;
      return;
    }
    var expected = Math.round((durMs / 1000) * CONFIG.refresh);
    var snapshot = statsSnapshot();
    var track = run.track;
    run.buckets.push({
      t: round((ts - run.firstFrameTs) / 1000, 2),
      durMs: Math.round(durMs),
      frames: b.frames,
      fps: round((b.frames * 1000) / durMs, 1),
      p50: percentileOfFrameTimes(b.durations, 50),
      p95: percentileOfFrameTimes(b.durations, 95),
      max: round(Math.max.apply(null, b.durations), 2),
      long50: b.long50,
      long100: b.long100,
      drop: Math.max(0, expected - b.frames),
      calls: round(b.calls / b.frames, 1),
      instances: Math.round(b.instances / b.frames),
      instancesMax: b.instancesMax,
      triangles: Math.round(b.triangles / b.frames),
      drawn: snapshot ? snapshot.drawn : null,
      mode: snapshot ? snapshot.mode : null,
      packs: snapshot ? snapshot.packs : null,
      pending: snapshot ? snapshot.pending : null,
      perfIndex: perfSnapshot() ? perfSnapshot().index : null,
      heapMB: b.heapMB
    });
    if (snapshot) {
      run.streaming = snapshot;
      if (!track && snapshot.instances) run.track = snapshot;
    }
    run.hudVisible = hudVisible();
    if (run.hudVisible) run.sawHud = true;
    run.bucket = null;
  }

  function hudVisible() {
    try {
      return !!(
        global.document.querySelector("#ui .speedometer") &&
        global.document.querySelector("#ui .timer")
      );
    } catch (err) {
      return false;
    }
  }

  function exportJSON() {
    var snapshot = run || {};
    var payload = {
      harness: "polytrack-perf-ab/1",
      label: label,
      startedAt: snapshot.startedAt || null,
      stoppedAt: snapshot.stoppedAt || null,
      valid: !snapshot.invalid && !!snapshot.summary,
      invalidReason: snapshot.invalid || null,
      stopReason: snapshot.stoppedReason || null,
      meta: {
        url: global.location ? global.location.href : "",
        userAgent: global.navigator ? global.navigator.userAgent : "",
        platform: global.navigator ? global.navigator.platform : "",
        devicePixelRatio: global.devicePixelRatio || 1,
        screen: global.screen
          ? { width: global.screen.width, height: global.screen.height }
          : null,
        cores: global.navigator ? global.navigator.hardwareConcurrency : null,
        refresh: CONFIG.refresh,
        durationSec: CONFIG.duration,
        adaptiveResolution: CONFIG.adaptive,
        trackstream: label,
        streamingDisabledByUrl: label === "off"
      },
      config: {
        radius: global.PolyTrackTrack
          ? global.PolyTrackTrack.config.radius
          : null,
        farRadius: global.PolyTrackTrack
          ? global.PolyTrackTrack.config.farRadius
          : null,
        repackStep: global.PolyTrackTrack
          ? global.PolyTrackTrack.config.repackStep
          : null,
        enabled: global.PolyTrackTrack
          ? global.PolyTrackTrack.config.enabled
          : null
      },
      summary: snapshot.summary || null,
      buckets: snapshot.buckets || []
    };
    return JSON.stringify(payload, null, 2);
  }

  /* ------------------------------------------------------------------ */
  /* Panel                                                               */
  /* ------------------------------------------------------------------ */
  var panel = null;
  var statusEl = null;
  var metricsEl = null;
  var jsonEl = null;
  var buttons = {};

  function el(tag, styles, text) {
    var node = global.document.createElement(tag);
    node.style.cssText = styles || "";
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(labelText, handler) {
    var node = el(
      "button",
      "pointer-events:auto;touch-action:manipulation;font:inherit;color:#fff;" +
        "background:#2c3a5e;border:1px solid #4d6396;border-radius:4px;" +
        "padding:4px 7px;margin:0 4px 4px 0;cursor:pointer;",
      labelText
    );
    node.type = "button";
    node.addEventListener("click", function (event) {
      event.stopPropagation();
      handler();
    });
    return node;
  }

  function buildPanel() {
    panel = el(
      "div",
      "position:fixed;top:92px;right:8px;z-index:2147483647;width:250px;" +
        "box-sizing:border-box;padding:8px 9px;border-radius:6px;" +
        "background:rgba(8,14,28,.86);color:#e8eefc;border:1px solid #3b4f7a;" +
        "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
        "pointer-events:auto;user-select:text;-webkit-user-select:text;"
    );
    panel.addEventListener("pointerdown", function (event) {
      event.stopPropagation();
    });
    panel.addEventListener("touchstart", function (event) {
      event.stopPropagation();
    });

    var head = el(
      "div",
      "display:flex;justify-content:space-between;align-items:center;gap:6px;",
      ""
    );
    head.appendChild(el("strong", "letter-spacing:.04em;", "PERF A/B · " + label));
    var collapse = el(
      "button",
      "font:inherit;color:#cfe0ff;background:none;border:0;padding:0 2px;" +
        "cursor:pointer;",
      "–"
    );
    collapse.type = "button";
    collapse.title = "collapse";
    collapse.addEventListener("click", function (event) {
      event.stopPropagation();
      toggleCollapsed();
    });
    head.appendChild(collapse);
    panel.appendChild(head);

    statusEl = el(
      "div",
      "color:#9fb4d8;margin:2px 0 4px;white-space:pre-wrap;",
      "waiting for a race…"
    );
    panel.appendChild(statusEl);

    metricsEl = el(
      "div",
      "white-space:pre-wrap;min-height:2.6em;color:#fff;",
      ""
    );
    panel.appendChild(metricsEl);

    var row = el("div", "margin-top:4px;", "");
    buttons.start = button("Start", function () {
      startRun();
    });
    buttons.stop = button("Stop", function () {
      finish("manual");
    });
    buttons.copy = button("Copy JSON", copyJson);
    buttons.download = button("Download", downloadJson);
    row.appendChild(buttons.start);
    row.appendChild(buttons.stop);
    row.appendChild(buttons.copy);
    row.appendChild(buttons.download);
    panel.appendChild(row);

    panel.appendChild(
      el(
        "div",
        "color:#8296b8;margin-top:2px;font-size:10px;",
        "auto: starts " +
          CONFIG.startDelay +
          "s after HUD, stops after " +
          (CONFIG.duration < 60
            ? CONFIG.duration + "s"
            : Math.round(CONFIG.duration / 60) + "min")
      )
    );

    jsonEl = el(
      "textarea",
      "display:none;width:100%;height:140px;margin-top:6px;box-sizing:border-box;" +
        "font:10px/1.3 ui-monospace,Menlo,monospace;background:#0b1220;" +
        "color:#dbe6fb;border:1px solid #3b4f7a;border-radius:4px;",
      ""
    );
    jsonEl.readOnly = true;
    panel.appendChild(jsonEl);

    panel.style.display = "none";
    global.document.body.appendChild(panel);
    updatePanel();
  }

  function showPanel() {
    if (!panel) return;
    if (panel.style.display !== "block") {
      panel.style.display = "block";
      updatePanel();
    }
  }

  function hidePanel() {
    if (!panel) return;
    if (panel.style.display !== "none") panel.style.display = "none";
  }

  var collapsed = false;
  function toggleCollapsed() {
    collapsed = !collapsed;
    var children = panel.children;
    for (var i = 1; i < children.length; i++) {
      children[i].style.display = collapsed ? "none" : "";
    }
    if (!collapsed) updatePanel();
  }

  var lastPaint = 0;
  function updatePanel() {
    if (!panel) return;
    var t = now();
    if (t - lastPaint < 100) return;
    lastPaint = t;
    if (!run) {
      metricsEl.textContent = "no run yet";
      buttons.start.style.display = "";
      buttons.stop.style.display = "none";
      buttons.copy.style.display = "none";
      buttons.download.style.display = "none";
      return;
    }
    var elapsed = run.lastFrameTs
      ? (run.lastFrameTs - run.firstFrameTs) / 1000
      : 0;
    if (run.running) {
      var recent = run.bucket ? run.bucket.durations : [];
      var fps = run.frames && elapsed > 0 ? run.frames / elapsed : 0;
      var glInfo = "calls " + (run.bucket ? run.bucket.calls / Math.max(1, run.bucket.frames) : 0).toFixed(0) +
        "  inst " + (run.bucket ? run.bucket.instances / Math.max(1, run.bucket.frames) : 0).toFixed(0) +
        "  tris " + (run.bucket ? run.bucket.triangles / Math.max(1, run.bucket.frames) : 0).toFixed(0);
      metricsEl.textContent =
        "t " + elapsed.toFixed(0) + "s / " + CONFIG.duration + "s\n" +
        "fps " + fps.toFixed(1) +
        "  p95 " + percentileOfFrameTimes(recent, 95).toFixed(1) + "ms\n" +
        ">50ms " + (run.bucket ? run.bucket.long50 : 0) + "/s" +
        "  heap " + (heapMB() === null ? "n/a" : heapMB() + "MB") + "\n" +
        glInfo;
      buttons.start.style.display = "none";
      buttons.stop.style.display = "";
      buttons.copy.style.display = "none";
      buttons.download.style.display = "none";
      return;
    }
    var summary = run.summary || summarize();
    var track =
      label === "off"
        ? "streaming: off (URL)"
        : run.track && run.track.mode
          ? run.track.mode + " " + run.track.drawn + "/" + run.track.instances
          : "waiting for track stats";
    metricsEl.textContent =
      "valid: " + (run.invalid ? "NO (" + run.invalid + ")" : "yes") + "\n" +
      "fps " + summary.fps +
      "  p95 " + summary.frameMs.p95 + "ms\n" +
      ">50ms/min " + summary.long.perMinute +
      "  drop " + summary.dropped.pct + "%\n" +
      track;
    buttons.start.style.display = "";
    buttons.stop.style.display = "none";
    buttons.copy.style.display = "";
    buttons.download.style.display = "";
  }

  function setStatus(kind, text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = kind === "invalid" ? "#ffb3b3" : "#9fb4d8";
  }

  function copyJson() {
    var text = exportJSON();
    if (jsonEl) {
      jsonEl.value = text;
      jsonEl.style.display = "block";
      jsonEl.focus();
      jsonEl.select();
    }
    var clipboard = global.navigator && global.navigator.clipboard;
    if (clipboard && clipboard.writeText) {
      clipboard.writeText(text).then(
        function () {
          setStatus("ok", "JSON copied to the clipboard");
        },
        function () {
          setStatus("ok", "select the text below and copy");
        }
      );
    } else {
      setStatus("ok", "select the text below and copy");
    }
  }

  function downloadJson() {
    try {
      var blob = new Blob([exportJSON()], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = global.document.createElement("a");
      var date = new Date();
      var stamp =
        date.getFullYear() +
        ("0" + (date.getMonth() + 1)).slice(-2) +
        ("0" + date.getDate()).slice(-2) +
        "-" +
        ("0" + date.getHours()).slice(-2) +
        ("0" + date.getMinutes()).slice(-2);
      a.href = url;
      a.download =
        "polytrack-winterfell-" + label + "-" + stamp + ".json";
      a.style.display = "none";
      global.document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        a.parentNode && a.parentNode.removeChild(a);
      }, 1000);
    } catch (err) {
      setStatus("invalid", "download unavailable, use Copy");
    }
  }

  global.document.addEventListener("visibilitychange", function () {
    if (global.document.hidden && run && run.running) {
      hidden = true;
      finish("tab hidden");
    }
  });

  var poll = global.setInterval(function () {
    if (!panel) return;
    // The panel only exists during and after a run: in the menu it would sit on
    // top of the track browser.
    if (hudVisible() || run) showPanel();
    else hidePanel();
    if (run) {
      if (run.running) {
        var visible = hudVisible();
        if (visible) {
          run.sawHud = true;
          run.hudGoneSince = 0;
        } else {
          run.hudGoneSince = run.hudGoneSince || now();
          if (now() - run.hudGoneSince > 2000) finish("left race");
        }
      }
      lastPaint = 0;
      updatePanel();
      return;
    }
    if (CONFIG.autostart && !startedOnce && hudVisible()) {
      hudSince = hudSince || now();
      if (now() - hudSince >= CONFIG.startDelay * 1000) startRun();
    } else if (!hudVisible()) {
      hudSince = 0;
    }
  }, CONFIG.sampleMs);

  buildPanel();
})(typeof window !== "undefined" ? window : this);
