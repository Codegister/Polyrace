/*
 * PolyTrack multiplayer - local transport.
 *
 * BroadcastChannel relay between tabs/windows of the same origin. It exists so
 * multiplayer can be played and debugged with no account, no key and no
 * network: open two windows, host in one, join with the code in the other.
 *
 * On a real deployment every client is a separate machine, so this transport
 * only covers same-browser play. transport-ably.js covers the real case.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PolyTrackTransportLocal = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function supports() {
    return typeof BroadcastChannel === "function";
  }

  function createLocalTransport(roomCode, clientId) {
    if (!supports()) {
      throw new Error("BroadcastChannel is not available");
    }
    var channel = new BroadcastChannel("polytrack-mp:" + roomCode);
    var handlers = [];
    var closed = false;

    channel.onmessage = function (event) {
      if (closed) return;
      var data = event && event.data;
      if (!data || data.from === clientId) return;
      for (var i = 0; i < handlers.length; i++) {
        try {
          handlers[i](data.from, data.payload);
        } catch (err) {
          if (typeof console !== "undefined") console.error(err);
        }
      }
    };

    return {
      name: "local",
      label: "same-browser tabs",
      send: function (payload) {
        if (closed) return;
        channel.postMessage({ from: clientId, payload: payload });
      },
      onMessage: function (handler) {
        handlers.push(handler);
      },
      close: function () {
        if (closed) return;
        closed = true;
        try {
          channel.close();
        } catch (err) {
          /* already closed */
        }
      },
    };
  }

  return { supports: supports, createLocalTransport: createLocalTransport };
});
