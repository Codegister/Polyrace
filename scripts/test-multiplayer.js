#!/usr/bin/env node
/* eslint-disable no-console */
// Tests for the multiplayer room core and the same-browser transport.

const path = require("path");

const core = require(path.join(__dirname, "..", "multiplayer", "room-core.js"));
const localTransport = require(
  path.join(__dirname, "..", "multiplayer", "transport-local.js")
);

const tests = [];

function addTest(name, fn) {
  tests.push({ name, fn });
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function seeded(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

addTest("Room codes are short, readable and unambiguous", () => {
  // 0 and 1 are excluded so spoken/typed codes cannot be misread as O and I.
  ensure(core.CODE_LENGTH === 5, "codes should be 5 characters");
  ensure(core.ALPHABET.indexOf("0") === -1, "alphabet must not contain 0");
  ensure(core.ALPHABET.indexOf("1") === -1, "alphabet must not contain 1");
  for (let i = 0; i < 200; i++) {
    const code = core.makeRoomCode();
    ensure(code.length === 5, `unexpected code length: ${code}`);
    for (const ch of code) {
      ensure(core.ALPHABET.indexOf(ch) !== -1, `unexpected character ${ch} in ${code}`);
    }
  }
});

addTest("makeRoomCode uses the injected random source", () => {
  const code = core.makeRoomCode(seeded([0, 0.5, 0.99, 0.25, 0.75]));
  const expected = ["A", "R", "9", "H", "V"].map((ch) => ch).join("");
  // Recomputed from the alphabet rather than hardcoded ordering assumptions.
  const alpha = core.ALPHABET;
  const want =
    alpha[0] +
    alpha[Math.floor(0.5 * alpha.length)] +
    alpha[alpha.length - 1] +
    alpha[Math.floor(0.25 * alpha.length)] +
    alpha[Math.floor(0.75 * alpha.length)];
  ensure(code === want, `expected ${want}, got ${code} (${expected})`);
});

addTest("normalizeRoomCode accepts what people actually type", () => {
  ensure(core.normalizeRoomCode("abcde") === "ABCDE", "lowercase should uppercase");
  ensure(core.normalizeRoomCode(" ab-cde ") === "ABCDE", "should strip separators");
  ensure(core.normalizeRoomCode(" ab-cd ") === null, "stripping must not shorten a code silently");
  ensure(core.normalizeRoomCode("AB0D1") === "ABODI", "0->O and 1->I folding");
  ensure(core.normalizeRoomCode("AB CDE") === "ABCDE", "internal spaces stripped");
  ensure(core.normalizeRoomCode("ABCD") === null, "too short must be rejected");
  ensure(core.normalizeRoomCode("ABCDEF") === null, "too long must be rejected");
  ensure(core.normalizeRoomCode("") === null, "empty must be rejected");
  ensure(core.normalizeRoomCode(null) === null, "non-string must be rejected");
  ensure(core.normalizeRoomCode("AB#CDE") === "ABCDE", "symbols stripped from a full code");
  ensure(core.normalizeRoomCode("AB#DE") === null, "symbols must not mask a short code");
  ensure(core.normalizeRoomCode("AB#DE") !== "ABCDE", "symbols do not invent characters");
});

addTest("Host is the lowest id, so every client agrees", () => {
  const room = core.createRoom({ selfId: "m-me", name: "Me", now: () => 0 });
  room.join("ABCDE");
  ensure(room.snapshot().isHost, "sole player hosts");
  room.handleMessage("a-peer", { t: "hello", name: "Peer" });
  const snap = room.snapshot();
  ensure(snap.count === 2, `expected 2 players, got ${snap.count}`);
  ensure(snap.hostId === "a-peer", "lower id wins the host role");
  ensure(!snap.isHost, "we are not host when a lower id joined");
  room.handleMessage("a-peer", { t: "bye" });
  ensure(room.snapshot().isHost, "host returns after the peer leaves");
});

addTest("Peer presence, state and timeouts", () => {
  let clock = 1000;
  const room = core.createRoom({
    selfId: "p1",
    name: "One",
    now: () => clock,
  });
  room.join("ROOM1");
  room.handleMessage("p2", { t: "hello", name: "Two" });
  room.handleMessage("p2", { t: "state", s: { v: 88 } });
  let peer = room.snapshot().players.find((p) => p.id === "p2");
  ensure(peer && peer.name === "Two", "peer should be tracked");
  ensure(peer.state && peer.state.v === 88, "peer state should be stored");

  clock += core.PEER_TIMEOUT_MS - 1;
  room.handleMessage("p2", { t: "state", s: { v: 90 } });
  ensure(room.snapshot().count === 2, "fresh heartbeat keeps the peer");
  clock += core.PEER_TIMEOUT_MS + 1;
  ensure(room.tick() === true, "stale peer should be dropped");
  ensure(room.snapshot().count === 1, "only the local player remains");
});

addTest("Room capacity is enforced", () => {
  const room = core.createRoom({ selfId: "p0", name: "Zero", maxPlayers: 3, now: () => 0 });
  room.join("CAP01");
  room.handleMessage("p1", { t: "hello", name: "One" });
  room.handleMessage("p2", { t: "hello", name: "Two" });
  ensure(room.snapshot().count === 3, "room should fill to capacity");
  ensure(room.snapshot().full, "room should report full");
  room.handleMessage("p3", { t: "hello", name: "Three" });
  ensure(room.snapshot().count === 3, "extra peer must be rejected, not evict anyone");
});

addTest("Leaving clears the roster but state updates do not resurrect peers", () => {
  const room = core.createRoom({ selfId: "p1", name: "One", now: () => 0 });
  room.join("LEAVE");
  room.handleMessage("p2", { t: "hello", name: "Two" });
  room.leave();
  ensure(room.snapshot().count === 0, "leaving empties the roster");
  ensure(room.snapshot().roomCode === null, "leaving clears the room code");
  room.handleMessage("p2", { t: "bye" });
  ensure(room.snapshot().count === 0, "no ghost players after leaving");
});

addTest("Worker tap sees both message directions without breaking the worker", () => {
  const fs = require("fs");
  const vm = require("vm");

  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.listeners = [];
      this.posted = [];
    }
    addEventListener(type, handler) {
      if (type === "message") this.listeners.push(handler);
    }
    postMessage(message, transfer) {
      this.posted.push({ message, transfer });
    }
    emit(data) {
      for (const handler of this.listeners) handler({ data });
    }
  }

  const sandbox = {
    Worker: FakeWorker,
    console,
    Object,
    String,
    Math,
    Date,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "multiplayer", "shim.js"), "utf8"),
    sandbox
  );

  ensure(typeof sandbox.window.PolyTrackNet === "object", "tap API should be exposed");
  ensure(
    sandbox.window.Worker !== FakeWorker,
    "Worker constructor should be wrapped"
  );

  const worker = new sandbox.window.Worker("simulation_worker.bundle.js");
  ensure(worker instanceof FakeWorker, "wrapped Worker must still be a real Worker");

  const seen = [];
  const posted = [];
  sandbox.window.PolyTrackNet.onWorkerMessage((data) => seen.push(data));
  sandbox.window.PolyTrackNet.onWorkerPost((msg) => posted.push(msg));

  worker.emit({ messageType: 10, carStates: [{ id: 3, frames: 7 }] });
  ensure(seen.length === 1, "worker -> page messages should be tapped");
  ensure(seen[0].carStates[0].id === 3, "tapped payload should be intact");

  worker.postMessage({ messageType: 6, carId: 3 });
  ensure(posted.length === 1, "page -> worker messages should be tapped");
  ensure(posted[0].messageType === 6, "outgoing payload should be intact");
  ensure(worker.posted.length === 1, "the real postMessage must still receive the message");

  // A throwing observer must not stop the game from talking to its worker.
  sandbox.window.PolyTrackNet.onWorkerPost(() => {
    throw new Error("observer blew up");
  });
  worker.postMessage({ messageType: 5, carId: 3 });
  ensure(worker.posted.length === 2, "a failing tap must not block the game");
});

