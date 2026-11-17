// LIVE GAZE — the overview: every image in its own quadrant, on one monitor.
//
// Made for an exhibition of PRINTED images: sheets on easels, two visitors
// wearing glasses, walking between them as in a museum — any order, back
// again, as long as they like. This one window does all of it:
//
//   - It REGISTERS every printed sheet with both bridges, exactly as frozen
//     in the saved exhibition (exhibition/exhibition.json), and records each
//     visitor's gaze on whichever sheet they are looking at. Recording runs
//     in the socket handlers, not in the drawing loop, so it keeps measuring
//     even when the browser stops painting this window.
//   - It shows each image in a quadrant with both visitors' live scanpaths.
//   - It wears its OWN four tags (LiveGazeStore.MONITOR), so the glasses can
//     find this monitor too: a visitor finishes by looking at the dot on the
//     right for 3 seconds. Glancing at it does nothing; the ring fills only
//     while the gaze stays on it. The operator can also finish a visitor
//     (1 1 / 2 2) or the whole session (e e).
//   - When every visitor has finished, the quadrants freeze and a pop-up asks
//     whether to print the scanpaths; heatmaps and fixation statistics are
//     produced when asked for (live-gaze-report.js).
//
// Images shown ON SCREENS (the other medium) still have their own screen
// windows; their gaze reaches this window over the BroadcastChannel, already
// in image coordinates, and lands in their quadrants the same way.
(function () {
  // Colour-blind safe (Okabe & Ito): orange and sky blue stay apart for
  // every common colour-vision deficiency, on the images and on paper.
  const PLAYERS = [
    { id: 0, label: "P1", port: 8443, color: "#E69F00", name: "orange" },
    { id: 1, label: "P2", port: 8444, color: "#56B4E9", name: "blue" },
  ];
  const MON = LiveGazeStore.MONITOR;
  const SETUP = SessionSetup.remembered("live-gaze");
  const params = new URLSearchParams(location.search);
  // ?mock: a TEST PRINT (from the test prints page) — a made-up finished
  // session (live-gaze-mock.js), straight to the pop-up. No bridges, nothing saved.
  const MOCK = params.has("mock");

  const FINISH_MS = 3000;     // gaze held on the dot
  const FINISH_GRACE_MS = 400; // a blink or a dropped sample does not reset it
  const STALE_MS = 250;       // no sample this long: the look has ended
  const TRAIL_MS = 1500;      // raw gaze trace behind each live marker
  const SPREAD = 0.035;       // fixation dispersion, share of image width (as on screens)
  const MIN_FIX_MS = 100;
  const SCANPATH_SHOWN = 30;  // most recent fixations drawn per visitor per image
  const NUMBERED = 12;

  const $ = (id) => document.getElementById(id);
  const bus = "BroadcastChannel" in window ? new BroadcastChannel(LiveGazeStore.CHANNEL) : null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const S = {
    images: [],        // { slot, name, w, h, medium, el, sheet, problem, cache }
    exhibition: null,
    phase: "loading",  // loading | idle | running | ended
    t0: 0, startedAt: 0, endedAt: 0,
    fix: [],           // { p, slot, u, v, dur, start (ms from start), visit }
    live: new Map(),   // p -> { slot, u, v, fu, fv, fd, at, trail }
    mon: new Map(),    // p -> { x, y, at } gaze on this monitor
    visitors: PLAYERS.map((p) => ({ id: p.id, in: false, finishedAt: null, by: null, dwellFrom: 0, lastIn: 0 })),
    sim: params.has("sim"),
    saved: null,
  };
  const detectors = new Map();   // p -> { slot, med, det, lastAt }
  const vis = (id) => S.visitors[id];
  const playerOf = (id) => PLAYERS[id];
  const now = () => performance.now();

  // ------------------------------------------------------------- layout
  let L = null;
  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const ui = clamp(Math.min(W, H) / 1000, 0.75, 1.7);
    document.documentElement.style.setProperty("--ui", String(ui));
    // The monitor's tags: big enough to be read from where the visitors stand
    // when they come to finish (a 1080p TV: ~170 px tags, ~11 cm on 55").
    const T = clamp(Math.round(Math.min(W, H) * 0.16), 110, 300);
    const M = 14;
    const F = M + T + 18;                       // side strips
    const gap = Math.round(16 * ui);
    const cap = Math.round(46 * ui);            // caption under each image
    const grid = { x: F, y: gap, w: W - 2 * F, h: H - 2 * gap };
    const cells = bestGrid(S.images, grid, gap, cap);
    const stripTop = M + T + 18, stripBottom = H - M - T - 18;
    const r = clamp(Math.round(F * 0.2), 24, 64);
    L = {
      W, H, ui, T, M, F, gap, cap, cells,
      finish: { cx: W - F / 2, cy: H / 2, r, hit: Math.min(F * 0.5, r * 2.3) },
      strip: { top: stripTop, bottom: stripBottom },
    };
    placeChrome();
    return L;
  }

  // As many columns as make the SMALLEST image biggest.
  function bestGrid(images, g, gap, cap) {
    const n = images.length;
    if (!n) return [];
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cw = (g.w - gap * (cols - 1)) / cols, ch = (g.h - gap * (rows - 1)) / rows;
      if (cw < 40 || ch - cap < 40) continue;
      let smallest = Infinity;
      for (const im of images) {
        const a = im.w / im.h || 1.5;
        const w = Math.min(cw, (ch - cap) * a);
        smallest = Math.min(smallest, w * (w / a));
      }
      if (!best || smallest > best.smallest) best = { cols, rows, cw, ch, smallest };
    }
    if (!best) best = { cols: 1, rows: n, cw: g.w, ch: g.h / n };
    return images.map((im, i) => {
      const col = i % best.cols, row = Math.floor(i / best.cols);
      // The last row is centred when it is not full.
      const inRow = row === best.rows - 1 ? n - row * best.cols : best.cols;
      const x0 = g.x + (g.w - (inRow * best.cw + (inRow - 1) * gap)) / 2;
      const cell = { x: x0 + col * (best.cw + gap), y: g.y + row * (best.ch + gap), w: best.cw, h: best.ch };
      const a = im.w / im.h || 1.5;
      let w = cell.w, h = w / a;
      if (h > cell.h - cap) { h = cell.h - cap; w = h * a; }
      const img = { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - cap - h) / 2, w, h };
      return { cell, img };
    });
  }

  function placeChrome() {
    const { W, H, T, M, F } = L;
    const tags = $("tags");
    if (!tags.children.length) {
      MON.ids.forEach((id) => {
        const img = new Image();
        img.src = `/markers/${id}.png`;
        img.alt = "";
        tags.appendChild(img);
      });
    }
    const pos = [[M, M], [W - M - T, M], [W - M - T, H - M - T], [M, H - M - T]];
    [...tags.children].forEach((img, k) => {
      Object.assign(img.style, { left: `${pos[k][0]}px`, top: `${pos[k][1]}px`, width: `${T}px`, height: `${T}px` });
    });
    Object.assign($("left").style, { left: "0px", width: `${F}px`, top: `${L.strip.top}px`,
                                     height: `${L.strip.bottom - L.strip.top}px` });
    const f = L.finish, size = f.hit * 2 + 8;
    const svg = $("finishSvg");
    svg.setAttribute("width", size); svg.setAttribute("height", size);
    svg.setAttribute("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`);
    Object.assign(svg.style, { left: `${f.cx - size / 2}px`, top: `${f.cy - size / 2}px` });
    Object.assign($("finTop").style, { left: `${W - F}px`, width: `${F}px`, bottom: `${H - (f.cy - size / 2) + 6}px` });
    Object.assign($("finBottom").style, { left: `${W - F}px`, width: `${F}px`, top: `${f.cy + size / 2 + 6}px` });
    const ring = (rad, i) => {
      const c = 2 * Math.PI * rad;
      return `<circle r="${rad}" fill="none" stroke="#23262e" stroke-width="${6 * L.ui}" />` +
        `<circle id="ring${i}" r="${rad}" fill="none" stroke="${PLAYERS[i].color}" stroke-width="${6 * L.ui}"
           stroke-linecap="round" stroke-dasharray="0 ${c}" transform="rotate(-90)" data-c="${c}" />`;
    };
    svg.innerHTML =
      `<circle r="${f.hit}" fill="rgba(232,230,226,.035)" stroke="rgba(232,230,226,.12)" stroke-dasharray="3 6" />` +
      ring(f.r + 12 * L.ui, 0) + ring(f.r + 22 * L.ui, 1) +
      `<circle r="${f.r * 0.62}" fill="#e8e6e2" />` +
      `<circle id="monDot0" r="${7 * L.ui}" fill="${PLAYERS[0].color}" stroke="#000" stroke-width="2" visibility="hidden" />` +
      `<circle id="monDot1" r="${7 * L.ui}" fill="${PLAYERS[1].color}" stroke="#000" stroke-width="2" visibility="hidden" />`;
  }

  // The monitor as a surface: its size and its tags' own size and inset, so
  // nothing about it depends on any other window or on the global tag slider.
  function monitorScreen() {
    return { key: MON.key, ids: MON.ids, surface: { w: L.W, h: L.H, marker: { size: L.T, margin: L.M } } };
  }
  function sheetScreens() {
    return S.images.filter((im) => im.sheet).map((im) => ({
      key: im.sheet.key, ids: im.sheet.ids,
      surface: { w: im.sheet.layout.w, h: im.sheet.layout.h,
                 marker: { size: im.sheet.layout.size, margin: im.sheet.layout.margin } },
    }));
  }

  // ------------------------------------------------------------ loading
  async function load() {
    const [recs, ex] = await Promise.all([LiveGazeStore.all(), LiveGazeStore.exhibition()]);
    S.exhibition = ex;
    for (const r of recs) {
      const im = { slot: r.slot, name: r.name, w: r.w, h: r.h, medium: r.medium || "screen",
                   el: null, sheet: null, problem: null, cache: null };
      const loaded = await LiveGazeStore.load(r);
      if (loaded) im.el = loaded.el;
      if (im.medium === "print") {
        const s = ex && ex.sheets.find((x) => x.slot === r.slot);
        if (SETUP.surface === "frame") {
          im.problem = "printed, but the purple frame cannot find paper — choose the AprilTags";
        } else if (!s) {
          im.problem = "printed, but not in the saved exhibition — print its sheet from the upload page";
        } else if (s.sha256 !== (r.sha256 || await LiveGazeStore.sha256(r.blob))) {
          im.problem = `not the image printed on sheet ${r.slot + 1} — print it again, or load the saved exhibition`;
        } else {
          im.sheet = s;
        }
      }
      S.images.push(im);
    }
  }

  // ------------------------------------------------------------ measuring
  function entry(p) {
    let e = detectors.get(p);
    if (!e) {
      e = { slot: null, med: new MedianFilter2D(5),
            det: new FixationDetector({ dispersionPx: 50, minDurationMs: MIN_FIX_MS }), lastAt: 0 };
      detectors.set(p, e);
    }
    return e;
  }

  function closeFix(p, e) {
    const f = e.det.flush();
    if (f && e.slot != null) record(p, e.slot, f);
  }

  function record(p, slot, f) {
    const im = S.images[slot];
    if (!im) return;
    const u = f.x / im.w, v = f.y / im.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    addFixation({ p, slot, u, v, dur: Math.round(f.duration), start: Math.round(f.start - S.t0) });
  }

  // A visit is a run of consecutive fixations on one image: looking at
  // another image ends it, a glance at the floor does not.
  function addFixation(fx) {
    let prev = null;
    for (let i = S.fix.length - 1; i >= 0; i--) if (S.fix[i].p === fx.p) { prev = S.fix[i]; break; }
    fx.visit = prev ? (prev.slot === fx.slot ? prev.visit : prev.visit + 1) : 1;
    S.fix.push(fx);
  }

  const accepting = (p) => S.phase === "running" && vis(p) && vis(p).finishedAt == null;

  // Gaze on an image, in 0..1 across it (u, v). Sheets, screens and the
  // mouse stand-in all arrive here.
  function imageSample(p, slot, u, v) {
    if (!accepting(p)) return;
    const im = S.images[slot];
    if (!im) return;
    vis(p).in = true;
    const t = now();
    const e = entry(p);
    if (e.slot !== slot) {
      closeFix(p, e);
      e.med.reset();
      e.slot = slot;
      // In the image's own pixels, like every screen measures it.
      e.det.dispersionPx = Math.max(4, SPREAD * im.w);
    }
    e.lastAt = t;
    const m = e.med.push(u * im.w, v * im.h);
    const inside = m.x >= 0 && m.x <= im.w && m.y >= 0 && m.y <= im.h;
    // Gaze off the image (on the passe-partout) ends a fixation.
    const closed = inside ? e.det.push(t, m.x, m.y) : e.det.flush();
    if (closed) record(p, slot, closed);
    const cur = inside ? e.det.current() : null;
    const prev = S.live.get(p);
    const trail = (prev && prev.slot === slot ? prev.trail : []).filter((q) => t - q.at < TRAIL_MS);
    trail.push({ u: m.x / im.w, v: m.y / im.h, at: t });
    S.live.set(p, { slot, u: m.x / im.w, v: m.y / im.h, at: t, trail,
                    fu: cur ? cur.x / im.w : null, fv: cur ? cur.y / im.h : null, fd: cur ? cur.duration : 0 });
  }

  // A look that stopped (turned away, between easels, tracking lost) closes
  // its fixation instead of leaving it open across the gap.
  setInterval(() => {
    const t = now();
    for (const [p, e] of detectors) {
      if (e.slot != null && t - e.lastAt > STALE_MS) {
        closeFix(p, e);
        e.med.reset();
        e.slot = null;
      }
    }
  }, 100);

  // Gaze on this monitor, in its CSS pixels: only the finish dot cares.
  function monitorSample(p, x, y) {
    if (S.phase !== "running") return;
    const v = vis(p);
    if (!v || v.finishedAt != null) return;
    v.in = true;
    const t = now();
    S.mon.set(p, { x, y, at: t });
    const f = L.finish;
    if (Math.hypot(x - f.cx, y - f.cy) <= f.hit) {
      if (!v.dwellFrom || t - v.lastIn > FINISH_GRACE_MS) v.dwellFrom = t;
      v.lastIn = t;
      if (t - v.dwellFrom >= FINISH_MS) finishVisitor(p, "looked at the dot");
    }
  }

  // From the bridges: sheet units (0.1 mm) on a sheet, CSS px on the monitor.
  function onSample(p, key, x, y) {
    if (key === MON.key) { monitorSample(p, x, y); return; }
    const im = S.images.find((i) => i.sheet && i.sheet.key === key);
    if (!im) return;
    const r = im.sheet.layout.image;
    imageSample(p, im.slot, (x - r.x) / r.w, (y - r.y) / r.h);
  }

  // Images on screens: their screen windows measure, in image coordinates.
  if (bus) {
    bus.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "images-changed") {
        if (S.phase === "running") note("the images were changed on the upload page — finish this session, then reload");
        else location.reload();
        return;
      }
      const im = S.images[m.slot];
      if (!im || im.medium === "print") return;
      if (m.type === "gaze" && Array.isArray(m.pts)) {
        const t = now();
        for (const q of m.pts) {
          if (!accepting(q.p)) continue;
          vis(q.p).in = true;
          const prev = S.live.get(q.p);
          const trail = (prev && prev.slot === m.slot ? prev.trail : []).filter((z) => t - z.at < TRAIL_MS);
          trail.push({ u: q.u, v: q.v, at: t });
          S.live.set(q.p, { slot: m.slot, u: q.u, v: q.v, at: t, trail, fu: q.fu, fv: q.fv, fd: q.fd || 0 });
        }
      } else if (m.type === "fixation" && m.fix && accepting(m.fix.p)) {
        const f = m.fix;
        addFixation({ p: f.p, slot: m.slot, u: f.u, v: f.v, dur: f.dur,
                      start: Math.round(now() - S.t0 - f.dur) });
      }
    };
  }

  // ------------------------------------------------------- the session
  function startSession() {
    if (S.phase !== "idle") return;
    chime(true);                       // unlocks audio with the operator's gesture
    S.phase = "running";
    S.t0 = now();
    S.startedAt = Date.now();
    S.fix = [];
    S.live.clear();
    S.mon.clear();
    detectors.clear();
    // Who takes part: glasses streaming now, or anyone whose gaze arrives
    // later. With the mouse stand-in, both (mouse, and shift+mouse).
    const snap = GazeAggregator.players();
    S.visitors.forEach((v) => {
      Object.assign(v, { in: S.sim || !!(snap.find((p) => p.id === v.id) || {}).streaming,
                         finishedAt: null, by: null, dwellFrom: 0, lastIn: 0 });
    });
    $("startCard").classList.add("hidden");
    // Screens showing images start with this.
    if (bus) bus.postMessage({ type: "start", slot: -1, display: -1 });
    renderSide();
  }

  function finishVisitor(p, by) {
    const v = vis(p);
    if (!v || v.finishedAt != null || S.phase !== "running") return;
    const e = detectors.get(p);
    if (e) { closeFix(p, e); e.med.reset(); e.slot = null; }
    S.live.delete(p);
    S.mon.delete(p);
    v.finishedAt = Math.round(now() - S.t0);
    v.by = by;
    v.dwellFrom = 0;
    chime();
    note(`${playerOf(p).label} (${playerOf(p).name}) has finished — thank you`);
    renderSide();
    const inside = S.visitors.filter((x) => x.in);
    if (inside.length && inside.every((x) => x.finishedAt != null)) endSession();
  }

  async function endSession() {
    if (S.phase !== "running") return;
    for (const [p, e] of detectors) { closeFix(p, e); e.slot = null; }
    const at = Math.round(now() - S.t0);
    S.visitors.forEach((v) => { if (v.in && v.finishedAt == null) { v.finishedAt = at; v.by = "ended by the operator"; } });
    S.phase = "ended";
    S.endedAt = Date.now();
    S.live.clear();
    S.mon.clear();
    renderSide();
    openModal("scanpaths");
    fillPrintSheet(["scanpaths"]).catch(() => {});
    if (SETUP.collect) {
      try {
        S.saved = await save();
        renderSummary();
      } catch (err) {
        S.saved = { error: String(err && err.message || err) };
        renderSummary();
      }
    }
  }

  function newSession() {
    if (S.phase !== "ended") return;
    if (MOCK) { location.reload(); return; }
    closeModal();
    S.phase = "idle";
    S.fix = [];
    S.saved = null;
    S.visitors.forEach((v) => Object.assign(v, { in: false, finishedAt: null, by: null, dwellFrom: 0, lastIn: 0 }));
    report.cache.clear();
    renderStartCard();
    renderSide();
  }

  // ------------------------------------------------------------- saving
  function session() {
    return {
      images: S.images, players: PLAYERS, fix: S.fix, visitors: S.visitors,
      startedAt: S.startedAt, endedAt: S.endedAt, test: MOCK,
    };
  }

  async function save() {
    const stamp = LiveGazeStore.sessionStamp(S.startedAt);
    const ses = session();
    const rows = ["player,label,image,slot,name,visit,order_on_image,u,v,x_px,y_px,start_ms,duration_ms"];
    const order = new Map();
    for (const f of S.fix) {
      const k = `${f.p}:${f.slot}`;
      order.set(k, (order.get(k) || 0) + 1);
      const im = S.images[f.slot];
      rows.push([f.p, playerOf(f.p).label, f.slot + 1, f.slot, JSON.stringify(im.name), f.visit, order.get(k),
                 f.u.toFixed(5), f.v.toFixed(5), Math.round(f.u * im.w), Math.round(f.v * im.h),
                 f.start, f.dur].join(","));
    }
    const results = {
      app: "live-gaze overview",
      startedAt: new Date(S.startedAt).toISOString(), endedAt: new Date(S.endedAt).toISOString(),
      images: S.images.map((im) => ({
        index: im.slot + 1, name: im.name, w: im.w, h: im.h, medium: im.medium,
        ...(im.sheet ? { sheet: { key: im.sheet.key, ids: im.sheet.ids, layout: im.sheet.layout,
                                  tones: im.sheet.tones, paper: S.exhibition.paper } } : {}),
      })),
      visitors: S.visitors.filter((v) => v.in).map((v) => ({
        id: v.id, label: playerOf(v.id).label, color: playerOf(v.id).color,
        finished_ms: v.finishedAt, finishedBy: v.by,
      })),
      settings: { spreadPctOfImageWidth: SPREAD * 100, minDurationMs: MIN_FIX_MS },
      statistics: LiveGazeReport.stats(ses),
      coordinates: "u,v are 0..1 across the image; x_px,y_px in the image's own pixels; " +
                   "start_ms from the start of the session",
      fixations: S.fix,
    };
    const files = [
      { name: "fixations.csv", blob: new Blob([rows.join("\n") + "\n"], { type: "text/csv" }) },
      { name: "results.json", blob: new Blob([JSON.stringify(results, null, 2)], { type: "application/json" }) },
    ];
    for (const kind of ["scanpaths", "heatmaps", "stats"]) {
      const c = await LiveGazeReport.render(kind, ses, { who: "all", scale: 0.5 });
      files.push({ name: `${kind === "stats" ? "statistics" : kind}.png`,
                   blob: await new Promise((r) => c.toBlob(r, "image/png")) });
    }
    return LiveGazeStore.saveFolder(stamp, "overview", files);
  }

  // ------------------------------------------------------------ drawing
  const canvas = $("grid");
  const ctx = canvas.getContext("2d");
  let dpr = 1;

  function fitCanvas() {
    dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // Each image resized once per size, in high-quality halving steps, then
  // drawn 1:1 onto device pixels.
  function scaled(im, w, h) {
    const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    if (im.cache && im.cache.w === W && im.cache.h === H) return im.cache.c;
    let src = im.el, sw = im.el.naturalWidth, sh = im.el.naturalHeight;
    while (sw / 2 >= W && sh / 2 >= H) {
      const c = document.createElement("canvas");
      c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
      const x = c.getContext("2d"); x.imageSmoothingQuality = "high";
      x.drawImage(src, 0, 0, c.width, c.height);
      src = c; sw = c.width; sh = c.height;
    }
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high";
    x.drawImage(src, 0, 0, W, H);
    im.cache = { w: W, h: H, c };
    return c;
  }

  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function draw() {
    requestAnimationFrame(draw);
    if (!L) return;
    fitCanvas();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#07080c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = now();
    S.images.forEach((im, i) => drawCell(im, L.cells[i], t));
    tickFinish(t);
    tickClock(t);
  }

  function drawCell(im, geo, t) {
    if (!geo) return;
    const { img: r, cell } = geo;
    const ui = L.ui;
    if (im.el) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const x = Math.round(r.x * dpr), y = Math.round(r.y * dpr);
      ctx.drawImage(scaled(im, r.w * dpr, r.h * dpr), x, y);
      ctx.restore();
    } else {
      ctx.fillStyle = "#14161c"; ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // A light veil, so the paths read over bright and dark paint alike.
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(r.x, r.y, r.w, r.h);

    const box = { x: r.x, y: r.y, w: r.w, h: r.h };
    const k = clamp(r.w / 700, 0.55, 1.6) * ui;
    for (const pl of PLAYERS) {
      LiveGazeReport.drawScanpath(ctx, box, S.fix.filter((f) => f.slot === im.slot && f.p === pl.id), pl.color, k,
        { shown: SCANPATH_SHOWN, numbered: NUMBERED });
      const l = S.live.get(pl.id);
      if (l && l.slot === im.slot && t - l.at < 1000) drawLive(box, l, pl.color, k, t);
    }

    // Who is looking here now: a frame in their colour.
    let ring = 0;
    for (const pl of PLAYERS) {
      const l = S.live.get(pl.id);
      if (!l || l.slot !== im.slot || t - l.at > 1000) continue;
      const o = (3 + ring * 6) * ui;
      ctx.lineWidth = 4 * ui; ctx.strokeStyle = pl.color;
      ctx.strokeRect(r.x - o, r.y - o, r.w + 2 * o, r.h + 2 * o);
      ring++;
    }

    // Caption: number and name; each visitor's time on it and fixations.
    const cy = r.y + r.h + 14 * ui;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.font = `${Math.round(13 * ui)}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = "#e8e6e2";
    const title = `${im.slot + 1} · ${im.name.replace(/\.[a-z0-9]+$/i, "")}` + (im.medium === "print" ? "  (printed)" : "");
    ctx.fillText(fitText(title, r.w * 0.55), r.x, cy);
    if (im.problem) {
      ctx.fillStyle = "#ff8a8a";
      ctx.font = `${Math.round(11.5 * ui)}px ui-monospace, Menlo, monospace`;
      ctx.fillText(fitText(im.problem, r.w), r.x, cy + 18 * ui);
    }
    ctx.textAlign = "right";
    let x = r.x + r.w;
    for (const pl of [...PLAYERS].reverse()) {
      const mine = S.fix.filter((f) => f.slot === im.slot && f.p === pl.id);
      if (!vis(pl.id).in && !mine.length) continue;
      const dwell = mine.reduce((s, f) => s + f.dur, 0);
      const txt = `${pl.label} ${fmtTime(dwell)} · ${mine.length} fix.`;
      // Text in ink; the swatch beside it carries who it is.
      ctx.fillStyle = "#cfcdc9";
      ctx.fillText(txt, x, cy);
      x -= ctx.measureText(txt).width + 8 * ui;
      const s = 10 * ui;
      ctx.fillStyle = pl.color;
      ctx.beginPath(); ctx.arc(x - s / 2, cy + 7 * ui, s / 2, 0, Math.PI * 2); ctx.fill();
      x -= s + 18 * ui;
    }
  }

  function fitText(s, w) {
    if (ctx.measureText(s).width <= w) return s;
    while (s.length > 1 && ctx.measureText(s + "…").width > w) s = s.slice(0, -1);
    return s + "…";
  }

  function drawLive(box, l, color, k, t) {
    const X = (u) => box.x + u * box.w, Y = (v) => box.y + v * box.h;
    const trail = l.trail.filter((q) => t - q.at < TRAIL_MS);
    ctx.lineCap = "round";
    for (let i = 1; i < trail.length; i++) {
      const a = 0.85 * (1 - (t - trail[i].at) / TRAIL_MS);
      ctx.strokeStyle = `rgba(0,0,0,${0.7 * a})`; ctx.lineWidth = 5 * k;
      ctx.beginPath(); ctx.moveTo(X(trail[i - 1].u), Y(trail[i - 1].v)); ctx.lineTo(X(trail[i].u), Y(trail[i].v)); ctx.stroke();
      ctx.strokeStyle = LiveGazeReport.rgba(color, a); ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.moveTo(X(trail[i - 1].u), Y(trail[i - 1].v)); ctx.lineTo(X(trail[i].u), Y(trail[i].v)); ctx.stroke();
    }
    if (l.fu != null) {
      ctx.setLineDash([5 * k, 4 * k]);
      ctx.beginPath(); ctx.arc(X(l.fu), Y(l.fv), LiveGazeReport.radius(l.fd) * k, 0, Math.PI * 2);
      ctx.lineWidth = 5 * k; ctx.strokeStyle = "rgba(0,0,0,.75)"; ctx.stroke();
      ctx.lineWidth = 2.5 * k; ctx.strokeStyle = color; ctx.stroke();
      ctx.setLineDash([]);
    }
    if (l.u >= 0 && l.u <= 1 && l.v >= 0 && l.v <= 1) {
      const x = X(l.u), y = Y(l.v), rr = 11 * k, arm = 17 * k;
      for (const [w, c] of [[6, "rgba(0,0,0,.8)"], [2.5, color]]) {
        ctx.lineWidth = w * k; ctx.strokeStyle = c;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y); ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm); ctx.stroke();
      }
    }
  }

  // The rings fill while a visitor's gaze stays on the dot; their gaze on
  // the monitor shows as a small dot near it, so they can find it.
  function tickFinish(t) {
    PLAYERS.forEach((pl, i) => {
      const v = vis(pl.id);
      const ring = document.getElementById(`ring${i}`);
      const dot = document.getElementById(`monDot${i}`);
      if (!ring || !dot) return;
      let frac = 0;
      if (v.finishedAt != null) frac = 1;
      else if (v.dwellFrom && t - v.lastIn <= FINISH_GRACE_MS) frac = clamp((t - v.dwellFrom) / FINISH_MS, 0, 1);
      else if (v.dwellFrom) v.dwellFrom = 0;
      const c = Number(ring.dataset.c);
      ring.setAttribute("stroke-dasharray", `${frac * c} ${c}`);
      ring.setAttribute("stroke-opacity", frac > 0 ? "1" : "0");   // no round-cap dot at zero
      const m = S.mon.get(pl.id);
      const f = L.finish;
      if (m && t - m.at < 400 && Math.hypot(m.x - f.cx, m.y - f.cy) < f.hit * 1.8) {
        dot.setAttribute("cx", m.x - f.cx); dot.setAttribute("cy", m.y - f.cy);
        dot.setAttribute("visibility", "visible");
      } else dot.setAttribute("visibility", "hidden");
    });
  }

  let lastClock = "";
  function tickClock(t) {
    let main = "0:00", sub = "not started";
    if (S.phase === "running") { main = fmtTime(t - S.t0); sub = "session running"; }
    else if (S.phase === "ended") { main = fmtTime(S.endedAt - S.startedAt); sub = "session finished"; }
    const key = main + sub;
    if (key === lastClock) return;
    lastClock = key;
    $("clock").innerHTML = `${main}<small>${sub}</small>`;
    renderSide();
  }

  // ------------------------------------------------------------ side text
  let players = [];
  window.addEventListener("gaze-players", (e) => { players = e.detail || []; renderSide(); if (S.phase === "idle") renderSources(); });

  function whereIs(p) {
    if (!p.on) return "";
    if (p.on === MON.key) return "looking at this monitor";
    const im = S.images.find((i) => i.sheet && i.sheet.key === p.on);
    return im ? `on image ${im.slot + 1}` : "";
  }

  function sourceLine(pl) {
    if (S.sim) return pl.id === 0 ? "mouse stand-in: move the mouse over an image" : "mouse stand-in: hold shift";
    const p = players.find((x) => x.id === pl.id);
    if (!p) return "connecting…";
    if (p.state !== "streaming") return p.detail || p.state;
    const sees = p.screens ? Object.entries(p.screens).filter(([, n]) => n > 0) : [];
    const names = sees.map(([key, n]) => {
      if (key === MON.key) return `this monitor (${n})`;
      const im = S.images.find((i) => i.sheet && i.sheet.key === key);
      return im ? `sheet ${im.slot + 1} (${n})` : null;
    }).filter(Boolean);
    return names.length ? `glasses ready · tags in view: ${names.join(", ")}` : "glasses ready";
  }

  function renderSide() {
    const t = now();
    $("visitors").innerHTML = PLAYERS.map((pl) => {
      const v = vis(pl.id);
      const p = players.find((x) => x.id === pl.id) || {};
      let st;
      if (S.phase === "idle" || S.phase === "loading") st = sourceLine(pl);
      else if (!v.in) st = "not taking part";
      else if (v.finishedAt != null) st = `finished · ${fmtTime(v.finishedAt)}`;
      else {
        const l = S.live.get(pl.id);
        st = l && t - l.at < 1000 ? `looking at image ${l.slot + 1}` : (whereIs(p) || "between images");
      }
      return `<div class="vis${v.finishedAt != null ? " done" : ""}" style="--c:${pl.color}">
        <div class="who">${pl.label} · ${pl.name}</div><div class="st">${st}</div></div>`;
    }).join("");
    $("doneList").innerHTML = PLAYERS.filter((pl) => vis(pl.id).finishedAt != null)
      .map((pl) => `<div><span style="color:${pl.color}">●</span> ${pl.label} finished ✓</div>`).join("");
    $("keys").innerHTML = S.phase === "running"
      ? "1 1 / 2 2 finish a visitor · e e end · f fullscreen"
      : S.phase === "ended" ? "p print · n n new session · f fullscreen"
      : "space start · m mouse stand-in · f fullscreen";
  }

  function renderSources() {
    $("scSources").innerHTML = PLAYERS.map((pl) =>
      `<div style="--c:${pl.color}"><b>${pl.label} · ${pl.name}</b> — ${sourceLine(pl)}</div>`).join("");
  }

  function renderStartCard() {
    const n = S.images.length;
    const printed = S.images.filter((i) => i.sheet).length;
    const problems = S.images.filter((i) => i.problem);
    $("scTitle").textContent = `overview · ${n} image${n === 1 ? "" : "s"}`;
    if (!n) {
      $("scBody").innerHTML = `<p class="warn">No images in this session. Choose them on the upload page
        (or press <b>use the saved exhibition</b> there), then reload this window.</p>`;
      $("startBtn").disabled = true;
    } else {
      $("scBody").innerHTML =
        `<p>${printed ? `<b>${printed} printed sheet${printed === 1 ? "" : "s"}</b> tracked from the saved exhibition` : "No printed sheets"}` +
        `${n - printed - problems.length ? `, <b>${n - printed - problems.length} on screens</b>` : ""}.
        Put the glasses on both visitors, then start. Each visitor walks between the images as
        they like and finishes by looking at the <b>dot on the right</b> of this monitor for
        3 seconds. When both have finished, the scanpaths freeze and you are asked what to print.</p>` +
        problems.map((i) => `<p class="warn">Image ${i.slot + 1}: ${i.problem}.</p>`).join("") +
        (SETUP.collect ? `<p>Data is collected: the session is saved when it ends.</p>` : "");
      $("startBtn").disabled = false;
    }
    renderSources();
    $("startCard").classList.remove("hidden");
  }

  // ------------------------------------------------------------- the end
  const report = { kind: "scanpaths", who: "all", cache: new Map() };

  async function picture(kind, who) {
    const key = `${kind}:${who}`;
    if (!report.cache.has(key)) {
      report.cache.set(key, (async () => {
        const c = await LiveGazeReport.render(kind, session(), { who });
        return new Promise((r) => c.toBlob((b) => r(URL.createObjectURL(b)), "image/png"));
      })());
    }
    return report.cache.get(key);
  }

  const ASK = {
    scanpaths: "Is this the print you want? The scanpaths",
    heatmaps: "Heatmaps — where the looking was densest",
    stats: "Fixation statistics",
  };

  async function showKind(kind) {
    report.kind = kind;
    document.querySelectorAll("#mTabs button").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
    document.querySelectorAll("#mWho button").forEach((b) => b.classList.toggle("on", b.dataset.who === String(report.who)));
    $("mWho").classList.toggle("hidden", kind !== "heatmaps");
    $("mAsk").textContent = ASK[kind];
    $("mPreview").style.opacity = "0.35";
    const url = await picture(kind, kind === "heatmaps" ? report.who : "all");
    if (report.kind === kind) { $("mPreview").src = url; $("mPreview").style.opacity = "1"; }
  }

  function renderSummary() {
    const shown = S.visitors.filter((v) => v.in);
    const parts = shown.map((v) => `<span style="color:${playerOf(v.id).color}">●</span> <b>${playerOf(v.id).label}</b> ${fmtTime(v.finishedAt)}`);
    let saved = "";
    if (S.saved && S.saved.where) saved = ` · saved to <b>${S.saved.where}</b>`;
    else if (S.saved && S.saved.error) saved = ` · <b style="color:#ff8a8a">not saved: ${S.saved.error}</b>`;
    else if (MOCK) saved = " · <b>test print: made-up data, nothing saved</b>";
    else if (SETUP.collect) saved = " · saving…";
    $("mSum").innerHTML = `${shown.length} visitor${shown.length === 1 ? "" : "s"} · ${parts.join(" · ")} · ` +
      `${S.fix.length} fixations on ${S.images.length} images${saved}`;
  }

  function openModal(kind) {
    renderSummary();
    $("modal").classList.remove("hidden");
    showKind(kind || report.kind);
  }
  function closeModal() { $("modal").classList.add("hidden"); }

  // What the print sheet holds — also what the browser's own Print (cmd+P)
  // prints: the scanpaths once a session has ended, until a button says else.
  async function fillPrintSheet(kinds) {
    const urls = [];
    for (const k of kinds) urls.push(await picture(k, k === "heatmaps" ? report.who : "all"));
    const sheet = $("printSheet");
    sheet.innerHTML = "";
    await Promise.all(urls.map((u) => new Promise((resolve) => {
      const img = new Image();
      img.onload = img.onerror = resolve;
      img.src = u;
      sheet.appendChild(img);
    })));
  }

  async function printKinds(kinds) {
    await fillPrintSheet(kinds);
    window.print();
  }

  $("mTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showKind(b.dataset.kind); });
  $("mWho").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    report.who = b.dataset.who === "all" ? "all" : Number(b.dataset.who);
    showKind("heatmaps");
  });
  $("mPrint").onclick = () => printKinds([report.kind]);
  $("mAll").onclick = () => printKinds(["scanpaths", "heatmaps", "stats"]);
  $("mClose").onclick = closeModal;
  $("mNew").onclick = newSession;
  $("startBtn").onclick = startSession;

  // ------------------------------------------------------------ feedback
  let audio = null;
  function chime(silent) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      if (silent) return;
      const t = audio.currentTime;
      [[659.25, 0], [987.77, 0.14]].forEach(([f, d]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 1.1);
        o.connect(g).connect(audio.destination);
        o.start(t + d); o.stop(t + d + 1.2);
      });
    } catch (_) { /* no audio: the ring and the note still say it */ }
  }

  let noteTimer = null;
  function note(text, ms = 4000) {
    const el = $("note");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => el.classList.remove("show"), ms);
  }

  // ------------------------------------------------------------- input
  // Twice within 1.5 s: a single stray key never ends anybody's visit.
  const armed = new Map();
  function twice(key, label, action) {
    const t = now();
    if (armed.has(key) && t - armed.get(key) < 1500) { armed.delete(key); action(); return; }
    armed.set(key, t);
    note(`press ${key} again to ${label}`, 1500);
  }

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === " " && S.phase === "idle") { e.preventDefault(); startSession(); return; }
    if (k === "f") { goFullscreen(); return; }
    if (k === "escape") { closeModal(); return; }
    if (S.phase === "running") {
      if (k === "1" || k === "2") {
        const p = Number(k) - 1;
        if (vis(p).in && vis(p).finishedAt == null) twice(k, `finish ${PLAYERS[p].label}`, () => finishVisitor(p, "finished by the operator"));
        return;
      }
      if (k === "e") { twice("e", "end the session for everyone", endSession); return; }
    }
    if (S.phase === "ended") {
      if (k === "p") { openModal(); return; }
      if (k === "n") { twice("n", "start a new session", newSession); return; }
    }
    if (k === "m" && S.phase !== "running") {
      S.sim = !S.sim;
      note(S.sim ? "mouse stand-in on: the mouse is P1, shift + mouse is P2" : "mouse stand-in off");
      renderSide();
      renderSources();
    }
  });

  function goFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  // The mouse stand-in: a steady 60 Hz stream from where the mouse rests,
  // like glasses would send, over an image or over the finish dot.
  const mouse = { x: 0, y: 0, shift: false, inside: false };
  window.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.shift = e.shiftKey; mouse.inside = true; });
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) mouse.inside = false; });
  window.addEventListener("keydown", (e) => { if (e.key === "Shift") mouse.shift = true; });
  window.addEventListener("keyup", (e) => { if (e.key === "Shift") mouse.shift = false; });
  setInterval(() => {
    if (!S.sim || !mouse.inside || S.phase !== "running" || !L) return;
    if (!$("modal").classList.contains("hidden")) return;
    const p = mouse.shift ? 1 : 0;
    const f = L.finish;
    if (Math.hypot(mouse.x - f.cx, mouse.y - f.cy) <= f.hit * 1.8) { monitorSample(p, mouse.x, mouse.y); return; }
    const i = L.cells.findIndex((g) => g && mouse.x >= g.img.x && mouse.x <= g.img.x + g.img.w &&
                                       mouse.y >= g.img.y && mouse.y <= g.img.y + g.img.h);
    if (i >= 0) {
      const g = L.cells[i].img;
      imageSample(p, S.images[i].slot, (mouse.x - g.x) / g.w, (mouse.y - g.y) / g.h);
    }
  }, 1000 / 60);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    layout();
    clearTimeout(resizeTimer);
    // The monitor is a surface: its new size goes to the bridges.
    resizeTimer = setTimeout(() => GazeAggregator.setScreens([...sheetScreens(), monitorScreen()]), 250);
  });

  // ------------------------------------------------------------- start
  // The made-up session, finished: the pop-up, as after real visitors.
  async function mockSession() {
    const imgs = await LiveGazeMock.images();
    S.images = imgs.map((im) => ({ slot: im.slot, name: im.name, w: im.w, h: im.h, medium: im.medium,
                                   el: im.el, sheet: null, problem: null, cache: null }));
    layout();
    const ses = LiveGazeMock.session(S.images);
    S.fix = ses.fix;
    ses.visitors.forEach((v) => Object.assign(vis(v.id), v));
    S.startedAt = ses.startedAt;
    S.endedAt = ses.endedAt;
    S.phase = "ended";
    $("scTitle").textContent = "test print";
    renderSide();
    requestAnimationFrame(draw);
    note("test print: a made-up session — nothing here was measured or saved", 6000);
    openModal("scanpaths");
    await fillPrintSheet(params.has("printall") ? ["scanpaths", "heatmaps", "stats"] : ["scanpaths"]);
    document.documentElement.dataset.printReady = "1";     // for scripted PDFs
    window.LiveGazeOverview = { state: S, layout: () => L };
  }

  (async () => {
    if (MOCK) { await mockSession(); return; }
    await load();
    layout();
    GazeAggregator.init({
      players: PLAYERS.map(({ id, label, port, color }) => ({ id, label, port, color })),
      screens: [...sheetScreens(), monitorScreen()],
      onSample,
    });
    // Only the tags: the frame cannot find paper (load() says so per image).
    if (SETUP.surface !== "frame") GazeAggregator.setSurfaceSource("tags");
    S.phase = "idle";
    renderStartCard();
    renderSide();
    requestAnimationFrame(draw);
    window.LiveGazeOverview = { state: S, layout: () => L, finishVisitor, endSession, startSession };
  })();
})();
