// Motion assist for a pointer that is noisy, late, and slightly wrong.
//
// This sits between the raw pointer stream and the game, and does three
// things in order. They are separate because they fix three different
// problems that get conflated as "the tracking feels bad":
//
//   1. FILTER    kill tremor while the eye is still, without adding lag
//                while it moves.
//   2. PREDICT   lead the pointer along its own velocity to pay back the
//                latency still left in the pipeline.
//   3. MAGNET    once a target is locked, let the pointer settle ONTO it
//                instead of hovering near it.
//
// WHY NOT JUST SMOOTH MORE
//
// A plain low-pass (or a fixed lerp, which is the same thing) has one knob
// and two jobs that pull opposite ways. Smooth enough to kill the jitter of
// a resting eye and every saccade arrives late and sludgy; responsive enough
// to track a saccade and the resting pointer buzzes. There is no setting
// that does both, because the signal's noise and its motion live at
// different frequencies.
//
// The One Euro filter fixes exactly this by making the cutoff a function of
// speed: heavy smoothing when slow, almost none when fast. Gaze is close to
// the ideal case for it — fixations are nearly stationary, saccades are very
// fast, and there is little in between.
//
// WHY THE MAGNET IS A WELL AND NOT A SNAP
//
// Snapping the pointer to the nearest target is tempting and wrong: it lies
// about where the visitor is looking, it makes leaving a target feel like
// fighting the interface, and it hides genuine calibration error from us.
//
// Instead the pull falls off with distance and reaches ZERO at the capture
// radius, so it is a gentle basin, not a tractor beam. Look properly away
// and there is nothing to escape from — you are already outside it. It also
// switches off entirely during fast movement, so a deliberate flick to
// another blob is never resisted.
(function () {
  // ------------------------------------------------------------ 1€ filter
  class LowPass {
    constructor() { this.y = null; }
    filter(x, a) {
      this.y = this.y === null ? x : a * x + (1 - a) * this.y;
      return this.y;
    }
  }

  class OneEuro {
    constructor({ minCutoff, beta, dCutoff = 1.0 }) {
      this.minCutoff = minCutoff;   // Hz. Lower = calmer when still.
      this.beta = beta;             // speed coefficient. Higher = more responsive.
      this.dCutoff = dCutoff;
      this.xf = new LowPass();
      this.dxf = new LowPass();
      this.last = null;
    }
    static alpha(cutoff, dt) {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }
    filter(x, dt) {
      if (dt <= 0) return this.xf.y === null ? x : this.xf.y;
      const dx = this.last === null ? 0 : (x - this.last) / dt;
      this.last = x;
      const edx = this.dxf.filter(dx, OneEuro.alpha(this.dCutoff, dt));
      // The whole trick: cutoff rises with speed, so a fast-moving pointer
      // is barely filtered and a still one is filtered hard.
      const cutoff = this.minCutoff + this.beta * Math.abs(edx);
      return this.xf.filter(x, OneEuro.alpha(cutoff, dt));
    }
    // SIGNED smoothed derivative, px/sec. Callers want this, not its
    // magnitude: under pure noise the signed estimate averages to ~0, which
    // is the correct answer for "how fast is the eye actually travelling".
    // Taking abs() and re-applying an instantaneous sign instead reads the
    // noise itself as motion and hands back a large, randomly-signed
    // velocity — which then feeds the lead term and pours the jitter the
    // filter just removed straight back into the output.
    velocity() { return this.dxf.y || 0; }
    speed() { return Math.abs(this.dxf.y || 0); }
  }

  // ------------------------------------------------------------- profiles
  // Each input is wrong in a different way, so each needs different
  // treatment. Sharing one setting across all three is what makes a mouse
  // feel sludgy or a webcam feel unusable.
  // beta is the knob that decides whether this works at all, and it is far
  // smaller than it looks like it should be. The reason: noise has a
  // velocity of its own. WebGazer-grade jitter of ~60px between frames
  // *appears* to move at ~800 px/s once the derivative is smoothed, while a
  // genuine saccade is ~8000 px/s. beta has to sit low enough that 800 px/s
  // barely lifts the cutoff, and still let 8000 px/s lift it a lot.
  //
  // An earlier 0.012 here was a straight mis-tune: it let noise inflate the
  // cutoff to ~10Hz, so the filter switched itself off exactly when it was
  // needed and the NOISIEST input ended up the LEAST filtered.
  //
  // Swept at 60fps against +-60px noise and a 400px step (jitter removed /
  // time to settle within 20px):
  //     minCutoff 0.5, beta 0.0007 -> 81% / 500ms   over-smoothed, sludgy
  //     minCutoff 0.5, beta 0.0015 -> 80% / 217ms
  //     minCutoff 0.5, beta 0.003  -> 78% /  50ms   <- chosen
  //     minCutoff 2.0, beta 0.003  -> 64% /  67ms   worse on both counts
  //
  // 0.003 is the knee: it gives up 3 points of smoothing to go ten times
  // faster. Below it the filter buys almost nothing more and just adds lag.
  const PROFILES = {
    // Pixel-accurate and instant. Filtering can only make it worse, so this
    // is close to pass-through. The magnet stays on, because the point of
    // testing with a cursor is to feel the assist the glasses will get.
    // leadFloor: the speed below which prediction is switched OFF entirely.
    // Prediction multiplies whatever velocity error it is given, so applying
    // it to a resting pointer feeds the noise velocity straight back into
    // the output — at 90ms lead and an 800px/s noise velocity that is ~72px
    // of reintroduced jitter, which undid most of the filtering. A still eye
    // needs no prediction anyway: there is nothing to catch up with.
    mouse: { minCutoff: 25.0, beta: 0.01, leadMs: 0, magnet: 0.35, saccade: 900, leadFloor: 400 },

    // ~1.3-1.8deg of error, but a clean 200Hz signal without much
    // high-frequency tremor. Mostly wants lead and magnet.
    neon: { minCutoff: 0.8, beta: 0.004, leadMs: 55, magnet: 0.55, saccade: 1100, leadFloor: 500 },

    // ~175px / 4.17deg by WebGazer's own evaluation, and visibly jittery
    // frame to frame. Needs the heaviest hand everywhere.
    webgazer: { minCutoff: 0.5, beta: 0.003, leadMs: 90, magnet: 0.7, saccade: 1400, leadFloor: 1200 },
  };

  // Pointer ids come from whichever source produced them; this keeps every
  // caller from having to pass a profile it does not really know.
  function profileFor(id) {
    if (id === "mouse" || id === "sim2") return PROFILES.mouse;
    if (id === "webgazer" || id === "gaze") return PROFILES.webgazer;
    return PROFILES.neon;   // "player-N" and anything else from a bridge
  }

  const state = new Map(); // pointerId -> { fx, fy, profile, lastX, lastY, speed }

  function stateFor(p) {
    let s = state.get(p.id);
    if (!s) {
      const profile = overrideProfile || profileFor(p.id);
      s = {
        profile,
        fx: new OneEuro(profile),
        fy: new OneEuro(profile),
        lastX: p.x, lastY: p.y, speed: 0,
      };
      state.set(p.id, s);
    }
    return s;
  }

  let overrideProfile = null;
  let enabled = true;

  window.GazeAssist = {
    PROFILES,

    // Force one profile for every pointer, e.g. to preview how the glasses
    // will feel while testing with a cursor.
    useProfile(name) {
      overrideProfile = name ? PROFILES[name] || null : null;
      state.clear();
    },

    setEnabled(on) { enabled = !!on; if (!on) state.clear(); },
    isEnabled() { return enabled; },

    // Steps 1 and 2. Returns NEW pointer objects — never mutates the caller's,
    // since Tracking hands out its own internal array.
    process(pointers, dt) {
      if (!enabled) return pointers;
      // Forget pointers that went away, so a returning id starts clean
      // rather than lerping in from wherever it vanished.
      const present = new Set(pointers.map((p) => p.id));
      for (const id of [...state.keys()]) if (!present.has(id)) state.delete(id);

      return pointers.map((p) => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return p;
        const s = stateFor(p);
        const x = s.fx.filter(p.x, dt);
        const y = s.fy.filter(p.y, dt);

        // px/sec, signed, straight from the filter's own smoothed derivative.
        const vx = s.fx.velocity();
        const vy = s.fy.velocity();
        s.speed = Math.hypot(vx, vy);
        s.lastX = x; s.lastY = y;

        // Lead the pointer by its own velocity to offset remaining latency,
        // but ONLY once it is clearly moving faster than its own noise floor
        // — below that, ramp to zero. Capped as well, because on a fast
        // saccade an uncapped lead throws the pointer hundreds of px past
        // the target and it visibly snaps back.
        const floor = s.profile.leadFloor || 0;
        const t = floor > 0 ? Math.min(1, Math.max(0, (s.speed - floor) / floor)) : 1;
        const gain = t * t * (3 - 2 * t);     // smoothstep, no hard switch-on
        const lead = (s.profile.leadMs / 1000) * gain;
        const MAX_LEAD_PX = 90;
        let lx = vx * lead, ly = vy * lead;
        const mag = Math.hypot(lx, ly);
        if (mag > MAX_LEAD_PX) { lx *= MAX_LEAD_PX / mag; ly *= MAX_LEAD_PX / mag; }

        // rawX/rawY carry the unassisted position through. The assist is tuned
        // for FEEL — it leads past a saccade's landing point and creeps into
        // place — which is right for hitting a target and wrong for MEASURING
        // looking: fed to a fixation detector it split a 650ms fixation into
        // 120ms + 400ms. Anything that analyses gaze should read these instead.
        return { ...p, x: x + lx, y: y + ly, speed: s.speed, rawX: p.x, rawY: p.y };
      });
    },

    // Step 3. Call AFTER the arbiter has chosen a winner per pointer.
    //   focus:   Map<pointerId, targetId> from AttentionArbiter.resolve
    //   targets: [{ id, x, y, radius }]
    //   reach:   (target) => capture radius, i.e. arbiter.reach.bind(arbiter)
    magnetize(pointers, focus, targets, reach) {
      if (!enabled) return pointers;
      const byId = new Map(targets.map((t) => [t.id, t]));

      return pointers.map((p) => {
        const t = byId.get(focus.get(p.id));
        if (!t) return p;
        const s = state.get(p.id);
        if (!s) return p;

        // A deliberate flick must never be resisted.
        if (s.speed > s.profile.saccade) return p;

        const dx = t.x - p.x, dy = t.y - p.y;
        const d = Math.hypot(dx, dy);
        const R = reach(t);
        if (d < 0.5 || d >= R) return p;   // already there, or outside the well

        // Quadratic falloff: full strength at the centre, exactly zero at the
        // rim. That is what makes it a basin you can simply walk out of
        // rather than something you have to fight.
        const k = s.profile.magnet * Math.pow(1 - d / R, 2);
        return { ...p, x: p.x + dx * k, y: p.y + dy * k };
      });
    },

    reset() { state.clear(); },
  };
})();
