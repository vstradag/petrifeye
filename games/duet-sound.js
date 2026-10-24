// DUET — the sound. Plain Web Audio, no library and no samples, so the piece
// runs offline like everything else here.
//
//   voices ─┬─ dry ─────────────┐
//   chord  ─┤                   ├─ master ─ compressor ─ speakers
//   bells  ─┴─ send ─ reverb ───┘
//   drone  ─┘
//
// Each player is one continuous VOICE that follows their gaze (games/duet.js
// decides its pitch); TENSION is how far apart the two players are, and it is
// heard as the voice's own unrest — a wider vibrato, a second oscillator
// pulled out of tune against the first so it beats. At zero tension the voice
// is clean. Where the two meet a CHORD blooms underneath them, and every
// fixation rings a BELL. A quiet DRONE on the root grows as the piece does.
//
// Nothing here makes a sound before start(), which must run inside a click:
// browsers keep an AudioContext silent until a user gesture.
(function () {
  let ctx = null;
  let master, comp, dry, send, droneGain;
  let volume = 0.8, muted = false;
  const voices = [];
  let chord = null;

  // A reverb made rather than loaded: decaying stereo noise is a convincing
  // large room, and there is no file to ship.
  function impulse(seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  const glide = (param, value, tc) => param.setTargetAtTime(value, ctx.currentTime, tc);

  // ------------------------------------------------------------- a voice
  // Two timbres, so two people singing can be told apart by ear as well as by
  // eye: player 1 warm (triangle, odd harmonics, like a clarinet), player 2
  // airy (sines an octave apart, like glass or a flute).
  function makeVoice(i) {
    const out = ctx.createGain(); out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass"; filter.frequency.value = 1200; filter.Q.value = 0.7;
    const pan = ctx.createStereoPanner();

    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    const c = ctx.createOscillator();
    const ga = ctx.createGain(), gb = ctx.createGain(), gc = ctx.createGain();
    if (i === 0) {
      a.type = "triangle"; b.type = "triangle"; c.type = "sine";
      ga.gain.value = 0.55; gb.gain.value = 0.35; gc.gain.value = 0.25;
    } else {
      a.type = "sine"; b.type = "sine"; c.type = "sine";
      ga.gain.value = 0.6; gb.gain.value = 0.4; gc.gain.value = 0.18;
    }
    a.connect(ga); b.connect(gb); c.connect(gc);
    ga.connect(filter); gb.connect(filter); gc.connect(filter);

    // Vibrato: one LFO into both main oscillators' frequency, its depth in Hz
    // set every frame from the voice's pitch and tension.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = i === 0 ? 5.1 : 4.6;
    const depth = ctx.createGain(); depth.gain.value = 0;
    lfo.connect(depth); depth.connect(a.frequency); depth.connect(b.frequency);

    filter.connect(out); out.connect(pan);
    pan.connect(dry); pan.connect(send);
    [a, b, c, lfo].forEach((o) => o.start());
    return { out, filter, pan, a, b, c, depth, octave: i === 0 ? 0.5 : 2 };
  }

  // ------------------------------------------------------------- the chord
  // Four soft notes (bass + three chord tones), each a pair of sines a few
  // cents apart — a slow chorus that reads as one warm pad.
  function makeChord() {
    const out = ctx.createGain(); out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass"; filter.frequency.value = 1800;
    filter.connect(out); out.connect(dry); out.connect(send);
    const notes = [];
    for (let n = 0; n < 4; n++) {
      const g = ctx.createGain(); g.gain.value = n === 0 ? 0.32 : 0.22;
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      o1.type = "sine"; o2.type = n === 0 ? "sine" : "triangle";
      o1.detune.value = -4; o2.detune.value = 4;
      o1.connect(g); o2.connect(g); g.connect(filter);
      o1.frequency.value = o2.frequency.value = 110;
      o1.start(); o2.start();
      notes.push({ o1, o2 });
    }
    // Shimmer: the chord's root two octaves up, trembling slowly — the light
    // on top that only a long, held meeting reaches.
    const shimmer = ctx.createOscillator(); shimmer.type = "sine";
    const shimmerGain = ctx.createGain(); shimmerGain.gain.value = 0;
    const trem = ctx.createOscillator(); trem.frequency.value = 0.35;
    const tremDepth = ctx.createGain(); tremDepth.gain.value = 0.5;
    trem.connect(tremDepth);
    const shimmerAmp = ctx.createGain(); shimmerAmp.gain.value = 0.5;
    tremDepth.connect(shimmerAmp.gain);
    shimmer.connect(shimmerAmp); shimmerAmp.connect(shimmerGain); shimmerGain.connect(send); shimmerGain.connect(dry);
    shimmer.start(); trem.start();
    return { out, notes, shimmer, shimmerGain };
  }

  function makeDrone() {
    droneGain = ctx.createGain(); droneGain.gain.value = 0;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 500;
    f.connect(droneGain); droneGain.connect(dry); droneGain.connect(send);
    const oscs = [];
    for (const mult of [0.5, 0.75]) {
      const o = ctx.createOscillator(); o.type = "sine";
      o.frequency.value = 146.83 * mult;
      o.connect(f); o.start(); oscs.push(o);
    }
    return oscs;
  }
  let droneOscs = [];

  function applyVolume() {
    if (ctx) glide(master.gain, muted ? 0 : volume, 0.1);
  }

  window.DuetSound = {
    get ready() { return !!ctx; },

    start() {
      if (ctx) { ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.3;
      master.connect(comp); comp.connect(ctx.destination);
      dry = ctx.createGain(); dry.gain.value = 0.75; dry.connect(master);
      const reverb = ctx.createConvolver(); reverb.buffer = impulse(4.2, 2.6);
      send = ctx.createGain(); send.gain.value = 0.5;
      send.connect(reverb); reverb.connect(master);
      voices.push(makeVoice(0), makeVoice(1));
      chord = makeChord();
      droneOscs = makeDrone();
      applyVolume();
      // A page opened with ?sim starts without a click, and its context starts
      // suspended. The first touch of anything wakes it.
      const wake = () => ctx.resume();
      window.addEventListener("pointerdown", wake);
      window.addEventListener("keydown", wake);
    },

    // One player's voice, every frame.
    //   f         Hz           amp      0..~0.2
    //   pan       -1..1        tension  0 (in tune) .. 1 (far apart)
    //   clarity   0..1, brightens the filter as the two find each other
    voice(i, { f, amp, pan, tension, clarity }) {
      const v = voices[i];
      if (!v) return;
      const t = Math.max(0, Math.min(1, tension));
      glide(v.a.frequency, f, 0.07);
      glide(v.b.frequency, f, 0.07);
      glide(v.c.frequency, f * v.octave, 0.07);
      // The second oscillator drifts out of tune with the first: slow beats
      // that come and go with distance.
      glide(v.b.detune, 4 + 20 * t, 0.2);
      const cents = 5 + 24 * t;
      glide(v.depth.gain, f * (Math.pow(2, cents / 1200) - 1), 0.2);
      glide(v.filter.frequency, 700 + 2400 * clarity, 0.25);
      glide(v.pan.pan, Math.max(-1, Math.min(1, pan)), 0.15);
      glide(v.out.gain, amp, amp > v.out.gain.value ? 0.18 : 0.45);
    },

    // The chord under a meeting: freqs = [bass, tone, tone, tone], level 0..1.
    chord(freqs, level) {
      if (!chord) return;
      const L = Math.max(0, Math.min(1, level));
      chord.notes.forEach((n, k) => {
        const f = freqs[k] || freqs[freqs.length - 1];
        glide(n.o1.frequency, f, 0.25);
        glide(n.o2.frequency, f, 0.25);
      });
      glide(chord.out.gain, 0.2 * L, L > 0.01 ? 0.5 : 0.8);
      glide(chord.shimmer.frequency, (freqs[1] || 220) * 4, 0.3);
      glide(chord.shimmerGain.gain, 0.05 * Math.max(0, (L - 0.6) / 0.4), 0.6);
    },

    // A bell for a fixation: FM, a bright attack that mellows as it dies.
    bell(f, pan, gain) {
      if (!ctx || muted) return;
      const t0 = ctx.currentTime;
      const car = ctx.createOscillator(); car.frequency.value = f;
      const mod = ctx.createOscillator(); mod.frequency.value = f * 3.5;
      const index = ctx.createGain();
      index.gain.setValueAtTime(f * 2.2, t0);
      index.gain.exponentialRampToValueAtTime(f * 0.05, t0 + 1.4);
      mod.connect(index); index.connect(car.frequency);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.6);
      const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
      car.connect(env); env.connect(p); p.connect(dry); p.connect(send);
      car.start(t0); mod.start(t0);
      car.stop(t0 + 2.7); mod.stop(t0 + 2.7);
    },

    // The chord's tones one after another — a harmony found, or the coda.
    arpeggio(freqs, pan, gain = 0.09, step = 0.13) {
      if (!ctx) return;
      freqs.forEach((f, k) => setTimeout(() => this.bell(f, pan, gain), k * step * 1000));
    },

    drone(level) {
      if (!droneGain) return;
      glide(droneGain.gain, Math.max(0, level), 1.5);
    },

    // Re-tunes the drone when the mood (and so the root) changes.
    droneRoot(f) {
      if (!droneOscs.length) return;
      glide(droneOscs[0].frequency, f * 0.5, 0.8);
      glide(droneOscs[1].frequency, f * 0.75, 0.8);
    },

    setVolume(v) { volume = v; applyVolume(); },
    toggleMute() { muted = !muted; applyVolume(); return muted; },
    get muted() { return muted; },
  };
})();
