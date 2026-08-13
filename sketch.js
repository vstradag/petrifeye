// PetrifEye — stone gaze, real webcam eye tracking.
// Blob-eyes drift across a fur field and petrify when stared at, driven by
// the WebGazer pipeline in shared/gaze/ — index.html wires up
// gaze-controller.js, which handles the permission/calibration flow and
// feeds real gaze samples into Tracking.setExternalPointers(). This sketch
// never touches WebGazer directly; it only reads Tracking.getPointers()
// (shared/tracking.js), so swapping the tracking library later means
// writing one new file matching shared/gaze/webgazer-source.js's small
// interface — nothing here changes. See README.md for the full rundown.
//
// DWELL_SECONDS is longer and NUM_BLOBS lower than you'd use for a mouse-
// driven version: webcam gaze is noisier/slower (jitter shouldn't
// accidentally petrify a blob) and shares CPU with the gaze-prediction
// loop.
//
// MIN_RADIUS / MAX_RADIUS / DWELL_SECONDS are `let`, not `const` — the
// tuning panel (index.html, wired up in initTuningPanel below) adjusts them
// live so eye size and petrify sensitivity can be dialed in against a real
// face without editing code.

let MIN_RADIUS = 28;
let MAX_RADIUS = 46;
let DWELL_SECONDS = 2.0;
// How far from a blob's centre a GAZE pointer can land and still be
// understood as looking at it (see shared/attention.js). Live-tunable, and
// re-derived from real measured error whenever a calibration finishes.
//
// Why it has to be this big: a blob body is 28-46px, while webcam gaze
// lands ~175px from truth. Requiring the estimate inside the body makes the
// game unplayable for reasons that have nothing to do with the visitor. The
// arbiter only ever awards ONE blob per pointer, so a wide radius doesn't
// mean sloppy multi-select — it means "closest wins", which is a question
// the tracker CAN answer reliably.
let GAZE_ASSIST_RADIUS = 170;
const MOUSE_ASSIST_RADIUS = 0; // a mouse is genuinely pixel-accurate — no assist
const UNFREEZE_SECONDS = 10;
const NUM_BLOBS = 9;
const STONE_PATHS = [
  "/textures/stone_1.jpeg",
  "/textures/stone_2.jpeg",
  "/textures/stone_3.jpeg",
  "/textures/stone_4.jpeg",
  "/textures/stone_5.jpeg",
  "/textures/stone_6.jpeg",
  "/textures/stone_7.jpeg",
];

let stoneImages = [];
let blobs = [];
let fur;
let furEnabled = false;
let attention;
// pointerId -> blobId for this frame. Each Blob's dwell hitTest reads this
// rather than doing its own distance check, so exactly one blob can be
// armed per pointer.
let focus = new Map();
let measuredAccuracyPx = null; // last validated gaze error, null until calibrated

function preload() {
  stoneImages = STONE_PATHS.map((p) => loadImage(p));
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  for (let i = 0; i < NUM_BLOBS; i++) {
    blobs.push(new Blob(random(width), random(height)));
  }
  fur = new FurField({ width, height });
  attention = new AttentionArbiter({ captureRadius: GAZE_ASSIST_RADIUS });
  initTuningPanel();

  if (window.ControlsHint) {
    ControlsHint.show([
      { keys: "look / mouse", does: "stare to petrify" },
      { keys: "s", does: "tuning panel" },
      { keys: "f", does: "fur background" },
      { keys: "r", does: "reset stones" },
      { keys: "t", does: "recalibrate" },
    ], "medusa");
  }
  initAccuracyListener();
}

// The gaze controller publishes the error it actually measured during its
// held-out validation sweep. Sizing the assist radius from that (instead of
// a fixed guess) means a visitor who calibrated well gets tight, honest
// targeting, and one who calibrated badly still gets a playable piece.
function initAccuracyListener() {
  window.addEventListener("gaze-accuracy", (e) => {
    const px = e.detail && e.detail.accuracyPx;
    if (!px || !Number.isFinite(px)) return;
    measuredAccuracyPx = px;
    // 1.1x: the arbiter should catch a blob the visitor is looking at even
    // on a slightly worse-than-average sample, without reaching so far that
    // two blobs are routinely in contention.
    GAZE_ASSIST_RADIUS = constrain(px * 1.1, 90, 320);
    syncAssistSlider();
  });
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  fur.resize(width, height);
}

