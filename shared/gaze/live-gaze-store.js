// The uploaded image set for LIVE GAZE, shared between windows.
//
// Live Gaze opens one window per image plus one analysis window per image, and
// all of them need the same pixels. IndexedDB is how they get them:
//
//   - It holds Blobs. A data: URL of a 4MB photograph, passed around as a
//     string, would be ~5.5MB of base64 in every window's memory and would
//     blow past localStorage's ~5MB quota on the first upload.
//   - It survives the window.open() hop and a reload of any window, so an
//     analysis screen can be opened, closed and reopened mid-session without
//     asking the visitor to pick the files again.
//   - Every window reads it independently, so nothing has to be shipped over
//     the BroadcastChannel except coordinates.
//
// There is no practical limit on images. Each one can have its own screen,
// and the bridge decodes one scene video and searches it for tags once per
// pair of glasses no matter how many screens are registered — see the
// surfaces comment in neon_bridge.py. Nor does every image need a display:
// screens draw from one queue, so two screens can show ten images in turn.
// MAX_IMAGES is only what the tag family can label: four tags per screen out
// of tag36h11's 587 ids (the bridge rejects any id outside 0..586), less the
// four the overview monitor wears (MONITOR, below).
(function () {
  const DB = "petrifeye-live-gaze";
  const STORE = "images";
  const META = "meta";
  const TAG_IDS = 587;                        // tag36h11
  // The overview monitor's own tags: the last full set, which no image slot
  // uses — slots stop just below it.
  const MONITOR = { key: "monitor", ids: [580, 581, 582, 583] };
  const MAX_IMAGES = MONITOR.ids[0] / 4;      // 145

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "slot" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, stores, mode) {
    const t = db.transaction(stores, mode);
    return {
      t,
      done: new Promise((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
    };
  }

  const request = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  // Which four AprilTags each screen draws, and the key it registers with the
  // bridge. Two displays showing the SAME four tags are one surface as far as
  // the scene camera is concerned — the detector cannot tell them apart and
  // gaze lands on whichever it solved last — so every slot gets its own set.
  //
  // Slot N draws tags 4N..4N+3 and registers as "screen-<N+1>" — the same
  // sets and keys the first three always had, so a bridge or a printed tag
  // sheet from before still matches.
  //
  // Slot 0 keeps tags 0-3 and the bridge's default screen key on purpose: that
  // surface always exists (every other experience uses it), so registering
  // under it REPLACES it instead of adding a duplicate with the same tags.
  function slotInfo(i) {
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n >= MAX_IMAGES) return null;
    return {
      ids: [4 * n, 4 * n + 1, 4 * n + 2, 4 * n + 3],
      key: n === 0 ? "main" : `screen-${n + 1}`,
    };
  }

  // ------------------------------------------------------------- paper
  // An image can be PRINTED instead of shown: a sheet with the image and four
  // tags, laid out by the same rule as a screen (the largest image that stays
  // clear of the corner tags), so the glasses find it exactly as they find a
  // display. The sheet registers with the bridge as a screen of its own, in
  // tenths of a millimetre, with its OWN tag size and inset (the on-screen tag
  // slider must not move tags that are already on paper).
  //
  // Scale does not matter: gaze is mapped through the four tags, so a printer
  // that shrinks the whole page a little ("fit to page") changes nothing. What
  // must not change after printing is the layout — the paper size, the tag
  // size, or the image itself — so the sheet must be printed again after any
  // of those changes.
  const PAPERS = {                       // landscape, 0.1 mm
    A0: [11890, 8410], A3: [4200, 2970], A4: [2970, 2100], Letter: [2794, 2159],
  };
  const PAPER_DEFAULT = { size: "A4", tagMm: 45, colors: "painting" };
  // Tags are read from about 20 times their own size away (45 mm from ~1 m);
  // the big ones are for sheets looked at from across a room.
  const PAPER_TAG_MM = [30, 45, 60, 80, 100, 120, 150];
  // What each paper starts with when chosen: A0 is looked at from 1-2.5 m.
  const PAPER_TAG_FOR = { A0: 120, A3: 60, A4: 45, Letter: 45 };
  // Inset of the tags from the paper's edge, and the gap between tags and
  // image. Printers leave a few mm unprinted, and a tag clipped by even a
  // little cannot be read. A0 sheets stand on easels, whose ledge and clamps
  // cover the edges, so their tags sit 4 cm in.
  const PAPER_EDGE = {
    A0: { margin: 400, gap: 120 },
    other: { margin: 80, gap: 30 },      // 8 mm, 3 mm
  };
  // Tag colours: "painting" takes a dark and a light tone from the image
  // itself (tonesOf), "bw" prints them black on white.
  const PAPER_COLORS = ["painting", "bw"];

  function normPaper(p) {
    const size = p && PAPERS[p.size] ? p.size : PAPER_DEFAULT.size;
    const tagMm = p && PAPER_TAG_MM.includes(Number(p.tagMm)) ? Number(p.tagMm) : PAPER_TAG_FOR[size];
    const colors = p && PAPER_COLORS.includes(p.colors) ? p.colors : PAPER_DEFAULT.colors;
    return { size, tagMm, colors };
  }

  // The sheet for one image, in 0.1 mm. The print page draws exactly this and
  // the overview registers exactly this, so they cannot differ — and once
  // printed it is frozen in the saved exhibition (below), so a later change to
  // this code cannot move the tags of sheets already on the wall either.
  function paperLayout(paper, imgW, imgH) {
    const pp = normPaper(paper);
    const [L, S] = PAPERS[pp.size];
    const landscape = !(imgH > imgW);
    const W = landscape ? L : S, H = landscape ? S : L;
    const edge = PAPER_EDGE[pp.size] || PAPER_EDGE.other;
    const size = pp.tagMm * 10, margin = edge.margin;
    const aspect = imgW && imgH ? imgW / imgH : 1.5;
    // The screen's imageRect(), on paper: as tall as the page between the tag
    // columns, or as wide as it between the tag rows, whichever is bigger.
    const pad = margin;
    const F = margin + size + edge.gap;
    const fullH = Math.min((W - 2 * pad) / aspect, H - 2 * pad);
    const betweenRows = Math.min((W - 2 * pad) / aspect, H - 2 * F);
    const betweenCols = Math.min((W - 2 * F) / aspect, H - 2 * pad);
    const h = Math.min(fullH, Math.max(betweenRows, betweenCols, 40));
    const w = h * aspect;
    return {
      paper: pp, landscape, w: W, h: H, size, margin, gap: edge.gap,
      // Same order as the bridge's marker_verts: TL, TR, BR, BL.
      tags: [
        { x: margin, y: margin }, { x: W - margin - size, y: margin },
        { x: W - margin - size, y: H - margin - size }, { x: margin, y: H - margin - size },
      ],
      image: { x: (W - w) / 2, y: (H - h) / 2, w, h },
    };
  }

  // ------------------------------------------------------------ tones
  // The sheet's colours, taken from the painting: its passe-partout and the
  // tags' light cells in a light tone of the image, the tags' dark cells in a
  // dark one. The detector only sees grey levels, so what matters is the
  // contrast between the two, not the hue: in a simulation of the Neon scene
  // camera (120 mm tags, 1-4.5 m, straight on and at 40 degrees, dim light,
  // video compression) tags in tones taken this way from Manet, Holbein,
  // Degas and two cartoons were read as far as black-on-white ones, PROVIDED
  // the dark tone is near black and the light one no darker than a light
  // beige. So the tones keep the painting's hue but are pushed until they are.
  const TONE_DARK_MAX = 0.03;     // relative luminance, 0..1
  const TONE_LIGHT_MIN = 0.60;

  const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const toSrgb = (l) => {
    l = Math.min(1, Math.max(0, l));
    return 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
  };
  const lumOf = (lin) => 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v)))
    .toString(16).padStart(2, "0")).join("");

  // The mean colour of the image's darkest 4 % and lightest 8 % of pixels,
  // then the contrast rule above.
  const tonesCache = new WeakMap();      // Blob -> Promise, per window
  function tonesOf(blob) {
    if (!tonesCache.has(blob)) tonesCache.set(blob, measureTones(blob));
    return tonesCache.get(blob);
  }

  async function measureTones(blob) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) {
      px.push([d[i], d[i + 1], d[i + 2], lumOf([toLin(d[i]), toLin(d[i + 1]), toLin(d[i + 2])])]);
    }
    px.sort((a, b) => a[3] - b[3]);
    const mean = (list) => [0, 1, 2].map((j) => list.reduce((s, p) => s + p[j], 0) / list.length);
    const n = px.length;
    let dark = mean(px.slice(0, Math.max(1, Math.floor(n * 0.04)))).map(toLin);
    let light = mean(px.slice(n - Math.max(1, Math.floor(n * 0.08)))).map(toLin);
    // Darker: scale down (same hue). Lighter: mix towards white.
    if (lumOf(dark) > TONE_DARK_MAX) dark = dark.map((v) => v * TONE_DARK_MAX / lumOf(dark));
    if (lumOf(light) < TONE_LIGHT_MIN) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 30; i++) {
        const t = (lo + hi) / 2;
        if (lumOf(light.map((v) => v * (1 - t) + t)) < TONE_LIGHT_MIN) lo = t; else hi = t;
      }
      light = light.map((v) => v * (1 - hi) + hi);
    }
    return { dark: hex(dark.map(toSrgb)), light: hex(light.map(toSrgb)) };
  }

  const BW = { dark: "#000000", light: "#ffffff" };

  // An image's fingerprint: how the saved exhibition recognises a file.
  async function sha256(blob) {
    const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ------------------------------------------------------- exhibition
  // The PRINTED sheets, frozen. Once a sheet is on paper its tags and layout
  // must never change, so printing saves them — with each image's original
  // file — into the project folder, exhibition/, through the bridge:
  //
  //   exhibition/exhibition.json   paper, and per sheet: slot, file, name,
  //                                fingerprint, tags, bridge key, layout, tones
  //   exhibition/<NN-name>.<ext>   the image, byte for byte
  //
  // The print page prints from there and the overview tracks from there, so
  // the paper on the easel and what the glasses look for always agree —
  // whatever is uploaded later, on this computer or another one with a copy
  // of the project. Replacing it moves the old one to exhibition-archive/.
  const EXHIBITION = "/exhibition/";

  async function exhibition() {
    try {
      const r = await fetch(EXHIBITION + "exhibition.json", { cache: "no-store" });
      if (!r.ok) return null;
      const ex = await r.json();
      return ex && Array.isArray(ex.sheets) ? ex : null;
    } catch (_) { return null; }
  }

  // The exhibition the current choices would print: every printed image, its
  // sheet laid out and coloured with the current paper settings.
  async function buildExhibition(records, paper) {
    const pp = normPaper(paper);
    const sheets = [];
    for (const r of records) {
      if (r.medium !== "print") continue;
      const info = slotInfo(r.slot);
      const ext = ((r.name || "").match(/\.(jpe?g|png|webp)$/i) || [, (r.type || "").split("/")[1] || "jpg"])[1]
        .toLowerCase().replace("jpeg", "jpg");
      sheets.push({
        slot: r.slot,
        file: `${String(r.slot + 1).padStart(2, "0")}-${safeName(r.name)}.${ext}`,
        name: r.name, type: r.type || "image/jpeg", w: r.w, h: r.h,
        sha256: r.sha256 || await sha256(r.blob),
        key: info.key, ids: info.ids,
        layout: paperLayout(pp, r.w, r.h),
        tones: pp.colors === "painting" ? await tonesOf(r.blob) : { ...BW },
      });
    }
    return { version: 1, app: "live-gaze", paper: pp, monitor: { ...MONITOR }, sheets };
  }

  // Same exhibition? Everything that decides what is on paper.
  function sameExhibition(a, b) {
    if (!a || !b || a.sheets.length !== b.sheets.length) return false;
    const pick = (ex) => JSON.stringify({
      paper: ex.paper,
      sheets: ex.sheets.map((s) => [s.slot, s.sha256, s.ids, s.key, s.layout, s.tones]),
    });
    return pick(a) === pick(b);
  }

  // Write it (bridge: POST /api/exhibition, from this Mac only). blobs:
  // slot -> Blob of the original file.
  async function saveExhibition(ex, blobs) {
    const body = { ...ex, savedAt: new Date().toISOString(), files: [] };
    for (const s of ex.sheets) {
      body.files.push({ name: s.file, data: await blobToBase64(blobs.get(s.slot)) });
    }
    const r = await fetch("/api/exhibition", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.text().catch(() => "")) || `HTTP ${r.status}`);
    return r.json();
  }

  function normProgress(p, m) {
    const n = (m && m.count) || 0;
    const list = (p && Array.isArray(p.images)) ? p.images.slice(0, n) : [];
    while (list.length < n) list.push({ status: "queued" });
    return list;
  }

  // runAt names the results folder. A RUN is one pass through the images:
  // it starts at the first image shown after an upload, or when the show is
  // started over (resetProgress) — so a second run of the same images gets
  // its own folder instead of overwriting the first one's results.
  //
  // boot: the bridge's BOOT_ID, when there is a bridge. The queue lives in
  // the browser and outlives the app, so a queue recorded under a different
  // bridge run belongs to an earlier session: it is started over, all
  // images unseen. A reload within the same session keeps it.
  async function mutate(fn, newRun = false, boot = null) {
    const db = await openDb();
    const { t, done } = tx(db, [META], "readwrite");
    const store = t.objectStore(META);
    const [p, m] = await Promise.all([request(store.get("progress")), request(store.get("session"))]);
    const list = normProgress(p, m);
    // A queue with NO boot recorded predates this check: also an old session.
    const stale = boot != null && p && p.boot !== boot;
    if (stale) list.forEach((_, i) => { list[i] = { status: "queued" }; });
    const out = fn(list, m || {});
    const runAt = (!newRun && !stale && p && p.runAt) || Date.now();
    store.put({ images: list, at: Date.now(), runAt, boot: boot ?? (p && p.boot) ?? null }, "progress");
    await done;
    db.close();
    if ("BroadcastChannel" in window) {
      const bus = new BroadcastChannel("live-gaze");
      bus.postMessage({ type: "progress", images: list, slot: -1 });
      bus.close();
    }
    return out;
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  function sessionStamp(at) {
    const d = new Date(at || Date.now());
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
           `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }
  const safeName = (s) => String(s).replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_").trim().slice(0, 60) || "image";

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  window.LiveGazeStore = {
    MAX_IMAGES,
    MONITOR,
    CHANNEL: "live-gaze",          // every window, both directions
    slotInfo,
    PAPERS: Object.keys(PAPERS),
    PAPER_TAG_MM,
    PAPER_TAG_FOR,
    paperLayout,
    tonesOf,
    sha256,
    exhibition,
    buildExhibition,
    sameExhibition,
    saveExhibition,
    exhibitionUrl: (file) => EXHIBITION + encodeURIComponent(file),
    sessionStamp,

    // The paper and tag size for printed images. Kept apart from the image
    // set, so changing it does not start the show over — but every sheet
    // must be printed again (the tracking windows reload to follow it).
    async paper() {
      const db = await openDb();
      const { t } = tx(db, [META], "readonly");
      const p = await request(t.objectStore(META).get("paper"));
      db.close();
      return normPaper(p);
    },

    async setPaper(p) {
      const db = await openDb();
      const { t, done } = tx(db, [META], "readwrite");
      t.objectStore(META).put(normPaper(p), "paper");
      await done;
      db.close();
    },

    // Replace the whole set in one transaction. Partial writes would leave a
    // screen window pointing at an image that is no longer in the show.
    async save(images) {
      const db = await openDb();
      const { t, done } = tx(db, [STORE, META], "readwrite");
      const store = t.objectStore(STORE);
      store.clear();
      images.slice(0, MAX_IMAGES).forEach((im, i) => {
        store.put({
          slot: i,
          name: im.name,
          type: im.type || "image/jpeg",
          blob: im.blob,
          w: im.w,
          h: im.h,
          medium: im.medium === "print" ? "print" : "screen",
          sha256: im.sha256 || null,
        });
      });
      // The generation is how a window that was already open notices the set
      // changed under it; the count lets a window say "image 2 of 3". media:
      // which images are printed — read where only this meta is at hand (the
      // queue, below).
      const kept = images.slice(0, MAX_IMAGES);
      t.objectStore(META).put({
        at: Date.now(), count: kept.length,
        media: kept.map((im) => (im.medium === "print" ? "print" : "screen")),
      }, "session");
      t.objectStore(META).delete("progress");    // a new set starts unseen
      await done;
      db.close();
    },

    // ------------------------------------------------------- progress
    // Which image each display is showing, and which have been closed. Kept
    // here rather than in any one window because every screen window draws
    // from the same queue: "next image" must never hand two displays the
    // same image, and a reloaded window must carry on where it was. Each
    // change happens inside ONE readwrite transaction, which IndexedDB runs
    // atomically — two displays pressing "next" at once get different images.
    //
    // status per image: "queued" | "showing" (with .display) | "closed"
    async progress() {
      const db = await openDb();
      const { t } = tx(db, [META], "readonly");
      const [p, m] = await Promise.all([
        request(t.objectStore(META).get("progress")),
        request(t.objectStore(META).get("session")),
      ]);
      db.close();
      return normProgress(p, m);
    },

    // Give `display` an image: `preferred` if it is free (or already this
    // display's), otherwise the first unseen one. Returns its index, or null
    // when every image has been shown.
    //
    // A PRINTED image is on its own sheet for the whole show, tracked by the
    // overview: no screen ever takes it.
    async claim(display, preferred, boot = null) {
      return mutate((list, m) => {
        const media = m.media || [];
        const takes = (i) => media[i] !== "print";
        // No bridge to tell sessions apart (webcam-only): a window opened
        // after every image was closed starts the show over.
        if (boot == null && list.length && list.every((x) => x.status === "closed")) {
          list.forEach((_, i) => { list[i] = { status: "queued" }; });
        }
        const mineNow = list.findIndex((x) => x.status === "showing" && x.display === display);
        if (mineNow >= 0) return mineNow;
        let i = (preferred != null && list[preferred] && list[preferred].status === "queued" && takes(preferred))
          ? preferred : list.findIndex((x, j) => x.status === "queued" && takes(j));
        if (i < 0) return null;
        list[i] = { status: "showing", display };
        return i;
      }, false, boot);
    },

    async close(index) {
      return mutate((list) => {
        if (list[index]) list[index] = { status: "closed", closedAt: Date.now() };
        return null;
      });
    },

    // Start the queue over (same images, nothing seen).
    async resetProgress() {
      return mutate((list) => { list.forEach((_, i) => { list[i] = { status: "queued" }; }); return null; }, true);
    },

    async runStamp() {
      const db = await openDb();
      const { t } = tx(db, [META], "readonly");
      const p = await request(t.objectStore(META).get("progress"));
      db.close();
      return sessionStamp(p && p.runAt);
    },

    // ---------------------------------------------------------- saving
    // Where a closed image's results go:
    //   ~/petrifeye-recordings/live-gaze/<session>/<NN-image name>/<file>
    // written by the bridge (POST /api/save-analysis, accepted from this Mac
    // only). Without a bridge — the webcam-only server has no such endpoint —
    // each file is downloaded instead, so nothing is ever lost silently.
    // files: [{ name, blob }]. stamp: the run's folder, when the caller
    // read it earlier (default: the current run). Resolves to { where, how }.
    async saveResults(index, imageName, files, stamp = null) {
      stamp = stamp || await this.runStamp();
      const folder = `${String(index + 1).padStart(2, "0")}-${safeName(imageName || "image")}`;
      return this.saveFolder(stamp, folder, files);
    },

    // Same, into any folder of the run: the overview saves a whole session of
    // every image at once, as <session>/<folder>/.
    async saveFolder(stamp, folder, files) {
      try {
        const payload = { session: stamp, image: folder, files: [] };
        for (const f of files) {
          payload.files.push({ name: f.name, data: await blobToBase64(f.blob) });
        }
        const r = await fetch("/api/save-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const res = await r.json();
        return { where: res.path, how: "saved" };
      } catch (_) {
        for (const f of files) download(f.blob, `live-gaze_${stamp}_${folder}_${f.name}`);
        return { where: "your Downloads folder", how: "downloaded" };
      }
    },

    async all() {
      const db = await openDb();
      const { t } = tx(db, [STORE], "readonly");
      const list = await request(t.objectStore(STORE).getAll());
      db.close();
      return (list || []).sort((a, b) => a.slot - b.slot);
    },

    async get(slot) {
      const db = await openDb();
      const { t } = tx(db, [STORE], "readonly");
      const rec = await request(t.objectStore(STORE).get(Number(slot)));
      db.close();
      return rec || null;
    },

    async session() {
      const db = await openDb();
      const { t } = tx(db, [META], "readonly");
      const m = await request(t.objectStore(META).get("session"));
      db.close();
      return m || { at: 0, count: 0 };
    },

    async clear() {
      const db = await openDb();
      const { t, done } = tx(db, [STORE, META], "readwrite");
      t.objectStore(STORE).clear();
      // Not the paper settings: those describe the printer, not the images.
      t.objectStore(META).delete("session");
      t.objectStore(META).delete("progress");
      await done;
      db.close();
    },

    // Decode a stored record into something drawable, keeping the natural
    // size: every coordinate in Live Gaze is normalised against the image, so
    // the observer needs the same w/h the viewer measured.
    load(rec) {
      return new Promise((resolve) => {
        if (!rec || !rec.blob) return resolve(null);
        const url = URL.createObjectURL(rec.blob);
        const el = new Image();
        el.onload = () => resolve({ el, w: el.naturalWidth, h: el.naturalHeight, url });
        el.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        el.src = url;
      });
    },
  };
})();
