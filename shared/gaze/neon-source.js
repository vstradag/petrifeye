// Pupil Labs Neon adapter — implements the same GazeSource interface as
// webgazer-source.js, so gaze-controller.js and sketch.js are unchanged.
//
// WHY THIS TALKS TO A LOCAL BRIDGE INSTEAD OF THE GLASSES DIRECTLY
//
// Three things make a direct browser->Neon connection impossible, not just
// inconvenient:
//
//   1. Neon streams gaze over RTSP. Browsers cannot consume RTSP at all —
//      there is no API for it and no polyfill.
//   2. Neon reports gaze in SCENE-CAMERA coordinates. It's head-mounted: it
//      knows where you're looking inside its forward camera's field of view,
//      not where that lands on a monitor. Turning one into the other needs
//      AprilTag markers and a homography, and Pupil Labs' implementation of
//      that (real-time-screen-gaze) is Python.
//   3. The Companion app serves plain HTTP on the LAN, and this page must be
//      HTTPS for the webcam path to work at all. An HTTPS page may not fetch
//      http://192.168.x.x.
//
// So bridge/neon_bridge.py does the RTSP + surface mapping in Python and
// hands finished SCREEN-PIXEL coordinates to this file over a WebSocket. The
// bridge also serves this very page, which is what makes that socket
// same-origin — no mixed content, no second certificate to trust.
//
// Message contract (JSON, bridge -> browser):
//   { type: "gaze",   x, y, worn }   x/y in CSS pixels, origin top-left
//   { type: "status", state, detail, surfaceOk, markersVisible }
//   { type: "error",  message }
(function () {
  // Same host/port as the page: the bridge is the web server.
  const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/gaze`;
  const CONNECT_TIMEOUT_MS = 12000;

  let socket = null;
  let sampleCb = null;
  let paused = false;
  let lastStatus = null;
  let running = false;      // true between start() and stop()
  // True once the bridge has reported "streaming" at least once. It decides
  // where a socket close goes: before the handshake a failure is a real boot
  // error worth showing; after it, the app is live and a drop must silently
  // reconnect instead. Without this distinction the initial socket keeps its
  // reject-handler forever and post-handshake drops route into a no-op —
  // which froze the pointer instead of recovering.
  let handshakeDone = false;
  let reconnectTimer = null;
  let reconnectDelay = 500; // grows to RECONNECT_MAX while the bridge is away
  const RECONNECT_MAX = 5000;

  function close() {
    if (!socket) return;
    // Drop the handler first: closing fires onclose, and without this a
    // deliberate stop() would look like an unexpected disconnect.
    socket.onclose = null;
    try { socket.close(); } catch (_) {}
    socket = null;
  }

  // Tells the bridge the page's true CSS-pixel size. Both the surface
  // geometry (where the markers actually are) and the output scaling depend
  // on it, so a wrong value tilts every coordinate. It must come from the
  // browser rather than a command-line guess: a Retina Mac's 3024x1964 panel
  // is a 1512x982 CSS viewport, and assuming 1920x1080 stretched gaze by
  // ~1.27x horizontally.
  //
  // Uses innerWidth/innerHeight, not screen.width: markers are positioned in
  // the viewport, so that is the coordinate space that matters — and it is
  // what changes when the window resizes or enters fullscreen.
  function sendViewport() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: "viewport",
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
    }));
  }

  // Entering fullscreen changes the viewport, which moves every marker.
  // Debounced because resize fires continuously while dragging a window and
  // each report rebuilds the surface.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendViewport, 250);
  });

  // Reconnects the gaze socket after an unexpected drop. The Companion app
  // crashes and restarts on its own, and the bridge stays up throughout —
  // so a dropped socket is a hiccup to ride out, not a session-ending error.
  // Without this the pointer simply froze at its last position and blobs
  // kept petrifying underneath it, which is the worst possible failure for
  // an unattended installation.
  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!running) return;
      openSocket();
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
    }, reconnectDelay);
  }

  // onReady/onFail are only supplied by the initial start() call; reconnects
  // pass nothing, because the app is already running and must not be shown a
  // boot error for a blip it recovered from on its own.
  function openSocket(onReady, onFail) {
    try {
      socket = new WebSocket(WS_URL);
    } catch (err) {
      if (onFail) onFail(`Couldn't open ${WS_URL}: ${err.message}`);
      else scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      reconnectDelay = 500;
      sendViewport();
    };

    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }

      if (msg.type === "status") {
        lastStatus = msg;
        window.dispatchEvent(new CustomEvent("neon-status", { detail: msg }));
        if (msg.state === "streaming") {
          handshakeDone = true;
          if (onReady) onReady();
        }
        // "stalled" is the bridge telling us the phone went quiet but it is
        // still retrying. Deliberately not an error: the app keeps running
        // and picks up again when the Companion app comes back.
        return;
      }

      if (msg.type === "error") {
        lastStatus = msg;
        window.dispatchEvent(new CustomEvent("neon-status", { detail: msg }));
        if (!handshakeDone && onFail) onFail(msg.message || "Neon bridge reported an error.");
        return;
      }

      // Discrete blink, used as "shoot" by the platformer. Re-broadcast as a
      // DOM event so gaze-actions.js can consume it without knowing anything
      // about this transport.
      if (msg.type === "blink") {
        window.dispatchEvent(new CustomEvent("neon-blink", { detail: msg }));
        return;
      }

      // Pupil diameter in mm. Requires "Compute eye state" on the phone.
      if (msg.type === "pupil") {
        window.dispatchEvent(new CustomEvent("neon-pupil", { detail: msg }));
        return;
      }

      if (msg.type === "gaze") {
        if (paused || !sampleCb) return;
        // worn === false means the glasses are off the face. Feeding those
        // samples through would drag the pointer to wherever the last valid
        // estimate decayed toward and quietly petrify things while nobody is
        // wearing the device.
        if (msg.worn === false) return;
        sampleCb({ x: msg.x, y: msg.y });
      }
    };

    socket.onerror = () => {
      if (!handshakeDone && onFail) onFail(`Couldn't reach the Neon bridge at ${WS_URL}.`);
    };

    socket.onclose = () => {
      socket = null;
      if (!handshakeDone && onFail) onFail("The Neon bridge closed the connection.");
      else scheduleReconnect();
    };
  }

  function start(onSample) {
    sampleCb = onSample;
    paused = false;
    running = true;
    reconnectDelay = 500;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => {
        if (settled) return;   // post-handshake drops are handled by reconnect
        settled = true;
        close();
        reject(new Error(msg));
      };

      // A WebSocket to a bridge that isn't running can sit in CONNECTING for
      // a long time on some platforms rather than erroring promptly, so cap
      // it ourselves — the visitor gets a real message instead of a
      // permanently spinning boot screen.
      const timer = setTimeout(
        () => fail("Timed out waiting for the Neon bridge. Is neon_bridge.py running?"),
        CONNECT_TIMEOUT_MS
      );

      openSocket(
        // "streaming" means the bridge has the glasses AND a usable surface
        // mapping — i.e. gaze is about to be meaningful. Resolving earlier
        // would drop the visitor into the scene with a dead pointer.
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (msg) => { clearTimeout(timer); fail(msg); }
      );
    });
  }

  function stop() {
    running = false;
    handshakeDone = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    close();
    sampleCb = null;
    paused = false;
  }

  // Neon keeps streaming regardless; pausing is purely local so that
  // switching to mouse control doesn't cost the (expensive) connection and
  // 'e' can resume instantly — same contract webgazer-source offers.
  function pause() { paused = true; }
  function resume() { paused = false; }

  // Neon is calibration-free by design, so there is nothing to train and no
  // click to record. Defined as a no-op rather than omitted so the interface
  // stays uniform for anything that feature-detects it.
  function recordCalibrationClick() {}

  function getStatus() { return lastStatus; }

  window.GazeSources = window.GazeSources || {};
  window.GazeSources.neon = {
    name: "neon",
    label: "pupil labs neon",
    // The 9x4 click grid exists to fit WebGazer's per-visitor regression.
    // Neon needs none of it — but gaze-controller still runs the look-only
    // validation sweep afterwards, because that measures real accuracy and
    // sizes the sketch's assist radius.
    needsClickCalibration: false,
    start,
    stop,
    pause,
    resume,
    recordCalibrationClick,
    getStatus,
    // No local camera preview to choreograph — the scene camera lives on the
    // phone. Returning nothing makes gaze-controller skip the face-scan
    // cinematic for this source automatically.
  };
})();
