/*
 * PolyTrack multiplayer - Ably transport (real internet play).
 *
 * Ably is loaded lazily from ./vendor/ably.min.js so the SDK is only paid for
 * when multiplayer is actually configured. Until that file exists (see
 * MULTIPLAYER.md) this transport refuses to start and the UI falls back to the
 * same-browser tab transport.
 *
 * Security note: the browser key is a capability key. Scope it to
 * publish/subscribe on `polytrack-mp:*` only - never ship a full-access key.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PolyTrackTransportAbly = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SDK_PATH = "multiplayer/vendor/ably.min.js";
  var sdkPromise = null;

  function loadSdk() {
    if (typeof Ably !== "undefined") return Promise.resolve(Ably);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject) {
      if (typeof document === "undefined") {
        reject(new Error("Ably SDK can only be loaded in a browser"));
        return;
      }
      var script = document.createElement("script");
      script.src = SDK_PATH;
      script.async = true;
      script.onload = function () {
        if (typeof Ably === "undefined") {
          reject(new Error("Ably SDK loaded but did not define Ably"));
          return;
        }
        resolve(Ably);
      };
      script.onerror = function () {
        reject(new Error("Ably SDK not found at " + SDK_PATH));
      };
      document.head.appendChild(script);
    });
    return sdkPromise;
  }

  function channelName(roomCode) {
    return "polytrack-mp:" + roomCode;
  }

  function createAblyTransport(roomCode, clientId, apiKey) {
    if (!apiKey) {
      return Promise.reject(new Error("No Ably key configured"));
    }
    return loadSdk().then(function (Ably) {
      var client = new Ably.Realtime({ key: apiKey, clientId: clientId });
      var channel = client.channels.get(channelName(roomCode));
      var handlers = [];
      var closed = false;

      channel.subscribe("m", function (message) {
        if (closed) return;
        var payload = message && message.data;
        if (!payload || payload.from === clientId) return;
        for (var i = 0; i < handlers.length; i++) {
          try {
            handlers[i](payload.from, payload.payload);
          } catch (err) {
            if (typeof console !== "undefined") console.error(err);
          }
        }
      });

      return {
        name: "ably",
        label: "online",
        send: function (payload) {
          if (closed) return;
          channel.publish("m", { from: clientId, payload: payload }).catch(function (err) {
            if (typeof console !== "undefined") console.error("[PolyTrackNet]", err);
          });
        },
        onMessage: function (handler) {
          handlers.push(handler);
        },
        close: function () {
          if (closed) return;
          closed = true;
          try {
            client.close();
          } catch (err) {
            /* already closed */
          }
        },
      };
    });
  }

  return {
    sdkPath: SDK_PATH,
    loadSdk: loadSdk,
    createAblyTransport: createAblyTransport,
  };
});
