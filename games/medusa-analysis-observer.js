// MEDUSA (+2 players) with second screen analysis — the analysis screen.
//
//   top-left     the live game with each player's scanpath
//   top-right    the score: eyes petrified per player
//   bottom-left  the looking that went into petrifying eyes
//   bottom-right the game screen split into four hidden regions, with the
//                looking spent in each drawn over the game's background
//
// Never connects to a bridge (see medusa-analysis.js for why). Everything
// arrives from the game window over a BroadcastChannel.
(function () {
  const CHANNEL = "medusa-analysis";
  const TRAIL_MS = 1500;
  const SCANPATH_SHOWN = 30;
  const NUMBERED = 12;
  const SCANPATH_VEIL = 0.22;
  const REGIONS = [
    { key: "tl", label: "top-left",     c: 0, r: 0 },
    { key: "tr", label: "top-right",    c: 1, r: 0 },
    { key: "bl", label: "bottom-left",  c: 0, r: 1 },
    { key: "br", label: "bottom-right", c: 1, r: 1 },
  ];

  const $ = (id) => document.getElementById(id);
  const bus = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;

  const S = {
    connected: false, started: false,
    players: [], scores: {}, fixations: [], eyes: 9,
    view: { w: 1920, h: 1080 },
    settings: { spreadPct: 3.5, minDurationMs: 100 },
    roundStart: performance.now(),
    live: new Map(),        // player id -> { u, v, fu, fv, fd, at, trail }
    blobs: [],              // latest eyes: { id, u, v, r, s }
    background: null,       // Image of the game with no eyes
    calibration: null,      // per-player accuracy from the nine-point screen
    ended: false,
  };
  let statsDirty = true, regionsDirty = true;

  // --------------------------------------------------------------- helpers
  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; }
    return false;
  }
  function containRect(cw, ch, aspect, pad) {
    const w0 = cw - 2 * pad, h0 = ch - 2 * pad;
    let w = w0, h = w0 / aspect;
    if (h > h0) { h = h0; w = h0 * aspect; }
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const fmt = (v, d = 0) => Number.isFinite(v)
    ? v.toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—";
  const aspect = () => S.view.w / S.view.h;

  // Distances in the GAME SCREEN's pixels.
  const dist = (a, b) => Math.hypot((a.u - b.u) * S.view.w, (a.v - b.v) * S.view.h);

  // Per-player fixation sequences, in time order. Saccades are measured only
  // between consecutive fixations of the SAME person — joining one player's
  // look to another's would invent a movement nobody made.
  function byPlayer() {
    const m = new Map(S.players.map((p) => [p.id, []]));
    for (const f of S.fixations) if (m.has(f.p)) m.get(f.p).push(f);
    for (const list of m.values()) list.sort((a, b) => a.start - b.start);
    return m;
  }

  // The saccade that LANDS on each fixation, keyed by fixation id.
  function landingSaccades(seqs) {
    const land = new Map();
    for (const list of seqs.values())
      for (let i = 1; i < list.length; i++) land.set(list[i].id, dist(list[i - 1], list[i]));
    return land;
  }

  // ------------------------------------------------------- Q1 live game
  function gameCanvas() {
    // Opened from the game, this window can read the game's own canvas and
    // draw the real thing, every frame. Opened any other way, there is no
    // opener and it falls back to a schematic of the eyes over the background.
    try {
      const doc = window.opener && !window.opener.closed && window.opener.document;
      return (doc && doc.querySelector("canvas")) || null;
    } catch (_) { return null; }
  }

  function drawGame() {
    const c = $("q1");
    fitCanvas(c);
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#07080b"; ctx.fillRect(0, 0, c.width, c.height);
    const r = containRect(c.width, c.height, aspect(), 10 * dpr);
    const X = (u) => r.x + u * r.w, Y = (v) => r.y + v * r.h;

    const live = gameCanvas();
    if (live && live.width) {
      ctx.drawImage(live, r.x, r.y, r.w, r.h);
      $("q1Mode").textContent = "live game";
    } else {
      if (S.background) ctx.drawImage(S.background, r.x, r.y, r.w, r.h);
      for (const b of S.blobs) {
        const rad = Math.max(3, b.r * r.w);
        ctx.beginPath(); ctx.arc(X(b.u), Y(b.v), rad, 0, Math.PI * 2);
        ctx.fillStyle = b.s ? "#8f8b82" : "#f1ede4"; ctx.fill();
        if (!b.s) { ctx.beginPath(); ctx.arc(X(b.u), Y(b.v), rad * 0.35, 0, Math.PI * 2); ctx.fillStyle = "#111"; ctx.fill(); }
      }
      $("q1Mode").textContent = "schematic — open this screen from the game to see it live";
    }
    ctx.strokeStyle = "#23252c"; ctx.lineWidth = dpr; ctx.strokeRect(r.x, r.y, r.w, r.h);

    ctx.fillStyle = `rgba(0,0,0,${SCANPATH_VEIL})`; ctx.fillRect(r.x, r.y, r.w, r.h);
    const k = dpr * Math.max(1, r.w / dpr / 640);
    const radiusFor = (dur) => Math.min(30, Math.max(8, 5 + Math.sqrt(dur) * 0.9)) * k;
    const haloLine = (x0, y0, x1, y1, color, width, alpha) => {
      ctx.lineCap = "round";
      ctx.strokeStyle = `rgba(0,0,0,${0.8 * alpha})`; ctx.lineWidth = width + 3.5 * k;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = hexA(color, alpha); ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    };
    const now = performance.now();
    const seqs = byPlayer();

    for (const pl of S.players) {
      const mine = seqs.get(pl.id) || [];
      const shown = mine.slice(-SCANPATH_SHOWN);
      const offset = mine.length - shown.length;
      for (let i = 1; i < shown.length; i++) {
        const a = 0.35 + 0.65 * (i / shown.length);
        haloLine(X(shown[i - 1].u), Y(shown[i - 1].v), X(shown[i].u), Y(shown[i].v), pl.color, 3 * k, a);
      }
      shown.forEach((f, i) => {
        const a = 0.45 + 0.55 * ((i + 1) / shown.length);
        const x = X(f.u), y = Y(f.v), rad = radiusFor(f.dur);
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fillStyle = hexA(pl.color, 0.62 * a); ctx.fill();
        ctx.lineWidth = 4 * k; ctx.strokeStyle = `rgba(0,0,0,${0.8 * a})`; ctx.stroke();
        // A fixation that went into petrifying an eye gets a stone-grey ring.
        ctx.lineWidth = 2 * k;
        ctx.strokeStyle = f.kind === "petrified" ? `rgba(205,200,188,${a})` : `rgba(255,255,255,${0.9 * a})`;
        ctx.stroke();
        if (i >= shown.length - NUMBERED) {
          ctx.font = `700 ${Math.round(12 * k)}px ui-monospace, Menlo, monospace`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.lineWidth = 3.5 * k; ctx.strokeStyle = "rgba(0,0,0,.9)";
          const label = String(offset + i + 1);
          ctx.strokeText(label, x, y); ctx.fillStyle = "#fff"; ctx.fillText(label, x, y);
        }
      });

      const l = S.live.get(pl.id);
      if (!l || now - l.at > 1000) continue;
      const trail = l.trail.filter((t) => now - t.at < TRAIL_MS);
      for (let i = 1; i < trail.length; i++) {
        const age = (now - trail[i].at) / TRAIL_MS;
        haloLine(X(trail[i - 1].u), Y(trail[i - 1].v), X(trail[i].u), Y(trail[i].v), pl.color, 2 * k, 0.85 * (1 - age));
      }
      if (l.fu != null) {
        ctx.setLineDash([5 * k, 4 * k]);
        ctx.beginPath(); ctx.arc(X(l.fu), Y(l.fv), radiusFor(l.fd), 0, Math.PI * 2);
        ctx.lineWidth = 5 * k; ctx.strokeStyle = "rgba(0,0,0,.75)"; ctx.stroke();
        ctx.lineWidth = 2.5 * k; ctx.strokeStyle = pl.color; ctx.stroke();
        ctx.setLineDash([]);
      }
      if (l.u >= 0 && l.u <= 1 && l.v >= 0 && l.v <= 1) {
        const x = X(l.u), y = Y(l.v), rr = 11 * k, arm = 17 * k;
        for (const [w, col] of [[6 * k, "rgba(0,0,0,.8)"], [2.5 * k, pl.color]]) {
          ctx.lineWidth = w; ctx.strokeStyle = col;
          ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y); ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm); ctx.stroke();
        }
      }
    }
  }

  // ------------------------------------------------------------ Q2 score
  function renderScore() {
    const vals = S.players.map((p) => S.scores[p.id] || 0);
    const best = Math.max(0, ...vals);
    const total = vals.reduce((a, b) => a + b, 0);
    const stones = S.blobs.length ? S.blobs.filter((b) => b.s).length : 0;
    const eyes = S.blobs.length || S.eyes;
    $("q2").innerHTML = `
      <div class="score-row">
        ${S.players.map((p) => {
          const v = S.scores[p.id] || 0;
          return `<div class="score-cell">
            <div class="score-name" style="color:${p.color}">${p.label}</div>
            <div class="score-num${v === best && v > 0 ? " score-lead" : ""}" style="color:${v === best && v > 0 ? "#fff" : "#d9d7d3"}">${v}</div>
          </div>`;
        }).join("")}
      </div>
      <div class="score-foot">
        ${total} eye${total === 1 ? "" : "s"} petrified this round
        <span class="stones">${Array.from({ length: eyes }, (_, i) => `<span class="stone${i < stones ? " on" : ""}"></span>`).join("")}</span>
        <div class="score-sub">${stones} of ${eyes} are stone right now — stones come back to life after 10s</div>
        ${calibrationLine()}
      </div>`;
    const s = Math.floor((performance.now() - S.roundStart) / 1000);
    const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    $("q2Clock").textContent = S.ended ? `session ended · ${S.endedClock || clock}` : S.started ? `round ${clock}` : "";
  }

  // Accuracy is the context for every number on this screen: 20px of error
  // and 80px of error make "looked at the eye" mean very different things.
  function calibrationLine() {
    const c = S.calibration;
    if (!c) return "";
    if (c.skipped) return `<div class="score-sub">calibration skipped</div>`;
    const parts = S.players.map((p) => {
      const r = c.byPlayer[p.id];
      if (!r || r.errorBeforePx == null) return `<span style="color:${p.color}">${p.label}</span> no data`;
      const after = r.correction !== "none" && c.applied ? ` → ~${r.errorAfterPx}px` : "";
      return `<span style="color:${p.color}">${p.label}</span> ${r.errorBeforePx}px${after}`;
    });
    return `<div class="score-sub">calibration error · ${parts.join(" · ")}${c.applied ? "" : " · correction off"}</div>`;
  }

  // ------------------------------------------------ Q3 petrifying stats
  function renderPetrifying() {
    const seqs = byPlayer();
    const land = landingSaccades(seqs);
    const rows = S.players.map((p) => {
      const mine = seqs.get(p.id) || [];
      const pet = mine.filter((f) => f.kind === "petrified");
      const allDur = mine.reduce((a, f) => a + f.dur, 0);
      const petDur = pet.reduce((a, f) => a + f.dur, 0);
      return {
        n: pet.length, petDur, allDur,
        path: pet.reduce((a, f) => a + (land.get(f.id) || 0), 0),
        score: S.scores[p.id] || 0,
        rival: pet.filter((f) => f.by != null && f.by !== p.id).length,
        stones: mine.filter((f) => f.kind === "stone").length,
      };
    });
    const tot = rows.reduce((a, r) => ({
      n: a.n + r.n, petDur: a.petDur + r.petDur, allDur: a.allDur + r.allDur, path: a.path + r.path,
      score: a.score + r.score, rival: a.rival + r.rival, stones: a.stones + r.stones,
    }), { n: 0, petDur: 0, allDur: 0, path: 0, score: 0, rival: 0, stones: 0 });

    const cell = (v, unit) => `<span class="big">${v}</span>${unit ? `<span class="unit">${unit}</span>` : ""}`;
    const row = (label, pick, unit, cls = "") =>
      `<tr class="${cls}"><td>${label}</td>${rows.map((r) => `<td>${cell(pick(r), unit)}</td>`).join("")}<td>${cell(pick(tot), unit)}</td></tr>`;

    $("q3").innerHTML = `
      <table>
        <tr><th></th>${S.players.map((p) => `<th style="color:${p.color}">${p.label}</th>`).join("")}<th>all</th></tr>
        ${row("fixations petrifying eyes", (r) => fmt(r.n))}
        ${row("average fixation", (r) => r.n ? fmt(r.petDur / r.n) : "—", "ms")}
        ${row("scanpath length", (r) => r.n ? fmt(r.path) : "—", "px")}
        ${row("time spent petrifying", (r) => r.n ? fmt(r.petDur / 1000, 1) : "—", "s", "secondary")}
        ${row("share of all looking", (r) => r.allDur ? fmt(100 * r.petDur / r.allDur) : "—", "%", "secondary")}
        ${row("looking per eye petrified", (r) => r.score ? fmt(r.petDur / 1000 / r.score, 1) : "—", "s", "secondary")}
        ${row("on eyes the rival petrified", (r) => fmt(r.rival), "", "secondary")}
      </table>
      <div class="foot">
        Petrifying: looks at an eye during the life in which it turned to stone, whoever finished it.
        Scanpath: eye movement landing on those looks, in game-screen px (${S.view.w}×${S.view.h}).
        Eyes drift, so one stare can count as two fixations — time is steadier than count.
      </div>`;
  }

  // ------------------------------------------------------- Q4 regions
  function drawRegions() {
    const c = $("q4");
    const resized = fitCanvas(c);
    if (!regionsDirty && !resized) return;
    regionsDirty = false;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#07080b"; ctx.fillRect(0, 0, c.width, c.height);
    const r = containRect(c.width, c.height, aspect(), 10 * dpr);
    if (S.background) ctx.drawImage(S.background, r.x, r.y, r.w, r.h);
    else { ctx.fillStyle = "rgb(8,10,16)"; ctx.fillRect(r.x, r.y, r.w, r.h); }

    const seqs = byPlayer();
    const land = landingSaccades(seqs);
    const regionOf = (f) => `${f.v < 0.5 ? "t" : "b"}${f.u < 0.5 ? "l" : "r"}`;
    const stat = {};
    for (const R of REGIONS) stat[R.key] = { dur: 0, byP: new Map(S.players.map((p) => [p.id, { n: 0, dur: 0, path: 0 }])) };
    let grand = 0;
    for (const f of S.fixations) {
      const s = stat[regionOf(f)];
      s.dur += f.dur; grand += f.dur;
      const ps = s.byP.get(f.p);
      if (ps) { ps.n++; ps.dur += f.dur; ps.path += land.get(f.id) || 0; }
    }
    const maxDur = Math.max(1, ...REGIONS.map((R) => stat[R.key].dur));

    const cw = r.w / 2, ch = r.h / 2;
    const unit = Math.min(cw, ch) / 150;       // text scales with the subquadrant
    for (const R of REGIONS) {
      const s = stat[R.key];
      const x0 = r.x + R.c * cw, y0 = r.y + R.r * ch;
      // The more of the looking a region took, the less it is veiled: the
      // busiest part of the screen is literally the brightest.
      ctx.fillStyle = `rgba(0,0,0,${0.72 - 0.42 * (s.dur / maxDur)})`;
      ctx.fillRect(x0, y0, cw, ch);

      const cx = x0 + cw / 2;
      let y = y0 + ch * 0.2;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(233,231,226,.6)";
      ctx.font = `500 ${Math.round(9.5 * unit)}px ui-monospace, Menlo, monospace`;
      ctx.fillText(R.label.toUpperCase().split("").join(" "), cx, y);

      y += 26 * unit;
      ctx.fillStyle = "#f4f2ed";
      ctx.font = `200 ${Math.round(34 * unit)}px ui-monospace, Menlo, monospace`;
      ctx.fillText(grand ? `${Math.round((100 * s.dur) / grand)}%` : "—", cx, y);
      y += 19 * unit;
      ctx.fillStyle = "rgba(233,231,226,.7)";
      ctx.font = `400 ${Math.round(10 * unit)}px ui-monospace, Menlo, monospace`;
      ctx.fillText(`${fmt(s.dur / 1000, 1)} s of looking`, cx, y);

      y += 21 * unit;
      ctx.font = `500 ${Math.round(10.5 * unit)}px ui-monospace, Menlo, monospace`;
      for (const p of S.players) {
        const ps = s.byP.get(p.id);
        const txt = ps.n
          ? `${p.label}  ${ps.n} fix · ${fmt(ps.dur / ps.n)} ms · ${fmt(ps.path)} px`
          : `${p.label}  —`;
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = "rgba(0,0,0,.85)";
        ctx.strokeText(txt, cx, y);
        ctx.fillStyle = p.color; ctx.fillText(txt, cx, y);
        y += 16 * unit;
      }
    }
    // The hidden division, shown only here.
    ctx.strokeStyle = "rgba(233,231,226,.35)"; ctx.lineWidth = 1.2 * dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.moveTo(r.x + cw, r.y); ctx.lineTo(r.x + cw, r.y + r.h);
    ctx.moveTo(r.x, r.y + ch); ctx.lineTo(r.x + r.w, r.y + ch);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = "#23252c"; ctx.strokeRect(r.x, r.y, r.w, r.h);
    $("q4Note").textContent = "average fixation · scanpath length per player";
  }

  // ------------------------------------------------------------ messages
  function onMessage(m) {
    if (!m || !m.type) return;
    if (m.type === "snapshot") {
      S.connected = true;
      S.started = !!m.started;
      S.players = m.players || [];
      S.scores = m.scores || {};
      S.fixations = m.fixations || [];
      S.eyes = m.eyes || S.eyes;
      if (m.view && m.view.w) S.view = m.view;
      S.settings = m.settings || S.settings;
      S.roundStart = performance.now() - (m.roundStartedMsAgo || 0);
      S.calibration = m.calibration || null;
      S.ended = !!m.ended;
      if (S.ended) {
        const t = Math.floor((m.roundStartedMsAgo || 0) / 1000);
        S.endedClock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
      }
      S.live.clear();
      $("waiting").classList.toggle("hidden", S.started);
      $("waitingMsg").innerHTML = S.started ? "" :
        "Game screen found, not started yet.<br />Press <b>start</b> (or the mouse test) on the game screen.";
      statsDirty = regionsDirty = true;
    } else if (m.type === "fixation") {
      S.fixations.push(m.fix);
      statsDirty = regionsDirty = true;
    } else if (m.type === "petrify") {
      const ids = new Set(m.fixIds || []);
      for (const f of S.fixations) if (ids.has(f.id)) { f.kind = "petrified"; f.by = m.by; }
      if (m.scores) S.scores = m.scores;
      statsDirty = regionsDirty = true;
    } else if (m.type === "gaze") {
      if (S.ended) return;
      const now = performance.now();
      if (m.view && m.view.w) S.view = m.view;
      S.blobs = m.blobs || S.blobs;
      for (const g of m.pts || []) {
        let l = S.live.get(g.p);
        if (!l) { l = { trail: [] }; S.live.set(g.p, l); }
        Object.assign(l, g, { at: now });
        l.trail.push({ u: g.u, v: g.v, at: now });
        while (l.trail.length && now - l.trail[0].at > TRAIL_MS) l.trail.shift();
      }
    } else if (m.type === "session-ended") {
      // Keep everything on screen as the final record; only the live markers go.
      S.ended = true;
      S.live.clear();
      statsDirty = regionsDirty = true;
    } else if (m.type === "background" && m.url) {
      const img = new Image();
      img.onload = () => { S.background = img; regionsDirty = true; };
      img.src = m.url;
    }
  }

  if (bus) bus.onmessage = (e) => onMessage(e.data);
  else $("waitingMsg").textContent = "This browser has no BroadcastChannel — use a current Chrome, Edge, Firefox or Safari.";

  const hello = () => bus && bus.postMessage({ type: "hello" });
  hello();
  setInterval(() => { if (!S.connected) hello(); }, 1000);

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "x" && bus) bus.postMessage({ type: "cmd", cmd: "newRound" });
    else if (k === "f") fullscreen();
  });
  document.addEventListener("dblclick", fullscreen);
  window.addEventListener("resize", () => { statsDirty = regionsDirty = true; });

  let lastStats = 0;
  function frame() {
    drawGame();
    drawRegions();
    const now = performance.now();
    if (statsDirty || now - lastStats > 500) {
      renderScore(); renderPetrifying();
      statsDirty = false; lastStats = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.MedusaAnalysisObserver = {
    state: S,
    renderNow: () => { regionsDirty = true; drawGame(); drawRegions(); renderScore(); renderPetrifying(); },
  };
})();
