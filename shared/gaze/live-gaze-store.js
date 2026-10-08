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
// MAX_IMAGES is a display limit, not a compute one. The bridge decodes one
// scene video and searches it for tags once per pair of glasses no matter how
// many screens are registered, so the cost of a fourth image is a fourth
// monitor to put it on — see the surfaces comment in neon_bridge.py.
(function () {
  const DB = "petrifeye-live-gaze";
  const STORE = "images";
  const META = "meta";
  const MAX_IMAGES = 3;

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
  // Slot 0 keeps tags 0-3 and the bridge's default screen key on purpose: that
  // surface always exists (every other experience uses it), so registering
  // under it REPLACES it instead of adding a duplicate with the same tags.
  const SLOTS = [
    { ids: [0, 1, 2, 3],    key: "main" },
    { ids: [4, 5, 6, 7],    key: "screen-2" },
    { ids: [8, 9, 10, 11],  key: "screen-3" },
  ];

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
    const out = fn(list);
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
    CHANNEL: "live-gaze",          // every window, both directions
    slotInfo: (i) => SLOTS[Number(i)] || null,

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
        });
      });
      // The generation is how a window that was already open notices the set
      // changed under it; the count lets a window say "image 2 of 3".
      t.objectStore(META).put({ at: Date.now(), count: Math.min(images.length, MAX_IMAGES) }, "session");
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
    async claim(display, preferred, boot = null) {
      return mutate((list) => {
        // No bridge to tell sessions apart (webcam-only): a window opened
        // after every image was closed starts the show over.
        if (boot == null && list.length && list.every((x) => x.status === "closed")) {
          list.forEach((_, i) => { list[i] = { status: "queued" }; });
        }
        const mineNow = list.findIndex((x) => x.status === "showing" && x.display === display);
        if (mineNow >= 0) return mineNow;
        let i = (preferred != null && list[preferred] && list[preferred].status === "queued")
          ? preferred : list.findIndex((x) => x.status === "queued");
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
    // files: [{ name, blob }]. Resolves to { where, how }.
    async saveResults(index, imageName, files) {
      const stamp = await this.runStamp();
      const folder = `${String(index + 1).padStart(2, "0")}-${safeName(imageName || "image")}`;
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
      t.objectStore(META).clear();
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