addTest("Host settings are clamped and sanitised", () => {
  ensure(core.MIN_PLAYERS === 2, "minimum players should be 2");
  ensure(core.MAX_PLAYERS === 16, "maximum players should be 16");
  ensure(core.clampMaxPlayers(0) === 2, "below minimum clamps up");
  ensure(core.clampMaxPlayers(99) === 16, "above maximum clamps down");
  ensure(core.clampMaxPlayers("7") === 7, "numeric strings are accepted");
  ensure(core.clampMaxPlayers("nope") === 8, "junk falls back to the default");
  ensure(core.clampMaxPlayers(7.6) === 8, "values round to whole players");

  const defaults = core.normalizeSettings();
  ensure(defaults.mode === "casual", "default mode is casual");
  ensure(defaults.maxPlayers === 8, "default cap is 8");
  ensure(defaults.track === null, "no default track");

  const junk = core.normalizeSettings({
    mode: "<script>",
    maxPlayers: 999,
    track: 42,
  });
  ensure(junk.mode === "casual", "unknown modes fall back to casual");
  ensure(junk.maxPlayers === 16, "player cap is clamped");
  ensure(junk.track === null, "non-string tracks are rejected");

  const valid = core.normalizeSettings({
    mode: "competitive",
    maxPlayers: 4,
    track: "tracks/official/desert.track",
  });
  ensure(valid.mode === "competitive", "competitive is accepted");
  ensure(valid.maxPlayers === 4, "in-range cap is preserved");
  ensure(valid.track === "tracks/official/desert.track", "track path is preserved");
});

addTest("Only the host can change room settings", () => {
  const room = core.createRoom({ selfId: "a-host", name: "Host" });
  room.join("SET01");
  room.handleMessage("m-guest", { t: "hello", name: "Guest" });
  ensure(room.snapshot().isHost, "we host a two-player room with a lower id");

  // The host's settings win.
  room.handleMessage("m-guest", { t: "settings", s: { mode: "competitive" } });
  ensure(
    room.snapshot().settings.mode === "casual",
    "settings from a non-host peer must be ignored"
  );

  const applied = room.setSettings({ mode: "competitive", maxPlayers: 12, track: "x.track" });
  ensure(applied.mode === "competitive", "host can set the mode");
  ensure(room.snapshot().settings.maxPlayers === 12, "host cap is reflected in the snapshot");

  // Capacity follows the host's chosen cap, not the global maximum.
  for (let i = 0; i < 20; i++) {
    room.handleMessage(`z${i}`, { t: "hello", name: `P${i}` });
  }
  ensure(room.snapshot().count === 12, `guest cap should stop at 12, got ${room.snapshot().count}`);
  ensure(room.snapshot().full, "room reports full at the chosen cap");
});

// --------------------------------------------------------------------------
// Minimal DOM harness: enough to run the real multiplayer.bundle.js against a
// stand-in for the game's menu, so the injection logic is covered without a
// browser.
// --------------------------------------------------------------------------

