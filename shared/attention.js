// Winner-take-all attention arbiter.
//
// Bridges the gap between how precise a pointer is and how small the things
// it has to select are. Webcam gaze lands somewhere around 175px / 4.17deg
// from where the visitor is actually looking (WebGazer's own published
// evaluation), while a blob body is 28-46px across. A strict "is the
// pointer inside the blob" test at that ratio is close to a lottery — and
// it fails in both directions at once: you can be staring straight at a
// blob and hit nothing, or drift across two of them and arm both.
//
// So instead of asking each target "does the pointer touch me?", this asks
// the pointer "of everything nearby, which one are you most likely looking
// at?" and hands the answer to exactly ONE target. That converts an
// ABSOLUTE accuracy problem into a RELATIVE one: the estimate no longer has
// to land within 40px of a blob, it only has to be nearer that blob than
// any other. With a handful of sparse blobs on screen that is a far easier
// bar, and it costs no tracking accuracy — it's pure interpretation.
//
// Two behaviours keep the lock from flickering, which matters because dwell
// progress decays as soon as the lock moves:
//
//   captureRadius  widens each target's catchment well past its drawn size.
//                  0 means "strict" — fall back to the target's own radius,
//                  which is what a mouse should get, since a mouse really
//                  is pixel-accurate and assist would just feel wrong.
//   switchMargin   makes the current holder sticky: a rival has to be
//                  clearly closer, not a hair closer, before it steals the
//                  lock. Without this, two similar-distance blobs trade the
//                  lock every few frames on gaze jitter alone and neither
//                  ever accumulates enough dwell to fire.
class AttentionArbiter {
  constructor({ captureRadius = 0, switchMargin = 40, releaseFactor = 1.25 } = {}) {
    this.captureRadius = captureRadius;
    this.switchMargin = switchMargin;
    // How far past its capture radius a held target can drift before the
    // lock breaks. Slightly >1 so a blob easing along the boundary doesn't
    // chatter in and out of focus.
    this.releaseFactor = releaseFactor;
    this.lockByPointer = new Map(); // pointerId -> targetId
  }

  reach(target) {
    return Math.max(target.radius, this.captureRadius);
  }

  // targets: [{ id, x, y, radius }] — only currently-selectable ones.
  // Returns Map<pointerId, targetId> naming the single target each pointer
  // is considered to be attending to this frame.
  resolve(pointers, targets) {
    const byId = new Map(targets.map((t) => [t.id, t]));
    const focus = new Map();

    // Drop locks for pointers that no longer exist (gaze stream dropped
    // out, mouse left, etc.) so their ids can't leak into a later frame.
    const present = new Set(pointers.map((p) => p.id));
    for (const id of [...this.lockByPointer.keys()]) {
      if (!present.has(id)) this.lockByPointer.delete(id);
    }

    for (const p of pointers) {
      // A held target can vanish between frames (it petrified, so it's no
      // longer in `targets`) — byId lookup returns undefined and we simply
      // fall through to picking a fresh winner.
      const heldId = this.lockByPointer.get(p.id);
      const held = heldId ? byId.get(heldId) : null;
      const heldDist = held ? Math.hypot(p.x - held.x, p.y - held.y) : Infinity;

      let best = null;
      let bestDist = Infinity;
      for (const t of targets) {
        const d = Math.hypot(p.x - t.x, p.y - t.y);
        if (d > this.reach(t)) continue;
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }

      let winner;
      if (held && heldDist <= this.reach(held) * this.releaseFactor) {
        const steals = best && best.id !== held.id && bestDist < heldDist - this.switchMargin;
        winner = steals ? best : held;
      } else {
        winner = best;
      }

      if (winner) {
        this.lockByPointer.set(p.id, winner.id);
        focus.set(p.id, winner.id);
      } else {
        this.lockByPointer.delete(p.id);
      }
    }

    return focus;
  }

  clear() {
    this.lockByPointer.clear();
  }
}

window.AttentionArbiter = AttentionArbiter;
