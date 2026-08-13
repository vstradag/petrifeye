// Generic dwell-time detector.
//
// Tracks how long each pointer (by id) continuously hits a target's region,
// firing onComplete once a threshold (in seconds) is reached. Dwell time
// drains per-pointer once that pointer leaves the region, and is dropped
// outright when the pointer disappears, so a real tracking system can
// stream pointers in/out freely.
class DwellTarget {
  // decayPerSec is how many seconds of accumulated dwell are lost per
  // second while a pointer is present but NOT hitting. Infinity (the
  // default) means progress is thrown away the instant contact breaks.
  //
  // That default is right for a mouse and actively harmful for gaze: a
  // webcam estimate drops out or jumps for a frame or two constantly, and
  // zeroing on every blip means a visitor staring dead-on for 1.9 of the
  // required 2.0 seconds gets sent back to zero by a single bad sample and
  // can never finish. A finite decay makes contact-loss cost proportional
  // to its length, so brief noise is survivable and genuinely looking away
  // still releases the target promptly.
  constructor({ id, hitTest, thresholdSec = 1.5, decayPerSec = Infinity, onComplete, onProgress, onLeave }) {
    this.id = id;
    this.hitTest = hitTest; // (pointer) => boolean
    this.thresholdSec = thresholdSec;
    this.decayPerSec = decayPerSec;
    this.onComplete = onComplete;
    this.onProgress = onProgress;
    this.onLeave = onLeave;
    this.dwellByPointer = new Map(); // pointerId -> seconds accumulated
    this.done = false;
  }

  update(pointers, dt) {
    if (this.done) return;

    const presentIds = new Set(pointers.map((p) => p.id));
    for (const id of [...this.dwellByPointer.keys()]) {
      if (!presentIds.has(id)) this.dwellByPointer.delete(id);
    }

    for (const p of pointers) {
      if (this.hitTest(p)) {
        const next = (this.dwellByPointer.get(p.id) || 0) + dt;
        this.dwellByPointer.set(p.id, next);
        if (this.onProgress) this.onProgress(p, next / this.thresholdSec);
        if (next >= this.thresholdSec) {
          this.done = true;
          if (this.onComplete) this.onComplete(p);
          return;
        }
      } else if (this.dwellByPointer.has(p.id)) {
        const drained = Number.isFinite(this.decayPerSec)
          ? this.dwellByPointer.get(p.id) - dt * this.decayPerSec
          : 0;
        if (drained > 0) {
          this.dwellByPointer.set(p.id, drained);
          if (this.onProgress) this.onProgress(p, drained / this.thresholdSec);
        } else {
          this.dwellByPointer.delete(p.id);
          if (this.onLeave) this.onLeave(p);
        }
      }
    }
  }

  reset() {
    this.done = false;
    this.dwellByPointer.clear();
  }

  progressFor(pointerId) {
    return (this.dwellByPointer.get(pointerId) || 0) / this.thresholdSec;
  }

  maxProgress() {
    let m = 0;
    for (const v of this.dwellByPointer.values()) m = Math.max(m, v / this.thresholdSec);
    return m;
  }
}

window.DwellTarget = DwellTarget;
