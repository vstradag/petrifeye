// MAGNETIC POETRY — the point between your eyes writes.
//
// A short poem's words float loose on the screen. Neither player can pick one
// alone: the PEN is the midpoint between the two gazes, so a word is taken
// only when the two of you, between you, rest on it — both looking at it, or
// at two places either side of it. Take the words in the poem's order and the
// poem assembles at the top; a word out of order shakes and stays. When the
// last word lands the poem is shown whole, with its author, and read aloud.
//
// The poems (magnetic-poetry-poems.js) were chosen so the next word can
// usually be guessed — until the end turns somewhere you did not expect.
//
// The look follows Rafael Lozano-Hemmer's surveillance-and-light pieces: a
// black field and a measurement grid, words framed as detected objects with
// machine IDs, hairlines locking onto the pen, a confidence readout climbing as
// a word is acquired (Level of Confidence), and a last word that pulses like
// an incandescent bulb to a heartbeat (Pulse Room). Players are Okabe & Ito's
// orange and sky blue, safe for every common colour vision deficiency; amber
// is the one colour of light.
//
// Players, trackers and setup screens: shared/gaze/duo-session.js.
(function () {
  const C = {
    p1: "#E69F00", p2: "#56B4E9",
    amber: "#FFC36B", poem: "#FFF1DA", ink: "rgba(236,236,236,.9)",
    dim: "rgba(255,255,255,.3)", faint: "rgba(255,255,255,.12)",
  };
  const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const MONO = 'ui-monospace, Menlo, "SF Mono", monospace';

  // ------------------------------------------------------------- settings
  let DWELL_SEC = 0.9;         // the pen resting on a word this long takes it
  let CAPTURE = 70;            // px around a word that still counts, for gaze
  let NEEDED = 2;              // 2: the midpoint writes; 1: player 1 alone (solo test)
  let HINTS = true;
  let READ = "recorded";      // "recorded" | "computer" | "off" — see the voice section
  const HINT_AFTER = 15;       // s without progress before the next word glows
  const HINT_STRONG = 30;
  const NEXT_DELAY = 3.5;      // s after completion before "next" can be taken
  const AUTO_NEXT = 34;        // s after completion before the next poem anyway
  const FLIGHT_MS = 750;
  const SETTLE_MS = 1800;      // the finished poem gliding to the centre
  const BEAT = 0.94;           // s per heartbeat, ~64 bpm

  const canvas = document.getElementById("poetry");
  const ctx = canvas.getContext("2d");
  let W = innerWidth, H = innerHeight;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const pad = (n, w = 4) => String(Math.max(0, Math.round(n))).padStart(w, "0");

  // ---------------------------------------------------------------- poems
  // Words as printed, and as magnets: lowercase, without the punctuation,
  // which belongs to the finished poem and would give the order away.
  function tokenize(text) {
    const tokens = [];
    let pending = "";
    text.split("\n").forEach((line, li) => {
      const indent = line.match(/^ */)[0].length;
      const chunks = line.trim().split(/\s+/).flatMap((ch) => ch.split(/(?<=—)(?=\S)/));
      for (const ch of chunks) {
        const norm = ch.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
        if (!norm) {
          // Punctuation on its own (". . ." in Triad) joins the word before.
          const last = tokens[tokens.length - 1];
          if (last && last.line === li) last.display += " " + ch;
          else pending += ch;
          continue;
        }
        tokens.push({ display: pending + ch, norm, line: li, indent: tokens.some((t) => t.line === li) ? 0 : indent });
        pending = "";
      }
    });
    return tokens;
  }

  // ---------------------------------------------------------------- state
  // The short poems are the piece; the longer set is for players who have
  // the hang of it (settings → poems).
  let set = window.POEMS;
  let poemIndex = 0;
  let poem = null;             // { ...set[i], tokens }
  let magnets = [];            // floating words
  let flights = [];            // words on their way into the poem
  let phase = "idle";          // "idle" | "play" | "complete"
  let poemStart = 0, lastProgressAt = 0, completeAt = 0;
  let assembly = null, final = null;   // poem layouts
  let focusId = null;
  let mid = null;              // the pen: { x, y, held, sep }
  let nextMagnet = null;
  let introAt = null, lastPresentAt = performance.now();
  let lastFrame = performance.now();

  // ---------------------------------------------------------------- layout
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (poem) { layoutPoem(); scatter(); if (phase === "complete") final = layoutFinal(); }
  }

  // The widest a centred block can be between y0 and y1 without running under
  // a corner tag — only tags beside that band count, so the finished poem in
  // the middle of the screen is not shrunk for tags far above and below it.
  function freeWidth(y0, y1) {
    const beside = DuoSession.markerRects().filter((t) => t.y < y1 && t.y + t.h > y0);
    if (!beside.length) return W * 0.86;
    const inset = Math.max(...beside.map((t) => (t.x < W / 2 ? t.x + t.w : W - t.x))) + 24;
    return Math.max(W * 0.4, Math.min(W * 0.86, W - 2 * inset));
  }

  // Lay the poem out at `top`, as wide as the tags beside it allow.
  function layoutBand(fontPx, top, cap = W * 0.86) {
    const wide = layoutLines(fontPx, top, cap);
    const room = Math.min(cap, freeWidth(top, top + wide.height));
    return wide.blockW <= room ? wide : layoutLines(fontPx, top, room);
  }

  function layoutLines(fontPx, top, maxW) {
    let size = fontPx;
    for (let attempt = 0; attempt < 8; attempt++) {
      ctx.font = `300 ${size}px ${SANS}`;
      const space = ctx.measureText(" ").width;
      const lineH = size * 1.5;
      const lines = [];
      for (const t of poem.tokens) (lines[t.line] = lines[t.line] || []).push(t);
      const widths = lines.map((ln) =>
        ln.reduce((s, t, i) => s + ctx.measureText(t.display).width + (i ? space : 0), 0) + (ln[0].indent ? size * 1.2 : 0));
      const blockW = Math.max(...widths);
      if (blockW > maxW && attempt < 7) { size *= maxW / blockW * 0.98; continue; }
      const x0 = (W - blockW) / 2;
      const slots = [];
      lines.forEach((ln, li) => {
        let x = x0 + (ln[0].indent ? size * 1.2 : 0);
        for (const t of ln) {
          const w = ctx.measureText(t.display).width;
          slots.push({ x, y: top + li * lineH + size, w });
          x += w + space;
        }
      });
      return { slots, size, height: lines.length * lineH, x0, blockW };
    }
  }

  function layoutPoem() {
    assembly = layoutBand(clamp(H * 0.034, 18, 38), H * 0.1);
  }

  function layoutFinal() {
    const size = clamp(H * 0.052, 24, 62);
    const probe = layoutLines(size, 0, W * 0.8);
    return layoutBand(size, H * 0.4 - probe.height / 2, W * 0.8);
  }

  // The loose words, anywhere on the screen except the poem, the corner tags
  // and the status line, never touching each other. If they will not all fit
  // with room between them, the type steps down and they are placed again —
  // a word dropped anywhere would land on another.
  function scatter() {
    const words = magnets.length ? magnets : poem.tokens.map((t, i) => ({ id: `m${i}`, norm: t.norm }));
    let fs = clamp(H * 0.03, 17, 32);
    for (let attempt = 0; attempt < 7; attempt++) {
      if (place(words, fs, attempt === 6)) break;
      fs = Math.max(13, fs * 0.9);
    }
    for (const m of words) {
      m.phase = m.phase ?? Math.random() * 10;
      m.hex = m.hex ?? Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
      m.dwell = m.dwell || 0;
    }
    magnets = words;
  }

  function place(words, fs, force) {
    ctx.font = `300 ${fs}px ${SANS}`;
    const field = { x0: W * 0.04, x1: W * 0.96, y0: H * 0.075, y1: H - 118 };
    const top = assembly.slots[0].y - assembly.size;
    const blocked = DuoSession.markerRects().map((r) => ({ x: r.x - 18, y: r.y - 18, w: r.w + 36, h: r.h + 36 }))
      .concat([
        { x: assembly.x0 - 36, y: top - 24, w: assembly.blockW + 72, h: assembly.height + 56 },   // the poem
        { x: W / 2 - 280, y: H - 118, w: 560, h: 118 },                                          // status
      ]);
    const hit = (a, b, p) => a.x < b.x + b.w + p && a.x + a.w + p > b.x && a.y < b.y + b.h + p && a.y + a.h + p > b.y;
    const placed = [];
    // Longest first: they are the hardest to fit.
    const order = words.slice().sort((a, b) => b.norm.length - a.norm.length || Math.random() - 0.5);
    for (const m of order) {
      m.fs = fs;
      m.tw = ctx.measureText(m.norm).width;
      m.w = m.tw + 26; m.h = fs * 1.15 + 18;
      let ok = false;
      for (const gap of [28, 16]) {
        for (let tries = 0; tries < 500 && !ok; tries++) {
          const x = lerp(field.x0, field.x1 - m.w, Math.random());
          const y = lerp(field.y0, field.y1 - m.h, Math.random());
          const box = { x, y, w: m.w, h: m.h };
          if (placed.some((p) => hit(box, p, gap)) || blocked.some((b) => hit(box, b, 0))) continue;
          m.hx = x + m.w / 2; m.hy = y + m.h / 2; placed.push(box); ok = true;
        }
        if (ok) break;
      }
      if (!ok && !force) return false;
      if (!ok) {
        // Out of room even at the smallest type (a small screen behind big
        // tags): the spot that overlaps least, rather than any spot at all.
        const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
                                  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        let best = null, bestCost = Infinity;
        for (let tries = 0; tries < 600; tries++) {
          const box = { x: lerp(field.x0, field.x1 - m.w, Math.random()), y: lerp(field.y0, field.y1 - m.h, Math.random()), w: m.w, h: m.h };
          const grown = { x: box.x - 10, y: box.y - 10, w: box.w + 20, h: box.h + 20 };
          const cost = placed.reduce((c, p) => c + overlap(grown, p), 0) + blocked.reduce((c, b) => c + 4 * overlap(box, b), 0);
          if (cost < bestCost) { bestCost = cost; best = box; }
        }
        m.hx = best.x + m.w / 2; m.hy = best.y + m.h / 2; placed.push(best);
      }
    }
    return true;
  }

  function loadPoem(i) {
    poemIndex = (i + set.length) % set.length;
    poem = { ...set[poemIndex], tokens: tokenize(set[poemIndex].text) };
    const sel = document.getElementById("select-poem");
    if (sel) sel.value = String(poemIndex);
    magnets = []; flights = []; nextMagnet = null; final = null; focusId = null;
    phase = "play";
    poemStart = lastProgressAt = performance.now();
    stopReading();
    reading = recordingFor(poem);
    layoutPoem();
    scatter();
  }

  // ---------------------------------------------------------------- frame
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const t = now / 1000;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    drawGrid();
    if (!DuoSession.started || !poem) return;

    // The two gazes, and the pen between them.
    const byPlayer = [null, null];
    for (const p of Tracking.update()) {
      const player = DuoSession.playerOf(p.id);
      if (!player || !Number.isFinite(p.x)) continue;
      const i = PLAYERS.indexOf(player);
      if (i >= 0 && !byPlayer[i]) byPlayer[i] = p;
    }
    if (byPlayer.some((p) => p && !p.held)) lastPresentAt = now;
    mid = pen(byPlayer);
    const gaze = byPlayer.some((p) => p && !DuoSession.isPrecise(p.id));

    // What the pen is resting on.
    const targets = phase === "play" ? magnets.filter((m) => !m.flying && !(m.cooldownUntil > now))
      : phase === "complete" && nextMagnet && now - completeAt > NEXT_DELAY * 1000 ? [nextMagnet] : [];
    focusId = mid ? pick(mid, targets, gaze ? CAPTURE : 2) : null;

    for (const m of targets) {
      const on = focusId === m.id && !mid.held;
      const before = m.dwell;
      m.dwell = on ? m.dwell + dt : Math.max(0, m.dwell - dt * 2);
      if (on && before === 0) Sound.click();
      if (m.dwell >= DWELL_SEC) { m.dwell = 0; take(m, now); }
    }
    for (const m of magnets) if (!targets.includes(m)) m.dwell = Math.max(0, m.dwell - dt * 2);

    if (phase === "complete" && now - completeAt > AUTO_NEXT * 1000) loadPoem(poemIndex + 1);

    // Flights landing.
    flights = flights.filter((f) => {
      if (now - f.t0 < FLIGHT_MS) return true;
      const tok = poem.tokens[f.token];
      tok.placed = true; tok.landedAt = now;
      if (poem.tokens.every((x) => x.placed)) complete(now);
      return false;
    });

    draw(now, t, byPlayer);
  }

  // Player 1 and 2's midpoint — or, in the solo test, player 1 alone. A pen
  // made from a held (frozen) gaze is held too: drawn, but it writes nothing.
  function pen(P) {
    if (NEEDED === 1) {
      const p = P[0] || P[1];
      return p ? { x: p.x, y: p.y, held: !!p.held, sep: 0 } : null;
    }
    if (!P[0] || !P[1]) return null;
    return {
      x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2,
      held: !!(P[0].held || P[1].held),
      sep: Math.hypot(P[0].x - P[1].x, P[0].y - P[1].y),
    };
  }

  function boxOf(m, now) {
    const t = now / 1000;
    const shake = m.rejectAt && now - m.rejectAt < 450 ? Math.sin((now - m.rejectAt) * 0.09) * 7 * (1 - (now - m.rejectAt) / 450) : 0;
    const x = m.hx + Math.sin(t * 0.37 + m.phase) * 5 + shake;
    const y = m.hy + Math.cos(t * 0.29 + m.phase * 1.3) * 3.5;
    return { x: x - m.w / 2, y: y - m.h / 2, w: m.w, h: m.h, cx: x, cy: y };
  }

  const rectDist = (p, b) => Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));

  // The word nearest the pen, within reach; the word already being taken
  // keeps the lock unless another is clearly nearer, so jitter between two
  // neighbours cannot reset the count.
  function pick(p, targets, reach) {
    const now = performance.now();
    let best = null, bestD = Infinity, cur = null, curD = Infinity;
    for (const m of targets) {
      const d = rectDist(p, boxOf(m, now));
      if (d <= reach && d < bestD) { best = m; bestD = d; }
      if (m.id === focusId) { cur = m; curD = d; }
    }
    if (cur && curD <= reach * 1.35 && !(best && best !== cur && bestD < curD - 18)) return cur.id;
    return best ? best.id : null;
  }

  function take(m, now) {
    if (m === nextMagnet) { loadPoem(poemIndex + 1); return; }
    const k = poem.tokens.findIndex((x) => !x.claimed);
    const tok = poem.tokens[k];
    if (tok && tok.norm === m.norm) {
      tok.claimed = true;
      m.flying = true;
      const b = boxOf(m, now);
      flights.push({ m, token: k, t0: now, from: { x: b.cx - m.tw / 2, y: b.cy + m.fs * 0.35, fs: m.fs } });
      magnets = magnets.filter((x) => x !== m);
      lastProgressAt = now;
      Sound.place(k);
    } else {
      m.rejectAt = now;
      m.cooldownUntil = now + 900;
      Sound.reject();
    }
  }

  function complete(now) {
    phase = "complete";
    completeAt = now;
    final = layoutFinal();
    // "next" is itself a word, taken with the pen like any other.
    const fs = clamp(H * 0.028, 16, 28);
    ctx.font = `300 ${fs}px ${SANS}`;
    const tw = ctx.measureText("next →").width;
    nextMagnet = { id: "next", norm: "next →", fs, tw, w: tw + 26, h: fs * 1.15 + 18, hx: W / 2, hy: H - 168, phase: 0, hex: "NEXT", dwell: 0 };
    Sound.heartbeat(3);
    setTimeout(() => speak(poem), SETTLE_MS + 400);
  }

  // ---------------------------------------------------------------- voice
  // The finished poem is read aloud, then who wrote it. The reading is a
  // recording made once, ahead of time, with an ElevenLabs voice
  // (magnetic-poetry/make-voices.mjs) and shipped with the piece: a person's
  // voice rather than the machine's, and at the venue just a file — no network,
  // no key. A poem with no recording yet is simply not read, unless the
  // computer voice is chosen in settings.
  const VOICE_DIR = "magnetic-poetry/voice/";
  let voices = null;           // the recordings' manifest, once loaded
  let reading = null;          // <audio> for the current poem, preloaded
  fetch(VOICE_DIR + "manifest.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      voices = m && m.poems ? m : null;
      if (poem && !reading) reading = recordingFor(poem);
      const opt = document.querySelector('#select-read option[value="recorded"]');
      if (opt) opt.textContent = voices ? `recorded voice — ${voices.voice.name}` : "recorded voice (none made yet)";
    })
    .catch(() => {});

  // Must match slug() in magnetic-poetry/make-voices.mjs.
  function slug(title) {
    return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function recordingFor(p) {
    const entry = voices && voices.poems[slug(p.title)];
    if (!entry) return null;
    const a = new Audio(VOICE_DIR + entry.file);
    a.preload = "auto";
    return a;
  }

  function stopReading() {
    if (reading) { reading.pause(); reading.currentTime = 0; }
    if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  }

  function speak(p) {
    if (READ === "off" || Sound.muted || p !== poem) return;
    if (READ === "recorded") {
      if (!reading) reading = recordingFor(p);
      if (reading) { reading.currentTime = 0; reading.play().catch(() => {}); }
      return;
    }
    computerVoice(p);
  }

  // The fallback: the browser's own synthesis. macOS also ships joke voices
  // (Bad News, Bubbles, Zarvox …) that a plain "first English voice" would
  // happily pick on some machines.
  const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Fred|Good News|Jester|Junior|Kathy|Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/;
  function pickVoice() {
    const all = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang) && !NOVELTY.test(v.name));
    const prefer = ["Daniel", "Moira", "Karen", "Tessa", "Samantha", "Serena", "Rishi"];
    return prefer.map((n) => all.find((v) => v.name.startsWith(n))).find(Boolean) || all[0] || null;
  }

  function computerVoice(p) {
    if (!window.speechSynthesis) return;
    // Chrome drops a speak() issued in the same breath as cancel(), so cancel
    // only what is actually playing and queue the lines a moment later.
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    setTimeout(() => {
      if (p !== poem) return;
      const voice = pickVoice();
      const lines = p.text.split("\n").map((s) => s.trim().replace(/[“”"]/g, ""))
        .concat([p.translator ? `${p.title}. ${p.author}, translated by ${p.translator}.` : `${p.title}. ${p.author}.`]);
      for (const line of lines) {
        const u = new SpeechSynthesisUtterance(line);
        if (voice) u.voice = voice;
        u.rate = 0.82; u.pitch = 0.95; u.volume = 0.9;
        speechSynthesis.speak(u);
      }
    }, 120);
  }

  // ---------------------------------------------------------------- sound
  // Small and dry, like the relays and bulbs of the pieces this borrows from:
  // a click as a word is locked, a soft tone as it lands (rising through a
  // pentatonic scale as the poem grows), a low knock for a wrong word, and a
  // heartbeat when the poem is whole.
  const Sound = (() => {
    let ac = null, out = null, muted = false;
    const PENTA = [1, 9 / 8, 81 / 64, 3 / 2, 27 / 16];
    function env(node, t0, peak, attack, decay) {
      node.gain.setValueAtTime(0.0001, t0);
      node.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      node.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    }
    return {
      get muted() { return muted; },
      start() {
        if (ac) { ac.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC();
        out = ac.createGain(); out.gain.value = 0.7;
        const comp = ac.createDynamicsCompressor();
        out.connect(comp); comp.connect(ac.destination);
        const wake = () => ac.resume();
        addEventListener("pointerdown", wake); addEventListener("keydown", wake);
      },
      toggle() {
        muted = !muted;
        if (out) out.gain.setTargetAtTime(muted ? 0 : 0.7, ac.currentTime, 0.05);
        return muted;
      },
      click() {
        if (!ac) return;
        const t0 = ac.currentTime;
        const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.012), ac.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        const src = ac.createBufferSource(); src.buffer = buf;
        const hp = ac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2500;
        const g = ac.createGain(); g.gain.value = 0.12;
        src.connect(hp); hp.connect(g); g.connect(out); src.start(t0);
      },
      place(i) {
        if (!ac) return;
        const t0 = ac.currentTime;
        const f = 293.66 * Math.pow(2, Math.floor(i / 5) % 2) * PENTA[i % 5];
        for (const [type, mult, peak] of [["sine", 1, 0.14], ["triangle", 2, 0.03]]) {
          const o = ac.createOscillator(); o.type = type; o.frequency.value = f * mult;
          const g = ac.createGain(); env(g, t0, peak, 0.006, 1.4);
          o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + 1.5);
        }
      },
      reject() {
        if (!ac) return;
        const t0 = ac.currentTime;
        const o = ac.createOscillator(); o.type = "sine";
        o.frequency.setValueAtTime(95, t0); o.frequency.exponentialRampToValueAtTime(55, t0 + 0.15);
        const g = ac.createGain(); env(g, t0, 0.3, 0.004, 0.16);
        o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + 0.25);
      },
      heartbeat(n) {
        if (!ac) return;
        const t0 = ac.currentTime + 0.05;
        for (let k = 0; k < n; k++) {
          for (const [off, peak] of [[0, 0.5], [0.28, 0.32]]) {
            const s = t0 + k * BEAT + off;
            const o = ac.createOscillator(); o.type = "sine";
            o.frequency.setValueAtTime(62, s); o.frequency.exponentialRampToValueAtTime(38, s + 0.16);
            const g = ac.createGain(); env(g, s, peak, 0.008, 0.2);
            o.connect(g); g.connect(out); o.start(s); o.stop(s + 0.3);
          }
        }
      },
    };
  })();

  // ---------------------------------------------------------------- drawing
  function draw(now, t, P) {
    // While the finished poem is read, the tracking steps back: still there,
    // as it always is in this kind of work, but quiet enough to read through.
    const quiet = phase === "complete" ? 1 - 0.65 * clamp((now - completeAt) / SETTLE_MS, 0, 1) : 1;
    drawHeader();
    ctx.globalAlpha = quiet;
    if (mid) drawHairlines(mid);
    ctx.globalAlpha = 1;
    drawPoem(now, t);
    if (phase === "play") magnets.forEach((m) => drawMagnet(m, now));
    if (nextMagnet && phase === "complete" && now - completeAt > NEXT_DELAY * 1000) drawMagnet(nextMagnet, now);
    drawFlights(now);
    ctx.globalAlpha = quiet;
    drawGazes(P);
    if (mid) drawPen(mid, now);
    ctx.globalAlpha = 1;
    drawStatus(now);
    drawIntro(now, P);
  }

  function mono(size, color, spacing = 2) {
    ctx.font = `${size}px ${MONO}`;
    ctx.fillStyle = color;
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
  }
  function plain() { if ("letterSpacing" in ctx) ctx.letterSpacing = "0px"; }

  // A measurement grid, barely there.
  function drawGrid() {
    const step = 36;
    ctx.fillStyle = "rgba(255,255,255,.07)";
    for (let y = step; y < H; y += step) for (let x = step; x < W; x += step) ctx.fillRect(x, y, 1, 1);
  }

  function drawHeader() {
    ctx.textAlign = "center";
    mono(10, C.dim, 4);
    ctx.fillText(`MAGNETIC POETRY  ·  SHARED DICTATION  ·  POEM ${String(poemIndex + 1).padStart(2, "0")} / ${String(set.length).padStart(2, "0")}`, W / 2, H * 0.05);
    plain();
  }

  // Hairlines locked on the pen, across the whole field — stopping short of
  // the screen's edge, which in frame mode belongs to the tracking frame.
  function drawHairlines(p) {
    ctx.strokeStyle = p.held ? "rgba(255,255,255,.05)" : "rgba(255,255,255,.11)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, p.y); ctx.lineTo(W - 40, p.y);
    ctx.moveTo(p.x, 40); ctx.lineTo(p.x, H - 40);
    ctx.stroke();
  }

  function drawPoem(now, t) {
    const L = assembly;
    if (!L) return;
    const settle = phase === "complete" && final ? easeInOut(clamp((now - completeAt) / SETTLE_MS, 0, 1)) : 0;
    const size = lerp(L.size, final ? final.size : L.size, settle);
    ctx.textAlign = "left";
    ctx.font = `300 ${size}px ${SANS}`;
    const next = poem.tokens.findIndex((x) => !x.claimed);
    const lastIdx = poem.tokens.length - 1;

    poem.tokens.forEach((tok, i) => {
      const a = L.slots[i];
      const b = final ? final.slots[i] : a;
      const x = lerp(a.x, b.x, settle), y = lerp(a.y, b.y, settle);
      if (!tok.placed) {
        // Where a word is still missing: a point, and a caret on the next one.
        ctx.fillStyle = C.faint;
        ctx.fillRect(x + a.w / 2 - 1.5, y - size * 0.3, 3, 3);
        if (i === next && phase === "play" && Math.floor(now / 530) % 2 === 0) {
          ctx.fillStyle = C.amber;
          ctx.fillRect(x - 6, y - size * 0.85, 2, size);
        }
        return;
      }
      const glow = tok.landedAt ? clamp(1 - (now - tok.landedAt) / 1300, 0, 1) : 0;
      let color = C.poem, blur = 18 * glow;
      if (phase === "complete" && i === lastIdx) {
        // The last word — the turn — glows like a bulb on a heartbeat.
        const beat = heartbeat((now - completeAt) / 1000);
        color = mixHex("#FFF1DA", C.amber, 0.35 + 0.65 * beat);
        blur = 6 + 30 * beat;
      } else if (glow > 0) {
        color = mixHex("#FFF1DA", C.amber, glow);
      }
      ctx.save();
      ctx.shadowColor = C.amber; ctx.shadowBlur = blur;
      ctx.fillStyle = color;
      ctx.fillText(tok.display, x, y);
      ctx.restore();
    });

    if (phase === "complete" && final) drawAttribution(now, settle);
  }

  // lub-dub: a sharp beat and a softer one, every BEAT seconds.
  function heartbeat(s) {
    const ph = ((s % BEAT) + BEAT) % BEAT;
    return Math.max(Math.exp(-ph / 0.11), 0.7 * (ph > 0.28 ? Math.exp(-(ph - 0.28) / 0.11) : 0));
  }

  function drawAttribution(now, settle) {
    const a = clamp((now - completeAt - SETTLE_MS * 0.7) / 1200, 0, 1);
    if (a <= 0) return;
    const y = final.slots[final.slots.length - 1].y + final.size * 1.6;
    ctx.textAlign = "center";
    ctx.font = `300 italic ${Math.round(final.size * 0.5)}px ${SANS}`;
    ctx.fillStyle = `rgba(255,241,218,${0.85 * a})`;
    ctx.fillText(poem.subtitle ? `${poem.title} — ${poem.subtitle}` : poem.title, W / 2, y);
    mono(12, `rgba(255,195,107,${0.95 * a})`, 5);
    ctx.fillText(`${poem.author.toUpperCase()}   ${poem.dates}`, W / 2, y + final.size * 0.75);
    mono(10, `rgba(255,255,255,${0.35 * a})`, 3);
    const credit = poem.translator ? `TRANSLATED BY ${poem.translator.toUpperCase()}  ·  ` : "";
    ctx.fillText(`${credit}${poem.source.toUpperCase()}  ·  PUBLIC DOMAIN`, W / 2, y + final.size * 0.75 + 22);
    plain();
  }

  // A word as a detected object: corner brackets, a machine ID, and — while
  // the pen rests on it — brackets closing in and a confidence readout.
  function drawMagnet(m, now) {
    const b = boxOf(m, now);
    const progress = clamp(m.dwell / DWELL_SEC, 0, 1);
    const focused = focusId === m.id;
    const rejected = m.rejectAt && now - m.rejectAt < 1100;
    const idle = (now - lastProgressAt) / 1000;
    const hinted = HINTS && phase === "play" && idle > HINT_AFTER && isNext(m);
    const hintPulse = hinted ? 0.5 + 0.5 * Math.sin(now / 380) : 0;

    // Brackets.
    const inset = 7 * progress;
    const arm = 9;
    const bx = b.x + inset, by = b.y + inset, bw = b.w - 2 * inset, bh = b.h - 2 * inset;
    ctx.lineWidth = focused ? 1.5 : 1;
    ctx.strokeStyle = focused && progress > 0 ? mixHex("#8a8a8a", C.amber, progress)
      : hinted ? `rgba(255,195,107,${0.25 + 0.5 * hintPulse})` : "rgba(255,255,255,.3)";
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx + bw, by + bh, -1, -1], [bx, by + bh, 1, -1]]) {
      ctx.moveTo(cx, cy + sy * arm); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * arm, cy);
    }
    ctx.stroke();

    // The word.
    ctx.textAlign = "center";
    ctx.font = `300 ${m.fs}px ${SANS}`;
    ctx.fillStyle = rejected ? "rgba(236,236,236,.45)"
      : hinted && idle > HINT_STRONG ? mixHex("#ECECEC", C.amber, 0.4 + 0.4 * hintPulse)
      : focused ? mixHex("#ECECEC", C.amber, progress * 0.6) : C.ink;
    ctx.fillText(m.norm, b.cx, b.cy + m.fs * 0.35);

    // Label: ID at rest; confidence while being taken; the verdict after.
    ctx.textAlign = "left";
    if (rejected) {
      mono(9, "rgba(255,255,255,.55)", 2);
      ctx.fillText("NOT THE NEXT WORD", b.x, b.y - 6);
    } else if (focused && progress > 0) {
      mono(9, C.amber, 2);
      ctx.fillText(`ACQUIRING  ${pad(progress * 100, 3)}%`, b.x, b.y - 6);
    } else {
      mono(9, "rgba(255,255,255,.22)", 2);
      ctx.fillText(m.hex, b.x, b.y - 6);
    }
    plain();
  }

  const isNext = (m) => { const tok = poem.tokens.find((x) => !x.claimed); return tok && tok.norm === m.norm; };

  function drawFlights(now) {
    for (const f of flights) {
      const k = easeInOut(clamp((now - f.t0) / FLIGHT_MS, 0, 1));
      const slot = assembly.slots[f.token];
      const tok = poem.tokens[f.token];
      const size = lerp(f.from.fs, assembly.size, k);
      ctx.save();
      ctx.font = `300 ${size}px ${SANS}`;
      ctx.textAlign = "left";
      ctx.shadowColor = C.amber; ctx.shadowBlur = 20;
      ctx.fillStyle = mixHex("#ECECEC", C.amber, 0.8);
      ctx.fillText(k < 0.6 ? f.m.norm : tok.display, lerp(f.from.x, slot.x, k), lerp(f.from.y, slot.y, k));
      ctx.restore();
      mono(9, C.amber, 2);
      if (k < 0.5) ctx.fillText("MATCH", lerp(f.from.x, slot.x, k), lerp(f.from.y, slot.y, k) - size);
      plain();
    }
  }

  // Each gaze as a crosshair in its player's colour, with its coordinates;
  // a thin tether runs from each to the pen they make together.
  function drawGazes(P) {
    if (!DuoSession.showTarget) return;
    const base = ctx.globalAlpha;
    P.forEach((p, i) => {
      if (!p) return;
      const color = i === 0 ? C.p1 : C.p2;
      const a = (p.held ? 0.35 : 1) * base;
      if (mid && NEEDED === 2) {
        ctx.strokeStyle = `rgba(255,255,255,${0.22 * a})`;
        ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(mid.x, mid.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = a;
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 14, p.y); ctx.lineTo(p.x - 4, p.y); ctx.moveTo(p.x + 4, p.y); ctx.lineTo(p.x + 14, p.y);
      ctx.moveTo(p.x, p.y - 14); ctx.lineTo(p.x, p.y - 4); ctx.moveTo(p.x, p.y + 4); ctx.lineTo(p.x, p.y + 14);
      ctx.stroke();
      ctx.textAlign = "left";
      mono(9, color, 1);
      ctx.fillText(`P${i + 1} ${pad(p.x)}·${pad(p.y)}`, p.x + 10, p.y + 22);
      plain();
      ctx.globalAlpha = base;
    });
  }

  function drawPen(p, now) {
    ctx.strokeStyle = p.held ? "rgba(255,195,107,.35)" : C.amber;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = C.amber;
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    // Below the ring: above it is where a word's own label sits when the pen
    // is resting on one.
    ctx.textAlign = "left";
    mono(9, p.held ? "rgba(255,195,107,.45)" : C.amber, 2);
    const what = NEEDED === 2 ? `MIDPOINT  ${pad(p.x)}·${pad(p.y)}  Δ${pad(p.sep)}` : `PEN  ${pad(p.x)}·${pad(p.y)}`;
    ctx.fillText(p.held ? `${what}  · SIGNAL LOST` : what, p.x + 18, p.y + 30);
    plain();
  }

  function drawStatus(now) {
    const placed = poem.tokens.filter((x) => x.placed).length;
    const el = Math.floor(((phase === "complete" ? completeAt : now) - poemStart) / 1000);
    const parts = phase === "complete"
      ? [`COMPLETE`, `${poem.tokens.length} WORDS`, `${String(Math.floor(el / 60)).padStart(2, "0")}:${String(el % 60).padStart(2, "0")}`,
         now - completeAt > NEXT_DELAY * 1000 ? `LOOK TOGETHER AT  NEXT →` : ``]
      : [`WORD ${String(placed).padStart(2, "0")} / ${String(poem.tokens.length).padStart(2, "0")}`,
         mid && NEEDED === 2 ? `SEPARATION ${pad(mid.sep)} PX` : NEEDED === 1 ? `SOLO TEST` : `WAITING FOR TWO GAZES`,
         `${String(Math.floor(el / 60)).padStart(2, "0")}:${String(el % 60).padStart(2, "0")}`];
    ctx.textAlign = "center";
    mono(10, C.dim, 3);
    ctx.fillText(parts.filter(Boolean).join("   ·   "), W / 2, H - 76);
    plain();
  }

  // The rule, once at the start and whenever the field has been empty a while.
  function drawIntro(now, P) {
    if (introAt == null || (now - lastPresentAt > 15000 && now - introAt > 14000)) introAt = now;
    const el = (now - introAt) / 1000;
    const a = el < 1 ? el : el < 10 ? 1 : clamp(1 - (el - 10) / 2, 0, 1);
    if (a <= 0 || phase !== "play") return;
    ctx.textAlign = "center";
    mono(11, `rgba(255,195,107,${0.85 * a})`, 4);
    ctx.fillText(NEEDED === 2 ? "THE POINT HALFWAY BETWEEN YOUR TWO GAZES IS THE PEN" : "SOLO TEST · YOUR GAZE IS THE PEN", W / 2, H - 100);
    mono(10, `rgba(255,255,255,${0.45 * a})`, 3);
    ctx.fillText("TAKE THE WORDS IN THE POEM’S ORDER", W / 2, H - 100 + 18);
    plain();
  }

  function mixHex(a, b, k) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = (s) => Math.round(lerp((pa >> s) & 255, (pb >> s) & 255, clamp(k, 0, 1)));
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }

  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(frame);

  // ------------------------------------------------------------- controls
  const $ = (id) => document.getElementById(id);
  function toggleSound() {
    const muted = Sound.toggle();
    if (muted) stopReading();
    $("mpSound").textContent = muted ? "sound off (u)" : "sound (u)";
  }
  function shuffle() { if (phase === "play") scatter(); }
  $("mpNext").onclick = () => loadPoem(poemIndex + 1);
  $("mpShuffle").onclick = shuffle;
  $("mpSound").onclick = toggleSound;
  $("slider-dwell").oninput = (e) => {
    DWELL_SEC = Number(e.target.value);
    $("tv-dwell").textContent = `${DWELL_SEC.toFixed(1)}s`;
  };
  $("slider-capture").oninput = (e) => {
    CAPTURE = Number(e.target.value);
    $("tv-capture").textContent = `${CAPTURE}px`;
  };
  $("select-needed").onchange = (e) => { NEEDED = Number(e.target.value); introAt = null; };
  function listPoems() {
    $("select-poem").innerHTML = set.map((p, i) => `<option value="${i}">${String(i + 1).padStart(2, "0")} · ${p.title} — ${p.author}</option>`).join("");
  }
  listPoems();
  $("select-poem").onchange = (e) => loadPoem(Number(e.target.value));
  $("select-set").onchange = (e) => {
    set = e.target.value === "longer" ? window.POEMS_LONGER : window.POEMS;
    listPoems();
    if (DuoSession.started) loadPoem(0); else poemIndex = 0;
  };
  $("toggle-hints").onchange = (e) => { HINTS = e.target.checked; };
  $("select-read").onchange = (e) => {
    READ = e.target.value;
    stopReading();
    if (phase === "complete") speak(poem);
  };

  DuoSession.init({
    players: PLAYERS,
    title: "magnetic poetry",
    hintRows: (sim) => [
      { keys: "look together", does: "the midpoint is the pen" },
      ...(sim ? [{ keys: "s → players", does: "1 for a solo test" }] : []),
      { keys: "n", does: "next poem" }, { keys: "r", does: "shuffle words" },
      { keys: "u", does: "sound" },
    ],
    // Inside the START click, which is what lets the browser make sound. The
    // voice list loads lazily, so it is asked for now, long before it is needed.
    onStart: () => {
      Sound.start();
      if (window.speechSynthesis) speechSynthesis.getVoices();
      // Unlock <audio> inside the click, as for the AudioContext: a browser
      // may refuse play() later otherwise.
      new Audio().play().catch(() => {});
      introAt = null;
      loadPoem(poemIndex);
    },
    onKey: (e) => {
      if (e.key === "n" || e.key === "N") loadPoem(poemIndex + 1);
      if (e.key === "r" || e.key === "R") shuffle();
      if (e.key === "u" || e.key === "U") toggleSound();
    },
  });

  window.MagneticPoetry = {
    state: () => ({
      phase, poem: poem && poem.title, next: poem && (poem.tokens.find((x) => !x.claimed) || {}).norm,
      placed: poem ? poem.tokens.filter((x) => x.placed).length : 0, total: poem ? poem.tokens.length : 0,
      magnets: magnets.length, focus: focusId, mid: mid && { x: Math.round(mid.x), y: Math.round(mid.y), held: mid.held },
    }),
    magnetBoxes: () => magnets.map((m) => ({ norm: m.norm, ...boxOf(m, performance.now()) })),
    layouts: () => ({ assembly, final: layoutFinal() }),
    loadPoem,
  };
})();
