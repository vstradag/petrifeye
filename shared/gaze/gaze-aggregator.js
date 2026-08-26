// Merge gaze from N Neon bridges into one tagged pointer stream.
//
// Each Neon phone needs its own bridge process on its own port (8443, 8444,
// ...), because a bridge owns one RTSP session to one device. This connects
// to all of them and republishes the result through the SAME channel the
// single-player game already uses:
//
//     Tracking.setExternalPointers([{ id: "p0", x, y }, { id: "p1", x, y }])
//
// That matters. DwellTarget and AttentionArbiter have been multi-pointer
// since the start — they key everything by pointer id and already resolve
// one winner per pointer. So multiplayer needs no new game logic at all,
// only more pointers with distinct ids. An earlier version of this file
// reimplemented dwell and arbitration standalone and got both wrong.
//
//   GazeAggregator.init({ players: [{ id, label, port, color }, ...] })
//
// Emits "gaze-players" (any state change) so UI can render connection state.
(function () {
  const STALE_MS = 1500;      // no sample for this long => that player is out
  const RECONNECT_MS = 1500;

  let players = [];
  let publishing = true;      // false while a mouse/keyboard stand-in drives
  const conn = {};            // playerId -> { ws, state, detail, x, y, at }

  function snapshot() {
    return players.map((p) => {
      const c = conn[p.id] || {};
      return {
        ...p,
        source: p.source,
        state: c.state || "connecting",
        detail: c.detail || "",
        // The bridge has gaze from the phone. This is what "ready to play"
        // means — NOT that mapped gaze has arrived, which additionally
        // requires the markers to be on screen and in that player's camera.
        // Gating readiness on mapped gaze deadlocks: the markers are only
        // drawn once play starts, so they can never become visible.
        streaming: c.state === "streaming",
        // How many of the four tags this player's scene camera can see.
        markers: typeof c.markers === "number" ? c.markers : null,
        // Mapped gaze actually flowing.
        live: !!c.at && performance.now() - c.at < STALE_MS,
        x: c.x, y: c.y,
      };
    });
  }

  function emit() {
    window.dispatchEvent(new CustomEvent("gaze-players", { detail: snapshot() }));
  }

  // Tell EVERY bridge the viewport it should map gaze into.
  //
  // Each bridge builds its surface from the marker positions this page
  // reports, so a bridge that never hears the real size falls back to its
  // command-line default (1920x1080) and stretches every coordinate — on a
  // 1512x982 Retina viewport that is ~1.27x horizontally. Single player
  // solved this in neon-source.js; multiplayer needs it per socket, and it
  // matters most exactly when entering fullscreen, which is the largest
  // viewport change that ever happens.
  function sendViewport() {
    const payload = JSON.stringify({
      type: "viewport",
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
    });
    for (const p of players) {
      const ws = (conn[p.id] || {}).ws;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // Marker size is surface geometry, so EVERY bridge has to hear about a
  // change — a bridge left on the old figure keeps solving against corners
  // the tags no longer occupy, and skews that player's gaze with no error
  // anywhere. Sent to all sockets for the same reason the viewport is.
  function sendMarkerSize(px) {
    const payload = JSON.stringify({ type: "markerSize", size: Math.round(px) });
    for (const p of players) {
      const ws = (conn[p.id] || {}).ws;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // Debounced: resize fires continuously while a window is dragged and each
  // report rebuilds a surface on every bridge.
  let resizeTimer = null;
  function watchViewport() {
    const bump = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendViewport, 250);
    };
    window.addEventListener("resize", bump);
    // Fullscreen transitions animate; the final size is only correct once
    // the change event has fired and the frame has settled.
    document.addEventListener("fullscreenchange", () => setTimeout(sendViewport, 120));
  }

  // Republish every live player as a pointer. Pointers that have gone stale
  // are omitted rather than frozen in place: DwellTarget drops accumulated
  // progress for a pointer that disappears, which is the correct behaviour
  // when a player takes the glasses off mid-stare.
  function publish() {
    // Publishing an empty array still switches Tracking into external mode,
    // which silently overrides the mouse. With no bridge up that means no
    // pointer at all and nothing to debug with, so a stand-in must be able
    // to take the channel back.
    if (!publishing) return;
    if (!window.Tracking || !Tracking.setExternalPointers) return;
    const now = performance.now();
    const pointers = [];
    for (const p of players) {
      const c = conn[p.id];
      if (!c || c.x == null || !c.at || now - c.at > STALE_MS) continue;
      pointers.push({ id: p.pointerId, x: c.x, y: c.y });
    }
    Tracking.setExternalPointers(pointers);
  }

  // A webcam player. WebGazer produces exactly ONE pointer per browser — one
  // camera, one face — so at most one player can use it, and it cannot be a
  // second "bridge". It joins here instead, writing into the same conn slot
  // a socket would, so publish() stays the single place pointers are handed
  // to Tracking. Two publishers would silently overwrite each other.
  //
  // webgazer-source delivers samples by callback and does NOT touch Tracking
  // itself (gaze-controller does that in single player), which is what makes
  // this possible without the two fighting.
  async function connectWebcam(p) {
    const src = (window.GazeSources || {}).webgazer;
    if (!src) {
      conn[p.id] = { state: "offline", detail: "webgazer.js not loaded" };
      emit();
      return;
    }
    conn[p.id] = { state: "connecting", detail: "starting camera…" };
    emit();
    try {
      await src.start((sample) => {
        const c = conn[p.id];
        if (!c || !sample) return;
        c.x = sample.x;
        c.y = sample.y;
        c.at = performance.now();
        if (c.state !== "streaming") { c.state = "streaming"; c.detail = ""; emit(); }
        publish();
      });
      conn[p.id].state = "streaming";
      conn[p.id].detail = "";
    } catch (err) {
      conn[p.id] = { state: "offline", detail: (err && err.message) || "camera failed" };
    }
    emit();
  }

  function connect(p) {
    if (p.source === "webcam") return connectWebcam(p);
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.hostname}:${p.port}/gaze`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      setTimeout(() => connect(p), RECONNECT_MS);
      return;
    }
    conn[p.id] = { ...(conn[p.id] || {}), ws, state: "connecting", detail: "connecting…" };
    emit();

    // Report the viewport immediately on open — before any gaze arrives, so
    // the very first mapped sample already uses the right coordinate space.
    // Also re-sent here on every reconnect, since a bridge that restarted
    // has forgotten it.
    // Viewport AND marker size on open: a bridge that restarted has forgotten
    // both, and either one being stale skews the mapping silently.
    ws.onopen = () => {
      sendViewport();
      if (window.Markers) sendMarkerSize(Markers.size);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      const c = conn[p.id];

      if (msg.type === "status") {
        c.state = msg.state;
        c.detail = msg.detail || "";
        if (msg.markersVisible != null) c.markers = msg.markersVisible;
        emit();
        return;
      }
      if (msg.type === "gaze") {
        // worn === false means the glasses are off the face; holding the last
        // position would leave a ghost pointer parked on a blob.
        if (msg.worn === false) return;
        c.x = msg.x;
        c.y = msg.y;
        c.at = performance.now();
        publish();
        return;
      }
      if (msg.type === "pupil") {
        c.pupilMm = msg.mm;
      }
    };

    ws.onclose = () => {
      const c = conn[p.id] || {};
      c.state = "offline";
      c.detail = `bridge on port ${p.port} not reachable`;
      c.at = 0;
      emit();
      publish();
      setTimeout(() => connect(p), RECONNECT_MS);
    };

    // onerror always precedes onclose; let onclose own the retry so a failed
    // connection doesn't schedule two reconnects racing each other.
    ws.onerror = () => {};
  }

  window.GazeAggregator = {
    init(config) {
      players = config.players.map((p, i) => ({
        source: "neon",     // "neon" (own bridge) | "webcam" (shared WebGazer)
        ...p,
        // Stable, distinct pointer id — this is what DwellTarget keys on and
        // what onComplete(ptr) reports back, so it IS the score attribution.
        pointerId: `player-${p.id != null ? p.id : i}`,
      }));
      players.forEach(connect);
      watchViewport();
      emit();
      // Republish on a timer as well as on message, so pointers that go stale
      // are withdrawn even when no new samples are arriving at all.
      setInterval(publish, 200);
    },

    players: () => snapshot(),
    pointerIdFor: (id) => `player-${id}`,

    // Resize the on-screen tags and keep every bridge's surface in step.
    // Single entry point on purpose: doing one without the other is the
    // silent-skew failure, so callers should never touch Markers.setSize
    // directly.
    setMarkerSize(px) {
      if (!window.Markers) return null;
      const applied = Markers.setSize(px);
      sendMarkerSize(applied);
      return applied;
    },

    // Change one player's input and reconnect just that player. Used by the
    // boot card so a webcam/Neon choice does not require a page reload.
    setSource(playerId, source) {
      const p = players.find((x) => x.id === playerId);
      if (!p || p.source === source) return;
      const old = conn[p.id];
      if (old && old.ws) { old.ws.onclose = null; old.ws.close(); }
      if (p.source === "webcam") {
        const src = (window.GazeSources || {}).webgazer;
        if (src && src.stop) { try { src.stop(); } catch (_) {} }
      }
      p.source = source;
      delete conn[p.id];
      connect(p);
      emit();
    },

    // The webcam player, if any. Its calibration is the caller's business —
    // WebGazer's ridge regression is untrained until someone clicks targets.
    webcamPlayer: () => players.find((p) => p.source === "webcam") || null,
    recordCalibrationClick(x, y) {
      const src = (window.GazeSources || {}).webgazer;
      if (src && src.recordCalibrationClick) src.recordCalibrationClick(x, y);
    },

    // Hand the pointer channel to a mouse/keyboard stand-in (or take it
    // back). Sockets stay connected either way, so the panel keeps showing
    // real bridge state while you test with simulated input.
    setPublishing(on) {
      publishing = !!on;
      if (publishing) publish();
    },

    allLive() {
      return players.length > 0 && snapshot().every((p) => p.live);
    },
  };
})();
