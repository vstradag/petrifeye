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
    petrifications: [],   // every petrification this round, for the export
    ended: false,
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
    A.petrifications.push({ at, blobId, by: player ? player.id : null });
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
    if (typeof started === "undefined" || !started || A.ended) return;
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
      roundStartedMsAgo: Math.round((A.sessionEndedPerf || performance.now()) - A.roundStart),
      ended: A.ended,
      calibration: calibrationSummary(),
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
    A.fixations = []; A.pending.clear(); A.petrifiedAt.clear(); A.petrifications = [];
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

  // The game proper starts only after calibration. Starting a clean round
  // HERE matters: the game runs underneath the start card and calibration,
  // so gaze resting on an eye back there could petrify it — and the session
  // would begin with a score nobody earned.
  window.addEventListener("medusa-session-start", () => {
    A.sessionStartedAt = new Date();
    newRound();
  });

  // ------------------------------------------------------ calibration info
  function calibrationSummary() {
    const cal = typeof calibration !== "undefined" ? calibration : null;
    if (!cal || !cal.result) return null;
    if (cal.result.skipped) return { skipped: true };
    const byPlayer = {};
    for (const [id, r] of Object.entries(cal.result.byPlayer)) {
      byPlayer[id] = {
        input: r.input, usablePoints: r.usable,
        errorBeforePx: r.errBefore != null ? Math.round(r.errBefore) : null,
        errorAfterPx: r.errAfter != null ? Math.round(r.errAfter) : null,
        correction: r.model ? r.model.type : "none",
        model: r.model, points: r.points,
      };
    }
    return { skipped: false, applied: cal.enabled, screen: cal.result.screen, byPlayer };
  }

  const corrBox = document.getElementById("toggle-correction");
  if (corrBox) corrBox.onchange = (e) => {
    if (typeof calibration !== "undefined") calibration.enabled = e.target.checked;
    broadcastSnapshot();
  };

  // ----------------------------------------------------------- end session
  // Two clicks, three seconds apart at most: the gear panel sits among other
  // controls, and ending a live session is not something to do by accident.
  const endBtn = document.getElementById("maEnd");
  let armTimer = null;
  if (endBtn) endBtn.onclick = () => {
    if (!endBtn.classList.contains("armed")) {
      endBtn.classList.add("armed");
      endBtn.textContent = "click again to end";
      armTimer = setTimeout(() => { endBtn.classList.remove("armed"); endBtn.textContent = "end session"; }, 3000);
      return;
    }
    clearTimeout(armTimer);
    endSession();
  };

  // What each fixation was on, in words that survive being opened elsewhere.
  const EXPORT_KIND = {
    petrified: "petrifying",          // on an eye during the life it turned to stone
    stone: "stone",                   // on an eye already turned
    live: "eye_not_petrified",        // on an eye that did not turn in that life
  };

  function fixRegion(f) { return `${f.v < 0.5 ? "top" : "bottom"}-${f.u < 0.5 ? "left" : "right"}`; }

  function sessionData() {
    const t0 = A.roundStart;
    const seqPrev = new Map();
    const inputs = {};
    for (const p of PLAYERS) {
      const ag = window.GazeAggregator ? GazeAggregator.players().find((x) => x.id === p.id) : null;
      inputs[p.id] = simMode ? (p.id === 0 ? "mouse" : "arrows") : ((ag && ag.source) || "neon");
    }
    const fixations = A.fixations.slice().sort((a, b) => a.start - b.start).map((f) => {
      const prev = seqPrev.get(f.p);
      const saccade = prev ? Math.hypot(f.x - prev.x, f.y - prev.y) : null;
      seqPrev.set(f.p, f);
      return {
        id: f.id, player: `P${f.p + 1}`, input: inputs[f.p],
        start_ms: Math.round(f.start - t0), end_ms: Math.round(f.end - t0), duration_ms: f.dur,
        x_px: Math.round(f.x), y_px: Math.round(f.y), u: +f.u.toFixed(4), v: +f.v.toFixed(4),
        region: fixRegion(f), eye: f.blob || "", kind: EXPORT_KIND[f.kind] || "no_eye",
        petrified_by: f.by != null ? `P${f.by + 1}` : "",
        saccade_in_px: saccade != null ? Math.round(saccade) : "",
      };
    });
    return {
      app: "MEDUSA (+2 players) with second screen analysis",
      startedAt: (A.sessionStartedAt || new Date(Date.now() - (performance.now() - t0))).toISOString(),
      endedAt: (A.sessionEndedAt || new Date()).toISOString(),
      durationMs: Math.round((A.sessionEndedPerf || performance.now()) - t0),
      screen: { width, height },
      players: PLAYERS.map((p) => ({ id: `P${p.id + 1}`, input: inputs[p.id] })),
      scores: Object.fromEntries(PLAYERS.map((p) => [`P${p.id + 1}`, scores[p.id] || 0])),
      settings: { fixationSpreadPctOfWidth: SPREAD_PCT, minFixationMs: MIN_FIX_MS, dwellToPetrifyS: typeof DWELL_SECONDS !== "undefined" ? DWELL_SECONDS : null },
      calibration: calibrationSummary(),
      petrifications: A.petrifications.map((e) => ({ at_ms: Math.round(e.at - t0), eye: e.blobId, by: e.by != null ? `P${e.by + 1}` : "" })),
      fixations,
    };
  }

  function toCSV(rows) {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
    const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function stamp(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  }

  function endSession() {
    if (A.ended) return;
    // Close every open fixation first, so the last looks are in the record.
    for (const [pid, e] of entries) {
      const f = e.det.flush();
      const player = playerOf(pid);
      if (f && player) finalize(e, pid, player, f);
    }
    A.ended = true;
    A.sessionEndedAt = new Date();
    A.sessionEndedPerf = performance.now();
    if (typeof noLoop === "function") noLoop();          // freeze the game where it stands
    if (window.GazeAggregator) GazeAggregator.setPublishing(false);

    const data = sessionData();
    post({ type: "session-ended", summary: { durationMs: data.durationMs, scores: data.scores } });
    broadcastSnapshot();

    const mins = Math.floor(data.durationMs / 60000), secs = Math.floor((data.durationMs % 60000) / 1000);
    const layer = document.createElement("div");
    layer.id = "maEndLayer";
    layer.style.cssText = "position:fixed;inset:0;z-index:1400;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;text-align:center;font-family:var(--gaze-mono)";
    layer.innerHTML = `
      <div style="max-width:620px;padding:30px">
        <h1 style="font-size:28px;font-weight:200;letter-spacing:.34em;margin:0 0 6px;color:#e8e6e2">SESSION <span style="color:var(--gaze-red)">ENDED</span></h1>
        <p style="font-size:11px;letter-spacing:.3em;color:#6a6a6a;margin:0 0 30px">${mins}:${String(secs).padStart(2, "0")} · ${data.fixations.length} fixations recorded</p>
        <div style="display:flex;justify-content:center;gap:60px;margin:0 0 34px">
          ${PLAYERS.map((p) => `<div><div style="color:${p.color};letter-spacing:.3em;font-size:12px">${p.label}</div>
            <div style="font-size:72px;font-weight:200;color:#f0eee9;line-height:1.1">${scores[p.id] || 0}</div>
            <div style="font-size:10px;color:#6f6d6a">eyes petrified</div></div>`).join("")}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center">
          <button class="mp-btn" id="maDlCsv">download fixations (csv)</button>
          <button class="mp-btn" id="maDlJson">download full session (json)</button>
        </div>
        <div style="margin-top:14px">
          <button class="mp-btn ghost" id="maNewSession" style="margin:0">new session</button>
          <button class="mp-btn ghost" id="maMenu">back to menu</button>
        </div>
        <p style="font-size:10.5px;line-height:1.7;color:#5a5856;margin-top:22px">
          Nothing is saved unless you download it — a new session or a reload starts from empty.</p>
      </div>`;
    document.body.appendChild(layer);
    const name = `medusa-session_${stamp(A.sessionEndedAt)}`;
    layer.querySelector("#maDlCsv").onclick = () => download(`${name}_fixations.csv`, toCSV(data.fixations), "text/csv");
    layer.querySelector("#maDlJson").onclick = () => download(`${name}.json`, JSON.stringify(data, null, 2), "application/json");
    layer.querySelector("#maNewSession").onclick = () => location.reload();
    layer.querySelector("#maMenu").onclick = () => { location.href = "../index.html"; };
  }

  window.MedusaAnalysis = { state: A, newRound, broadcastSnapshot, openObserver, endSession, sessionData, toCSV };
})();