function createDom() {
  function matches(node, selector) {
    const attr = selector.match(/^\[([\w-]+)\]$/);
    if (attr) return Object.prototype.hasOwnProperty.call(node.attrs, attr[1]);
    const cls = selector.match(/^([a-z]*)\.?([\w-]+)?$/);
    if (cls) {
      const tag = cls[1];
      const className = cls[2];
      if (tag && node.tagName.toLowerCase() !== tag) return false;
      if (className && node.className.split(/\s+/).indexOf(className) === -1) return false;
      return true;
    }
    if (selector[0] === ".") {
      return node.className.split(/\s+/).indexOf(selector.slice(1)) !== -1;
    }
    return node.tagName.toLowerCase() === selector.toLowerCase();
  }

  function descendants(node, out) {
    for (const child of node.children) {
      if (child.nodeType !== 1) continue;
      out.push(child);
      descendants(child, out);
    }
    return out;
  }

  function ancestorsMatch(node, selectors) {
    let current = node.parentNode;
    for (let i = selectors.length - 1; i >= 0; i--) {
      while (current && !matches(current, selectors[i])) current = current.parentNode;
      if (!current) return false;
      current = current.parentNode;
    }
    return true;
  }

  function querySelectorAll(root, selector) {
    if (selector.indexOf(" > ") !== -1) {
      const parts = selector.split(" > ");
      const parentSel = parts[0];
      const childSel = parts[1];
      const hits = [];
      for (const candidate of descendants(root, [])) {
        if (!matches(candidate, childSel)) continue;
        if (candidate.parentNode && matches(candidate.parentNode, parentSel)) hits.push(candidate);
      }
      return hits;
    }
    // Descendant selectors such as ".track-title p".
    const chain = selector.split(/\s+/).filter(Boolean);
    if (chain.length > 1) {
      return descendants(root, []).filter(
        (node) => matches(node, chain[chain.length - 1]) && ancestorsMatch(node, chain.slice(0, -1))
      );
    }
    return descendants(root, []).filter((node) => matches(node, selector));
  }

  function createText(text) {
    return { nodeType: 3, text: String(text) };
  }

  function createElement(tag) {
    const node = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      children: [],
      parentNode: null,
      attrs: {},
      style: {},
      dataset: {},
      listeners: {},
      disabled: false,
      className: "",
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, reference) {
        const index = this.children.indexOf(reference);
        child.parentNode = this;
        if (index === -1) this.children.push(child);
        else this.children.splice(index, 0, child);
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
      },
      querySelector(selector) {
        const hits = querySelectorAll(this, selector);
        return hits.length ? hits[0] : null;
      },
      querySelectorAll(selector) {
        return querySelectorAll(this, selector);
      },
      setSelectionRange() {},
      focus() {},
      click() {
        const handlers = this.listeners.click || [];
        for (const handler of handlers) {
          handler({ type: "click", preventDefault() {} });
        }
      },
      contains(target) {
        let current = target;
        while (current) {
          if (current === this) return true;
          current = current.parentNode;
        }
        return false;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
    };
    node.classList = {
      add(name) {
        if (node.className.split(/\s+/).indexOf(name) === -1) {
          node.className = (node.className + " " + name).trim();
        }
      },
      remove(name) {
        node.className = node.className
          .split(/\s+/)
          .filter((c) => c && c !== name)
          .join(" ");
      },
      contains(name) {
        return node.className.split(/\s+/).indexOf(name) !== -1;
      },
      toggle(name, force) {
        const on = force === undefined ? !this.contains(name) : !!force;
        if (on) this.add(name);
        else this.remove(name);
      },
    };
    Object.defineProperty(node, "textContent", {
      get() {
        let out = "";
        for (const child of this.children) {
          out += child.nodeType === 3 ? child.text : child.textContent;
        }
        return out;
      },
      set(value) {
        this.children = [];
        if (value !== undefined && value !== null && value !== "") {
          this.children.push(createText(value));
        }
      },
    });
    Object.defineProperty(node, "innerHTML", {
      get() {
        return "";
      },
      set(value) {
        this.children = [];
        const img = /<img[^>]*src="([^"]+)"/i.exec(String(value));
        if (img) {
          const image = createElement("img");
          image.setAttribute("src", img[1]);
          this.appendChild(image);
        }
      },
    });
    return node;
  }

  const body = createElement("body");
  const ui = createElement("div");
  ui.setAttribute("id", "ui");
  body.appendChild(ui);

  const observers = [];

  const document = {
    readyState: "complete",
    body,
    head: createElement("head"),
    createElement,
    createTextNode: createText,
    getElementById(id) {
      const hits = descendants(body, []).filter(
        (node) => node.getAttribute("id") === id
      );
      return hits.length ? hits[0] : null;
    },
    querySelector(selector) {
      const hits = querySelectorAll(body, selector);
      return hits.length ? hits[0] : null;
    },
    querySelectorAll(selector) {
      return querySelectorAll(body, selector);
    },
    addEventListener() {},
  };

  function MutationObserver(callback) {
    observers.push(callback);
  }
  MutationObserver.prototype.observe = function () {};

  return {
    document,
    body,
    createElement,
    flushObservers() {
      for (const callback of observers.slice()) callback([]);
    },
  };
}

function createGameMenu(dom) {
  const menu = dom.createElement("div");
  menu.className = "menu";
  const container = dom.createElement("div");
  container.className = "main-buttons-container hidden";
  menu.appendChild(container);

  const icons = ["customize", "editor", "settings", "helmet", "play"];
  const labels = ["Customize", "Editor", "Settings", "Profile", "Play"];
  icons.forEach((icon, index) => {
    const tile = dom.createElement("button");
    tile.className = "button button-image";
    tile.innerHTML = '<img src="images/' + icon + '.svg">';
    const label = dom.createElement("p");
    label.textContent = labels[index];
    tile.appendChild(label);
    container.appendChild(tile);
  });

  dom.body.appendChild(menu);
  return { menu, container };
}

