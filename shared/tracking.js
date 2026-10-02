// Pointer abstraction layer shared by every prototype.
//
// Sketches never read mouseX/mouseY directly — they call Tracking.update()
// once per frame and then Tracking.getPointers(), which returns an array of
// { id, x, y } in canvas pixel coordinates (origin top-left). That's the
// only contract a future tracking system needs to satisfy.
//
// To wire up a real tracking system later, call (every frame, or whenever
// new data arrives):
//
//   Tracking.setExternalPointers([{ id: "gaze-left", x, y }, { id: "gaze-right", x, y }]);
//
// One point or many are both fine — every sketch already loops over
// Tracking.getPointers(). Call Tracking.releaseExternal() to fall back to
// mouse control.
(function () {
  const w = window;

  const state = {
    mode: "mouse", // "mouse" | "external"
    pointers: [],
    externalPointers: null,
    simSecondEnabled: false,
    simSecondPos: { x: 0, y: 0 },
    lastUpdateAt: 0,
    seen: new Map(),   // external pointer id -> { x, y, at }
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ----------------------------------------------------------------- hold
  // A gaze pointer does not fade out; it stops. The phone's Wi-Fi stalls, the
  // scene camera loses the tags for a moment, or gaze lands past the edge of
  // the mapped surface — and the samples simply cease. Dropping the pointer at
  // that instant is wrong twice over: the marker vanishes while the visitor is
  // still looking at the screen, and the dwell they had built up is thrown
  // away by a network hiccup that had nothing to do with them.
  //
  // So a pointer that stops being refreshed is HELD at its last known place,
  // flagged `held`, and withdrawn only if the gap outlasts the window. Held
  // pointers are drawn, but they neither gain nor lose dwell (see
  // shared/dwell.js) — freezing rather than continuing is what stops a stalled
  // marker sitting on an eye and petrifying it with nobody there.
  const FRESH_MS = 300;        // beyond this with no new sample, we are stalled
  const HOLD_MS = 1200;        // keep showing it this long
  // Longer near an edge, which is exactly where mapping is lost while the
  // visitor is still looking at the screen: gaze a little past the last tag
  // falls off the mapped surface, and the eye has nowhere further to go.
  const EDGE_HOLD_MS = 4000;
  const EDGE_PX = 160;

  function holdWindowFor(x, y) {
    const W = w.innerWidth || w.width || 0;
    const H = w.innerHeight || w.height || 0;
    const nearEdge = x <= EDGE_PX || y <= EDGE_PX ||
                     (W && x >= W - EDGE_PX) || (H && y >= H - EDGE_PX);
    return nearEdge ? EDGE_HOLD_MS : HOLD_MS;
  }

  // Fresh pointers pass through; ones that stopped arriving are held, then
  // expire. Timestamped per id rather than per call, because the two sources
  // behave differently: the multiplayer aggregator omits a player it has lost,
  // while single-player's gaze-controller simply stops calling — leaving its
  // last array in place, which used to mean one stalled pointer stayed "live"
  // forever and kept accumulating dwell.
  // NB: nothing is timestamped here. Freshness is recorded in
  // setExternalPointers, i.e. when data actually ARRIVES — stamping on every
  // update() instead looks correct and silently defeats the whole mechanism,
  // because the last array stays in place between calls and would be re-dated
  // as fresh on every single frame. A stall would then never be detected.
  function withHeld(list, now) {
    const out = [];
    for (const [id, s] of [...state.seen]) {
      const age = now - s.at;
      if (age <= FRESH_MS) {
        const live = (list || []).find((p) => p.id === id);
        out.push(live ? { ...live, held: false } : { id, x: s.x, y: s.y, held: false });
      } else if (age <= holdWindowFor(s.x, s.y)) {
        out.push({ id, x: s.x, y: s.y, held: true });
      } else {
        state.seen.delete(id);
      }
    }
    return out;
  }

  window.Tracking = {
    // Dev-only helper: toggle a second simulated pointer (arrow keys) so
    // multi-pointer dwell logic can be tested with a single mouse.
    toggleSimSecondPointer() {
      state.simSecondEnabled = !state.simSecondEnabled;
      if (state.simSecondEnabled) {
        state.simSecondPos.x = w.width * 0.25;
        state.simSecondPos.y = w.height * 0.5;
      }
      return state.simSecondEnabled;
    },

    isSimSecondEnabled() {
      return state.simSecondEnabled;
    },

    // Call once per frame from draw().
    //
    // Filtering happens HERE rather than in each game, because Tracking is
    // the single place every consumer gets pointers from. OCULUS RUN reads
    // them through GazeActions to decide an up/neutral/down zone, and raw
    // jitter across a zone boundary makes the character flap between jumping
    // and ducking — the same noise problem as Medusa, in a game that never
    // touches a pointer position directly.
    //
    // Some games call update() more than once per frame (platformer.js does,
    // from two different hooks). Re-running an adaptive filter on the same
    // instant would advance its clock with dt~0 and corrupt the velocity
    // estimate, so a repeat call within the same frame returns the previous
    // result untouched.
    update() {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const dt = state.lastUpdateAt ? (now - state.lastUpdateAt) / 1000 : 1 / 60;
      if (dt < 0.002 && state.pointers.length) return state.pointers;
      state.lastUpdateAt = now;

      const assist = (pts) =>
        window.GazeAssist ? window.GazeAssist.process(pts, dt) : pts;

      if (state.mode === "external" && state.externalPointers) {
        state.pointers = assist(withHeld(state.externalPointers, now));
        return state.pointers;
      }

      const pts = [{ id: "mouse", x: w.mouseX, y: w.mouseY }];

      if (state.simSecondEnabled) {
        const speed = 4;
        // Self-heal the start position. toggleSimSecondPointer() seeds it
        // from width/height, which are undefined if the toggle happens
        // before p5 has made the canvas (a page that enables the sim pointer
        // from its own inline script does exactly that) — leaving the
        // pointer at NaN, invisible and unable to hit anything.
        if (!Number.isFinite(state.simSecondPos.x) || !Number.isFinite(state.simSecondPos.y)) {
          state.simSecondPos.x = (w.width || 0) * 0.25;
          state.simSecondPos.y = (w.height || 0) * 0.5;
        }
        if (w.keyIsDown(w.LEFT_ARROW)) state.simSecondPos.x -= speed;
        if (w.keyIsDown(w.RIGHT_ARROW)) state.simSecondPos.x += speed;
        if (w.keyIsDown(w.UP_ARROW)) state.simSecondPos.y -= speed;
        if (w.keyIsDown(w.DOWN_ARROW)) state.simSecondPos.y += speed;
        state.simSecondPos.x = clamp(state.simSecondPos.x, 0, w.width);
        state.simSecondPos.y = clamp(state.simSecondPos.y, 0, w.height);
        pts.push({ id: "sim2", x: state.simSecondPos.x, y: state.simSecondPos.y });
      }

      state.pointers = assist(pts);
      return state.pointers;
    },

    getPointers() {
      return state.pointers;
    },

    setExternalPointers(pointers) {
      state.mode = "external";
      state.externalPointers = pointers;
      // The moment of arrival is the only honest measure of freshness: a
      // source that has gone quiet leaves its last array in place, so anything
      // derived from update() would call that stale data new.
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      for (const p of pointers || []) {
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
          state.seen.set(p.id, { x: p.x, y: p.y, at: now });
        }
      }
    },

    // Held positions belong to the source that was just released; keeping them
    // would park a ghost gaze marker on screen after switching to the mouse.
    releaseHeld() { state.seen.clear(); },

    releaseExternal() {
      state.seen.clear();
      state.mode = "mouse";
      state.externalPointers = null;
    },
  };
})();
