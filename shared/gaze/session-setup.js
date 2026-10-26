// The two questions every experience asks before anything else:
//
//   1. How should the eye trackers find the screen — the AprilTags in the
//      corners, or the purple frame around the edge?
//   2. Collect data from this session, or just play?
//
// Asked as pop-ups over the boot card, one after the other, every time an
// experience opens: the room, the lighting and the purpose change from one
// session to the next, and a choice made yesterday must not silently apply.
// The last answers are remembered only to highlight them.
//
//   SessionSetup.ask({ app, surface: true, collect: true, notes })
//     -> Promise<{ surface: "tags" | "frame", collect: bool }>
//
// The surface choice is applied the moment it is made, to the page AND every
// bridge (GazeAggregator.setSurfaceSource), so the frame or the tags are
// already on screen while the second question is read. The data choice is
// read by shared/gaze/data-collection.js (and by LIVE GAZE directly).
//
// URL overrides, for testing and for windows opened by another page:
//   ?surface=tags|frame   ?collect=1|0
// ?sim (mouse + arrows) skips both questions: there is no screen to find, and
// it collects only when ?collect says so.
(function () {
  const KEY = "petrifeye-session-setup";
  const params = new URLSearchParams(location.search);

  function appFromPath() {
    const m = /([^/]+?)(?:\.html)?$/.exec(location.pathname);
    return (m && m[1] && m[1] !== "index") ? m[1] : "petrifeye";
  }

  function readAll() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) { return {}; }
  }
  function stored(app) { return readAll()[app] || null; }
  function store(app, choice) {
    try {
      const all = readAll();
      all[app] = { ...choice, at: Date.now() };
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (_) { /* private window: nothing to remember, nothing lost */ }
  }

  function urlSurface() {
    const v = params.get("surface");
    return v === "tags" || v === "frame" ? v : null;
  }
  function urlCollect() {
    if (!params.has("collect")) return null;
    return !/^(0|no|false|off)$/i.test(params.get("collect") || "1");
  }

  // What the bridge serving this page is set to now, for the highlight when
  // there is no earlier answer. null without a bridge (webcam only).
  async function bridgeSource() {
    try {
      const r = await fetch("/markers/layout.json", { cache: "no-store" });
      if (!r.ok) return null;
      const cfg = await r.json();
      return cfg.source === "frame" || cfg.source === "tags" ? cfg.source : null;
    } catch (_) { return null; }
  }

  // Page and bridges together; see GazeAggregator.setSurfaceSource. A page
  // without the gaze stack (LIVE GAZE's upload page) only stores the answer.
  function apply(surface) {
    if (window.GazeAggregator && GazeAggregator.setSurfaceSource) GazeAggregator.setSurfaceSource(surface);
    else if (window.Markers && Markers.useSource) Markers.useSource(surface);
  }

  // ---------------------------------------------------------------- look
  const CSS = `
  .psu { position:fixed; inset:0; z-index:3000; display:flex; align-items:center; justify-content:center;
         background:rgba(0,0,0,.82); font-family:var(--gaze-mono, ui-monospace, Menlo, monospace);
         color:#e8e6e2; padding:20px; box-sizing:border-box; }
  .psu-card { width:min(680px, 100%); background:#0b0d12; border:1px solid #23252c; padding:30px 30px 24px;
              box-shadow:0 24px 80px rgba(0,0,0,.6); }
  .psu-eyebrow { font-size:9.5px; letter-spacing:.36em; text-transform:uppercase; color:#6a6a6a; margin:0 0 10px; }
  .psu-q { font-size:19px; font-weight:300; letter-spacing:.04em; line-height:1.4; margin:0 0 22px; }
  .psu-opts { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:560px) { .psu-opts { grid-template-columns:1fr; } }
  .psu-opt { text-align:left; font:inherit; color:inherit; background:#07080c; border:1px solid #2a2c33;
             padding:16px 16px 14px; cursor:pointer; display:flex; flex-direction:column; gap:8px;
             transition:border-color .15s, background .15s; }
  .psu-opt:hover, .psu-opt.hi { border-color:var(--gaze-red, #ff3b3b); background:rgba(255,59,59,.07); }
  .psu-opt:focus-visible { outline:2px solid var(--gaze-red, #ff3b3b); outline-offset:2px; }
  .psu-name { display:flex; align-items:center; gap:10px; font-size:13px; letter-spacing:.16em; text-transform:uppercase; }
  .psu-key { margin-left:auto; font-size:10px; color:#6a6a6a; border:1px solid #2a2c33; padding:1px 6px; letter-spacing:0; }
  .psu-desc { font-size:11.5px; line-height:1.65; color:#8d8b88; }
  .psu-note { font-size:11.5px; line-height:1.75; color:#9a9895; margin:20px 0 0; padding-top:16px; border-top:1px solid #1c1e24; }
  .psu-note b { color:#c98f8f; font-weight:600; }
  .psu-foot { font-size:10px; color:#55545a; margin:14px 0 0; letter-spacing:.06em; }
  .psu-ico-tags { width:14px; height:14px; background:#fff; position:relative; flex:none; }
  .psu-ico-tags::after { content:""; position:absolute; inset:3px; background:#000;
                         box-shadow:inset 3px 3px 0 #fff; }
  .psu-ico-frame { width:18px; height:12px; border:2.5px solid #ff00ff; box-sizing:border-box; flex:none; }
  .psu-ico-rec { width:10px; height:10px; border-radius:50%; background:#ff3b3b; flex:none; }
  .psu-ico-off { width:10px; height:10px; border-radius:50%; border:1.5px solid #6a6a6a; box-sizing:border-box; flex:none; }
  `;
  function injectCss() {
    if (document.getElementById("psu-css")) return;
    const st = document.createElement("style");
    st.id = "psu-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // One question as a pop-up. options: [{ value, name, icon, desc }].
  // Resolves with the chosen value. 1/2 (or ←/→ and return) for keyboards.
  function popup({ eyebrow, question, options, note, highlight }) {
    injectCss();
    return new Promise((resolve) => {
      const el = document.createElement("div");
      el.className = "psu";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.innerHTML = `<div class="psu-card">
        <p class="psu-eyebrow">${eyebrow}</p>
        <p class="psu-q">${question}</p>
        <div class="psu-opts">${options.map((o, i) => `
          <button class="psu-opt" data-i="${i}">
            <span class="psu-name"><span class="psu-ico-${o.icon}"></span>${o.name}<span class="psu-key">${i + 1}</span></span>
            <span class="psu-desc">${o.desc}</span>
          </button>`).join("")}
        </div>
        ${note ? `<p class="psu-note">${note}</p>` : ""}
        <p class="psu-foot">click, or press 1 / 2 · return takes the highlighted one</p>
      </div>`;
      const buttons = [...el.querySelectorAll(".psu-opt")];
      let hi = Math.max(0, options.findIndex((o) => o.value === highlight));
      const mark = () => buttons.forEach((b, i) => b.classList.toggle("hi", i === hi));
      mark();

      const done = (i) => {
        window.removeEventListener("keydown", onKey, true);
        el.remove();
        resolve(options[i].value);
      };
      // Capture phase, and nothing gets past it: the experience's own keys
      // (r, s, m …) must not act on a page the visitor cannot see yet.
      function onKey(e) {
        e.stopImmediatePropagation();
        if (e.key === "1" || e.key === "2") { e.preventDefault(); done(Number(e.key) - 1); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); hi = 0; mark(); }
        else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); hi = 1; mark(); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); done(hi); }
      }
      window.addEventListener("keydown", onKey, true);
      buttons.forEach((b, i) => {
        b.onclick = () => done(i);
        b.onmouseenter = () => { hi = i; mark(); };
      });
      document.body.appendChild(el);
    });
  }

  // ----------------------------------------------------------- questions
  const SURFACE_OPTIONS = [
    { value: "tags", name: "AprilTags", icon: "tags",
      desc: "Four black-and-white codes in the corners of the screen. Reliable in any light, and the only way to tell several screens apart." },
    { value: "frame", name: "Purple frame", icon: "frame",
      desc: "A thin purple line around the edge of the screen. Nothing in the corners, nothing over the picture." },
  ];
  const SURFACE_NOTE =
    "The <b>purple frame</b> works best in a <b>dark room</b>, where the lit screen stands out clearly " +
    "to the eye trackers' cameras. In a bright room, or if gaze keeps dropping out, use the AprilTags.";

  const COLLECT_OPTIONS = [
    { value: true, name: "Collect data", icon: "rec",
      desc: "Saves where each player looked — every fixation, in order, with how long it lasted — and a scanpath picture." },
    { value: false, name: "Just play", icon: "off",
      desc: "Nothing is saved." },
  ];
  const collectNote = (app) =>
    `Saved on this Mac, in <b>petrifeye-recordings/${app}/</b>, one folder per session. ` +
    "Before play starts, each player looks at five eyes to calibrate (about ten seconds); " +
    "nothing seen while calibrating is saved.";

  let choice = null;

  async function ask(opts = {}) {
    const app = opts.app || appFromPath();
    const notes = opts.notes || {};
    const prev = stored(app) || {};
    const sim = params.has("sim");

    let surface = urlSurface();
    if (!surface && opts.surface !== false && !sim) {
      const highlight = prev.surface || await bridgeSource() || "tags";
      surface = await popup({
        eyebrow: "screen tracking",
        question: "How should the eye trackers find the screen?",
        options: SURFACE_OPTIONS,
        note: SURFACE_NOTE + (notes.surface ? `<br><br>${notes.surface}` : ""),
        highlight,
      });
    }
    surface = surface || prev.surface || "tags";
    if (opts.surface !== false) apply(surface);

    let collect = urlCollect();
    if (collect == null && opts.collect !== false && !sim) {
      collect = await popup({
        eyebrow: "data collection",
        question: "Collect data from this session?",
        options: COLLECT_OPTIONS,
        note: notes.collect || collectNote(app),
        highlight: prev.collect === true,
      });
    }
    collect = !!collect;

    choice = { app, surface, collect };
    if (!sim) store(app, { surface, collect });
    window.dispatchEvent(new CustomEvent("session-setup", { detail: { ...choice } }));
    return { ...choice };
  }

  window.SessionSetup = {
    ask,
    apply,
    // The answers of THIS page, once given (null before).
    get choice() { return choice ? { ...choice } : null; },
    // The last answers given for an app, with the URL overrides on top — how a
    // window opened by another page (LIVE GAZE's screens) learns what was
    // chosen there without asking again.
    remembered(app) {
      const prev = stored(app || appFromPath()) || {};
      const surface = urlSurface() || prev.surface || "tags";
      const u = urlCollect();
      return { surface, collect: u != null ? u : !!prev.collect };
    },
  };
})();
