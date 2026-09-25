// LIVE GAZE — one image, one screen.
//
// Political Vision with the cartoons swapped for uploaded images, and with the
// one change that makes several images possible at once: THIS WINDOW IS A
// SCREEN. It draws its own four AprilTags (window.GazeMarkerIds, set in the
// HTML before markers.js loads), registers them with every bridge, and accepts
// only the gaze the bridge says landed on that surface.
//
// WHY A SCREEN PER WINDOW, RATHER THAN ONE WINDOW SHOWING EVERYTHING
//
// The glasses' scene camera finds the display by its tags. Two displays wearing
// tags 0-3 are indistinguishable — one surface, solved from whichever set of
// four the detector happened to see — and every mapped coordinate would be
// attributed to the wrong image with no error anywhere. Distinct tag sets are
// what make "which image is this person looking at" a question with an answer.
//
// The cost of a second image is therefore a second DISPLAY, not more compute:
// each bridge decodes its phone's scene video and searches it for tags once per
// frame regardless of how many surfaces are registered.
//
// Everything broadcast is in NORMALISED IMAGE COORDINATES (0..1 across the
// image), so an analysis window can draw it at any size.
(function () {
  const PLAYERS = [
    { id: 0, label: "P1", port: 8443, color: "#ff5f5f" },
    { id: 1, label: "P2", port: 8444, color: "#4ecdc4" },
  ];
  const CHANNEL = LiveGazeStore.CHANNEL;
  const TARGET_D = 44;                    // same marker as MEDUSA
  const TARGET_RGB = "57, 255, 20";

  const SLOT = Math.max(0, Math.min(LiveGazeStore.MAX_IMAGES - 1,
    Number(new URLSearchParams(location.search).get("slot") || 0)));
  const INFO = LiveGazeStore.slotInfo(SLOT);

  const $ = (id) => document.getElementById(id);
  const bus = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;

  const state = {
    image: null,         // { el, w, h, name }
    total: 1,            // how many images in the session, for "2 of 3"
    fixations: [],       // [{ p, u, v, dur, start }]
    started: false,
    simMode: false,
    showTarget: false,
    spreadPct: 3.5,      // fixation dispersion, % of displayed image width
    minDurationMs: 100,
  };
  const detectors = new Map();   // pointerId -> FixationDetector
  let rect = { x: 0, y: 0, w: 1, h: 1 };

  // ------------------------------------------------------------ players
  function playerFor(id) {
    const m = /^player-(\d+)$/.exec(id);
    if (m) return PLAYERS[Number(m[1])] || null;
    // The mouse/keyboard stand-in, credited to the first two players.
    if (state.simMode && id === "mouse") return PLAYERS[0];
    if (state.simMode && id === "sim2") return PLAYERS[1];
    return null;
  }

  // Measurement settings per INPUT, because precision differs by an order of
  // magnitude between them: a webcam cannot resolve fixations as finely as
  // glasses, so it gets a longer median and a wider spatial window rather than
  // a detector that fragments every look into noise.
  function inputOf(id) {
    if (!/^player-/.test(id)) return "mouse";
    const n = Number(id.split("-")[1]);
    const p = (GazeAggregator.players() || []).find((x) => x.id === n);
    return p && p.source === "webcam" ? "webcam" : "neon";
  }
  const MEASURE = {
    neon:   { median: 5, spread: 1 },
    mouse:  { median: 5, spread: 1 },
    webcam: { median: 7, spread: 2.5 },
  };

  function dispersionPx(input) {
    return Math.max(4, (state.spreadPct / 100) * rect.w * MEASURE[input].spread);
  }

  function entryFor(id) {
    let e = detectors.get(id);
    if (!e) {
      const input = inputOf(id);
      e = {
        input,
        med: new MedianFilter2D(MEASURE[input].median),
        det: new FixationDetector({ dispersionPx: dispersionPx(input), minDurationMs: state.minDurationMs }),
      };
      detectors.set(id, e);
    }
    return e;
  }

  function retuneDetectors() {
    for (const e of detectors.values()) {
      e.det.dispersionPx = dispersionPx(e.input);
      e.det.minDurationMs = state.minDurationMs;
    }
  }

  // ------------------------------------------------------------- layout
  // Largest image rectangle that stays CLEAR of the four corner tags: letting
  // the tags overlap would hide parts of the image from the very people being
  // studied. The tags only occupy the corners, so the image can be as tall as
  // the screen if it sits between the tag columns, or as wide as the screen if
  // it sits between the tag rows — take whichever is bigger. Shrinking the tags
  // from the gear therefore directly enlarges the image.
  function imageRect() {
    const W = window.innerWidth, H = window.innerHeight;
    const aspect = state.image && state.image.w ? state.image.w / state.image.h : 1.5;
    const pad = 12;
    const fullH = Math.min((W - 2 * pad) / aspect, H - 2 * pad);
    let h = fullH;

    const tagsOn = window.Markers && Markers.shown && !state.simMode;
    if (tagsOn) {
      const F = (Markers.margin || 24) + (Markers.size || 300) + 10;
      const betweenRows = Math.min((W - 2 * pad) / aspect, H - 2 * F);
      const betweenCols = Math.min((W - 2 * F) / aspect, H - 2 * pad);
      h = Math.min(fullH, Math.max(betweenRows, betweenCols, 40));
    }
    const w = h * aspect;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  // ------------------------------------------------------------- image
  async function loadImage() {
    const rec = await LiveGazeStore.get(SLOT);
    const session = await LiveGazeStore.session();
    state.total = Math.max(1, session.count || 1);
    if (!rec) {
      $("ssSub").innerHTML = `no image in slot ${SLOT + 1} — ` +
        `<a href="live-gaze.html" style="color:#c98f8f">upload images first</a>`;
      updateTitle();
      return;
    }
    const loaded = await LiveGazeStore.load(rec);
    if (loaded) state.image = { ...loaded, name: rec.name };
    updateTitle();
    broadcastSnapshot();
  }

  function updateTitle() {
    const name = state.image ? state.image.name : "no image";
    $("lgTitle").textContent = `${SLOT + 1} / ${state.total} — ${name}`;
    $("lgTags").textContent = `tags ${INFO.ids.join(" · ")} · bridge screen "${INFO.key}"`;
    $("ssSub").innerHTML = state.image
      ? `image <b class="lg-slot">${SLOT + 1}</b> of ${state.total} — ${name}`
      : $("ssSub").innerHTML;
    $("ssWhich").textContent = `screen ${SLOT + 1} of ${state.total}`;
  }

  function flushAll() {
    for (const [id, e] of detectors) {
      const pl = playerFor(id);
      const f = e.det.flush();
      if (f && pl) recordFixation(pl, f);
    }
  }

  function resetImage() {
    flushAll();
    state.fixations = [];
    detectors.clear();
    broadcastSnapshot();
  }

  // ------------------------------------------------------------ record
  function recordFixation(pl, f) {
    const u = (f.x - rect.x) / rect.w, v = (f.y - rect.y) / rect.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    const fix = { p: pl.id, u, v, dur: Math.round(f.duration), start: Math.round(f.start) };
    state.fixations.push(fix);
    post({ type: "fixation", fix });
  }

  // --------------------------------------------------------- broadcast
  // One channel for every Live Gaze window, in both directions, with `slot` on
  // every message. That is what lets ONE analysis window carry the other
  // images' scanpaths in its fourth panel when displays are short — it hears
  // all of them and picks what it needs.
  function post(msg) { if (bus) bus.postMessage({ ...msg, slot: SLOT }); }

  function broadcastSnapshot() {
    post({
      type: "snapshot",
      total: state.total,
      image: state.image
        ? { name: state.image.name, w: state.image.w, h: state.image.h }
        : null,
      players: PLAYERS.map(({ id, label, color }) => ({ id, label, color })),
      fixations: state.fixations,
      started: state.started,
      settings: { spreadPct: state.spreadPct, minDurationMs: state.minDurationMs },
    });
  }

  // Marker size is one global on the bridge, shared by every registered
  // screen — so a change here has to reach the OTHER screen windows too, or
  // their tags would stay at the old size while the bridge solves against the
  // new one, skewing their mapping with nothing to show for it.
  let applyingRemote = false;

  if (bus) {
    bus.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "hello") { broadcastSnapshot(); return; }
      if (m.type === "images-changed") { location.reload(); return; }
      if (m.type === "markerSize" && m.slot !== SLOT) {
        applyingRemote = true;
        const applied = GazeAggregator.setMarkerSize(m.size);
        if (applied) { $("tv-marker").textContent = `${applied}px`; $("slider-marker").value = applied; }
        applyingRemote = false;
        return;
      }
      // Starting one screen starts them all: with three projectors up, walking
      // to each window to press start is exactly when visitors are waiting.
      if (m.type === "start" && m.slot !== SLOT && !state.started) { start(false); return; }
      if (m.type === "cmd" && (m.slot === SLOT || m.slot == null)) {
        if (m.cmd === "reset") resetImage();
      }
    };
  }

  let lastGazePost = 0;

  // ------------------------------------------------------------ p5 loop
  window.setup = function () {
    createCanvas(windowWidth, windowHeight);
    pixelDensity(1);
    loadImage();
  };

  window.windowResized = function () {
    resizeCanvas(windowWidth, windowHeight);
  };

  window.draw = function () {
    background(0);
    rect = imageRect();
    const img = state.image;
    if (img && img.el) drawingContext.drawImage(img.el, rect.x, rect.y, rect.w, rect.h);
    if (!state.started) return;

    retuneDetectors();                    // rect may have changed size
    const now = performance.now();
    const pointers = Tracking.update();
    const seen = new Set();
    const live = [];

    for (const ptr of pointers) {
      const pl = playerFor(ptr.id);
      if (!pl || !Number.isFinite(ptr.x) || !Number.isFinite(ptr.y)) continue;
      seen.add(ptr.id);
      const e = entryFor(ptr.id);

      // MEASURE the raw position, median-filtered — never the assisted one,
      // which overshoots saccades and creeps into place for the sake of feel.
      const m = e.med.push(ptr.rawX ?? ptr.x, ptr.rawY ?? ptr.y);
      const inside = m.x >= rect.x && m.x <= rect.x + rect.w &&
                     m.y >= rect.y && m.y <= rect.y + rect.h;
      // Gaze off the image ends a fixation: the stats describe looking AT the
      // image, and a fixation must not straddle its edge.
      const closed = inside ? e.det.push(now, m.x, m.y) : e.det.flush();
      if (closed) recordFixation(pl, closed);

      const cur = inside ? e.det.current() : null;
      live.push({
        p: pl.id,
        u: (m.x - rect.x) / rect.w,
        v: (m.y - rect.y) / rect.h,
        fu: cur ? (cur.x - rect.x) / rect.w : null,
        fv: cur ? (cur.y - rect.y) / rect.h : null,
        fd: cur ? Math.round(cur.duration) : 0,
      });
      // The participant-facing target keeps the smooth assisted position:
      // that one is for looking at, not for counting.
      if (state.showTarget && ptr.id !== "mouse") drawTarget(ptr.x, ptr.y, pl.color);
    }

    // A pointer that vanished (glasses off, looking at another screen, tracking
    // lost) closes its fixation rather than leaving it open across the gap.
    for (const [id, e] of detectors) {
      if (seen.has(id)) continue;
      const pl = playerFor(id);
      const f = e.det.flush();
      e.med.reset();
      if (f && pl) recordFixation(pl, f);
    }

    if (now - lastGazePost > 33) {         // ~30Hz is plenty for a trace
      lastGazePost = now;
      post({ type: "gaze", pts: live });
    }
  };

  function drawTarget(x, y, color) {
    const ctx = drawingContext;
    const d = TARGET_D, arm = d * 0.64;
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgb(${TARGET_RGB})`;
    ctx.beginPath(); ctx.arc(x, y, d / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, d * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------- boot card
  function renderBootCmd() {
    const neon = GazeAggregator.players().filter((p) => p.source === "neon");
    const box = $("ssBootCmd");
    if (!neon.length) { box.style.display = "none"; return; }
    box.style.display = "";
    const lines = neon.map((p) =>
      `<b>#</b> ${p.label}\n~/dev/medusa-bridge-venv/bin/python bridge/neon_bridge.py --port ${p.port} --address PHONE_IP`
    ).join("\n\n");
    box.innerHTML = `<b># each bridge must be pinned to ITS OWN phone with --address</b>\n<b># without it, every bridge grabs the first phone it finds — the same one</b>\n<b># easiest: double-click Start PetrifEye.command, which finds and pins each phone</b>\n\n${lines}`;
  }

  // WebGazer is one camera watching one face, and it reports positions in the
  // window that owns it — so it can only ever describe THIS screen. Offered on
  // the first image only; on the others it would silently attribute a visitor's
  // gaze to an image they are not looking at.
  function renderSources(list) {
    const webcamTaken = list.some((p) => p.source === "webcam");
    $("ssSrcs").innerHTML = list.map((p) => {
      let camOpt;
      if (SLOT !== 0) {
        camOpt = `<option value="webcam" disabled>webcam — image 1 only</option>`;
      } else if (p.source === "webcam" || !webcamTaken) {
        camOpt = `<option value="webcam"${p.source === "webcam" ? " selected" : ""}>webcam (WebGazer)</option>`;
      } else {
        camOpt = `<option value="webcam" disabled>webcam — taken by another player</option>`;
      }
      const cls = p.live ? "live" : p.state === "offline" ? "err" : "warn";
      const st = p.live ? "ready"
        : p.source === "webcam" ? (p.detail || p.state)
        : p.streaming && p.markers != null ? `${p.markers}/4 markers`
        : (p.detail || p.state);
      return `<div class="ss-src">
        <span class="who" style="color:${p.color}">${p.label}</span>
        <select data-player="${p.id}">
          <option value="neon"${p.source === "neon" ? " selected" : ""}>neon glasses · port ${p.port}</option>
          ${camOpt}
        </select>
        <span class="st ${cls}">${st}</span>
      </div>`;
    }).join("");
    $("ssSrcs").querySelectorAll("select").forEach((sel) => {
      sel.onchange = (e) => {
        GazeAggregator.setSource(Number(e.target.dataset.player), e.target.value);
        calibratedWebcam = false;
      };
    });
  }

  function renderBootState(list) {
    // Ready means "the bridge has gaze from the phone", not "mapped gaze has
    // arrived": mapping needs THIS screen's tags, which the boot card covers.
    const ready = list.filter((p) => p.streaming).length;
    $("ssBootState").innerHTML = list.map((p) => {
      let cls, txt;
      if (p.live) { cls = "live"; txt = "gaze mapped to this screen — ready"; }
      else if (p.streaming) {
        cls = "warn";
        txt = p.markers != null
          ? `${p.markers}/4 of THIS screen's tags — ${p.markers >= 3 ? "nearly there, hold still" : "normal before start: the tags appear once the image does"}`
          : (p.detail || "connected");
      } else { cls = p.state === "offline" ? "err" : "warn"; txt = p.detail || p.state; }
      return `<span style="color:${p.color}">${p.label}</span> · port ${p.port} — <span class="ss-state ${cls}">${txt}</span>`;
    }).join("<br>");
    const btn = $("ssStart");
    btn.disabled = ready === 0;
    btn.textContent = ready === 0 ? "waiting for bridges"
      : ready < list.length ? `start with ${ready} of ${list.length}` : "start";
  }

  // Only speaks when something needs attention — never sits on the image.
  function renderStatus(list) {
    if (!state.started || state.simMode) { $("ssStatus").textContent = ""; return; }
    const issues = list.filter((p) => !p.live).map((p) =>
      `${p.label}: ${p.streaming && p.markers != null ? `${p.markers}/4 markers`
        : p.streaming ? "looking elsewhere" : "disconnected"}`);
    $("ssStatus").textContent = issues.join("   ");
  }

  // ------------------------------------------------- webcam calibration
  let calibratedWebcam = false;
  function runWebcamCalibration() {
    return new Promise((resolve) => {
      const layer = $("ssCal"), msg = $("ssCalMsg");
      layer.classList.add("on");
      const pts = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) pts.push({ fx: (c + 0.5) / 3, fy: (r + 0.5) / 3 });
      const CLICKS = 4;
      let i = 0;
      const show = () => {
        layer.querySelectorAll(".ss-cal-dot").forEach((d) => d.remove());
        if (i >= pts.length) { layer.classList.remove("on"); calibratedWebcam = true; resolve(); return; }
        let clicks = 0;
        const dot = document.createElement("button");
        dot.className = "ss-cal-dot";
        dot.style.left = `${pts[i].fx * 100}%`;
        dot.style.top = `${pts[i].fy * 100}%`;
        dot.innerHTML = `<span>${CLICKS}</span>`;
        dot.onclick = (ev) => {
          GazeAggregator.recordCalibrationClick(ev.clientX, ev.clientY);
          clicks += 1;
          dot.querySelector("span").textContent = String(CLICKS - clicks);
          if (clicks >= CLICKS) { i += 1; show(); }
        };
        layer.appendChild(dot);
        msg.textContent = `look at the dot and click it — point ${i + 1} of ${pts.length}`;
      };
      show();
    });
  }

  // ------------------------------------------------------------- chrome
  function setTuningVisible(on) { $("tuning-panel").classList.toggle("tuning-panel-hidden", !on); }
  function toggleTuning() { setTuningVisible($("tuning-panel").classList.contains("tuning-panel-hidden")); wakeGear(); }

  function setTargetVisible(on) { state.showTarget = !!on; $("toggle-target").checked = !!on; }
  function setAssist(on) { if (window.GazeAssist) GazeAssist.setEnabled(on); $("toggle-assist").checked = !!on; }
  function setMarkers(on) { if (window.Markers) (on ? Markers.show() : Markers.hide()); }

  const GEAR_IDLE_MS = 3000;
  let gearTimer = null;
  function wakeGear() {
    const g = $("ssGear");
    g.classList.remove("idle");
    clearTimeout(gearTimer);
    gearTimer = setTimeout(() => {
      if (!$("tuning-panel").classList.contains("tuning-panel-hidden")) return wakeGear();
      g.classList.add("idle");
    }, GEAR_IDLE_MS);
  }

  function openObserver() {
    window.open(`live-gaze-observer.html?slot=${SLOT}`, `lg-obs-${SLOT}`, "popup=yes,width=1280,height=800");
  }

  $("ssGear").onclick = toggleTuning;
  $("toggle-target").onchange = (e) => setTargetVisible(e.target.checked);
  $("toggle-assist").onchange = (e) => setAssist(e.target.checked);
  $("toggle-markers").onchange = (e) => setMarkers(e.target.checked);
  $("lgReset").onclick = resetImage;
  $("lgObserver").onclick = openObserver;
  $("ssObserverBoot").onclick = openObserver;
  $("lgPick").onclick = () => { location.href = "live-gaze.html"; };

  $("slider-marker").oninput = (e) => {
    const applied = GazeAggregator.setMarkerSize(Number(e.target.value));
    if (applied) $("tv-marker").textContent = `${applied}px`;
  };
  window.addEventListener("markers-size", (e) => {
    $("tv-marker").textContent = `${e.detail.size}px`;
    $("slider-marker").value = e.detail.size;
    if (!applyingRemote) post({ type: "markerSize", size: e.detail.size });
  });
  window.addEventListener("markers-visibility", (e) => { $("toggle-markers").checked = !!e.detail.shown; });

  $("slider-spread").oninput = (e) => {
    state.spreadPct = Number(e.target.value);
    $("tv-spread").textContent = `${state.spreadPct}%`;
    retuneDetectors();
    broadcastSnapshot();
  };
  $("slider-mindur").oninput = (e) => {
    state.minDurationMs = Number(e.target.value);
    $("tv-mindur").textContent = `${state.minDurationMs}ms`;
    retuneDetectors();
    broadcastSnapshot();
  };
  $("select-profile").onchange = (e) => {
    if (window.GazeAssist) GazeAssist.useProfile(e.target.value || null);
    $("tv-profile").textContent = e.target.value || "auto";
  };

  window.addEventListener("mousemove", () => state.started && wakeGear());
  window.addEventListener("mousedown", () => state.started && wakeGear());
  window.addEventListener("keydown", (e) => {
    if (!state.started) return;
    const k = e.key.toLowerCase();
    if (k === "g") setTargetVisible(!state.showTarget);
    else if (k === "a") setAssist(!GazeAssist.isEnabled());
    else if (k === "m") setMarkers(!(window.Markers && Markers.shown));
    else if (k === "s") toggleTuning();
    else if (k === "r") resetImage();
    else if (k === "o") openObserver();
  });

  let lastList = PLAYERS.map((p) => ({ ...p, state: "connecting", live: false }));
  window.addEventListener("gaze-players", (e) => {
    lastList = e.detail;
    if (state.started) renderStatus(lastList);
    else { renderSources(lastList); renderBootState(lastList); renderBootCmd(); }
  });

  // ------------------------------------------------------------- start
  function goFullscreen() {
    try {
      if (document.fullscreenElement) return;
      const p = document.documentElement.requestFullscreen?.();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }

  function start(sim) {
    if (state.started) return;
    state.started = true;
    state.simMode = !!sim;
    goFullscreen();
    $("ssBoot").classList.add("hidden");
    $("ssGear").style.display = "";
    wakeGear();

    // The camera preview would sit on top of the image.
    const wg = (window.GazeSources || {}).webgazer;
    if (wg && wg.setPreviewVisible) { try { wg.setPreviewVisible(false); } catch (_) {} }

    if (sim) {
      GazeAggregator.setPublishing(false);
      Tracking.releaseExternal();
      if (!Tracking.isSimSecondEnabled()) Tracking.toggleSimSecondPointer();
      if (window.Markers) Markers.hide();
      if (window.ControlsHint) {
        ControlsHint.show([
          { keys: "mouse", does: "P1 gaze" }, { keys: "arrows", does: "P2 gaze" },
          { keys: "g", does: "gaze target on/off" },
          { keys: "o", does: "open analysis screen" },
          { keys: "r", does: "reset this image" },
        ], `live gaze · image ${SLOT + 1}`);
      }
    } else {
      // Real start only: a mouse test on one screen must not pull the other
      // screens out of their boot card, where their tags are still being framed.
      post({ type: "start" });
    }
    renderStatus(lastList);
    broadcastSnapshot();
  }

  $("ssStart").onclick = async () => {
    const cam = GazeAggregator.webcamPlayer();
    if (cam && !calibratedWebcam) {
      $("ssBootInner").style.visibility = "hidden";
      await runWebcamCalibration();
      $("ssBootInner").style.visibility = "";
    }
    start(false);
  };
  $("ssSim").onclick = () => start(true);

  renderBootCmd();
  updateTitle();
  // The screen registration travels with init: this window's own tags and its
  // own size, so the very first surface solve already belongs to this display.
  GazeAggregator.init({ players: PLAYERS, screen: { key: INFO.key, ids: INFO.ids } });
  // Tags drawn during the boot card: each scene camera must see them before any
  // gaze can be mapped, so framing happens before START.
  if (window.Markers) Markers.show();
  if (new URLSearchParams(location.search).has("sim")) start(true);

  // Exposed for testing and the console.
  window.LiveGazeScreen = { state, slot: SLOT, info: INFO, resetImage, imageRect: () => rect, detectors };
})();
