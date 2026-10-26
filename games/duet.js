// DUET — each gaze is a voice; find each other.
//
// There is no target and no score, only two people listening to each other.
// Everything on screen is the sound made visible:
//
//   HEIGHT    is pitch. Faint staff lines mark the notes of the scale; look
//             between two and the voice slides between them.
//   DISTANCE  between the two gazes is tension. Far apart, each voice wavers,
//             glides off the scale and beats against itself; the rings it
//             sends out wobble, and the thread between the two eyes vibrates
//             with the real ratio of their pitches — tangled while that ratio
//             is not a simple one. Coming closer pulls both voices onto the
//             scale's pure intervals: the rings round out, the thread calms.
//   MEETING   (both within MEET of each other) blooms a chord under the two
//             voices, drawn as a Lissajous figure of the chord's own frequency
//             ratio — a closed, still shape, which is what consonance looks
//             like. Held for HARMONY_SEC somewhere new, it stays there as a
//             glyph and fills one of the dots below.
//   FIXATIONS ring a soft bell each, and leave a fading dot: the score of
//             the duet so far.
//
// After PIECE harmonies the piece plays itself back — each glyph's chord in
// the order it was found — and begins again.
//
// Colours are Okabe & Ito's colour-blind-safe set: player 1 orange, player 2
// sky blue, harmony yellow. They ADD, so where the two meet their light turns
// white. Colour is never the only cue: player 2's rings are dashed.
//
// The players, their trackers and the setup screens are shared with DUCK HUNT
// (shared/gaze/duo-session.js); the sound is duet-sound.js.
(function () {
  const COLORS = { p1: "#E69F00", p2: "#56B4E9", harmony: "#F0E442", glyph: "#FFF6DA" };

  // Tuned so the intervals the voices settle into are pure. The pentatonic
  // moods are Pythagorean — a chain of perfect fifths, which is what a
  // pentatonic scale is — so EVERY fourth and fifth between two of its notes
  // is exact. The obvious just-intonation version (…5/4, 3/2, 5/3) hides a
  // wolf fifth of 40:27 between its 2nd and 6th, a fifth of a semitone flat,
  // and it soured every chord that used both.
  const MOODS = {
    dawn: { root: 146.83, ratios: [1, 9 / 8, 81 / 64, 3 / 2, 27 / 16] },   // major pentatonic
    dusk: { root: 146.83, ratios: [1, 32 / 27, 4 / 3, 3 / 2, 16 / 9] },    // minor pentatonic
    mist: { root: 130.81, ratios: [1, 9 / 8, 6 / 5, 3 / 2, 8 / 5] },       // hirajōshi
  };
  const DEGREES = 11;          // two octaves of a five-note scale, and the top note

  // ------------------------------------------------------------- settings
  let MOOD = "dawn";
  let MEET = 0.13;             // x screen height: this close is "together"
  const ATTRACT = 0.62;        // x screen height: harmony starts pulling from here
  let HARMONY_SEC = 2.5;       // held together this long somewhere new → a glyph
  const PIECE = 8;             // glyphs in a piece
  const GLYPH_SPACING = 0.15;  // x screen height between glyphs
  let BELLS = true;
  let PARTNER = "person";      // "person" | "echo" (a solo test companion)
  const CODA_STEP_MS = 2300;
  const CODA_FADE_MS = 5000;

  const canvas = document.getElementById("duet");
  const ctx = canvas.getContext("2d");
  let W = innerWidth, H = innerHeight;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const ease = (dt, tc) => 1 - Math.exp(-dt / tc);

  // ---------------------------------------------------------------- scale
  const mood = () => MOODS[MOOD];
  function freqAt(n) {
    const o = Math.floor(n / 5), s = ((n % 5) + 5) % 5;
    return mood().root * Math.pow(2, o) * mood().ratios[s];
  }
  // Between two notes the pitch slides evenly in log-frequency, so a gaze
  // resting exactly on a staff line sings exactly that note.
  function freqAtCont(c) {
    const lo = Math.floor(c), hi = Math.ceil(c);
    if (lo === hi) return freqAt(lo);
    const fl = freqAt(lo), fh = freqAt(hi);
    return fl * Math.pow(fh / fl, c - lo);
  }
  const staffTop = () => H * 0.12;
  const staffBottom = () => H * 0.84;
  const degreeAtY = (y) => clamp((staffBottom() - y) / (staffBottom() - staffTop()) * (DEGREES - 1), 0, DEGREES - 1);
  const yOfDegree = (n) => staffBottom() - (n / (DEGREES - 1)) * (staffBottom() - staffTop());

  // A frequency ratio as small whole numbers (3:2, 5:4 …) — the shape of the
  // Lissajous figure. Octaves are folded in so the figure stays simple. The
  // tolerance admits the Pythagorean third and minor third (81:64, 32:27) as
  // 5:4 and 6:5, and nothing that would be heard as out of tune.
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }
  function ratioOf(f1, f2) {
    let r = Math.max(f1, f2) / Math.min(f1, f2);
    while (r > 3.01) r /= 2;
    for (let b = 1; b <= 6; b++) {
      const a = Math.round(r * b);
      if (Math.abs(a / b - r) < 0.016) { const g = gcd(a, b); return [a / g, b / g]; }
    }
    return null;
  }

  // The simplest interval inside a chord — the figure for a meeting sung in
  // unison, which as a ratio (1:1) would only draw a line.
  function chordFigure(root) {
    const tones = [root, root + 2, root + 4].map(freqAt);
    let best = null;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const r = ratioOf(tones[i], tones[j]);
      if (r && (!best || r[0] + r[1] < best[0] + best[1])) best = r;
    }
    return best || [3, 2];
  }

  // --------------------------------------------------------------- voices
  function newVoice(i) {
    return {
      i, color: i === 0 ? COLORS.p1 : COLORS.p2, dashed: i === 1,
      x: W / 2, y: H / 2, seen: false, present: false, held: false,
      speed: 0, steady: 0, vamp: 0, f: freqAt(4), q: 4, snap: 0,
      det: new FixationDetector({ dispersionPx: 60, minDurationMs: 120 }),
      fixStart: null, lastBellAt: 0, rings: [], lastRingAt: 0,
    };
  }
  let V = [newVoice(0), newVoice(1)];

  // The echo: a companion for testing alone. It drifts after player 1 with
  // a lag and a slow wander of its own, so one person can hear the whole arc
  // from apart to together.
  const echo = { x: null, y: null };
  function echoPointer(lead, dt, t) {
    if (!lead || lead.held) return echo.x == null ? null : { id: "echo", x: echo.x, y: echo.y, held: true };
    if (echo.x == null) { echo.x = W - lead.x; echo.y = H - lead.y; }
    const k = ease(dt, 1.6);
    echo.x += (lead.x + Math.sin(t * 0.31) * H * 0.05 - echo.x) * k;
    echo.y += (lead.y + Math.cos(t * 0.23) * H * 0.04 - echo.y) * k;
    return { id: "echo", x: echo.x, y: echo.y };
  }

  function track(v, p, dt) {
    v.present = !!p && !p.held;
    v.held = !!p && !!p.held;
    if (p) {
      const sp = v.seen ? Math.hypot(p.x - v.x, p.y - v.y) / Math.max(dt, 1e-3) : 0;
      v.speed += (sp - v.speed) * ease(dt, 0.12);
      v.x = p.x; v.y = p.y; v.seen = true;
    }
    // Steady gaze sings; a moving one goes quiet. Eyes move in jumps, so this
    // is smoothed — otherwise every saccade would chop the voice in half.
    const steadyNow = v.present ? clamp(1 - v.speed / 1400, 0, 1) : 0;
    v.steady += (steadyNow - v.steady) * ease(dt, 0.25);
  }

  // ---------------------------------------------------------------- state
  let meetT = 0, collectT = 0, bloom = 0;
  let meetX = W / 2, meetY = H / 2;
  let chordRoot = 4, chordFreqs = [freqAt(4) / 2, freqAt(4), freqAt(6), freqAt(8)];
  let figure = [3, 2];
  let glyphs = [];             // { x, y, a, b, freqs, born, glow }
  let traces = [];             // { x, y, t, color }
  let bursts = [];             // { x, y, t, color, dashed, big }
  let coda = null;             // { start, step }
  let lastPresentAt = performance.now();
  let introAt = null;
  let lastFrame = performance.now();

  // ---------------------------------------------------------------- frame
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const t = now / 1000;

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (!DuoSession.started) return;

    // Who is where.
    const pts = Tracking.update();
    const byPlayer = [null, null];
    for (const p of pts) {
      const player = DuoSession.playerOf(p.id);
      if (!player || !Number.isFinite(p.x)) continue;
      const i = PLAYERS.indexOf(player);
      if (i >= 0 && !byPlayer[i]) byPlayer[i] = p;
    }
    if (PARTNER === "echo") byPlayer[1] = echoPointer(byPlayer[0], dt, t);
    V.forEach((v, i) => track(v, byPlayer[i], dt));
    if (V.some((v) => v.present)) lastPresentAt = now;

    // The two of them.
    const both = V[0].present && V[1].present;
    const d = both ? Math.hypot(V[0].x - V[1].x, V[0].y - V[1].y) : Infinity;
    const meetPx = MEET * H;
    const closeness = both ? smooth(ATTRACT * H, meetPx, d) : 0;
    const tension = both ? 1 - closeness : 0.45;
    const meeting = both && d < meetPx && !coda;

    if (meeting) {
      meetT += dt;
      meetX = (V[0].x + V[1].x) / 2;
      meetY = (V[0].y + V[1].y) / 2;
      chordRoot = Math.round(degreeAtY(meetY));
      chordFreqs = [freqAt(chordRoot) / 2, freqAt(chordRoot), freqAt(chordRoot + 2), freqAt(chordRoot + 4)];
    } else {
      meetT = Math.max(0, meetT - dt * 1.5);
    }
    bloom += ((meeting ? 1 : 0) - bloom) * ease(dt, meeting ? 0.9 : 0.6);

    // Pitches. Player 1 first: player 2 avoids singing the very same note in
    // a meeting, so the two make an interval rather than a unison.
    V.forEach((v, i) => pitch(v, i, closeness, tension, meeting, t));
    if (meeting) {
      const r = ratioOf(V[0].f, V[1].f);
      figure = r && !(r[0] === 1 && r[1] === 1) ? r : chordFigure(chordRoot);
    }

    // Sound.
    const duck = coda ? 0.35 : 1;
    V.forEach((v, i) => {
      const amp = v.present ? (0.05 + 0.12 * v.steady) * duck : 0;
      v.vamp += (amp - v.vamp) * ease(dt, amp > v.vamp ? 0.18 : 0.45);
      DuetSound.voice(i, { f: v.f, amp, pan: (v.x / W) * 1.6 - 0.8, tension, clarity: closeness });
    });
    if (!coda) DuetSound.chord(chordFreqs, bloom);
    DuetSound.drone(0.012 + 0.005 * glyphs.length);

    // Fixations → bells.
    V.forEach((v, i) => {
      if (!v.present) { v.det.flush(); return; }
      v.det.push(now, v.x, v.y);
      const cur = v.det.current();
      if (cur && cur.start !== v.fixStart) {
        v.fixStart = cur.start;
        fixated(v, i, cur, closeness, meeting, now);
      }
    });

    // Harmony found somewhere new?
    let resung = null;
    if (meeting) {
      resung = glyphs.find((g) => Math.hypot(g.x - meetX, g.y - meetY) < GLYPH_SPACING * H) || null;
      if (resung) { resung.glow = 1; collectT = Math.max(0, collectT - dt * 2); }
      else {
        collectT += dt;
        if (collectT >= HARMONY_SEC) collect(now);
      }
    } else {
      collectT = Math.max(0, collectT - dt * 2);
    }

    if (coda) runCoda(now);

    // Rings: each voice keeps sending out its sound as circles.
    V.forEach((v) => {
      const period = 1000 / (0.7 + 0.25 * degreeAtY(v.y));
      if (v.vamp > 0.035 && now - v.lastRingAt > period) {
        v.rings.push({ x: v.x, y: v.y, t: now, amp: v.vamp });
        v.lastRingAt = now;
      }
      v.rings = v.rings.filter((r) => now - r.t < 1900);
    });

    draw(now, t, { both, d, closeness, tension, meeting, resung });
  }

  function pitch(v, i, closeness, tension, meeting, t) {
    const c = degreeAtY(v.y);
    let q = Math.round(c);
    if (meeting) {
      // The nearest chord tone, in any octave on the staff.
      const cands = [];
      for (const base of [chordRoot, chordRoot + 2, chordRoot + 4]) {
        for (const o of [-10, -5, 0, 5, 10]) {
          const n = base + o;
          if (n >= 0 && n <= DEGREES + 3) cands.push(n);
        }
      }
      cands.sort((a, b) => Math.abs(a - c) - Math.abs(b - c));
      q = cands[0];
      // Player 2 sings the harmony line: among the chord tones within reach,
      // the one that sounds best against player 1's — the simpler the ratio
      // the better (3:2, 4:3 before 5:4 …). Consonance outweighs distance on
      // purpose: two people who have met are at the same height, so "nearest"
      // would nearly always be the same note. A unison is still better than a
      // second; close chord voicings are full of seconds, and a second is a
      // rub, not the harmony this moment is for. Over every chord and meeting
      // in all three moods: fourths and fifths ~64%, thirds/sixths ~18%,
      // unison ~15% (no other tone in reach), seconds never.
      if (i === 1) {
        const f1 = freqAt(V[0].q);
        let best = null, bestScore = Infinity;
        for (const n of cands) {
          const dist = Math.abs(n - c);
          if (dist > 3.2) continue;
          const r = ratioOf(f1, freqAt(n));
          const score = 0.5 * dist + (n === V[0].q ? 5 : r ? (r[0] + r[1]) / 3 : 8);
          if (score < bestScore) { bestScore = score; best = n; }
        }
        if (best != null) q = best;
      }
    }
    const k = meeting ? 1 : clamp(0.3 + 0.7 * closeness + 0.25 * v.steady, 0, 1);
    const fc = freqAtCont(c), fq = freqAt(q);
    let f = Math.exp(Math.log(fc) * (1 - k) + Math.log(fq) * k);
    // Apart, a voice wanders a little off pitch on its own — searching.
    const drift = (meeting ? 0 : tension) * 26 * Math.sin(t * 0.9 + i * 2.1) * Math.sin(t * 0.37 + i);
    f *= Math.pow(2, drift / 1200);
    v.q = q; v.snap = k; v.f = f;
  }

  function fixated(v, i, fix, closeness, meeting, now) {
    traces.push({ x: fix.x, y: fix.y, t: now, color: v.color });
    if (traces.length > 240) traces.shift();
    if (!BELLS || now - v.lastBellAt < 280 || coda) return;
    v.lastBellAt = now;
    const n = meeting ? v.q : Math.round(degreeAtY(fix.y));
    // Player 2's bells an octave up, so the two can be told apart by ear.
    const f = freqAt(n) * (i === 1 ? 2 : 1);
    DuetSound.bell(f, (fix.x / W) * 1.6 - 0.8, 0.05 + 0.05 * closeness);
    bursts.push({ x: fix.x, y: fix.y, t: now, color: v.color, dashed: v.dashed });
  }

  function collect(now) {
    collectT = 0;
    glyphs.push({ x: meetX, y: meetY, a: figure[0], b: figure[1], freqs: chordFreqs.slice(), born: now, glow: 1 });
    const tones = chordFreqs.slice(1);
    DuetSound.arpeggio(tones.concat(tones[0] * 2), (meetX / W) * 1.6 - 0.8, 0.08);
    bursts.push({ x: meetX, y: meetY, t: now, color: COLORS.harmony, big: true });
    if (glyphs.length >= PIECE) coda = { start: now + 1200, step: -1 };
  }

  // The piece plays itself back: each glyph's chord in the order it was found,
  // a line drawn on to the next, then everything fades and a new one begins.
  function runCoda(now) {
    const el = now - coda.start;
    if (el < 0) { DuetSound.chord(chordFreqs, 0); return; }
    const k = Math.floor(el / CODA_STEP_MS);
    if (k < glyphs.length) {
      if (k !== coda.step) {
        coda.step = k;
        const g = glyphs[k];
        const tones = g.freqs.slice(1);
        DuetSound.arpeggio(tones.concat(tones[0] * 2), (g.x / W) * 1.6 - 0.8, 0.07, 0.11);
        g.glow = 1;
      }
      DuetSound.chord(glyphs[k].freqs, 0.85);
    } else {
      DuetSound.chord(glyphs[glyphs.length - 1].freqs, 0);
      if (el > glyphs.length * CODA_STEP_MS + CODA_FADE_MS) newPiece();
    }
  }

  function codaFade(now) {
    if (!coda) return 1;
    const el = now - coda.start - glyphs.length * CODA_STEP_MS;
    return el <= 0 ? 1 : clamp(1 - el / CODA_FADE_MS, 0, 1);
  }

  function newPiece() {
    glyphs = []; traces = []; bursts = []; coda = null;
    collectT = 0; meetT = 0;
    if (window.DataCollection) DataCollection.newPart("piece");
  }

  // ---------------------------------------------------------------- drawing
  // Light ADDS only where the two voices mix — the thread, the bloom — so
  // orange and blue make white there. Each player's own marks are drawn
  // plainly: stacked on themselves, additive orange saturates into the
  // harmony's yellow, and the colours stop telling the players apart.
  function draw(now, t, s) {
    const fade = codaFade(now);
    drawStaff();
    drawTraces(now, fade);
    drawGlyphs(now, t, fade);
    if (coda) drawCodaPath(now, fade);
    V.forEach((v) => drawRings(v, now, s.tension));
    ctx.globalCompositeOperation = "lighter";
    if (s.both) drawThread(t, s);
    if (bloom > 0.02) drawBloom(t);
    ctx.globalCompositeOperation = "source-over";
    drawBursts(now);
    if (DuoSession.showTarget) V.forEach((v) => drawEye(v));
    drawDots(fade);
    drawIntro(now);
  }

  // The staff: one faint line per note, the roots a little brighter. Kept off
  // the screen's edges, which in frame mode belong to the tracking frame.
  function drawStaff() {
    const x0 = W * 0.07, x1 = W * 0.93;
    ctx.lineWidth = 1;
    for (let n = 0; n < DEGREES; n++) {
      const y = yOfDegree(n);
      ctx.strokeStyle = n % 5 === 0 ? "rgba(255,255,255,.11)" : "rgba(255,255,255,.05)";
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
    // The note a voice has settled on lights up under it.
    ctx.globalCompositeOperation = "lighter";
    for (const v of V) {
      if (!v.present || v.snap < 0.6 || v.q < 0 || v.q > DEGREES - 1) continue;
      const y = yOfDegree(v.q);
      const a = clamp(v.vamp / 0.17, 0, 1) * (v.snap - 0.6) / 0.4;
      const g = ctx.createLinearGradient(v.x - 200, 0, v.x + 200, 0);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.5, hexA(v.color, 0.75 * a));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.strokeStyle = g; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(v.x - 200, y); ctx.lineTo(v.x + 200, y); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function drawTraces(now, fade) {
    for (const p of traces) {
      const a = (1 - (now - p.t) / 25000) * 0.55 * fade;
      if (a <= 0) continue;
      ctx.fillStyle = hexA(p.color, a);
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2); ctx.fill();
    }
    traces = traces.filter((p) => now - p.t < 25000);
  }

  // The string between the two: both voices travelling along it at once,
  // each with as many waves as its pitch. A simple ratio between them repeats
  // cleanly along the line; any other crawls and knots.
  function drawThread(t, s) {
    const [a, b] = V;
    const len = s.d;
    if (len < 8) return;
    const alpha = (0.3 + 0.5 * s.closeness) * (1 - bloom);
    if (alpha < 0.02) return;
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const root = mood().root;
    const k1 = (a.f / root) * 1.3, k2 = (b.f / root) * 1.3;
    const w1 = (a.f / root) * 2.2, w2 = (b.f / root) * 2.2;
    const amp = (3 + 20 * s.tension) * Math.min(1, len / 260);
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, hexA(a.color, alpha));
    g.addColorStop(1, hexA(b.color, alpha));
    ctx.strokeStyle = g; ctx.lineWidth = 1.6;
    ctx.beginPath();
    const N = 160;
    for (let j = 0; j <= N; j++) {
      const u = j / N;
      const off = amp * Math.sin(Math.PI * u) * 0.5 *
        (Math.sin(2 * Math.PI * k1 * u - w1 * t) + Math.sin(2 * Math.PI * k2 * u - w2 * t));
      const x = a.x + (b.x - a.x) * u + nx * off;
      const y = a.y + (b.y - a.y) * u + ny * off;
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  function lissajous(cx, cy, R, a, b, delta, upTo = 1, steps = 420) {
    ctx.beginPath();
    const end = Math.max(1, Math.round(steps * upTo));
    for (let j = 0; j <= end; j++) {
      const th = (j / steps) * Math.PI * 2;
      const x = cx + R * Math.sin(a * th + delta);
      const y = cy + R * Math.sin(b * th);
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
  }

  // The meeting: a warm light, and the chord's figure written in both colours
  // at once — slightly out of step, so where they agree the light is white.
  function drawBloom(t) {
    const R = H * (0.045 + 0.1 * bloom);
    const glow = ctx.createRadialGradient(meetX, meetY, 0, meetX, meetY, R * 2.2);
    glow.addColorStop(0, hexA(COLORS.harmony, 0.22 * bloom));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(meetX, meetY, R * 2.2, 0, Math.PI * 2); ctx.fill();

    // Written out as the harmony is held; whole once it is found, or when
    // this is a harmony already found.
    const upTo = collectT > 0 ? clamp(collectT / HARMONY_SEC, 0.04, 1) : 1;
    const [a, b] = figure;
    const delta = t * 0.25;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 14;
    for (const [color, off] of [[COLORS.p1, 0], [COLORS.p2, 0.1]]) {
      ctx.shadowColor = color;
      ctx.strokeStyle = hexA(color, 0.85 * bloom);
      lissajous(meetX, meetY, R, a, b, delta + off, upTo);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  function drawGlyphs(now, t, fade) {
    for (const g of glyphs) {
      g.glow = Math.max(0, g.glow - 0.012);
      const R = H * (0.028 + 0.02 * g.glow);
      const a = (0.45 + 0.5 * g.glow) * fade;
      ctx.shadowBlur = 6 + 18 * g.glow; ctx.shadowColor = COLORS.harmony;
      ctx.strokeStyle = hexA(COLORS.glyph, a);
      ctx.lineWidth = 1.4;
      lissajous(g.x, g.y, R, g.a, g.b, t * 0.12 + g.born / 1000, 1, 300);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  function drawCodaPath(now, fade) {
    const el = now - coda.start;
    if (el < 0) return;
    const pos = el / CODA_STEP_MS;              // glyph index, fractional
    ctx.strokeStyle = hexA(COLORS.harmony, 0.5 * fade);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let k = 0; k < glyphs.length; k++) {
      const g = glyphs[k];
      if (k === 0) { ctx.moveTo(g.x, g.y); continue; }
      if (k > pos) {
        const p = glyphs[k - 1], f = clamp(pos - (k - 1), 0, 1);
        ctx.lineTo(p.x + (g.x - p.x) * f, p.y + (g.y - p.y) * f);
        break;
      }
      ctx.lineTo(g.x, g.y);
    }
    ctx.stroke();
  }

  // Sound waves leaving each voice. Far from the other they wobble; together
  // they are true circles.
  function drawRings(v, now, tension) {
    ctx.lineWidth = 1.4;
    ctx.setLineDash(v.dashed ? [5, 7] : []);
    for (const r of v.rings) {
      const life = (now - r.t) / 1900;
      const rad = 16 + 150 * life;
      const a = clamp(r.amp * 4.2, 0, 0.8) * (1 - life);
      if (a <= 0.01) continue;
      ctx.strokeStyle = hexA(v.color, a);
      ctx.beginPath();
      const phase = r.t * 0.003;
      for (let j = 0; j <= 64; j++) {
        const th = (j / 64) * Math.PI * 2;
        const wob = 1 + tension * (0.07 * Math.sin(5 * th + phase + now * 0.003) + 0.04 * Math.sin(3 * th - now * 0.002));
        const x = r.x + rad * wob * Math.cos(th), y = r.y + rad * wob * Math.sin(th);
        j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawBursts(now) {
    bursts = bursts.filter((b) => now - b.t < (b.big ? 1400 : 700));
    for (const b of bursts) {
      const life = (now - b.t) / (b.big ? 1400 : 700);
      ctx.strokeStyle = hexA(b.color, (b.big ? 0.9 : 0.7) * (1 - life));
      ctx.lineWidth = b.big ? 2.5 : 1.5;
      ctx.setLineDash(b.dashed ? [3, 5] : []);
      ctx.beginPath(); ctx.arc(b.x, b.y, (b.big ? 30 : 5) + (b.big ? 220 : 40) * life, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Each voice is an eye — PetrifEye's — that opens as it sings.
  function drawEye(v) {
    if (!v.present && !v.held) return;
    const w = 50;
    const open = 3 + 11 * clamp(v.vamp / 0.17, 0, 1);
    const a = v.present ? 1 : 0.35;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(v.x - w / 2, v.y);
      ctx.quadraticCurveTo(v.x, v.y - open * 2, v.x + w / 2, v.y);
      ctx.quadraticCurveTo(v.x, v.y + open * 2, v.x - w / 2, v.y);
      ctx.closePath();
    };
    ctx.save();
    ctx.shadowBlur = 12; ctx.shadowColor = v.color;
    ctx.strokeStyle = hexA(v.color, a); ctx.lineWidth = 2;
    path(); ctx.stroke();
    path(); ctx.clip();
    ctx.beginPath(); ctx.arc(v.x, v.y, Math.min(11, w * 0.22), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = hexA(v.color, a);
    ctx.beginPath(); ctx.arc(v.x, v.y, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // One dot per harmony in the piece; the next one fills as it is held.
  function drawDots(fade) {
    const n = PIECE, gap = 18, y = H - 74;
    const x0 = W / 2 - ((n - 1) * gap) / 2;
    for (let k = 0; k < n; k++) {
      const x = x0 + k * gap;
      ctx.lineWidth = 1.2;
      if (k < glyphs.length) {
        ctx.fillStyle = `rgba(255,255,255,${0.9 * fade})`;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.strokeStyle = `rgba(255,255,255,${0.45 * fade})`;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke();
        if (k === glyphs.length && collectT > 0 && !coda) {
          ctx.strokeStyle = COLORS.harmony; ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(collectT / HARMONY_SEC, 0, 1));
          ctx.stroke();
        }
      }
    }
  }

  // A line of instruction when the piece begins, and again whenever nobody
  // has been seen for a while — then it gets out of the way.
  function drawIntro(now) {
    if (introAt == null || now - lastPresentAt > 15000 && now - introAt > 12000) introAt = now;
    const el = (now - introAt) / 1000;
    const a = el < 1.2 ? el / 1.2 : el < 8 ? 1 : clamp(1 - (el - 8) / 2, 0, 1);
    if (a <= 0) return;
    ctx.save();
    ctx.font = "300 13px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    if ("letterSpacing" in ctx) ctx.letterSpacing = "5px";
    ctx.fillStyle = `rgba(232,230,226,${0.75 * a})`;
    ctx.fillText("EACH GAZE IS A VOICE · FIND EACH OTHER", W / 2, H * 0.06 + 6);
    ctx.restore();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`;
  }

  requestAnimationFrame(frame);

  // ------------------------------------------------------------- controls
  const $ = (id) => document.getElementById(id);
  function toggleSound() {
    const m = DuetSound.toggleMute();
    $("duSound").textContent = m ? "sound off (u)" : "sound (u)";
  }
  $("duNew").onclick = newPiece;
  $("duSound").onclick = toggleSound;
  $("select-mood").onchange = (e) => {
    MOOD = e.target.value;
    DuetSound.droneRoot(mood().root);
  };
  $("select-partner").onchange = (e) => {
    PARTNER = e.target.value;
    echo.x = echo.y = null;
  };
  $("slider-meet").oninput = (e) => {
    MEET = Number(e.target.value) / 100;
    $("tv-meet").textContent = `${e.target.value}%`;
  };
  $("slider-harmony").oninput = (e) => {
    HARMONY_SEC = Number(e.target.value);
    $("tv-harmony").textContent = `${HARMONY_SEC.toFixed(1)}s`;
  };
  $("slider-volume").oninput = (e) => {
    DuetSound.setVolume(Number(e.target.value) / 100);
    $("tv-volume").textContent = `${e.target.value}%`;
  };
  $("toggle-bells").onchange = (e) => { BELLS = e.target.checked; };

  DuoSession.init({
    app: "duet",
    partLabel: "piece",
    players: PLAYERS,
    title: "duet",
    hintRows: () => [
      { keys: "look", does: "sing — height is pitch" },
      { keys: "together", does: "harmony" },
      { keys: "r", does: "new piece" }, { keys: "u", does: "sound" },
    ],
    // Inside the START click, which is what lets the browser make sound.
    onStart: () => { DuetSound.start(); DuetSound.droneRoot(mood().root); introAt = null; },
    onKey: (e) => {
      if (e.key === "r" || e.key === "R") newPiece();
      if (e.key === "u" || e.key === "U") toggleSound();
    },
  });

  window.Duet = {
    state: () => ({
      voices: V.map((v) => ({ x: Math.round(v.x), y: Math.round(v.y), present: v.present, f: +v.f.toFixed(2), q: v.q, snap: +v.snap.toFixed(2), vamp: +v.vamp.toFixed(3) })),
      bloom: +bloom.toFixed(2), collectT: +collectT.toFixed(2), figure, chordRoot, glyphs: glyphs.length, coda: !!coda,
    }),
    newPiece,
  };
})();