function bootMultiplayerUi(options) {
  const settings = options || {};
  const fs = require("fs");
  const vm = require("vm");
  const dom = createDom();

  const vault = Object.assign({}, settings.storage || {});
  const windowStub = {
    document: dom.document,
    localStorage: {
      getItem: (k) => (k in vault ? vault[k] : null),
      setItem: (k, v) => {
        vault[k] = String(v);
      },
    },
    // Run deferred callbacks immediately so fallback paths are exercised.
    setTimeout: (fn) => {
      if (typeof fn === "function") fn();
      return 0;
    },
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => fn(),
    addEventListener: () => {},
    console,
    __reloads: 0,
    location: {
      reload: () => {
        windowStub.__reloads += 1;
      },
    },
    MutationObserver: undefined,
    fetch: settings.fetch || (() => Promise.reject(new Error("no network in tests"))),
    POLYTRACK_MP_CONFIG: { ablyKey: "", maxPlayers: 16 },
    PolyTrackRoomCore: core,
    PolyTrackNet: {
      onWorkerPost: () => {},
      onWorkerMessage: () => {},
      remoteCars: () => [],
    },
  };
  windowStub.window = windowStub;
  windowStub.MutationObserver = function (callback) {
    windowStub.__observer = callback;
  };
  windowStub.MutationObserver.prototype.observe = function () {};
  windowStub.PolyTrackTransportLocal = localTransport;

  const sandbox = Object.assign({}, windowStub, {
    document: dom.document,
    MutationObserver: windowStub.MutationObserver,
    localStorage: windowStub.localStorage,
    console,
    Object,
    Math,
    Date,
    String,
    isFinite,
    Promise,
    setTimeout: windowStub.setTimeout,
    setInterval: windowStub.setInterval,
  });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "..", "multiplayer", "multiplayer.bundle.js"),
      "utf8"
    ),
    sandbox
  );

  // The game creates its menu after our script boots; simulate that.
  const { container } = createGameMenu(dom);
  windowStub.__observer([]);
  return { dom, container, windowStub };
}

function findTile(container, label) {
  return container
    .querySelectorAll("button.button-image")
    .find((tile) => tile.querySelector("p").textContent === label);
}

addTest("Join and Host dialogs render the expected controls", () => {
  const { container, windowStub } = bootMultiplayerUi();
  const ui = windowStub.document.getElementById("ui");

  findTile(container, "Multiplayer").listeners.click[0]();
  let overlay = ui.querySelector(".mp-overlay");
  ensure(overlay !== null, "the Multiplayer tile should open a dialog in #ui");
  ensure(
    overlay.querySelector(".mp-title").textContent === "Join Multiplayer Game",
    "join dialog title"
  );
  const input = overlay.querySelector(".mp-input");
  ensure(input !== null, "join dialog needs a code field");
  ensure(input.placeholder === "Enter invite code", `placeholder: ${input.placeholder}`);

  const buttons = overlay.querySelectorAll(".mp-button");
  const joinButton = overlay.querySelector(".mp-join");
  ensure(joinButton !== null && joinButton.disabled === true, "Join starts disabled");
  const backButton = overlay.querySelector(".mp-back");
  ensure(backButton !== null && backButton.textContent === "Back", "Back button present");
  ensure(
    buttons.some((b) => b.textContent === "Host"),
    "join dialog should offer Host"
  );

  input.value = "abcde";
  input.listeners.input[0]();
  ensure(input.value === "ABCDE", `input should upper-case, got ${input.value}`);
  ensure(joinButton.disabled === false, "Join enables once the code is complete");

  input.value = "ab";
  input.listeners.input[0]();
  ensure(joinButton.disabled === true, "Join disables again for a short code");

  // Host button swaps the dialog.
  buttons.find((b) => b.textContent === "Host").listeners.click[0]();
  overlay = ui.querySelector(".mp-overlay");
  ensure(
    overlay.querySelector(".mp-title").textContent === "Host Multiplayer Game",
    "host dialog title"
  );

  const modeButtons = overlay.querySelector(".mp-segmented").querySelectorAll(".mp-button");
  ensure(modeButtons.length === 2, `expected Casual/Competitive, got ${modeButtons.length}`);
  ensure(
    modeButtons[0].textContent === "Casual" && modeButtons[1].textContent === "Competitive",
    "mode labels"
  );
  ensure(
    modeButtons[0].classList.contains("mp-selected"),
    "Casual is selected by default"
  );

  const labels = overlay
    .querySelectorAll(".mp-label")
    .map((node) => node.textContent);
  ensure(labels.indexOf("Game Mode") !== -1, `labels: ${labels.join("|")}`);
  ensure(
    labels.indexOf("Maximum Players: 8") !== -1,
    `player cap label missing: ${labels.join("|")}`
  );
  const slider = overlay.querySelector(".mp-slider-row").querySelector("input");
  ensure(slider !== null, "slider missing");
  ensure(slider.min === "2" && slider.max === "16", "slider range should be 2-16");
  ensure(slider.value === "8", `slider default should be 8, got ${slider.value}`);

  const trackTile = overlay.querySelector(".mp-track-tile");
  ensure(trackTile !== null, "track tile missing");
  ensure(
    trackTile.querySelector(".mp-track-name").textContent === "Select Track",
    "track tile should start unselected"
  );
  const startButton = overlay.querySelector(".mp-start");
  ensure(startButton.disabled === true, "Host is disabled until a track is chosen");
});