function draw() {
  background(8, 10, 16);
  const dt = deltaTime / 1000;
  const pointers = Tracking.update();

  // Hole radius has to match the body's actual visible size (this.radius —
  // what blobShapePoints uses to draw it), not the smaller eyeRadius(). It
  // was sized off eyeRadius() from an earlier version that had no body
  // disc; with the disc back, a hole smaller than it hid the whole
  // displacement ring underneath it — invisible, covered by the body.
  //
  // noiseSeed/noiseTime are the same values Blob.organicShapePoints uses
  // to draw the body/stone's actual wobbly, non-circular silhouette —
  // passing them lets FurField shape the hole to match that silhouette
  // instead of a perfect circle around it. (Petrified blobs stop
  // advancing noiseTime in move(), so this naturally stays locked to
  // whatever shape the stone mask was frozen at.)
  const holes = blobs.map((b) => ({
    x: b.pos.x, y: b.pos.y, radius: b.radius,
    noiseSeed: b.noiseSeed, noiseTime: b.noiseTime,
  }));

  if (furEnabled) {
    const nudges = pointers.map((p) => ({ x: p.x, y: p.y, radius: 55, push: 1.0 }));
    // Fur flexing along each moving eye's direction of travel — separate
    // from the hard rim-bunching in `holes`, this sways nearby strand
    // tips (a wider radius than the eye itself) like grass bending as
    // something brushes through, not just parting symmetrically. Only
    // applies to blobs actually moving; petrified ones are stationary.
    const flexes = blobs
      .filter((b) => !b.petrified && b.vel.magSq() > 0.0004)
      .map((b) => {
        const dir = b.vel.copy().normalize();
        return {
          x: b.pos.x, y: b.pos.y,
          radius: b.radius * 2.4,
          push: 0,
          dirX: dir.x, dirY: dir.y,
          dirStrength: Math.min(b.vel.mag() * 20, 6),
        };
      });
    fur.update(dt, nudges.concat(flexes), holes);
    fur.display();
  }

  for (const b of blobs) b.flock(blobs);
  for (const b of blobs) b.move(dt);
  resolveCollisions(blobs);

  // Decide what each pointer is attending to BEFORE any dwell runs, so the
  // per-blob hitTests below all agree on a single winner. Petrified blobs
  // are excluded outright — they're finished, and leaving them in would let
  // a stone sitting nearer the gaze steal the lock from the live blob the
  // visitor is actually trying to petrify.
  const gazeMode = pointers.some((p) => p.id === "gaze");
  attention.captureRadius = gazeMode ? GAZE_ASSIST_RADIUS : MOUSE_ASSIST_RADIUS;
  focus = attention.resolve(
    pointers,
    blobs.filter((b) => !b.petrified).map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y, radius: b.radius }))
  );

  for (const b of blobs) b.dwell.update(pointers, dt);
  for (const b of blobs) b.display(pointers);

  // Whatever fur happens to droop over a socket's rim on its own — no
  // special push, just its ordinary length and sway — redraws in front of
  // the eye/stone now that it's on the canvas. This is what should read as
  // "growing into the fur" instead of a clean disc or a buried one.
  if (furEnabled) fur.displayOverlap(holes);

  drawPointerMarkers(pointers);
  drawHUD(pointers);
}

// Hard collision pass so blobs bounce off each other (not just the canvas
// edges). Petrified blobs act as immovable obstacles that moving blobs
// still bounce off of.
function resolveCollisions(blobs) {
  for (let i = 0; i < blobs.length; i++) {
    for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i];
      const b = blobs[j];
      if (a.petrified && b.petrified) continue;

      const delta = p5.Vector.sub(b.pos, a.pos); // points from a to b
      const dist = delta.mag();
      const minDist = a.radius + b.radius;
      if (dist <= 0 || dist >= minDist) continue;

      const normal = delta.div(dist);
      const overlap = minDist - dist;
      const aMovable = !a.petrified;
      const bMovable = !b.petrified;

      if (aMovable && bMovable) {
        a.pos.sub(p5.Vector.mult(normal, overlap / 2));
        b.pos.add(p5.Vector.mult(normal, overlap / 2));
      } else if (aMovable) {
        a.pos.sub(p5.Vector.mult(normal, overlap));
      } else if (bMovable) {
        b.pos.add(p5.Vector.mult(normal, overlap));
      }

      if (aMovable) {
        const vn = a.vel.dot(normal);
        if (vn > 0) a.vel.sub(p5.Vector.mult(normal, 2 * vn));
      }
      if (bMovable) {
        const vn = b.vel.dot(normal);
        if (vn < 0) b.vel.sub(p5.Vector.mult(normal, 2 * vn));
      }
    }
  }
}

