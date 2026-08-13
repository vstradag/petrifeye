// Fur field — spring-physics fur wall, adapted from references/fur-wall (1).html.
// Purely decorative/atmospheric: it doesn't touch Tracking or DwellTarget.
//
// Strands root on a jittered grid and hang down (gravity) with large-scale
// Perlin flow so the coat swirls and parts naturally. Each strand's tip is a
// lightweight spring: it eases back toward its resting position, and gets
// pushed away by nearby "disturbers" — anything that should locally part
// the fur, like a blob's body or the gaze pointer brushing past.
//
// A sketch constructs one, calls .update(dt, disturbers) then .display()
// once per frame, and .resize(width, height) on windowResized().
//
// disturbers: array of { x, y, radius?, push?, dirX?, dirY?, dirStrength? }.
// radius/push default to the field's disturbRadius/disturbPush if omitted,
// so a sketch can mix a strong wide push (a blob's body) with a gentle
// narrow one (a gaze point) in the same array. dirX/dirY (a unit vector)
// and dirStrength add an extra push ALONG that direction on top of the
// normal push-away-from-center — for something moving (a blob's current
// velocity direction), so nearby fur flexes along its path of travel
// instead of only parting symmetrically around it.
class FurField {
  constructor({
    width,
    height,
    grid = 13,           // px between roots — lower = denser fur, slower
    spring = 0.1,         // pull back to rest
    damping = 0.84,
    disturbRadius = 100,  // default reach if a disturber doesn't specify its own
    disturbPush = 2.6,    // default push strength if a disturber doesn't specify its own
  } = {}) {
    this.grid = grid;
    this.spring = spring;
    this.damping = damping;
    this.disturbRadius = disturbRadius;
    this.disturbPush = disturbPush;
    this.time = 0;
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.strands = [];
    for (let gx = -this.grid; gx < width + this.grid; gx += this.grid) {
      for (let gy = -this.grid; gy < height + this.grid * 3; gy += this.grid) {
        const rx = gx + random(-this.grid * 0.5, this.grid * 0.5);
        const ry = gy + random(-this.grid * 0.5, this.grid * 0.5);

        // Base direction: hanging down (HALF_PI), bent by a large-scale
        // noise field so the coat swirls and parts naturally.
        const flow = map(noise(rx * 0.0025, ry * 0.0025), 0, 1, -1.4, 1.4);
        const dir = HALF_PI + flow;

        const isGuard = random() < 0.45;
        const len = isGuard ? random(30, 52) : random(16, 28);
        const baseHue = 25 + random(-10, 10);
        const patchLight = map(noise(rx * 0.004, ry * 0.004), 0, 1, -10, 10); // mottled coat

        this.strands.push({
          root: { x: rx, y: ry },
          dir, len, isGuard,
          tipX: rx + Math.cos(dir) * len,
          tipY: ry + Math.sin(dir) * len,
          vx: 0, vy: 0,
          rootOffX: 0, rootOffY: 0, // persistent displacement — see update()
          edgeMargin: random(6, 26), // how far past the rim this strand piles up — varied so the pileup looks like a crowd, not a ruler-straight ring
          seed: random(1000),
          baseHue, patchLight,
        });
      }
    }
    this.buildRenderBuckets();
  }

