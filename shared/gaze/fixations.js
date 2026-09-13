// Fixation detection from a stream of gaze samples: dispersion-threshold
// identification (I-DT, Salvucci & Goldberg 2000), run incrementally.
//
// A fixation is a stretch of samples that stays inside a small spatial
// window for at least a minimum time. Everything else — the fast jumps
// between fixations — is saccade, and carries no looking.
//
// WHY DISPERSION AND NOT VELOCITY
//
// The velocity method (I-VT) needs a steady, fairly high sample rate to
// estimate speed, and this app gets three very different streams: Neon at up
// to 120Hz, a webcam at an irregular ~30Hz, and a mouse at the display rate.
// Dispersion only asks "did the points stay close together for long enough",
// which holds up across all three without retuning per input.
//
//   const det = new FixationDetector({ dispersionPx: 50, minDurationMs: 100 });
//   const fix = det.push(performance.now(), x, y);   // a CLOSED fixation, or null
//   det.current();                                   // the one still in progress
//   det.flush();                                     // gaze left: close it now
//
// Works in browsers and Node (for tests).
(function (root) {
  class FixationDetector {
    constructor({ dispersionPx = 50, minDurationMs = 100, maxGapMs = 150 } = {}) {
      this.dispersionPx = dispersionPx;
      this.minDurationMs = minDurationMs;
      // A pause in the samples longer than this ends a fixation. Blinks and
      // tracking dropouts arrive as gaps, and a fixation must not silently
      // stretch across one — "looked here, blinked, looked here again" is two
      // fixations, and averaging over the gap would inflate duration.
      this.maxGapMs = maxGapMs;
      this.reset();
    }

    reset() {
      this.win = [];
      this.minX = Infinity; this.maxX = -Infinity;
      this.minY = Infinity; this.maxY = -Infinity;
    }

    // Salvucci & Goldberg's measure: horizontal spread plus vertical spread.
    dispersionWith(x, y) {
      return (Math.max(this.maxX, x) - Math.min(this.minX, x)) +
             (Math.max(this.maxY, y) - Math.min(this.minY, y));
    }

    recomputeBounds() {
      this.minX = this.minY = Infinity;
      this.maxX = this.maxY = -Infinity;
      for (const s of this.win) {
        if (s.x < this.minX) this.minX = s.x;
        if (s.x > this.maxX) this.maxX = s.x;
        if (s.y < this.minY) this.minY = s.y;
        if (s.y > this.maxY) this.maxY = s.y;
      }
    }

    duration() {
      const n = this.win.length;
      return n < 2 ? 0 : this.win[n - 1].t - this.win[0].t;
    }

    // The window as a fixation, if it has lasted long enough to count.
    asFixation() {
      if (this.duration() < this.minDurationMs) return null;
      let sx = 0, sy = 0;
      for (const s of this.win) { sx += s.x; sy += s.y; }
      const n = this.win.length;
      return {
        x: sx / n, y: sy / n,
        start: this.win[0].t,
        end: this.win[n - 1].t,
        duration: this.duration(),
        samples: n,
      };
    }

    // Feed one sample. Returns a fixation that has just ENDED, or null.
    push(t, x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return this.flush();

      let closed = null;
      const last = this.win[this.win.length - 1];
      if (last && t - last.t > this.maxGapMs) closed = this.flush();

      if (this.win.length && this.dispersionWith(x, y) > this.dispersionPx) {
        // This sample breaks the window. Whatever came before it was compact;
        // if it lasted long enough, that was a fixation and it ends here.
        const fix = this.asFixation();
        if (fix) {
          closed = fix;
          this.reset();
        } else {
          // Too short to be a fixation: slide the window's start forward
          // until the new sample fits, rather than discarding everything —
          // the tail may be the beginning of the next fixation.
          this.win.push({ t, x, y });
          while (this.win.length > 1) {
            this.recomputeBounds();
            if ((this.maxX - this.minX) + (this.maxY - this.minY) <= this.dispersionPx) break;
            this.win.shift();
          }
          this.recomputeBounds();
          return closed;
        }
      }

      this.win.push({ t, x, y });
      if (x < this.minX) this.minX = x;
      if (x > this.maxX) this.maxX = x;
      if (y < this.minY) this.minY = y;
      if (y > this.maxY) this.maxY = y;
      return closed;
    }

    // The fixation still in progress, for live display. Null during saccades.
    current() {
      return this.asFixation();
    }

    // Gaze has gone (left the image, lost tracking): close what is open.
    flush() {
      const fix = this.asFixation();
      this.reset();
      return fix;
    }
  }

  // Pre-filter for the detector: the median of the last few samples, per axis.
  //
  // Real gaze streams carry occasional SPIKES — a single wild sample from a
  // blink edge or a mis-detected pupil. Raw, one spike breaks the dispersion
  // window and splits a fixation in two: with spikes on 8% of samples, raw
  // Neon-like data segmented correctly in 1 run of 40.
  //
  // A median removes a spike outright while keeping a saccade's edge sharp.
  // That is the difference from a low-pass or the motion assist, both of
  // which blur the edge — overshooting past the landing point, then creeping
  // into place — and the detector reads the creep as extra fixations. With a
  // 5-sample median the same data segmented correctly in 40 of 40.
  //
  // Window per input, from a sweep over 100 trials of noisy 30Hz data:
  //   neon / mouse   5 samples, normal spread           40/40
  //   webcam         7 samples, spread x 2.5            95/100
  // WebGazer's precision simply does not resolve fixations as finely, so the
  // honest adaptation is a coarser spatial window, not pretending otherwise.
  class MedianFilter2D {
    constructor(size = 5) { this.size = size; this.xs = []; this.ys = []; }
    static median(a) {
      const s = a.slice().sort((p, q) => p - q);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    push(x, y) {
      this.xs.push(x); this.ys.push(y);
      if (this.xs.length > this.size) { this.xs.shift(); this.ys.shift(); }
      return { x: MedianFilter2D.median(this.xs), y: MedianFilter2D.median(this.ys) };
    }
    reset() { this.xs = []; this.ys = []; }
  }

  root.FixationDetector = FixationDetector;
  root.MedianFilter2D = MedianFilter2D;
  if (typeof module !== "undefined") module.exports = { FixationDetector, MedianFilter2D };
})(typeof window !== "undefined" ? window : globalThis);
