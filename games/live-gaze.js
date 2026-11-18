// LIVE GAZE — the entry page: pick the images, then open a window per screen.
//
// This page deliberately does NOT load the gaze stack. It is used with a mouse
// before any tracker is running, and it must not claim the webcam or report a
// viewport to a bridge (a bridge maps gaze into the viewport of whichever page
// last reported one, so a setup window doing that would skew the real screens).
(function () {
  const $ = (id) => document.getElementById(id);
  const MAX = LiveGazeStore.MAX_IMAGES;

  let picks = [];   // [{ name, type, blob, w, h, url, medium: "screen" | "print", sha256 }]
  let paper = { size: "A0", tagMm: 120, colors: "painting", place: "beside" };  // LiveGazeStore.paper()
  let saved = null; // the exhibition saved in exhibition/ (LiveGazeStore.exhibition)

  // Printing needs the AprilTags: the purple frame is found by a lit screen's
  // edges, which paper does not have.
  const canPrint = () => !frameMode();
  const mediumOf = (p) => (canPrint() && p.medium === "print" ? "print" : "screen");

  // ------------------------------------------------------- the questions
  // AprilTags or the purple frame, collect data or not: asked here, at the
  // start of the show, and read by every screen and analysis window it opens
  // (SessionSetup.remembered). This page has no gaze stack, so the screens
  // are the ones that switch the bridges.
  const SETUP_NOTES = {
    surface: "In LIVE GAZE the frame can find only <b>one screen</b>: with it, screen 1 shows " +
             "the images one after another. One screen per image needs the AprilTags.",
    collect: "Saved on this Mac, in <b>petrifeye-recordings/live-gaze/</b>, one folder per run: " +
             "each image's fixations, results and analysis picture, written as the image closes. " +
             "Every visitor is calibrated either way.",
  };
  let setup = SessionSetup.remembered("live-gaze");
  const frameMode = () => setup.surface === "frame";

  function renderSetup() {
    $("setupLine").innerHTML =
      `screen found by <b>${frameMode() ? "the purple frame" : "AprilTags"}</b> · ` +
      `data <b>${setup.collect ? "collected" : "not collected"}</b> · ` +
      `<button class="mini" id="setupChange">change</button>`;
    $("setupChange").onclick = askSetup;
    $("frameNote").classList.toggle("hidden", !frameMode() || picks.length < 2);
  }

  async function askSetup() {
    const before = setup;
    setup = await SessionSetup.ask({ app: "live-gaze", notes: SETUP_NOTES });
    renderSetup();
    renderPicks();
    renderScreens();
    // The frame cannot find paper, so with it printed images are shown on the
    // screen instead (mediumOf) — stored that way, so screen 1 takes them in
    // turn. The choice itself is kept for when the tags come back.
    if (setup.surface !== before.surface && picks.some((p) => p.medium === "print")) await commit();
    // Windows already open reload to take new answers — only new ones: this
    // page reopened mid-show must not restart every screen.
    if (setup.surface === before.surface && setup.collect === before.collect) return;
    if ("BroadcastChannel" in window) {
      const bus = new BroadcastChannel(LiveGazeStore.CHANNEL);
      bus.postMessage({ type: "images-changed", count: picks.length });
      bus.close();
    }
  }

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
      // The fingerprint is how a saved exhibition recognises the file later.
      el.onload = async () => resolve({
        name: file.name, type: file.type, blob: file,
        w: el.naturalWidth, h: el.naturalHeight, url, medium: "screen",
        sha256: await LiveGazeStore.sha256(file).catch(() => null),
      });
      el.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      el.src = url;
    });
  }

  async function addFiles(files) {
    const imgs = [...files].filter((f) => /^image\//.test(f.type));
    if (!imgs.length) { err("those files are not images."); return; }
    // Not a design limit: it is how many screens the tag family can label.
    const room = MAX - picks.length;
    if (room <= 0) { err(`${MAX} images is the limit — remove one first.`); return; }
    err(imgs.length > room ? `only the first ${room} were added — ${MAX} is the limit.` : "");

    const measured = (await Promise.all(imgs.slice(0, room).map(measure))).filter(Boolean);
    picks = picks.concat(measured);
    renderPicks();
    await commit();
  }

  function renderPicks() {
    $("picks").innerHTML = picks.map((p, i) => {
      const slot = LiveGazeStore.slotInfo(i);
      const med = mediumOf(p);
      const noPrint = canPrint() ? "" : ` disabled title="printing needs the AprilTags — the purple frame cannot find paper"`;
      return `<div class="pick">
        <img src="${p.url}" alt="" />
        <div class="meta">
          <div class="nm" title="${p.name}">${i + 1} · ${p.name}</div>
          <div class="dim">${p.w} × ${p.h} px</div>
          <div class="tags">tags ${slot.ids.join(" · ")}</div>
          <div class="seg" role="group" aria-label="how image ${i + 1} is shown">
            <button class="mini${med === "screen" ? " on" : ""}" data-med="${i}" data-v="screen">on a screen</button>
            <button class="mini${med === "print" ? " on" : ""}" data-med="${i}" data-v="print"${noPrint}>printed</button>
          </div>
          <div class="row">
            <button class="mini" data-up="${i}" ${i === 0 ? "disabled" : ""}>← earlier</button>
            <button class="mini" data-del="${i}">remove</button>
          </div>
        </div>
      </div>`;
    }).join("");

    $("picks").querySelectorAll("[data-med]").forEach((b) => {
      b.onclick = async () => {
        const p = picks[Number(b.dataset.med)];
        if (!p || p.medium === b.dataset.v) return;
        p.medium = b.dataset.v;
        renderPicks();
        await commit();
      };
    });

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

  // ------------------------------------------------------------ included
  // The images that ship with the project: images/live-gaze/, listed in its
  // manifest.json. A fresh install starts with them, so a show can run
  // without anyone carrying files over. To change them, swap the files and
  // the list in that folder; an empty list ships none. Picking, removing and
  // reordering here work on them exactly as on uploaded ones.
  const INCLUDED = "../images/live-gaze/";

  async function includedImages() {
    try {
      const r = await fetch(INCLUDED + "manifest.json", { cache: "no-store" });
      if (!r.ok) return [];
      const list = ((await r.json()).images || []).slice(0, MAX);
      const files = await Promise.all(list.map(async (m) => {
        const res = await fetch(INCLUDED + m.file);
        if (!res.ok) return null;
        const blob = await res.blob();
        return new File([blob], m.title || m.file, { type: blob.type || "image/jpeg" });
      }));
      return (await Promise.all(files.filter(Boolean).map(measure))).filter(Boolean);
    } catch (_) { return []; }
  }

  async function useIncluded(quiet = false) {
    const got = await includedImages();
    if (!got.length) { if (!quiet) err("no included images — images/live-gaze/ lists none."); return; }
    picks.forEach((p) => URL.revokeObjectURL(p.url));
    picks = got;
    renderPicks();
    await commit();
    err("");
  }

  // ------------------------------------------------------------- storing
  async function commit() {
    await LiveGazeStore.save(picks.map((p) => ({ ...p, medium: mediumOf(p) })));
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
  const overviewUrl = "live-gaze-overview.html";
  // Every printed sheet at once (one per page), or some: ?sheets=1,3
  const printUrl = (list) => `live-gaze-print.html?sheets=${list.join(",")}`;
  const printed = () => picks.map((p, i) => (mediumOf(p) === "print" ? i : -1)).filter((i) => i >= 0);

  function renderScreens() {
    // With the frame there is one screen: image 1's window shows them all.
    const one = frameMode();
    $("frameNote").classList.toggle("hidden", !one || picks.length < 2);
    $("screens").innerHTML = picks.map((p, i) => {
      const slot = LiveGazeStore.slotInfo(i);
      const off = one && i > 0 ? " disabled title=\"the purple frame finds one screen: this image follows on screen 1\"" : "";
      if (mediumOf(p) === "print") {
        const L = LiveGazeStore.paperLayout(paper, p.w, p.h);
        const s = saved && saved.sheets.find((x) => x.slot === i);
        const state = !s ? "not saved yet"
          : s.sha256 !== p.sha256 ? "<span class=\"warn\">a different image is saved for this sheet</span>"
          : "saved";
        const dpi = Math.round(p.w / (L.image.w / 254));
        return `<div class="scr print">
          <div class="n">${i + 1}</div>
          <div>
            <div class="nm">${p.name} <span class="badge">printed</span></div>
            <div class="sub">${L.paper.size} ${L.landscape ? "landscape" : "portrait"} · image ${Math.round(L.image.w / 10)} × ${Math.round(L.image.h / 10)} mm at ${dpi} dpi · tags <b>${slot.ids.join(" ")}</b> at ${L.paper.tagMm} mm · ${state}</div>
          </div>
          <div class="btns">
            <button data-print="${i}" title="the sheet: this image with its four tags, one page">print sheet</button>
          </div>
        </div>`;
      }
      const sub = one
        ? (i === 0 ? "the purple frame · bridge screen <b>main</b>" : "shown on screen 1, after the one before")
        : `tags <b>${slot.ids.join(" ")}</b> · bridge screen <b>${slot.key}</b>`;
      return `<div class="scr">
        <div class="n">${i + 1}</div>
        <div>
          <div class="nm">${p.name}</div>
          <div class="sub">${p.w}×${p.h} · ${sub}</div>
        </div>
        <div class="btns">
          <button data-screen="${i}"${off}>image ${i + 1}</button>
          <button data-obs="${i}"${off}>analysis ${i + 1}</button>
        </div>
      </div>`;
    }).join("");

    $("screens").querySelectorAll("[data-screen]").forEach((b) => {
      b.onclick = () => openWin(screenUrl(b.dataset.screen), `lg-screen-${b.dataset.screen}`, 1280, 800);
    });
    $("screens").querySelectorAll("[data-obs]").forEach((b) => {
      b.onclick = () => openWin(observerUrl(b.dataset.obs), `lg-obs-${b.dataset.obs}`, 1280, 800);
    });
    $("screens").querySelectorAll("[data-print]").forEach((b) => {
      b.onclick = () => printSheets([Number(b.dataset.print)]);
    });
    renderPaper();
  }

  // ---------------------------------------------------------------- paper
  function renderPaper() {
    const list = printed();
    $("paperBox").classList.toggle("hidden", !list.length);
    $("monTags").textContent = LiveGazeStore.MONITOR.ids.join(" ");
    if (!list.length) return;
    $("paperSize").innerHTML = LiveGazeStore.PAPERS
      .map((s) => `<option value="${s}"${s === paper.size ? " selected" : ""}>${s}</option>`).join("");
    $("paperTag").innerHTML = LiveGazeStore.PAPER_TAG_MM
      .map((mm) => `<option value="${mm}"${mm === paper.tagMm ? " selected" : ""}>${mm} mm</option>`).join("");
    $("paperColors").value = paper.colors;
    $("paperPlace").value = paper.place;
    $("printAll").textContent = list.length === 1 ? "print the sheet" : `print all ${list.length} sheets`;
    renderExStatus();
  }

  // What is saved, and whether the current choices still match it.
  let statusToken = 0;
  async function renderExStatus() {
    const token = ++statusToken;
    const el = $("exStatus");
    if (!saved) { el.innerHTML = "No exhibition saved yet — <b>printing saves it</b>."; return; }
    const when = new Date(saved.savedAt).toLocaleString();
    const desc = `${saved.sheets.length} sheet${saved.sheets.length === 1 ? "" : "s"}, ${saved.paper.size}, ` +
      `${saved.paper.tagMm} mm tags ${saved.paper.place === "on" ? "on the image's corners" : "beside the image"}, ` +
      `${saved.paper.colors === "bw" ? "black & white" : "colours from the painting"}`;
    el.innerHTML = `Saved exhibition: <b>${desc}</b> — ${when}. Checking…`;
    const ex = await LiveGazeStore.buildExhibition(records(), paper);
    if (token !== statusToken) return;
    el.innerHTML = LiveGazeStore.sameExhibition(saved, ex)
      ? `Saved exhibition: <b>${desc}</b> — ${when}. These are the sheets the overview tracks.`
      : `Saved exhibition: <b>${desc}</b> — ${when}. <span class="warn">The choices above differ from it</span>: ` +
        `printing saves them as the new exhibition (the old one is kept in exhibition-archive/).`;
  }

  function records() {
    return picks.map((p, i) => ({ slot: i, name: p.name, type: p.type, blob: p.blob, w: p.w, h: p.h,
                                  medium: mediumOf(p), sha256: p.sha256 }));
  }

  async function changePaper(e) {
    const size = $("paperSize").value;
    // A new paper starts with the tag size made for it (120 mm on A0).
    const tagMm = e && e.target === $("paperSize") ? LiveGazeStore.PAPER_TAG_FOR[size] : Number($("paperTag").value);
    paper = { size, tagMm, colors: $("paperColors").value, place: $("paperPlace").value };
    await LiveGazeStore.setPaper(paper);
    paper = await LiveGazeStore.paper();
    renderScreens();
  }
  $("paperSize").onchange = changePaper;
  $("paperTag").onchange = changePaper;
  $("paperColors").onchange = changePaper;
  $("paperPlace").onchange = changePaper;
  $("printAll").onclick = () => printSheets(printed());

  // Printing = saving the exhibition (if it changed), then the print page,
  // which prints from the saved copy. The window is opened at once, inside
  // the click, so the browser does not block it while the images upload.
  let pending = null;
  async function printSheets(slots) {
    err("");
    const ex = await LiveGazeStore.buildExhibition(records(), paper);
    if (!ex.sheets.length) return;
    if (saved && LiveGazeStore.sameExhibition(saved, ex)) { window.open(printUrl(slots), "lg-print"); return; }
    if (saved) {
      pending = { ex, slots };
      $("exConfirmText").innerHTML = `This replaces the saved exhibition (${saved.sheets.length} sheets, ` +
        `${new Date(saved.savedAt).toLocaleString()}). <b>Sheets already printed from it will no longer be ` +
        `tracked</b>; a copy is kept in exhibition-archive/.`;
      $("exConfirm").classList.remove("hidden");
      return;
    }
    await saveAndPrint(ex, slots);
  }

  async function saveAndPrint(ex, slots) {
    $("exConfirm").classList.add("hidden");
    const win = window.open("", "lg-print");
    if (win) win.document.body.innerHTML = "<p style='font:13px ui-monospace,monospace;padding:30px'>saving the exhibition…</p>";
    $("exStatus").innerHTML = "Saving the exhibition into the project folder…";
    try {
      const blobs = new Map(picks.map((p, i) => [i, p.blob]));
      await LiveGazeStore.saveExhibition(ex, blobs);
      saved = await LiveGazeStore.exhibition();
      $("useExhibition").classList.toggle("hidden", !saved);
      renderScreens();
      announce();          // an open overview reloads to track the new sheets
      if (win) win.location.href = printUrl(slots);
      else err("the print window was blocked — allow popups for this site, then press print again.");
    } catch (e) {
      if (win) win.close();
      renderExStatus();
      err(`the exhibition could not be saved (${e.message}) — is PetrifEye's bridge running? Nothing was printed.`);
    }
  }
  $("exReplace").onclick = () => { if (pending) saveAndPrint(pending.ex, pending.slots); pending = null; };
  $("exCancel").onclick = () => { pending = null; $("exConfirm").classList.add("hidden"); };

  function announce() {
    if (!("BroadcastChannel" in window)) return;
    const bus = new BroadcastChannel(LiveGazeStore.CHANNEL);
    bus.postMessage({ type: "images-changed", count: picks.length });
    bus.close();
  }

  // The saved exhibition back into this session: its images, in their sheet
  // order, printed, with its paper — on this computer after other images were
  // used, or on another one with a copy of the project.
  async function useExhibition() {
    const ex = await LiveGazeStore.exhibition();
    if (!ex) { err("no exhibition is saved in the project's exhibition/ folder."); return; }
    const n = Math.max(...ex.sheets.map((s) => s.slot)) + 1;
    const next = [];
    for (let i = 0; i < n; i++) {
      const s = ex.sheets.find((x) => x.slot === i);
      if (!s) {
        // A sheet's tags follow its position, so a gap must keep the image
        // that was shown on screen there.
        if (picks[i] && mediumOf(picks[i]) !== "print") { next.push(picks[i]); continue; }
        err(`the saved exhibition leaves position ${i + 1} to an image on a screen — add one there first.`);
        return;
      }
      const res = await fetch(LiveGazeStore.exhibitionUrl(s.file), { cache: "no-store" });
      if (!res.ok) { err(`exhibition/${s.file} is missing.`); return; }
      const blob = await res.blob();
      const m = await measure(new File([blob], s.name, { type: s.type || blob.type }));
      if (!m) { err(`exhibition/${s.file} is not an image.`); return; }
      m.medium = "print";
      next.push(m);
    }
    picks.forEach((p) => { if (!next.includes(p)) URL.revokeObjectURL(p.url); });
    picks = next;
    paper = ex.paper;
    await LiveGazeStore.setPaper(paper);
    paper = await LiveGazeStore.paper();
    renderPicks();
    await commit();
    err("");
  }

  LiveGazeStore.paper().then((p) => { paper = p; renderScreens(); }).catch(() => {});
  LiveGazeStore.exhibition().then((ex) => {
    saved = ex;
    $("useExhibition").classList.toggle("hidden", !saved);
    renderScreens();
  });

  $("openOverview").onclick = () => openWin(overviewUrl, "lg-overview", 1440, 900);

  $("openAll").onclick = async () => {
    // Opening every window starts the show over: all images unseen again.
    // Windows already open reload and pick their images afresh.
    await LiveGazeStore.resetProgress();
    announce();
    // Spaced out: a browser that allows several windows per gesture still
    // drops some when they are opened in the same tick. Printed images have
    // no window of their own: the overview tracks them.
    let delay = 0;
    picks.slice(0, frameMode() ? 1 : picks.length).forEach((p, i) => {
      if (mediumOf(p) === "print") return;
      setTimeout(() => openWin(screenUrl(i), `lg-screen-${i}`, 1280, 800), delay);
      delay += 300;
    });
    setTimeout(() => openWin(overviewUrl, "lg-overview", 1440, 900), delay);
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
  $("useIncluded").onclick = () => useIncluded();
  $("useExhibition").onclick = () => useExhibition();
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

  renderSetup();
  askSetup();

  // ---------------------------------------------------------------- resume
  // A previous session's images are still in the database. Offering them back
  // matters in a showing: reopening this page after closing a window should
  // not mean re-picking the files with visitors waiting.
  (async () => {
    try {
      const stored = await LiveGazeStore.all();
      // Nothing picked yet on this computer: start from the included images.
      if (!stored.length) { await useIncluded(true); return; }
      picks = stored.map((r) => ({
        name: r.name, type: r.type, blob: r.blob, w: r.w, h: r.h,
        url: URL.createObjectURL(r.blob), medium: r.medium || "screen", sha256: r.sha256 || null,
      }));
      // Images stored before fingerprints existed get theirs now.
      for (const p of picks) if (!p.sha256) p.sha256 = await LiveGazeStore.sha256(p.blob).catch(() => null);
      renderPicks();
      renderScreens();
      $("step1").classList.add("done");
      $("step2").classList.remove("hidden");
    } catch (_) { /* no database yet, or blocked — the picker still works */ }
  })();
})();
