// A small corner legend of the current experience's controls.
//
// Every game has a keyboard/mouse stand-in for its gaze control so behaviour
// can be tested without a headset — but an undiscoverable fallback may as
// well not exist. This shows them, and stays out of the way afterwards.
//
//   ControlsHint.show([{ keys: "↑ / space", does: "jump" }, ...])
//   press h to toggle
//
// Auto-hides after a few seconds so it doesn't sit on top of the artwork
// during an actual showing.
(function () {
  const AUTO_HIDE_MS = 9000;
  let el = null, timer = null, visible = false;

  function build(rows, title) {
    if (el) el.remove();
    el = document.createElement("div");
    el.className = "controls-hint";
    el.innerHTML =
      `<div class="ch-title">${title || "controls"} <span>· h</span></div>` +
      rows.map((r) => `<div class="ch-row"><b>${r.keys}</b><span>${r.does}</span></div>`).join("") +
      `<div class="ch-row ch-sep"><b>m</b><span>cursor mode</span></div>` +
      `<div class="ch-row"><b>e</b><span>back to eye tracking</span></div>`;
    document.body.appendChild(el);
    return el;
  }

  function setVisible(on) {
    visible = on;
    if (el) el.classList.toggle("ch-hidden", !on);
    clearTimeout(timer);
    if (on) timer = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
  }

  window.ControlsHint = {
    show(rows, title) {
      build(rows, title);
      setVisible(true);
      window.addEventListener("keydown", (e) => {
        if (e.key === "h" || e.key === "H") setVisible(!visible);
      });
    },
  };
})();