function drawPointerMarkers(pointers) {
  push();
  strokeWeight(2.5);
  for (const p of pointers) {
    if (p.id === "mouse") continue; // the OS cursor already marks this one
    noFill();
    stroke(90, 200, 255);
    circle(p.x, p.y, 22);
    line(p.x - 14, p.y, p.x + 14, p.y);
    line(p.x, p.y - 14, p.x, p.y + 14);
    noStroke();
    fill(90, 200, 255);
    circle(p.x, p.y, 6); // bright center dot — the crosshair alone reads faint at a glance
    textSize(11);
    textFont("monospace");
    text(p.id, p.x + 14, p.y - 14);
  }
  pop();
}

function keyPressed() {
  if (key === "r" || key === "R") blobs.forEach((b) => b.unpetrify());
  if (key === "f" || key === "F") setFurEnabled(!furEnabled);
  if (key === "s" || key === "S") toggleSettingsPanel();
}

function setFurEnabled(enabled) {
  furEnabled = enabled;
  const toggle = document.getElementById("toggle-fur");
  if (toggle) toggle.checked = enabled;
}

function toggleSettingsPanel() {
  const panel = document.getElementById("tuning-panel");
  if (panel) panel.classList.toggle("tuning-panel-hidden");
}

// Traces a closed, organic blob silhouette through curveVertex points onto
// either the main canvas (g omitted) or an offscreen p5.Graphics (g).
function traceBlobShape(pts, g) {
  const beginS = g ? g.beginShape.bind(g) : beginShape;
  const cv = g ? g.curveVertex.bind(g) : curveVertex;
  const endS = g ? g.endShape.bind(g) : endShape;
  beginS();
  cv(pts[pts.length - 1].x, pts[pts.length - 1].y);
  for (const pt of pts) cv(pt.x, pt.y);
  cv(pts[0].x, pts[0].y);
  cv(pts[1].x, pts[1].y);
  endS(CLOSE);
}

// Same closed organic silhouette as traceBlobShape, but built directly on
// the raw canvas path (moveTo + quadraticCurveTo through segment midpoints,
// the standard smooth-closed-curve-through-points trick) instead of p5's
// beginShape/curveVertex. p5's fill() only ever sets a flat color on
// drawingContext.fillStyle — to fill a shape with an actual gradient
// (needed for the body to read as lit/3D instead of a flat cutout) the
// path has to be built and filled through the raw context ourselves.
function traceOrganicPathRaw(ctx, pts) {
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const m0 = mid(pts[pts.length - 1], pts[0]);
  ctx.beginPath();
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < pts.length; i++) {
    const next = pts[(i + 1) % pts.length];
    const m = mid(pts[i], next);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  ctx.closePath();
}

function squareCrop(img, size) {
  const s = min(img.width, img.height);
  const sx = (img.width - s) / 2;
  const sy = (img.height - s) / 2;
  const cropped = img.get(sx, sy, s, s);
  cropped.resize(size, size);
  return cropped;
}

// Rotates a square image by a random multiple of 90deg so repeated stone
// textures (only 7, shared across up to NUM_BLOBS petrified blobs) don't
// all read as the exact same crop.
function randomlyRotatedSquare(img) {
  const size = img.width;
  const steps = floor(random(4));
  if (steps === 0) return img;
  const g = createGraphics(size, size);
  g.imageMode(CENTER);
  g.translate(size / 2, size / 2);
  g.rotate(HALF_PI * steps);
  g.image(img, 0, 0, size, size);
  return g.get(0, 0, size, size);
}

class Blob {
  constructor(x, y) {
    this.pos = createVector(x, y);
    this.vel = p5.Vector.random2D().mult(random(0.3, 0.8));
    this.acc = createVector(0, 0);
    this.radius = random(MIN_RADIUS, MAX_RADIUS);
    this.maxSpeed = random(0.4, 0.9);
    this.maxForce = 0.02;
    this.noiseSeed = random(1000);
    this.noiseTime = random(1000);
    this.petrified = false;
    this.petrifiedElapsed = 0;
    this.stoneImg = null;
    this.id = `blob-${floor(random(1e6))}`;

    this.dwell = new DwellTarget({
      id: this.id,
      thresholdSec: DWELL_SECONDS,
      // Progress drains at 1.5x the rate it builds: fast enough that
      // deliberately looking away frees the blob in well under a second,
      // slow enough that the constant single-frame dropouts of a webcam
      // estimate cost almost nothing.
      decayPerSec: 1.5,
      // No distance test of its own — the frame's arbiter already picked a
      // single winner per pointer (see draw()). Asking "am I the winner?"
      // instead of "is the pointer inside me?" is what makes a 40px target
      // reachable with a ~175px-accurate signal.
      hitTest: (ptr) => !this.petrified && focus.get(ptr.id) === this.id,
      onComplete: () => this.petrify(),
    });
  }

