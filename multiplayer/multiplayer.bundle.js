/*
 * PolyTrack multiplayer - client layer.
 *
 * Loads after the game bundles. Responsibilities:
 *   1. read the local car's state out of the tapped simulation worker
 *   2. run a room (invite codes, presence, host) over a transport
 *   3. stream local state ~12 Hz and keep remote players' latest state
 *   4. render the menu entry, Join/Host dialogs and lobby in the game's own
 *      visual language (see ui.css), and expose PolyTrackNet.remoteCars()
 *
 * Nothing here mutates game memory: remote cars are made available as data.
 */
(function () {
  "use strict";

  var core = window.PolyTrackRoomCore;
  var net = window.PolyTrackNet;
  if (!core || !net) {
    if (typeof console !== "undefined") {
      console.error("[PolyTrackNet] room core or worker tap missing");
    }
    return;
  }

  var config = window.POLYTRACK_MP_CONFIG || {};
  var STATE_INTERVAL_MS = 80;
  var HELLO_INTERVAL_MS = 2000;

  // Simulation worker protocol.
  var MSG_CONTROL_CAR = 6;
  var MSG_UPDATE_RESULT = 10;

  var transport = null;
  var localCarId = null;
  var localState = null;
  var lastHelloAt = 0;
  var status = "idle";
  var statusDetail = "";
  var loop = null;

  // Host dialog choices (only meaningful on the host side).
  var hostSettings = core.normalizeSettings({ mode: "casual", maxPlayers: 8, track: null });

  var selfId = readStored("polytrack-mp-id", function () {
    return (
      "p" +
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36).slice(-4)
    );
  });
  var selfName = readStored("polytrack-mp-name", function () {
    return "Player " + selfId.slice(1, 4).toUpperCase();
  });

  var room = core.createRoom({
    selfId: selfId,
    name: selfName,
    settings: hostSettings,
    onChange: function () {
      refreshOpenView();
    },
  });

  /**
   * Index of the active profile slot. The game writes this key with
   * `JSON.stringify`, so accept 1, "1" and quoted forms alike, and fall back to
   * the first slot that actually holds a profile.
   */
  function activeProfileSlot(storage) {
    var slot = 0;
    var raw = null;
    try {
      raw = storage.getItem("polytrack_v4_prod_user_slot");
    } catch (err) {
      raw = null;
    }
    if (raw !== null && raw !== undefined) {
      var parsed = raw;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        parsed = raw;
      }
      var numeric = Number(parsed);
      if (isFinite(numeric) && numeric >= 0) slot = Math.floor(numeric);
    }
    if (readProfile(storage, slot)) return slot;
    for (var i = 0; i < 3; i++) {
      if (readProfile(storage, i)) return i;
    }
    return slot;
  }

  function readProfile(storage, slot) {
    try {
      var raw = storage.getItem("polytrack_v4_prod_user_" + slot);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      var name = typeof parsed.nickname === "string" ? parsed.nickname.trim() : "";
      return name ? { nickname: name, token: parsed.token } : null;
    } catch (err) {
      return null;
    }
  }

  function readStored(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      if (value) return value;
      var made = fallback();
      window.localStorage.setItem(key, made);
      return made;
    } catch (err) {
      return fallback();
    }
  }

  /**
   * Current game profile nickname. Profiles live in localStorage as
   * `polytrack_v4_prod_user_<slot>` -> { token, nickname, carColors }, with the
   * active slot in `polytrack_v4_prod_user_slot`. Falls back to the game's own
   * default nickname.
   */
  function currentNickname() {
    try {
      var storage = window.localStorage;
      var profile = readProfile(storage, activeProfileSlot(storage));
      if (profile) return profile.nickname;
    } catch (err) {
      /* private mode or corrupt profile: fall through to the default */
    }
    return "Anonymous";
  }

  function summarize(state) {
    if (!state) return null;
    var position = state.position || {};
    var quaternion = state.quaternion || {};
    return {
      f: state.frames || 0,
      v: Math.round(state.speedKmh || 0),
      p: [round(position.x), round(position.y), round(position.z)],
      q: [
        round(quaternion.x),
        round(quaternion.y),
        round(quaternion.z),
        round(quaternion.w),
      ],
      b: state.brakeLightEnabled ? 1 : 0,
      s: state.hasStarted ? 1 : 0,
      k: state.nextCheckpointIndex || 0,
    };
  }

  function round(value) {
    return typeof value === "number" && isFinite(value)
      ? Math.round(value * 1000) / 1000
      : 0;
  }

  // ---------------------------------------------------------------- sim tap

  net.onWorkerPost(function (message) {
    if (!message || typeof message !== "object") return;
    if (message.messageType !== MSG_CONTROL_CAR) return;
    var id = message.carId !== undefined ? message.carId : message.id;
    if (typeof id === "number" && id !== localCarId) localCarId = id;
  });

  net.onWorkerMessage(function (data) {
    if (!data || typeof data !== "object") return;
    if (data.messageType !== MSG_UPDATE_RESULT) return;
    var states = data.carStates;
    if (!states || !states.length) return;

    var mine = null;
    if (localCarId !== null) {
      for (var i = 0; i < states.length; i++) {
        if (states[i] && states[i].id === localCarId) {
          mine = states[i];
          break;
        }
      }
    } else if (states.length === 1) {
      localCarId = states[0].id;
      mine = states[0];
    }
    if (mine) localState = summarize(mine);
  });

  // ------------------------------------------------------------- connection

  function pickTransport(code) {
    if (config.ablyKey && window.PolyTrackTransportAbly) {
      return window.PolyTrackTransportAbly.createAblyTransport(
        code,
        selfId,
        config.ablyKey
      ).then(function (t) {
        t.label = "online";
        return t;
      });
    }
    if (window.PolyTrackTransportLocal && window.PolyTrackTransportLocal.supports()) {
      return Promise.resolve(
        window.PolyTrackTransportLocal.createLocalTransport(code, selfId)
      );
    }
    return Promise.reject(new Error("No multiplayer transport available"));
  }

  function handlePayload(from, payload) {
    if (!payload || typeof payload !== "object") return;
    room.handleMessage(from, payload);
    if (!transport) return;
    if (payload.t === "hello") {
      transport.send({ t: "welcome", name: selfName });
      if (room.snapshot().isHost) transport.send(room.settingsMessage());
      if (localState) transport.send(room.stateMessage(localState));
    }
    if (payload.t === "welcome" || payload.t === "settings") {
      refreshOpenView();
    }
  }

  function connect(code, asHost) {
    leave();
    var normalized = core.normalizeRoomCode(code);
    if (!normalized) {
      status = "error";
      statusDetail = "Codes are " + core.CODE_LENGTH + " letters or digits";
      return false;
    }
    room.join(normalized);
    if (asHost) room.setSettings(hostSettings);
    status = "connecting";
    statusDetail = "";
    openLobby();

    pickTransport(normalized)
      .then(function (t) {
        transport = t;
        t.onMessage(handlePayload);
        t.send(room.hello());
        if (room.snapshot().isHost) t.send(room.settingsMessage());
        lastHelloAt = Date.now();
        status = "joined";
        statusDetail = "";
        startLoop();
        openLobby();
      })
      .catch(function (err) {
        status = "error";
        statusDetail = err && err.message ? err.message : String(err);
        openLobby();
      });
    return true;
  }

  function host() {
    if (!hostSettings.track) {
      status = "error";
      statusDetail = "Select a track first";
      refreshOpenView();
      return false;
    }
    return connect(core.makeRoomCode(), true);
  }

  function join(code) {
    return connect(code, false);
  }

  function leave() {
    stopLoop();
    if (transport) {
      try {
        transport.send(room.bye());
      } catch (err) {
        /* transport already gone */
      }
      try {
        transport.close();
      } catch (err) {
        /* already closed */
      }
      transport = null;
    }
    room.leave();
    status = "idle";
    statusDetail = "";
  }

  function startLoop() {
    stopLoop();
    loop = window.setInterval(function () {
      if (!transport) return;
      room.tick();
      if (localState) {
        room.setLocalState(localState);
        transport.send(room.stateMessage(localState));
      } else if (Date.now() - lastHelloAt > HELLO_INTERVAL_MS) {
        transport.send(room.hello());
        lastHelloAt = Date.now();
      }
    }, STATE_INTERVAL_MS);
  }

  function stopLoop() {
    if (loop !== null) {
      window.clearInterval(loop);
      loop = null;
    }
  }

  // -------------------------------------------------------------------- API

  net.currentNickname = currentNickname;
  net.matchTrackFile = matchTrackFile;
  net.watchGameTrackScreen = watchGameTrackScreen;
  net.remoteCars = function () {
    var snap = room.snapshot();
    var out = [];
    for (var i = 0; i < snap.players.length; i++) {
      var p = snap.players[i];
      if (p.isLocal || !p.state) continue;
      out.push({ id: p.id, name: p.name, state: p.state, age: p.age });
    }
    return out;
  };
  net.host = host;
  net.join = join;
  net.leave = leave;
  net.room = room;
  net.selfId = selfId;

  // --------------------------------------------------------------------- UI

  var uiRoot = null;
  var overlay = null;
  var overlayKind = null; // "join" | "host" | "lobby" | "tracks"
  var raceChip = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconButton(className, label, iconSrc, text) {
    var button = el("button", "mp-button " + className);
    button.type = "button";
    if (iconSrc) {
      var img = el("img");
      img.src = iconSrc;
      img.alt = "";
      button.appendChild(img);
    }
    button.appendChild(document.createTextNode(text !== undefined ? text : label));
    return button;
  }

  function prettyTrackName(file) {
    if (!file) return "";
    return file
      .replace(/^.*\//, "")
      .replace(/\.track$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function mountRoot() {
    if (uiRoot && document.body.contains(uiRoot)) return uiRoot;
    uiRoot = el("div", "mp-root");
    var host = document.getElementById("ui") || document.body;
    host.appendChild(uiRoot);
    return uiRoot;
  }

  function openOverlay(kind, windowNode) {
    closeOverlay();
    mountRoot();
    overlay = el("div", "mp-overlay");
    overlay.appendChild(windowNode);
    uiRoot.appendChild(overlay);
    overlayKind = kind;
  }

  function closeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    overlayKind = null;
  }

  function refreshOpenView() {
    if (overlayKind === "lobby") openLobby();
    else if (overlayKind === "host") openHost();
    else if (overlayKind === "join") openJoin();
    renderRaceChip();
  }

  // --- menu entry -----------------------------------------------------------

  function findTileByIcon(container, needle) {
    var tiles = container.querySelectorAll("button.button-image");
    for (var i = 0; i < tiles.length; i++) {
      var img = tiles[i].querySelector("img");
      if (img && img.getAttribute("src") && img.getAttribute("src").indexOf(needle) !== -1) {
        return tiles[i];
      }
    }
    return null;
  }

  function injectMenuTile() {
    var container = document.querySelector(".menu > .main-buttons-container");
    if (!container) return;
    if (container.querySelector("[data-mp-tile]")) return;

    var playTile = findTileByIcon(container, "play.svg");
    var tile = el("button", "button button-image");
    tile.type = "button";
    tile.setAttribute("data-mp-tile", "1");
    tile.innerHTML = '<img src="images/globe.svg" alt="">';
    tile.appendChild(el("p", null, "Multiplayer"));
    tile.addEventListener("click", function () {
      openJoin();
    });
    if (playTile) container.insertBefore(tile, playTile);
    else container.appendChild(tile);

    // The reference layout labels the car-customisation entry "Garage".
    if (config.renameGarageTile !== false) {
      var customize = findTileByIcon(container, "customize.svg");
      if (customize) {
        var label = customize.querySelector("p");
        if (label) label.textContent = "Garage";
      }
    }

    // Profiles are managed inside the Garage now. The tile is hidden rather
    // than removed so the native profile dialog can still be opened from the
    // Garage's "Switch Profile" button.
    if (config.hideProfileTile !== false) {
      var profileTile = findTileByIcon(container, "helmet.svg");
      if (profileTile) {
        profileTile.setAttribute("data-mp-profile-tile", "1");
        profileTile.style.display = "none";
      }
    }
  }

  // --- garage additions -----------------------------------------------------

  function findProfileTile() {
    return document.querySelector("[data-mp-profile-tile]");
  }

  // The game's profile dialog is created inside #ui while the garage is a
  // sibling screen on top of it, so the garage steps aside until it closes.
  var profileSwitch = { garageHidden: false };

  function hideGarage() {
    var garage = document.querySelector(".customization");
    if (!garage) return;
    garage.style.display = "none";
    profileSwitch.garageHidden = true;
  }

  function restoreGarage() {
    var garage = document.querySelector(".customization");
    if (garage && garage.style.display === "none") garage.style.display = "";
    profileSwitch.garageHidden = false;
  }

  /** Switches the active profile slot the way the game itself does. */
  function switchProfile(slot) {
    try {
      // The game stores this key with JSON.stringify, and reads it at boot.
      window.localStorage.setItem("polytrack_v4_prod_user_slot", JSON.stringify(slot));
    } catch (err) {
      status = "error";
      statusDetail = "Could not save the profile slot";
      refreshOpenView();
      return;
    }
    window.location.reload();
  }

  /**
   * Profile switcher built by us: the game's own screen is unreachable from
   * here (its click handler builds it inside an async callback that never
   * fires), so this reproduces it from the same stored slots.
   */
  function openProfileMenu() {
    var windowNode = el("div", "mp-window");
    windowNode.appendChild(el("p", "mp-title", "Profiles"));

    var body = el("div", "mp-body");
    if (status === "error" && statusDetail) {
      body.appendChild(el("p", "mp-error", statusDetail));
    }

    var section = el("div", "mp-section");
    section.appendChild(el("p", "mp-label", "Choose a profile"));

    var storage = null;
    try {
      storage = window.localStorage;
    } catch (err) {
      storage = null;
    }
    var current = storage ? activeProfileSlot(storage) : 0;
    var filled = 0;

    for (var slot = 0; slot < 3; slot++) {
      var profile = storage ? readProfile(storage, slot) : null;
      if (profile) filled += 1;
      var option = el("button", "mp-button mp-profile-option");
      option.type = "button";
      option.style.display = "block";
      option.style.width = "100%";
      option.style.margin = "0 0 8px 0";
      option.style.textAlign = "left";
      option.textContent =
        (profile ? profile.nickname : "Empty slot") +
        (slot === current ? "   current" : "");
      if (!profile) option.disabled = true;
      if (slot === current) option.classList.add("mp-selected");
      addProfileOptionHandler(option, slot, !!profile, slot === current);
      section.appendChild(option);
    }

    if (!filled) {
      section.appendChild(
        el("p", "mp-note", "No profiles yet - the game creates one on first launch.")
      );
    }
    section.appendChild(el("p", "mp-note", "Switching profiles reloads the game."));
    body.appendChild(section);
    windowNode.appendChild(body);

    var footer = el("div", "mp-footer");
    var back = iconButton("mp-back", "Back", "images/back.svg");
    // The garage is already visible again behind this dialog, so Back just
    // closes us rather than reopening a second garage screen.
    back.addEventListener("click", closeOverlay);
    footer.appendChild(back);
    footer.appendChild(el("span", "mp-spacer"));
    windowNode.appendChild(footer);

    openOverlay("profiles", windowNode);
  }

  function addProfileOptionHandler(option, slot, hasProfile, isCurrent) {
    option.addEventListener("click", function () {
      if (!hasProfile || isCurrent) {
        closeOverlay();
        return;
      }
      switchProfile(slot);
    });
  }

  /**
   * Tries the game's own profile menu first (that is the screen the old Profile
   * tile showed) and falls back to our own switcher if it does not appear.
   */
  function openProfilePicker() {
    var tile = findProfileTile();
    if (!tile) {
      openProfileMenu();
      return;
    }
    hideGarage();
    tile.click();
    window.setTimeout(function () {
      if (document.querySelector(".profile-selection")) {
        syncProfileScreen();
        return;
      }
      restoreGarage();
      openProfileMenu();
    }, 250);
  }

  function syncProfileScreen() {
    var screenNode = document.querySelector(".profile-selection");
    if (screenNode) {
      if (screenNode.classList && !screenNode.classList.contains("mp-profile-screen")) {
        screenNode.classList.add("mp-profile-screen");
      }
      return;
    }
    if (profileSwitch.garageHidden) restoreGarage();
  }

  /** Adds the profile header (name + Switch Profile) to the game's garage. */
  function injectGarage() {
    var garage = document.querySelector(".customization");
    if (!garage) return;

    var top = garage.querySelector(".top");
    if (top && !garage.querySelector("[data-mp-switch-profile]")) {
      var button = el("button", "button mp-garage-switch");
      button.type = "button";
      button.setAttribute("data-mp-switch-profile", "1");
      button.innerHTML = '<img class="button-icon" src="images/switch_profile.svg"> ';
      button.appendChild(document.createTextNode("Switch Profile"));
      button.addEventListener("click", openProfilePicker);
      top.appendChild(button);
    }

    var nameNode = garage.querySelector("[data-mp-profile-name]");
    if (!nameNode) {
      nameNode = el("div", "mp-profile-name");
      nameNode.setAttribute("data-mp-profile-name", "1");
      garage.appendChild(nameNode);
    }

    // Sit directly under the tool bar. Measured rather than hard-coded so the
    // tab lines up at any UI scale; the stylesheet's 68px stays as a fallback
    // for when the bar is not laid out yet.
    if (top && typeof top.getBoundingClientRect === "function") {
      var barHeight = top.getBoundingClientRect().height;
      if (barHeight > 0) nameNode.style.top = Math.round(barHeight) + "px";
    }

    var nickname = currentNickname();
    if (nameNode.textContent !== nickname) nameNode.textContent = nickname;

    syncProfileScreen();
  }

  function watchMenu() {
    injectMenuTile();
    if (typeof MutationObserver !== "function" || !document.body) return;
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        injectMenuTile();
        injectGarage();
        watchGameTrackScreen();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- join dialog ----------------------------------------------------------

  function openJoin() {
    var windowNode = el("div", "mp-window");
    windowNode.appendChild(el("p", "mp-title", "Join Multiplayer Game"));

    var body = el("div", "mp-body");
    if (status === "error" && statusDetail) {
      body.appendChild(el("p", "mp-error", statusDetail));
    }
    var input = el("input", "mp-input");
    input.type = "text";
    input.placeholder = "Enter invite code";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = core.CODE_LENGTH + 3;
    body.appendChild(input);
    windowNode.appendChild(body);

    var footer = el("div", "mp-footer");
    var back = iconButton("mp-back", "Back", "images/back.svg");
    back.addEventListener("click", closeOverlay);
    var hostButton = el("button", "mp-button mp-secondary", "Host");
    hostButton.type = "button";
    hostButton.addEventListener("click", openHost);
    var joinButton = iconButton("mp-join", "Join", null, "Join");
    joinButton.type = "button";
    joinButton.disabled = true;
    var playIcon = el("img");
    playIcon.src = "images/play.svg";
    playIcon.alt = "";
    joinButton.appendChild(playIcon);
    joinButton.addEventListener("click", function () {
      var code = core.normalizeRoomCode(input.value);
      if (code) connect(code, false);
    });

    footer.appendChild(back);
    footer.appendChild(hostButton);
    footer.appendChild(el("span", "mp-spacer"));
    footer.appendChild(joinButton);
    windowNode.appendChild(footer);

    function syncEnabled() {
      joinButton.disabled = core.normalizeRoomCode(input.value) === null;
    }
    input.addEventListener("input", function () {
      var caretEnd = input.value.length;
      input.value = input.value.toUpperCase();
      if (caretEnd) input.setSelectionRange(caretEnd, caretEnd);
      syncEnabled();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !joinButton.disabled) {
        var code = core.normalizeRoomCode(input.value);
        if (code) connect(code, false);
      }
    });

    openOverlay("join", windowNode);
    window.setTimeout(function () {
      input.focus();
    }, 0);
  }

  // --- host dialog ----------------------------------------------------------

  var MODE_COPY = {
    casual: "Players play to improve their personal best times.",
    competitive: "Players race head to head, and the best time wins.",
  };

  function openHost() {
    var windowNode = el("div", "mp-window");
    windowNode.appendChild(el("p", "mp-title", "Host Multiplayer Game"));

    var body = el("div", "mp-body");

    // Game mode
    var modeSection = el("div", "mp-section");
    modeSection.appendChild(el("p", "mp-label", "Game Mode"));
    var segmented = el("div", "mp-segmented");
    var modeButtons = {};
    core.GAME_MODES.forEach(function (mode) {
      var label = mode.charAt(0).toUpperCase() + mode.slice(1);
      var button = el("button", "mp-button", label);
      button.type = "button";
      modeButtons[mode] = button;
      button.addEventListener("click", function () {
        hostSettings = core.normalizeSettings(
          Object.assign({}, hostSettings, { mode: mode })
        );
        syncModeButtons();
      });
      segmented.appendChild(button);
    });
    modeSection.appendChild(segmented);
    var modeNote = el("p", "mp-note", MODE_COPY[hostSettings.mode]);
    modeSection.appendChild(modeNote);
    body.appendChild(modeSection);

    function syncModeButtons() {
      core.GAME_MODES.forEach(function (mode) {
        modeButtons[mode].classList.toggle("mp-selected", hostSettings.mode === mode);
        modeButtons[mode].classList.toggle("mp-secondary", hostSettings.mode !== mode);
      });
      modeNote.textContent = MODE_COPY[hostSettings.mode];
    }
    syncModeButtons();

    // Player count
    var playerSection = el("div", "mp-section");
    var playerLabel = el(
      "p",
      "mp-label",
      "Maximum Players: " + hostSettings.maxPlayers
    );
    playerSection.appendChild(playerLabel);
    var sliderRow = el("div", "mp-slider-row");
    var slider = el("input");
    slider.type = "range";
    slider.min = String(core.MIN_PLAYERS);
    slider.max = String(core.MAX_PLAYERS);
    slider.step = "1";
    slider.value = String(hostSettings.maxPlayers);
    slider.addEventListener("input", function () {
      hostSettings = core.normalizeSettings(
        Object.assign({}, hostSettings, { maxPlayers: slider.value })
      );
      slider.value = String(hostSettings.maxPlayers);
      playerLabel.textContent = "Maximum Players: " + hostSettings.maxPlayers;
    });
    sliderRow.appendChild(slider);
    playerSection.appendChild(sliderRow);
    body.appendChild(playerSection);

    // Track selection
    var trackSection = el("div", "mp-section");
    trackSection.style.padding = "0";
    var trackTile = el("button", "mp-track-tile");
    trackTile.type = "button";
    var thumb = el("span", "mp-thumb");
    var thumbImage = el("img");
    thumbImage.src = "images/car_thumbnail_placeholder.png";
    thumbImage.alt = "";
    thumb.appendChild(thumbImage);
    trackTile.appendChild(thumb);
    var trackName = el(
      "span",
      "mp-track-name",
      hostSettings.track ? prettyTrackName(hostSettings.track) : "Select Track"
    );
    trackTile.appendChild(trackName);
    trackTile.addEventListener("click", function () {
      openGameTrackScreen();
    });
    trackSection.appendChild(trackTile);
    body.appendChild(trackSection);

    windowNode.appendChild(body);

    var footer = el("div", "mp-footer");
    var back = iconButton("mp-back", "Back", "images/back.svg");
    back.addEventListener("click", function () {
      openJoin();
    });
    var startButton = el("button", "mp-button mp-start", "Host");
    startButton.type = "button";
    startButton.disabled = !hostSettings.track;
    if (!hostSettings.track) startButton.classList.add("mp-secondary");
    startButton.addEventListener("click", function () {
      host();
    });
    footer.appendChild(back);
    footer.appendChild(el("span", "mp-spacer"));
    footer.appendChild(startButton);
    windowNode.appendChild(footer);

    openOverlay("host", windowNode);
    syncModeButtons();
    void trackName;
  }

  var trackList = null;

  function loadTracks() {
    if (trackList) return Promise.resolve(trackList);
    return fetch("./multiplayer/tracks.json", { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        trackList = data;
        return trackList;
      });
  }

  // --- track picker (reuses the game's own Play-menu screen) ----------------

  var trackPick = { active: false, bound: null, seen: false };

  function closestWithClass(node, className) {
    var current = node;
    while (current && current.classList) {
      if (current.classList.contains(className)) return current;
      current = current.parentNode;
    }
    return null;
  }

  /** Maps a track's displayed title back to its file name when possible. */
  function matchTrackFile(title) {
    var wanted = String(title === undefined || title === null ? '' : title).trim().toLowerCase();
    if (!wanted || !trackList) return title;
    var all = []
      .concat(trackList.official || [])
      .concat(trackList.community || [])
      .concat(trackList.custom || []);
    for (var i = 0; i < all.length; i++) {
      if (prettyTrackName(all[i]).toLowerCase() === wanted) return all[i];
    }
    for (var j = 0; j < all.length; j++) {
      if (prettyTrackName(all[j]).toLowerCase().indexOf(wanted) !== -1) return all[j];
    }
    // Custom tracks live in the game profile, not on disk: keep the given name.
    return title;
  }

  /**
   * Opens the game's own track screen (the Play menu) so the host dialog gets
   * real track previews, every category, and the search box for free. Selecting
   * a track is intercepted before the game can start the race.
   */
  function openGameTrackScreen() {
    var container = document.querySelector('.menu > .main-buttons-container');
    var play = container ? findTileByIcon(container, 'play.svg') : null;
    if (!play) {
      status = 'error';
      statusDetail = 'Could not open the track screen';
      openHost();
      return;
    }
    closeOverlay();
    trackPick.active = true;
    // The screen is built asynchronously by the game, so the watcher must not
    // treat its absence as a cancel until it has actually been seen.
    trackPick.seen = false;
    play.click();
  }

  function bindGameTrackScreen(screenNode) {
    trackPick.bound = screenNode;
    // Capture phase, so the game's own 'start this track' handler never runs.
    screenNode.addEventListener(
      'click',
      function (event) {
        if (!trackPick.active) return;
        var card = closestWithClass(event.target, 'track');
        if (!card) return;
        var titleNode = card.querySelector('.track-title p');
        if (!titleNode) return;
        event.preventDefault();
        event.stopPropagation();
        hostSettings = core.normalizeSettings(
          Object.assign({}, hostSettings, { track: matchTrackFile(titleNode.textContent) })
        );
        trackPick.active = false;
        trackPick.seen = false;
        closeGameTrackScreen();
        openHost();
      },
      true
    );
  }

  function closeGameTrackScreen() {
    var screenNode = document.querySelector('.track-selection');
    if (!screenNode) return;
    var buttons = screenNode.querySelectorAll('.bar > .button');
    for (var i = 0; i < buttons.length; i++) {
      var image = buttons[i].querySelector('img');
      if (image && String(image.getAttribute('src')).indexOf('back.svg') !== -1) {
        buttons[i].click();
        return;
      }
    }
    if (buttons.length) buttons[0].click();
  }

  /** Keeps our state in step with the game's screen appearing and closing. */
  function watchGameTrackScreen() {
    var screenNode = document.querySelector('.track-selection');
    if (screenNode) {
      trackPick.seen = true;
      if (trackPick.bound !== screenNode) bindGameTrackScreen(screenNode);
      return;
    }
    trackPick.bound = null;
    if (trackPick.active && trackPick.seen) {
      // Closed without a selection (Back), so return to the host dialog.
      trackPick.active = false;
      trackPick.seen = false;
      openHost();
    }
  }

  // --- lobby ----------------------------------------------------------------

  function openLobby() {
    var snap = room.snapshot();
    var windowNode = el("div", "mp-window");
    var title =
      status === "connecting"
        ? "Connecting…"
        : snap.isHost
        ? "Hosting Multiplayer Game"
        : "Multiplayer Lobby";
    windowNode.appendChild(el("p", "mp-title", title));

    var body = el("div", "mp-body");
    if (status === "error" && statusDetail) {
      body.appendChild(el("p", "mp-error", statusDetail));
    }

    var codeSection = el("div", "mp-section");
    codeSection.appendChild(el("p", "mp-label", "Invite Code"));
    codeSection.appendChild(el("p", "mp-code", snap.roomCode || "—"));
    var settingsLine = [];
    settingsLine.push(snap.settings.mode === "competitive" ? "Competitive" : "Casual");
    settingsLine.push(snap.maxPlayers + " players max");
    if (snap.settings.track) settingsLine.push(prettyTrackName(snap.settings.track));
    codeSection.appendChild(el("p", "mp-note", settingsLine.join(" · ")));
    if (transport && transport.label) {
      codeSection.appendChild(el("p", "mp-note", "Connection: " + transport.label));
    } else if (!config.ablyKey) {
      codeSection.appendChild(
        el("p", "mp-note", "Same-browser tabs only until an Ably key is configured.")
      );
    }
    body.appendChild(codeSection);

    var playersSection = el("div", "mp-section");
    playersSection.appendChild(
      el("p", "mp-label", "Players (" + snap.count + "/" + snap.maxPlayers + ")")
    );
    if (snap.count === 0) {
      playersSection.appendChild(el("p", "mp-note", "No players yet."));
    }
    snap.players.forEach(function (player) {
      var row = el("div", "mp-player-row" + (player.isLocal ? " mp-is-self" : ""));
      var name = el("span", "mp-player-name", player.name);
      var meta = el(
        "span",
        "mp-player-meta",
        (player.id === snap.hostId ? "host" : "player") +
          (player.state && typeof player.state.v === "number"
            ? " · " + player.state.v + " km/h"
            : " · idle")
      );
      row.appendChild(name);
      row.appendChild(meta);
      playersSection.appendChild(row);
    });
    body.appendChild(playersSection);
    windowNode.appendChild(body);

    var footer = el("div", "mp-footer");
    var back = iconButton("mp-back", "Back", "images/back.svg");
    back.addEventListener("click", function () {
      leave();
      closeOverlay();
    });
    footer.appendChild(back);
    footer.appendChild(el("span", "mp-spacer"));
    windowNode.appendChild(footer);

    openOverlay("lobby", windowNode);
    renderRaceChip();
  }

  // --- in-race chip ---------------------------------------------------------

  function renderRaceChip() {
    var snap = room.snapshot();
    var active = status === "joined" && snap.roomCode;
    if (!raceChip || !document.body.contains(raceChip)) {
      if (!active) return;
      raceChip = el("div", "mp-race-status");
      (document.getElementById("ui") || document.body).appendChild(raceChip);
    }
    if (!active) {
      raceChip.style.display = "none";
      return;
    }
    raceChip.style.display = "block";
    var lines = [snap.roomCode + " · " + snap.count + "/" + snap.maxPlayers];
    snap.players.forEach(function (player) {
      if (player.isLocal) return;
      var speed =
        player.state && typeof player.state.v === "number"
          ? player.state.v + " km/h"
          : "idle";
      lines.push(player.name + " · " + speed);
    });
    raceChip.textContent = lines.join("\n");
    raceChip.style.whiteSpace = "pre-line";
  }

  function boot() {
    watchMenu();
    // Peer speeds arrive ~12 Hz; refresh the chip a few times a second so it
    // stays live without rebuilding the lobby under the user's cursor.
    // Track titles are matched back to file names from this list.
    loadTracks().catch(function () {});
    window.setInterval(function () {
      renderRaceChip();
      // The garage is created/destroyed as the player navigates, and the
      // nickname changes when a profile is switched.
      injectGarage();
      watchGameTrackScreen();
    }, 500);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && overlay) closeOverlay();
    });
    window.addEventListener("beforeunload", function () {
      if (transport) transport.send(room.bye());
    });
    renderRaceChip();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
