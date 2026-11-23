// MEDUSA's "line" look: white line drawing on black, after the Gazeboard
// medusa room. Almond eyes that blink and look at the nearest gaze, an iris
// that fills with white as the stare builds, and stones as rough outlines
// filled with the stone photos.
//
// Only how things LOOK lives here. Which eyes exist, where they drift, what
// a player is locked on to, how long a stare takes, when an eye turns to
// stone and when it comes back are all still sketch.js's, unchanged, so the
// classic look and this one play exactly the same game. sketch.js calls in
// here instead of drawing its own blob when PetrifEyeShow.look is "line".
//
// Everything is drawn on the raw canvas context, in canvas pixels.
(function () {
  const TAU = Math.PI * 2;
  const GAP = 6;            // px of black kept around each eye and stone, so lines behind never show through
  const BLINK = [2, 7];     // s between blinks
  const LOOK_EASE = 0.1;    // per 60 Hz frame, how fast a pupil turns towards the gaze
  const rnd = (a, b) => a + Math.random() * (b - a);

  // The design's 1.2 px line is for a laptop screen. Across a room, on a
  // projector, it needs a little more, so it grows with the screen height.
  const weight = (h) => Math.min(2.4, Math.max(1.2, h / 600));

  // Each eye its own: how open, the iris size, a dot or a snake's slit for a
  // pupil, sometimes a second iris ring. Made once and kept for the blob's
  // life, so the eye that comes back from stone is the same eye.
  function looksOf(b) {
    if (!b._line) {
      b._line = {
        open: rnd(0.45, 0.8), iris: rnd(0.28, 0.5),
        slit: Math.random() < 0.25, ring: Math.random() < 0.3,
        blink: rnd(...BLINK), lid: 0,   // lid 0 is shut: a new eye opens
        look: { x: 0, y: 0 },
        stone: null,
      };
    }
    return b._line;
  }

  // A rough stone, each one different: 6-9 corners, squat or tall, with its
  // own photo and its own part of it. Corners are in units of the eye's
  // radius, so the size slider still resizes a stone that already exists.
  function makeStone(textures) {
    const n = 6 + Math.floor(Math.random() * 4), ay = rnd(0.6, 0.95), pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rnd(-0.25, 0.25);
      pts.push({ x: Math.cos(a) * rnd(0.75, 1.1), y: Math.sin(a) * ay * rnd(0.75, 1.1) });
    }
    return {
      pts,
      img: Math.floor(Math.random() * Math.max(1, textures.length)),
      ox: rnd(0.3, 0.6), oy: rnd(0.4, 0.6), sc: rnd(0.9, 1.5), angle: rnd(0, TAU),
    };
  }

  // Black fill and a wide black stroke of the current path: hides what is
  // behind it and leaves a gap around the outline.
  function halo(ctx, lw) {
    ctx.save();
    ctx.fillStyle = ctx.strokeStyle = "#000";
    ctx.lineWidth = GAP + lw;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawStone(ctx, x, y, r, st, textures, lw) {
    ctx.beginPath();
    st.pts.forEach((p, i) => (i ? ctx.lineTo(x + p.x * r, y + p.y * r) : ctx.moveTo(x + p.x * r, y + p.y * r)));
    ctx.closePath();
    halo(ctx, lw);
    // The photo, clipped inside the outline. p5 images keep their pixels in
    // a canvas of their own.
    const im = textures[st.img];
    const src = im && (im.canvas || im.elt || im);
    const iw = im && im.width, ih = im && im.height;
    if (src && iw && ih) {
      ctx.save();
      ctx.clip();
      ctx.translate(x, y);
      ctx.rotate(st.angle);
      const w = r * 4 * st.sc, h = (w * ih) / iw;
      ctx.drawImage(src, -w * st.ox, -h * st.oy, w, h);
      ctx.restore();
    }
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  // Blinking, and the pupil turning towards the nearest gaze. An eye being
  // stared at does not blink: the iris filling up is how a player sees the
  // stare working, and a blink would hide it.
  function animate(L, b, pointers, dt, staring) {
    if (staring) L.blink = Math.max(L.blink, 0.4);
    L.blink -= dt;
    if (L.blink < 0) {
      L.lid = Math.max(0, L.lid - dt * 12);
      if (L.blink < -0.15) L.blink = rnd(...BLINK);
    } else {
      L.lid = Math.min(1, L.lid + dt * 8);
    }
    let at = null, nd = Infinity;
    for (const p of pointers) {
      const d = Math.hypot(p.x - b.pos.x, p.y - b.pos.y);
      if (d < nd) { nd = d; at = p; }
    }
    const d = at ? nd || 1 : 1;
    const tx = at ? (at.x - b.pos.x) / d : 0, ty = at ? (at.y - b.pos.y) / d : 0;
    const k = 1 - Math.pow(1 - LOOK_EASE, Math.min(6, dt * 60));
    L.look.x += (tx - L.look.x) * k;
    L.look.y += (ty - L.look.y) * k;
  }

  // An eye: almond lids, iris and pupil looking towards the gaze; the iris
  // fills with solid white, from the middle out, as the stare builds.
  function drawEye(ctx, x, y, r, L, prog, lw) {
    const h = r * L.open * L.lid;
    const almond = () => {
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.quadraticCurveTo(x, y - h * 1.6, x + r, y);
      ctx.quadraticCurveTo(x, y + h * 1.6, x - r, y);
    };
    almond();
    halo(ctx, lw);
    ctx.lineWidth = lw;
    almond();
    ctx.stroke();
    if (L.lid <= 0.2) return;
    ctx.save();
    almond();
    ctx.clip();
    const ix = x + L.look.x * r * 0.35, iy = y + L.look.y * r * 0.15, ir = r * L.iris;
    ctx.beginPath();
    ctx.arc(ix, iy, ir, 0, TAU);
    ctx.stroke();
    if (prog > 0) {
      ctx.beginPath();
      ctx.arc(ix, iy, ir * Math.min(1, prog), 0, TAU);
      ctx.fill();
    }
    if (L.ring) {
      ctx.beginPath();
      ctx.arc(ix, iy, ir * 0.72, 0, TAU);
      ctx.stroke();
    }
    ctx.beginPath();
    if (L.slit) { ctx.moveTo(ix, iy - ir * 0.6); ctx.lineTo(ix, iy + ir * 0.6); ctx.stroke(); }
    else { ctx.arc(ix, iy, Math.max(1.5, r * 0.05), 0, TAU); ctx.fill(); }
    ctx.restore();
  }

  // Locked on, as in the classic: with gaze assist the gaze often sits well
  // outside the eye it has chosen, so a faint dotted line ties the two
  // together and a dashed ring marks the chosen eye.
  function drawLock(ctx, b, ptr, lw) {
    const r = b.radius, x = b.pos.x, y = b.pos.y;
    const dx = ptr.x - x, dy = ptr.y - y, d = Math.hypot(dx, dy);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = lw;
    if (d > r * 1.2) {
      ctx.setLineDash([1.5, 6]);
      ctx.beginPath();
      ctx.moveTo(x + (dx / d) * r, y + (dy / d) * r);
      ctx.lineTo(ptr.x, ptr.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([2, 7]);
    ctx.beginPath();
    ctx.arc(x, y, r * 1.35, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Cooperative MEDUSA's mark, in line: a ring with one slot per player
  // needed, the finder's in their colour and the missing ones dashed; while
  // it waits, a slow pulse in the finder's colour and who it waits for.
  // The players' colours stay here, as on the scoreboard: they are how the
  // two players tell whose eye it is.
  function drawWaiting(ctx, b, w, lw, H) {
    const on = w.on;
    if (!on.length) return;
    const who = on.map((id) => (w.playerOf && w.playerOf(id)) || null);
    const finder = (who[0] && who[0].color) || "#ffffff";
    const waiting = on.length < w.needed;
    const r = b.radius * 1.5, x = b.pos.x, y = b.pos.y;
    ctx.save();
    if (waiting) {
      const k = 0.5 + 0.5 * Math.sin((performance.now() / 1000) * TAU * 0.9);
      ctx.strokeStyle = finder;
      ctx.globalAlpha = 0.25 + 0.55 * k;
      ctx.lineWidth = lw + 2 * k;
      ctx.beginPath(); ctx.arc(x, y, r + 8 + 8 * k, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = lw * 1.6;
    for (let i = 0; i < w.needed; i++) {
      const a0 = -Math.PI / 2 + (i * TAU) / w.needed + 0.2;
      const a1 = -Math.PI / 2 + ((i + 1) * TAU) / w.needed - 0.2;
      const filled = i < on.length;
      ctx.strokeStyle = filled ? ((who[i] && who[i].color) || "#ffffff") : "rgba(255,255,255,.45)";
      ctx.setLineDash(filled ? [] : [2, 7]);
      ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (waiting) {
      const missing = (w.players || []).filter((p) => !who.includes(p));
      const short = w.needed - on.length;
      const named = missing.length === short;
      const label = named ? `waiting for ${missing.map((p) => p.label).join(" + ")}` : `waiting for ${short} more`;
      ctx.font = "13px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const gap = r + 30;
      const ly = y + gap + 12 < H ? y + gap : y - gap;
      const tw = ctx.measureText(label).width + 16;
      ctx.fillStyle = "#000";
      ctx.fillRect(x - tw / 2, ly - 11, tw, 22);
      ctx.fillStyle = named && missing.length === 1 ? missing[0].color : "#ffffff";
      ctx.fillText(label, x, ly);
    }
    ctx.restore();
  }

  // One blob, live or stone. opts: { prog, locked, waiting, textures, dt, height }
  function drawBlob(ctx, b, pointers, opts) {
    const L = looksOf(b), lw = weight(opts.height);
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (b.petrified) {
      if (!L.stone) L.stone = makeStone(opts.textures || []);
      drawStone(ctx, b.pos.x, b.pos.y, b.radius, L.stone, opts.textures || [], lw);
      ctx.restore();
      return;
    }
    // Back from stone: the same eye, opening again.
    if (L.stone) { L.stone = null; L.lid = 0; }
    animate(L, b, pointers, opts.dt, opts.prog > 0);
    drawEye(ctx, b.pos.x, b.pos.y, b.radius, L, opts.prog, lw);
    if (opts.locked) drawLock(ctx, b, opts.locked, lw);
    if (opts.waiting) drawWaiting(ctx, b, opts.waiting, lw, opts.height);
    ctx.restore();
  }

  // Where each player is looking: P1 a circle, P2 a square (and so on,
  // alternating), white, as in the design — and the same shapes as on the
  // scoreboard, so each player knows which mark is theirs.
  function drawPointers(ctx, pointers, opts) {
    const d = opts.size, lw = weight(opts.height) * 1.25;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = "#ffffff";
    ctx.lineWidth = lw;
    ctx.lineJoin = "round";
    for (const p of pointers) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const pl = opts.playerOf ? opts.playerOf(p.id) : null;
      const square = pl ? pl.id % 2 === 1 : p.id === "sim2";
      ctx.beginPath();
      if (square) { const s = d * 0.86; ctx.rect(p.x - s / 2, p.y - s / 2, s, s); }
      else ctx.arc(p.x, p.y, d / 2, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, lw), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  window.MedusaLine = { drawBlob, drawPointers, weight };
})();
