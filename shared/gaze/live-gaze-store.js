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
      await done;
      db.close();
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
