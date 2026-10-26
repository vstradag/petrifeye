// DUCK HUNT — two pairs of eyes, one shot.
//
// The game is DuckHunt-JS (duck-hunt/, MIT, see duck-hunt/README.md), with
// the click taken away. Aiming is MEDUSA's: the same bridges and aggregator,
// the same per-player webcam/Neon choice, the same pointer pipeline —
// Tracking (filtered, held through stalls) → auto-calibration → attention
// arbiter (one duck per player) → magnetised marker. What changes is the
// trigger. A duck is shot only when BOTH players' gaze is on it at once:
//
//   nobody on it      nothing
//   one player on it  a cross on the duck, in that player's colour — "I've
//                     got this one, find it"
//   both on it        it fires, that instant
//
// HOLD_SEC (settings, 0 by default) can require the two to stay together a
// moment first — the red closing reticle shows it filling — if a gaze
// sweeping across a duck the other player is on turns out to fire too easily.
(function () {
  // The boot card, calibration, settings gear, common keys and the mouse +
  // arrows stand-in are shared/gaze/duo-session.js; this file is the game.

  // ------------------------------------------------------------- settings
  let HOLD_SEC = 0;            // both on the duck this long → shot
  let NEEDED = 2;              // players who must agree
  let GAZE_ASSIST_RADIUS = 170;
  // Agreement drains faster than it builds, so a broken look starts over
  // almost at once rather than finishing on the next brief overlap.
  const DECAY = 3;

  const game = () => window.DuckHuntGame || null;

  // Ducks never pick a destination under a corner tag (Stage.isBlocked reads
  // this), since a duck under a tag is a duck neither player can see.
  window.DuckHuntBlocked = () => DuoSession.markerRects();

  // ------------------------------------------------------------- the frame
  const attention = new AttentionArbiter({ captureRadius: GAZE_ASSIST_RADIUS });
  const agree = new Map();      // duckId -> seconds both have been on it
  const bursts = [];            // { x, y, t } — a shot just fired
  let focus = new Map();
  let lastFrame = performance.now();

  const overlay = document.getElementById("dhOverlay");
  const ctx = overlay.getContext("2d");

  function sizeOverlay() {
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(innerWidth * dpr);
    overlay.height = Math.round(innerHeight * dpr);
    overlay.style.width = `${innerWidth}px`;
    overlay.style.height = `${innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeOverlay();
  window.addEventListener("resize", sizeOverlay);

  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!DuoSession.started) return;

    const g = game();
    const pointers = Tracking.update();
    // Only ducks that can be shot right now. When a wave's time runs out the
    // survivors fly away still "alive"; marking them would promise a shot the
    // game will refuse.
    const targets = g && g.shootable() ? g.duckTargets() : [];

    const gazeMode = pointers.some((p) => !DuoSession.isPrecise(p.id));
    attention.captureRadius = gazeMode ? GAZE_ASSIST_RADIUS : 0;

    // As in MEDUSA: correct each wearer's bias before anything judges what
    // they look at, learn only from the corrected position the arbiter judged,
    // and magnetise only what is drawn.
    const aimed = window.GazeAutoCalibrate ? GazeAutoCalibrate.apply(pointers) : pointers;
    focus = attention.resolve(aimed, targets);
    if (window.GazeAutoCalibrate) {
      GazeAutoCalibrate.observe(aimed, focus, targets, (t) => attention.reach(t), dt);
    }
    const shown = window.GazeAssist
      ? GazeAssist.magnetize(aimed, focus, targets, (t) => attention.reach(t))
      : aimed;

    // Who is on which duck. A held pointer is a frozen last position, not a
    // look (shared/tracking.js), so it can never complete an agreement.
    const lookers = new Map();   // duckId -> [player]
    for (const p of aimed) {
      if (p.held) continue;
      const player = DuoSession.playerOf(p.id);
      const id = focus.get(p.id);
      if (!player || !id) continue;
      if (!lookers.has(id)) lookers.set(id, []);
      const list = lookers.get(id);
      if (!list.includes(player)) list.push(player);
    }

    const needed = Math.min(NEEDED, PLAYERS.length);
    const live = new Set(targets.map((t) => t.id));
    for (const id of [...agree.keys()]) if (!live.has(id)) agree.delete(id);

    for (const t of targets) {
      const on = lookers.get(t.id) || [];
      let a = agree.get(t.id) || 0;
      a = on.length >= needed ? a + dt : Math.max(0, a - dt * DECAY);
      agree.set(t.id, a);
      if (on.length >= needed && a >= HOLD_SEC) {
        if (g.shootDuck(t.duck)) {
          bursts.push({ x: t.x, y: t.y, t: now });
          agree.delete(t.id);
          window.dispatchEvent(new CustomEvent("duck-shot", {
            detail: { duckId: t.id, players: on.map((p) => p.id) },
          }));
          continue;
        }
      }
      if (on.length) drawReticle(t, on, needed, a);
    }

    drawBursts(now);
    if (DuoSession.showTarget) drawPointers(shown);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------ drawing
  // The hint. One player on a duck: a cross over it in that player's colour,
  // with the slot for the missing player left empty. Both: the cross turns
  // red, the ring closes as the agreement builds, and it fires.
  function drawReticle(t, on, needed, held) {
    const both = on.length >= needed;
    const r = Math.max(26, t.radius * 1.25);
    const arm = r * 0.55;
    ctx.save();
    ctx.lineCap = "round";

    if (!both) {
      const c = on[0].color;
      ctx.strokeStyle = c;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.95;
      // The cross itself: a diagonal X through the duck.
      ctx.beginPath();
      ctx.moveTo(t.x - arm, t.y - arm); ctx.lineTo(t.x + arm, t.y + arm);
      ctx.moveTo(t.x + arm, t.y - arm); ctx.lineTo(t.x - arm, t.y + arm);
      ctx.stroke();
      // One quarter-ring per player needed; those looking are filled in.
      for (let i = 0; i < needed; i++) {
        const who = on[i];
        const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / needed + 0.18;
        const a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / needed - 0.18;
        ctx.strokeStyle = who ? who.color : "rgba(255,255,255,.35)";
        ctx.setLineDash(who ? [] : [4, 6]);
        ctx.beginPath(); ctx.arc(t.x, t.y, r, a0, a1); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.font = "600 12px ui-monospace, Menlo, monospace";
      ctx.fillStyle = c;
      ctx.textAlign = "center";
      ctx.fillText(`${on.length}/${needed}`, t.x, t.y + r + 16);
    } else {
      const k = HOLD_SEC > 0 ? Math.min(1, held / HOLD_SEC) : 1;
      ctx.strokeStyle = "#ff3b3b";
      ctx.lineWidth = 3.5;
      ctx.shadowColor = "rgba(255,59,59,.8)";
      ctx.shadowBlur = 12;
      const rr = r * (1 - 0.25 * k);
      ctx.beginPath(); ctx.arc(t.x, t.y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(t.x - rr - 10, t.y); ctx.lineTo(t.x - rr * 0.35, t.y);
      ctx.moveTo(t.x + rr * 0.35, t.y); ctx.lineTo(t.x + rr + 10, t.y);
      ctx.moveTo(t.x, t.y - rr - 10); ctx.lineTo(t.x, t.y - rr * 0.35);
      ctx.moveTo(t.x, t.y + rr * 0.35); ctx.lineTo(t.x, t.y + rr + 10);
      ctx.stroke();
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(t.x, t.y, rr + 7, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBursts(now) {
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      const age = (now - b.t) / 450;
      if (age >= 1) { bursts.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(b.x, b.y, 20 + age * 60, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  // Each player's gaze, in their own colour, so the two can tell which
  // marker is whose. The mouse in a test is a player too, so it is drawn.
  // MEDUSA's size (44px ring, crosshair, centre dot), with a dark outline under
  // every stroke: a thin coloured ring alone vanished against the sky — the
  // teal one most of all.
  function drawPointers(pointers) {
    const d = 44;
    const arm = d * 0.64;
    const shape = () => {
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, d / 2, 0, Math.PI * 2);
      ctx.moveTo(p0.x - arm, p0.y); ctx.lineTo(p0.x - d * 0.2, p0.y);
      ctx.moveTo(p0.x + d * 0.2, p0.y); ctx.lineTo(p0.x + arm, p0.y);
      ctx.moveTo(p0.x, p0.y - arm); ctx.lineTo(p0.x, p0.y - d * 0.2);
      ctx.moveTo(p0.x, p0.y + d * 0.2); ctx.lineTo(p0.x, p0.y + arm);
    };
    let p0 = null;
    ctx.save();
    ctx.lineCap = "round";
    ctx.font = "700 13px ui-monospace, Menlo, monospace";
    for (const p of pointers) {
      const player = DuoSession.playerOf(p.id);
      if (!player || !Number.isFinite(p.x)) continue;
      p0 = p;
      ctx.globalAlpha = p.held ? 0.4 : 1;
      shape();
      ctx.strokeStyle = "rgba(0,0,0,.7)";
      ctx.lineWidth = 6.5;
      ctx.stroke();
      ctx.strokeStyle = player.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = player.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.stroke();
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.75)";
      ctx.strokeText(player.label, p.x + arm + 4, p.y - arm + 4);
      ctx.fillStyle = player.color;
      ctx.fillText(player.label, p.x + arm + 4, p.y - arm + 4);
    }
    ctx.restore();
  }

  // ------------------------------------------------------- game controls
  function newGame() {
    const g = game();
    if (!g || !DuoSession.started) return;
    agree.clear();
    attention.clear();
    g.restart();
    if (window.DataCollection) DataCollection.newPart("game");
  }
  function pauseGame() { const g = game(); if (g && g.started) g.pause(); }
  function muteGame() { const g = game(); if (g) g.mute(); }

  document.getElementById("dhNewGame").onclick = newGame;
  document.getElementById("dhPause").onclick = pauseGame;
  document.getElementById("dhMute").onclick = muteGame;

  document.getElementById("slider-hold").oninput = (e) => {
    HOLD_SEC = Number(e.target.value);
    document.getElementById("tv-hold").textContent = HOLD_SEC ? `${HOLD_SEC.toFixed(2)}s` : "instant";
  };
  document.getElementById("select-needed").onchange = (e) => {
    NEEDED = Number(e.target.value);
    document.getElementById("tv-needed").textContent = String(NEEDED);
  };
  // Takes effect from the next wave: a duck in flight keeps its speed.
  document.getElementById("slider-pace").oninput = (e) => {
    const pct = Number(e.target.value);
    document.getElementById("tv-pace").textContent = pct === 100 ? "original" : `${pct}% of original`;
    window.DuckHuntConfig.pace = pct / 100;
    const g = game();
    if (g) g.pace = pct / 100;
  };
  document.getElementById("slider-assist").oninput = (e) => {
    GAZE_ASSIST_RADIUS = Number(e.target.value);
    document.getElementById("tv-assist").textContent = `${GAZE_ASSIST_RADIUS}px`;
  };

  // The bundle may still be loading its sprites when START is pressed.
  function whenGameReady(fn) {
    const g = game();
    if (g && g.stage) return fn(g);
    window.addEventListener("duckhunt-ready", (e) => fn(e.detail.game), { once: true });
  }

  DuoSession.init({
    app: "duck-hunt",
    partLabel: "game",
    players: PLAYERS,
    title: "duck hunt",
    hintRows: () => [
      { keys: "both look", does: "shoot the duck" },
      { keys: "r / space", does: "new game" },
      { keys: "p", does: "pause" }, { keys: "u", does: "sound" },
    ],
    onStart: () => whenGameReady((g) => g.begin()),
    onKey: (e) => {
      const k = e.key;
      if (k === "r" || k === "R") newGame();
      if (k === "p" || k === "P") pauseGame();
      if (k === "u" || k === "U") muteGame();
      // The game's own "play again" is a click; space does it without the mouse.
      if (k === " " && game() && game().over) { e.preventDefault(); newGame(); }
    },
  });

  window.DuckHuntGaze = {
    state: () => ({ started: DuoSession.started, simMode: DuoSession.simMode, NEEDED, HOLD_SEC, agree: [...agree], focus: [...focus] }),
    newGame,
  };
})();
