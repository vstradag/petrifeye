// LIVE GAZE — analysis screen for one image.
//
// Shown only to third parties, on a second projector. It never connects to a
// bridge: a bridge maps gaze into the viewport of whichever page last reported
// one, so if this window connected it would drag every player's gaze into ITS
// size and corrupt the real screen's mapping with no visible error. Everything
// arrives from the screen windows over a BroadcastChannel, in normalised image
// coordinates, so it can be drawn at any size.
//
//   top-left     this image with live scanpaths
//   top-right    statistics, per player and combined
//   bottom-left  this image hidden, uncovered only where eyes fixated
//   bottom-right THE OTHER IMAGES — thumbnails with their own scanpaths
//
// The fourth panel is what makes a three-image show possible on fewer than six
// displays: it hears every screen window, not just this one's, so a single
// analysis window still shows what is happening on all of them.
(function () {
  const CHANNEL = LiveGazeStore.CHANNEL;
  const TRAIL_MS = 1500;        // raw gaze trace kept behind each live marker
  const SCANPATH_SHOWN = 40;    // most recent fixations drawn per player
  const NUMBERED = 15;          // of those, how many carry their order number
  const SCANPATH_VEIL = 0.32;   // darkening under the scanpaths
  // Reveal: a fixation uncovers a circle of REVEAL_R (share of image width),
  // grown by the square root of how many fixations share that neighbourhood —
  // so the uncovered AREA grows in proportion to the number of looks there.
  const REVEAL_R = 0.04;
  const REVEAL_MAX = 4;         // cap, in multiples of REVEAL_R

  const SLOT = Math.max(0, Math.min(LiveGazeStore.MAX_IMAGES - 1,
    Number(new URLSearchParams(location.search).get("slot") || 0)));

  const $ = (id) => document.getElementById(id);
  const bus = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;

  // One record per image in the session, whether or not this window is its
  // analysis screen: the fourth panel needs the others.
  function blank(slot) {
    return {
      slot, name: "", w: 0, h: 0, el: null,
      fixations: [], players: [], live: new Map(),
      started: false, connected: false,
      settings: { spreadPct: 3.5, minDurationMs: 100 },
    };
  }

  const S = {
    slots: new Map(),
    total: 1,
  };
  const rec = (slot) => {
    if (!S.slots.has(slot)) S.slots.set(slot, blank(slot));
    return S.slots.get(slot);
  };
  const mine = () => rec(SLOT);
  const others = () => [...S.slots.values()]
    .filter((r) => r.slot !== SLOT && (r.el || r.fixations.length))
    .sort((a, b) => a.slot - b.slot);

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

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // -------------------------------------------------------- statistics
  // Distances are in the IMAGE's own pixels, not screen pixels, so a number
  // means the same thing on a laptop and on a projector — and the same thing
  // for two images of different sizes.
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
    const r = mine();
    const W = r.w || 1536, H = r.h || 1024;
    const all = r.fixations;
    const cols = r.players.map((p) => ({ p, s: statsFor(all.filter((f) => f.p === p.id), W, H) }));
    // Combined: pairs are taken WITHIN each player's own sequence. Joining one
    // player's fixation to another's would invent saccades nobody made.
    const tot = cols.reduce((a, c) => ({
      n: a.n + c.s.n, dur: a.dur + c.s.dur, dist: a.dist + c.s.dist, pairs: a.pairs + c.s.pairs,
    }), { n: 0, dur: 0, dist: 0, pairs: 0 });

    const fmt = (v, d = 0) => Number.isFinite(v) ? v.toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—";
    const cell = (v, unit) => `<span class="big">${v}</span>${unit ? `<span class="unit">${unit}</span>` : ""}`;
    const row = (label, pick, unit, cls = "") =>
      `<tr class="${cls}"><td>${label}</td>${cols.map((c) => `<td>${cell(pick(c.s), unit)}</td>`).join("")}<td>${cell(pick(tot), unit)}</td></tr>`;

    const now = performance.now();
    const head = r.players.map((p) => {
      const l = r.live.get(p.id);
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
        Distances in this image's own pixels (${W}×${H}), so they read the same on any
        screen and can be compared with the other images.
        A fixation is gaze staying within ${r.settings.spreadPct}% of the image's width for at least
        ${r.settings.minDurationMs}ms. Distance is measured between consecutive fixations of the same person.
      </div>`;
    statsDirty = false;
  }

  // ---------------------------------------------- scanpath drawing (shared)
  // Used full-size for this image in Q1 and small for the others in Q4, which
  // is why it takes its own rect and scale rather than reading the canvas.
  function drawScanpathInto(ctx, r, box, k, opts) {
    const X = (u) => box.x + u * box.w, Y = (v) => box.y + v * box.h;
    const now = performance.now();
    const shownMax = opts.shown ?? SCANPATH_SHOWN;
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

    for (const pl of r.players) {
      const my = r.fixations.filter((f) => f.p === pl.id);
      const shown = my.slice(-shownMax);
      const offset = my.length - shown.length;

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
        if (opts.numbers && i >= shown.length - NUMBERED) {
          ctx.font = `700 ${Math.round(12 * k)}px ui-monospace, Menlo, monospace`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.lineWidth = 3.5 * k; ctx.strokeStyle = "rgba(0,0,0,.9)";
          const label = String(offset + i + 1);
          ctx.strokeText(label, x, y);
          ctx.fillStyle = "#fff"; ctx.fillText(label, x, y);
        }
      });

      // Live: fading trace, the fixation forming now, and the gaze itself.
      const l = r.live.get(pl.id);
      if (!l || now - l.at > 1000) continue;
      const trail = l.trail.filter((t) => now - t.at < TRAIL_MS);
      for (let i = 1; i < trail.length; i++) {
        const age = (now - trail[i].at) / TRAIL_MS;
        haloLine(X(trail[i - 1].u), Y(trail[i - 1].v), X(trail[i].u), Y(trail[i].v), pl.color, 2 * k, 0.85 * (1 - age));
      }
      if (opts.forming && l.fu != null) {
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

  // -------------------------------------------------------- Q1 scanpaths
  function drawScanpaths() {
    const c = $("q1");
    fitCanvas(c);
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#07080b";
    ctx.fillRect(0, 0, c.width, c.height);
    const r = mine();
    if (!r.el) return;

    const box = containRect(c.width, c.height, r.w / r.h, 10 * dpr);
    ctx.drawImage(r.el, box.x, box.y, box.w, box.h);
    // A light veil: uploaded images are often bright and saturated, and full of
    // the very colours the players are drawn in, where marks alone vanish. The
    // veil keeps the image readable while letting the scanpath pop.
    ctx.fillStyle = `rgba(0,0,0,${SCANPATH_VEIL})`;
    ctx.fillRect(box.x, box.y, box.w, box.h);

    // Mark sizes in CSS px, scaled up with the quadrant: a projected quadrant
    // is read from across a room.
    const k = dpr * Math.max(1, box.w / dpr / 640);
    drawScanpathInto(ctx, r, box, k, { numbers: true, forming: true });
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
    const r = mine();
    if (!r.el) { $("q3Pct").textContent = ""; return; }

    const box = containRect(c.width, c.height, r.w / r.h, 10 * dpr);
    const w = Math.max(1, Math.round(box.w)), h = Math.max(1, Math.round(box.h));
    maskCanvas.width = w; maskCanvas.height = h;
    compCanvas.width = w; compCanvas.height = h;
    const m = maskCanvas.getContext("2d");
    m.clearRect(0, 0, w, h);

    // Neighbour count per fixation, in the image's own pixels so a
    // neighbourhood is round on the image rather than stretched to the screen.
    const fx = r.fixations;
    const R0 = REVEAL_R * r.w;
    const pts = fx.map((f) => ({ x: f.u * r.w, y: f.v * r.h }));
    for (let i = 0; i < pts.length; i++) {
      let n = 0;
      for (let j = 0; j < pts.length; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= R0 * 1.5) n++;
      }
      // sqrt: revealed AREA grows linearly with the number of looks.
      const rNative = Math.min(R0 * REVEAL_MAX, R0 * Math.sqrt(n));
      const rad = rNative * (w / r.w);
      const x = pts[i].x * (w / r.w), y = pts[i].y * (h / r.h);
      const g = m.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.6, "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      m.fillStyle = g;
      m.beginPath(); m.arc(x, y, rad, 0, Math.PI * 2); m.fill();
    }

    const comp = compCanvas.getContext("2d");
    comp.clearRect(0, 0, w, h);
    comp.drawImage(r.el, 0, 0, w, h);
    comp.globalCompositeOperation = "destination-in";
    comp.drawImage(maskCanvas, 0, 0);
    comp.globalCompositeOperation = "source-over";

    // The hidden image's outline, so the uncovered patches have a frame.
    ctx.strokeStyle = "#1e2027";
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, w - 1, h - 1);
    ctx.drawImage(compCanvas, Math.round(box.x), Math.round(box.y));

    // Share of the image uncovered, measured on a small copy of the mask.
    const sw = 150, sh = Math.max(1, Math.round(150 * h / w));
    const probe = document.createElement("canvas");
    probe.width = sw; probe.height = sh;
    const p = probe.getContext("2d");
    p.drawImage(maskCanvas, 0, 0, sw, sh);
    const data = p.getImageData(0, 0, sw, sh).data;
    let on = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 127) on++;
    r.uncovered = on / (sw * sh);          // exact share, 0..1
    $("q3Pct").textContent = fx.length ? `${Math.round(100 * r.uncovered)}% uncovered` : "";
  }

  // ------------------------------------------------------- Q4 the others
  // Small live panels for the images this window is NOT the analysis screen
  // for. With three images on three projectors and only one analysis display
  // free, this is the panel that keeps the other two visible.
  function drawOthers() {
    const c = $("q4");
    fitCanvas(c);
    const list = others();
    $("q4Empty").style.display = list.length ? "none" : "";
    $("q4Label").textContent = list.length === 1 ? "the other image" : "the other images";
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#07080b";
    ctx.fillRect(0, 0, c.width, c.height);
    if (!list.length) { $("q4Note").textContent = ""; return; }

    // Side by side while they stay reasonably wide, stacked otherwise: two
    // portrait images side by side in half a quadrant are unreadable.
    const pad = 12 * dpr;
    const cellW = (c.width - pad * (list.length + 1)) / list.length;
    const columns = cellW / dpr > 200;
    const n = list.length;
    let live = 0;

    list.forEach((r, i) => {
      const cell = columns
        ? { x: pad + i * (cellW + pad), y: pad, w: cellW, h: c.height - 2 * pad }
        : { x: pad, y: pad + i * ((c.height - pad * (n + 1)) / n + pad),
            w: c.width - 2 * pad, h: (c.height - pad * (n + 1)) / n };

      // Caption first, so the image box knows what room is left.
      const capH = Math.min(34 * dpr, cell.h * 0.3);
      ctx.font = `500 ${Math.round(11 * dpr)}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = "#7a7876";
      const W = r.w || 1, H = r.h || 1;
      const tot = r.players.reduce((a, p) => {
        const s = statsFor(r.fixations.filter((f) => f.p === p.id), W, H);
        return { n: a.n + s.n, dur: a.dur + s.dur, dist: a.dist + s.dist, pairs: a.pairs + s.pairs };
      }, { n: 0, dur: 0, dist: 0, pairs: 0 });
      const nowMs = performance.now();
      const anyLive = r.players.some((p) => {
        const l = r.live.get(p.id);
        return l && nowMs - l.at < 1000;
      });
      if (anyLive) live++;
      ctx.fillText(`IMAGE ${r.slot + 1}`, cell.x, cell.y);
      ctx.fillStyle = "#b9b7b3";
      const secs = tot.dur / 1000;
      ctx.fillText(
        `${tot.n} fix · ${tot.n ? Math.round(tot.dur / tot.n) : 0}ms avg · ${secs.toFixed(1)}s`,
        cell.x + Math.round(70 * dpr), cell.y);
      // A live dot per player who is looking at that image right now, so the
      // panel says WHO is where without reading numbers.
      let dx = cell.x + cell.w;
      for (const p of r.players) {
        const l = r.live.get(p.id);
        const on = l && nowMs - l.at < 1000;
        dx -= 12 * dpr;
        ctx.beginPath();
        ctx.arc(dx, cell.y + 5 * dpr, 4 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = on ? p.color : "#23262e";
        ctx.fill();
      }

      const boxArea = { x: cell.x, y: cell.y + capH, w: cell.w, h: cell.h - capH };
      if (!r.el) {
        ctx.fillStyle = "#23262e";
        ctx.font = `${Math.round(10 * dpr)}px ui-monospace, Menlo, monospace`;
        ctx.fillText("waiting for its screen…", boxArea.x, boxArea.y + 6 * dpr);
        return;
      }
      const box = containRect(boxArea.w, boxArea.h, r.w / r.h, 0);
      box.x += boxArea.x; box.y += boxArea.y;
      ctx.drawImage(r.el, box.x, box.y, box.w, box.h);
      ctx.fillStyle = `rgba(0,0,0,${SCANPATH_VEIL})`;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = "#1e2027"; ctx.lineWidth = 1 * dpr;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);

      // Fewer marks and no numbers: at this size they would be a smear.
      const k = Math.max(0.45, box.w / dpr / 640) * dpr;
      drawScanpathInto(ctx, r, box, k, { numbers: false, forming: false, shown: 18 });
    });

    $("q4Note").textContent = live ? `${live} being looked at now` : "";
  }

  // ------------------------------------------------------------ messages
  // Images come from IndexedDB, not over the channel: the screen windows are
  // busy drawing at 60fps and a multi-megabyte blob per window is exactly the
  // kind of cost that shows up as a stutter in the thing being measured.
  async function loadImages() {
    const all = await LiveGazeStore.all();
    S.total = Math.max(S.total, all.length);
    for (const r of all) {
      const slot = r.slot;
      const target = rec(slot);
      if (target.el && target.name === r.name) continue;
      const loaded = await LiveGazeStore.load(r);
      if (!loaded) continue;
      target.el = loaded.el;
      target.name = r.name;
      target.w = loaded.w;
      target.h = loaded.h;
      if (slot === SLOT) {
        $("q1Title").textContent = `${slot + 1}/${S.total} · ${r.name}`;
        revealDirty = statsDirty = true;
      }
    }
    $("waitSlot").textContent = String(SLOT + 1);
  }

  function onMessage(msg) {
    if (!msg || !msg.type || msg.slot == null) return;
    const r = rec(msg.slot);

    if (msg.type === "images-changed") { location.reload(); return; }

    if (msg.type === "snapshot") {
      r.connected = true;
      r.started = !!msg.started;
      r.players = msg.players || [];
      r.fixations = msg.fixations || [];
      r.settings = msg.settings || r.settings;
      if (msg.total) S.total = Math.max(S.total, msg.total);
      if (msg.image) {
        // The screen window measured the image; trust it over anything read
        // here, so both windows normalise against exactly the same figures.
        r.name = msg.image.name;
        r.w = msg.image.w; r.h = msg.image.h;
      }
      if (msg.slot === SLOT) {
        $("q1Title").textContent = r.name ? `${SLOT + 1}/${S.total} · ${r.name}` : "—";
        $("waiting").classList.toggle("hidden", r.started);
        $("waitingMsg").innerHTML = r.started ? "" :
          `Image <b>${SLOT + 1}</b>'s screen was found, not started yet.<br />` +
          "Press <b>start</b> (or the mouse test) in that window.";
        revealDirty = statsDirty = true;
      }
      return;
    }

    if (msg.type === "fixation") {
      r.fixations.push(msg.fix);
      if (msg.slot === SLOT) revealDirty = statsDirty = true;
      return;
    }

    if (msg.type === "gaze") {
      const now = performance.now();
      for (const g of msg.pts) {
        let l = r.live.get(g.p);
        if (!l) { l = { trail: [] }; r.live.set(g.p, l); }
        Object.assign(l, g, { at: now });
        l.trail.push({ u: g.u, v: g.v, at: now });
        while (l.trail.length && now - l.trail[0].at > TRAIL_MS) l.trail.shift();
      }
    }
  }

  if (bus) bus.onmessage = (e) => onMessage(e.data);
  else $("waitingMsg").textContent = "This browser has no BroadcastChannel — use a current Chrome, Edge, Firefox or Safari.";

  // Ask for the full state, and keep asking until the screens answer: a screen
  // window may be opened after this one, or reloaded while it is open.
  function hello() { if (bus) bus.postMessage({ type: "hello", slot: SLOT }); }
  hello();
  setInterval(() => { if (!mine().connected) hello(); }, 1000);

  // ------------------------------------------------------------- controls
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "r" && bus) bus.postMessage({ type: "cmd", cmd: "reset", slot: SLOT });
    else if (k === "f") fullscreen();
  });
  document.addEventListener("dblclick", fullscreen);
  window.addEventListener("resize", () => { revealDirty = statsDirty = true; });

  // ----------------------------------------------------------------- loop
  let lastStats = 0;
  function frame() {
    drawScanpaths();
    drawReveal();
    drawOthers();
    const now = performance.now();
    // Stats on change, plus a slow tick so the live dots follow reality.
    if (statsDirty || now - lastStats > 500) { renderStats(); lastStats = now; }
    requestAnimationFrame(frame);
  }

  loadImages().catch(() => {});
  // Late-opened screens, or a re-upload, land in the store after this window
  // started; the snapshot tells us the metadata but not the pixels.
  setInterval(() => loadImages().catch(() => {}), 4000);
  requestAnimationFrame(frame);

  window.LiveGazeObserver = {
    state: S,
    slot: SLOT,
    redraw: () => { revealDirty = statsDirty = true; },
    // Render every panel immediately, without waiting for a frame — for the
    // console, and for hidden windows where browsers throttle animation.
    renderNow: () => {
      revealDirty = statsDirty = true;
      drawScanpaths(); drawReveal(); drawOthers(); renderStats();
    },
  };
})();
