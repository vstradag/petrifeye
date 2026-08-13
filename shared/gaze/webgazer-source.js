// WebGazer adapter — the ONLY file in this project that touches the global
// `webgazer` object. Everything else (gaze-controller.js, every sketch)
// talks to the small GazeSource interface below. To switch to a different
// eye-tracking library later: write one new file matching this same shape,
// point index.html at it instead, and nothing else in the codebase changes.
//
// GazeSource interface:
//   name                 - string, for display/debugging.
//   start(onSample)      -> Promise<void>
//                           Begins producing gaze samples. Resolves once the
//                           camera/model is ready, rejects (with a readable
//                           .message) if the camera can't be used. Calls
//                           onSample({ x, y }) in page pixel coordinates
//                           (same space as MouseEvent.clientX/clientY) each
//                           time a new prediction is ready.
//   stop()               -> void. Releases the camera, stops predictions,
//                           and (for WebGazer) discards the trained model —
//                           resuming after this means starting over from
//                           scratch, including recalibration.
//   pause()              -> void, optional. Stops the camera/predictions
//                           WITHOUT discarding the trained model — for a
//                           temporary "switch to mouse for a bit" that
//                           doesn't cost the user their calibration.
//   resume()              -> void, optional. Resumes after pause().
//   recordCalibrationClick(x, y) -> void, optional.
//                           Called once per calibration-dot click with the
//                           dot's page coordinates, so the source can use it
//                           as an explicit labeled training sample.
//   getPreviewElement()  -> Element|null, optional. The tracker's live
//                           camera-preview container (video + face-mesh
//                           overlay), if it renders one. gaze-controller's
//                           boot cinematic transforms it around the screen;
//                           sources without a visual preview return null and
//                           the cinematic is skipped.
//   setPreviewVisible(v) -> void, optional. Show/hide that preview without
//                           affecting tracking (hidden during the game,
//                           shown again for recalibration).
(function () {
  let ready = false;

  async function start(onSample) {
    if (typeof webgazer === "undefined") {
      throw new Error("webgazer.js failed to load (check the <script> tag / network connection).");
    }

    // WebGazer's face-mesh model loads its assets (wasm/binarypb) from a
    // path relative to *our* page by default, which 404s since we don't
    // host them. webgazer.cs.brown.edu hosts a copy alongside webgazer.js
    // itself, but fetches it there fail on CORS (no Access-Control-Allow-
    // Origin header on those files) — so point at MediaPipe's own CDN
    // instead, which serves the identical files with CORS enabled.
    webgazer.params.faceMeshSolutionPath = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh";

    // Bigger internal preview than WebGazer's 320x240 default. The boot
    // cinematic blows this container up to fill the screen with CSS
    // transforms — most webcams capture at 640x480 anyway, so rendering at
    // that size means the fullscreen scale-up starts from the sharpest
    // frame the camera gives us.
    webgazer.params.videoViewerWidth = 640;
    webgazer.params.videoViewerHeight = 480;

    // Public/kiosk use: each visitor is a new face. Wipe any training data
    // left over from session storage or a previous recalibration before we
    // start collecting fresh samples.
    webgazer.saveDataAcrossSessions(false);
    webgazer.clearData();

    // Note: don't call setRegression() here — WebGazer defaults to ridge
    // already, and calling it before begin() throws (it reads the *existing*
    // regression module's data to seed the new one, and none exists yet).
    webgazer
      .setGazeListener((data) => {
        if (!data) return;
        onSample({ x: data.x, y: data.y });
      })
      .showPredictionPoints(false) // we draw our own pointer marker
      .applyKalmanFilter(true); // WebGazer's own smoothing, cuts raw jitter before it reaches us

    await webgazer.begin();
    ready = true;
  }

  function stop() {
    if (!ready) return;
    webgazer.end();
    ready = false;
  }

  function pause() {
    if (!ready) return;
    webgazer.pause();
  }

  function resume() {
    if (!ready) return;
    webgazer.resume();
  }

  // WebGazer already auto-trains on real click/mousemove events (attached
  // internally by begin()), but calling this explicitly for each
  // calibration-dot click is more reliable — it doesn't depend on event
  // bubbling or listener attachment order, and it's the documented API for
  // exactly this purpose (see WebGazer wiki: Top-Level-API).
  function recordCalibrationClick(x, y) {
    if (!ready) return;
    webgazer.recordScreenPosition(x, y, "click");
  }

  // WebGazer creates this container during begin(); null before that.
  function getPreviewElement() {
    return document.getElementById("webgazerVideoContainer");
  }

  // Toggles the whole preview stack (video, face overlay, feedback box)
  // via display — tracking keeps running while hidden.
  function setPreviewVisible(visible) {
    if (!ready) return;
    webgazer.showVideoPreview(visible);
  }

  // Registered rather than assigned straight to window.GazeSource: the boot
  // screen now offers a choice of trackers (webcam vs Neon), and
  // gaze-controller picks one out of this registry at selection time.
  window.GazeSources = window.GazeSources || {};
  window.GazeSources.webgazer = {
    name: "webgazer",
    label: "webcam",
    needsClickCalibration: true, // ridge regression has to be trained per visitor
    start,
    stop,
    pause,
    resume,
    recordCalibrationClick,
    getPreviewElement,
    setPreviewVisible,
  };
})();