addTest("Garage header shows the profile and switches it", () => {
  const { dom, container, windowStub } = bootMultiplayerUi({
    storage: {
      // The game stores the active slot as JSON.stringify(number).
      polytrack_v4_prod_user_slot: "1",
      polytrack_v4_prod_user_0: JSON.stringify({ nickname: "Ryzeal", token: "a" }),
      polytrack_v4_prod_user_1: JSON.stringify({ nickname: "Speedy", token: "abc" }),
    },
  });

  // Profile tile is hidden on the home screen but kept clickable.
  const profileTile = container.querySelector("[data-mp-profile-tile]");
  ensure(profileTile !== null, "profile tile should be marked for the garage");
  ensure(profileTile.style.display === "none", "profile tile should be hidden");
  let profileOpened = 0;
  profileTile.addEventListener("click", () => {
    profileOpened += 1;
  });

  // The game creates the garage screen when the player opens it.
  const garage = dom.createElement("div");
  garage.className = "customization";
  const top = dom.createElement("div");
  top.className = "top";
  garage.appendChild(top);
  windowStub.document.getElementById("ui").appendChild(garage);
  windowStub.__observer([]);

  ensure(windowStub.PolyTrackNet.currentNickname() === "Speedy", "nickname should come from the active profile slot");

  const switchButton = garage.querySelector("[data-mp-switch-profile]");
  ensure(switchButton !== null, "Switch Profile button missing");
  ensure(
    switchButton.textContent.indexOf("Switch Profile") !== -1,
    `switch label: ${switchButton.textContent}`
  );
  ensure(
    switchButton.querySelector("img").getAttribute("src") === "images/switch_profile.svg",
    "switch button icon"
  );

  const nameNode = garage.querySelector("[data-mp-profile-name]");
  ensure(nameNode !== null, "profile name label missing");
  ensure(nameNode.textContent === "Speedy", `name label: ${nameNode.textContent}`);

  switchButton.listeners.click[0]();
  ensure(profileOpened === 1, "Switch Profile should ask the game to open its profile menu");

  // The game's screen never appears here, so our own switcher opens instead.
  const ui = windowStub.document.getElementById("ui");
  const dialog = ui.querySelector(".mp-overlay");
  ensure(dialog !== null, "Switch Profile must always show something");
  ensure(
    dialog.querySelector(".mp-title").textContent === "Profiles",
    `profile dialog title: ${dialog.querySelector(".mp-title").textContent}`
  );
  ensure(
    garage.style.display === "",
    "the garage should be visible again once we take over"
  );

  const options = dialog.querySelectorAll(".mp-profile-option");
  ensure(options.length === 3, `expected 3 profile slots, got ${options.length}`);
  ensure(options[0].textContent.indexOf("Ryzeal") !== -1, `slot 0: ${options[0].textContent}`);
  ensure(options[1].textContent.indexOf("Speedy") !== -1, `slot 1: ${options[1].textContent}`);
  ensure(options[1].textContent.indexOf("current") !== -1, "active slot should be marked");
  ensure(options[1].classList.contains("mp-selected"), "active slot should be highlighted");
  ensure(options[2].disabled === true, "empty slots should be disabled");
  ensure(options[2].textContent.indexOf("Empty slot") !== -1, `slot 2: ${options[2].textContent}`);

  // Choosing another profile writes the slot the way the game does and reloads.
  ensure(windowStub.__reloads === 0, "no reload before choosing");
  options[0].listeners.click[0]();
  ensure(
    windowStub.localStorage.getItem("polytrack_v4_prod_user_slot") === "0",
    `slot key should be written as JSON, got ${windowStub.localStorage.getItem(
      "polytrack_v4_prod_user_slot"
    )}`
  );
  ensure(windowStub.__reloads === 1, "switching should reload so the game picks it up");
});

addTest("Switch Profile prefers the game's own screen when it opens", () => {
  const { container, windowStub } = bootMultiplayerUi({
    storage: {
      polytrack_v4_prod_user_slot: "0",
      polytrack_v4_prod_user_0: JSON.stringify({ nickname: "Ryzeal", token: "a" }),
    },
  });
  const ui = windowStub.document.getElementById("ui");

  // The game already raised its profile screen.
  const profileScreen = windowStub.document.createElement("div");
  profileScreen.className = "profile-selection";
  ui.appendChild(profileScreen);

  const garage = windowStub.document.createElement("div");
  garage.className = "customization";
  const top = windowStub.document.createElement("div");
  top.className = "top";
  garage.appendChild(top);
  ui.appendChild(garage);
  windowStub.__observer([]);

  garage.querySelector("[data-mp-switch-profile]").listeners.click[0]();

  ensure(
    profileScreen.classList.contains("mp-profile-screen"),
    "the game's screen should be raised above the garage"
  );
  ensure(
    ui.querySelector(".mp-overlay") === null,
    "our own dialog must not open when the game's screen is up"
  );
  ensure(garage.style.display === "none", "the garage should step aside");

  // Closing it brings the garage back.
  profileScreen.remove();
  windowStub.__observer([]);
  ensure(garage.style.display === "", "the garage should come back after closing profiles");
});

addTest("Nickname falls back to Anonymous when no profile is stored", () => {
  const { windowStub } = bootMultiplayerUi();
  ensure(
    windowStub.PolyTrackNet.currentNickname() === "Anonymous",
    "missing profile should fall back to Anonymous"
  );
});

