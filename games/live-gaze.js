// LIVE GAZE — the entry page: pick the images, then open a window per screen.
//
// This page deliberately does NOT load the gaze stack. It is used with a mouse
// before any tracker is running, and it must not claim the webcam or report a
// viewport to a bridge (a bridge maps gaze into the viewport of whichever page
// last reported one, so a setup window doing that would skew the real screens).
(function () {
  const $ = (id) => document.getElementById(id);
  const MAX = LiveGazeStore.MAX_IMAGES;

  let picks = [];   // [{ name, type, blob, w, h, url }]

  // ------------------------------------------------------------- picking
  function err(msg) {
    const el = $("err");
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
  }

  // Measured here, not in the screen window: every coordinate Live Gaze
  // records is normalised against the image's own pixels, so the numbers on
  // the analysis screen ("214px between fixations") mean the same thing
  // whatever the display is. The observer needs the same figures, and getting
  // them here means they are stored once rather than measured twice.
  function measure(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const el = new Image();
      el.onload = () => resolve({
        name: file.name, type: file.type, blob: file,
        w: el.naturalWidth, h: el.naturalHeight, url,
      });
      el.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      el.src = url;
    });
  }

  async function addFiles(files) {
    const imgs = [...files].filter((f) => /^image\//.test(f.type));
    if (!imgs.length) { err("those files are not images."); return; }
    const room = MAX - picks.length;
    if (room <= 0) { err(`three images is the limit — remove one first.`); return; }
    err(imgs.length > room ? `only the first ${room} were added — three is the limit.` : "");

    const measured = (await Promise.all(imgs.slice(0, room).map(measure))).filter(Boolean);
    picks = picks.concat(measured);
    renderPicks();
    await commit();
  }

  function renderPicks() {
    $("picks").innerHTML = picks.map((p, i) => {
      const slot = LiveGazeStore.slotInfo(i);
      return `<div class="pick">
        <img src="${p.url}" alt="" />
        <div class="meta">
          <div class="nm" title="${p.name}">${i + 1} · ${p.name}</div>
          <div class="dim">${p.w} × ${p.h} px</div>
          <div class="tags">tags ${slot.ids.join(" · ")}</div>
          <div class="row">
            <button class="mini" data-up="${i}" ${i === 0 ? "disabled" : ""}>← earlier</button>
            <button class="mini" data-del="${i}">remove</button>
          </div>
        </div>
      </div>`;
    }).join("");

    $("picks").querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        const i = Number(b.dataset.del);
        URL.revokeObjectURL(picks[i].url);
        picks.splice(i, 1);
        renderPicks();
        await commit();
      };
    });
    // Order is not cosmetic: it decides which tag set each image carries, so
    // it has to be changeable before the windows are opened.
    $("picks").querySelectorAll("[data-up]").forEach((b) => {
      b.onclick = async () => {
        const i = Number(b.dataset.up);
        [picks[i - 1], picks[i]] = [picks[i], picks[i - 1]];
        renderPicks();
        await commit();
      };
    });
  }

  // ------------------------------------------------------------- storing
  async function commit() {
    await LiveGazeStore.save(picks);
    renderScreens();
    $("step1").classList.toggle("done", picks.length > 0);
    $("step2").classList.toggle("hidden", picks.length === 0);
    // Windows already open reload themselves rather than keep a stale image.
    if ("BroadcastChannel" in window) {
      const bus = new BroadcastChannel(LiveGazeStore.CHANNEL);
      bus.postMessage({ type: "images-changed", count: picks.length });
      bus.close();
    }
  }

  // ------------------------------------------------------------ launching
  // Named windows: clicking a button twice focuses the window that is already
  // open instead of opening a second copy of the same screen, which would give
  // the bridge two registrations of one screen.
  function openWin(url, name, w, h) {
    const win = window.open(url, name, `popup=yes,width=${w},height=${h}`);
    if (win) win.focus();
    return win;
  }

  const screenUrl = (i) => `live-gaze-screen.html?slot=${i}`;
  const observerUrl = (i) => `live-gaze-observer.html?slot=${i}`;

  function renderScreens() {
    $("screens").innerHTML = picks.map((p, i) => {
      const slot = LiveGazeStore.slotInfo(i);
      return `<div class="scr">
        <div class="n">${i + 1}</div>
        <div>
          <div class="nm">${p.name}</div>
          <div class="sub">${p.w}×${p.h} · tags <b>${slot.ids.join(" ")}</b> · bridge screen <b>${slot.key}</b></div>
        </div>
        <button data-screen="${i}">image ${i + 1}</button>
        <button data-obs="${i}">analysis ${i + 1}</button>
      </div>`;
    }).join("");

    $("screens").querySelectorAll("[data-screen]").forEach((b) => {
      b.onclick = () => openWin(screenUrl(b.dataset.screen), `lg-screen-${b.dataset.screen}`, 1280, 800);
    });
    $("screens").querySelectorAll("[data-obs]").forEach((b) => {
      b.onclick = () => openWin(observerUrl(b.dataset.obs), `lg-obs-${b.dataset.obs}`, 1280, 800);
    });
  }

  $("openAll").onclick = () => {
    // Spaced out: a browser that allows several windows per gesture still
    // drops some when they are opened in the same tick.
    let delay = 0;
    picks.forEach((_, i) => {
      setTimeout(() => openWin(screenUrl(i), `lg-screen-${i}`, 1280, 800), delay);
      setTimeout(() => openWin(observerUrl(i), `lg-obs-${i}`, 1280, 800), delay + 220);
      delay += 440;
    });
  };

  $("again").onclick = async () => {
    picks.forEach((p) => URL.revokeObjectURL(p.url));
    picks = [];
    await LiveGazeStore.clear();
    renderPicks();
    await commit();
    err("");
  };

  // --------------------------------------------------------------- events
  $("drop").onclick = () => $("file").click();
  $("file").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault(); drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault(); drop.classList.remove("over");
  }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer) addFiles(e.dataTransfer.files); });
  // Dropping anywhere on the page works too; without this the browser would
  // NAVIGATE to the dropped file and lose the session.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  // ---------------------------------------------------------------- resume
  // A previous session's images are still in the database. Offering them back
  // matters in a showing: reopening this page after closing a window should
  // not mean re-picking the files with visitors waiting.
  (async () => {
    try {
      const saved = await LiveGazeStore.all();
      if (!saved.length) return;
      picks = saved.map((r) => ({
        name: r.name, type: r.type, blob: r.blob, w: r.w, h: r.h,
        url: URL.createObjectURL(r.blob),
      }));
      renderPicks();
      renderScreens();
      $("step1").classList.add("done");
      $("step2").classList.remove("hidden");
    } catch (_) { /* no database yet, or blocked — the picker still works */ }
  })();
})();
