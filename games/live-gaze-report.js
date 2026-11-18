// LIVE GAZE — the printouts of a finished session (and the shared scanpath
// drawing the overview uses live).
//
//   render("scanpaths" | "heatmaps" | "stats", session, { who, scale })
//     -> a landscape page (A-series proportions, 300 dpi at A4 when scale 1)
//   card(same kinds, session, { who })
//     -> the same print as a 1260 × 800 card for an INSTAX Link WIDE
//   stats(session) -> the numbers, also written to results.json
//
// session: { images: [{ slot, name, w, h, el }], players: [{ id, label, color, name }],
//            fix: [{ p, slot, u, v, dur, start, visit }], visitors: [{ id, in, finishedAt }],
//            startedAt, endedAt }
//
// Colour: the two visitors are orange and blue (Okabe & Ito), which stay
// apart for every common colour-vision deficiency. Over the images the marks
// use the bright steps with a dark halo; on white paper (bars, timeline) the
// orange is a step darker so it holds 3:1 against the page. Text is always in
// ink, with a colour swatch beside it — identity never rests on colour alone.
// The heatmap is the one multi-hue scale: viridis, perceptually even and
// colour-blind safe, always with its scale beside it.
(function () {
  const INK = "#1d1d1b", INK2 = "#55534f", MUTED = "#8a8782", RULE = "#dcd9d3", PAGE = "#ffffff";
  const ON_PAPER = { 0: "#C17F00", 1: "#0072B2" };
  const FONT = "ui-monospace, Menlo, monospace";
  const VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6dcd59", "#fde725"];

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const radius = (dur) => Math.min(30, Math.max(8, 5 + Math.sqrt(dur) * 0.9));
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));   // as the monitor's clock
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const fmtS = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);
  const shortName = (s) => String(s || "").replace(/\.[a-z0-9]+$/i, "");

  // ------------------------------------------------------- scanpath marks
  // One visitor's fixations on one image, in time order. Lines join
  // fixations WITHIN a visit only: a line from where someone left an image
  // to where they looked on coming back would be a saccade nobody made.
  // opts: { shown (most recent N, default all), numbered (last N carry
  // their order on this image; default all), fade (older marks fainter) }
  function drawScanpath(ctx, box, fixes, color, k, opts = {}) {
    if (!fixes.length) return;
    const X = (u) => box.x + u * box.w, Y = (v) => box.y + v * box.h;
    const shown = opts.shown ? fixes.slice(-opts.shown) : fixes;
    const offset = fixes.length - shown.length;
    const numbered = opts.numbered == null ? shown.length : opts.numbered;
    const fade = opts.fade !== false;
    const alpha = (i) => (fade ? 0.45 + 0.55 * ((i + 1) / shown.length) : 1);
    ctx.lineCap = "round";
    for (let i = 1; i < shown.length; i++) {
      if (shown[i].visit !== shown[i - 1].visit) continue;
      const a = alpha(i) * 0.95;
      const [x0, y0, x1, y1] = [X(shown[i - 1].u), Y(shown[i - 1].v), X(shown[i].u), Y(shown[i].v)];
      ctx.strokeStyle = `rgba(0,0,0,${0.8 * a})`; ctx.lineWidth = 6.5 * k;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = rgba(color, a); ctx.lineWidth = 3 * k;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    shown.forEach((f, i) => {
      const a = alpha(i);
      const x = X(f.u), y = Y(f.v), r = radius(f.dur) * k;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color, 0.62 * a); ctx.fill();
      ctx.lineWidth = 4 * k; ctx.strokeStyle = `rgba(0,0,0,${0.8 * a})`; ctx.stroke();
      ctx.lineWidth = 2 * k; ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`; ctx.stroke();
      if (i >= shown.length - numbered) {
        ctx.font = `700 ${Math.round(12 * k)}px ${FONT}`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.lineWidth = 3.5 * k; ctx.strokeStyle = "rgba(0,0,0,.9)";
        const label = String(offset + i + 1);
        ctx.strokeText(label, x, y);
        ctx.fillStyle = "#fff"; ctx.fillText(label, x, y);
      }
    });
  }

  // ------------------------------------------------------------ numbers
  function stats(ses) {
    const inVisitors = ses.visitors.filter((v) => v.in);
    const visitors = inVisitors.map((v) => {
      const pl = ses.players.find((p) => p.id === v.id) || { label: `P${v.id + 1}` };
      const mine = ses.fix.filter((f) => f.p === v.id).sort((a, b) => a.start - b.start);
      const total = mine.reduce((s, f) => s + f.dur, 0);
      // Visits, in order: { slot, start, end }.
      const visits = [];
      for (const f of mine) {
        const last = visits[visits.length - 1];
        if (last && last.visit === f.visit) last.end = Math.max(last.end, f.start + f.dur);
        else visits.push({ visit: f.visit, slot: f.slot, start: f.start, end: f.start + f.dur });
      }
      const images = ses.images.map((im) => {
        const fs = mine.filter((f) => f.slot === im.slot);
        const dwell = fs.reduce((s, f) => s + f.dur, 0);
        const vs = visits.filter((x) => x.slot === im.slot);
        return {
          slot: im.slot, name: im.name,
          dwell_ms: dwell,
          share: total ? dwell / total : 0,
          fixations: fs.length,
          meanFixation_ms: fs.length ? Math.round(dwell / fs.length) : null,
          firstLook_ms: fs.length ? fs[0].start : null,
          visits: vs.length,
          longestVisit_ms: vs.length ? Math.max(...vs.map((x) => x.end - x.start)) : null,
        };
      });
      return {
        id: v.id, label: pl.label, color: pl.color,
        session_ms: v.finishedAt, fixations: mine.length, fixationTime_ms: total,
        visits, sequence: visits.map((x) => x.slot + 1), images,
      };
    });
    return { visitors };
  }

  // ------------------------------------------------------------- pages
  function page(scale) {
    const c = document.createElement("canvas");
    c.width = Math.round(3508 * scale); c.height = Math.round(2480 * scale);
    const ctx = c.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = PAGE; ctx.fillRect(0, 0, 3508, 2480);
    ctx.imageSmoothingQuality = "high";
    return { c, ctx, W: 3508, H: 2480 };
  }

  function header(ctx, W, ses, title, sub) {
    const d = new Date(ses.startedAt || Date.now());
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.fillStyle = INK; ctx.font = `600 60px ${FONT}`;
    ctx.fillText(`${ses.test ? "TEST PRINT · " : ""}LIVE GAZE · ${title}`, 140, 190);
    ctx.fillStyle = INK2; ctx.font = `34px ${FONT}`;
    ctx.fillText(`${d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} · ` +
      `${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` + (sub ? ` · ${sub}` : "") +
      (ses.test ? " · made-up data, nothing was measured" : ""), 140, 250);
    // Legend: one swatch per visitor, the name in ink.
    let x = W - 140;
    ctx.textAlign = "right";
    for (const v of [...ses.visitors.filter((q) => q.in)].reverse()) {
      const pl = ses.players.find((p) => p.id === v.id);
      const label = `${pl.label} · ${pl.name} · ${fmtTime(v.finishedAt)}`;
      ctx.fillStyle = INK; ctx.font = `34px ${FONT}`;
      ctx.fillText(label, x, 190);
      x -= ctx.measureText(label).width + 22;
      ctx.fillStyle = pl.color;
      ctx.beginPath(); ctx.arc(x - 16, 178, 16, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.65)"; ctx.stroke();
      x -= 70;
    }
    ctx.strokeStyle = RULE; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(140, 290); ctx.lineTo(W - 140, 290); ctx.stroke();
  }

  function footer(ctx, W, H, text) {
    ctx.fillStyle = MUTED; ctx.font = `28px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(text, 140, H - 90);
  }

  // The images on the page: as many columns as make the smallest biggest.
  function grid(images, area, gap, cap) {
    const n = images.length;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cw = (area.w - gap * (cols - 1)) / cols, ch = (area.h - gap * (rows - 1)) / rows;
      if (ch - cap < 60) continue;
      let smallest = Infinity;
      for (const im of images) {
        const a = im.w / im.h || 1.5;
        const w = Math.min(cw, (ch - cap) * a);
        smallest = Math.min(smallest, w * w / a);
      }
      if (!best || smallest > best.smallest) best = { cols, rows, cw, ch, smallest };
    }
    if (!best) best = { cols: n, rows: 1, cw: area.w / n, ch: area.h };
    return images.map((im, i) => {
      const col = i % best.cols, row = Math.floor(i / best.cols);
      const inRow = row === best.rows - 1 ? n - row * best.cols : best.cols;
      const x0 = area.x + (area.w - (inRow * best.cw + (inRow - 1) * gap)) / 2;
      const cell = { x: x0 + col * (best.cw + gap), y: area.y + row * (best.ch + gap), w: best.cw, h: best.ch };
      const a = im.w / im.h || 1.5;
      let w = cell.w, h = w / a;
      if (h > cell.h - cap) { h = cell.h - cap; w = h * a; }
      return { cell, img: { x: cell.x + (cell.w - w) / 2, y: cell.y, w, h } };
    });
  }

  // Large images drawn small, in halving steps: one big jump aliases.
  function drawImageHQ(ctx, el, r, filter) {
    if (!el) { ctx.fillStyle = "#eee"; ctx.fillRect(r.x, r.y, r.w, r.h); return; }
    const t = ctx.getTransform();
    const tw = Math.max(1, Math.round(r.w * t.a)), th = Math.max(1, Math.round(r.h * t.d));
    let src = el, sw = el.naturalWidth || el.width, sh = el.naturalHeight || el.height;
    while (sw / 2 >= tw && sh / 2 >= th) {
      const c = document.createElement("canvas");
      c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
      const x = c.getContext("2d"); x.imageSmoothingQuality = "high";
      x.drawImage(src, 0, 0, c.width, c.height);
      src = c; sw = c.width; sh = c.height;
    }
    ctx.save();
    if (filter) ctx.filter = filter;
    ctx.drawImage(src, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  function caption(ctx, im, r, ses, line2) {
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    ctx.fillStyle = INK; ctx.font = `600 34px ${FONT}`;
    ctx.fillText(`${im.slot + 1} · ${shortName(im.name)}`, r.x, r.y + r.h + 22);
    if (!line2) return;
    let x = r.x;
    ctx.font = `30px ${FONT}`;
    for (const v of ses.visitors.filter((q) => q.in)) {
      const pl = ses.players.find((p) => p.id === v.id);
      const fs = ses.fix.filter((f) => f.p === v.id && f.slot === im.slot);
      const dwell = fs.reduce((s, f) => s + f.dur, 0);
      const visits = new Set(fs.map((f) => f.visit)).size;
      ctx.fillStyle = pl.color;
      ctx.beginPath(); ctx.arc(x + 12, r.y + r.h + 83, 12, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.stroke();
      const txt = `${pl.label} ${fmtS(dwell)} · ${fs.length} fix. · ${visits} visit${visits === 1 ? "" : "s"}`;
      ctx.fillStyle = INK2;
      ctx.fillText(txt, x + 34, r.y + r.h + 68);
      x += 34 + ctx.measureText(txt).width + 50;
    }
  }

  function scanpathsPage(ses, scale) {
    const { c, ctx, W, H } = page(scale);
    header(ctx, W, ses, "scanpaths", `${ses.images.length} images`);
    const geo = grid(ses.images, { x: 140, y: 340, w: W - 280, h: H - 340 - 190 }, 70, 130);
    ses.images.forEach((im, i) => {
      const r = geo[i].img;
      drawImageHQ(ctx, im.el, r);
      ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(r.x, r.y, r.w, r.h);
      const k = Math.max(1, r.w / 900) * 1.6;
      for (const pl of ses.players) {
        const fs = ses.fix.filter((f) => f.p === pl.id && f.slot === im.slot).sort((a, b) => a.start - b.start);
        // Numbers while they stay readable; past that, the path speaks.
        drawScanpath(ctx, r, fs, pl.color, k, { numbered: fs.length <= 50 ? fs.length : 0, fade: false });
      }
      caption(ctx, im, r, ses, true);
    });
    footer(ctx, W, H, "circle area = how long a fixation lasted · numbers = order on that image · " +
      "lines join the fixations of one visit · fixation: gaze within 3.5 % of the image's width for 100 ms or more");
    return c;
  }

  function heatmapsPage(ses, scale, who) {
    const { c, ctx, W, H } = page(scale);
    const whoPl = who === "all" ? null : ses.players.find((p) => p.id === who);
    header(ctx, W, ses, "heatmaps", whoPl ? `${whoPl.label} (${whoPl.name}) only` : "both visitors");
    const area = { x: 140, y: 340, w: W - 280 - 260, h: H - 340 - 190 };
    const geo = grid(ses.images, area, 70, 80);
    const { maps, max } = heatMaps(ses, who);
    const lut = viridisLut();
    ses.images.forEach((im, i) => {
      const r = geo[i].img;
      drawHeat(ctx, im, r, maps[i], max, lut);
      caption(ctx, im, r, ses, false);
    });
    // The scale.
    const sx = W - 140 - 120, sy = 420, sh = 900;
    for (let y = 0; y < sh; y++) {
      const [R, G, B] = lut[Math.round(255 * (1 - y / sh))];
      ctx.fillStyle = `rgb(${R},${G},${B})`; ctx.fillRect(sx, sy + y, 60, 1.5);
    }
    ctx.strokeStyle = RULE; ctx.lineWidth = 2; ctx.strokeRect(sx, sy, 60, sh);
    ctx.fillStyle = INK; ctx.font = `30px ${FONT}`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText("most", sx - 18, sy + 14);
    ctx.fillText("least", sx - 18, sy + sh - 14);
    ctx.save(); ctx.translate(sx + 110, sy + sh / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.fillStyle = INK2;
    ctx.fillText("time spent fixating", 0, 0);
    ctx.restore();
    footer(ctx, W, H, "each fixation adds its duration, spread over about 3 % of the image's width · " +
      "one scale for every image, so they compare · uncoloured: not looked at");
    return c;
  }

  // Duration-weighted density per image, then ONE scale for all of them:
  // the brightest spot anywhere is "most looked at", so images compare.
  function heatMaps(ses, who) {
    const fixes = ses.fix.filter((f) => who === "all" || f.p === who);
    const MAP_W = 220;
    const maps = ses.images.map((im) => {
      const mw = MAP_W, mh = Math.max(1, Math.round(MAP_W * im.h / im.w));
      const d = new Float32Array(mw * mh);
      const sigma = 0.03 * mw;            // about one degree at a few metres
      const rad = Math.ceil(sigma * 3);
      for (const f of fixes) {
        if (f.slot !== im.slot) continue;
        const cx = f.u * mw, cy = f.v * mh;
        for (let y = Math.max(0, Math.floor(cy - rad)); y < Math.min(mh, cy + rad); y++) {
          for (let x = Math.max(0, Math.floor(cx - rad)); x < Math.min(mw, cx + rad); x++) {
            const q = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (2 * sigma * sigma);
            d[y * mw + x] += f.dur * Math.exp(-q);
          }
        }
      }
      return { mw, mh, d };
    });
    const max = Math.max(1e-9, ...maps.map((m) => m.d.reduce((a, b) => Math.max(a, b), 0)));
    return { maps, max };
  }

  function drawHeat(ctx, im, r, m, max, lut) {
    // The image in grey and lightened, so the colour belongs to the heat.
    drawImageHQ(ctx, im.el, r, "grayscale(1) contrast(0.85) brightness(1.12)");
    ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(r.x, r.y, r.w, r.h);
    const hc = document.createElement("canvas");
    hc.width = m.mw; hc.height = m.mh;
    const hx = hc.getContext("2d");
    const img = hx.createImageData(m.mw, m.mh);
    for (let j = 0; j < m.d.length; j++) {
      const t = m.d[j] / max;
      if (t < 0.03) continue;
      const [R, G, B] = lut[Math.min(255, Math.round(t * 255))];
      img.data[j * 4] = R; img.data[j * 4 + 1] = G; img.data[j * 4 + 2] = B;
      img.data[j * 4 + 3] = Math.round(255 * Math.min(0.88, 0.25 + 0.75 * Math.sqrt(t)));
    }
    hx.putImageData(img, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(hc, r.x, r.y, r.w, r.h);
    ctx.restore();
    ctx.strokeStyle = RULE; ctx.lineWidth = 2; ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  function viridisLut() {
    const stops = VIRIDIS.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    const out = [];
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * (stops.length - 1), a = Math.floor(t), b = Math.min(stops.length - 1, a + 1), f = t - a;
      out.push(stops[a].map((v, k) => Math.round(v + (stops[b][k] - v) * f)));
    }
    return out;
  }

  function statsPage(ses, scale) {
    const { c, ctx, W, H } = page(scale);
    const st = stats(ses);
    header(ctx, W, ses, "fixation statistics", `${ses.images.length} images`);
    const V = st.visitors;
    const imgs = ses.images;

    // --- table: one row per image, a column group per visitor.
    const COLS = [
      ["time", (r) => fmtS(r.dwell_ms)],
      ["share", (r) => (r.fixations ? `${Math.round(r.share * 100)} %` : "—")],
      ["fix.", (r) => String(r.fixations)],
      ["mean", (r) => (r.meanFixation_ms == null ? "—" : `${r.meanFixation_ms} ms`)],
      ["first look", (r) => fmtS(r.firstLook_ms)],
      ["visits", (r) => String(r.visits)],
    ];
    const tx = 140, ty = 360, nameW = 560, colW = 205, rowH = 64;
    const groupW = COLS.length * colW + 40;
    ctx.textBaseline = "middle";
    V.forEach((v, g) => {
      const gx = tx + nameW + g * groupW;
      ctx.fillStyle = v.color;
      ctx.beginPath(); ctx.arc(gx + 14, ty + 18, 14, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.stroke();
      ctx.fillStyle = INK; ctx.font = `600 32px ${FONT}`; ctx.textAlign = "left";
      ctx.fillText(`${v.label} · ${ses.players.find((p) => p.id === v.id).name}`, gx + 40, ty + 18);
      ctx.font = `26px ${FONT}`; ctx.fillStyle = MUTED; ctx.textAlign = "right";
      COLS.forEach(([h], j) => ctx.fillText(h, gx + (j + 1) * colW, ty + 72));
    });
    ctx.strokeStyle = RULE; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tx, ty + 100); ctx.lineTo(tx + nameW + V.length * groupW, ty + 100); ctx.stroke();
    const rows = imgs.length + 1;
    for (let i = 0; i < rows; i++) {
      const y = ty + 100 + rowH * (i + 0.5);
      const total = i === imgs.length;
      ctx.textAlign = "left"; ctx.fillStyle = INK; ctx.font = `${total ? "600 " : ""}30px ${FONT}`;
      const name = total ? "all images" : `${imgs[i].slot + 1} · ${shortName(imgs[i].name)}`;
      let nm = name;
      while (ctx.measureText(nm).width > nameW - 30 && nm.length > 3) nm = nm.slice(0, -2);
      ctx.fillText(nm === name ? nm : nm + "…", tx, y);
      V.forEach((v, g) => {
        const gx = tx + nameW + g * groupW;
        const r = total ? {
          dwell_ms: v.fixationTime_ms, share: v.fixationTime_ms ? 1 : 0, fixations: v.fixations,
          meanFixation_ms: v.fixations ? Math.round(v.fixationTime_ms / v.fixations) : null,
          firstLook_ms: v.visits.length ? v.visits[0].start : null, visits: v.visits.length,
        } : v.images[i];
        ctx.textAlign = "right"; ctx.fillStyle = INK2;
        COLS.forEach(([, fmt], j) => ctx.fillText(fmt(r), gx + (j + 1) * colW, y));
      });
      if (i === imgs.length - 1) {
        ctx.beginPath(); ctx.moveTo(tx, ty + 100 + rowH * (i + 1)); ctx.lineTo(tx + nameW + V.length * groupW, ty + 100 + rowH * (i + 1)); ctx.stroke();
      }
    }
    const tableBottom = ty + 100 + rowH * rows;
    ctx.textAlign = "left"; ctx.fillStyle = MUTED; ctx.font = `26px ${FONT}`;
    ctx.fillText("time: total fixation time on the image · share: of that visitor's fixation time · mean: " +
      "fixation duration · first look: from the start · visits: separate times the visitor came to it",
      tx, tableBottom + 40);

    // --- bars: time on each image, a bar per visitor, value at the end.
    const bx = tx, by = tableBottom + 130, bw = W - 280, bh = Math.min(560, H - 600 - by);
    ctx.fillStyle = INK; ctx.font = `600 32px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText("time on each image", bx, by);
    const labelW = 420, plotX = bx + labelW, plotW = bw - labelW - 220;
    const maxDwell = Math.max(1, ...V.flatMap((v) => v.images.map((r) => r.dwell_ms)));
    const groupH = (bh - 30) / Math.max(1, imgs.length);
    const barH = Math.min(36, (groupH - 18) / Math.max(1, V.length) - 4);
    imgs.forEach((im, i) => {
      const gy = by + 30 + i * groupH;
      ctx.fillStyle = INK2; ctx.font = `28px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      let nm = `${im.slot + 1} · ${shortName(im.name)}`;
      while (ctx.measureText(nm).width > labelW - 30 && nm.length > 3) nm = nm.slice(0, -1);
      ctx.fillText(nm, bx, gy + (V.length * (barH + 4)) / 2);
      V.forEach((v, j) => {
        const val = v.images[i].dwell_ms;
        const w = Math.max(val ? 4 : 0, plotW * val / maxDwell);
        const y = gy + j * (barH + 4);
        ctx.fillStyle = ON_PAPER[v.id] || v.color;
        roundEnd(ctx, plotX, y, w, barH, 4);
        ctx.fillStyle = INK2; ctx.font = `26px ${FONT}`;
        ctx.fillText(`${v.label} ${fmtS(val)}`, plotX + w + 14, y + barH / 2);
      });
    });
    ctx.strokeStyle = MUTED; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(plotX, by + 20); ctx.lineTo(plotX, by + 30 + imgs.length * groupH - 14); ctx.stroke();

    // --- visits in time: one row per visitor, a block per visit, its image's number in it.
    const vy = by + bh + 90, vx = tx + 260, vw = W - 280 - 260;
    const span = Math.max(1, ...V.map((v) => v.session_ms || 0));
    ctx.fillStyle = INK; ctx.font = `600 32px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText("visits in order, over time (the number is the image)", tx, vy);
    V.forEach((v, j) => {
      const y = vy + 40 + j * 74;
      ctx.fillStyle = v.color;
      ctx.beginPath(); ctx.arc(tx + 14, y + 26, 14, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.stroke();
      ctx.fillStyle = INK2; ctx.font = `28px ${FONT}`; ctx.textBaseline = "middle";
      ctx.fillText(`${v.label} ${fmtTime(v.session_ms || 0)}`, tx + 40, y + 26);
      ctx.fillStyle = "#f1efeb"; ctx.fillRect(vx, y + 4, vw * (v.session_ms || 0) / span, 44);
      for (const s of v.visits) {
        const x0 = vx + vw * s.start / span, x1 = vx + vw * s.end / span;
        ctx.fillStyle = ON_PAPER[v.id] || v.color;
        ctx.fillRect(x0, y + 4, Math.max(3, x1 - x0 - 2), 44);
        if (x1 - x0 > 34) {
          ctx.fillStyle = "#fff"; ctx.font = `600 26px ${FONT}`; ctx.textAlign = "center";
          ctx.fillText(String(s.slot + 1), (x0 + x1) / 2, y + 27);
          ctx.textAlign = "left";
        }
      }
    });
    const ay = vy + 40 + V.length * 74 + 10;
    ctx.fillStyle = MUTED; ctx.font = `26px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("0:00", vx, ay);
    ctx.textAlign = "right"; ctx.fillText(fmtTime(span), vx + vw, ay);
    V.forEach((v, j) => {
      ctx.textAlign = "left";
      ctx.fillText(`${v.label} order: ${v.sequence.join(" → ") || "—"}`, vx + j * (vw / 2), ay + 44);
    });
    footer(ctx, W, H, "a visit is a run of fixations on one image; looking at another image ends it · " +
      "fixation: gaze within 3.5 % of the image's width for 100 ms or more");
    return c;
  }

  function roundEnd(ctx, x, y, w, h, r) {
    if (w <= 0) return;
    r = Math.min(r, w, h / 2);
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
  }

  async function render(kind, ses, opts = {}) {
    const scale = opts.scale || 1;
    if (kind === "heatmaps") return heatmapsPage(ses, scale, opts.who == null ? "all" : opts.who);
    if (kind === "stats") return statsPage(ses, scale);
    return scanpathsPage(ses, scale);
  }

  // ------------------------------------------------- instax WIDE cards
  // The same three prints for an INSTAX Link WIDE, which prints from its
  // phone app onto instax WIDE film: a 99 × 62 mm picture of 1260 × 800 dots,
  // 12.5 to the millimetre. A page shrunk to that is unreadable, so each card
  // is laid out again: the images as big as the card allows, numbered in a
  // corner instead of captioned, and no text under 24 dots (about 2 mm).
  //
  // The app does not print all of the picture it is given: its Simple Print
  // preview shows only x 64–1196 and y 48–752 of a 1260 × 800 card (about 5 %
  // off every side). So a card is laid out on 1260 × 800 and then drawn at
  // FIT of that size, centred, which keeps a margin of ~25 dots inside what
  // the app shows; the rest of the picture is white, like the film's border.
  const CARD = { W: 1260, H: 800, M: 40, FIT: 0.91 };

  function cardCanvas() {
    const c = document.createElement("canvas");
    c.width = CARD.W; c.height = CARD.H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = PAGE; ctx.fillRect(0, 0, CARD.W, CARD.H);
    ctx.imageSmoothingQuality = "high";
    const s = CARD.FIT;
    ctx.setTransform(s, 0, 0, s, CARD.W * (1 - s) / 2, CARD.H * (1 - s) / 2);
    return { c, ctx, W: CARD.W, H: CARD.H, M: CARD.M };
  }

  function swatch(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,.65)"; ctx.stroke();
  }

  // Text cut to a width, with an ellipsis when it had to be.
  function fitText(ctx, text, x, y, maxW) {
    if (ctx.measureText(text).width <= maxW) { ctx.fillText(text, x, y); return; }
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    ctx.fillText(t + "…", x, y);
  }

  function cardHeader(ctx, ses, title, sub) {
    const { W, M } = CARD;
    const d = new Date(ses.startedAt || Date.now());
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.fillStyle = INK; ctx.font = `600 34px ${FONT}`;
    ctx.fillText(`${ses.test ? "TEST PRINT · " : ""}LIVE GAZE · ${title}`, M, 70);
    ctx.fillStyle = INK2; ctx.font = `25px ${FONT}`;
    ctx.fillText(`${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · ` +
      `${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` + (sub ? ` · ${sub}` : "") +
      (ses.test ? " · made-up data" : ""), M, 106);
    // Legend: a swatch per visitor, the name in ink.
    let x = W - M;
    ctx.textAlign = "right"; ctx.font = `600 27px ${FONT}`;
    for (const v of [...ses.visitors.filter((q) => q.in)].reverse()) {
      const pl = ses.players.find((p) => p.id === v.id);
      const label = `${pl.label} ${pl.name}`;
      ctx.fillStyle = INK; ctx.fillText(label, x, 70);
      x -= ctx.measureText(label).width + 12;
      swatch(ctx, x - 13, 61, 13, pl.color);
      x -= 26 + 30;
    }
    ctx.strokeStyle = RULE; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(M, 126); ctx.lineTo(W - M, 126); ctx.stroke();
  }

  function cardFooter(ctx, text) {
    ctx.fillStyle = INK2; ctx.font = `24px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    fitText(ctx, text, CARD.M, CARD.H - CARD.M + 2, CARD.W - 2 * CARD.M);
  }

  // The images of a card: the page's grid with no room for captions, each
  // image centred in its cell.
  function cardGrid(images, area) {
    return grid(images, area, 20, 0).map(({ cell, img }) => ({ ...img, y: cell.y + (cell.h - img.h) / 2 }));
  }

  // The image's number in its top-left corner (the statistics card names it).
  function badge(ctx, r, n) {
    ctx.font = `700 26px ${FONT}`;
    const w = ctx.measureText(String(n)).width + 20;
    ctx.fillStyle = "rgba(29,29,27,.88)"; ctx.fillRect(r.x, r.y, w, 38);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(n), r.x + w / 2, r.y + 20);
  }

  function scanpathsCard(ses) {
    const { c, ctx, W, H, M } = cardCanvas();
    cardHeader(ctx, ses, "scanpaths", `${ses.images.length} image${ses.images.length === 1 ? "" : "s"}`);
    const geo = cardGrid(ses.images, { x: M, y: 146, w: W - 2 * M, h: H - 146 - 70 });
    ses.images.forEach((im, i) => {
      const r = geo[i];
      drawImageHQ(ctx, im.el, r);
      ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(r.x, r.y, r.w, r.h);
      const k = Math.max(0.55, r.w / 560);
      for (const pl of ses.players) {
        const fs = ses.fix.filter((f) => f.p === pl.id && f.slot === im.slot).sort((a, b) => a.start - b.start);
        drawScanpath(ctx, r, fs, pl.color, k, { numbered: 0, fade: false });
      }
      badge(ctx, r, im.slot + 1);
    });
    cardFooter(ctx, "circle: a fixation (bigger = longer) · line: to the next one, same visit");
    return c;
  }

  function heatmapsCard(ses, who) {
    const { c, ctx, W, H, M } = cardCanvas();
    const whoPl = who === "all" ? null : ses.players.find((p) => p.id === who);
    cardHeader(ctx, ses, "heatmaps", whoPl ? `${whoPl.label} (${whoPl.name}) only` : "both visitors");
    const geo = cardGrid(ses.images, { x: M, y: 146, w: W - 2 * M - 132, h: H - 146 - 70 });
    const { maps, max } = heatMaps(ses, who);
    const lut = viridisLut();
    ses.images.forEach((im, i) => {
      drawHeat(ctx, im, geo[i], maps[i], max, lut);
      badge(ctx, geo[i], im.slot + 1);
    });
    // The scale, labelled at both ends.
    const sx = W - M - 112, sy = 176, sh = 480;
    for (let y = 0; y < sh; y++) {
      const [R, G, B] = lut[Math.round(255 * (1 - y / sh))];
      ctx.fillStyle = `rgb(${R},${G},${B})`; ctx.fillRect(sx, sy + y, 26, 1.5);
    }
    ctx.strokeStyle = RULE; ctx.lineWidth = 2; ctx.strokeRect(sx, sy, 26, sh);
    ctx.fillStyle = INK; ctx.font = `24px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("most", sx + 36, sy + 12);
    ctx.fillText("least", sx + 36, sy + sh - 12);
    cardFooter(ctx, "colour: time spent looking, one scale for every image · grey: not looked at");
    return c;
  }

  function statsCard(ses) {
    const { c, ctx, W, H, M } = cardCanvas();
    const st = stats(ses), V = st.visitors, imgs = ses.images;
    cardHeader(ctx, ses, "statistics", `${imgs.length} image${imgs.length === 1 ? "" : "s"}`);
    if (!V.length) {
      ctx.fillStyle = INK2; ctx.font = `28px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText("Nobody took part in this session.", M, 220);
      return c;
    }

    // --- each visitor: their time, fixations and the order of their visits.
    const colW = (W - 2 * M) / V.length;
    V.forEach((v, j) => {
      const x = M + j * colW;
      const pl = ses.players.find((p) => p.id === v.id) || { name: "" };
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      swatch(ctx, x + 13, 168, 13, v.color);
      ctx.fillStyle = INK; ctx.font = `600 28px ${FONT}`;
      fitText(ctx, `${v.label} ${pl.name} · ${fmtTime(v.session_ms || 0)}`, x + 36, 178, colW - 56);
      ctx.fillStyle = INK2; ctx.font = `25px ${FONT}`;
      const mean = v.fixations ? Math.round(v.fixationTime_ms / v.fixations) : null;
      fitText(ctx, `${v.fixations} fixations · mean ${mean == null ? "—" : `${mean} ms`}`, x, 214, colW - 20);
      fitText(ctx, `order ${v.sequence.join(" → ") || "—"}`, x, 248, colW - 20);
    });

    // --- bars: time on each image, a bar per visitor, the value at its end.
    ctx.fillStyle = INK; ctx.font = `600 26px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText("time on each image", M, 304);
    const top = 320, room = 262;
    const groupH = Math.min(66, room / Math.max(1, imgs.length));
    const pitch = (groupH - 10) / V.length, barH = Math.max(3, Math.min(22, pitch - 4));
    const labelW = 390, plotX = M + labelW, plotW = W - M - plotX - 170;
    const maxDwell = Math.max(1, ...V.flatMap((v) => v.images.map((r) => r.dwell_ms)));
    imgs.forEach((im, i) => {
      const gy = top + i * groupH;
      ctx.fillStyle = INK; ctx.font = `25px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      fitText(ctx, `${im.slot + 1} · ${shortName(im.name)}`, M, gy + (V.length * pitch - 4) / 2, labelW - 20);
      V.forEach((v, j) => {
        const val = v.images[i].dwell_ms;
        const w = Math.max(val ? 4 : 0, plotW * val / maxDwell);
        const y = gy + j * pitch;
        ctx.fillStyle = ON_PAPER[v.id] || v.color;
        roundEnd(ctx, plotX, y, w, barH, 4);
        if (pitch >= 24) {
          ctx.fillStyle = INK2; ctx.font = `24px ${FONT}`;
          ctx.fillText(`${v.label} ${fmtS(val)}`, plotX + w + 10, y + barH / 2 + 1);
        }
      });
    });
    ctx.strokeStyle = MUTED; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(plotX, top - 4); ctx.lineTo(plotX, top + imgs.length * groupH - 8); ctx.stroke();

    // --- visits in time: a row per visitor, a block per visit, its image's number in it.
    const ty = 620;
    ctx.fillStyle = INK; ctx.font = `600 26px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText("visits over time (the number is the image)", M, ty);
    const vx = M + 96, vw = W - M - vx;
    const span = Math.max(1, ...V.map((v) => v.session_ms || 0));
    const rowH = Math.min(46, 92 / V.length);
    V.forEach((v, j) => {
      const y = ty + 14 + j * rowH, h = rowH - 6;
      swatch(ctx, M + 13, y + h / 2, 13, v.color);
      ctx.fillStyle = INK; ctx.font = `600 25px ${FONT}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      ctx.fillText(v.label, M + 34, y + h / 2 + 1);
      ctx.fillStyle = "#ebe8e3"; ctx.fillRect(vx, y, vw * (v.session_ms || 0) / span, h);
      for (const s of v.visits) {
        const x0 = vx + vw * s.start / span, x1 = vx + vw * s.end / span;
        ctx.fillStyle = ON_PAPER[v.id] || v.color;
        ctx.fillRect(x0, y, Math.max(3, x1 - x0 - 2), h);
        if (x1 - x0 > 30) {
          ctx.fillStyle = "#fff"; ctx.font = `700 24px ${FONT}`; ctx.textAlign = "center";
          ctx.fillText(String(s.slot + 1), (x0 + x1) / 2, y + h / 2 + 1);
          ctx.textAlign = "left";
        }
      }
    });
    ctx.fillStyle = INK2; ctx.font = `24px ${FONT}`; ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText("0:00", vx, H - M + 2);
    ctx.textAlign = "right"; ctx.fillText(fmtTime(span), W - M, H - M + 2);
    return c;
  }

  // card("scanpaths" | "heatmaps" | "stats", session, { who }) -> 1260 × 800
  async function card(kind, ses, opts = {}) {
    if (kind === "heatmaps") return heatmapsCard(ses, opts.who == null ? "all" : opts.who);
    if (kind === "stats") return statsCard(ses);
    return scanpathsCard(ses);
  }

  window.LiveGazeReport = { render, card, CARD, stats, drawScanpath, radius, rgba };
})();
