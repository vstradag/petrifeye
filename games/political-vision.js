// POLITICAL VISION — viewer screen.
//
// What participants see: one political cartoon, full screen. Gaze from each
// player (Neon glasses, the webcam, or mouse + arrows for testing) is turned
// into fixations here, and everything is broadcast to the observer screen
// (political-vision-observer.html) for the second projector.
//
// WHY THE OBSERVER IS FED FROM HERE, NOT FROM THE BRIDGES
//
// Two reasons, and the second is the one that would bite silently.
//   1. Only this window has all three inputs. WebGazer runs in the page that
//      owns the camera, and the mouse lives here too.
//   2. A bridge maps gaze into the viewport of whichever page last reported
//      one. If the observer window connected to a bridge it would report ITS
//      size, and every player's gaze would be mapped into the wrong screen —
//      no error, just quietly wrong coordinates. So the observer never touches
//      a bridge; it listens on a BroadcastChannel, which same-origin windows
//      in the same browser share.
//
// Everything sent is in NORMALISED IMAGE COORDINATES (0..1 across the
// cartoon), so the observer can draw it at any size, and moving or resizing
// the image here never corrupts the record.
(function () {
  const PLAYERS = [
    { id: 0, label: "P1", port: 8443, color: "#ff5f5f" },
    { id: 1, label: "P2", port: 8444, color: "#4ecdc4" },
  ];
  const CHANNEL = "political-vision";
  const MANIFEST = "../images/political-vision/manifest.json";
  const TARGET_D = 44;                    // same marker as MEDUSA
  const TARGET_RGB = "57, 255, 20";

  const $ = (id) => document.getElementById(id);
  const bus = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;

  const state = {
    images: [],          // [{ file, title, el, w, h }]
    index: 0,
    fixByImage: [],      // per image: [{ p, u, v, dur, start }]
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
  // magnitude between them. Chosen by sweep (see MedianFilter2D in
  // fixations.js): a webcam cannot resolve fixations as finely as glasses, so
  // it gets a longer median and a wider spatial window rather than a
  // detector that fragments every look into noise.
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

  // One entry per pointer: its own median filter feeding its own detector.
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
  // Largest cartoon rectangle that stays CLEAR of the four corner tags.
  //
  // Letting the tags overlap the image would hide its corners from the very
  // people being studied — the "BELLWEATHER BUILDS" sign sits exactly where
  // the top-left tag goes. The tags only occupy the corners, so the image can
  // be as tall as the screen if it sits between the tag columns, or as wide
  // as the screen if it sits between the tag rows. Take whichever is bigger.
  // Shrinking the tags from the gear therefore directly enlarges the cartoon.
  function imageRect() {
    const W = window.innerWidth, H = window.innerHeight;
    const img = state.images[state.index];
    const aspect = img && img.w ? img.w / img.h : 1.5;
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

  // ------------------------------------------------------------ images
  async function loadImages() {
    const res = await fetch(MANIFEST, { cache: "no-store" });
    const man = await res.json();
    state.images = man.images.map((m) => ({ ...m, el: null, w: 0, h: 0 }));
    state.fixByImage = state.images.map(() => []);
    await Promise.all(state.images.map((m) => new Promise((resolve) => {
      const el = new Image();
      el.onload = () => { m.el = el; m.w = el.naturalWidth; m.h = el.naturalHeight; resolve(); };
      el.onerror = () => resolve();
      el.src = `../images/political-vision/${m.file}`;
    })));
    updateTitle();
    broadcastSnapshot();
  }

  function updateTitle() {
    const img = state.images[state.index];
    $("pvTitle").textContent = img
      ? `${state.index + 1} / ${state.images.length} — ${img.title}` : "no images";
  }

  // Close every open fixation on the CURRENT image before anything about the
  // image changes — otherwise the last look at one cartoon gets filed under
  // the next.
  function flushAll() {
    for (const [id, e] of detectors) {
      const pl = playerFor(id);
      const f = e.det.flush();
      if (f && pl) recordFixation(pl, f);
    }
  }

  function changeImage(delta) {
    if (!state.images.length) return;
    flushAll();
    state.index = (state.index + delta + state.images.length) % state.images.length;
    detectors.clear();
    updateTitle();
    broadcastSnapshot();
  }

  function resetImage() {
    flushAll();
    state.fixByImage[state.index] = [];
    detectors.clear();
    broadcastSnapshot();
  }

  // ------------------------------------------------------------ record
  function recordFixation(pl, f) {
    const u = (f.x - rect.x) / rect.w, v = (f.y - rect.y) / rect.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    const fix = { p: pl.id, u, v, dur: Math.round(f.duration), start: Math.round(f.start) };
    state.fixByImage[state.index].push(fix);
    post({ type: "fixation", index: state.index, fix });
  }

  // --------------------------------------------------------- broadcast
  function post(msg) { if (bus) bus.postMessage(msg); }

  function broadcastSnapshot() {
    post({
      type: "snapshot",
      index: state.index,
      images: state.images.map(({ file, title, w, h }) => ({ file, title, w, h })),
      players: PLAYERS.map(({ id, label, color }) => ({ id, label, color })),
      fixations: state.fixByImage,
      started: state.started,
      settings: { spreadPct: state.spreadPct, minDurationMs: state.minDurationMs },
    });
  }

  if (bus) {
    bus.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "hello") broadcastSnapshot();
      else if (m.type === "cmd") {
        if (m.cmd === "next") changeImage(1);
        if (m.cmd === "prev") changeImage(-1);
        if (m.cmd === "reset") resetImage();
      }
    };
  }

  let lastGazePost = 0;

  // ------------------------------------------------------------ p5 loop
  window.setup = function () {
    createCanvas(windowWidth, windowHeight);
    pixelDensity(1);
    loadImages();
  };

  window.windowResized = function () {
    resizeCanvas(windowWidth, windowHeight);
  };

  window.draw = function () {
    background(0);
    rect = imageRect();
    const img = state.images[state.index];
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
      // Gaze off the cartoon ends a fixation: the stats describe looking AT
      // the image, and a fixation must not straddle its edge.
      const closed = inside ? e.det.push(now, m.x, m.y) : e.det.flush();
      if (closed) recordFixation(pl, closed);

      // The observer's live trace uses the same measured position, so the
      // trace and the fixations drawn on top of it can never disagree.
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

    // A pointer that vanished (glasses off, tracking lost) closes its fixation.
    for (const [id, e] of detectors) {
      if (seen.has(id)) continue;
      const pl = playerFor(id);
      const f = e.det.flush();
      e.med.reset();
      if (f && pl) recordFixation(pl, f);
    }

    if (now - lastGazePost > 33) {         // ~30Hz is plenty for a trace
      lastGazePost = now;
      post({ type: "gaze", index: state.index, pts: live });
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
    // Player colour at the centre, so two targets can be told apart.
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
    // The LOCAL venv, never bridge/.venv: that one lives in the Google Drive
    // folder and can hang forever on import.
    const lines = neon.map((p) =>
      `<b>#</b> ${p.label}\n~/dev/medusa-bridge-venv/bin/python bridge/neon_bridge.py --port ${p.port} --address PHONE_IP`
    ).join("\n\n");
    box.innerHTML = `<b># each bridge must be pinned to ITS OWN phone with --address</b>\n<b># without it, every bridge grabs the first phone it finds — the same one</b>\n<b># easiest: double-click Start PetrifEye.command, which finds and pins each phone</b>\n\n${lines}`;
  }

  // WebGazer is one camera watching one face: at most one player on webcam.
  function renderSources(list) {
    const webcamTaken = list.some((p) => p.source === "webcam");
    $("ssSrcs").innerHTML = list.map((p) => {
      const camOpt = (p.source === "webcam" || !webcamTaken)
        ? `<option value="webcam"${p.source === "webcam" ? " selected" : ""}>webcam (WebGazer)</option>`
        : `<option value="webcam" disabled>webcam — taken by another player</option>`;
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
    // arrived": mapping needs the tags, which are on this very screen.
    const ready = list.filter((p) => p.streaming).length;
    $("ssBootState").innerHTML = list.map((p) => {
      let cls, txt;
      if (p.live) { cls = "live"; txt = "gaze mapped — ready"; }
      else if (p.streaming) {
        cls = "warn";
        txt = p.markers != null
          ? `${p.markers}/4 markers — ${p.markers >= 3 ? "nearly there, hold still" : "look at this screen"}`
          : "connected — look at this screen";
      } else { cls = p.state === "offline" ? "err" : "warn"; txt = p.detail || p.state; }
      return `<span style="color:${p.color}">${p.label}</span> · port ${p.port} — <span class="ss-state ${cls}">${txt}</span>`;
    }).join("<br>");
    const btn = $("ssStart");
    btn.disabled = ready === 0;
    btn.textContent = ready === 0 ? "waiting for bridges"
      : ready < list.length ? `start with ${ready} of ${list.length}` : "start";
  }

  // Only speaks when something needs attention — never sits on the cartoon.
  function renderStatus(list) {
    if (!state.started || state.simMode) { $("ssStatus").textContent = ""; return; }
    const issues = list.filter((p) => !p.live).map((p) =>
      `${p.label}: ${p.streaming && p.markers != null ? `${p.markers}/4 markers`
        : p.streaming ? "look at the screen" : "disconnected"}`);
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
    window.open("political-vision-observer.html", "pv-observer", "popup=yes,width=1280,height=800");
  }

  $("ssGear").onclick = toggleTuning;
  $("toggle-target").onchange = (e) => setTargetVisible(e.target.checked);
  $("toggle-assist").onchange = (e) => setAssist(e.target.checked);
  $("toggle-markers").onchange = (e) => setMarkers(e.target.checked);
  $("pvPrev").onclick = () => changeImage(-1);
  $("pvNext").onclick = () => changeImage(1);
  $("pvReset").onclick = resetImage;
  $("pvObserver").onclick = openObserver;
  $("ssObserverBoot").onclick = openObserver;

  $("slider-marker").oninput = (e) => {
    const applied = GazeAggregator.setMarkerSize(Number(e.target.value));
    if (applied) $("tv-marker").textContent = `${applied}px`;
  };
  window.addEventListener("markers-size", (e) => {
    $("tv-marker").textContent = `${e.detail.size}px`;
    $("slider-marker").value = e.detail.size;
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
    else if (k === "n") changeImage(1);
    else if (k === "p") changeImage(-1);
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

    // The camera preview would sit on top of the cartoon.
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
          { keys: "n / p", does: "next / previous cartoon" },
          { keys: "g", does: "gaze target on/off" },
          { keys: "o", does: "open observer screen" },
          { keys: "r", does: "reset this cartoon" },
        ], "political vision");
      }
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
  GazeAggregator.init({ players: PLAYERS });
  // Tags drawn during the boot card: each scene camera must see them before
  // any gaze can be mapped, so framing happens before START.
  if (window.Markers) Markers.show();
  if (new URLSearchParams(location.search).has("sim")) start(true);

  // Exposed for testing and the console.
  window.PoliticalVision = { state, changeImage, resetImage, imageRect: () => rect, detectors };
})();