  flock(others) {
    if (this.petrified) return;
    const sep = createVector(), ali = createVector(), coh = createVector();
    let count = 0;
    for (const o of others) {
      if (o === this || o.petrified) continue;
      const d = p5.Vector.dist(this.pos, o.pos);
      if (d > 0 && d < 90) {
        sep.add(p5.Vector.sub(this.pos, o.pos).normalize().div(d));
        ali.add(o.vel);
        coh.add(o.pos);
        count++;
      }
    }
    if (count > 0) {
      sep.div(count).setMag(this.maxSpeed).limit(this.maxForce * 1.6);
      ali.div(count).setMag(this.maxSpeed).limit(this.maxForce);
      coh.div(count).sub(this.pos).setMag(this.maxSpeed).limit(this.maxForce);
      this.acc.add(sep).add(ali).add(coh);
    }
    const wander = p5.Vector.fromAngle(noise(this.noiseSeed, this.noiseTime) * TWO_PI * 2);
    this.acc.add(wander.mult(0.01));
  }

  move(dt) {
    if (this.petrified) {
      this.petrifiedElapsed += dt;
      if (this.petrifiedElapsed >= UNFREEZE_SECONDS) this.unpetrify();
      return;
    }
    this.vel.add(this.acc);
    this.vel.limit(this.maxSpeed);
    this.pos.add(p5.Vector.mult(this.vel, dt * 60));
    this.acc.mult(0);
    this.noiseTime += 0.003;

    if (this.pos.x - this.radius < 0) {
      this.pos.x = this.radius;
      this.vel.x *= -1;
    } else if (this.pos.x + this.radius > width) {
      this.pos.x = width - this.radius;
      this.vel.x *= -1;
    }
    if (this.pos.y - this.radius < 0) {
      this.pos.y = this.radius;
      this.vel.y *= -1;
    } else if (this.pos.y + this.radius > height) {
      this.pos.y = height - this.radius;
      this.vel.y *= -1;
    }
  }

  blobShapePoints(t) {
    const pts = [];
    const n = 10;
    for (let i = 0; i < n; i++) {
      const angle = (TWO_PI / n) * i;
      const r = this.radius * (0.82 + 0.18 * noise(this.noiseSeed + i * 10, t));
      pts.push(createVector(cos(angle) * r, sin(angle) * r));
    }
    return pts;
  }

  // Visible eyeball radius — this.radius stays the physics/hit-test size
  // (flocking, collision, dwell); the fur-hole in draw() is sized off this
  // instead, so the clearing matches what's actually sitting in it.
  eyeRadius() {
    return this.radius * 0.42;
  }

  petrify() {
    if (this.petrified) return;
    this.petrified = true;
    this.petrifiedElapsed = 0;
    this.vel.mult(0);
    if (fur) fur.ruffle(this.pos.x, this.pos.y);

    const tex = random(stoneImages);
    const d = ceil(this.radius * 2.2);
    const pts = this.blobShapePoints(this.noiseTime);

    const g = createGraphics(d, d);
    g.clear();
    g.noStroke();
    g.fill(255);
    g.push();
    g.translate(d / 2, d / 2);
    traceBlobShape(pts, g);
    g.pop();

    const stoneCopy = randomlyRotatedSquare(squareCrop(tex, d));
    stoneCopy.mask(g.get(0, 0, d, d));

    this.stoneImg = stoneCopy;
    this.stoneSize = d;
  }

  unpetrify() {
    if (!this.petrified) return;
    this.petrified = false;
    this.stoneImg = null;
    this.vel = p5.Vector.random2D().mult(random(0.3, 0.8));
    this.dwell.reset();
  }