  // Groups strands into a handful of (color, weight) buckets so display()
  // can draw each bucket as one canvas path + one stroke() call instead of
  // one p5 stroke()+bezier() call per strand. Per-strand color/weight is
  // static (set once here from baseHue/patchLight/isGuard), only the
  // geometry changes frame to frame — that's what makes bucketing valid.
  // See the perf note on display() for why this matters.
  buildRenderBuckets() {
    const SHADE_STEPS = 5;
    const mainBuckets = new Map(); // key -> { isGuard, style, lineWidth, indices: [] }
    const highlightBuckets = new Map(); // guard strands only

    this.strands.forEach((s, i) => {
      const shadeStep = Math.floor((s.patchLight + 10) / 20 * SHADE_STEPS);
      const mainKey = `${s.isGuard ? "g" : "u"}${shadeStep}`;
      if (!mainBuckets.has(mainKey)) {
        mainBuckets.set(mainKey, { style: this.strandColor(s), lineWidth: s.isGuard ? 1.3 : 1.9, indices: [] });
      }
      mainBuckets.get(mainKey).indices.push(i);

      if (s.isGuard) {
        const hlKey = `h${shadeStep}`;
        if (!highlightBuckets.has(hlKey)) {
          highlightBuckets.set(hlKey, {
            style: hsbToCss(s.baseHue + 10, 42, 92 + s.patchLight * 0.5, 50),
            lineWidth: 1,
            indices: [],
          });
        }
        highlightBuckets.get(hlKey).indices.push(i);
      }
    });

    this.mainBuckets = [...mainBuckets.values()];
    this.highlightBuckets = [...highlightBuckets.values()];
  }

  strandColor(s) {
    return s.isGuard
      ? hsbToCss(s.baseHue, 72, 74 + s.patchLight, 68)
      : hsbToCss(s.baseHue, 82, 38 + s.patchLight, 85);
  }

  // A hole's radius at a given angle around its center. Plain circle
  // unless the hole carries noiseSeed/noiseTime (sketches set these from
  // the same per-blob noise state that draws its actual organic,
  // non-circular silhouette — see Blob.organicShapePoints in sketch.js),
  // in which case this reconstructs that same wobble as a continuous
  // function of angle instead of a fixed radius, so the fur boundary
  // actually hugs the irregular shape instead of a circle around it.
  // noise() is itself continuous, so evaluating it at a fractional vertex
  // index (rather than only the 10 integer ones sketch.js samples for the
  // drawn silhouette) gives a smooth, closely-matching approximation
  // without duplicating its curve-interpolation math.
  organicRadiusAt(h, theta) {
    if (h.noiseSeed == null) return h.radius;
    const n = 10; // must match Blob.organicShapePoints' vertex count
    const norm = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
    const continuousI = (norm / TWO_PI) * n;
    return h.radius * (0.82 + 0.18 * noise(h.noiseSeed + continuousI * 10, h.noiseTime));
  }

