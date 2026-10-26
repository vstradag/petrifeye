// Data collection for any experience: LIVE GAZE's pipeline, for the pieces
// that are not about one image.
//
// When the visitor answers "Collect data" at the start (session-setup.js):
//
//   1. CALIBRATE. Before play begins, each player looks at five eyes, the same
//      targets LIVE GAZE uses (target-calibration.js). The median miss is that
//      pair of glasses' correction — applied to what is RECORDED only; the
//      game keeps its own feel (motion assist, MEDUSA's auto-calibration).
//      Nothing seen while calibrating is data.
//   2. MEASURE. Every frame, each player's raw gaze (never the assisted
//      position, which overshoots saccades) goes through a median filter and
//      the dispersion fixation detector (fixations.js), with LIVE GAZE's
//      settings per input. Held pointers — a stalled stream frozen in place —
//      count as no gaze, so a Wi-Fi hiccup is never a long fixation.
//   3. SAVE, through the bridge, to
//        ~/petrifeye-recordings/<app>/<session date-time>/<NN-part>/
//      fixations.csv, results.json and scanpath.png — the files LIVE GAZE
//      writes for an image. A PART is a round, a game, a cartoon: whatever
//      the experience starts over (newPart). Saved every few seconds while
//      it runs, so closing the window loses almost nothing, and in full when
//      the part ends. Without a bridge (webcam only), clicking the rec badge
//      downloads the files instead.
//
//   DataCollection.init({ app, title, players, playerOf, area, areaInfo,
//                         background, extra, measure, partLabel })
//   DataCollection.calibrate({ sim })  -> Promise (after fullscreen is asked for)
//   DataCollection.begin({ sim })
//   DataCollection.newPart(label)
//
// Everything is a no-op unless collection was chosen, so an experience can
// call these unconditionally.
(function () {
  const SPREAD_PCT = 3.5;          // fixation dispersion, % of the measured area's width
  const MIN_DURATION_MS = 100;
  // Per input, as in LIVE GAZE: a webcam cannot resolve fixations as finely
  // as glasses, so it gets a longer median and a wider spatial window.
  const MEASURE = {
    neon:   { median: 5, spread: 1 },
    mouse:  { median: 5, spread: 1 },
    webcam: { median: 7, spread: 2.5 },
  };
  const AUTOSAVE_MS = 15000;       // fixations.csv + results.json, when changed
  const PICTURE_EVERY_MS = 120000; // scanpath.png is heavier: now and then, and at the end
  const KEEPALIVE_MAX = 60000;     // a fetch that outlives the page carries at most ~64 KB
  const VIEWPORT_SETTLE_MS = 700;  // see LIVE GAZE's goFullscreen
  const FULLSCREEN_WAIT_MS = 1500;

  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => String(n).padStart(2, "0");
  const safeName = (s) => String(s).replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_").trim().slice(0, 60) || "part";

  let cfg = null;
  let sim = false;
  let recording = false;
  let stamp = null;                // the session's folder
  let part = null;                 // { index, label, startedAt, t0, fixations, savedCount }
  let partIndex = 0;
  let lastPicture = 0;
  let lastSave = null;             // { at, where, how } | { error }
  let calibSession = null;         // the calibration running now, if any
  const detectors = new Map();     // pointerId -> { input, med, det }

  function enabled() {
    if (cfg && cfg.enabled != null) return !!cfg.enabled;
    return !!(window.SessionSetup && SessionSetup.choice && SessionSetup.choice.collect);
  }

  function sessionStamp(d = new Date()) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
           `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }

  // ------------------------------------------------------------ players
  function playerOf(pointerId) {
    if (cfg.playerOf) return cfg.playerOf(pointerId);
    const m = /^player-(\d+)$/.exec(pointerId);
    if (m) return cfg.players.find((p) => p.id === Number(m[1])) || null;
    // The mouse/keyboard stand-in, credited to the first two players.
    if (sim && pointerId === "mouse") return cfg.players[0] || null;
    if (sim && pointerId === "sim2") return cfg.players[1] || null;
    return null;
  }

  function inputOf(pointerId) {
    if (!/^player-/.test(pointerId)) return "mouse";
    const n = Number(pointerId.split("-")[1]);
    const p = (window.GazeAggregator ? GazeAggregator.players() : []).find((x) => x.id === n);
    return p && p.source === "webcam" ? "webcam" : "neon";
  }

  // ------------------------------------------------------------ the area
  // What is measured, in screen px: the whole viewport unless the experience
  // says otherwise (POLITICAL VISION: the cartoon). areaInfo is its natural
  // size, for x_px/y_px — the screen's pixels, or the image's own.
  const viewport = () => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  const area = () => (cfg.area ? cfg.area() : viewport());
  function areaInfo() {
    const r = area();
    const i = cfg.areaInfo ? cfg.areaInfo() : null;
    return { name: (i && i.name) || "screen", w: (i && i.w) || Math.round(r.w), h: (i && i.h) || Math.round(r.h) };
  }
  function measureSettings() {
    const m = cfg.measure ? cfg.measure() : null;
    return {
      spreadPct: (m && m.spreadPct) || SPREAD_PCT,
      minDurationMs: (m && m.minDurationMs) || MIN_DURATION_MS,
    };
  }

  function entryFor(id, r, ms) {
    let e = detectors.get(id);
    if (!e) {
      const input = inputOf(id);
      e = {
        input,
        med: new MedianFilter2D(MEASURE[input].median),
        det: new FixationDetector({ dispersionPx: 50, minDurationMs: ms.minDurationMs }),
      };
      detectors.set(id, e);
    }
    // The area can change size (fullscreen, a new cartoon), and the settings
    // with it: retuned every frame, as LIVE GAZE does.
    e.det.dispersionPx = Math.max(4, (ms.spreadPct / 100) * r.w * MEASURE[e.input].spread);
    e.det.minDurationMs = ms.minDurationMs;
    return e;
  }

  // ------------------------------------------------------------- record
  function record(pl, f, r) {
    if (!part || !pl) return;
    const u = (f.x - r.x) / r.w, v = (f.y - r.y) / r.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    part.fixations.push({
      p: pl.id, u, v,
      dur: Math.round(f.duration),
      start: Math.round(f.start - part.t0),
    });
    renderBadge();
  }

  function flushAll() {
    const r = area();
    for (const [id, e] of detectors) {
      const f = e.det.flush();
      if (f) record(playerOf(id), f, r);
    }
  }

  // The game drives Tracking.update() once a frame; this reads what it got
  // (getPointers), so the game's filters run exactly as they always have.
  function tick() {
    if (!recording) return;
    requestAnimationFrame(tick);
    const now = performance.now();
    const r = area();
    if (!(r.w > 0 && r.h > 0)) return;
    const ms = measureSettings();
    const pointers = window.GazeTargetCalibration
      ? GazeTargetCalibration.apply(Tracking.getPointers() || [])
      : (Tracking.getPointers() || []);
    const seen = new Set();
    for (const ptr of pointers) {
      if (ptr.held) continue;
      const pl = playerOf(ptr.id);
      if (!pl || !Number.isFinite(ptr.x) || !Number.isFinite(ptr.y)) continue;
      seen.add(ptr.id);
      const e = entryFor(ptr.id, r, ms);
      const m = e.med.push(ptr.rawX ?? ptr.x, ptr.rawY ?? ptr.y);
      const inside = m.x >= r.x && m.x <= r.x + r.w && m.y >= r.y && m.y <= r.y + r.h;
      // Gaze off the area ends a fixation; one must not straddle its edge.
      const closed = inside ? e.det.push(now, m.x, m.y) : e.det.flush();
      if (closed) record(pl, closed, r);
    }
    // A pointer that vanished (glasses off, tracking lost) closes its fixation.
    for (const [id, e] of detectors) {
      if (seen.has(id)) continue;
      const f = e.det.flush();
      e.med.reset();
      if (f) record(playerOf(id), f, r);
    }
  }

  // ------------------------------------------------------- calibration
  // Five targets the visitor looks at, as in LIVE GAZE. Over an image: the
  // centre and towards its corners. Over the whole screen: the centre and the
  // middle of each side — the corners are where the tags are.
  function targetsFor(r) {
    const at = (fx, fy) => ({ x: r.x + fx * r.w, y: r.y + fy * r.h });
    if (cfg.area) return [at(0.5, 0.5), at(0.2, 0.2), at(0.8, 0.2), at(0.8, 0.8), at(0.2, 0.8)];
    return [at(0.5, 0.5), at(0.5, 0.2), at(0.8, 0.5), at(0.5, 0.8), at(0.2, 0.5)];
  }

  // Resolves once the viewport is final and the bridges have rebuilt their
  // surface for it: targets laid out for the pre-fullscreen size, measured
  // through a mapping scaled for it, made LIVE GAZE's first calibration wrong.
  function viewportSettled() {
    return new Promise((resolve) => {
      const settle = () => setTimeout(resolve, VIEWPORT_SETTLE_MS);
      if (document.fullscreenElement) { settle(); return; }
      let done = false;
      const once = () => { if (done) return; done = true; settle(); };
      document.addEventListener("fullscreenchange", once, { once: true });
      setTimeout(once, FULLSCREEN_WAIT_MS);
    });
  }

  function caption(ctx, text, y) {
    ctx.save();
    ctx.font = "15px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(232, 230, 226, 0.85)";
    ctx.fillText(text, ctx.canvas.width / 2, y);
    ctx.restore();
  }

  function calibrate(opts = {}) {
    sim = !!opts.sim;
    if (!cfg || !enabled() || sim || !window.GazeTargetCalibration) return Promise.resolve(null);
    // New visitors: nobody's earlier correction carries over.
    GazeTargetCalibration.clear();
    return viewportSettled().then(() => new Promise((resolve) => {
      // Over the game, under the tags and the frame (1100/1101): the glasses
      // must keep seeing them, or there is no gaze to calibrate.
      const c = document.createElement("canvas");
      c.className = "dc-calib";
      Object.assign(c.style, { position: "fixed", inset: "0", zIndex: "1050", background: "#000" });
      c.width = window.innerWidth; c.height = window.innerHeight;
      document.body.appendChild(c);
      const ctx = c.getContext("2d");

      const r = area();
      const targets = targetsFor(r);
      // How far settled gaze may be from a target and still count: above the
      // bias being measured, well under the spacing between targets.
      const spacing = Math.min(0.3 * r.w, 0.3 * r.h, Math.hypot(0.3 * r.w, 0.3 * r.h));
      const radius = Math.max(60, Math.min(220, 0.45 * spacing));
      const name = (id) => (playerOf(id) || { label: id }).label;
      let result = null;
      const session = calibSession = new GazeTargetCalibration.Session({
        targets, radius, areaW: r.w, mode: "full",
        onDone: (summary) => {
          result = summary;
          calibSession = null;
          const parts = summary.map((s) => s.ok
            ? `${name(s.id)}: calibrated · ${s.n}/5 eyes · ±${Math.round(s.spread)}px`
            : `${name(s.id)}: not calibrated${s.tooBig ? ` (off by ${s.tooBig}px)` : ""}`);
          const text = parts.join("    ") || "nobody looked at the screen — not calibrated";
          ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
          caption(ctx, text, c.height / 2);
          setTimeout(() => { c.remove(); resolve(result); }, 2200);
        },
      });

      const step = () => {
        if (result) return;
        requestAnimationFrame(step);
        const now = performance.now();
        if (c.width !== window.innerWidth || c.height !== window.innerHeight) {
          c.width = window.innerWidth; c.height = window.innerHeight;
        }
        const ptrs = Tracking.update().filter((p) => !p.held && playerOf(p.id));
        session.update(now, ptrs);
        if (result) return;
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
        session.draw(ctx, now);
        // Above an image (as in LIVE GAZE); on the whole screen, low down,
        // clear of the top target.
        caption(ctx, `calibration — look at each eye until it turns to stone · ${Math.min(session.i + 1, 5)} / 5`,
                cfg.area ? Math.max(28, r.y - 14) : c.height - 64);
      };
      requestAnimationFrame(step);
    }));
  }

  // --------------------------------------------------------------- parts
  function openPart(label) {
    partIndex += 1;
    part = {
      index: partIndex,
      label: label || cfg.partLabel || "session",
      startedAt: new Date(),
      endedAt: null,
      t0: performance.now(),
      fixations: [],
      savedCount: -1,
    };
    detectors.clear();
    renderBadge();
  }

  function begin(opts = {}) {
    if (!cfg || !enabled() || recording) return;
    sim = !!opts.sim;
    stamp = sessionStamp();
    recording = true;
    openPart();
    lastPicture = performance.now();
    requestAnimationFrame(tick);
    setInterval(() => {
      if (!part || part.fixations.length === part.savedCount) return;
      const picture = performance.now() - lastPicture > PICTURE_EVERY_MS;
      save({ picture });
    }, AUTOSAVE_MS);
    window.addEventListener("pagehide", saveOnExit);
    renderBadge();
  }

  // The current part ends (saved whole, with its picture) and the next begins.
  // A part with nothing in it yet is renamed rather than saved empty: a game
  // that announces its first round as it begins (MAGNETIC POETRY's first
  // poem) should not leave a "01-session" folder of nothing behind.
  async function newPart(label) {
    if (!recording) return;
    flushAll();
    if (!part.fixations.length && part.savedCount < 0) {
      part.label = label || part.label;
      part.startedAt = new Date();
      part.t0 = performance.now();
      renderBadge();
      return;
    }
    const ended = part;
    ended.endedAt = new Date();
    // Frozen now: by the time the save runs, the experience has moved on —
    // scores reset, the next cartoon on screen.
    ended.frozen = {
      info: areaInfo(),
      onScreen: area(),
      extra: cfg.extra ? safeExtra() : {},
      bg: snapshotBackground(),
    };
    openPart(label);
    await save({ picture: true, of: ended });
  }

  // ---------------------------------------------------------------- save
  // fixations.csv and results.json, as text: built synchronously, so the
  // last save as the window closes needs nothing that waits.
  function textFiles(p) {
    const fz = p.frozen || {};
    const info = fz.info || areaInfo();
    const players = playerList();
    const rows = ["player,label,order,u,v,x_px,y_px,start_ms,duration_ms"];
    const order = new Map();
    for (const f of p.fixations) {
      const k = (order.get(f.p) || 0) + 1; order.set(f.p, k);
      const pl = players.find((x) => x.id === f.p) || { label: `P${f.p + 1}` };
      rows.push([f.p, pl.label, k, f.u.toFixed(5), f.v.toFixed(5),
                 Math.round(f.u * info.w), Math.round(f.v * info.h), f.start, f.dur].join(","));
    }
    const inputs = window.GazeAggregator ? GazeAggregator.players() : [];
    const results = {
      app: cfg.app,
      title: cfg.title || cfg.app,
      session: stamp,
      part: { index: p.index, label: p.label, startedAt: p.startedAt.toISOString(),
              endedAt: p.endedAt ? p.endedAt.toISOString() : null },
      surface: (window.SessionSetup && SessionSetup.choice && SessionSetup.choice.surface) ||
               (window.GazeAggregator && GazeAggregator.surfaceSource && GazeAggregator.surfaceSource()) || null,
      simulated: sim,
      screen: { w: window.innerWidth, h: window.innerHeight },
      area: { ...info, onScreen: fz.onScreen || area() },
      players: players.map((pl) => {
        const x = inputs.find((q) => q.id === pl.id);
        return { ...pl, input: sim ? "mouse" : (x ? x.source : null) };
      }),
      settings: measureSettings(),
      calibration: window.GazeTargetCalibration ? GazeTargetCalibration.all() : [],
      coordinates: "u,v are 0..1 across the measured area; x_px,y_px are in its own pixels " +
                   "(the screen's, or the image's); start_ms counts from the start of this part",
      ...(fz.extra || (cfg.extra ? safeExtra() : {})),
      fixations: p.fixations,
    };
    return [
      { name: "fixations.csv", type: "text/csv", text: rows.join("\n") + "\n" },
      { name: "results.json", type: "application/json", text: JSON.stringify(results, null, 2) },
    ];
  }

  const playerList = () => cfg.players.map(({ id, label, color }) => ({ id, label, color }));
  // UTF-8 safe, and synchronous (FileReader is neither needed nor allowed time
  // while a page is closing).
  const b64 = (text) => btoa(unescape(encodeURIComponent(text)));

  function safeExtra() {
    try { return cfg.extra() || {}; } catch (_) { return {}; }
  }

  // Under the scanpath: what the experience says (POLITICAL VISION: the
  // cartoon), else the page's largest canvas cropped to the area — the game
  // as it stands. A WebGL canvas may come back blank; then it stays dark.
  function backgroundSource(r) {
    if (cfg.background) {
      const el = cfg.background();
      return el ? { el, sx: 0, sy: 0, sw: el.naturalWidth || el.width, sh: el.naturalHeight || el.height } : null;
    }
    let best = null;
    for (const c of document.querySelectorAll("canvas")) {
      if (c.classList.contains("dc-calib") || !c.width || !c.clientWidth) continue;
      if (!best || c.width * c.height > best.width * best.height) best = c;
    }
    if (!best) return null;
    const k = best.width / best.clientWidth;
    const box = best.getBoundingClientRect();
    return { el: best, sx: (r.x - box.left) * k, sy: (r.y - box.top) * k, sw: r.w * k, sh: r.h * k };
  }

  // A copy of the background as it is now, for a part that has ended.
  function snapshotBackground() {
    try {
      const bg = backgroundSource(area());
      if (!bg || !(bg.sw > 0 && bg.sh > 0)) return null;
      const scale = Math.min(1, 1600 / Math.max(bg.sw, bg.sh));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bg.sw * scale));
      c.height = Math.max(1, Math.round(bg.sh * scale));
      c.getContext("2d").drawImage(bg.el, bg.sx, bg.sy, bg.sw, bg.sh, 0, 0, c.width, c.height);
      return { el: c, sx: 0, sy: 0, sw: c.width, sh: c.height };
    } catch (_) { return null; }
  }

  function picture(p) {
    const fz = p.frozen || {};
    const info = fz.info || areaInfo();
    const players = playerList();
    const scale = Math.min(1, 1600 / Math.max(info.w, info.h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(info.w * scale));
    c.height = Math.max(1, Math.round(info.h * scale));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
    try {
      const bg = fz.bg || backgroundSource(area());
      if (bg) ctx.drawImage(bg.el, bg.sx, bg.sy, bg.sw, bg.sh, 0, 0, c.width, c.height);
    } catch (_) { /* tainted or blank: the paths still go on black */ }
    ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fillRect(0, 0, c.width, c.height);
    for (const pl of players) {
      const fs = p.fixations.filter((f) => f.p === pl.id);
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

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const folderOf = (p) => `${pad2(p.index)}-${safeName(p.label)}`;

  // Saves one part (default: the current one). Without the bridge's endpoint
  // an autosave stays quiet — downloading every 15 s would bury the visitor in
  // files — and an explicit save (the badge) downloads instead.
  let saving = Promise.resolve();
  function save({ picture: withPicture = false, of = null, explicit = false } = {}) {
    const p = of || part;
    if (!p) return Promise.resolve(null);
    const count = p.fixations.length;
    saving = saving.then(async () => {
      const texts = textFiles(p);
      const png = withPicture ? await picture(p) : null;
      if (withPicture) lastPicture = performance.now();
      try {
        const payload = { app: cfg.app, session: stamp, image: folderOf(p),
                          files: texts.map((f) => ({ name: f.name, data: b64(f.text) })) };
        if (png) payload.files.push({ name: "scanpath.png", data: await blobToBase64(png) });
        const r = await fetch("/api/save-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const res = await r.json();
        p.savedCount = count;
        lastSave = { at: new Date(), where: res.path, how: "saved" };
      } catch (err) {
        if (explicit) {
          const name = (f) => `${cfg.app}_${stamp}_${folderOf(p)}_${f}`;
          for (const f of texts) download(new Blob([f.text], { type: f.type }), name(f.name));
          if (png) download(png, name("scanpath.png"));
          p.savedCount = count;
          lastSave = { at: new Date(), where: "your Downloads folder", how: "downloaded" };
        } else {
          lastSave = { at: new Date(), error: "no bridge to save through — click to download" };
        }
      }
      renderBadge();
      return lastSave;
    }).catch(() => null);
    return saving;
  }

  // Closing the window: whatever the last autosave missed, if it is small
  // enough for a request that outlives the page. Never the picture.
  function saveOnExit() {
    if (!part) return;
    flushAll();
    if (part.fixations.length === part.savedCount) return;
    const payload = { app: cfg.app, session: stamp, image: folderOf(part),
                      files: textFiles(part).map((f) => ({ name: f.name, data: b64(f.text) })) };
    const body = JSON.stringify(payload);
    if (body.length > KEEPALIVE_MAX) return;
    try {
      fetch("/api/save-analysis", { method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    } catch (_) { /* the page is going either way */ }
  }

  // ---------------------------------------------------------------- badge
  // Small and low on the screen, clear of the tags and inside the frame: the
  // operator can see that data is being collected, and so can the visitor.
  // Clicking it saves now, picture included.
  function renderBadge() {
    if (!recording) return;
    let el = $("dcBadge");
    if (!el) {
      el = document.createElement("button");
      el.id = "dcBadge";
      Object.assign(el.style, {
        position: "fixed", left: "50%", bottom: "34px", transform: "translateX(-50%)", zIndex: "1150",
        font: "10px ui-monospace, Menlo, monospace", letterSpacing: "0.22em", textTransform: "uppercase",
        color: "#c98f8f", background: "rgba(0,0,0,0.55)", border: "1px solid #3a2a2a",
        padding: "4px 10px", cursor: "pointer", opacity: "0.6",
      });
      el.onmouseenter = () => { el.style.opacity = "1"; };
      el.onmouseleave = () => { el.style.opacity = "0.6"; };
      el.onclick = () => { flushAll(); save({ picture: true, explicit: true }); };
      document.body.appendChild(el);
    }
    const n = part ? part.fixations.length : 0;
    el.innerHTML = `<span style="color:#ff3b3b">●</span> rec · ${part ? folderOf(part) : ""} · ${n} fixation${n === 1 ? "" : "s"}`;
    el.title = lastSave
      ? (lastSave.error ? lastSave.error
        : `${lastSave.how} ${lastSave.at.toLocaleTimeString()} to ${lastSave.where} — click to save now`)
      : "collecting data — click to save now";
  }

  window.DataCollection = {
    init(config) {
      cfg = { players: [], ...config };
      cfg.app = cfg.app || "petrifeye";
    },
    calibrate,
    begin,
    newPart,
    save: () => { flushAll(); return save({ picture: true, explicit: true }); },
    get enabled() { return !!cfg && enabled(); },
    get recording() { return recording; },
    // For tests and the console.
    get part() { return part; },
    get calibrationTarget() { return calibSession ? calibSession.current() : null; },
    get session() { return stamp; },
  };
})();
