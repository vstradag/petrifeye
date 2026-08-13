// Pupil diameter -> two normalised signals for ANEMONE.
//
//   dilation  0..1   how open the pupil is, relative to THIS person
//   vitality  0..1   how much it has been CHANGING lately
//
// WHY A PER-PERSON BASELINE
//
// Absolute pupil diameter is close to meaningless as a control signal.
// Resting size varies from roughly 2mm to 8mm between people, drifts with
// age, and is dominated by ambient light — a bright room can hold someone at
// 3mm while a dim one puts another at 6mm. Mapping millimetres straight to
// petal opening would mean the flower is permanently shut for some visitors
// and permanently open for others.
//
// So the range self-calibrates: a rolling window tracks the low and high
// percentiles this visitor actually produces, and dilation is the position
// between them. Percentiles rather than min/max because a single blink or
// dropped sample would otherwise pin an endpoint forever.
//
// WHY VITALITY IS ABOUT VARIATION
//
// The brief is that the flower wilts the longer the pupil stays the same.
// A still pupil means a still mind — no light change, no arousal, no
// surprise. So vitality tracks the recent spread of the signal, not its
// level: hold anything perfectly steady and it fades, whether wide or narrow.
(function () {
  const WINDOW_MS = 12000;   // history kept for percentile range
  const VAR_WINDOW_MS = 4000; // shorter window for "has it been changing"
  const MIN_SAMPLES = 12;

  // Below this spread (in mm) the signal counts as static. Real pupils are
  // never perfectly still — there is a constant tremor of ~0.05mm (hippus) —
  // so the threshold has to sit above that or nothing ever wilts.
  const STATIC_MM = 0.12;
  const LIVELY_MM = 0.55;    // spread at which vitality is fully restored

  // Adaptive range envelope, kept SEPARATELY from the short variation window.
  // Deriving the range from the same 12s history collapsed it whenever the
  // visitor held still: after a minute of a steady wide pupil, lo == hi, and
  // dilation fell to 0 — the flower closed AND wilted. The brief is that a
  // held-wide pupil stays open and wilts, so the envelope has to remember a
  // range the recent samples no longer contain. It snaps outward instantly
  // and relaxes inward slowly.
  const RELAX_PER_SEC = 0.06;  // mm/s the envelope creeps back in
  const MIN_SPAN = 0.9;        // mm, floor so noise can't fill the range
  let rangeLo = null, rangeHi = null;

  const history = [];        // {t, mm}
  let dilation = 0.5;
  let vitality = 1.0;
  let lastSampleAt = 0;
  let haveData = false;
  // Tracked separately from lastSampleAt so a caller can ask "is REAL hardware
  // feeding me?" without its own simulated samples answering yes. A game that
  // gates its mouse fallback on available() otherwise silences itself the
  // moment it feeds one value, then resumes only when that sample goes stale
  // — a 0.5Hz control that looks like a frozen flower.
  let lastNeonAt = 0;

  function prune(now) {
    while (history.length && now - history[0].t > WINDOW_MS) history.shift();
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
  }

  function push(mm) {
    const now = performance.now();
    const dt = lastSampleAt ? Math.min(1, (now - lastSampleAt) / 1000) : 0;
    haveData = true;
    lastSampleAt = now;
    history.push({ t: now, mm });
    prune(now);

    // Envelope: expand instantly to admit a new extreme, relax inward slowly.
    if (rangeLo === null) { rangeLo = mm - MIN_SPAN / 2; rangeHi = mm + MIN_SPAN / 2; }
    if (mm < rangeLo) rangeLo = mm;
    else rangeLo += RELAX_PER_SEC * dt;
    if (mm > rangeHi) rangeHi = mm;
    else rangeHi -= RELAX_PER_SEC * dt;
    // Never let the two cross or close up entirely.
    if (rangeHi - rangeLo < MIN_SPAN) {
      const mid = (rangeHi + rangeLo) / 2;
      rangeLo = mid - MIN_SPAN / 2;
      rangeHi = mid + MIN_SPAN / 2;
    }

    if (history.length < MIN_SAMPLES) return;

    const span = rangeHi - rangeLo;
    const target = Math.min(1, Math.max(0, (mm - rangeLo) / span));
    // Ease toward the target: pupils have their own fast tremor and the
    // petals shouldn't buzz with it.
    dilation += (target - dilation) * 0.12;

    const recent = history.filter((s) => now - s.t <= VAR_WINDOW_MS).map((s) => s.mm);
    if (recent.length >= MIN_SAMPLES) {
      const rSorted = [...recent].sort((a, b) => a - b);
      const spread = percentile(rSorted, 0.9) - percentile(rSorted, 0.1);
      const t = (spread - STATIC_MM) / (LIVELY_MM - STATIC_MM);
      const targetVit = Math.min(1, Math.max(0, t));
      // Asymmetric: wilting is slow and mournful, recovery is quick and
      // rewarding. Equal rates made it feel like a noisy meter rather than
      // something alive responding to you.
      const rate = targetVit > vitality ? 0.05 : 0.012;
      vitality += (targetVit - vitality) * rate;
    }
  }

  window.Pupil = {
    start() {
      window.addEventListener("neon-pupil", (e) => {
        const mm = e.detail && e.detail.mm;
        if (typeof mm === "number" && mm > 0 && e.detail.worn !== false) {
          lastNeonAt = performance.now();
          push(mm);
        }
      });
    },
    // Manual injection, for the keyboard/mouse stand-in and for tests.
    feed: push,
    dilation: () => dilation,
    vitality: () => vitality,
    // Any data at all, simulated included — use for "is the display meaningful".
    available: () => haveData && performance.now() - lastSampleAt < 2000,
    // REAL glasses only. Use this to decide whether to run a fallback.
    neonLive: () => lastNeonAt > 0 && performance.now() - lastNeonAt < 2000,
    lastMm: () => (history.length ? history[history.length - 1].mm : null),
    reset() {
      history.length = 0; dilation = 0.5; vitality = 1; haveData = false;
      lastSampleAt = 0; lastNeonAt = 0; rangeLo = null; rangeHi = null;
    },
  };
})();
