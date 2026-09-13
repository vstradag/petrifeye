// POLITICAL VISION — observer screen.
//
// Shown only to third parties, on the second projector. It never connects
// to a bridge: a bridge maps gaze into the viewport of whichever page last
// reported one, so if this window connected it would drag every player's
// gaze into ITS size and corrupt the viewer's mapping with no visible error.
// Everything arrives from the viewer window over a BroadcastChannel instead,
// in normalised image coordinates, so it can be drawn at any size.
//
//   top-left     the cartoon with live scanpaths
//   top-right    statistics, per player and combined
//   bottom-left  the cartoon hidden, uncovered only where eyes fixated
//   bottom-right reserved
(function () {
  const CHANNEL = "political-vision";
  const TRAIL_MS = 1500;        // raw gaze trace kept behind each live marker
  const SCANPATH_SHOWN = 40;    // most recent fixations drawn per player
  const NUMBERED = 15;          // of those, how many carry their order number
  const SCANPATH_VEIL = 0.32;   // darkening over the cartoon under the scanpaths
  // Reveal: a fixation uncovers a circle of REVEAL_R (share of image width),
  // grown by the square root of how many fixations share that neighbourhood —
  // so the uncovered AREA grows in proportion to the number of looks there.
  const REVEAL_R = 0.04;
  const REVEAL_MAX = 4;         // cap, in multiples of REVEAL_R

  const $ = (id) => document.getElementById(id);
  const bus = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;

  const S = {
    connected: false,
    started: false,
    index: 0,
    images: [],                 // [{ file, title, w, h, el }]
    players: [],
    fixations: [],              // per image: [{ p, u, v, dur, start }]
    settings: { spreadPct: 3.5, minDurationMs: 100 },
    live: new Map(),            // player id -> { u, v, fu, fv, fd, at, trail: [{u, v, at}] }
  };
  let revealDirty = true;
  let statsDirty = true;

  // ------------------------------------------------------------- canvas
  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; }
    return false;
  }

  function containRect(cw, ch, aspect, pad) {
    const w0 = cw - 2 * pad, h0 = ch - 2 * pad;
    let w = w0, h = w0 / aspect;
    if (h > h0) { h = h0; w = h0 * aspect; }
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  const current = () => S.images[S.index];
  const fixesHere = () => S.fixations[S.index] || [];
  const colorOf = (pid) => (S.players.find((p) => p.id === pid) || {}).color || "#fff";

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // -------------------------------------------------------- statistics
  // Distances are in the CARTOON's own pixels (1536 x 1024), not screen
  // pixels, so a number means the same thing on a laptop and on a projector.
  function statsFor(list, W, H) {
    const n = list.length;
    let dur = 0, dist = 0, pairs = 0;
    for (let i = 0; i < n; i++) {
      dur += list[i].dur;
      if (i > 0) {
        dist += Math.hypot((list[i].u - list[i - 1].u) * W, (list[i].v - list[i - 1].v) * H);
        pairs++;
      }
    }
    return { n, dur, dist, pairs };
  }

  function renderStats() {
    const img = current();
    const W = (img && img.w) || 1536, H = (img && img.h) || 1024;
    const all = fixesHere();
    const cols = S.players.map((p) => ({ p, s: statsFor(all.filter((f) => f.p === p.id), W, H) }));
    // Combined: pairs are taken WITHIN each player's own sequence. Joining
    // one player's fixation to another's would invent saccades nobody made.
    const tot = cols.reduce((a, c) => ({
      n: a.n + c.s.n, dur: a.dur + c.s.dur, dist: a.dist + c.s.dist, pairs: a.pairs + c.s.pairs,
    }), { n: 0, dur: 0, dist: 0, pairs: 0 });

    const fmt = (v, d = 0) => Number.isFinite(v) ? v.toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—";
    const cell = (v, unit) => `<span class="big">${v}</span>${unit ? `<span class="unit">${unit}</span>` : ""}`;
    const row = (label, pick, unit, cls = "") =>
      `<tr class="${cls}"><td>${label}</td>${cols.map((c) => `<td>${cell(pick(c.s), unit)}</td>`).join("")}<td>${cell(pick(tot), unit)}</td></tr>`;

    const now = performance.now();
    const head = S.players.map((p) => {
      const l = S.live.get(p.id);
      const on = l && now - l.at < 1000;
      return `<th><span class="live-dot" style="background:${on ? p.color : "#2a2c33"}"></span><span style="color:${p.color}">${p.label}</span></th>`;
    }).join("");

    $("q2").innerHTML = `
      <table>
        <tr><th></th>${head}<th>all</th></tr>
        ${row("fixations", (s) => fmt(s.n))}
        ${row("average fixation", (s) => s.n ? fmt(s.dur / s.n) : "—", "ms")}
        ${row("average distance between fixations", (s) => s.pairs ? fmt(s.dist / s.pairs) : "—", "px")}
        ${row("total scanpath length", (s) => s.pairs ? fmt(s.dist) : "—", "px", "secondary")}
        ${row("total time fixating", (s) => s.n ? fmt(s.dur / 1000, 1) : "—", "s", "secondary")}
      </table>
      <div class="foot">
        Distances in the cartoon's own pixels (${W}×${H}), so they read the same on any screen.
        A fixation is gaze staying within ${S.settings.spreadPct}% of the cartoon's width for at least
        ${S.settings.minDurationMs}ms. Distance is measured between consecutive fixations of the same person.
      </div>`;
    statsDirty = false;
  }

  // -------------------------------------------------------- Q1 scanpaths
  function drawScanpaths() {
    const c = $("q1");
    fitCanvas(c);
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#07080b";
    ctx.fillRect(0, 0, c.width, c.height);
    const img = current();
    if (!img || !img.el) return;

    const r = containRect(c.width, c.height, img.w / img.h, 10 * dpr);
    ctx.drawImage(img.el, r.x, r.y, r.w, r.h);

    // A light veil over the cartoon. These cartoons are busy and saturated,
    // and full of the very colours the players are drawn in — red sashes,
    // teal overalls — so unveiled, the first version's scanpaths measurably
    // existed (8% of pixels changed) and were visually close to invisible.
    // The veil keeps the cartoon fully readable while letting marks pop.
    ctx.fillStyle = `rgba(0,0,0,${SCANPATH_VEIL})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);

    const X = (u) => r.x + u * r.w, Y = (v) => r.y + v * r.h;
    // Mark sizes in CSS px, scaled up with the quadrant: a projected quadrant
    // is read from across a room.
    const k = dpr * Math.max(1, r.w / dpr / 640);
    const all = fixesHere();
    const now = performance.now();
    const radiusFor = (dur) => Math.min(30, Math.max(8, 5 + Math.sqrt(dur) * 0.9)) * k;

    // Every mark is drawn twice: a dark halo, then the colour. That combination
    // reads on bright sky and dark ink alike, where colour alone cannot.
    const haloLine = (x0, y0, x1, y1, color, width, alpha) => {
      ctx.lineCap = "round";
      ctx.strokeStyle = `rgba(0,0,0,${0.8 * alpha})`; ctx.lineWidth = width + 3.5 * k;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = hexA(color, alpha); ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    };

    for (const pl of S.players) {
      const mine = all.filter((f) => f.p === pl.id);
      const shown = mine.slice(-SCANPATH_SHOWN);
      const offset = mine.length - shown.length;

      // Saccades: older ones fade, so the path reads in the direction of time.
      for (let i = 1; i < shown.length; i++) {
        const a = 0.35 + 0.65 * (i / shown.length);
        haloLine(X(shown[i - 1].u), Y(shown[i - 1].v), X(shown[i].u), Y(shown[i].v), pl.color, 3 * k, a);
      }

      // Fixations: area follows duration, so a long look is a big circle.
      shown.forEach((f, i) => {
        const a = 0.45 + 0.55 * ((i + 1) / shown.length);
        const x = X(f.u), y = Y(f.v), rad = radiusFor(f.dur);
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fillStyle = hexA(pl.color, 0.62 * a); ctx.fill();
        ctx.lineWidth = 4 * k; ctx.strokeStyle = `rgba(0,0,0,${0.8 * a})`; ctx.stroke();
        ctx.lineWidth = 2 * k; ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`; ctx.stroke();
        if (i >= shown.length - NUMBERED) {
          ctx.font = `700 ${Math.round(12 * k)}px ui-monospace, Menlo, monospace`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.lineWidth = 3.5 * k; ctx.strokeStyle = "rgba(0,0,0,.9)";
          const label = String(offset + i + 1);
          ctx.strokeText(label, x, y);
          ctx.fillStyle = "#fff"; ctx.fillText(label, x, y);
        }
      });

      // Live: fading trace, the fixation forming now, and the gaze itself.
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
        ctx.lineWidth = 6 * k; ctx.strokeStyle = "rgba(0,0,0,.8)";
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y); ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm); ctx.stroke();
        ctx.lineWidth = 2.5 * k; ctx.strokeStyle = pl.color;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y); ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm); ctx.stroke();
      }
    }
  }

  // ----------------------------------------------------------- Q3 reveal
  const maskCanvas = document.createElement("canvas");
  const compCanvas = document.createElement("canvas");

  function drawReveal() {
    const c = $("q3");
    const resized = fitCanvas(c);
    if (!revealDirty && !resized) return;
    revealDirty = false;

    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#07080b";
    ctx.fillRect(0, 0, c.width, c.height);
    const img = current();
    if (!img || !img.el) { $("q3Pct").textContent = ""; return; }

    const r = containRect(c.width, c.height, img.w / img.h, 10 * dpr);
    const w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h));
    maskCanvas.width = w; maskCanvas.height = h;
    compCanvas.width = w; compCanvas.height = h;
    const m = maskCanvas.getContext("2d");
    m.clearRect(0, 0, w, h);

    // Neighbour count per fixation, in the cartoon's own pixels so a
    // neighbourhood is round on the image rather than stretched to the screen.
    const fx = fixesHere();
    const R0 = REVEAL_R * img.w;
    const pts = fx.map((f) => ({ x: f.u * img.w, y: f.v * img.h }));
    for (let i = 0; i < pts.length; i++) {
      let n = 0;
      for (let j = 0; j < pts.length; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= R0 * 1.5) n++;
      }
      // sqrt: revealed AREA grows linearly with the number of looks.
      const rNative = Math.min(R0 * REVEAL_MAX, R0 * Math.sqrt(n));
      const rad = rNative * (w / img.w);
      const x = pts[i].x * (w / img.w), y = pts[i].y * (h / img.h);
      const g = m.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.6, "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      m.fillStyle = g;
      m.beginPath(); m.arc(x, y, rad, 0, Math.PI * 2); m.fill();
    }

    const comp = compCanvas.getContext("2d");
    comp.clearRect(0, 0, w, h);
    comp.drawImage(img.el, 0, 0, w, h);
    comp.globalCompositeOperation = "destination-in";
    comp.drawImage(maskCanvas, 0, 0);
    comp.globalCompositeOperation = "source-over";

    // The hidden cartoon's outline, so the uncovered patches have a frame.
    ctx.strokeStyle = "#1e2027";
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, w - 1, h - 1);
    ctx.drawImage(compCanvas, Math.round(r.x), Math.round(r.y));

    // Share of the cartoon uncovered, measured on a small copy of the mask.
    const sw = 150, sh = Math.max(1, Math.round(150 * h / w));
    const probe = document.createElement("canvas");
    probe.width = sw; probe.height = sh;
    const p = probe.getContext("2d");
    p.drawImage(maskCanvas, 0, 0, sw, sh);
    const data = p.getImageData(0, 0, sw, sh).data;
    let on = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 127) on++;
    S.uncovered = on / (sw * sh);          // exact share, 0..1
    $("q3Pct").textContent = fx.length ? `${Math.round(100 * S.uncovered)}% uncovered` : "";
  }

  // ------------------------------------------------------------ messages
  function loadImages(list) {
    const same = S.images.length === list.length && S.images.every((m, i) => m.file === list[i].file);
    if (same) return;
    S.images = list.map((m) => ({ ...m, el: null }));
    S.images.forEach((m) => {
      const el = new Image();
      el.onload = () => { m.el = el; revealDirty = true; };
      el.src = `../images/political-vision/${m.file}`;
    });
  }

  function onMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "snapshot") {
      S.connected = true;
      S.started = !!msg.started;
      if (msg.index !== S.index) S.live.clear();
      S.index = msg.index;
      S.players = msg.players || [];
      S.fixations = msg.fixations || [];
      S.settings = msg.settings || S.settings;
      loadImages(msg.images || []);
      const img = current();
      $("q1Title").textContent = img ? `${S.index + 1}/${S.images.length} · ${img.title}` : "—";
      $("waiting").classList.toggle("hidden", S.started);
      $("waitingMsg").innerHTML = S.started ? "" :
        "Viewer screen found, not started yet.<br />Press <b>start</b> (or the mouse test) on the viewer.";
      revealDirty = statsDirty = true;
    } else if (msg.type === "fixation") {
      if (!S.fixations[msg.index]) S.fixations[msg.index] = [];
      S.fixations[msg.index].push(msg.fix);
      if (msg.index === S.index) revealDirty = statsDirty = true;
    } else if (msg.type === "gaze") {
      if (msg.index !== S.index) return;
      const now = performance.now();
      for (const g of msg.pts) {
        let l = S.live.get(g.p);
        if (!l) { l = { trail: [] }; S.live.set(g.p, l); }
        Object.assign(l, g, { at: now });
        l.trail.push({ u: g.u, v: g.v, at: now });
        while (l.trail.length && now - l.trail[0].at > TRAIL_MS) l.trail.shift();
      }
    }
  }

  if (bus) bus.onmessage = (e) => onMessage(e.data);
  else $("waitingMsg").textContent = "This browser has no BroadcastChannel — use a current Chrome, Edge, Firefox or Safari.";

  // Ask for the full state, and keep asking until the viewer answers: the
  // viewer may be opened after this window, or reloaded while it is open.
  function hello() { if (bus) bus.postMessage({ type: "hello" }); }
  hello();
  setInterval(() => { if (!S.connected) hello(); }, 1000);

  // ------------------------------------------------------------- controls
  const cmd = (c) => bus && bus.postMessage({ type: "cmd", cmd: c });
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "n") cmd("next");
    else if (k === "p") cmd("prev");
    else if (k === "r") cmd("reset");
    else if (k === "f") fullscreen();
  });
  document.addEventListener("dblclick", fullscreen);
  window.addEventListener("resize", () => { revealDirty = statsDirty = true; });

  // ----------------------------------------------------------------- loop
  let lastStats = 0;
  function frame() {
    drawScanpaths();
    drawReveal();
    const now = performance.now();
    // Stats on change, plus a slow tick so the live-dots follow reality.
    if (statsDirty || now - lastStats > 500) { renderStats(); lastStats = now; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.PoliticalVisionObserver = {
    state: S,
    redraw: () => { revealDirty = statsDirty = true; },
    // Render all quadrants immediately, without waiting for a frame — for the
    // console, and for hidden windows where browsers throttle animation.
    renderNow: () => { revealDirty = statsDirty = true; drawScanpaths(); drawReveal(); renderStats(); },
  };
})();
