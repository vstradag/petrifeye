// Continuous self-calibration from what the visitor is already doing.
//
// Neon is calibration-free in the sense that it needs no click grid, but it
// still lands with a bias: a constant offset in one direction, from where the
// glasses sit on a particular face, from the wearer's eye geometry, and from
// the fact that the Companion app's own offset correction was set for somebody
// else. That bias is the single biggest reason a demonstration feels broken —
// the visitor looks straight at an eye and it never turns to stone.
//
// The piece already provides what an implicit calibration needs: the visitor
// WANTS to look at the eyes, and an eye is a small, isolated, high-salience
// target. So when gaze settles near exactly one eye, the difference between
// where we think they are looking and where that eye actually is, is an
// estimate of the bias — and averaging those estimates tracks it as it drifts.
//
// WHY THIS CAN GO BADLY WRONG, AND WHAT STOPS IT
//
// The correction is applied and THEN used to pick the target it learns from.
// That is a closed loop, and a closed loop that is confidently wrong will
// happily walk the offset somewhere absurd: attribute gaze to the wrong eye,
// learn an offset towards it, which makes that eye even more likely to be
// picked next frame. It ends with the pointer nailed to one eye and the whole
// screen unusable — worse than no calibration at all, and hard to diagnose
// because it looks like "tracking broke".
//
// Four gates keep it honest, and they matter far more than the arithmetic:
//
//   1. UNAMBIGUOUS. The nearest eye must be clearly nearer than the next one
//      (AMBIGUITY margin). In a cluster, nobody can say which is being looked
//      at, so nothing is learned.
//   2. ALREADY CLOSE. Gaze must land within TRUST_RADIUS of the eye. A big
//      residual is far more likely to be "looking somewhere else entirely"
//      than a real bias, and learning from it is how the loop runs away.
//   3. STILL. Only while fixating, never mid-saccade — a pointer flying past
//      an eye is not looking at it.
//   4. BOUNDED AND SLOW. The total correction is capped, and adapts over
//      seconds rather than frames, so a bad patch of data cannot move it far
//      before the good data around it pulls it back.
//
// It learns from the RAW measured position, never the assisted one. The magnet
// deliberately pulls the pointer onto the target, so measuring the residual
// after it would find ~0 every time and conclude the calibration is already
// perfect — the same mistake as fitting a model on its own training points.
(function () {
  const TRUST_RADIUS = 1.25;   // x the arbiter's capture radius
  const AMBIGUITY = 1.5;       // nearest eye must be this much nearer than the next
  const MAX_OFFSET = 220;      // px, total correction in any direction
  const RATE = 0.9;            // share of the residual absorbed per second
  const MAX_SPEED = 600;       // px/s above which we treat it as a saccade
  const WARMUP_SAMPLES = 20;   // observations before the offset is applied at all

  const offsets = new Map();   // pointerId -> { x, y, n }
  let enabled = true;

  const isGaze = (id) => id !== "mouse" && id !== "sim2";

  function entryFor(id) {
    let o = offsets.get(id);
    if (!o) { o = { x: 0, y: 0, n: 0 }; offsets.set(id, o); }
    return o;
  }

  window.GazeAutoCalibrate = {
    setEnabled(on) { enabled = !!on; },
    isEnabled() { return enabled; },

    // Shift gaze pointers by what has been learned so far. Call BEFORE the
    // arbiter, so the correction actually helps targeting rather than only
    // describing the error.
    //
    // rawX/rawY are left alone on purpose: they are the honest record of what
    // the tracker reported, and the fixation analysis on the second screen
    // reads them. Only x/y — what the game plays with — are corrected.
    apply(pointers) {
      if (!enabled) return pointers;
      return pointers.map((p) => {
        if (!isGaze(p.id)) return p;
        const o = offsets.get(p.id);
        if (!o || o.n < WARMUP_SAMPLES) return p;
        return { ...p, x: p.x + o.x, y: p.y + o.y, calibX: o.x, calibY: o.y };
      });
    },

    // Learn from this frame. `pointers` must be the CORRECTED ones the arbiter
    // just judged, so the residual measured here is what is still wrong after
    // the current correction.
    observe(pointers, focus, targets, reach, dt) {
      if (!enabled || !dt || dt > 0.25) return;   // skip absurd frames (tab wake)
      const byId = new Map(targets.map((t) => [t.id, t]));

      for (const p of pointers) {
        if (!isGaze(p.id) || p.held) continue;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if ((p.speed || 0) > MAX_SPEED) continue;              // gate 3: still

        const t = byId.get(focus.get(p.id));
        if (!t) continue;

        const d = Math.hypot(t.x - p.x, t.y - p.y);
        const R = reach(t) * TRUST_RADIUS;
        if (d > R) continue;                                   // gate 2: close

        // gate 1: and clearly the only candidate
        let second = Infinity;
        for (const o of targets) {
          if (o.id === t.id) continue;
          second = Math.min(second, Math.hypot(o.x - p.x, o.y - p.y));
        }
        if (second < d * AMBIGUITY) continue;

        // gate 4: absorb a fraction of what is still wrong, then clamp
        const o = entryFor(p.id);
        const k = Math.min(1, RATE * dt);
        o.x += (t.x - p.x) * k;
        o.y += (t.y - p.y) * k;
        const mag = Math.hypot(o.x, o.y);
        if (mag > MAX_OFFSET) { o.x *= MAX_OFFSET / mag; o.y *= MAX_OFFSET / mag; }
        o.n += 1;
      }
    },

    // What it has learned, for the HUD and for tests.
    offsetFor(id) {
      const o = offsets.get(id);
      return o ? { x: o.x, y: o.y, n: o.n, active: o.n >= WARMUP_SAMPLES } : null;
    },
    all() { return [...offsets.entries()].map(([id, o]) => ({ id, ...o })); },
    reset() { offsets.clear(); },
  };
})();
