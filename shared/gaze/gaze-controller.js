// Generic gaze-tracking UI/controller.
//
// Knows nothing about WebGazer or any specific tracking library — it only
// talks to `window.GazeSource` (see webgazer-source.js for the interface
// contract and the current implementation). Swapping tracking libraries
// later means writing a new source file with the same interface; this file
// does not change.
//
// Owns the walk-up-and-use boot cinematic a public installation needs:
//   1. opaque black boot screen ("INITIATE" — browsers require a user
//      gesture before asking for webcam access, and the same gesture is
//      reused to enter fullscreen)
//   2. camera permission → full-screen face scan (the tracker's own video
//      preview + face-mesh points blown up to cover the viewport)
//   3. cinematic zoom into the eye region
//   4. preview docks to a corner and the red-dot click calibration runs
//   5. "gaze link established" flash → preview hidden → game revealed
// Plus smoothing of the raw gaze signal and a fallback to mouse control if
// the camera is refused or unavailable. Once running, it feeds samples into
// Tracking.setExternalPointers([{ id: "gaze", x, y }]) every time a new one
// arrives — every prototype already reads pointers from Tracking, so no
// sketch code needs to know this exists.
(function () {
  // 0 = no smoothing (raw+jittery), 1 = frozen. WebGazer's raw output is
  // noisy enough on its own (webcam-based estimation, not a real eye
  // tracker) that a light value here still reads as shaky — each frame's
  // raw sample dominates too much of the result. Heavier smoothing trades
  // responsiveness for stability; 0.8 means a single bad frame only moves
  // the displayed point 20% of the way toward it, which is the right
  // trade for this game (DWELL_SECONDS is already 2s, so a few hundred ms
  // of added lag doesn't hurt play) even though it wouldn't be for
  // anything needing fast reaction.
  // Per-source exponential smoothing. WebGazer's raw output is noisy enough
  // to need heavy filtering; Neon's is a clean 200Hz signal already mapped
  // through a homography, so the same filter only adds lag — and lag reads
  // as inaccuracy, because the marker is always behind where you're looking.
  const SMOOTHING_BY_SOURCE = { webgazer: 0.8, neon: 0.35 };
  const SMOOTHING_DEFAULT = 0.8;
  function smoothing() {
    const key = GazeSource && GazeSource.name;
    return key in SMOOTHING_BY_SOURCE ? SMOOTHING_BY_SOURCE[key] : SMOOTHING_DEFAULT;
  }
  const CALIBRATION_GRID = { cols: 3, rows: 3 };
  const CLICKS_PER_POINT = 4;

  // ---- accuracy correction pass -----------------------------------------
  // WebGazer maps a 10x6 grayscale thumbnail of each eye straight to screen
  // coordinates through linear ridge regression. A large part of what comes
  // out is not random scatter but SYSTEMATIC bias — a constant offset and a
  // wrong gain, and much worse vertically than horizontally (its own
  // evaluation reports ~73px error in X against ~141px in Y). A per-axis
  // affine fit removes exactly that component, and it's the cheapest
  // accuracy available: no new model, no new dependency, ~40 lines.
  //
  // The fit CANNOT be taken from the calibration clicks themselves. Those
  // are the points the regression was just trained on, so its residual
  // there is near zero by construction and the fit would learn nothing
  // (or worse, amplify noise). It needs points the model has NOT seen,
  // which is why there's a separate look-only validation sweep afterwards.
  // That sweep doubles as the only honest accuracy number in the system.
  const VALIDATION_POINTS = [
    { fx: 0.5, fy: 0.5 },
    { fx: 0.15, fy: 0.18 },
    { fx: 0.85, fy: 0.18 },
    { fx: 0.15, fy: 0.82 },
    { fx: 0.85, fy: 0.82 },
  ];
  const VALIDATE_SETTLE_MS = 550; // let the eye land + smoothing catch up before believing anything
  const VALIDATE_SAMPLE_MS = 950;
  // Refuse a fit that rescales an axis beyond this. A visitor who blinks or
  // looks away through the sweep can produce a mathematically valid but
  // wildly wrong line; better to ship uncorrected than inverted.
  const GAIN_LIMITS = { min: 0.25, max: 4 };

  // Cinematic pacing (ms). TRAVELs must match the transform transition
  // duration in gaze-ui.css (#webgazerVideoContainer.gaze-preview-live).
  const SCAN_HOLD = 3200;   // full-screen face + mesh points
  const ZOOM_TRAVEL = 1600; // camera-push into the eyes
  const ZOOM_HOLD = 2200;   // lingering on the eyes
  const DOCK_TRAVEL = 1000; // shrink to the corner before calibration
  const COMPLETE_HOLD = 1700;

  // Where the docked preview sits during calibration (top-left corner).
  const DOCK_W = 240;
  const DOCK_MARGIN = 12;

  let smoothed = null;
  let overlay; // z 1000 — scrim / boot-black backdrop / cards
  let hud;     // z 1002 — HUD chrome + calibration dots (above the video)
  let trackingActive = false; // true once GazeSource.start() has resolved and stop() hasn't been called since
  let gazeInControl = false;  // true when onSample() is actually driving Tracking (false while paused to mouse)
  let cineRun = 0; // cancellation token: bumping it aborts any in-flight cinematic
  let correction = null;   // { ax, bx, ay, by } — per-axis affine, null = identity
  let rawCollector = null; // non-null while the validation sweep is sampling
  // The chosen tracker, picked from window.GazeSources on the boot screen.
  // Everything below refers to it by this name, so the rest of the file is
  // identical to when there was exactly one hard-wired source.
  let GazeSource = null;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Cheap terminal-style typewriter for HUD status lines.
  function typeInto(el, text, speed = 24) {
    el.textContent = "";
    let i = 0;
    const tick = () => {
      if (!el.isConnected) return; // HUD was re-rendered — stop typing
      el.textContent = text.slice(0, ++i);
      if (i < text.length) setTimeout(tick, speed);
    };
    tick();
  }

  function calibrationPoints() {
    const pts = [];
    for (let r = 0; r < CALIBRATION_GRID.rows; r++) {
      for (let c = 0; c < CALIBRATION_GRID.cols; c++) {
        pts.push({ fx: (c + 0.5) / CALIBRATION_GRID.cols, fy: (r + 0.5) / CALIBRATION_GRID.rows });
      }
    }
    return pts;
  }

  // Raw source coordinates -> corrected screen coordinates.
  function correct(x, y) {
    if (!correction) return { x, y };
    return { x: correction.ax * x + correction.bx, y: correction.ay * y + correction.by };
  }

  function onSample({ x, y }) {
    // Validation samples the UNCORRECTED signal on purpose — it's fitting
    // the correction, so feeding it already-corrected values would make the
    // second fit of a re-calibration chase its own tail.
    if (rawCollector) rawCollector.push({ x, y });
    if (!gazeInControl) return; // paused to mouse — ignore samples rather than fight Tracking for control
    const c = correct(x, y);
    if (!smoothed) smoothed = { x: c.x, y: c.y };
    const k = smoothing();
    smoothed.x = smoothed.x * k + c.x * (1 - k);
    smoothed.y = smoothed.y * k + c.y * (1 - k);
    const cx = Math.max(0, Math.min(window.innerWidth, smoothed.x));
    const cy = Math.max(0, Math.min(window.innerHeight, smoothed.y));
    Tracking.setExternalPointers([{ id: "gaze", x: cx, y: cy }]);
  }

  // Ordinary least squares for actual = a*pred + b.
  function fitAxis(pred, actual) {
    const n = pred.length;
    let sp = 0, sa = 0, spp = 0, spa = 0;
    for (let i = 0; i < n; i++) {
      sp += pred[i];
      sa += actual[i];
      spp += pred[i] * pred[i];
      spa += pred[i] * actual[i];
    }
    const denom = n * spp - sp * sp;
    // Degenerate when every prediction landed on the same value — which is
    // exactly what a frozen/failed tracker produces, so this guard is load
    // bearing, not theoretical.
    if (Math.abs(denom) < 1e-6) return null;
    const a = (n * spa - sp * sa) / denom;
    const b = (sa - a * sp) / n;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    // Gain must be POSITIVE, not merely non-tiny. A negative slope is a
    // mirrored mapping — look left, pointer goes right — which is never a
    // legitimate correction, only ever a sign that the sweep collected
    // garbage. An abs() test here would happily accept it.
    if (a < GAIN_LIMITS.min || a > GAIN_LIMITS.max) return null;
    return { a, b };
  }

  // Median beats mean here: a visitor's eye flicking away mid-sample
  // produces a handful of wild outliers, and the mean chases them.
  function median(values) {
    const s = [...values].sort((p, q) => p - q);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function rmsError(pairs, mapFn) {
    let sum = 0;
    for (const { pred, actual } of pairs) {
      const p = mapFn(pred);
      sum += (p.x - actual.x) ** 2 + (p.y - actual.y) ** 2;
    }
    return Math.sqrt(sum / pairs.length);
  }

  // Look-only sweep over points the regression was never trained on: the
  // residual here is real generalisation error, so it both fits the
  // correction and yields a number worth showing the visitor.
  async function runValidation(run) {
    const pairs = [];

    for (let i = 0; i < VALIDATION_POINTS.length; i++) {
      const pt = VALIDATION_POINTS[i];
      const x = pt.fx * window.innerWidth;
      const y = pt.fy * window.innerHeight;

      hud.innerHTML = `
        <p class="gaze-hud-status">VERIFYING LOCK ▸ NODE ${i + 1}/${VALIDATION_POINTS.length} ▸ DO NOT CLICK — JUST LOOK</p>
        <button class="gaze-dot gaze-dot-passive" style="left:${x}px; top:${y}px; --fill-ms:${VALIDATE_SETTLE_MS + VALIDATE_SAMPLE_MS}ms;">
          <span class="gaze-dot-ring"></span>
          <span class="gaze-dot-core"></span>
        </button>`;

      await wait(VALIDATE_SETTLE_MS);
      if (run !== cineRun) return null;
      rawCollector = [];
      await wait(VALIDATE_SAMPLE_MS);
      const got = rawCollector;
      rawCollector = null;
      if (run !== cineRun) return null;

      if (got.length >= 3) {
        pairs.push({
          pred: { x: median(got.map((g) => g.x)), y: median(got.map((g) => g.y)) },
          actual: { x, y },
        });
      }
    }

    // Two points can define a line but not a trustworthy one; below three
    // usable nodes, leave the signal alone.
    if (pairs.length < 3) return null;

    const before = rmsError(pairs, (p) => p);
    const fx = fitAxis(pairs.map((p) => p.pred.x), pairs.map((p) => p.actual.x));
    const fy = fitAxis(pairs.map((p) => p.pred.y), pairs.map((p) => p.actual.y));
    if (!fx || !fy) return before;

    const candidate = { ax: fx.a, bx: fx.b, ay: fy.a, by: fy.b };
    const after = rmsError(pairs, (p) => ({
      x: candidate.ax * p.x + candidate.bx,
      y: candidate.ay * p.y + candidate.by,
    }));

    // Only adopt a fit that actually helps on the very points it was fit
    // to. If it doesn't, something upstream is wrong and identity is safer.
    if (after < before) {
      correction = candidate;
      return after;
    }
    return before;
  }

  // ---------------------------------------------------------------- preview
  // All cinematic movement is done with CSS transforms on the tracker's
  // preview container (internal size stays fixed — see PREVIEW size note in
  // webgazer-source.js), so the video, face-mesh overlay and feedback box
  // all travel together and the transitions stay buttery.

  function previewEl() {
    return GazeSource && GazeSource.getPreviewElement ? GazeSource.getPreviewElement() : null;
  }

  function previewSize(el) {
    return { w: el.offsetWidth || 640, h: el.offsetHeight || 480 };
  }

  // Transform so preview point (fx, fy) lands on the screen centre at scale z.
  function focusPreviewOn(el, fx, fy, z) {
    const tx = window.innerWidth / 2 - z * fx;
    const ty = window.innerHeight / 2 - z * fy;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
  }

  function coverScale(el) {
    const { w, h } = previewSize(el);
    return Math.max(window.innerWidth / w, window.innerHeight / h);
  }

  function dockPreview(el) {
    const { w } = previewSize(el);
    el.style.transform = `translate(${DOCK_MARGIN}px, ${DOCK_MARGIN}px) scale(${DOCK_W / w})`;
  }

  // ------------------------------------------------------------------ boot
  // One-button boot for when the tracker was already chosen via ?src=.
  function showBootConfirm(key) {
    const src = window.GazeSources[key];
    overlay.className = "gaze-overlay gaze-overlay-boot";
    overlay.innerHTML = `
      <div class="gaze-boot">
        <h1 class="gaze-boot-title">PETRIF<span>EYE</span></h1>
        <p class="gaze-boot-sub">${src.label || src.name}</p>
        <div class="gaze-source-row">
          <button class="gaze-btn-boot" id="gaze-go">▸ initiate</button>
        </div>
        <button class="gaze-boot-skip" id="gaze-other">choose a different input</button>
        <button class="gaze-boot-skip" id="gaze-skip">bypass — cursor mode</button>
      </div>`;
    overlay.querySelector("#gaze-go").onclick = () => beginCinematic(key);
    overlay.querySelector("#gaze-other").onclick = showBoot;
    overlay.querySelector("#gaze-skip").onclick = pauseToMouse;
  }

  function showBoot() {
    overlay.className = "gaze-overlay gaze-overlay-boot";
    const sources = window.GazeSources || {};
    const hasNeon = !!sources.neon;
    overlay.innerHTML = `
      <div class="gaze-boot">
        <h1 class="gaze-boot-title">PETRIF<span>EYE</span></h1>
        <p class="gaze-boot-sub">ocular tracking interface</p>
        <p class="gaze-boot-choose">select input</p>
        <div class="gaze-source-row">
          <button class="gaze-btn-boot" id="gaze-src-webgazer">
            ▸ webcam
            <span class="gaze-src-note">built in · needs calibration</span>
          </button>
          ${hasNeon ? `
          <button class="gaze-btn-boot" id="gaze-src-neon">
            ▸ neon glasses
            <span class="gaze-src-note">calibration-free · needs bridge</span>
          </button>` : ""}
        </div>
        <button class="gaze-boot-skip" id="gaze-skip">bypass — cursor mode</button>
      </div>`;
    overlay.querySelector("#gaze-src-webgazer").onclick = () => beginCinematic("webgazer");
    const neonBtn = overlay.querySelector("#gaze-src-neon");
    if (neonBtn) neonBtn.onclick = () => beginCinematic("neon");
    overlay.querySelector("#gaze-skip").onclick = pauseToMouse;
  }

  function showBootStatus(main, hint = "") {
    overlay.className = "gaze-overlay gaze-overlay-boot";
    overlay.innerHTML = main
      ? `<div class="gaze-boot">
           <p class="gaze-boot-status">${main}<span class="gaze-caret">▮</span></p>
           ${hint ? `<p class="gaze-boot-hint">${hint}</p>` : ""}
         </div>`
      : "";
  }

  function showError(message) {
    overlay.className = "gaze-overlay gaze-overlay-boot";
    overlay.innerHTML = `
      <div class="gaze-card">
        <h2>Couldn't start eye tracking</h2>
        <p>${message}</p>
        <button class="gaze-btn" id="gaze-retry">Try again</button>
        <button class="gaze-btn gaze-btn-ghost" id="gaze-back">Pick a different input</button>
        <button class="gaze-btn gaze-btn-ghost" id="gaze-skip">Use mouse instead</button>
      </div>`;
    // No argument: retry whatever source was already selected.
    overlay.querySelector("#gaze-retry").onclick = () => beginCinematic();
    overlay.querySelector("#gaze-back").onclick = () => { GazeSource = null; showBoot(); };
    overlay.querySelector("#gaze-skip").onclick = pauseToMouse;
  }

  // ------------------------------------------------------------- cinematic
  async function startCamera() {
    if (trackingActive) return true;
    try {
      await GazeSource.start(onSample);
      trackingActive = true;
      gazeInControl = true;
      return true;
    } catch (err) {
      showError(err.message || String(err));
      return false;
    }
  }

  async function beginCinematic(sourceKey) {
    // Fullscreen must be requested inside the click/key gesture — i.e.
    // before the first await. Denied/unsupported → just carry on windowed.
    const fs = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    if (fs && fs.catch) fs.catch(() => {});

    // Selection only happens on a fresh start; 't'/'e' reuse whatever is
    // already chosen, so they pass nothing and keep the current source.
    if (sourceKey) {
      const picked = (window.GazeSources || {})[sourceKey];
      if (!picked) {
        showError(`No tracker registered under "${sourceKey}".`);
        return;
      }
      GazeSource = picked;
    }
    if (!GazeSource) {
      showBoot();
      return;
    }

    // Markers must be on screen BEFORE the bridge starts mapping, and must
    // stay up for as long as Neon is driving — the surface is re-solved
    // every scene frame.
    if (GazeSource.name === "neon" && window.Markers) window.Markers.show();

    const run = ++cineRun;
    showBootStatus(
      GazeSource.name === "neon" ? "LINKING TO NEON BRIDGE" : "REQUESTING OPTIC FEED",
      GazeSource.name === "neon"
        ? "put the glasses on — the bridge must be running"
        : "allow camera access when your browser asks"
    );
    if (!(await startCamera())) return;
    if (run !== cineRun) return;

    const el = previewEl();
    if (!el) {
      // Source has no local video to choreograph (Neon's scene camera lives
      // on the phone) — skip the face-scan cinematic entirely.
      showBootStatus("");
      runCalibration();
      return;
    }

    // Phase: full-screen face scan. Position the (still invisible) preview
    // to cover the viewport BEFORE enabling transitions, so the reveal is a
    // fade-in rather than a fly-in from the corner.
    showBootStatus("");
    const { w, h } = previewSize(el);
    focusPreviewOn(el, w / 2, h / 2, coverScale(el));
    void el.offsetWidth; // flush the untransitioned transform
    el.classList.add("gaze-preview-live");

    hud.classList.remove("gaze-hud-tight");
    hud.innerHTML = `
      <div class="gaze-hud-corner gaze-tl"></div><div class="gaze-hud-corner gaze-tr"></div>
      <div class="gaze-hud-corner gaze-bl"></div><div class="gaze-hud-corner gaze-br"></div>
      <div class="gaze-scanline"></div>
      <p class="gaze-hud-status" id="gaze-status"></p>`;
    typeInto(hud.querySelector("#gaze-status"), "SUBJECT ACQUIRED ▸ FACIAL MESH LOCK");
    await wait(SCAN_HOLD);
    if (run !== cineRun) return;

    // Phase: push in on the eyes. Eyes sit roughly centred horizontally and
    // ~40% down the frame when the face-feedback box has the visitor lined
    // up — a stylised zoom, not landmark-accurate, and that's fine here.
    const scanline = hud.querySelector(".gaze-scanline");
    if (scanline) scanline.remove();
    hud.classList.add("gaze-hud-tight"); // corner brackets close in on the eye band
    typeInto(hud.querySelector("#gaze-status"), "ISOLATING OCULAR REGION ▸ PUPIL VECTORS LOCKED");
    focusPreviewOn(el, w / 2, h * 0.4, coverScale(el) * 2.4);
    await wait(ZOOM_TRAVEL + ZOOM_HOLD);
    if (run !== cineRun) return;

    // Phase: dock the feed and calibrate.
    hud.classList.remove("gaze-hud-tight");
    hud.innerHTML = "";
    dockPreview(el);
    await wait(DOCK_TRAVEL);
    if (run !== cineRun) return;
    runCalibration();
  }

  async function finishCinematic(accuracyPx) {
    const run = ++cineRun;
    // Publish the measured error so the rest of the app can size itself to
    // how good this particular calibration actually turned out — a
    // CustomEvent rather than a direct call, so nothing here needs to know
    // the sketch exists (and the sketch needs no gaze imports).
    window.dispatchEvent(new CustomEvent("gaze-accuracy", { detail: { accuracyPx } }));

    const readout =
      accuracyPx == null
        ? "ACCURACY UNVERIFIED"
        : `MEAN ERROR ±${Math.round(accuracyPx)}PX`;
    hud.innerHTML = `
      <div class="gaze-complete">
        <div class="gaze-complete-ring"></div>
        <p class="gaze-complete-text">GAZE LINK ESTABLISHED</p>
        <p class="gaze-complete-sub">${readout}</p>
      </div>`;
    await wait(COMPLETE_HOLD);
    if (run !== cineRun) return;
    hud.innerHTML = "";
    if (GazeSource.setPreviewVisible) GazeSource.setPreviewVisible(false);
    overlay.classList.add("gaze-overlay-fade");
    await wait(900); // matches the opacity transition in gaze-ui.css
    if (run !== cineRun) return;
    hideOverlay();
  }

  // -------------------------------------------------------------- calibrate
  function runCalibration() {
    overlay.className = "gaze-overlay gaze-overlay-boot"; // black stage for the dots
    overlay.innerHTML = "";
    // Drop any correction from a previous session before re-measuring —
    // otherwise the new sweep would be validating the OLD fit and the two
    // would compound.
    correction = null;
    const run = cineRun;

    // Neon is calibration-free — there is no per-visitor model to train, so
    // the click grid would be pure ceremony. Go straight to the look-only
    // sweep, which is still worth running: it measures real accuracy and
    // sizes the sketch's assist radius.
    if (GazeSource && GazeSource.needsClickCalibration === false) {
      runValidation(run).then((accuracyPx) => {
        if (run !== cineRun) return;
        hud.innerHTML = "";
        finishCinematic(accuracyPx);
      });
      return;
    }

    const points = calibrationPoints();
    let ptIndex = 0;
    let clicks = 0;

    const step = () => {
      if (ptIndex >= points.length) {
        runValidation(run).then((accuracyPx) => {
          if (run !== cineRun) return;
          hud.innerHTML = "";
          finishCinematic(accuracyPx);
        });
        return;
      }
      const pt = points[ptIndex];
      let x = pt.fx * window.innerWidth;
      let y = pt.fy * window.innerHeight;

      // The docked preview owns the top-left corner during calibration — a
      // dot landing under it would be hidden and unclickable (the video
      // renders above the HUD's siblings at z 1001). Nudge such points just
      // past it instead of losing that corner's coverage entirely.
      const { w, h } = (() => {
        const el = previewEl();
        if (!el) return { w: 0, h: 0 };
        const s = previewSize(el);
        const scale = DOCK_W / s.w;
        return { w: DOCK_MARGIN + s.w * scale, h: DOCK_MARGIN + s.h * scale };
      })();
      const MARGIN = 24;
      if (x < w + MARGIN && y < h + MARGIN) {
        x = w + MARGIN;
        y = h + MARGIN;
      }

      hud.innerHTML = `
        <p class="gaze-hud-status">CALIBRATION ▸ NODE ${ptIndex + 1}/${points.length} ▸ <span id="gaze-locks">0/${CLICKS_PER_POINT}</span> LOCKS</p>
        <button class="gaze-dot" style="left:${x}px; top:${y}px;">
          <span class="gaze-dot-ring"></span>
          <span class="gaze-dot-core"></span>
        </button>`;

      const dot = hud.querySelector(".gaze-dot");
      const ring = hud.querySelector(".gaze-dot-ring");
      const locks = hud.querySelector("#gaze-locks");
      dot.onclick = () => {
        clicks++;
        ring.style.setProperty("--p", String(clicks / CLICKS_PER_POINT));
        locks.textContent = `${clicks}/${CLICKS_PER_POINT}`;
        if (GazeSource.recordCalibrationClick) GazeSource.recordCalibrationClick(x, y);
        if (clicks >= CLICKS_PER_POINT) {
          clicks = 0;
          ptIndex++;
          step();
        }
      };
    };
    step();
  }

  // Re-run just the calibration on an already-live session ('t' key): bring
  // the (hidden) preview back, dock it, run the dots, finishCinematic hides
  // it again.
  function startRecalibration() {
    cineRun++;
    if (!GazeSource) { showBoot(); return; }
    const el = previewEl();
    if (el) {
      if (GazeSource.setPreviewVisible) GazeSource.setPreviewVisible(true);
      el.classList.add("gaze-preview-live");
      dockPreview(el);
    }
    runCalibration();
  }

  // ---------------------------------------------------------- mouse <-> eye
  // Switches control to the mouse WITHOUT tearing down the gaze session —
  // if a source supports pause() (WebGazer does), the camera stops and
  // predictions stop, but the trained model stays in memory, so
  // resumeToEye() can come back instantly with no recalibration. Falls
  // back to a full stop() for a source that doesn't support pause().
  function pauseToMouse() {
    cineRun++; // abort any in-flight cinematic
    gazeInControl = false;
    // Heavy smoothing (SMOOTHING=0.8) means the displayed point normally
    // eases toward each new sample gradually. Left alone across a pause,
    // the first real sample after resuming would have to slowly drag the
    // stale pre-pause position all the way back to wherever the gaze
    // actually is now — reads as "tracking is lost/stuck" even though
    // fresh samples are arriving immediately. Clearing it means the next
    // sample after resume becomes the new anchor outright.
    smoothed = null;
    rawCollector = null; // an aborted validation sweep must not keep collecting
    hud.innerHTML = "";
    // Nothing is mapping a surface while the mouse is driving, so the tags
    // are pure visual noise on the piece until gaze resumes.
    if (window.Markers) window.Markers.hide();
    if (trackingActive) {
      if (GazeSource.setPreviewVisible) GazeSource.setPreviewVisible(false);
      if (GazeSource.pause) {
        GazeSource.pause();
      } else {
        GazeSource.stop();
        trackingActive = false;
      }
    }
    Tracking.releaseExternal();
    hideOverlay();
  }

  // The other half of pauseToMouse(): resume an already-running (but
  // paused) session instantly, or start fresh (camera prompt + cinematic +
  // calibration) if there's no session to resume.
  async function resumeToEye() {
    if (trackingActive) {
      if (GazeSource && GazeSource.name === "neon" && window.Markers) window.Markers.show();
      if (GazeSource && GazeSource.resume) GazeSource.resume();
      gazeInControl = true;
      hideOverlay();
    } else {
      await beginCinematic();
    }
  }

  function hideOverlay() {
    overlay.innerHTML = "";
    overlay.className = "gaze-overlay gaze-overlay-hidden";
    // The boot screen is gone and input is live — the moment a game should
    // actually start. Medusa doesn't care (it renders continuously behind the
    // overlay), but the platformer must not run while the player is looking
    // at calibration dots. The flag covers listeners that attach late.
    window.__gazeReady = true;
    window.dispatchEvent(new CustomEvent("gaze-ready"));
  }

  document.addEventListener("keydown", (e) => {
    if (!overlay) return;
    if (e.key === "t" || e.key === "T") {
      if (trackingActive) startRecalibration();
      else beginCinematic(); // keydown is a user gesture too — fullscreen allowed
    }
    if (e.key === "m" || e.key === "M") pauseToMouse();
    if (e.key === "e" || e.key === "E") resumeToEye();
  });

  window.addEventListener("DOMContentLoaded", () => {
    overlay = document.createElement("div");
    overlay.className = "gaze-overlay";
    document.body.appendChild(overlay);
    hud = document.createElement("div");
    hud.className = "gaze-hud";
    document.body.appendChild(hud);

    const params = new URLSearchParams(location.search);

    // ?mouse (or ?src=mouse) drops straight into cursor control with no boot
    // screen at all. Unlike the tracker paths this needs no user gesture —
    // no camera, no fullscreen — so it can start on load. Exists because
    // clicking through calibration on every reload makes iterating on a
    // game's behaviour miserable.
    if (params.has("mouse") || params.get("src") === "mouse") {
      pauseToMouse();
      return;
    }

    // ?src=neon / ?src=webgazer preselects the tracker, so the launcher can
    // send a visitor straight into a game. Still requires their click on the
    // boot screen: fullscreen and getUserMedia both need a user gesture, so
    // auto-starting here would fail silently on the first load.
    const wanted = params.get("src");
    if (wanted && (window.GazeSources || {})[wanted]) {
      showBootConfirm(wanted);
      return;
    }
    showBoot();
  });
})();
