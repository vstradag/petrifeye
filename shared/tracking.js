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
    update() {
      if (state.mode === "external" && state.externalPointers) {
        state.pointers = state.externalPointers;
        return state.pointers;
      }

      const pts = [{ id: "mouse", x: w.mouseX, y: w.mouseY }];

      if (state.simSecondEnabled) {
        const speed = 4;
        if (w.keyIsDown(w.LEFT_ARROW)) state.simSecondPos.x -= speed;
        if (w.keyIsDown(w.RIGHT_ARROW)) state.simSecondPos.x += speed;
        if (w.keyIsDown(w.UP_ARROW)) state.simSecondPos.y -= speed;
        if (w.keyIsDown(w.DOWN_ARROW)) state.simSecondPos.y += speed;
        state.simSecondPos.x = clamp(state.simSecondPos.x, 0, w.width);
        state.simSecondPos.y = clamp(state.simSecondPos.y, 0, w.height);
        pts.push({ id: "sim2", x: state.simSecondPos.x, y: state.simSecondPos.y });
      }

      state.pointers = pts;
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
