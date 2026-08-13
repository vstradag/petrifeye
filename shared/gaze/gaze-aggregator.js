// Aggregate gaze from multiple Neon bridges into tagged streams.
//
// In multiplayer mode, each Neon phone runs on a separate bridge port.
// The aggregator connects to all of them and merges their samples into a
// single [player0, player1, ...] array for the game.
//
//   GazeAggregator.init({
//     players: [
//       { id: 0, label: "Player 1", port: 8443, color: "#ff6b6b" },
//       { id: 1, label: "Player 2", port: 8444, color: "#4ecdc4" },
//     ],
//   });
//   GazeAggregator.on((samples) => {
//     // samples = [{ x, y, worn, playerId, label, color }, ...]
//   });
//
// Each sample carries the player metadata so the game knows who's looking where.
(function () {
  const sockets = {};
  const lastSample = {};
  let onSample = null;
  let readyCount = 0;
  let expectedCount = 0;

  function dispatchIfReady() {
    // Once all players have sent at least one sample, dispatch. After that,
    // dispatch on every update (someone went stale, that's fine — zero is
    // truth until their next sample).
    if (readyCount < expectedCount) {
      readyCount = Object.keys(lastSample).length;
      if (readyCount < expectedCount) return;
    }

    if (onSample) {
      const samples = Object.values(lastSample).sort((a, b) => a.playerId - b.playerId);
      onSample(samples);
    }
  }

  function startPlayer(player) {
    const url = `${location.protocol}//${location.hostname}:${player.port}/gaze`;
    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log(`[GazeAgg] player ${player.id} (port ${player.port}) connected`);
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      // Only care about gaze and pupil updates; ignore status/markers for now.
      if (msg.type === "gaze") {
        lastSample[player.id] = {
          x: msg.x,
          y: msg.y,
          worn: msg.worn,
          playerId: player.id,
          label: player.label,
          color: player.color,
        };
        dispatchIfReady();
      }

      if (msg.type === "pupil") {
        lastSample[player.id] = {
          ...lastSample[player.id],
          pupilMm: msg.mm,
          pupilLeft: msg.left,
          pupilRight: msg.right,
          worn: msg.worn,
        };
      }

      // Pass through status messages to the game (e.g. "stalled", "streaming").
      if (msg.type === "status") {
        window.dispatchEvent(
          new CustomEvent("gaze-aggregator-status", {
            detail: { playerId: player.id, ...msg },
          })
        );
      }
    };

    ws.onerror = () => {
      console.error(`[GazeAgg] player ${player.id} error`);
      window.dispatchEvent(
        new CustomEvent("gaze-aggregator-error", {
          detail: { playerId: player.id, message: "WebSocket error" },
        })
      );
    };

    ws.onclose = () => {
      console.warn(`[GazeAgg] player ${player.id} disconnected`);
      delete sockets[player.id];
    };

    sockets[player.id] = ws;
  }

  window.GazeAggregator = {
    init(config) {
      expectedCount = config.players.length;
      readyCount = 0;
      config.players.forEach((p) => startPlayer(p));
    },

    on(callback) {
      onSample = callback;
    },

    isReady() {
      return Object.keys(lastSample).length === expectedCount;
    },

    // For testing: manually inject a sample as if it came from a bridge.
    feed(playerId, mm) {
      if (!lastSample[playerId]) lastSample[playerId] = {};
      lastSample[playerId].playerId = playerId;
      // Update pupil diameter (for flower-like games).
      lastSample[playerId].pupilMm = mm;
      dispatchIfReady();
    },

    reset() {
      Object.values(sockets).forEach((s) => {
        if (s && s.close) s.close();
      });
      Object.keys(sockets).forEach((k) => delete sockets[k]);
      Object.keys(lastSample).forEach((k) => delete lastSample[k]);
      readyCount = 0;
    },
  };
})();
