// LIVE GAZE — a made-up session, for TEST PRINTS (games/live-gaze-test-prints.html).
//
// Every printable sheet can be opened in a mock mode that fills it from this
// instead of from glasses, so a printer can be tried before a real visitor
// ever looks at anything. The data is invented but shaped like the real
// thing: two visitors walking between the images in their own order, coming
// back to some, fixations clustered on a few places per image, durations
// spread like real ones. Seeded, so the same images always give the same
// mock — a test print can be compared with the last one.
//
//   LiveGazeMock.images()  -> the images of the current session, or the
//                             included paintings when there is none
//   LiveGazeMock.session(images, seed) -> { images, players, fix, visitors,
//                                           startedAt, endedAt }
(function () {
  const PLAYERS = [
    { id: 0, label: "P1", color: "#E69F00", name: "orange" },
    { id: 1, label: "P2", color: "#56B4E9", name: "blue" },
  ];

  function rng(seed) {             // mulberry32
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

  async function included() {
    const base = "/images/live-gaze/";
    const res = await fetch(base + "manifest.json", { cache: "no-store" });
    if (!res.ok) return [];
    const list = (await res.json()).images || [];
    const out = [];
    for (const [i, m] of list.entries()) {
      const r = await fetch(base + m.file);
      if (!r.ok) continue;
      const blob = await r.blob();
      out.push({ slot: i, name: m.title || m.file, type: blob.type || "image/jpeg", blob });
    }
    return out;
  }

  // The saved exhibition's images, from the project folder.
  async function exhibited() {
    const ex = await LiveGazeStore.exhibition();
    if (!ex) return [];
    const out = [];
    for (const s of ex.sheets) {
      const r = await fetch(LiveGazeStore.exhibitionUrl(s.file));
      if (r.ok) out.push({ slot: s.slot, name: s.name, type: s.type, blob: await r.blob(), sha256: s.sha256, medium: "print" });
    }
    return out;
  }

  // The session's images when there are any (what will really be printed),
  // then the saved exhibition's (a browser that never chose any), then the
  // paintings that ship with the project.
  async function images() {
    let recs = [];
    try { recs = await LiveGazeStore.all(); } catch (_) { /* no database */ }
    let source = "session";
    if (!recs.length) { recs = await exhibited(); source = "exhibition"; }
    if (!recs.length) { recs = await included(); source = "included"; }
    const out = [];
    for (const r of recs) {
      const l = await LiveGazeStore.load(r);
      if (l) out.push({ slot: r.slot, name: r.name, type: r.type, w: l.w, h: l.h, el: l.el,
                        blob: r.blob, sha256: r.sha256 || null, medium: r.medium || "screen" });
    }
    out.forEach((im, i) => { im.slot = i; });
    out.source = source;
    return out;
  }

  function session(imgs, seed = 7) {
    const r = rng(seed);
    const n = imgs.length;
    // A few places on each image that draw the eye, shared by both visitors
    // so the heatmaps show where they agree.
    const spots = imgs.map(() => Array.from({ length: 4 + Math.floor(r() * 3) },
      () => ({ u: 0.12 + r() * 0.76, v: 0.12 + r() * 0.76 })));
    const plans = [[0, 1, 2, 0, 3, 1], [1, 0, 3, 2, 3]].map((p) => p.map((i) => i % Math.max(1, n)));
    const fix = [];
    const visitors = PLAYERS.map((pl, k) => {
      let t = 1500 + r() * 2000, visit = 0;
      for (const slot of plans[k]) {
        visit++;
        const count = 5 + Math.floor(r() * 10);
        let at = spots[slot][Math.floor(r() * spots[slot].length)];
        for (let j = 0; j < count; j++) {
          if (r() > 0.7) at = spots[slot][Math.floor(r() * spots[slot].length)];
          const u = Math.min(0.98, Math.max(0.02, at.u + gauss(r) * 0.03));
          const v = Math.min(0.98, Math.max(0.02, at.v + gauss(r) * 0.03));
          const dur = Math.round(Math.min(1200, Math.max(100, Math.exp(Math.log(260) + gauss(r) * 0.45))));
          fix.push({ p: pl.id, slot, u, v, dur, start: Math.round(t), visit });
          t += dur + 30 + r() * 40;
        }
        t += 2000 + r() * 4000;      // walking to the next easel
      }
      return { id: pl.id, in: true, finishedAt: Math.round(t + 3000), by: "looked at the dot" };
    });
    fix.sort((a, b) => a.start - b.start);
    const endedAt = Date.now();
    const longest = Math.max(...visitors.map((v) => v.finishedAt));
    return { images: imgs, players: PLAYERS, fix, visitors, startedAt: endedAt - longest, endedAt };
  }

  window.LiveGazeMock = { PLAYERS, images, session };
})();
