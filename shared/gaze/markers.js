// AprilTag corner markers for Neon surface tracking.
//
// Neon's scene camera has to be able to FIND the monitor inside its own
// field of view before any gaze can be expressed in screen coordinates.
// Four tags in known screen positions give the bridge the homography it
// needs (see bridge/neon_bridge.py marker_verts(), which must agree with
// SIZE/MARGIN below — they describe the same four rectangles).
//
// The tags must stay visible the whole time gaze is being mapped, not just
// during a setup phase: the surface is re-solved every scene frame, which is
// what keeps mapping correct as the visitor moves their head. Hiding them
// after setup breaks tracking.
//
// If the tags are too intrusive for the piece, the alternative is to PRINT
// them and mount them around the monitor bezel — the bridge doesn't care
// where they physically are, only that its marker_verts() matches reality.
// Call Markers.hide() and update the bridge geometry in that case.
(function () {
  // Fallbacks only. The real geometry comes from the bridge's
  // /markers/layout.json, so there is a single source of truth — these two
  // files silently skewing every mapped coordinate if they drifted apart was
  // too easy a mistake to leave in place.
  let IDS = [0, 1, 2, 3];
  let SIZE = 200;
  let MARGIN = 16;
  // "always" | "flash" | "off" — see MARKER_MODE in neon_bridge.py.
  let MODE = "always";
  let FLASH_ON_MS = 260;
  let FLASH_PERIOD_MS = 1800;

  let layer = null;
  let wanted = false;      // has show() been called for the current step?
  let flashTimer = null;

  // Fire-and-forget: if the bridge answers before show() is called (it
  // normally does, this is same-origin and local) the real numbers are used.
  const layoutReady = fetch("/markers/layout.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (!cfg) return;
      IDS = cfg.ids || IDS;
      SIZE = cfg.size || SIZE;
      MARGIN = cfg.margin != null ? cfg.margin : MARGIN;
      MODE = cfg.mode || MODE;
      FLASH_ON_MS = cfg.flashOnMs || FLASH_ON_MS;
      FLASH_PERIOD_MS = cfg.flashPeriodMs || FLASH_PERIOD_MS;
      // Geometry changed after the layer was built — rebuild it.
      if (layer) { layer.remove(); layer = null; build(); }
      if (wanted) applyMode();
    })
    .catch(() => {}); // no bridge (webcam mode): markers are never shown anyway

  function build() {
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "gaze-markers";
    // Top-left, top-right, bottom-right, bottom-left — same order the
    // bridge lists them, so ids line up with corners.
    const corners = [
      { top: `${MARGIN}px`, left: `${MARGIN}px` },
      { top: `${MARGIN}px`, right: `${MARGIN}px` },
      { bottom: `${MARGIN}px`, right: `${MARGIN}px` },
      { bottom: `${MARGIN}px`, left: `${MARGIN}px` },
    ];
    IDS.forEach((id, i) => {
      const img = document.createElement("img");
      img.className = "gaze-marker";
      // Served by the bridge from real-time-screen-gaze's own generator, so
      // the bitmaps are guaranteed to match the family/ids the detector
      // expects rather than something hand-rolled here.
      img.src = `/markers/${id}.png`;
      img.alt = "";
      img.width = SIZE;
      img.height = SIZE;
      Object.assign(img.style, corners[i]);
      layer.appendChild(img);
    });
    document.body.appendChild(layer);
    return layer;
  }

  function setVisible(on) {
    const el = on ? build() : layer;
    if (el) el.classList.toggle("gaze-markers-hidden", !on);
  }

  function stopFlashing() {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
  }

  // Pulses the tags on and off. The bridge caches the last surface solve for
  // SURFACE_HOLD_MS, so gaze keeps mapping through the dark phase — the tags
  // only need to reappear often enough to re-solve before that cache expires.
  function runFlashCycle() {
    if (!wanted || MODE !== "flash") return;
    setVisible(true);
    flashTimer = setTimeout(() => {
      if (!wanted || MODE !== "flash") return;
      setVisible(false);
      flashTimer = setTimeout(runFlashCycle, Math.max(0, FLASH_PERIOD_MS - FLASH_ON_MS));
    }, FLASH_ON_MS);
  }

  function applyMode() {
    stopFlashing();
    if (!wanted || MODE === "off") { setVisible(false); return; }
    if (MODE === "flash") { runFlashCycle(); return; }
    setVisible(true);
  }

  window.Markers = {
    show() {
      wanted = true;
      applyMode();
      // If the layout lands after this call the mode may change, so re-apply.
      layoutReady.then(() => { if (wanted) applyMode(); });
    },
    hide() { wanted = false; stopFlashing(); setVisible(false); },
    get size() { return SIZE; },
    get margin() { return MARGIN; },
    get mode() { return MODE; },
  };
})();
