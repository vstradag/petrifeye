// MEDUSA (+2 players) with second screen analysis — the analysis layer.
//
// Loaded after sketch.js and the multiplayer page's own script, and it only
// ever READS the game: the pointers Tracking already computed, the eyes in
// `blobs`, which eye each player is focused on in `focus`, and the
// "blob-petrified" events the game already fires. Nothing about how MEDUSA
// plays changes, which is what lets the analysis describe the same game the
// original page runs.
//
// Everything is sent to medusa-analysis-observer.html over a BroadcastChannel.
// The observer never connects to a bridge: a bridge maps gaze into the
// viewport of whichever page last reported one, so a second window reporting
// its own size would silently move every player's gaze.
(function () {
  const CHANNEL = "medusa-analysis";
  const SPREAD_PCT = 3.5;           // fixation spread, % of screen width
  const MIN_FIX_MS = 100;
  const FOCUS_LOG_MS = 30000;       // per-pointer history of what it was focused on
  const bus = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;
  const post = (m) => { if (bus) bus.postMessage(m); };

  // Same measurement choices as POLITICAL VISION, for the same measured
  // reasons (see MedianFilter2D in shared/gaze/fixations.js): raw gaze, never
  // the motion assist, through a median; a coarser window for the webcam.
  const MEASURE = {
    neon:   { median: 5, spread: 1 },
    mouse:  { median: 5, spread: 1 },
    webcam: { median: 7, spread: 2.5 },
  };

  const A = {
    fixations: [],        // { id, p, x, y, u, v, dur, start, end, blob, kind, by }
    pending: new Map(),   // blobId -> fixation ids on that eye while it is alive
    petrifiedAt: new Map(), // blobId -> { at, by } for its latest petrification
    nextId: 1,
    roundStart: performance.now(),
  };
  const entries = new Map();   // pointerId -> { input, med, det, focusLog: [{t, blob}] }

  // --------------------------------------------------------------- players
  // byPointer / PLAYERS / scores come from the page's own script. byPointer
  // already maps player-N, and after a mouse test also "mouse" and "sim2".
  const playerOf = (pid) => (typeof byPointer !== "undefined" && byPointer[pid]) || null;

  function inputOf(pid) {
    if (!/^player-/.test(pid)) return "mouse";
    const n = Number(pid.split("-")[1]);
    const p = (window.GazeAggregator && GazeAggregator.players() || []).find((x) => x.id === n);
    return p && p.source === "webcam" ? "webcam" : "neon";
  }

  function entryFor(pid) {
    let e = entries.get(pid);
    if (!e) {
      const input = inputOf(pid);
      e = {
        input,
        med: new MedianFilter2D(MEASURE[input].median),
        det: new FixationDetector({ dispersionPx: 50, minDurationMs: MIN_FIX_MS }),
        focusLog: [],
      };
      entries.set(pid, e);
    }
    e.det.dispersionPx = Math.max(4, (SPREAD_PCT / 100) * width * MEASURE[e.input].spread);
    return e;
  }

  // ------------------------------------------------------------ attribution
  // Which eye was a fixation ON? First choice is the game's own answer: the
  // eye the attention arbiter held for that player during the fixation, which
  // is exactly what drives petrification — so the analysis and the score can
  // never disagree about what someone was looking at. The arbiter only ever
  // holds LIVE eyes, so a look that falls just outside an eye, or rests on a
  // stone, is resolved by proximity instead.
  function targetOf(e, fix) {
    const counts = new Map();
    let frames = 0;
    for (const s of e.focusLog) {
      if (s.t < fix.start || s.t > fix.end) continue;
      frames++;
      if (s.blob) counts.set(s.blob, (counts.get(s.blob) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
    if (best && bestN >= Math.max(1, frames * 0.3)) return best;

    let near = null, nearD = Infinity;
    for (const b of blobs) {
      const d = Math.hypot(b.pos.x - fix.x, b.pos.y - fix.y);
      if (d <= b.radius * 1.5 + 25 && d < nearD) { near = b.id; nearD = d; }
    }
    return near;
  }

  function finalize(e, pid, player, fix) {
    const blobId = targetOf(e, fix);
    const blob = blobId && blobs.find((b) => b.id === blobId);
    let kind = null, by = null;

    if (blob) {
      const pet = A.petrifiedAt.get(blobId);
      if (blob.petrified && pet && pet.at >= fix.start - 50) {
        // Turned to stone WHILE this fixation was still open — the look that
        // finished the job. Usually the last fixation before petrifying ends
        // after the event, so it has to be credited here, not left pending.
        kind = "petrified"; by = pet.by;
      } else if (blob.petrified) {
        kind = "stone";               // looking at an eye already turned
      } else {
        kind = "live";                // may still be petrified later
      }
    }

    const rec = {
      id: A.nextId++, p: player.id,
      x: fix.x, y: fix.y, u: fix.x / width, v: fix.y / height,
      dur: Math.round(fix.duration), start: Math.round(fix.start), end: Math.round(fix.end),
      blob: blobId || null, kind, by,
    };
    A.fixations.push(rec);
    if (kind === "live") {
      if (!A.pending.has(blobId)) A.pending.set(blobId, []);
      A.pending.get(blobId).push(rec.id);
    }
    post({ type: "fixation", fix: rec });
  }

  // When an eye turns to stone, every look it received during that life was
  // spent petrifying it — whoever made the final stare.
  window.addEventListener("blob-petrified", (ev) => {
    const { blobId, pointerId } = ev.detail || {};
    const player = playerOf(pointerId);
    const at = performance.now();
    A.petrifiedAt.set(blobId, { at, by: player ? player.id : null });
    const ids = A.pending.get(blobId) || [];
    for (const id of ids) {
      const f = A.fixations.find((x) => x.id === id);
      if (f) { f.kind = "petrified"; f.by = player ? player.id : null; }
    }
    A.pending.delete(blobId);
    // The page's own listener was registered first and has already counted
    // the point, so the scores read here include this petrification.
    post({ type: "petrify", blobId, by: player ? player.id : null, fixIds: ids, scores: { ...scores } });
  });

  // ---------------------------------------------------- per-frame analysis
  let lastGaze = 0;

  function afterDraw() {
    if (typeof started === "undefined" || !started) return;
    const now = performance.now();
    const pointers = Tracking.getPointers();   // already updated by sketch.js this frame
    const seen = new Set();
    const live = [];

    for (const ptr of pointers) {
      const player = playerOf(ptr.id);
      if (!player || !Number.isFinite(ptr.x)) continue;
      seen.add(ptr.id);
      const e = entryFor(ptr.id);

      e.focusLog.push({ t: now, blob: (typeof focus !== "undefined" && focus.get(ptr.id)) || null });
      while (e.focusLog.length && now - e.focusLog[0].t > FOCUS_LOG_MS) e.focusLog.shift();

      const m = e.med.push(ptr.rawX ?? ptr.x, ptr.rawY ?? ptr.y);
      const inside = m.x >= 0 && m.x <= width && m.y >= 0 && m.y <= height;
      const closed = inside ? e.det.push(now, m.x, m.y) : e.det.flush();
      if (closed) finalize(e, ptr.id, player, closed);

      const cur = inside ? e.det.current() : null;
      live.push({
        p: player.id, u: m.x / width, v: m.y / height,
        fu: cur ? cur.x / width : null, fv: cur ? cur.y / height : null, fd: cur ? Math.round(cur.duration) : 0,
      });
    }

    for (const [pid, e] of entries) {
      if (seen.has(pid)) continue;
      const f = e.det.flush();
      e.med.reset();
      const player = playerOf(pid);
      if (f && player) finalize(e, pid, player, f);
    }

    if (now - lastGaze > 33) {
      lastGaze = now;
      post({
        type: "gaze", pts: live,
        blobs: blobs.map((b) => ({ id: b.id, u: b.pos.x / width, v: b.pos.y / height, r: b.radius / width, s: !!b.petrified })),
        view: { w: width, h: height },
      });
    }
    maybeSnapshotBackground(now);
  }

  // p5 calls registered "post" methods after every draw(). Registered before
  // p5 initialises, so the game's own draw loop stays exactly as written.
  if (window.p5 && p5.prototype.registerMethod) p5.prototype.registerMethod("post", afterDraw);

  // --------------------------------------------------- background snapshot
  // The fourth quadrant shows the game's background with no eyes on it. The
  // frame is copied from inside the game's own fur.display(): at that instant
  // the canvas holds the background and fur and nothing else, because the
  // eyes are drawn after it. The fur is wrapped, not edited.
  let furWrapped = false, wantSnapshot = true, lastSnapshot = 0;

  function wrapFur() {
    if (furWrapped || typeof fur === "undefined" || !fur || !fur.display) return;
    const original = fur.display.bind(fur);
    fur.display = function () {
      original();
      if (wantSnapshot) { wantSnapshot = false; sendBackground(true); }
    };
    furWrapped = true;
  }

  function sendBackground(withFur) {
    const src = drawingContext.canvas;
    const scale = Math.min(1, 960 / src.width);
    const c = document.createElement("canvas");
    c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
    const ctx = c.getContext("2d");
    if (withFur) ctx.drawImage(src, 0, 0, c.width, c.height);
    else { ctx.fillStyle = "rgb(8,10,16)"; ctx.fillRect(0, 0, c.width, c.height); }
    post({ type: "background", url: c.toDataURL("image/jpeg", 0.82), w: width, h: height });
    lastSnapshot = performance.now();
  }

  function maybeSnapshotBackground(now) {
    wrapFur();
    // Refresh now and then: the fur is alive, and the window may be resized.
    if (now - lastSnapshot > 15000 && now - A.roundStart > 1500) {
      if (typeof furEnabled !== "undefined" && !furEnabled) sendBackground(false);
      else wantSnapshot = true;
    }
  }

  window.addEventListener("resize", () => { wantSnapshot = true; lastSnapshot = 0; });

  // ------------------------------------------------------------- snapshot
  function broadcastSnapshot() {
    post({
      type: "snapshot",
      started: typeof started !== "undefined" && started,
      players: PLAYERS.map(({ id, label, color }) => ({ id, label, color })),
      scores: { ...scores },
      fixations: A.fixations,
      eyes: blobs.length,
      view: { w: width || innerWidth, h: height || innerHeight },
      roundStartedMsAgo: Math.round(performance.now() - A.roundStart),
      settings: { spreadPct: SPREAD_PCT, minDurationMs: MIN_FIX_MS },
    });
    lastSnapshot = 0;   // and send a fresh background with it
  }

  // New round: scores to zero, every stone back to life, analysis cleared.
  // Clearing analysis without the score (or the reverse) would leave the
  // second screen describing a game that is no longer the one on screen.
  function newRound() {
    for (const k of Object.keys(scores)) scores[k] = 0;
    blobs.forEach((b) => b.unpetrify());
    A.fixations = []; A.pending.clear(); A.petrifiedAt.clear();
    A.roundStart = performance.now();
    for (const e of entries.values()) { e.det.reset(); e.med.reset(); e.focusLog = []; }
    if (typeof renderPanel === "function" && typeof lastList !== "undefined") renderPanel(lastList);
    broadcastSnapshot();
  }

  function openObserver() {
    window.open("medusa-analysis-observer.html", "medusa-analysis", "popup=yes,width=1280,height=800");
  }

  if (bus) {
    bus.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "hello") broadcastSnapshot();
      else if (m.type === "cmd" && m.cmd === "newRound") newRound();
    };
  }

  document.getElementById("maObserver").onclick = openObserver;
  document.getElementById("maObserverBoot").onclick = openObserver;
  document.getElementById("maNewRound").onclick = newRound;
  window.addEventListener("keydown", (e) => { if (e.key === "o" || e.key === "O") openObserver(); });

  // The observer learns the session started from the next snapshot.
  const startBtns = ["mpStart", "mpSim"].map((id) => document.getElementById(id));
  startBtns.forEach((b) => b && b.addEventListener("click", () => {
    A.roundStart = performance.now();
    setTimeout(broadcastSnapshot, 400);
  }));

  window.MedusaAnalysis = { state: A, newRound, broadcastSnapshot, openObserver };
})();
