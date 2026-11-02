// A stylesheet that fails to load is fetched again, instead of leaving the
// page without it for the rest of the session.
//
// Seen for real (2026-11-02): MEDUSA, fullscreen on a projector, came up
// without tuning.css. Unstyled, the hidden settings panel became a full-width
// block at the top of the page and pushed the eyes 413px down — a black band
// over the top of the screen. The bridge serves the file reliably (1,050 of
// 1,050 requests in a load test), so that one request simply failed; and a
// stylesheet that fails once stays missing until someone reloads, which
// nobody does in the middle of a showing.
//
// Included in every page's <head> after its stylesheets, with defer.
(function () {
  const RETRIES = 3;

  // Whether a stylesheet arrived. Chrome gives one that failed an EMPTY sheet
  // rather than none, so having a sheet proves nothing; every stylesheet here
  // has rules, so no rules means it never came. (A cross-origin sheet's rules
  // cannot be read; it is taken as arrived.)
  function arrived(link) {
    if (!link.sheet) return false;
    try { return link.sheet.cssRules.length > 0; } catch (_) { return true; }
  }

  function retry(link, n) {
    const url = new URL(link.href);
    url.searchParams.set("retry", String(n));
    const again = link.cloneNode();
    again.href = url.href;
    // Judged by its rules, not by which event fires: Chrome can fire "load"
    // for a stylesheet that came back 404.
    const settle = () => {
      if (arrived(again)) { link.remove(); return; }
      again.remove();
      if (n < RETRIES) setTimeout(() => retry(link, n + 1), 1000 * n);
      else console.error(`stylesheet ${link.href} still missing after ${RETRIES} retries`);
    };
    again.addEventListener("load", settle, { once: true });
    again.addEventListener("error", settle, { once: true });
    link.after(again);
  }

  function check() {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      if (arrived(link)) continue;
      console.warn(`stylesheet ${link.href} failed to load — fetching it again`);
      retry(link, 1);
    }
  }

  // "load" waits for every stylesheet to finish, loaded or failed.
  if (document.readyState === "complete") check();
  else window.addEventListener("load", check, { once: true });
})();
