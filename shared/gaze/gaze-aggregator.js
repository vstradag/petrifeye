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
        state: c.state || "connecting",
        detail: c.detail || "",
        live: !!c.at && performance.now() - c.at < STALE_MS,
        x: c.x, y: c.y,
      };
    });
  }

  function emit() {
    window.dispatchEvent(new CustomEvent("gaze-players", { detail: snapshot() }));
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

  function connect(p) {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.hostname}:${p.port}/gaze`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      setTimeout(() => connect(p), RECONNECT_MS);
      return;
    }
    conn[p.id] = { ...(conn[p.id] || {}), ws, state: "connecting", detail: `port ${p.port}` };
    emit();

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      const c = conn[p.id];

      if (msg.type === "status") {
        c.state = msg.state;
        c.detail = msg.detail || "";
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
        ...p,
        // Stable, distinct pointer id — this is what DwellTarget keys on and
        // what onComplete(ptr) reports back, so it IS the score attribution.
        pointerId: `player-${p.id != null ? p.id : i}`,
      }));
      players.forEach(connect);
      emit();
      // Republish on a timer as well as on message, so pointers that go stale
      // are withdrawn even when no new samples are arriving at all.
      setInterval(publish, 200);
    },

    players: () => snapshot(),
    pointerIdFor: (id) => `player-${id}`,

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
