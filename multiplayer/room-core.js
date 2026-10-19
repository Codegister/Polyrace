/*
 * PolyTrack multiplayer - room core.
 *
 * Transport-agnostic lobby/room state machine. No DOM, no network: the
 * transports in transport-*.js only move opaque payloads, and this module
 * decides who is in the room, who hosts, and what the renderer should draw.
 *
 * Loaded as a plain script in the browser (exposes PolyTrackRoomCore) and via
 * require() in the Node test suite.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PolyTrackRoomCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Codes are read aloud and typed by hand, so 0 and 1 are excluded and
  // normalisation folds the characters people mistype into their letters.
  var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";
  var CODE_LENGTH = 5;
  var MAX_PLAYERS = 16;
  var MIN_PLAYERS = 2;
  var HEARTBEAT_MS = 2000;
  var PEER_TIMEOUT_MS = 7000;

  var GAME_MODES = ["casual", "competitive"];
  var DEFAULT_SETTINGS = { mode: "casual", maxPlayers: 8, track: null };

  function clampMaxPlayers(value) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return DEFAULT_SETTINGS.maxPlayers;
    if (n < MIN_PLAYERS) return MIN_PLAYERS;
    if (n > MAX_PLAYERS) return MAX_PLAYERS;
    return n;
  }

  /** Coerces untrusted (peer-supplied) host settings into a known shape. */
  function normalizeSettings(input) {
    var raw = input && typeof input === "object" ? input : {};
    return {
      mode: GAME_MODES.indexOf(raw.mode) === -1 ? DEFAULT_SETTINGS.mode : raw.mode,
      maxPlayers: clampMaxPlayers(
        raw.maxPlayers === undefined ? DEFAULT_SETTINGS.maxPlayers : raw.maxPlayers
      ),
      track:
        typeof raw.track === "string" && raw.track.length > 0 ? raw.track : null,
    };
  }

  function makeRoomCode(random) {
    var rnd = random || Math.random;
    var out = "";
    for (var i = 0; i < CODE_LENGTH; i++) {
      var pick = Math.floor(rnd() * ALPHABET.length);
      if (pick < 0) pick = 0;
      if (pick >= ALPHABET.length) pick = ALPHABET.length - 1;
      out += ALPHABET.charAt(pick);
    }
    return out;
  }

  function normalizeRoomCode(raw) {
    if (typeof raw !== "string") return null;
    var code = raw
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .replace(/0/g, "O")
      .replace(/1/g, "I");
    if (code.length !== CODE_LENGTH) return null;
    for (var i = 0; i < code.length; i++) {
      if (ALPHABET.indexOf(code.charAt(i)) === -1) return null;
    }
    return code;
  }

  function isRoomCode(raw) {
    return normalizeRoomCode(raw) === raw && typeof raw === "string";
  }

  function createRoom(options) {
    var opts = options || {};
    var clock = opts.now || function () {
      return Date.now();
    };
    // Accept both the modern `settings` object and the older `maxPlayers`
    // shortcut so existing callers keep working.
    var settings = normalizeSettings(
      opts.settings ||
        (opts.maxPlayers !== undefined ? { maxPlayers: opts.maxPlayers } : undefined)
    );
    var selfId = opts.selfId;
    var selfName = opts.name || "Player";
    var onChange = opts.onChange || function () {};
    var roomCode = opts.roomCode || null;

    // id -> {id, name, lastSeen, state}
    var players = new Map();

    // Race phase is host-driven: "lobby" until the host starts, then "racing"
    // on every peer with the track the host picked. Kept outside `players` so a
    // late joiner cannot resurrect a finished race before the host sends it.
    var phase = "lobby";
    var raceTrack = null;

    function emit() {
      onChange(snapshot());
    }

    function ensureSelf() {
      var existing = players.get(selfId);
      if (existing) {
        existing.name = selfName;
        existing.lastSeen = clock();
        existing.isLocal = true;
        return existing;
      }
      var entry = {
        id: selfId,
        name: selfName,
        lastSeen: clock(),
        state: null,
        isLocal: true,
      };
      players.set(selfId, entry);
      return entry;
    }

    function addPeer(id, name, state) {
      if (!id || id === selfId) return null;
      var existing = players.get(id);
      if (existing) {
        existing.lastSeen = clock();
        if (name) existing.name = name;
        if (state !== undefined) existing.state = state;
        return existing;
      }
      if (players.size >= settings.maxPlayers) return null;
      var entry = {
        id: id,
        name: name || "Player",
        lastSeen: clock(),
        state: state === undefined ? null : state,
        isLocal: false,
      };
      players.set(id, entry);
      return entry;
    }

    function removePeer(id) {
      if (id === selfId) return false;
      return players.delete(id);
    }

    // Host is derived, never elected: the lowest id present is the host, so
    // every client agrees without a negotiation round-trip.
    function hostId() {
      var lowest = null;
      players.forEach(function (entry) {
        if (lowest === null || entry.id < lowest) lowest = entry.id;
      });
      return lowest;
    }

    function snapshot() {
      var list = [];
      players.forEach(function (entry) {
        list.push({
          id: entry.id,
          name: entry.name,
          isLocal: !!entry.isLocal,
          state: entry.state,
          age: clock() - entry.lastSeen,
        });
      });
      list.sort(function (a, b) {
        if (a.id === b.id) return 0;
        return a.id < b.id ? -1 : 1;
      });
      var host = hostId();
      return {
        phase: phase,
        raceTrack: raceTrack,
        roomCode: roomCode,
        selfId: selfId,
        selfName: selfName,
        hostId: host,
        isHost: host === selfId,
        count: list.length,
        maxPlayers: settings.maxPlayers,
        settings: {
          mode: settings.mode,
          maxPlayers: settings.maxPlayers,
          track: settings.track,
        },
        full: list.length >= settings.maxPlayers,
        players: list,
      };
    }

    return {
      selfId: selfId,

      get maxPlayers() {
        return settings.maxPlayers;
      },

      get settings() {
        return settings;
      },

      /** Only the host's settings win; peers' suggestions are ignored. */
      setSettings: function (next) {
        settings = normalizeSettings(next);
        emit();
        return settings;
      },

      settingsMessage: function () {
        return { t: "settings", s: settings };
      },

      get roomCode() {
        return roomCode;
      },

      setName: function (name) {
        selfName = name || "Player";
        ensureSelf();
        emit();
      },

      join: function (code) {
        roomCode = code;
        phase = "lobby";
        raceTrack = null;
        players.clear();
        ensureSelf();
        emit();
        return snapshot();
      },

      leave: function () {
        var wasInRoom = roomCode !== null;
        roomCode = null;
        phase = "lobby";
        raceTrack = null;
        players.clear();
        if (wasInRoom) emit();
      },

      /** Handles one peer payload. Returns true when visible state changed. */
      handleMessage: function (fromId, message) {
        if (!message || typeof message !== "object" || !fromId) return false;
        var changed = false;
        switch (message.t) {
          case "hello":
            changed = !!addPeer(fromId, message.name);
            break;
          case "welcome":
            if (!players.has(fromId)) {
              changed = !!addPeer(fromId, message.name);
            }
            break;
          case "state":
            if (players.has(fromId)) {
              var peer = players.get(fromId);
              peer.state = message.s || null;
              peer.lastSeen = clock();
            } else {
              changed = !!addPeer(fromId, message.name, message.s || null);
            }
            break;
          case "settings":
            if (fromId === hostId()) {
              settings = normalizeSettings(message.s);
              changed = true;
            }
            break;
          case "start":
            // Only the host's start counts, and only for a track it names.
            if (fromId === hostId() && typeof message.track === "string" && message.track) {
              phase = "racing";
              raceTrack = message.track;
              changed = true;
            }
            break;
          case "bye":
            changed = removePeer(fromId);
            break;
          default:
            return false;
        }
        if (changed) emit();
        return changed;
      },

      setLocalState: function (state) {
        var self = ensureSelf();
        self.state = state;
      },

      /** Drops peers that stopped sending heartbeats. */
      tick: function () {
        var cutoff = clock() - PEER_TIMEOUT_MS;
        var dropped = false;
        var stale = [];
        players.forEach(function (entry) {
          if (!entry.isLocal && entry.lastSeen < cutoff) stale.push(entry.id);
        });
        for (var i = 0; i < stale.length; i++) {
          players.delete(stale[i]);
          dropped = true;
        }
        if (dropped) emit();
        return dropped;
      },

      hello: function () {
        return { t: "hello", name: selfName };
      },

      stateMessage: function (state) {
        return { t: "state", name: selfName, s: state };
      },

      bye: function () {
        return { t: "bye", name: selfName };
      },

      /**
       * Starts the race locally (host only) and returns the payload to
       * broadcast. Refuses when no track has been chosen, because every peer
       * needs a track it can actually open.
       */
      beginRace: function () {
        if (hostId() !== selfId || !settings.track) return null;
        phase = "racing";
        raceTrack = settings.track;
        emit();
        return { t: "start", track: settings.track };
      },

      snapshot: snapshot,
    };
  }

  return {
    ALPHABET: ALPHABET,
    CODE_LENGTH: CODE_LENGTH,
    MAX_PLAYERS: MAX_PLAYERS,
    MIN_PLAYERS: MIN_PLAYERS,
    GAME_MODES: GAME_MODES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    clampMaxPlayers: clampMaxPlayers,
    normalizeSettings: normalizeSettings,
    HEARTBEAT_MS: HEARTBEAT_MS,
    PEER_TIMEOUT_MS: PEER_TIMEOUT_MS,
    makeRoomCode: makeRoomCode,
    normalizeRoomCode: normalizeRoomCode,
    isRoomCode: isRoomCode,
    createRoom: createRoom,
  };
});
