// Explicit calibration with targets the visitor looks at, for experiences that
// MEASURE where people look (LIVE GAZE), where MEDUSA's implicit calibration
// (auto-calibrate.js) cannot work: an arbitrary image has no small, isolated,
// unambiguous targets to learn from — and learning from what is "probably"
// looked at (faces, contrast) would pull the data toward that assumption, so
// the analysis would end up confirming it.
//
// What is corrected: a constant offset per pair of glasses, in screen px —
// where the glasses sit on this face, this wearer's eyes, the Companion app's
// offset set for someone else. Measured, Neon's own bias is that kind of
// error; a single offset fixes most of it.
//
// HOW A TARGET IS JUDGED
//
// A fixed timer would record whatever the visitor happened to be doing —
// looking late, looking away, blinking. Instead each target waits: a player's
// RAW gaze must settle (stay within a small spread for SETTLE_MS) near it, and
// only that settled position is used. The target then "turns to stone" and the
// next appears. A target completes once every player currently looking at THIS
// screen has settled on it, or after a timeout — and if nobody is looking at
// this screen at all, the calibration here stops rather than holding the image
// hostage for a visitor who is at another screen.
//
// The offset is the MEDIAN of the per-target residuals: one target looked at
// sloppily cannot drag it. Its spread is reported as the calibration's
// consistency, so a bad calibration is visible rather than silently applied.
(function () {
  const SETTLE_MS = 600;        // gaze must stay put this long on a target
  const MIN_SAMPLES = 8;        // …with at least this many samples
  const SPREAD_FRAC = 0.025;    // max spread while settled, share of the target area width
  const SPREAD_MIN_PX = 22;
  const TIMEOUT_MS = 7000;      // per target, when nobody has settled on it
  const GRACE_MS = 2500;        // once one player has, the others get this long
  const PRESENT_MS = 600;       // a player seen this recently is "looking here"
  const STONE_MS = 380;         // petrify animation between targets
  const MAX_OFFSET = 260;       // px: beyond this it is not looking, it is elsewhere

  // ------------------------------------------------------------ offsets
  // One offset per player id. Deliberately NOT saved across page loads: in an
  // installation the next person wearing the glasses is someone else, and
  // their correction must come from their own calibration, never from the
  // previous visitor's. Windows of the same session share offsets through the
  // experience's BroadcastChannel (the caller relays them; see adopt()).
  const offsets = new Map();    // id -> { x, y, spread, n, at, here }

  function apply(pointers) {
    return pointers.map((p) => {
      const o = offsets.get(p.id);
      if (!o) return p;
      return {
        ...p,
        x: p.x + o.x, y: p.y + o.y,
        rawX: (p.rawX ?? p.x) + o.x, rawY: (p.rawY ?? p.y) + o.y,
        uncalX: p.rawX ?? p.x, uncalY: p.rawY ?? p.y,   // the tracker's own word
        calibX: o.x, calibY: o.y,
      };
    });
  }

  // ------------------------------------------------------------ session
  // targets: [{x, y}] in screen px. radius: how far (px) settled gaze may be
  // from a target and still count as looking at it — must exceed the bias
  // being measured, and stay well under the spacing between targets.
  function Session({ targets, radius, areaW, mode = "full", onDone }) {
    this.targets = targets;
    this.radius = radius;
    this.spread = Math.max(SPREAD_MIN_PX, SPREAD_FRAC * areaW);
    this.mode = mode;
    this.onDone = onDone;
    this.i = 0;
    this.phase = "look";         // "look" | "stone" | "done"
    this.phaseAt = performance.now();
    this.buf = new Map();        // id -> [{t, x, y}]
    this.seen = new Map();       // id -> last time seen on this screen
    this.residuals = new Map();  // id -> [{dx, dy}]
    this.doneFor = new Set();    // ids settled on the current target
    this.anyoneThisTarget = false;
    this.firstSettledAt = null;
    this.summary = null;
  }

  Session.prototype.current = function () { return this.targets[this.i] || null; };

  // pointers: UNCORRECTED (straight from Tracking.update), already filtered to
  // this experience's players and with held/stale pointers removed.
  Session.prototype.update = function (now, pointers) {
    if (this.phase === "done") return;
    if (this.phase === "stone") {
      if (now - this.phaseAt >= STONE_MS) this._next(now);
      return;
    }
    const t = this.current();
    for (const p of pointers) {
      const x = p.rawX ?? p.x, y = p.rawY ?? p.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      this.seen.set(p.id, now);
      this.anyoneThisTarget = true;
      if (this.doneFor.has(p.id)) continue;
      const b = this.buf.get(p.id) || [];
      b.push({ t: now, x, y });
      while (b.length && now - b[0].t > SETTLE_MS) b.shift();
      this.buf.set(p.id, b);
      if (b.length < MIN_SAMPLES || now - b[0].t < SETTLE_MS * 0.9) continue;
      const mx = b.reduce((s, q) => s + q.x, 0) / b.length;
      const my = b.reduce((s, q) => s + q.y, 0) / b.length;
      if (b.some((q) => Math.hypot(q.x - mx, q.y - my) > this.spread)) continue;   // still moving
      // Near THIS target — judged with the previous offset too, so a
      // recalibration still recognises a visitor whose bias is large.
      const prev = offsets.get(p.id);
      const dRaw = Math.hypot(t.x - mx, t.y - my);
      const dPrev = prev ? Math.hypot(t.x - (mx + prev.x), t.y - (my + prev.y)) : Infinity;
      if (Math.min(dRaw, dPrev) > this.radius) continue;
      const r = this.residuals.get(p.id) || [];
      r.push({ dx: t.x - mx, dy: t.y - my });
      this.residuals.set(p.id, r);
      this.doneFor.add(p.id);
      if (this.firstSettledAt == null) this.firstSettledAt = now;
    }

    const present = [...this.seen].filter(([, at]) => now - at < PRESENT_MS).map(([id]) => id);
    const allSettled = present.length > 0 && present.every((id) => this.doneFor.has(id));
    // A second visitor who is not taking part must not hold every target
    // for the full timeout: once someone has settled, the rest get a grace.
    const graceOver = this.firstSettledAt != null && now - this.firstSettledAt > GRACE_MS;
    const timedOut = now - this.phaseAt > TIMEOUT_MS;
    if (allSettled || graceOver) { this.phase = "stone"; this.phaseAt = now; return; }
    if (timedOut) {
      // Nobody looked at this screen during the whole target: they are at
      // another screen. Stop here instead of cycling empty targets.
      if (!this.anyoneThisTarget) { this._finish(now); return; }
      this._next(now);
    }
  };

  Session.prototype._next = function (now) {
    this.i += 1;
    this.doneFor.clear();
    this.buf.clear();
    this.anyoneThisTarget = false;
    this.firstSettledAt = null;
    this.phase = "look";
    this.phaseAt = now;
    if (this.i >= this.targets.length) this._finish(now);
  };

  Session.prototype._finish = function (now) {
    this.phase = "done";
    const summary = [];
    for (const [id, rs] of this.residuals) {
      const need = this.mode === "check" ? 1 : 2;
      if (rs.length < need) {
        // A full calibration that failed for this player must not leave an
        // older correction in place, which may be someone else's.
        if (this.mode === "full") offsets.delete(id);
        summary.push({ id, ok: false, n: rs.length });
        continue;
      }
      const med = (a) => { const s = [...a].sort((u, v) => u - v); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
      let x = med(rs.map((r) => r.dx)), y = med(rs.map((r) => r.dy));
      const spread = med(rs.map((r) => Math.hypot(r.dx - x, r.dy - y)));
      const prev = offsets.get(id);
      if (this.mode === "check" && prev) {
        // One target is one noisy measurement: move halfway toward it.
        x = prev.x + 0.5 * (x - prev.x);
        y = prev.y + 0.5 * (y - prev.y);
      }
      const mag = Math.hypot(x, y);
      if (mag > MAX_OFFSET) {
        if (this.mode === "full") offsets.delete(id);
        summary.push({ id, ok: false, n: rs.length, tooBig: Math.round(mag) });
        continue;
      }
      const drift = prev ? Math.hypot(x - prev.x, y - prev.y) : null;
      offsets.set(id, { x, y, spread: this.mode === "check" && prev ? prev.spread : spread, n: rs.length, at: Date.now(), here: true });
      summary.push({ id, ok: true, x, y, spread, n: rs.length, drift });
    }
    this.summary = summary;
    if (this.onDone) this.onDone(summary);
  };

  // Draws the current target: an eye that looks back, turning to stone once
  // everyone here has settled on it. ctx is a 2D canvas context.
  Session.prototype.draw = function (ctx, now) {
    if (this.phase === "done") return;
    const t = this.current();
    if (!t) return;
    const r = Math.max(14, this.radius * 0.22);
    const k = this.phase === "stone" ? Math.min(1, (now - this.phaseAt) / STONE_MS) : 0;
    const pulse = this.phase === "look" ? 1 + 0.06 * Math.sin(now / 160) : 1;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.fillStyle = `rgb(${Math.round(240 - 120 * k)}, ${Math.round(236 - 116 * k)}, ${Math.round(228 - 108 * k)})`;
    ctx.beginPath(); ctx.arc(0, 0, r * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = k ? `rgba(60,60,60,${1 - 0.6 * k})` : "#111";
    ctx.beginPath(); ctx.arc(0, 0, r * 0.38, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(-r * 0.12, -r * 0.12, r * 0.09, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  window.GazeTargetCalibration = {
    Session,
    apply,
    offsetFor(id) { return offsets.get(id) || null; },
    all() { return [...offsets.entries()].map(([id, o]) => ({ id, ...o })); },
    // Adopt an offset learned on another screen — only for players with no
    // calibration of their own on this one this session.
    adopt(id, o) {
      const mine = offsets.get(id);
      if (mine && mine.here) return false;
      offsets.set(id, { ...o, here: false });
      return true;
    },
    clear(id) { if (id == null) offsets.clear(); else offsets.delete(id); },
  };
})();