  display(pointers) {
    push();
    translate(this.pos.x, this.pos.y);

    if (this.petrified && this.stoneImg) {
      imageMode(CENTER);
      image(this.stoneImg, 0, 0, this.stoneSize, this.stoneSize);
    } else {
      // A flat-filled shape with zero shading always reads as a cutout
      // pasted on top, no matter how tight the fur gets or how dark a halo
      // sits behind it — there's no actual light/form information, just
      // adjacency. Real fix: shade the body itself like a lit form (light
      // upper-left highlight -> shadowed lower-right, plus a dark rim
      // where it meets the fur), via a raw-canvas gradient fill on the
      // same organic silhouette instead of a flat color.
      const ctx = drawingContext;
      const bodyPts = this.blobShapePoints(this.noiseTime);

      const grd = ctx.createRadialGradient(
        -this.radius * 0.35, -this.radius * 0.4, this.radius * 0.1,
        0, 0, this.radius * 1.05
      );
      grd.addColorStop(0, "rgb(252,248,242)");
      grd.addColorStop(0.5, "rgb(214,206,196)");
      grd.addColorStop(1, "rgb(132,120,108)");
      ctx.fillStyle = grd;
      traceOrganicPathRaw(ctx, bodyPts);
      ctx.fill();

      // Dark ambient-occlusion rim right at the edge, where body meets fur.
      const rim = ctx.createRadialGradient(0, 0, this.radius * 0.68, 0, 0, this.radius);
      rim.addColorStop(0, "rgba(18,14,12,0)");
      rim.addColorStop(1, "rgba(18,14,12,0.5)");
      ctx.fillStyle = rim;
      traceOrganicPathRaw(ctx, bodyPts);
      ctx.fill();

      let nearest = null, nd = Infinity;
      for (const ptr of pointers) {
        const d = dist(ptr.x, ptr.y, this.pos.x, this.pos.y);
        if (d < nd) { nd = d; nearest = ptr; }
      }
      const eyeR = this.eyeRadius();
      stroke(20);
      strokeWeight(1.5);
      fill(255);
      ellipse(0, 0, eyeR * 2, eyeR * 2);

      let pupilOff = createVector(0, 0);
      if (nearest) {
        pupilOff = createVector(nearest.x - this.pos.x, nearest.y - this.pos.y);
        pupilOff.limit(eyeR * 0.45);
      }
      noStroke();
      fill(15);
      ellipse(pupilOff.x, pupilOff.y, eyeR * 0.9, eyeR * 0.9);

      // Eye shine — a small offset highlight, standard trick for making a
      // flat circle read as a wet/glossy sphere instead of a painted dot.
      fill(255, 255, 255, 235);
      ellipse(pupilOff.x - eyeR * 0.28, pupilOff.y - eyeR * 0.3, eyeR * 0.26, eyeR * 0.26);

      // Locked-on feedback. With assist active the gaze marker routinely
      // sits well outside the blob it has selected, so without an explicit
      // link the choice reads as arbitrary — or worse, as the tracker being
      // broken. Drawing the tether makes the arbiter's reasoning legible:
      // "this one, because it's the closest thing to where you're looking."
      const lockedPtr = pointers.find((ptr) => focus.get(ptr.id) === this.id);
      if (lockedPtr) {
        const lx = lockedPtr.x - this.pos.x;
        const ly = lockedPtr.y - this.pos.y;
        if (Math.hypot(lx, ly) > this.radius * 1.2) {
          push();
          stroke(255, 90, 90, 90);
          strokeWeight(1);
          // p5's push/pop doesn't track raw-context state, so the dash has
          // to be cleared by hand or every later stroke inherits it.
          drawingContext.setLineDash([4, 6]);
          line(lx, ly, 0, 0);
          drawingContext.setLineDash([]);
          pop();
        }
        noFill();
        stroke(255, 90, 90, 70);
        strokeWeight(1.5);
        circle(0, 0, this.radius * 2.7);
      }

      const prog = this.dwell.maxProgress();
      if (prog > 0.02) {
        noFill();
        stroke(255, 80, 80, 220);
        strokeWeight(3);
        arc(0, 0, this.radius * 2.3, this.radius * 2.3, -HALF_PI, -HALF_PI + TWO_PI * prog);
      }
    }
    pop();
  }
}

