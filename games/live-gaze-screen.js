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
//
// SCREEN AND IMAGE ARE SEPARATE. The window's `slot` (URL) is the DISPLAY: it
// fixes the tags and the bridge registration, which must not change while the
// glasses are tracking it. The IMAGE it shows (state.img) can: when a visitor
// is done, the operator closes it (x) or moves on to the next unseen one (n),
// and its results are saved. Messages carry both — `slot` is the image the
// data belongs to, `display` the window that sent it.
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
  // The mouse needs no calibration; ?calib runs it anyway, for testing.
  const CALIB_IN_SIM = new URLSearchParams(location.search).has("calib");

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
    img: null,           // index of the image shown, null once this screen is done
    done: false,         // every image this display could show has been closed
    progress: [],        // the shared queue (LiveGazeStore.progress)
    calib: null,         // GazeTargetCalibration.Session while calibrating
    calibWaiting: false, // the first calibration, held until fullscreen has settled
    calibNote: null,     // { text, until } — result shown after it
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
    // Inside the frame line when there is one (Frame mode), with the same
    // black gap the viewport edge gets: the frame is found by its edges, and
    // a bright image right against the line would blur the inner one.
    const pad = 12 + (window.Markers && !state.simMode ? Markers.framePx : 0);
    const fullH = Math.min((W - 2 * pad) / aspect, H - 2 * pad);
    let h = fullH;

    // Only when tags are actually drawn: Frame mode turns them off.
    const tagsOn = window.Markers && Markers.tagsDrawn && !state.simMode;
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
  // This display's first image: its own (image N on screen N) unless that
  // one was already shown, then the next unseen one; if none, this screen is
  // done. A reloaded window gets back the image it was showing.
  async function loadImage() {
    const session = await LiveGazeStore.session();
    state.total = Math.max(1, session.count || 1);
    if (!session.count) {
      $("ssSub").innerHTML = `no images — ` +
        `<a href="live-gaze.html" style="color:#c98f8f">upload images first</a>`;
      updateTitle();
      return;
    }
    const idx = await LiveGazeStore.claim(SLOT, SLOT, await bridgeBoot());
    if (idx == null) { await finishScreen(); return; }
    await showImage(idx);
  }

  // Which run of the bridge served this page (null without a bridge): how
  // the shared queue tells a new session from a reload. See BOOT_ID.
  let bootId;
  async function bridgeBoot() {
    if (bootId !== undefined) return bootId;
    try {
      const r = await fetch("/markers/layout.json", { cache: "no-store" });
      bootId = r.ok ? ((await r.json()).boot ?? null) : null;
    } catch (_) { bootId = null; }
    return bootId;
  }

  async function showImage(idx) {
    const rec = await LiveGazeStore.get(idx);
    const loaded = rec && await LiveGazeStore.load(rec);
    state.img = idx;
    state.image = loaded ? { ...loaded, name: rec.name } : null;
    state.fixations = [];
    detectors.clear();
    state.done = false;
    updateTitle();
    broadcastSnapshot();
    refreshProgress();
  }

  function updateTitle() {
    const name = state.image ? state.image.name : "no image";
    const n = state.img != null ? state.img + 1 : "—";
    $("lgTitle").textContent = state.done ? "this screen is done" : `${n} / ${state.total} — ${name}`;
    $("lgTags").textContent = `tags ${INFO.ids.join(" · ")} · bridge screen "${INFO.key}"`;
    $("ssSub").innerHTML = state.image
      ? `image <b class="lg-slot">${n}</b> of ${state.total} — ${name}`
      : $("ssSub").innerHTML;
    $("ssWhich").textContent = `screen ${SLOT + 1}`;
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
    // A reset is how a new visitor starts — and a new visitor needs their own
    // calibration, not the previous wearer's.
    if (state.started && (!state.simMode || CALIB_IN_SIM)) startCalibration("full");
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
  function post(msg) {
    if (bus) bus.postMessage({ ...msg, slot: state.img == null ? -1 : state.img, display: SLOT });
  }

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
      done: state.done,
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
      if (m.type === "progress") { state.progress = m.images || []; renderProgress(); return; }
      if (m.type === "analysis-saved") { const r = ackWaiters.get(m.slot); if (r) r(m); return; }
      if (m.type === "markerSize" && m.display !== SLOT) {
        applyingRemote = true;
        const applied = GazeAggregator.setMarkerSize(m.size);
        if (applied) { $("tv-marker").textContent = `${applied}px`; $("slider-marker").value = applied; }
        applyingRemote = false;
        return;
      }
      // Starting one screen starts them all: with three projectors up, walking
      // to each window to press start is exactly when visitors are waiting.
      if (m.type === "start" && m.display !== SLOT && !state.started) { start(false); return; }
      if (m.type === "new-run" && m.display !== SLOT && state.started) { beginRun(false); return; }
      // A calibration done on another screen: a starting point for players
      // who have not calibrated on this one (see adopt()).
      if (m.type === "calib" && m.display !== SLOT && Array.isArray(m.offsets)) {
        for (const o of m.offsets) GazeTargetCalibration.adopt(o.id, o);
        renderCalibInfo();
        return;
      }
      // From an analysis window: addressed to its display, or to the image.
      if (m.type === "cmd" && (m.display === SLOT || (m.display == null && m.slot === state.img))) {
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

    const now = performance.now();
    if (state.done || state.img == null) {
      background(0);
      const over = showOver();
      drawCaption(over ? "all images have been seen — thank you" : "this screen is done");
      if (over) drawCaption("next visitors: press space to start again", 1);
      if (state.calibNote && now < state.calibNote.until) drawCaption(state.calibNote.text, over ? 2 : 1);
      return;
    }
    if (state.calib) { drawCalibration(now); return; }
    if (state.calibWaiting) { background(0); drawCaption("calibration starting — look at the screen"); return; }

    retuneDetectors();                   // rect may have changed size
    // Corrected by this visitor's calibration — x/y AND rawX/rawY, since the
    // measurement below reads the raw position. The tracker's own reading
    // stays on each pointer as uncalX/uncalY.
    const pointers = GazeTargetCalibration.apply(Tracking.update());
    const seen = new Set();
    const live = [];

    for (const ptr of pointers) {

      // A held pointer is a frozen last-known position, not a measurement — the
      // samples stopped arriving (see shared/tracking.js). Feeding it to the
      // fixation detector would manufacture a long, perfectly still fixation out
      // of a Wi-Fi stall. Treated as absent instead, which closes the fixation
      // that was in progress, exactly as a real loss of tracking should.

      if (ptr.held) continue;
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
    if (state.calibNote && now < state.calibNote.until) drawCaption(state.calibNote.text);
  };

  // --------------------------------------------------------- calibration
  // Five eyes inside the image area — the centre and four towards its corners
  // — where the analysis happens, and clear of the tags. Image hidden while
  // it runs: nothing seen during calibration is data.
  function calibrationTargets(mode) {
    const r = rect;
    const at = (fx, fy) => ({ x: r.x + fx * r.w, y: r.y + fy * r.h });
    if (mode === "check") return [at(0.5, 0.5)];
    return [at(0.5, 0.5), at(0.2, 0.2), at(0.8, 0.2), at(0.8, 0.8), at(0.2, 0.8)];
  }

  function startCalibration(mode = "full") {
    if (!state.started) return;
    state.calibWaiting = false;
    rect = imageRect();
    flushAll();                // close fixations in progress: what follows isn't data
    detectors.clear();         // their filters hold uncorrected positions
    const targets = calibrationTargets(mode);
    // How far settled gaze may be from a target and still count: must exceed
    // the bias being measured (Neon: up to ~100 px), and stay well under the
    // spacing between targets so the wrong one is never credited.
    const spacing = Math.min(0.6 * rect.w, 0.6 * rect.h, Math.hypot(0.3 * rect.w, 0.3 * rect.h));
    const radius = Math.max(60, Math.min(220, 0.45 * spacing));
    state.calibNote = null;
    state.calib = new GazeTargetCalibration.Session({
      targets, radius, areaW: rect.w, mode,
      onDone: (summary) => finishCalibration(mode, summary),
    });
    post({ type: "calibrating", mode });
  }

  function finishCalibration(mode, summary) {
    state.calib = null;
    detectors.clear();
    const name = (id) => (playerFor(id) || { label: id }).label;
    const parts = summary.map((r) => {
      if (!r.ok) return `${name(r.id)}: not calibrated${r.tooBig ? ` (off by ${r.tooBig}px)` : ""} — press c to retry`;
      if (mode === "check") {
        return `${name(r.id)}: checked${r.drift != null ? `, drift ${Math.round(r.drift)}px corrected halfway` : ""}`;
      }
      return `${name(r.id)}: calibrated · ${r.n}/5 eyes · consistency ±${Math.round(r.spread)}px`;
    });
    state.calibNote = { text: parts.join("    ") || "nobody looked at this screen — not calibrated here", until: performance.now() + 3500 };
    const mine = GazeTargetCalibration.all().filter((o) => o.here);
    if (mine.length) post({ type: "calib", offsets: mine });
    renderCalibInfo();
  }

  function drawCalibration(now) {
    background(0);            // the image is hidden while calibrating
    const s = state.calib;
    const ptrs = Tracking.update().filter((p) => !p.held && playerFor(p.id));
    s.update(now, ptrs);
    s.draw(drawingContext, now);
    if (!state.calib) return;  // finished during update
    const n = s.targets.length;
    drawCaption(s.mode === "check"
      ? "quick check — look at the eye"
      : `look at each eye until it turns to stone · ${Math.min(s.i + 1, n)} / ${n}`);
  }

  function drawCaption(text, line = 0) {
    const ctx = drawingContext;
    ctx.save();
    ctx.font = "15px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(232, 230, 226, 0.85)";
    const y = state.done || state.img == null ? height / 2 - 10 : Math.max(28, rect.y - 14);
    ctx.fillText(text, width / 2, y + line * 26);
    ctx.restore();
  }

  // --------------------------------------------- closing an image / next
  // n: close this image and show the next unseen one. x: close it and end
  // this screen. When nothing unseen is left, closing is the only option.
  // Keys need a second press within 2 s — a stray key must not end an image.
  const ackWaiters = new Map();     // image index -> resolve(analysis-saved)
  let closing = false;
  let armed = null;                 // { key, until }

  const unseen = () => state.progress.filter((p) => p.status === "queued").length;

  async function refreshProgress() {
    try { state.progress = await LiveGazeStore.progress(); } catch (_) {}
    renderProgress();
  }

  function renderProgress() {
    const left = unseen();
    $("lgNext").disabled = state.done || state.img == null || left === 0;
    $("lgClose").disabled = state.done || state.img == null;
    $("lgQueue").textContent = state.done ? "all done on this screen"
      : left ? `${left} image${left === 1 ? "" : "s"} not yet seen` : "no unseen images left — close when done";
  }

  function note(text, ms = 2500) { state.calibNote = { text, until: performance.now() + ms }; }

  function confirmKey(key, label, action) {
    const now = performance.now();
    if (armed && armed.key === key && now < armed.until) { armed = null; action(); return; }
    armed = { key, until: now + 2000 };
    note(`press ${key} again to ${label}`, 2000);
  }

  async function closeImage(goNext) {
    if (closing || state.img == null || state.calib) return;
    if (goNext && !unseen()) { note("no more images to show — press x to close this one"); return; }
    closing = true;
    try {
      flushAll();
      const idx = state.img;
      const image = state.image;
      const fixations = state.fixations.slice();
      const players = PLAYERS.map(({ id, label, color }) => ({ id, label, color }));
      // The analysis window renders and saves its panels from this.
      post({ type: "image-closed", fixations, players, total: state.total,
             image: image ? { name: image.name, w: image.w, h: image.h } : null });
      // The run's folder, read BEFORE closing: the save waits up to 3 s for
      // the analysis window, and a new run started meanwhile (space, once
      // this was the last image) must not take this image's results with it.
      const stamp = await LiveGazeStore.runStamp();
      await LiveGazeStore.close(idx);
      const saving = saveResults(idx, image, fixations, players, stamp);
      const next = goNext ? await LiveGazeStore.claim(SLOT, null, await bridgeBoot()) : null;
      if (next != null) {
        await showImage(next);
        note(`image ${idx + 1} closed — now image ${next + 1}`);
      } else {
        await finishScreen();
      }
      const where = await saving;
      note(`image ${idx + 1} saved to ${where}`, 6000);
    } finally {
      closing = false;
    }
  }

  async function finishScreen() {
    state.done = true;
    state.img = null;
    state.image = null;
    state.fixations = [];
    detectors.clear();
    await refreshProgress();
    updateTitle();
    broadcastSnapshot();
  }

  // ------------------------------------------------------------ new run
  // Every image has been closed: the show is over, and starting it again
  // must not need the app relaunched (which is what a new run used to take —
  // see BOOT_ID). Space on any screen starts a NEW RUN of the same images:
  // the queue starts over, unseen, in a new results folder; every screen
  // takes its image again and calibrates the new visitors. Bridges, glasses
  // and fullscreen stay as they are.
  //
  // Not automatic on a timer: a calibration that starts while nobody is
  // wearing the glasses gives up after the first eye and shows the image,
  // recording whoever wanders past, uncalibrated, as data.
  const showOver = () => state.progress.length > 0 && state.progress.every((p) => p.status === "closed");

  async function newRun() {
    if (!showOver()) return;
    if (closing) { note("still saving the last image — press space again in a moment"); return; }
    await LiveGazeStore.resetProgress();
    post({ type: "new-run" });
    beginRun(true);
  }

  async function beginRun(fromKey) {
    if (!state.done) return;
    // New visitors: nobody's correction carries over, on any screen.
    GazeTargetCalibration.clear();
    renderCalibInfo();
    state.calibNote = null;
    const idx = await LiveGazeStore.claim(SLOT, SLOT, await bridgeBoot());
    if (idx == null) { await finishScreen(); return; }
    await showImage(idx);
    // Only the screen where space was pressed can go fullscreen again (it
    // has the key press); the others are still fullscreen, or stay as they are.
    beginVisitors(fromKey ? goFullscreen() : Promise.resolve());
  }

  // Data always comes from here; the analysis picture from the analysis
  // window when one is open (it has the drawing), otherwise a plain scanpath
  // picture drawn here, so a closed image never ends up with no picture.
  async function saveResults(idx, image, fixations, players, stamp) {
    const name = image ? image.name : `image ${idx + 1}`;
    const W = image ? image.w : 1, H = image ? image.h : 1;
    const rows = ["player,label,order,u,v,x_px,y_px,start_ms,duration_ms"];
    const order = new Map();
    for (const f of fixations) {
      const k = (order.get(f.p) || 0) + 1; order.set(f.p, k);
      const pl = players.find((p) => p.id === f.p) || { label: `P${f.p + 1}` };
      rows.push([f.p, pl.label, k, f.u.toFixed(5), f.v.toFixed(5),
                 Math.round(f.u * W), Math.round(f.v * H), f.start, f.dur].join(","));
    }
    const results = {
      image: { index: idx, name, w: W, h: H },
      display: SLOT, closedAt: new Date().toISOString(),
      players, settings: { spreadPct: state.spreadPct, minDurationMs: state.minDurationMs },
      calibration: GazeTargetCalibration.all(),
      coordinates: "u,v are 0..1 across the image; x_px,y_px are in the image's own pixels",
      fixations,
    };
    const files = [
      { name: "fixations.csv", blob: new Blob([rows.join("\n") + "\n"], { type: "text/csv" }) },
      { name: "results.json", blob: new Blob([JSON.stringify(results, null, 2)], { type: "application/json" }) },
    ];
    // Wait briefly for an analysis window to say it saved its picture.
    const ack = await new Promise((resolve) => {
      const timer = setTimeout(() => { ackWaiters.delete(idx); resolve(null); }, 3000);
      ackWaiters.set(idx, (m) => { clearTimeout(timer); ackWaiters.delete(idx); resolve(m); });
    });
    if (!ack && image && image.el) {
      const png = await scanpathPicture(image, fixations, players);
      if (png) files.push({ name: "scanpath.png", blob: png });
    }
    const res = await LiveGazeStore.saveResults(idx, name, files, stamp);
    return res.where;
  }

  function scanpathPicture(image, fixations, players) {
    const scale = Math.min(1, 1600 / Math.max(image.w, image.h));
    const c = document.createElement("canvas");
    c.width = Math.round(image.w * scale); c.height = Math.round(image.h * scale);
    const ctx = c.getContext("2d");
    ctx.drawImage(image.el, 0, 0, c.width, c.height);
    ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fillRect(0, 0, c.width, c.height);
    for (const pl of players) {
      const fs = fixations.filter((f) => f.p === pl.id);
      ctx.strokeStyle = pl.color; ctx.fillStyle = pl.color; ctx.lineWidth = 2;
      ctx.beginPath();
      fs.forEach((f, i) => { const x = f.u * c.width, y = f.v * c.height; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      fs.forEach((f) => {
        ctx.globalAlpha = 0.55;
        ctx.beginPath(); ctx.arc(f.u * c.width, f.v * c.height, 4 + Math.sqrt(f.dur) * 0.6, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      });
    }
    return new Promise((resolve) => c.toBlob(resolve, "image/png"));
  }

  function renderCalibInfo() {
    const all = GazeTargetCalibration.all();
    $("lgCalibInfo").textContent = all.length
      ? all.map((o) => `${(playerFor(o.id) || { label: o.id }).label} ${Math.round(o.x)},${Math.round(o.y)}px` +
          `${o.here ? ` ±${Math.round(o.spread || 0)}` : " (from another screen)"}`).join(" · ")
      : "not calibrated";
  }

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

  // The analysis window follows this DISPLAY: when it moves on to the next
  // image, its analysis window does too (after saving the closed one).
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
  $("lgCalib").onclick = () => { if (!state.calib) startCalibration("full"); };
  $("lgNext").onclick = () => closeImage(true);
  $("lgClose").onclick = () => closeImage(false);
  $("lgCheck").onclick = () => { if (!state.calib) startCalibration("check"); };

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
    else if (k === "n") confirmKey("n", "close this image and show the next", () => closeImage(true));
    else if (k === "x") confirmKey("x", "close this image", () => closeImage(false));
    else if (k === "c" && !state.calib) startCalibration("full");
    else if (k === "v" && !state.calib) startCalibration("check");
    else if (k === " " && state.done) { e.preventDefault(); newRun(); }
  });

  let lastList = PLAYERS.map((p) => ({ ...p, state: "connecting", live: false }));
  window.addEventListener("gaze-players", (e) => {
    lastList = e.detail;
    if (state.started) renderStatus(lastList);
    else { renderSources(lastList); renderBootState(lastList); renderBootCmd(); }
  });

  // ------------------------------------------------------------- start
  // Resolves once the viewport is final AND the bridges have had time to
  // rebuild their surface for it. Entering fullscreen resizes the viewport;
  // the new size reaches each bridge only after the aggregator's debounce
  // (fullscreenchange + 120 ms, resize + 250 ms), and the rebuilt surface
  // maps nothing until its first solve. Calibrating inside that window laid
  // the targets out for the old viewport and measured them through a
  // mapping scaled for it — the first calibration was off, a later one not.
  const VIEWPORT_SETTLE_MS = 700;
  const FULLSCREEN_WAIT_MS = 2000;   // a request that never completes
  function goFullscreen() {
    return new Promise((resolve) => {
      const settle = () => setTimeout(resolve, VIEWPORT_SETTLE_MS);
      if (document.fullscreenElement || !document.documentElement.requestFullscreen) { resolve(); return; }
      let done = false;
      const once = () => { if (done) return; done = true; settle(); };
      document.addEventListener("fullscreenchange", once, { once: true });
      setTimeout(once, FULLSCREEN_WAIT_MS);
      try {
        const p = document.documentElement.requestFullscreen();
        if (p && p.catch) p.catch(() => { if (!done) { done = true; resolve(); } });
      } catch (_) { done = true; resolve(); }
    });
  }

  function start(sim) {
    if (state.started) return;
    state.started = true;
    state.simMode = !!sim;
    const viewportReady = goFullscreen();
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
          { keys: "c / v", does: "calibrate / quick check" },
          { keys: "n / x", does: "next image / close image (press twice)" },
          { keys: "space", does: "start again, once every image is closed" },
        ], `live gaze · image ${SLOT + 1}`);
      }
    } else {
      // Real start only: a mouse test on one screen must not pull the other
      // screens out of their boot card, where their tags are still being framed.
      post({ type: "start" });
    }
    renderStatus(lastList);
    broadcastSnapshot();
    // Every visitor starts with their own calibration. Each screen runs it
    // for whoever is looking at it; a screen nobody looks at gives up after
    // the first eye and shows its image. Held until fullscreen has settled
    // (see goFullscreen); the screen stays black meanwhile, so nothing seen
    // before the calibration is recorded as data.
    beginVisitors(viewportReady);
  }

  function beginVisitors(viewportReady) {
    if (state.simMode && !CALIB_IN_SIM) return;
    state.calibWaiting = true;
    viewportReady.then(() => { if (state.calibWaiting && !state.calib) startCalibration("full"); });
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
  window.LiveGazeScreen = { state, slot: SLOT, info: INFO, resetImage, imageRect: () => rect, detectors,
                            startCalibration, closeImage };
})();
