// Nine-point calibration screen for multi-player gaze sessions.
//
// What it does depends on the input, because "calibration" means different
// things for each:
//
//   Neon glasses  Calibration-free by design — nothing to train. What CAN go
//                 wrong is the screen mapping: the AprilTag surface and the
//                 wearer's fit leave a consistent error on screen. So this
//                 MEASURES each player's gaze against nine known points and
//                 fits a correction for the consistent part of the error.
//   Webcam        WebGazer's regression is untrained until it sees gaze paired
//                 with clicks, so each point waits for clicks. Its error is
//                 measured on the points it was trained on, which flatters it,
//                 so no correction is fitted on top.
//   Mouse         Exact already; the screen still runs so the flow can be
//                 tested without hardware.
//
// THE CORRECTION, AND WHY IT IS CHOSEN BY LEAVE-ONE-OUT
//
// Two models are fitted per player: a plain offset (2 parameters) and an
// affine map (6 — offset, scale, shear). With nine noisy points an affine fit
// always matches the points it was fitted to at least as well as an offset,
// which proves nothing: it may simply be bending to noise, and then it makes
// the EDGES of the screen worse. So each model is scored by leaving each
// point out in turn, fitting on the other eight, and measuring the error on
// the one left out. That is an honest estimate of the error the player will
// actually have during play. A model is used only if it beats the next
// simpler one by at least 10% on that score; otherwise nothing is corrected.
//
//   NinePointCalibration.run({ players, readPointers, playerOfPointer, ... })
//     -> Promise<{ skipped, byPlayer: { [id]: { input, points, errBefore,
//                  errAfter, model } } }>
//   NinePointCalibration.apply(model, x, y) -> { x, y }
(function () {
  const ORDER = ["C", "TL", "TC", "TR", "MR", "BR", "BC", "BL", "ML"];
  const SETTLE_MS = 450;        // eyes travel and land before anything is sampled
  const COLLECT_MS = 1000;      // then this long is averaged per point
  const CLICKS = 4;             // webcam training clicks per point
  const MIN_SAMPLES = 6;
  const IDENTITY = { type: "none", a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };

  // ------------------------------------------------------------- maths
  const median = (arr) => {
    const s = arr.slice().sort((p, q) => p - q), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  function apply(model, x, y) {
    const m = model || IDENTITY;
    return { x: m.a * x + m.b * y + m.c, y: m.d * x + m.e * y + m.f };
  }

  function fitOffset(pts) {
    const dx = mean(pts.map((p) => p.tx - p.mx)), dy = mean(pts.map((p) => p.ty - p.my));
    return { type: "offset", a: 1, b: 0, c: dx, d: 0, e: 1, f: dy };
  }

  // Least squares for x' = a·x + b·y + c (and the same for y'), via the 3×3
  // normal equations. Returns null when the points cannot pin it down.
  function solve3(M, r) {
    const det = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (!Number.isFinite(D) || Math.abs(D) < 1e-6) return null;
    const col = (i) => M.map((row, k) => row.map((v, j) => (j === i ? r[k] : v)));
    return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
  }

  function fitAffine(pts) {
    if (pts.length < 4) return null;
    // Centre the coordinates first: raw pixel values in the thousands make
    // the normal equations badly conditioned for no reason.
    const cx = mean(pts.map((p) => p.mx)), cy = mean(pts.map((p) => p.my));
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rx = [0, 0, 0], ry = [0, 0, 0];
    for (const p of pts) {
      const v = [p.mx - cx, p.my - cy, 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j];
        rx[i] += v[i] * p.tx; ry[i] += v[i] * p.ty;
      }
    }
    const X = solve3(S, rx), Y = solve3(S, ry);
    if (!X || !Y) return null;
    // Undo the centring so the model applies to plain screen coordinates.
    const m = { type: "affine", a: X[0], b: X[1], c: X[2] - X[0] * cx - X[1] * cy,
                d: Y[0], e: Y[1], f: Y[2] - Y[0] * cx - Y[1] * cy };
    // A calibration that says the screen is squashed by half is a failed
    // calibration, not a discovery. Reject anything implausible.
    const sane = m.a > 0.7 && m.a < 1.4 && m.e > 0.7 && m.e < 1.4 && Math.abs(m.b) < 0.25 && Math.abs(m.d) < 0.25;
    return sane ? m : null;
  }

  // Error on the point left out, averaged over all nine: an out-of-sample
  // estimate of how far off this player will be once the model is applied.
  function leaveOneOut(pts, fit) {
    const errs = [];
    for (let i = 0; i < pts.length; i++) {
      const model = fit(pts.filter((_, j) => j !== i));
      if (!model) return Infinity;
      const q = apply(model, pts[i].mx, pts[i].my);
      errs.push(Math.hypot(q.x - pts[i].tx, q.y - pts[i].ty));
    }
    return mean(errs);
  }

  function chooseModel(pts, input) {
    if (!pts.length) return { model: IDENTITY, errBefore: null, errAfter: null };
    const errBefore = mean(pts.map((p) => Math.hypot(p.mx - p.tx, p.my - p.ty)));
    if (input !== "neon" || pts.length < 5) return { model: IDENTITY, errBefore, errAfter: errBefore };
    const offLOO = leaveOneOut(pts, fitOffset);
    const affLOO = leaveOneOut(pts, fitAffine);
    const affine = fitAffine(pts);
    if (affine && affLOO < 0.9 * offLOO && affLOO < 0.9 * errBefore) return { model: affine, errBefore, errAfter: affLOO };
    if (offLOO < 0.9 * errBefore) return { model: fitOffset(pts), errBefore, errAfter: offLOO };
    return { model: IDENTITY, errBefore, errAfter: errBefore };
  }

  // ------------------------------------------------------------- layout
  // Nine points kept CLEAR of the corner tags: a target under a tag would
  // hide the tag the scene camera needs, and put the point where no gaze can
  // be mapped. Clear columns work at any height, so the side columns sit just
  // inside the tag footprint.
  function targetPositions(W, H, footprint) {
    const xL = Math.min(W * 0.35, Math.max(footprint + 60, W * 0.12));
    const x = { L: xL, C: W / 2, R: W - xL };
    const y = { T: H * 0.13, M: H / 2, B: H * 0.87 };
    const at = { C: [x.C, y.M], TL: [x.L, y.T], TC: [x.C, y.T], TR: [x.R, y.T], MR: [x.R, y.M],
                 BR: [x.R, y.B], BC: [x.C, y.B], BL: [x.L, y.B], ML: [x.L, y.M] };
    return ORDER.map((k) => ({ key: k, x: at[k][0], y: at[k][1] }));
  }

  // --------------------------------------------------------------- DOM
  function injectStyles() {
    if (document.getElementById("npc-style")) return;
    const s = document.createElement("style");
    s.id = "npc-style";
    // z-index BELOW the tracking markers (1100): during calibration the Neon
    // scene cameras must see all four tags, or there is no gaze to measure.
    s.textContent = `
      .npc { position:fixed; inset:0; z-index:1080; background:#000; font-family:var(--gaze-mono, ui-monospace, Menlo, monospace); color:#e8e6e2; }
      .npc-msg { position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); text-align:center; pointer-events:none; }
      .npc-msg h2 { font-size:22px; font-weight:200; letter-spacing:.34em; margin:0 0 12px; }
      .npc-msg h2 span { color:#ff3b3b; }
      .npc-msg p { font-size:12px; line-height:1.9; color:#8d8b88; margin:0; }
      .npc-target { position:fixed; width:0; height:0; }
      .npc-ring { position:absolute; left:-22px; top:-22px; width:44px; height:44px; border-radius:50%;
                  border:2px solid #ff3b3b; box-sizing:border-box; animation:npc-shrink 1.1s ease-out forwards; }
      .npc-dot { position:absolute; left:-5px; top:-5px; width:10px; height:10px; border-radius:50%; background:#fff;
                 box-shadow:0 0 12px rgba(255,255,255,.8); }
      .npc-target.clickable { cursor:pointer; }
      .npc-target.clickable .npc-hit { position:absolute; left:-30px; top:-30px; width:60px; height:60px; border-radius:50%; }
      .npc-clicks { position:absolute; left:18px; top:-26px; font-size:12px; color:#ffd9d9; }
      @keyframes npc-shrink { from { transform:scale(2.4); opacity:.2 } to { transform:scale(1); opacity:1 } }
      .npc-count { position:fixed; left:50%; bottom:22px; transform:translateX(-50%); font-size:11px; letter-spacing:.3em; color:#6a6a6a; }
      .npc-skip { position:fixed; right:50%; bottom:52px; transform:translateX(50%); font-family:inherit; font-size:10px;
                  letter-spacing:.24em; text-transform:uppercase; background:transparent; color:#6f6d6a; border:1px solid #2a2c33;
                  padding:7px 16px; cursor:pointer; }
      .npc-skip:hover { color:#e8e6e2; border-color:#666; }
      .npc-results { position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); width:min(760px, 90vw); text-align:center; }
      .npc-results h2 { font-size:20px; font-weight:200; letter-spacing:.3em; margin:0 0 18px; }
      .npc-results canvas { width:100%; aspect-ratio:16/9; background:#07080b; border:1px solid #23252c; display:block; }
      .npc-rows { margin:16px 0 20px; font-size:12.5px; line-height:2; text-align:left; display:inline-block; }
      .npc-rows .warn { color:#d8a657; }
      .npc-btns button { font-family:inherit; font-size:11px; letter-spacing:.28em; text-transform:uppercase; cursor:pointer;
                         padding:12px 28px; background:transparent; margin:0 6px; }
      .npc-go { color:#ffb0b0; border:1px solid #ff3b3b; }
      .npc-go:hover { background:rgba(255,59,59,.14); color:#fff; }
      .npc-again { color:#9a9895; border:1px solid #2a2c33; }
      .npc-again:hover { border-color:#666; }
    `;
    document.head.appendChild(s);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // --------------------------------------------------------------- run
  async function runOnce(opts, layer) {
    const W = window.innerWidth, H = window.innerHeight;
    const pts = targetPositions(W, H, opts.markerFootprint ? opts.markerFootprint() : 0);
    const clickMode = !!opts.clickMode;
    let skipped = false;

    layer.innerHTML = `
      <div class="npc-msg" id="npcMsg"><h2>CALI<span>BRATION</span></h2>
        <p>Nine points will appear one at a time.<br>${clickMode
          ? "Look at each point and click it — the webcam learns from each click."
          : "Look straight at each point until it moves on. No need to click."}</p></div>
      <div class="npc-count" id="npcCount"></div>
      <button class="npc-skip" id="npcSkip">skip calibration</button>`;
    layer.querySelector("#npcSkip").onclick = () => { skipped = true; };

    // Get ready: give every glasses-wearer's mapping time to lock onto the
    // tags before the first point, rather than wasting that point on it.
    const readyBy = performance.now() + (opts.simMode ? 900 : 6000);
    await wait(opts.simMode ? 900 : 1400);
    while (!skipped && performance.now() < readyBy && opts.allLive && !opts.allLive()) await wait(150);
    layer.querySelector("#npcMsg").remove();

    // Sampling runs every animation frame for the whole session and files
    // each sample under whichever point is currently in its collect window.
    const samples = pts.map(() => new Map());   // point -> player id -> {xs, ys}
    let active = -1, collectFrom = Infinity, collectUntil = -Infinity, running = true;
    const sample = () => {
      if (!running) return;
      const now = performance.now();
      if (active >= 0 && now >= collectFrom && now <= collectUntil) {
        for (const ptr of opts.readPointers()) {
          const pl = opts.playerOfPointer(ptr.id);
          if (!pl) continue;
          const x = ptr.rawX ?? ptr.x, y = ptr.rawY ?? ptr.y;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          let s = samples[active].get(pl.id);
          if (!s) { s = { xs: [], ys: [] }; samples[active].set(pl.id, s); }
          s.xs.push(x); s.ys.push(y);
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);

    for (let i = 0; i < pts.length && !skipped; i++) {
      const p = pts[i];
      layer.querySelector("#npcCount").textContent = `${i + 1} / ${pts.length}`;
      const t = document.createElement("div");
      t.className = "npc-target" + (clickMode ? " clickable" : "");
      t.style.left = `${p.x}px`; t.style.top = `${p.y}px`;
      t.innerHTML = `<span class="npc-ring"></span><span class="npc-dot"></span>${clickMode ? `<span class="npc-hit"></span><span class="npc-clicks">${CLICKS}</span>` : ""}`;
      layer.appendChild(t);

      const shownAt = performance.now();
      active = i;
      collectFrom = shownAt + SETTLE_MS;

      if (clickMode) {
        collectUntil = Infinity;
        let clicks = 0;
        await new Promise((resolve) => {
          t.onclick = (ev) => {
            if (opts.onClick) opts.onClick(ev.clientX, ev.clientY);
            clicks++;
            t.querySelector(".npc-clicks").textContent = String(CLICKS - clicks);
            if (clicks >= CLICKS) resolve();
          };
          const poll = setInterval(() => { if (skipped) { clearInterval(poll); resolve(); } }, 100);
        });
        // Glasses-wearers still need their sampling window if the clicks were fast.
        const minEnd = shownAt + SETTLE_MS + 500;
        if (performance.now() < minEnd) await wait(minEnd - performance.now());
        collectUntil = performance.now();
      } else {
        collectUntil = shownAt + SETTLE_MS + COLLECT_MS;
        while (!skipped && performance.now() < collectUntil) await wait(50);
      }
      t.remove();
    }
    running = false;
    active = -1;
    if (skipped) return { skipped: true, byPlayer: {} };

    const byPlayer = {};
    for (const pl of opts.players) {
      const points = pts.map((p, i) => {
        const s = samples[i].get(pl.id);
        if (!s || s.xs.length < MIN_SAMPLES) return { tx: p.x, ty: p.y, mx: null, my: null, n: s ? s.xs.length : 0 };
        return { tx: p.x, ty: p.y, mx: median(s.xs), my: median(s.ys), n: s.xs.length };
      });
      const usable = points.filter((q) => q.mx != null);
      const input = opts.inputOf ? opts.inputOf(pl) : "neon";
      byPlayer[pl.id] = { input, points, usable: usable.length, ...chooseModel(usable, input) };
    }
    return { skipped: false, byPlayer, screen: { w: W, h: H } };
  }

  function drawResults(canvas, result, players) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    const ctx = canvas.getContext("2d");
    const sx = canvas.width / result.screen.w, sy = canvas.height / result.screen.h;
    ctx.fillStyle = "#07080b"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const first = Object.values(result.byPlayer)[0];
    if (first) for (const q of first.points) {
      const x = q.tx * sx, y = q.ty * sy, a = 7 * dpr;
      ctx.strokeStyle = "#e8e6e2"; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(x - a, y); ctx.lineTo(x + a, y); ctx.moveTo(x, y - a); ctx.lineTo(x, y + a); ctx.stroke();
    }
    for (const pl of players) {
      const r = result.byPlayer[pl.id];
      if (!r) continue;
      for (const q of r.points) {
        if (q.mx == null) continue;
        const tx = q.tx * sx, ty = q.ty * sy, mx = q.mx * sx, my = q.my * sy;
        ctx.strokeStyle = pl.color; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.2 * dpr;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(mx, my); ctx.stroke();
        ctx.globalAlpha = 1; ctx.fillStyle = pl.color;
        ctx.beginPath(); ctx.arc(mx, my, 4 * dpr, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  async function run(opts) {
    injectStyles();
    const layer = document.createElement("div");
    layer.className = "npc";
    document.body.appendChild(layer);
    try {
      for (;;) {
        const result = await runOnce(opts, layer);
        if (result.skipped) return result;

        const rows = opts.players.map((pl) => {
          const r = result.byPlayer[pl.id];
          const name = `<b style="color:${pl.color}">${pl.label}</b> · ${r.input}`;
          if (!r.usable) return `<div class="warn">${name} — no gaze reached any point. Check the glasses face the screen and the markers are visible.</div>`;
          const few = r.usable < 7 ? ` <span class="warn">(only ${r.usable} of 9 points had gaze)</span>` : "";
          const before = `${Math.round(r.errBefore)}px`;
          if (r.input === "webcam") return `<div>${name} — trained on 9 points, error on those points ${before}${few}</div>`;
          if (r.input === "mouse") return `<div>${name} — ${before} from the points (a mouse needs no correction)</div>`;
          if (r.model.type === "none") return `<div>${name} — ${before} from the points; no correction beats it, none applied${few}</div>`;
          return `<div>${name} — ${before} from the points → about <b>${Math.round(r.errAfter)}px</b> with ${r.model.type} correction${few}</div>`;
        }).join("");

        layer.innerHTML = `
          <div class="npc-results">
            <h2>CALIBRATION RESULT</h2>
            <canvas id="npcCanvas"></canvas>
            <div class="npc-rows">${rows}</div>
            <div class="npc-btns">
              <button class="npc-again" id="npcAgain">calibrate again</button>
              <button class="npc-go" id="npcGo">start game</button>
            </div>
            <p style="font-size:10.5px;color:#5a5856;margin-top:14px">
              Crosses are the points; dots are where each player's gaze landed on average.
              These figures are accuracy — how far the averaged gaze lands from where the player looks —
              measured on points left out of the fit, so not the best case. Moment-to-moment jitter comes on top.</p>
          </div>`;
        drawResults(layer.querySelector("#npcCanvas"), result, opts.players);
        const again = await new Promise((resolve) => {
          layer.querySelector("#npcAgain").onclick = () => resolve(true);
          layer.querySelector("#npcGo").onclick = () => resolve(false);
        });
        if (!again) return result;
      }
    } finally {
      layer.remove();
    }
  }

  window.NinePointCalibration = { run, apply, targetPositions, chooseModel, fitAffine, fitOffset, leaveOneOut, IDENTITY };
  if (typeof module !== "undefined") module.exports = window.NinePointCalibration;
})();
