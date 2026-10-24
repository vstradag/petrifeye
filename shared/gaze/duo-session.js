// Two players, one screen — everything around the game that every two-player
// experience shares (DUCK HUNT, DUET): the boot card with each player's
// Neon/webcam choice and bridge state, the webcam calibration, the trouble
// panel, the settings gear and its common toggles, the keys that go with them,
// and the mouse + arrow-key stand-in. MEDUSA's page is where all of this was
// first worked out (games/medusa-analysis.html); it keeps its own copy.
//
//   DuoSession.init({
//     players,                 // [{ id, label, port, color }]
//     title,                   // control legend title
//     hintRows(sim),           // game rows for the legend
//     onStart(sim),            // the game begins (sim: mouse + arrows)
//     onKey(e),                // a key pressed after start, not a common one
//   })
//
// The page provides the standard elements (mpBoot, mpSrcs, mpStart, mpSim,
// mpCal, mpPanel, mpGear, tuning-panel …, see games/duck-hunt.html) and styles
// them with shared/gaze/duo.css. Common toggles are wired only if the page has
// them, so a game can leave out what does not apply to it.
(function () {
  // ------------------------------------------------------------ p5 globals
  // Tracking's mouse and arrow-key stand-in was written for p5 sketches and
  // reads p5's globals. A page without p5 gets the five it uses from here.
  if (typeof window.keyIsDown !== "function") {
    const keysDown = new Set();
    window.LEFT_ARROW = 37; window.UP_ARROW = 38; window.RIGHT_ARROW = 39; window.DOWN_ARROW = 40;
    window.mouseX = innerWidth / 2; window.mouseY = innerHeight / 2;
    window.width = innerWidth; window.height = innerHeight;
    window.keyIsDown = (code) => keysDown.has(code);
    window.addEventListener("mousemove", (e) => { window.mouseX = e.clientX; window.mouseY = e.clientY; });
    window.addEventListener("keydown", (e) => {
      keysDown.add(e.keyCode);
      // Arrows steer P2 in a mouse test; they must not scroll anything.
      if (e.keyCode >= 37 && e.keyCode <= 40) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => keysDown.delete(e.keyCode));
    window.addEventListener("blur", () => keysDown.clear());
    window.addEventListener("resize", () => { window.width = innerWidth; window.height = innerHeight; });
  }

  const PRECISE_POINTER_IDS = new Set(["mouse", "sim2"]);
  const SIM_POINTER_IDS = ["mouse", "sim2"];
  const $ = (id) => document.getElementById(id);

  let cfg = null;
  let players = [];
  let started = false;
  let simMode = false;
  let showTarget = true;
  let calibratedWebcam = false;
  // pointerId -> player. "mouse"/"sim2" are added for a mouse test.
  const byPointer = {};
  let lastList = [];

  // ------------------------------------------------------------ boot card
  function renderBootCmd() {
    const neon = GazeAggregator.players().filter((p) => p.source === "neon");
    const box = $("mpBootCmd");
    if (!box) return;
    if (!neon.length) { box.style.display = "none"; return; }
    box.style.display = "";
    const lines = neon.map(
      (p) => `<b>#</b> ${p.label}\n~/dev/medusa-bridge-venv/bin/python bridge/neon_bridge.py --port ${p.port} --address PHONE_IP`
    ).join("\n\n");
    box.innerHTML =
      `<b># each bridge must be pinned to ITS OWN phone with --address</b>\n<b># easiest: double-click Start PetrifEye.command, which finds and pins each phone</b>\n\n${lines}`;
  }

  // WebGazer is one camera watching one face: at most one webcam player.
  function renderSources(list) {
    const webcamTaken = list.some((p) => p.source === "webcam");
    $("mpSrcs").innerHTML = list.map((p) => {
      const camOpt = (p.source === "webcam" || !webcamTaken)
        ? `<option value="webcam"${p.source === "webcam" ? " selected" : ""}>webcam (WebGazer)</option>`
        : `<option value="webcam" disabled>webcam — taken by another player</option>`;
      const cls = p.live ? "live" : p.state === "offline" ? "err" : "warn";
      const st = p.live ? "ready"
        : p.source === "webcam" ? (p.detail || p.state)
        : p.streaming && p.markers != null ? `${p.markers}/4 markers`
        : (p.detail || p.state);
      return `<div class="mp-src">
        <span class="who" style="color:${p.color}">${p.label}</span>
        <select data-player="${p.id}">
          <option value="neon"${p.source === "neon" ? " selected" : ""}>neon glasses · port ${p.port}</option>
          ${camOpt}
        </select>
        <span class="st ${cls}">${st}</span>
      </div>`;
    }).join("");

    $("mpSrcs").querySelectorAll("select").forEach((sel) => {
      sel.onchange = (e) => {
        GazeAggregator.setSource(Number(e.target.dataset.player), e.target.value);
        calibratedWebcam = false;
      };
    });
  }

  function renderBootState(list) {
    const el = $("mpBootState");
    const btn = $("mpStart");
    // Ready means the bridge has gaze from the phone, not that mapped gaze has
    // arrived: the tags it needs are on this screen, under the card.
    const ready = list.filter((p) => p.streaming).length;

    el.innerHTML = list.map((p) => {
      let cls, txt;
      if (p.live) {
        cls = "live"; txt = "gaze mapped — ready";
      } else if (p.streaming) {
        cls = "warn";
        const m = p.markers;
        txt = m != null
          ? `${m}/4 markers — ${m >= 3 ? "nearly there, hold still" : "normal before start: the tags appear once the game starts"}`
          : (p.detail || "connected");
      } else {
        cls = p.state === "offline" ? "err" : "warn";
        txt = p.detail || p.state;
      }
      return `<span style="color:${p.color}">${p.label}</span> · port ${p.port} — <span class="mp-state ${cls}">${txt}</span>`;
    }).join("<br>");

    btn.disabled = ready === 0;
    btn.textContent = ready === 0 ? "waiting for bridges"
      : ready < list.length ? `start with ${ready} of ${list.length}` : "start";
  }

  // Connection trouble only: a dead pointer explained, never a status line
  // sitting on the game while everyone is tracked.
  function renderPanel(list) {
    if (simMode) { $("mpPanel").innerHTML = ""; return; }
    $("mpPanel").innerHTML = list.filter((p) => !p.live).map((p) => {
      const cls = p.state === "offline" ? "err" : "warn";
      const txt = p.streaming && p.markers != null ? `${p.markers}/4 markers`
        : p.streaming ? "look at the screen" : "disconnected";
      return `<div class="mp-row">
        <div class="mp-dot" style="background:${p.color}"></div>
        <div class="mp-name" style="color:${p.color}">${p.label}</div>
        <div class="mp-state ${cls}">${txt}</div>
      </div>`;
    }).join("");
  }

  // ------------------------------------------------------ webcam calibration
  // Same 3x3, four-clicks-a-dot grid as MEDUSA: WebGazer's regression is
  // untrained until it has seen clicks paired with gaze.
  const CAL_COLS = 3, CAL_ROWS = 3, CAL_CLICKS = 4;

  function runWebcamCalibration() {
    return new Promise((resolve) => {
      const layer = $("mpCal");
      const msg = $("mpCalMsg");
      layer.classList.add("on");
      const pts = [];
      for (let r = 0; r < CAL_ROWS; r++)
        for (let c = 0; c < CAL_COLS; c++)
          pts.push({ fx: (c + 0.5) / CAL_COLS, fy: (r + 0.5) / CAL_ROWS });

      let i = 0;
      const showPoint = () => {
        layer.querySelectorAll(".mp-cal-dot").forEach((d) => d.remove());
        if (i >= pts.length) {
          layer.classList.remove("on");
          calibratedWebcam = true;
          resolve();
          return;
        }
        let clicks = 0;
        const dot = document.createElement("button");
        dot.className = "mp-cal-dot";
        dot.style.left = `${pts[i].fx * 100}%`;
        dot.style.top = `${pts[i].fy * 100}%`;
        dot.innerHTML = `<span>${CAL_CLICKS}</span>`;
        dot.onclick = (ev) => {
          GazeAggregator.recordCalibrationClick(ev.clientX, ev.clientY);
          clicks += 1;
          dot.querySelector("span").textContent = String(CAL_CLICKS - clicks);
          if (clicks >= CAL_CLICKS) { i += 1; showPoint(); }
        };
        layer.appendChild(dot);
        msg.textContent = `look at the dot and click it — point ${i + 1} of ${pts.length}`;
      };
      showPoint();
    });
  }

  // ---------------------------------------------------------------- markers
  // The four tag squares in screen pixels, empty when no tags are drawn — for
  // keeping things a visitor must see out from under them.
  function markerRects() {
    if (!(window.Markers && Markers.tagsDrawn)) return [];
    const s = Markers.size, m = Markers.margin;
    const W = innerWidth, H = innerHeight;
    return [
      { x: m, y: m, w: s, h: s },
      { x: W - m - s, y: m, w: s, h: s },
      { x: W - m - s, y: H - m - s, w: s, h: s },
      { x: m, y: H - m - s, w: s, h: s },
    ];
  }

  // ------------------------------------------------------------- chrome
  function setTuningVisible(on) {
    const panel = $("tuning-panel");
    if (panel) panel.classList.toggle("tuning-panel-hidden", !on);
  }
  function toggleTuning() {
    const panel = $("tuning-panel");
    if (panel) setTuningVisible(panel.classList.contains("tuning-panel-hidden"));
  }

  // Fully visible whenever the mouse is in use, gone a few seconds after: a
  // showing runs untouched, so it disappears on its own.
  const GEAR_IDLE_MS = 3000;
  let gearIdleTimer = null;
  function wakeGear() {
    const gear = $("mpGear");
    if (!gear) return;
    gear.classList.remove("idle");
    clearTimeout(gearIdleTimer);
    gearIdleTimer = setTimeout(() => {
      const panel = $("tuning-panel");
      if (panel && !panel.classList.contains("tuning-panel-hidden")) return wakeGear();
      gear.classList.add("idle");
    }, GEAR_IDLE_MS);
  }

  function setChecked(id, on) { const box = $(id); if (box) box.checked = !!on; }
  function setTargetVisible(on) { showTarget = !!on; setChecked("toggle-target", showTarget); }
  function setAssist(on) {
    if (window.GazeAssist) GazeAssist.setEnabled(on);
    setChecked("toggle-assist", on);
  }
  function setAutoCalibrate(on) {
    if (window.GazeAutoCalibrate) GazeAutoCalibrate.setEnabled(on);
    setChecked("toggle-autocal", on);
  }
  function setMarkers(on) {
    if (!window.Markers) return;
    on ? Markers.show() : Markers.hide();
  }

  function bind(id, event, fn) { const el = $(id); if (el) el[event] = fn; }

  function wireChrome() {
    bind("mpGear", "onclick", toggleTuning);
    window.addEventListener("mousemove", wakeGear);
    window.addEventListener("mousedown", wakeGear);

    bind("toggle-target", "onchange", (e) => setTargetVisible(e.target.checked));
    bind("toggle-assist", "onchange", (e) => setAssist(e.target.checked));
    bind("toggle-autocal", "onchange", (e) => setAutoCalibrate(e.target.checked));
    bind("toggle-markers", "onchange", (e) => setMarkers(e.target.checked));

    // Marker size goes through the aggregator, so the tags and every bridge's
    // surface geometry move together.
    const markerSlider = $("slider-marker");
    const showMarkerSize = (px) => {
      const out = $("tv-marker");
      if (out) out.textContent = `${px}px`;
      if (markerSlider && Number(markerSlider.value) !== px) markerSlider.value = px;
    };
    if (markerSlider) {
      markerSlider.oninput = (e) => {
        const applied = GazeAggregator.setMarkerSize(Number(e.target.value));
        if (applied) showMarkerSize(applied);
      };
    }
    window.addEventListener("markers-size", (e) => showMarkerSize(e.detail.size));
    window.addEventListener("load", () => { if (window.Markers && Markers.size) showMarkerSize(Markers.size); });
    window.addEventListener("markers-visibility", (e) => setChecked("toggle-markers", e.detail.shown));

    // Preview how another input will feel while testing with a cursor.
    bind("select-profile", "onchange", (e) => {
      const v = e.target.value;
      if (window.GazeAssist) GazeAssist.useProfile(v || null);
      const out = $("tv-profile");
      if (out) out.textContent = v || "auto";
    });

    window.addEventListener("keydown", (e) => {
      // Typing into a field or choosing in a dropdown is not a command. A
      // slider or checkbox that still has focus after use is, or s could no
      // longer close the panel it was opened with.
      const t = e.target;
      if (t && (t.tagName === "SELECT" || t.tagName === "TEXTAREA" ||
                (t.tagName === "INPUT" && !/^(range|checkbox)$/.test(t.type)))) return;
      const k = e.key;
      if (k === "s" || k === "S") { toggleTuning(); wakeGear(); return; }
      if (k === "g" || k === "G") { setTargetVisible(!showTarget); return; }
      if (k === "a" || k === "A") { if (window.GazeAssist) setAssist(!GazeAssist.isEnabled()); return; }
      if (k === "m" || k === "M") { setMarkers(!(window.Markers && Markers.shown)); return; }
      if ($("toggle-autocal")) {
        if (k === "C") { if (window.GazeAutoCalibrate) GazeAutoCalibrate.reset(); return; }
        if (k === "c") { if (window.GazeAutoCalibrate) setAutoCalibrate(!GazeAutoCalibrate.isEnabled()); return; }
      }
      if (started && cfg.onKey) cfg.onKey(e);
    });
  }

  // ---------------------------------------------------------------- start
  function goFullscreen() {
    try {
      if (document.fullscreenElement) return;
      const p = document.documentElement.requestFullscreen?.();
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* unsupported → play windowed */ }
  }

  function start(sim) {
    if (started) return;
    started = true;
    simMode = !!sim;
    goFullscreen();
    $("mpBoot").classList.add("hidden");
    $("mpPanel").style.display = "";
    $("mpGear").style.display = "";
    wakeGear();
    renderPanel(lastList);

    if (sim) {
      // The aggregator must stop publishing first, or it keeps pushing an
      // empty pointer list over the top of the mouse.
      GazeAggregator.setPublishing(false);
      Tracking.releaseExternal();
      if (!Tracking.isSimSecondEnabled()) Tracking.toggleSimSecondPointer();
      SIM_POINTER_IDS.forEach((pid, i) => { if (players[i]) byPointer[pid] = players[i]; });
      if (window.Markers) Markers.hide();
    }

    if (window.ControlsHint) {
      ControlsHint.show(
        (sim ? [{ keys: "mouse", does: `${players[0].label}'s gaze` }, { keys: "arrows", does: `${players[1].label}'s gaze` }] : [])
          .concat(cfg.hintRows ? cfg.hintRows(sim) : [])
          .concat([{ keys: "g", does: "gaze target on/off" }, { keys: "s", does: "settings" }]),
        cfg.title
      );
    }

    if (cfg.onStart) cfg.onStart(simMode);
  }

  window.DuoSession = {
    init(config) {
      cfg = config;
      players = config.players;
      players.forEach((p) => (byPointer[`player-${p.id}`] = p));
      lastList = players.map((p) => ({ ...p, state: "connecting", live: false }));

      window.addEventListener("gaze-players", (e) => {
        lastList = e.detail;
        if (started) renderPanel(lastList);
        else { renderSources(lastList); renderBootState(lastList); renderBootCmd(); }
      });

      $("mpStart").onclick = async () => {
        const cam = GazeAggregator.webcamPlayer();
        if (cam && !calibratedWebcam) {
          $("mpBootInner").style.visibility = "hidden";
          await runWebcamCalibration();
          $("mpBootInner").style.visibility = "";
        }
        start(false);
      };
      $("mpSim").onclick = () => start(true);
      wireChrome();

      renderBootCmd();
      GazeAggregator.init({ players });
      // Tags on during the boot card: it doubles as the framing step.
      if (window.Markers) Markers.show();

      if (new URLSearchParams(location.search).has("sim")) start(true);
    },

    get started() { return started; },
    get simMode() { return simMode; },
    get showTarget() { return showTarget; },
    get players() { return players; },
    byPointer,
    playerOf: (pointerId) => byPointer[pointerId] || null,
    isPrecise: (pointerId) => PRECISE_POINTER_IDS.has(pointerId),
    markerRects,
    wakeGear,
  };
})();