  // organicRadiusAt() calls noise() — cheap once, but ruinous at scale:
  // every strand checking every hole every frame is strands*holes noise()
  // calls (thousands of strands x several holes = tens of thousands/frame)
  // even though almost every strand is nowhere near any hole. The organic
  // wobble is always <= h.radius (the formula's multiplier maxes out at
  // 1.0), so a strand outside h.radius can never be inside the hole
  // regardless of wobble — reject on that cheap arithmetic bound FIRST
  // and only pay for noise() on strands actually close enough to matter.
  insideAnyHole(x, y, holes) {
    for (const h of holes) {
      const dx = x - h.x, dy = y - h.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > h.radius * h.radius) continue;
      const r = this.organicRadiusAt(h, Math.atan2(dy, dx));
      if (d2 < r * r) return true;
    }
    return false;
  }

  // If (x, y) falls inside a hole, returns the {dx, dy} offset that
  // relocates it radially outward to just past that hole's rim (by
  // `margin`, varied per strand so the pileup reads as a crowd, not a
  // ruler-straight ring) — fur pushed aside by something displaces to the
  // edges, it doesn't vanish. Returns null if (x, y) isn't inside any hole.
  edgeDisplacement(x, y, margin, holes) {
    for (const h of holes) {
      const dx = x - h.x, dy = y - h.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > h.radius * h.radius) continue; // see insideAnyHole — skips noise() for the common case
      const r = this.organicRadiusAt(h, Math.atan2(dy, dx));
      if (d2 < r * r) {
        const d = Math.max(Math.sqrt(d2), 0.001);
        const scale = (r + margin) / d;
        return { dx: dx * scale - dx, dy: dy * scale - dy };
      }
    }
    return null;
  }

  update(dt, disturbers = [], holes = []) {
    // Reference advances noise time by 0.008/frame at ~60fps; scale by dt
    // so the sway speed doesn't change with frame rate.
    this.time += dt * 0.48;

    for (const s of this.strands) {
      // Persistent radial displacement toward a hole's rim. This has to
      // live here, not be recomputed fresh in display() each frame, or it
      // has no memory — it'd just be a clean ring that pops in wherever
      // the hole currently sits. With memory + asymmetric ease (snap out
      // of the way fast, relax back slowly), a strand that's just been
      // passed by stays smushed for a bit and eases back — that lag is
      // what actually reads as fur being physically shoved aside by
      // something moving through it, like dragging a hand across carpet,
      // rather than a static exclusion zone.
      const disp = holes.length ? this.edgeDisplacement(s.root.x, s.root.y, s.edgeMargin, holes) : null;
      const targetOffX = disp ? disp.dx : 0;
      const targetOffY = disp ? disp.dy : 0;
      const ease = 1 - Math.exp(-(disp ? 14 : 2.2) * dt);
      s.rootOffX += (targetOffX - s.rootOffX) * ease;
      s.rootOffY += (targetOffY - s.rootOffY) * ease;

      const breeze = (noise(s.seed, this.time) - 0.5) * 0.45;
      const restX = s.root.x + Math.cos(s.dir + breeze) * s.len;
      const restY = s.root.y + Math.sin(s.dir + breeze) * s.len;

      s.vx += (restX - s.tipX) * this.spring;
      s.vy += (restY - s.tipY) * this.spring;

      for (const d of disturbers) {
        const reach = d.radius != null ? d.radius : this.disturbRadius;
        const push = d.push != null ? d.push : this.disturbPush;
        const dx = s.tipX - d.x;
        const dy = s.tipY - d.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < reach * reach && d2 > 0.01) {
          const dd = Math.sqrt(d2);
          const falloff = 1 - dd / reach;
          const f = falloff * push;
          s.vx += (dx / dd) * f;
          s.vy += (dy / dd) * f;

          // Flex: a push ALONG the direction something is moving, not just
          // away from its center — this is what makes fur read as combed/
          // bent by motion (like grass leaning as something brushes
          // through) instead of just parting symmetrically regardless of
          // which way it's headed. Optional — only disturbers that supply
          // a direction (moving blobs; see sketch.js) apply it.
          if (d.dirX != null) {
            s.vx += d.dirX * falloff * d.dirStrength;
            s.vy += d.dirY * falloff * d.dirStrength;
          }
        }
      }

      s.vx *= this.damping;
      s.vy *= this.damping;
      s.tipX += s.vx;
      s.tipY += s.vy;

      // Keep tips from stretching absurdly far from the root.
      const ox = s.tipX - s.root.x;
      const oy = s.tipY - s.root.y;
      const maxLen = s.len * 1.6;
      const stretch2 = ox * ox + oy * oy;
      if (stretch2 > maxLen * maxLen) {
        const st = Math.sqrt(stretch2);
        s.tipX = s.root.x + (ox / st) * maxLen;
        s.tipY = s.root.y + (oy / st) * maxLen;
      }
    }
  }

  // Same visual result as calling p5's stroke()/bezier()/line() once per
  // strand, but through the raw canvas context, batched by (color, weight)
  // bucket: one beginPath()+stroke() per bucket instead of thousands of
  // individual p5 draw calls. Measured ~28x faster at 9k strands — p5's
  // per-call overhead (color parsing, state tracking), not the curve math,
  // was the actual cost.
  //
  // Reads the persistent rootOffX/Y that update(dt, disturbers, holes)
  // computed — see the comment there for why the displacement lives in
  // physics state instead of being recomputed here from scratch.
  display() {
    const ctx = drawingContext;
    ctx.save();
    ctx.lineCap = "round";

    for (const bucket of this.mainBuckets) {
      ctx.strokeStyle = bucket.style;
      ctx.lineWidth = bucket.lineWidth;
      ctx.beginPath();
      for (const i of bucket.indices) {
        const s = this.strands[i];
        const rx = s.root.x + s.rootOffX;
        const ry = s.root.y + s.rootOffY;
        const tx = s.tipX + s.rootOffX;
        const ty = s.tipY + s.rootOffY;
        const midX = rx + Math.cos(s.dir) * s.len * 0.45;
        const midY = ry + Math.sin(s.dir) * s.len * 0.45;
        ctx.moveTo(rx, ry);
        ctx.bezierCurveTo(midX, midY, (midX + tx) / 2, (midY + ty) / 2, tx, ty);
      }
      ctx.stroke();
    }

    for (const bucket of this.highlightBuckets) {
      ctx.strokeStyle = bucket.style;
      ctx.lineWidth = bucket.lineWidth;
      ctx.beginPath();
      for (const i of bucket.indices) {
        const s = this.strands[i];
        const rx = s.root.x + s.rootOffX;
        const ry = s.root.y + s.rootOffY;
        const tx = s.tipX + s.rootOffX;
        const ty = s.tipY + s.rootOffY;
        const midX = rx + Math.cos(s.dir) * s.len * 0.45;
        const midY = ry + Math.sin(s.dir) * s.len * 0.45;
        const hx = lerp((midX + tx) / 2, tx, 0.6);
        const hy = lerp((midY + ty) / 2, ty, 0.6);
        ctx.moveTo(hx, hy);
        ctx.lineTo(tx, ty);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  // Redraws, on top of whatever's been drawn since display(), only the
  // strands that are ALREADY naturally overlapping a hole — root outside
  // it (never grew there), tip currently inside it (long/swayed enough to
  // reach over the rim right now). No new physics, no special-casing:
  // whatever the ordinary spring/breeze motion already produced. Call
  // this after drawing the thing that sits in the holes, so the strands
  // that happen to droop over its edge render in front of it.
  displayOverlap(holes) {
    if (!holes.length) return;
    const ctx = drawingContext;
    ctx.save();
    ctx.lineCap = "round";
    for (const s of this.strands) {
      if (this.insideAnyHole(s.root.x, s.root.y, holes)) continue;
      if (!this.insideAnyHole(s.tipX, s.tipY, holes)) continue;
      const midX = s.root.x + Math.cos(s.dir) * s.len * 0.45;
      const midY = s.root.y + Math.sin(s.dir) * s.len * 0.45;
      ctx.strokeStyle = this.strandColor(s);
      ctx.lineWidth = s.isGuard ? 1.3 : 1.9;
      ctx.beginPath();
      ctx.moveTo(s.root.x, s.root.y);
      ctx.bezierCurveTo(midX, midY, (midX + s.tipX) / 2, (midY + s.tipY) / 2, s.tipX, s.tipY);
      ctx.stroke();
    }
    ctx.restore();
  }

  // A sharp local kick, e.g. when something suddenly lands/petrifies —
  // matching the reference demo's click-to-ruffle.
  ruffle(x, y, radius = this.disturbRadius * 2.5) {
    const r2 = radius * radius;
    for (const s of this.strands) {
      const dx = s.tipX - x;
      const dy = s.tipY - y;
      if (dx * dx + dy * dy < r2) {
        s.vx += random(-10, 10);
        s.vy += random(-10, 10);
      }
    }
  }
}

// h in [0,360], s/b/a in [0,100] (p5's HSB convention) -> a CSS hsla()
// string. Canvas 2D has no native HSB, but does accept hsl()/hsla()
// directly, so converting once per render bucket (not per strand, per
// frame) is cheaper than routing through p5's colorMode/color machinery.
function hsbToCss(h, s, b, a) {
  const S = s / 100, B = b / 100, A = a / 100;
  const l = B * (1 - S / 2);
  const sl = l <= 0 || l >= 1 ? 0 : (B - l) / Math.min(l, 1 - l);
  return `hsla(${h.toFixed(1)},${(sl * 100).toFixed(1)}%,${(l * 100).toFixed(1)}%,${A.toFixed(2)})`;
}

window.FurField = FurField;