addTest("Nickname resolves the active slot however it is written", () => {
  const speedy = JSON.stringify({ nickname: "Speedy", token: "abc" });
  const ryzeal = JSON.stringify({ nickname: "Ryzeal", token: "a" });

  // slotKey: undefined means the key is absent, which the game reads as slot 0.
  const cases = [
    { label: "plain number", slotKey: "1", slots: { 0: ryzeal, 1: speedy }, want: "Speedy" },
    { label: "quoted string", slotKey: '"1"', slots: { 0: ryzeal, 1: speedy }, want: "Speedy" },
    { label: "absent key defaults to slot 0", slotKey: undefined, slots: { 0: ryzeal, 1: speedy }, want: "Ryzeal" },
    { label: "absent key, only slot 1 filled", slotKey: undefined, slots: { 1: speedy }, want: "Speedy" },
    { label: "slot points at an empty profile", slotKey: "2", slots: { 1: speedy }, want: "Speedy" },
    { label: "corrupt slot value", slotKey: "not-a-number", slots: { 1: speedy }, want: "Speedy" },
  ];

  for (const testCase of cases) {
    const storage = {};
    Object.keys(testCase.slots).forEach((slot) => {
      storage["polytrack_v4_prod_user_" + slot] = testCase.slots[slot];
    });
    if (testCase.slotKey !== undefined) {
      storage.polytrack_v4_prod_user_slot = testCase.slotKey;
    }

    const { windowStub } = bootMultiplayerUi({ storage });
    const name = windowStub.PolyTrackNet.currentNickname();
    ensure(name === testCase.want, `${testCase.label}: expected ${testCase.want}, got ${name}`);
  }
});

function buildGameTrackScreen(windowStub, titles) {
  const screen = windowStub.document.createElement("div");
  screen.className = "track-selection";

  const bar = windowStub.document.createElement("div");
  bar.className = "bar";
  const back = windowStub.document.createElement("button");
  back.className = "button";
  back.innerHTML = '<img src="images/back.svg">';
  bar.appendChild(back);
  screen.appendChild(bar);

  const container = windowStub.document.createElement("div");
  container.className = "tracks-container open";
  const cards = {};
  titles.forEach((title) => {
    const wrap = windowStub.document.createElement("div");
    wrap.className = "track";
    const button = windowStub.document.createElement("button");
    const titleBox = windowStub.document.createElement("div");
    titleBox.className = "track-title";
    const text = windowStub.document.createElement("p");
    text.textContent = title;
    titleBox.appendChild(text);
    button.appendChild(titleBox);
    wrap.appendChild(button);
    container.appendChild(wrap);
    cards[title] = wrap;
  });
  screen.appendChild(container);

  let backClicks = 0;
  back.addEventListener("click", () => {
    backClicks += 1;
  });
  return { screen, cards, backClicks: () => backClicks };
}

addTest("Host track picker drives the game's own track screen", async () => {
  const trackData = JSON.parse(
    require("fs").readFileSync(
      path.join(__dirname, "..", "multiplayer", "tracks.json"),
      "utf8"
    )
  );
  const { container, windowStub } = bootMultiplayerUi({
    fetch: () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(trackData) }),
  });
  const ui = windowStub.document.getElementById("ui");
  await new Promise((resolve) => setTimeout(resolve, 0));

  // File-name mapping comes from the generated track list.
  ensure(
    windowStub.PolyTrackNet.matchTrackFile("Japan") === "japan.track",
    `mapping failed: ${windowStub.PolyTrackNet.matchTrackFile("Japan")}`
  );
  ensure(
    windowStub.PolyTrackNet.matchTrackFile("My Custom Map") === "My Custom Map",
    "custom tracks should keep their displayed name"
  );

  findTile(container, "Multiplayer").listeners.click[0]();
  ui.querySelector(".mp-overlay")
    .querySelectorAll(".mp-button")
    .find((b) => b.textContent === "Host")
    .listeners.click[0]();

  // The real Play tile has the game's own handler; count activations here.
  let playClicks = 0;
  const playTile = findTile(container, "Play");
  playTile.listeners.click = [
    () => {
      playClicks += 1;
    },
  ];

  ui.querySelector(".mp-track-tile").listeners.click[0]();
  ensure(playClicks === 1, "Select Track should open the game's Play screen");
  ensure(ui.querySelector(".mp-overlay") === null, "our dialog should close first");

  // The game then builds its screen; simulate that and let the observer bind.
  const game = buildGameTrackScreen(windowStub, ["Japan", "Snow Park"]);
  ui.appendChild(game.screen);
  windowStub.__observer([]);

  let gameStarted = 0;
  const japanButton = game.cards.Japan.querySelector("button");
  japanButton.addEventListener("click", () => {
    gameStarted += 1;
  });

  // A card click is intercepted: the game must not start the race.
  game.screen.listeners.click[0]({
    target: japanButton,
    preventDefault() {},
    stopPropagation() {},
  });
  ensure(gameStarted === 0, "the game's track-start handler must not run");
  ensure(game.backClicks() === 1, "the game's screen should be closed via its Back button");

  const hostWindow = ui.querySelector(".mp-overlay").querySelector(".mp-window");
  ensure(
    hostWindow.querySelector(".mp-title").textContent === "Host Multiplayer Game",
    "selecting a track should return to the host dialog"
  );
  ensure(
    hostWindow.querySelector(".mp-track-name").textContent === "Japan",
    `track name: ${hostWindow.querySelector(".mp-track-name").textContent}`
  );
  ensure(
    hostWindow.querySelector(".mp-start").disabled === false,
    "Host should enable once a track is chosen"
  );
});

