/*
 * PolyTrack multiplayer - simulation worker tap.
 *
 * MUST load before main.bundle.js. The game runs all physics in a worker
 * created as `new Worker("simulation_worker.bundle.js")`, so wrapping the
 * Worker constructor gives a read-only view of both message directions without
 * touching a single line of the minified game code.
 *
 * Incoming (worker -> page):
 *   { messageType: 10, carStates: [ { id, frames, speedKmh, position,
 *     quaternion, ... } ] }
 *
 * Outgoing (page -> worker), relevant types:
 *   3 CreateCar, 4 DeleteCar, 5 StartCar, 6 ControlCar, 7 PauseCar
 */
(function () {
  "use strict";

  var messageHandlers = [];
  var postHandlers = [];
  var workers = [];

  function notify(list, payload, worker) {
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](payload, worker);
      } catch (err) {
        if (typeof console !== "undefined") console.error("[PolyTrackNet]", err);
      }
    }
  }

  function instrument(worker, url) {
    worker.__polytrackUrl = url;
    worker.addEventListener("message", function (event) {
      notify(messageHandlers, event.data, worker);
    });
    var nativePost = worker.postMessage;
    worker.postMessage = function (message, transfer) {
      notify(postHandlers, message, worker);
      if (transfer === undefined) return nativePost.call(worker, message);
      return nativePost.call(worker, message, transfer);
    };
    workers.push(worker);
    return worker;
  }

  if (typeof Worker === "function") {
    var NativeWorker = Worker;
    var TappedWorker = function (url, options) {
      var worker =
        options === undefined ? new NativeWorker(url) : new NativeWorker(url, options);
      return instrument(worker, String(url));
    };
    TappedWorker.prototype = NativeWorker.prototype;
    try {
      Object.setPrototypeOf(TappedWorker, NativeWorker);
    } catch (err) {
      /* older engines: prototype assignment above is enough */
    }
    window.Worker = TappedWorker;
  }

  window.PolyTrackNet = {
    version: 1,
    workers: workers,
    onWorkerMessage: function (handler) {
      messageHandlers.push(handler);
      return function () {
        var i = messageHandlers.indexOf(handler);
        if (i !== -1) messageHandlers.splice(i, 1);
      };
    },
    onWorkerPost: function (handler) {
      postHandlers.push(handler);
      return function () {
        var i = postHandlers.indexOf(handler);
        if (i !== -1) postHandlers.splice(i, 1);
      };
    },
    // Replaced by multiplayer.bundle.js once remote players exist.
    remoteCars: function () {
      return [];
    },
  };
})();
