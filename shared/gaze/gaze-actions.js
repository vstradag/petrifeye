// Turns a continuous gaze POSITION into discrete game ACTIONS.
//
// Medusa wants "where exactly are you looking" — it dwells on a target and
// petrifies it. A platformer wants something completely different: "are you
// looking up, down, or neither", plus discrete blink events. Those are the
// same input stream read two different ways, so the conversion lives here
// rather than inside any one game.
//
//   GazeActions.start()                  begin reading Tracking
//   GazeActions.zone()                   -1 up | 0 neutral | +1 down
//   GazeActions.on("blink", fn)          discrete blink events
//   GazeActions.on("zone", fn)           fires on zone CHANGE, with the zone
//   GazeActions.blinkAvailable()         false => the shoot key is the only way
//
// WHY BANDS AND NOT A THRESHOLD
//
// Neon lands roughly 66-90px from truth on a laptop screen. A single
// horizontal threshold at the screen middle would flip constantly whenever
// you looked near it. Instead the screen is split into three generous bands
// with a neutral gap far wider than the error, plus hysteresis: once a band
// is entered you must travel back past its edge PLUS a margin to leave it.
// Without that a player holding a gaze near a boundary gets a machine-gun of
// jump/land transitions.
(function () {
  // Fractions of viewport height. The neutral band is deliberately the
  // largest: resting gaze belongs to "do nothing", and a player reading the
  // screen shouldn't be jumping.
  const UP_EDGE = 0.34;      // above this fraction => up
  const DOWN_EDGE = 0.66;    // below this fraction => down
  const HYSTERESIS = 0.05;   // extra travel needed to leave a band

  const UP = -1, NEUTRAL = 0, DOWN = 1;

  let running = false;
  let zone = NEUTRAL;
  const listeners = { blink: [], zone: [] };

  // Blink support depends on the tracker: Neon streams real blink events,
  // WebGazer has no notion of them at all. Games must be able to ask, so they
  // can tell the player which control actually works.
  let blinkSupported = false;
  let lastBlinkAt = 0;
  const BLINK_COOLDOWN_MS = 220; // one blink shouldn't fire twice

  function emit(name, payload) {
    for (const fn of listeners[name] || []) {
      try { fn(payload); } catch (err) { console.error(err); }
    }
  }

  function onNeonStatus(ev) {
    const d = ev.detail || {};
    if (typeof d.blinkAvailable === "boolean") blinkSupported = d.blinkAvailable;
  }

  function onNeonBlink() {
    const now = performance.now();
    if (now - lastBlinkAt < BLINK_COOLDOWN_MS) return;
    lastBlinkAt = now;
    emit("blink", { source: "neon" });
  }

  // Keyboard fallback. Always active, not just when blink is unsupported:
  // blinking on demand is genuinely tiring, and during development you want
  // to fire without a headset on.
  function onKey(e) {
    if (e.code !== "Space") return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastBlinkAt < BLINK_COOLDOWN_MS) return;
    lastBlinkAt = now;
    emit("blink", { source: "key" });
  }

  function classify(y, h) {
    const f = y / h;
    // Hysteresis widens the band you are currently in.
    const upEdge = zone === UP ? UP_EDGE + HYSTERESIS : UP_EDGE;
    const downEdge = zone === DOWN ? DOWN_EDGE - HYSTERESIS : DOWN_EDGE;
    if (f < upEdge) return UP;
    if (f > downEdge) return DOWN;
    return NEUTRAL;
  }

  function update() {
    if (!running) return;
    const p = (window.Tracking && Tracking.getPointers()[0]) || null;
    if (!p) return;
    const next = classify(p.y, window.innerHeight);
    if (next !== zone) {
      zone = next;
      emit("zone", zone);
    }
  }

  window.GazeActions = {
    start() {
      if (running) return;
      running = true;
      window.addEventListener("neon-status", onNeonStatus);
      window.addEventListener("neon-blink", onNeonBlink);
      window.addEventListener("keydown", onKey);
    },
    stop() {
      running = false;
      window.removeEventListener("neon-status", onNeonStatus);
      window.removeEventListener("neon-blink", onNeonBlink);
      window.removeEventListener("keydown", onKey);
    },
    // Games call this once per frame, after Tracking.update().
    update,
    zone() { return zone; },
    blinkAvailable() { return blinkSupported; },
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    // Exposed so a game can draw the bands as an on-screen guide.
    bands: { upEdge: UP_EDGE, downEdge: DOWN_EDGE },
    UP, NEUTRAL, DOWN,
  };
})();