addTest("Backing out of the game's track screen reopens Host", () => {
  const { container, windowStub } = bootMultiplayerUi();
  const ui = windowStub.document.getElementById("ui");

  findTile(container, "Multiplayer").listeners.click[0]();
  ui.querySelector(".mp-overlay")
    .querySelectorAll(".mp-button")
    .find((b) => b.textContent === "Host")
    .listeners.click[0]();
  ui.querySelector(".mp-track-tile").listeners.click[0]();

  const game = buildGameTrackScreen(windowStub, ["Japan"]);
  ui.appendChild(game.screen);
  windowStub.__observer([]);

  // Player presses Back: the screen disappears with no selection.
  game.screen.remove();
  windowStub.__observer([]);

  const hostWindow = ui.querySelector(".mp-overlay").querySelector(".mp-window");
  ensure(
    hostWindow.querySelector(".mp-title").textContent === "Host Multiplayer Game",
    "backing out should return to the host dialog"
  );
  ensure(
    hostWindow.querySelector(".mp-start").disabled === true,
    "no track should be selected after backing out"
  );
});

addTest("Only the host can start a race, and only with a track", () => {
  const room = core.createRoom({
    selfId: "p1",
    name: "Host",
    settings: { track: "japan.track" },
  });
  room.join("ABCDE");
  ensure(room.snapshot().isHost === true, "p1 is alone, so it hosts");
  ensure(room.snapshot().phase === "lobby", "rooms start in the lobby phase");

  // A guest that knows the host cannot start, locally or by broadcast.
  const guest = core.createRoom({ selfId: "p2", name: "Guest" });
  guest.join("ABCDE");
  guest.handleMessage("p1", { t: "hello", name: "Host" });
  ensure(guest.snapshot().isHost === false, "p1 is the host for the guest");
  ensure(guest.beginRace() === null, "a guest must not be able to start");
  ensure(guest.snapshot().phase === "lobby", "a refused start leaves the phase alone");

  // A third peer's start message is ignored even if it claims a track.
  const peer2 = core.createRoom({ selfId: "p5", name: "Peer" });
  peer2.join("ABCDE");
  peer2.handleMessage("p1", { t: "hello", name: "Host" });
  peer2.handleMessage("p2", { t: "hello", name: "Guest" });
  const applied = peer2.handleMessage("p2", { t: "start", track: "x.track" });
  ensure(applied === false, "a non-host start must not change state");
  ensure(peer2.snapshot().phase === "lobby", "phase must stay in the lobby");

  // The host's start message carries the track and moves everyone to racing.
  ensure(
    guest.handleMessage("p1", { t: "start", track: "japan.track" }) === true,
    "the host start should be applied"
  );
  ensure(guest.snapshot().phase === "racing", "guest enters the racing phase");
  ensure(guest.snapshot().raceTrack === "japan.track", "guest learns the track");

  const message = room.beginRace();
  ensure(message !== null, "the host should be able to start");
  ensure(
    message.t === "start" && message.track === "japan.track",
    `start payload: ${JSON.stringify(message)}`
  );
  ensure(room.snapshot().phase === "racing", "host enters the racing phase");
  ensure(room.snapshot().raceTrack === "japan.track", "host snapshot carries the track");

  // Without a track there is nothing for peers to open, so start is refused.
  const noTrack = core.createRoom({ selfId: "p1", name: "Host" });
  noTrack.join("ABCDE");
  ensure(noTrack.beginRace() === null, "no track means no start");
  ensure(noTrack.snapshot().phase === "lobby", "phase unchanged without a track");

  // Leaving resets the race so a rejoin starts from the lobby.
  room.leave();
  ensure(room.snapshot().phase === "lobby", "leave returns to the lobby phase");
  ensure(room.snapshot().raceTrack === null, "leave clears the race track");
});

addTest("Lobby gives the host a Start Race control that opens the chosen track", async () => {
  const trackData = JSON.parse(
    require("fs").readFileSync(
      path.join(__dirname, "..", "multiplayer", "tracks.json"),
      "utf8"
    )
  );
  const { container, windowStub } = bootMultiplayerUi({
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(trackData) }),
  });
  const ui = windowStub.document.getElementById("ui");
  const net = windowStub.PolyTrackNet;
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Host dialog: choose Japan through the game's own track screen.
  findTile(container, "Multiplayer").listeners.click[0]();
  ui.querySelector(".mp-overlay")
    .querySelectorAll(".mp-button")
    .find((b) => b.textContent === "Host")
    .listeners.click[0]();
  ui.querySelector(".mp-track-tile").listeners.click[0]();

  let game = buildGameTrackScreen(windowStub, ["Japan"]);
  ui.appendChild(game.screen);
  net.watchGameTrackScreen();
  game.screen.listeners.click[0]({
    target: game.cards.Japan.querySelector("button"),
    preventDefault() {},
    stopPropagation() {},
  });

  // Hosting opens the lobby; the host is alone, so the room elects it.
  ui.querySelector(".mp-overlay").querySelector(".mp-start").listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const lobby = ui.querySelector(".mp-overlay").querySelector(".mp-window");
  ensure(
    lobby.querySelector(".mp-title").textContent === "Hosting Multiplayer Game",
    `lobby title: ${lobby.querySelector(".mp-title").textContent}`
  );
  const startRace = lobby
    .querySelectorAll(".mp-button")
    .find((b) => b.textContent === "Start Race");
  ensure(startRace !== undefined, "the host lobby needs a Start Race button");
  ensure(startRace.disabled === false, "Start Race enables once a track is chosen");

  // Starting opens the game's Play screen and clicks the chosen card.
  let playClicks = 0;
  const playTile = findTile(container, "Play");
  playTile.listeners.click = [
    () => {
      playClicks += 1;
    },
  ];
  startRace.listeners.click[0]();
  ensure(playClicks === 1, "Start Race should open the game's Play screen");
  ensure(
    net.room.snapshot().phase === "racing",
    "starting should move the room to the racing phase"
  );

  // The stub does not remove the screen the way the game does, and
  // document.querySelector() would otherwise find the stale one.
  game.screen.remove();
  game = buildGameTrackScreen(windowStub, ["Japan", "Snow Park"]);
  ui.appendChild(game.screen);
  let started = 0;
  game.cards.Japan
    .querySelector("button")
    .addEventListener("click", () => {
      started += 1;
    });
  net.watchGameTrackScreen();
  ensure(started === 1, `the host's track should start by itself (started=${started})`);

  // Hosting opened a real BroadcastChannel, which would otherwise keep the
  // Node process alive after the suite finishes.
  net.leave();
});