function drawHUD(pointers) {
  push();
  fill(255, 180);
  noStroke();
  textSize(12);
  textFont("monospace");
  let y = height - 14 * (pointers.length + 3) - 8;
  text("PETRIFEYE // real webcam gaze turns blobs to stone", 12, y); y += 16;
  text("f: fur  m: mouse  e: eye  t: train  s: settings  r: reset", 12, y); y += 16;
  const acc = measuredAccuracyPx == null ? "uncalibrated" : `±${measuredAccuracyPx.toFixed(0)}px`;
  text(`gaze error: ${acc}   assist: ${GAZE_ASSIST_RADIUS.toFixed(0)}px`, 12, y); y += 16;
  for (const p of pointers) {
    const locked = focus.get(p.id);
    text(`${p.id}: ${p.x.toFixed(0)}, ${p.y.toFixed(0)}${locked ? "  -> " + locked : ""}`, 12, y);
    y += 14;
  }
  pop();
}

// Wires the min/max eye size and dwell-duration sliders (index.html) to the
// live sketch state. Resizing remaps each blob's radius proportionally
// within the new range (rather than re-randomizing) so blobs don't jump
// around while a slider is being dragged.
function initTuningPanel() {
  const minSlider = document.getElementById("slider-min-radius");
  const maxSlider = document.getElementById("slider-max-radius");
  const dwellSlider = document.getElementById("slider-dwell");
  const assistSlider = document.getElementById("slider-assist");
  const furToggle = document.getElementById("toggle-fur");
  const minLabel = document.getElementById("tv-min");
  const maxLabel = document.getElementById("tv-max");
  const dwellLabel = document.getElementById("tv-dwell");
  const assistLabel = document.getElementById("tv-assist");

  furToggle.addEventListener("change", () => setFurEnabled(furToggle.checked));

  function remapRadii(oldMin, oldMax, newMin, newMax) {
    for (const b of blobs) {
      const t = oldMax > oldMin ? constrain((b.radius - oldMin) / (oldMax - oldMin), 0, 1) : 0.5;
      b.radius = lerp(newMin, newMax, t);
    }
  }

  minSlider.addEventListener("input", () => {
    // Both bounds have to be captured before either gets mutated below —
    // when dragging min forces max to bump up too (keeping a 4px gap),
    // MAX_RADIUS is already the NEW value by the time remapRadii ran
    // previously, so "old max" and "new max" were the same (mutated)
    // number. That collapsed the computed range to ~nothing, compressing
    // every blob's radius into a tiny band — looked like "all eyes are
    // the same size" even though the underlying random-range logic was
    // fine.
    const oldMin = MIN_RADIUS;
    const oldMax = MAX_RADIUS;
    let next = Number(minSlider.value);
    if (next > MAX_RADIUS - 4) {
      MAX_RADIUS = next + 4;
      maxSlider.value = MAX_RADIUS;
      maxLabel.textContent = `${MAX_RADIUS}px`;
    }
    MIN_RADIUS = next;
    minLabel.textContent = `${MIN_RADIUS}px`;
    remapRadii(oldMin, oldMax, MIN_RADIUS, MAX_RADIUS);
  });

  maxSlider.addEventListener("input", () => {
    const oldMin = MIN_RADIUS;
    const oldMax = MAX_RADIUS;
    let next = Number(maxSlider.value);
    if (next < MIN_RADIUS + 4) {
      MIN_RADIUS = next - 4;
      minSlider.value = MIN_RADIUS;
      minLabel.textContent = `${MIN_RADIUS}px`;
    }
    MAX_RADIUS = next;
    maxLabel.textContent = `${MAX_RADIUS}px`;
    remapRadii(oldMin, oldMax, MIN_RADIUS, MAX_RADIUS);
  });

  dwellSlider.addEventListener("input", () => {
    DWELL_SECONDS = Number(dwellSlider.value);
    dwellLabel.textContent = `${DWELL_SECONDS.toFixed(1)}s`;
    for (const b of blobs) b.dwell.thresholdSec = DWELL_SECONDS;
  });

  assistSlider.addEventListener("input", () => {
    GAZE_ASSIST_RADIUS = Number(assistSlider.value);
    assistLabel.textContent = `${GAZE_ASSIST_RADIUS}px`;
  });
}

// Pushes a programmatic assist change (from a finished calibration) back
// into the panel, so the slider never disagrees with what's actually in
// effect.
function syncAssistSlider() {
  const slider = document.getElementById("slider-assist");
  const label = document.getElementById("tv-assist");
  if (slider) slider.value = String(Math.round(GAZE_ASSIST_RADIUS));
  if (label) label.textContent = `${Math.round(GAZE_ASSIST_RADIUS)}px`;
}
