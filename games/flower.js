// ANEMONE — a flower that answers your pupils.
//
//   pupil DILATES        -> the bloom opens
//   pupil stays STATIC   -> it wilts, however wide it is
//
// The second rule is the piece: a still pupil means a still mind, so holding
// any fixed state — wide or narrow — lets the flower die. You keep it alive
// by actually reacting to things.
//
// Drawn procedurally rather than from a photograph so every petal can respond
// continuously. The look follows the reference: near-black ground, cool
// blue-to-violet petals, fine radial striations, dark stamen disc.
(function () {
  const NUM_PETALS = 8;
  const LAYERS = 3;           // back to front; back petals are larger, darker
  const STRIATIONS = 44;      // fine lines per petal — the signature detail

  let W = 0, H = 0;
  let seedNoise = [];
  let t = 0;

  // Simulated pupil for mouse/keyboard play. Neon overrides this the moment
  // real samples arrive.
  //
  // Mouse height alone couples the two signals: to make the pupil VARY you
  // must also change its SIZE, so you can't hold it wide and static — which
  // is exactly the case worth testing. Hence explicit modes.
  //   "mouse"  size follows the cursor (moving it = varying = alive)
  //   "frozen" size pinned exactly — the wilt case, at whatever width
  //   "lively" size held but breathing — the recovery case
  let simMm = 4.0, simTarget = 4.0, simMode = "mouse";

  function lerp(a, b, k) { return a + (b - a) * k; }

  // Per-petal random offsets, fixed once so the flower doesn't shimmer.
  function buildSeeds() {
    seedNoise = [];
    for (let l = 0; l < LAYERS; l++) {
      const layer = [];
      for (let i = 0; i < NUM_PETALS; i++) {
        layer.push({
          lean: (Math.random() - 0.5) * 0.22,
          curl: 0.85 + Math.random() * 0.3,
          len: 0.9 + Math.random() * 0.2,
          hue: (Math.random() - 0.5) * 26,
          phase: Math.random() * Math.PI * 2,
        });
      }
      seedNoise.push(layer);
    }
  }

  window.setup = function () {
    const c = createCanvas(windowWidth, windowHeight);
    c.parent(document.body);
    W = width; H = height;
    buildSeeds();
    if (window.Pupil) Pupil.start();
    colorMode(HSB, 360, 100, 100, 1);
    noStroke();

    if (window.ControlsHint) {
      ControlsHint.show([
        { keys: "mouse ↕", does: "pupil size (moving = alive)" },
        { keys: "hold c", does: "eyes closed → flower shuts" },
        { keys: "f", does: "freeze pupil → wilt" },
        { keys: "l", does: "hold width, keep varying → revive" },
        { keys: "r", does: "reset" },
      ], "anemone");
    }
  };

  window.keyPressed = function () {
    const k = (key || "").toLowerCase();
    // Freeze/lively pin the CURRENT width so the two signals can be varied
    // independently — the whole point of the mechanic.
    if (k === "f") simMode = simMode === "frozen" ? "mouse" : "frozen";
    if (k === "l") simMode = simMode === "lively" ? "mouse" : "lively";
    if (k === "r") { if (window.Pupil) Pupil.reset(); simMode = "mouse"; }
  };

  window.windowResized = function () {
    resizeCanvas(windowWidth, windowHeight);
    W = width; H = height;
  };

  // Petal outline. `w` scales the half-width, so the same curve can be used
  // for the silhouette and for the inner striation paths.
  // `phase` shifts the edge ripple. Striations pass their own so they don't
  // all carry an identical wave — when every inner line was an exact scaled
  // copy of the outline they aligned into bands and the petal looked like
  // brushed metal rather than fibre.
  function petalOutline(ctx, len, wide, curl, droop, w, close, phase) {
    const pt = (s, side) => {
      // sin() gives a rounded body that tapers at both ends; the exponent
      // pushes the widest point outward so it reads as a broad anemone petal
      // rather than a leaf. A rounded tip (not a spike) needs the taper eased
      // off near s=1, hence the small floor.
      const spread = (Math.pow(Math.sin(Math.PI * s), 0.62) * 0.97 + 0.03) * curl;
      // One slow ripple, not seven — the high frequency was faceting the
      // silhouette into a polygon.
      const ruffle = 1 + Math.sin(s * 2.4 + (phase || 0)) * 0.026;
      return [side * wide * spread * w * ruffle,
              -len * s + droop * len * s * s * 0.55];
    };
    let p = pt(0, -1);
    ctx.moveTo(p[0], p[1]);
    for (let s = 0; s <= 1.0001; s += 0.02) { p = pt(s, -1); ctx.lineTo(p[0], p[1]); }
    for (let s = 1; s >= -0.0001; s -= 0.02) { p = pt(s, 1); ctx.lineTo(p[0], p[1]); }
    if (close) ctx.closePath();
  }

  // One petal. Drawn straight onto the 2D context rather than through p5's
  // shape API so it can carry a real gradient — flat fills were what made the
  // first version look like cut paper instead of a translucent petal.
  // `depth` 0 = frontmost, 1 = rearmost. Depth DARKENS and fades a petal but
  // must not touch its colour temperature — dimming rear petals by lowering
  // their vitality instead turned them grey, and the bloom looked like a
  // violet flower sitting on a dead one.
  function petal(len, wide, openness, vitality, seed, depth) {
    const ctx = drawingContext;
    const curl = lerp(0.62, 1.0, vitality) * seed.curl;
    const droop = (1 - vitality) * 0.5;
    // Rear petals stay fairly OPAQUE but go dark. Fading them out instead
    // left a near-invisible body with the striations still drawing over it,
    // so the back of the bloom read as a pale wireframe ring.
    const dim = lerp(1.0, 0.18, depth);     // how far it sinks toward DEEP
    const fade = lerp(1.0, 0.62, depth);    // and recedes in opacity
    const fibre = Math.pow(1 - depth, 2.2); // striations vanish quickly behind

    push();
    rotate(seed.lean * (1 - openness * 0.4) + droop * 0.22);

    // Base -> tip gradient. Alive: deep violet at the base washing out to a
    // pale blue-white at the edge, which is what gives the reference its
    // backlit, translucent quality. Dying: the whole ramp desaturates toward
    // a cold grey and loses its glow.
    const g = ctx.createLinearGradient(0, 0, 0, -len);
    const v = vitality, o = 0.35 + openness * 0.65;
    const A = (a) => a * lerp(0.42, 0.92, v) * fade;

    // Rear petals sink toward a deep indigo rather than being scaled down
    // channel-wise. Plain multiplication drags a near-white petal tip to a
    // neutral grey, which is why the back of the bloom looked like ash.
    // Strongly violet, not a neutral dark. The petal tips are near-white, so
    // a desaturated sink colour keeps R≈G and the rear of the bloom turns to
    // ash no matter how far it is dimmed.
    const DEEP = [34, 16, 86];
    const mix = (dead, alive) => [0, 1, 2].map((i) =>
      Math.round(lerp(lerp(dead[i], alive[i], v), DEEP[i], 1 - dim))
    ).join(",");

    // Every stop keeps a real blue-violet bias. An earlier ramp ran to
    // (224,232,255) at the tip — R≈G≈B, which is grey by definition, and it
    // made the outer half of every petal look like ash however the layers
    // were tuned. The white in the reference comes from the STRIATIONS
    // sitting on a coloured petal, not from the petal turning white.
    g.addColorStop(0.00, `rgba(${mix([52,50,74],   [64,52,124])},${A(0.96)})`);
    g.addColorStop(0.28, `rgba(${mix([70,68,98],   [104,92,198])},${A(0.94)})`);
    g.addColorStop(0.58, `rgba(${mix([92,92,122],  [140,134,232])},${A(0.90)})`);
    g.addColorStop(0.84, `rgba(${mix([108,110,138],[170,172,244])},${A(0.82 * o)})`);
    g.addColorStop(1.00, `rgba(${mix([116,118,146],[186,192,250])},${A(0.52 * o)})`);

    ctx.save();
    ctx.beginPath();
    petalOutline(ctx, len, wide, curl, droop, 1, true, seed.phase);
    ctx.fillStyle = g;
    ctx.fill();

    // Striations clipped to the petal, so they can run right to the edge
    // without spilling. Each is a scaled copy of the outline, which makes
    // them follow the petal's curvature instead of fanning geometrically.
    ctx.clip();
    ctx.lineWidth = Math.max(0.45, W * 0.00055);
    for (let i = 1; i < STRIATIONS; i++) {
      const f = i / STRIATIONS;         // 0..1 across the petal
      const w = (f - 0.5) * 2;          // -1..1, signed so both halves are drawn
      // Brighter toward the middle of the petal, fading at the edges.
      const edge = 1 - Math.abs(w);
      ctx.beginPath();
      // Per-line phase offset breaks up the banding.
      petalOutline(ctx, len, wide, curl, droop, w, false, seed.phase + i * 0.9);
      ctx.strokeStyle = `rgba(${(lerp(150,232,v)*dim)|0},${(lerp(152,238,v)*dim)|0},${(lerp(170,255,v)*dim)|0},${
        lerp(0.04, 0.22, v) * (0.3 + edge * 0.7) * fibre})`;
      ctx.stroke();
    }

    // Shadow pooling where the petal meets the centre — cheap depth that
    // stops the bloom reading as one flat disc.
    const sh = ctx.createRadialGradient(0, 0, 0, 0, 0, len * 0.55);
    sh.addColorStop(0, `rgba(10,10,26,${lerp(0.55, 0.34, v)})`);
    sh.addColorStop(1, "rgba(10,10,26,0)");
    ctx.fillStyle = sh;
    ctx.fillRect(-wide * 1.6, -len * 1.1, wide * 3.2, len * 1.3);
    ctx.restore();

    pop();
  }

  function stamens(r, vitality) {
    const ctx = drawingContext;
    const v = vitality;

    // Filaments first so the disc overlaps their roots.
    ctx.lineWidth = Math.max(0.5, r * 0.028);
    for (let i = 0; i < 150; i++) {
      const a = (i / 150) * Math.PI * 2 + Math.sin(i * 3.1) * 0.02;
      const l = r * (1.5 + 1.5 * Math.abs(Math.sin(i * 12.9898)));
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55);
      ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
      ctx.strokeStyle = `rgba(${lerp(70,150,v)|0},${lerp(70,148,v)|0},${lerp(92,186,v)|0},${lerp(0.18,0.5,v)})`;
      ctx.stroke();
    }

    // Anther dots — the pale speckled ring that reads as an anemone.
    for (let i = 0; i < 150; i++) {
      const a = (i / 150) * Math.PI * 2 + Math.sin(i * 3.1) * 0.02;
      const l = r * (1.5 + 1.5 * Math.abs(Math.sin(i * 12.9898)));
      ctx.beginPath();
      ctx.arc(Math.cos(a) * l, Math.sin(a) * l, r * 0.075, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${lerp(120,238,v)|0},${lerp(122,240,v)|0},${lerp(140,226,v)|0},${lerp(0.3,0.95,v)})`;
      ctx.fill();
    }

    // The dark navy eye at the centre.
    const d = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.15);
    d.addColorStop(0.00, `rgba(${lerp(16,20,v)|0},${lerp(16,20,v)|0},${lerp(30,44,v)|0},1)`);
    d.addColorStop(0.72, `rgba(${lerp(12,14,v)|0},${lerp(12,15,v)|0},${lerp(24,34,v)|0},1)`);
    d.addColorStop(1.00, "rgba(8,8,18,0)");
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
    ctx.fillStyle = d;
    ctx.fill();
  }

  window.draw = function () {
    t += 0.006;

    // --- signal ---------------------------------------------------------
    if (window.Tracking) Tracking.update();
    const live = window.Pupil && Pupil.neonLive();
    if (!live && window.Pupil) {
      if (keyIsDown(67) /* c — simulate eyes closed */) {
        Pupil.feedClosed();
      } else if (simMode === "mouse") {
        simTarget = 2.5 + (1 - mouseY / Math.max(1, height)) * 4.5;
        simMm = lerp(simMm, simTarget, 0.08);
        Pupil.feed(simMm);
      } else if (simMode === "frozen") {
        // Exactly the same value every frame — the wilt case.
        Pupil.feed(simMm);
      } else {
        // Held at the same average width but genuinely varying, so vitality
        // recovers without the width changing. Amplitude sits well above the
        // static threshold in pupil.js.
        Pupil.feed(simMm + Math.sin(t * 9) * 0.45);
      }
    }
    const openness = window.Pupil ? Pupil.dilation() : 0.5;
    const vitality = window.Pupil ? Pupil.vitality() : 1;

    // --- ground ---------------------------------------------------------
    background(232, 45, lerp(4, 7, vitality));

    // Faint vignette glow behind the bloom, stronger when alive.
    push();
    translate(W / 2, H / 2);
    for (let i = 6; i > 0; i--) {
      fill(250, 40, 12, 0.05 * vitality);
      ellipse(0, 0, Math.min(W, H) * (0.5 + i * 0.09));
    }
    pop();

    // --- flower ---------------------------------------------------------
    const base = Math.min(W, H) * 0.42;
    push();
    translate(W / 2, H / 2);
    // Slow breathing so it never looks like a static image.
    rotate(Math.sin(t * 0.7) * 0.012);
    const breathe = 1 + Math.sin(t * 1.6) * 0.008 * vitality;

    for (let l = LAYERS - 1; l >= 0; l--) {
      const layerK = l / (LAYERS - 1 || 1);
      // Rear layers sit slightly smaller and rotated so they fill the gaps
      // between the front petals rather than hiding directly behind them.
      const scaleL = (1.0 - layerK * 0.14) * breathe;
      const spin = (l * Math.PI) / NUM_PETALS + Math.sin(t * 0.5 + l) * 0.006;

      push();
      rotate(spin);
      for (let i = 0; i < NUM_PETALS; i++) {
        const seed = seedNoise[l][i];
        push();
        rotate((i / NUM_PETALS) * TWO_PI);
        // Openness spreads the petals outward from the centre.
        const reach = base * scaleL * seed.len * lerp(0.46, 1.0, openness);
        // Wide enough that neighbours overlap — the reference reads as a
        // dense bloom, and non-overlapping petals look like a paper star.
        const wide = base * 0.42 * scaleL * lerp(0.78, 1.06, vitality);
        translate(0, -reach * 0.04);
        petal(reach, wide, openness, vitality, seed, layerK);
        pop();
      }
      pop();
    }

    stamens(base * 0.1, vitality);
    pop();

    drawHud(openness, vitality, live);
  };

  function drawHud(openness, vitality, live) {
    push();
    resetMatrix();
    colorMode(RGB, 255);
    const pad = 18;
    noStroke();
    fill(190, 190, 200, 150);
    textFont("monospace");
    textSize(11);
    textAlign(LEFT, TOP);
    const mm = window.Pupil && Pupil.lastMm();
    const src = live ? "neon" : `simulated · ${simMode}`;
    text(
      `PUPIL   ${mm ? mm.toFixed(2) + " mm" : "--"}   ${src}\n` +
      `BLOOM   ${(openness * 100).toFixed(0)}%\n` +
      `VITALITY ${(vitality * 100).toFixed(0)}%`,
      pad, pad
    );

    // Vitality bar — the thing the visitor is actually fighting.
    const bw = 190, bh = 3, bx = pad, by = pad + 54;
    fill(255, 255, 255, 26); rect(bx, by, bw, bh);
    fill(lerp(150, 120, vitality), lerp(120, 170, vitality), 230, 220);
    rect(bx, by, bw * vitality, bh);

    if (vitality < 0.25) {
      fill(210, 160, 190, 120 + Math.sin(t * 4) * 60);
      textAlign(CENTER, CENTER);
      textSize(13);
      text("it is wilting — react to something", W / 2, H - 40);
    }
    pop();
  }
})();