addTest("Menu entry is injected before Play, idempotently", () => {
  const { container, windowStub } = bootMultiplayerUi();

  const tiles = container.querySelectorAll("button.button-image");
  ensure(tiles.length === 6, `expected 6 tiles, got ${tiles.length}`);

  const labels = tiles.map((tile) => tile.querySelector("p").textContent);
  ensure(labels.indexOf("Multiplayer") !== -1, `no Multiplayer tile: ${labels.join(",")}`);
  ensure(
    labels[labels.length - 1] === "Play",
    `Play must stay last, order was ${labels.join(",")}`
  );
  ensure(
    labels[labels.indexOf("Multiplayer") + 1] === "Play",
    "Multiplayer must sit immediately before Play"
  );
  ensure(labels[0] === "Garage", `Customize should be relabelled Garage: ${labels[0]}`);

  const mpTile = tiles[labels.indexOf("Multiplayer")];
  ensure(
    mpTile.querySelector("img").getAttribute("src") === "images/globe.svg",
    "Multiplayer tile should use the globe icon"
  );

  // Re-running the observer must not duplicate the tile.
  windowStub.__observer([]);
  const again = container.querySelectorAll("button.button-image");
  ensure(again.length === 6, `tile duplicated on re-inject: ${again.length}`);
});

addTest("Every image the UI references exists", () => {
  const fs = require("fs");
  const repoRoot = path.join(__dirname, "..");
  const source = fs.readFileSync(
    path.join(repoRoot, "multiplayer", "multiplayer.bundle.js"),
    "utf8"
  );
  const refs = source.match(/images\/[A-Za-z0-9_.-]+/g) || [];
  ensure(refs.length > 0, "expected the UI to reference game icons");
  for (const ref of new Set(refs)) {
    ensure(
      fs.existsSync(path.join(repoRoot, ref)),
      `UI references missing asset: ${ref}`
    );
  }
});

addTest("Generated track list matches the tracks on disk", () => {
  const fs = require("fs");
  const repoRoot = path.join(__dirname, "..");
  const generated = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "multiplayer", "tracks.json"), "utf8")
  );
  const read = (dir) =>
    fs
      .readdirSync(path.join(repoRoot, "tracks", dir))
      .filter((name) => name.endsWith(".track"))
      .sort();
  const official = read("official");
  const community = read("community");
  ensure(
    JSON.stringify(generated.official) === JSON.stringify(official),
    "tracks.json official list is stale - run npm run update-fallbacks"
  );
  ensure(
    JSON.stringify(generated.community) === JSON.stringify(community),
    "tracks.json community list is stale - run npm run update-fallbacks"
  );
  ensure(
    official.length + community.length === generated.official.length + generated.community.length,
    "track counts disagree"
  );
});

addTest("Same-browser transport relays between two clients", async () => {
  if (!localTransport.supports()) {
    console.log("  (skipped: BroadcastChannel unavailable in this runtime)");
    return;
  }
  const code = core.makeRoomCode();
  const a = localTransport.createLocalTransport(code, "client-a");
  const b = localTransport.createLocalTransport(code, "client-b");

  const receivedByB = new Promise((resolve) => {
    b.onMessage((from, payload) => resolve({ from, payload }));
  });
  b.onMessage(() => {});
  a.send({ t: "hello", name: "A" });
  const message = await Promise.race([
    receivedByB,
    new Promise((_, reject) => setTimeout(() => reject(new Error("no relay within 2s")), 2000)),
  ]);
  ensure(message.from === "client-a", "sender id must be preserved");
  ensure(message.payload.t === "hello", "payload must survive the relay");

  a.close();
  b.close();
});

addTest("Vendored Ably SDK is present, parses, and is where the transport looks", () => {
  const fs = require("fs");
  const vm = require("vm");
  const transport = require(path.join(__dirname, "..", "multiplayer", "transport-ably.js"));
  const file = path.join(__dirname, "..", transport.sdkPath);
  ensure(fs.existsSync(file), `${transport.sdkPath} is missing`);
  const src = fs.readFileSync(file, "utf8");
  ensure(src.length > 100000, `unexpectedly small SDK (${src.length} bytes)`);
  ensure(/Ably JavaScript Library v2\./.test(src), "file does not look like the Ably v2 browser build");
  // Parses without executing: a syntax error here would break every online room.
  new vm.Script(src, { filename: "ably.min.js" });
});

(async () => {
  let passed = 0;
  for (const test of tests) {
    try {
      await test.fn();
      console.log(`✔ ${test.name}`);
      passed += 1;
    } catch (err) {
      console.error(`✘ ${test.name}`);
      console.error(err.message || err);
      process.exitCode = 1;
      break;
    }
  }
  if (passed === tests.length) {
    console.log(`\nAll ${passed} multiplayer tests passed.`);
  } else {
    console.log(`\n${passed} of ${tests.length} multiplayer tests passed.`);
  }
})();
