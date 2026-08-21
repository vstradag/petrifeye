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
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
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
        state.pointers = assist(state.externalPointers);
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
    },

    releaseExternal() {
      state.mode = "mouse";
      state.externalPointers = null;
    },
  };
})();
