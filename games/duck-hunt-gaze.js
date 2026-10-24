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
//   both on it        the cross closes to red; held for HOLD seconds, it fires
//
// The hold is short (0.3s) and only stops a gaze sweeping across a duck the
// other player happens to be on from counting as agreement.
(function () {
  // ------------------------------------------------------------ p5 globals
  // Tracking's mouse and arrow-key stand-in was written for p5 sketches and
  // reads p5's globals. This page has no p5, so it supplies the five it uses.
  const keysDown = new Set();
  window.LEFT_ARROW = 37; window.UP_ARROW = 38; window.RIGHT_ARROW = 39; window.DOWN_ARROW = 40;
  window.mouseX = innerWidth / 2; window.mouseY = innerHeight / 2;
  window.width = innerWidth; window.height = innerHeight;
  window.keyIsDown = (code) => keysDown.has(code);
  window.addEventListener("mousemove", (e) => { window.mouseX = e.clientX; window.mouseY = e.clientY; });
  window.addEventListener("keydown", (e) => {
    keysDown.add(e.keyCode);
    // Arrows steer P2 in a mouse test; they must not scroll anything.
    if (e.keyCode >= 37 && e.keyCode <= 40) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keysDown.delete(e.keyCode));
  window.addEventListener("blur", () => keysDown.clear());
  window.addEventListener("resize", () => { window.width = innerWidth; window.height = innerHeight; });

  // ------------------------------------------------------------- settings
  const PRECISE_POINTER_IDS = new Set(["mouse", "sim2"]);
  let HOLD_SEC = 0.3;          // both on the duck this long → shot
  let NEEDED = 2;              // players who must agree
  let GAZE_ASSIST_RADIUS = 170;
  // Agreement drains faster than it builds, so a broken look starts over
  // almost at once rather than finishing on the next brief overlap.
  const DECAY = 3;

  let started = false;
  let simMode = false;
  let showTarget = true;

  const game = () => window.DuckHuntGame || null;

  // pointerId -> player. "mouse"/"sim2" are added for a mouse test.
  const byPointer = {};
  PLAYERS.forEach((p) => (byPointer[`player-${p.id}`] = p));
  const SIM_POINTER_IDS = ["mouse", "sim2"];

  // ------------------------------------------------------------ boot card
  function renderBootCmd() {
    const neon = GazeAggregator.players().filter((p) => p.source === "neon");
    const box = document.getElementById("mpBootCmd");
    if (!neon.length) { box.style.display = "none"; return; }
    box.style.display = "";
    const lines = neon.map(
      (p) => `<b>#</b> ${p.label}\n~/dev/medusa-bridge-venv/bin/python bridge/neon_bridge.py --port ${p.port} --address PHONE_IP`
    ).join("\n\n");
    box.innerHTML =
      `<b># each bridge must be pinned to ITS OWN phone with --address</b>\n<b># easiest: double-click Start PetrifEye.command, which finds and pins each phone</b>\n\n${lines}`;
  }

  // WebGazer is one camera watching one face: at most one webcam player.
  function renderSources(list) {
    const webcamTaken = list.some((p) => p.source === "webcam");
    document.getElementById("mpSrcs").innerHTML = list.map((p) => {
      const camOpt = (p.source === "webcam" || !webcamTaken)
        ? `<option value="webcam"${p.source === "webcam" ? " selected" : ""}>webcam (WebGazer)</option>`
        : `<option value="webcam" disabled>webcam — taken by another player</option>`;
      const cls = p.live ? "live" : p.state === "offline" ? "err" : "warn";
      const st = p.live ? "ready"
        : p.source === "webcam" ? (p.detail || p.state)
        : p.streaming && p.markers != null ? `${p.markers}/4 markers`
        : (p.detail || p.state);
      return `<div class="mp-src">
        <span class="who" style="color:${p.color}">${p.label}</span>
        <select data-player="${p.id}">
          <option value="neon"${p.source === "neon" ? " selected" : ""}>neon glasses · port ${p.port}</option>
          ${camOpt}
        </select>
        <span class="st ${cls}">${st}</span>
      </div>`;
    }).join("");

    document.getElementById("mpSrcs").querySelectorAll("select").forEach((sel) => {
      sel.onchange = (e) => {
        GazeAggregator.setSource(Number(e.target.dataset.player), e.target.value);
        calibratedWebcam = false;
      };
    });
  }

  function renderBootState(list) {
    const el = document.getElementById("mpBootState");
    const btn = document.getElementById("mpStart");
    // Ready means the bridge has gaze from the phone, not that mapped gaze has
    // arrived: the tags it needs are on this screen, under the card.
    const ready = list.filter((p) => p.streaming).length;

    el.innerHTML = list.map((p) => {
      let cls, txt;
      if (p.live) {
        cls = "live"; txt = "gaze mapped — ready";
      } else if (p.streaming) {
        cls = "warn";
        const m = p.markers;
        txt = m != null
          ? `${m}/4 markers — ${m >= 3 ? "nearly there, hold still" : "normal before start: the tags appear once the game starts"}`
          : (p.detail || "connected");
      } else {
        cls = p.state === "offline" ? "err" : "warn";
        txt = p.detail || p.state;
      }
      return `<span style="color:${p.color}">${p.label}</span> · port ${p.port} — <span class="mp-state ${cls}">${txt}</span>`;
    }).join("<br>");

    btn.disabled = ready === 0;
    btn.textContent = ready === 0 ? "waiting for bridges"
      : ready < list.length ? `start with ${ready} of ${list.length}` : "start";
  }

  // Connection trouble only: a dead pointer explained, never a status line
  // sitting on the game while everyone is tracked.
  function renderPanel(list) {
    if (simMode) { document.getElementById("mpPanel").innerHTML = ""; return; }
    document.getElementById("mpPanel").innerHTML = list.filter((p) => !p.live).map((p) => {
      const cls = p.state === "offline" ? "err" : "warn";
      const txt = p.streaming && p.markers != null ? `${p.markers}/4 markers`
        : p.streaming ? "look at the screen" : "disconnected";
      return `<div class="mp-row">
        <div class="mp-dot" style="background:${p.color}"></div>
        <div class="mp-name" style="color:${p.color}">${p.label}</div>
        <div class="mp-state ${cls}">${txt}</div>
      </div>`;
    }).join("");
  }

  // ------------------------------------------------------ webcam calibration
  // Same 3x3, four-clicks-a-dot grid as MEDUSA: WebGazer's regression is
  // untrained until it has seen clicks paired with gaze.
  let calibratedWebcam = false;
  const CAL_COLS = 3, CAL_ROWS = 3, CAL_CLICKS = 4;

  function runWebcamCalibration() {
    return new Promise((resolve) => {
      const layer = document.getElementById("mpCal");
      const msg = document.getElementById("mpCalMsg");
      layer.classList.add("on");
      const pts = [];
      for (let r = 0; r < CAL_ROWS; r++)
        for (let c = 0; c < CAL_COLS; c++)
          pts.push({ fx: (c + 0.5) / CAL_COLS, fy: (r + 0.5) / CAL_ROWS });

      let i = 0;
      const showPoint = () => {
        layer.querySelectorAll(".mp-cal-dot").forEach((d) => d.remove());
        if (i >= pts.length) {
          layer.classList.remove("on");
          calibratedWebcam = true;
          resolve();
          return;
        }
        let clicks = 0;
        const dot = document.createElement("button");
        dot.className = "mp-cal-dot";
        dot.style.left = `${pts[i].fx * 100}%`;
        dot.style.top = `${pts[i].fy * 100}%`;
        dot.innerHTML = `<span>${CAL_CLICKS}</span>`;
        dot.onclick = (ev) => {
          GazeAggregator.recordCalibrationClick(ev.clientX, ev.clientY);
          clicks += 1;
          dot.querySelector("span").textContent = String(CAL_CLICKS - clicks);
          if (clicks >= CAL_CLICKS) { i += 1; showPoint(); }
        };
        layer.appendChild(dot);
        msg.textContent = `look at the dot and click it — point ${i + 1} of ${pts.length}`;
      };
      showPoint();
    });
  }

  // ---------------------------------------------------------------- markers
  // The four tag squares in screen pixels, empty when no tags are drawn.
  // Ducks never pick a destination inside one (Stage.isBlocked reads this),
  // since a duck under a tag is a duck neither player can see.
  function markerRects() {
    if (!(window.Markers && Markers.tagsDrawn)) return [];
    const s = Markers.size, m = Markers.margin;
    const W = innerWidth, H = innerHeight;
    return [
      { x: m, y: m, w: s, h: s },
      { x: W - m - s, y: m, w: s, h: s },
      { x: W - m - s, y: H - m - s, w: s, h: s },
      { x: m, y: H - m - s, w: s, h: s },
    ];
  }
  window.DuckHuntBlocked = markerRects;

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
    if (!started) return;

    const g = game();
    const pointers = Tracking.update();
    const targets = g && g.started && !g.paused ? g.duckTargets() : [];

    const gazeMode = pointers.some((p) => !PRECISE_POINTER_IDS.has(p.id));
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
      const player = byPointer[p.id];
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
    if (showTarget) drawPointers(shown);
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
      const player = byPointer[p.id];
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

  // ------------------------------------------------------------- chrome
  function setTuningVisible(on) {
    document.getElementById("tuning-panel").classList.toggle("tuning-panel-hidden", !on);
  }
  function toggleTuning() {
    setTuningVisible(document.getElementById("tuning-panel").classList.contains("tuning-panel-hidden"));
  }
  document.getElementById("mpGear").onclick = toggleTuning;

  const GEAR_IDLE_MS = 3000;
  let gearIdleTimer = null;
  function wakeGear() {
    const gear = document.getElementById("mpGear");
    gear.classList.remove("idle");
    clearTimeout(gearIdleTimer);
    gearIdleTimer = setTimeout(() => {
      const panel = document.getElementById("tuning-panel");
      if (!panel.classList.contains("tuning-panel-hidden")) return wakeGear();
      gear.classList.add("idle");
    }, GEAR_IDLE_MS);
  }
  window.addEventListener("mousemove", wakeGear);
  window.addEventListener("mousedown", wakeGear);

  function setTargetVisible(on) {
    showTarget = !!on;
    document.getElementById("toggle-target").checked = showTarget;
  }
  function setAssist(on) {
    if (window.GazeAssist) GazeAssist.setEnabled(on);
    document.getElementById("toggle-assist").checked = !!on;
  }
  function setAutoCalibrate(on) {
    if (window.GazeAutoCalibrate) GazeAutoCalibrate.setEnabled(on);
    document.getElementById("toggle-autocal").checked = !!on;
  }
  function setMarkers(on) {
    if (!window.Markers) return;
    on ? Markers.show() : Markers.hide();
  }
  function newGame() {
    const g = game();
    if (!g || !started) return;
    agree.clear();
    attention.clear();
    g.restart();
  }
  function pauseGame() { const g = game(); if (g && g.started) g.pause(); }
  function muteGame() { const g = game(); if (g) g.mute(); }

  document.getElementById("toggle-target").onchange = (e) => setTargetVisible(e.target.checked);
  document.getElementById("toggle-assist").onchange = (e) => setAssist(e.target.checked);
  document.getElementById("toggle-autocal").onchange = (e) => setAutoCalibrate(e.target.checked);
  document.getElementById("toggle-markers").onchange = (e) => setMarkers(e.target.checked);
  document.getElementById("dhNewGame").onclick = newGame;
  document.getElementById("dhPause").onclick = pauseGame;
  document.getElementById("dhMute").onclick = muteGame;

  document.getElementById("slider-hold").oninput = (e) => {
    HOLD_SEC = Number(e.target.value);
    document.getElementById("tv-hold").textContent = `${HOLD_SEC.toFixed(2)}s`;
  };
  document.getElementById("select-needed").onchange = (e) => {
    NEEDED = Number(e.target.value);
    document.getElementById("tv-needed").textContent = String(NEEDED);
  };
  // Takes effect from the next wave: a duck in flight keeps its speed.
  document.getElementById("slider-slow").oninput = (e) => {
    const v = Number(e.target.value);
    document.getElementById("tv-slow").textContent = v ? `−${v}` : "original";
    window.DuckHuntConfig.slowdown = v;
    const g = game();
    if (g) g.slowdown = v;
  };
  document.getElementById("slider-assist").oninput = (e) => {
    GAZE_ASSIST_RADIUS = Number(e.target.value);
    document.getElementById("tv-assist").textContent = `${GAZE_ASSIST_RADIUS}px`;
  };

  // Marker size goes through the aggregator, so the tags and every bridge's
  // surface geometry move together.
  const markerSlider = document.getElementById("slider-marker");
  function showMarkerSize(px) {
    document.getElementById("tv-marker").textContent = `${px}px`;
    if (Number(markerSlider.value) !== px) markerSlider.value = px;
  }
  markerSlider.oninput = (e) => {
    const applied = GazeAggregator.setMarkerSize(Number(e.target.value));
    if (applied) showMarkerSize(applied);
  };
  window.addEventListener("markers-size", (e) => showMarkerSize(e.detail.size));
  window.addEventListener("load", () => { if (window.Markers && Markers.size) showMarkerSize(Markers.size); });
  window.addEventListener("markers-visibility", (e) => {
    document.getElementById("toggle-markers").checked = !!e.detail.shown;
  });

  document.getElementById("select-profile").onchange = (e) => {
    const v = e.target.value;
    if (window.GazeAssist) GazeAssist.useProfile(v || null);
    document.getElementById("tv-profile").textContent = v || "auto";
  };

  window.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === "s" || k === "S") { toggleTuning(); wakeGear(); }
    if (k === "g" || k === "G") setTargetVisible(!showTarget);
    if (k === "a" || k === "A") setAssist(!GazeAssist.isEnabled());
    if (k === "m" || k === "M") setMarkers(!(window.Markers && Markers.shown));
    if (k === "C") { if (window.GazeAutoCalibrate) GazeAutoCalibrate.reset(); }
    else if (k === "c") setAutoCalibrate(!GazeAutoCalibrate.isEnabled());
    if (!started) return;
    if (k === "r" || k === "R") newGame();
    if (k === "p" || k === "P") pauseGame();
    if (k === "u" || k === "U") muteGame();
    // The game's own "play again" is a click; space does it without the mouse.
    if (k === " " && game() && game().over) { e.preventDefault(); newGame(); }
  });

  let lastList = PLAYERS.map((p) => ({ ...p, state: "connecting", live: false }));
  window.addEventListener("gaze-players", (e) => {
    lastList = e.detail;
    if (started) renderPanel(lastList);
    else { renderSources(lastList); renderBootState(lastList); renderBootCmd(); }
  });

  // ---------------------------------------------------------------- start
  function goFullscreen() {
    try {
      if (document.fullscreenElement) return;
      const p = document.documentElement.requestFullscreen?.();
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* unsupported → play windowed */ }
  }

  // The bundle may still be loading its sprites when START is pressed.
  function whenGameReady(fn) {
    const g = game();
    if (g && g.stage) return fn(g);
    window.addEventListener("duckhunt-ready", (e) => fn(e.detail.game), { once: true });
  }

  function start(sim) {
    if (started) return;
    started = true;
    simMode = !!sim;
    goFullscreen();
    document.getElementById("mpBoot").classList.add("hidden");
    document.getElementById("mpPanel").style.display = "";
    document.getElementById("mpGear").style.display = "";
    wakeGear();
    renderPanel(lastList);

    if (sim) {
      // The aggregator must stop publishing first, or it keeps pushing an
      // empty pointer list over the top of the mouse.
      GazeAggregator.setPublishing(false);
      Tracking.releaseExternal();
      if (!Tracking.isSimSecondEnabled()) Tracking.toggleSimSecondPointer();
      SIM_POINTER_IDS.forEach((pid, i) => { if (PLAYERS[i]) byPointer[pid] = PLAYERS[i]; });
      if (window.Markers) Markers.hide();
    }

    if (window.ControlsHint) {
      ControlsHint.show(
        (sim ? [{ keys: "mouse", does: "P1's gaze" }, { keys: "arrows", does: "P2's gaze" }] : [])
          .concat([
            { keys: "both look", does: "shoot the duck" },
            { keys: "r / space", does: "new game" },
            { keys: "p", does: "pause" }, { keys: "u", does: "sound" },
            { keys: "g", does: "gaze target on/off" }, { keys: "s", does: "settings" },
          ]),
        "duck hunt"
      );
    }

    whenGameReady((g) => g.begin());
  }

  document.getElementById("mpStart").onclick = async () => {
    const cam = GazeAggregator.webcamPlayer();
    if (cam && !calibratedWebcam) {
      document.getElementById("mpBootInner").style.visibility = "hidden";
      await runWebcamCalibration();
      document.getElementById("mpBootInner").style.visibility = "";
    }
    start(false);
  };
  document.getElementById("mpSim").onclick = () => start(true);

  renderBootCmd();
  GazeAggregator.init({ players: PLAYERS });
  // Tags on during the boot card: it doubles as the framing step.
  if (window.Markers) Markers.show();

  if (new URLSearchParams(location.search).has("sim")) start(true);

  window.DuckHuntGaze = {
    state: () => ({ started, simMode, NEEDED, HOLD_SEC, agree: [...agree], focus: [...focus] }),
    newGame,
  };
})();
