#!/usr/bin/env node
// MAGNETIC POETRY — record the poems with an ElevenLabs voice, once.
//
// The piece plays these recordings when a poem is completed. They are made
// here, ahead of time, and committed with the project, so the piece itself
// never needs the network or an API key: at the venue it just plays files.
//
// BY HAND, on the ElevenLabs website — no API key at all:
//   node games/magnetic-poetry/make-voices.mjs sheet --open
//       a page with every poem's exact text, a copy button each, in order
//   node games/magnetic-poetry/make-voices.mjs import [~/Downloads] [--voice "George"] [--yes]
//       takes the newest MP3s from Downloads, in the order they were made,
//       checks each one's length against its poem, and puts them in place
//       (--count N if you made only the first N; --set all for both sets)
//
// OR WITH THE API, all at once:
//   node games/magnetic-poetry/make-voices.mjs voices [search]
//       the voices your account can use: name, accent, description, id
//   node games/magnetic-poetry/make-voices.mjs audition "George,Alice,Brian" [--poem 12]
//       one poem in each of those voices, to compare by ear (add --play)
//   node games/magnetic-poetry/make-voices.mjs record "George" [--speed 0.9] [--force]
//       every poem, both sets, into voice/ — only what changed is re-recorded
//
// The API key is read from $ELEVENLABS_API_KEY, or else from the file
// ~/.config/elevenlabs/api_key — outside the project, so it can never be
// committed. It is sent only to api.elevenlabs.io and never printed.
//
// Plain Node 18+ (fetch is built in); nothing to install.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "voice");
const AUDITION = path.join(OUT, "_audition");
const POEMS_FILE = path.join(HERE, "..", "magnetic-poetry-poems.js");
const API = "https://api.elevenlabs.io";
const KEY_FILE = path.join(os.homedir(), ".config", "elevenlabs", "api_key");

// eleven_v4 is ElevenLabs' recommendation for narration. It paces itself from
// punctuation and line breaks (it takes no <break> tags), which suits poems.
const DEFAULTS = { model: "eleven_v4", speed: 0.9, stability: 0.5, similarity: 0.75, style: 0, seed: 1919 };
const FORMAT = "mp3_44100_96";   // ~12 KB a second: all the poems come to a few MB

function apiKey() {
  const env = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (env) return env;
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, "utf8").trim();
  fail(`No ElevenLabs API key. Copy it from elevenlabs.io (Profile → API keys), then run:\n` +
       `  mkdir -p ~/.config/elevenlabs && pbpaste > ~/.config/elevenlabs/api_key && chmod 600 ~/.config/elevenlabs/api_key`);
}

function fail(msg) { console.error(msg); process.exit(1); }

function loadSets() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(POEMS_FILE, "utf8"), sandbox);
  return { short: sandbox.window.POEMS, longer: sandbox.window.POEMS_LONGER };
}
function loadPoems() { const { short, longer } = loadSets(); return [...short, ...longer]; }

const MANIFEST = path.join(OUT, "manifest.json");
const readManifest = () => (fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { poems: {} });
const writeManifest = (m) => fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");

// Seconds a careful reading of `text` should take, roughly: ~12 characters a
// second, plus a breath at each line. Only used to catch a file that plainly
// belongs to a different poem.
const expectedSeconds = (text) => text.length / 12 + text.split("\n").length * 0.35;

function durationOf(file) {
  try {
    const out = execFileSync("afinfo", [file], { encoding: "utf8" });
    const m = out.match(/estimated duration:\s*([\d.]+)/);
    return m ? Number(m[1]) : null;
  } catch (_) { return null; }
}

const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The recording sheet: one card per poem, in order, with the exact text to
// paste and a copy button — and a tick box, remembered in the browser, for
// keeping track over 14 poems.
function sheetHtml(sets) {
  const card = (p, n) => `
  <section class="card" data-key="${slug(p.title)}">
    <header><span class="n">${String(n).padStart(2, "0")}</span>
      <span class="t">${esc(p.title)}</span><span class="a">${esc(p.author)}</span>
      <label class="done"><input type="checkbox"> done</label></header>
    <pre>${esc(script(p))}</pre>
    <button class="copy">copy text</button>
  </section>`;
  let n = 0;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Magnetic Poetry — recording sheet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0c10; color:#e8e6e2; font:15px/1.55 -apple-system, "Helvetica Neue", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 18px 80px; }
  h1 { font-weight:300; letter-spacing:.2em; font-size:22px; margin:0 0 6px; }
  h1 b { color:#FFC36B; font-weight:300; }
  h2 { font-weight:400; font-size:13px; letter-spacing:.2em; text-transform:uppercase; color:#8d8b88; margin:40px 0 12px; }
  ol.steps { padding-left: 20px; color:#c9c7c4; } ol.steps li { margin: 6px 0; }
  code { background:#1a1c22; padding:1px 6px; border-radius:4px; color:#FFC36B; }
  .card { border:1px solid #23252c; background:#111318; padding:14px 16px; margin:12px 0; }
  .card.is-done { opacity:.45; }
  header { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
  .n { font-family: ui-monospace, Menlo, monospace; color:#FFC36B; }
  .t { font-size:16px; } .a { color:#8d8b88; font-size:13px; }
  .done { margin-left:auto; font-size:13px; color:#8d8b88; cursor:pointer; }
  pre { white-space:pre-wrap; font: 16px/1.6 -apple-system, "Helvetica Neue", sans-serif; margin:10px 0; color:#fff1da; }
  button { font: 12px ui-monospace, Menlo, monospace; letter-spacing:.12em; text-transform:uppercase;
           background:transparent; color:#FFC36B; border:1px solid #FFC36B; padding:7px 14px; cursor:pointer; }
  button.ok { color:#0b0c10; background:#FFC36B; }
</style></head><body><main>
<h1>MAGNETIC <b>POETRY</b> — recording sheet</h1>
<ol class="steps">
  <li>Sign in at <b>elevenlabs.io</b> and open <b>Text to Speech</b>.</li>
  <li>Choose <b>one voice</b> and keep it for every poem. Settings: the newest model on offer
      (Eleven v4 if listed), <b>speed a little below normal (≈0.9)</b>, the rest as they are.</li>
  <li>For each poem below, <b>in this order</b>: <i>copy text</i> → paste into ElevenLabs → generate →
      listen → <b>download</b> → tick <i>done</i>. If a take is bad, delete that download and make it again.</li>
  <li>Leave the files in Downloads with whatever names ElevenLabs gives them, and say when you are done —
      they are matched to the poems by the order you made them.</li>
</ol>
<h2>The piece — ${sets.short.length} short poems</h2>
${sets.short.map((p) => card(p, ++n)).join("")}
<h2>Optional — the ${sets.longer.length} longer poems (settings → poems → longer)</h2>
${sets.longer.map((p) => card(p, ++n)).join("")}
</main>
<script>
  const KEY = "mp-recording-sheet";
  let done = {}; try { done = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) {}
  for (const card of document.querySelectorAll(".card")) {
    const k = card.dataset.key, box = card.querySelector("input");
    box.checked = !!done[k]; card.classList.toggle("is-done", box.checked);
    box.onchange = () => { done[k] = box.checked; card.classList.toggle("is-done", box.checked);
      try { localStorage.setItem(KEY, JSON.stringify(done)); } catch (_) {} };
    const btn = card.querySelector("button.copy"), text = card.querySelector("pre").textContent;
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(text); }
      catch (_) { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
      btn.textContent = "copied"; btn.classList.add("ok");
      setTimeout(() => { btn.textContent = "copy text"; btn.classList.remove("ok"); }, 1500);
    };
  }
</script></body></html>
`;
}

// Must match slug() in games/magnetic-poetry.js: the piece finds a poem's
// recording by its title.
export function slug(title) {
  return title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// What is read: the poem as printed, line by line, then who wrote it.
function script(p) {
  const lines = p.text.split("\n").map((s) => s.trim()).join("\n");
  const credit = p.translator
    ? `${p.title}. ${p.author}, translated by ${p.translator}.`
    : `${p.title}. ${p.author}.`;
  return `${lines}\n\n${credit}`;
}

async function api(pathname, { method = "GET", body, query } = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { "xi-api-key": apiKey(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    fail(`ElevenLabs ${method} ${pathname} → ${res.status}\n${detail.slice(0, 600)}`);
  }
  return res;
}

async function listVoices(search) {
  const all = [];
  let token = null;
  do {
    const res = await api("/v2/voices", { query: { page_size: 100, search, next_page_token: token } });
    const page = await res.json();
    all.push(...page.voices);
    token = page.has_more ? page.next_page_token : null;
  } while (token);
  return all;
}

async function resolveVoice(nameOrId) {
  const voices = await listVoices(nameOrId);
  const exact = voices.find((v) => v.voice_id === nameOrId) ||
    voices.find((v) => v.name.toLowerCase() === nameOrId.toLowerCase()) ||
    voices.find((v) => v.name.toLowerCase().startsWith(nameOrId.toLowerCase()));
  if (exact) return exact;
  fail(`No voice called "${nameOrId}". List them with: node games/magnetic-poetry/make-voices.mjs voices`);
}

async function speak(text, voice, s) {
  const res = await api(`/v1/text-to-speech/${voice.voice_id}`, {
    method: "POST",
    query: { output_format: FORMAT },
    body: {
      text,
      model_id: s.model,
      seed: s.seed,
      voice_settings: { stability: s.stability, similarity_boost: s.similarity, style: s.style, speed: s.speed, use_speaker_boost: true },
    },
  });
  return Buffer.from(await res.arrayBuffer());
}

function options(args) {
  const s = { ...DEFAULTS };
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  if (get("--model")) s.model = get("--model");
  for (const k of ["speed", "stability", "similarity", "style", "seed"]) if (get(`--${k}`) != null) s[k] = Number(get(`--${k}`));
  return { s, poem: get("--poem"), force: args.includes("--force"), play: args.includes("--play") };
}

const [cmd, arg, ...rest] = process.argv.slice(2);

if (cmd === "sheet") {
  const file = path.join(HERE, "recording-sheet.html");
  fs.writeFileSync(file, sheetHtml(loadSets()));
  console.log(file);
  if ([arg, ...rest].includes("--open")) execFileSync("open", [file]);
} else if (cmd === "import") {
  const args = [arg, ...rest].filter((x) => x != null);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const flagged = new Set(args.flatMap((x, i) => (x.startsWith("--") ? [i, i + 1] : [])));
  let folder = (args.find((x, i) => !x.startsWith("--") && !flagged.has(i)) || path.join(os.homedir(), "Downloads")).replace(/^~/, os.homedir());
  // A zip from ElevenLabs' History download is unpacked to a scratch folder.
  if (/\.zip$/i.test(folder)) {
    const into = fs.mkdtempSync(path.join(os.tmpdir(), "mp-import-"));
    execFileSync("unzip", ["-q", "-o", folder, "-d", into]);
    folder = into;
  }
  const { short, longer } = loadSets();
  let poems = get("--set") === "all" ? [...short, ...longer] : short;
  if (get("--count")) poems = poems.slice(0, Number(get("--count")));
  // ElevenLabs names each download after the moment it was GENERATED
  // (ElevenLabs_2026-10-24T18_27_07_Vince_…), which is the order the poems
  // were made in whatever order they were downloaded; other files fall back
  // to their modification time. Only ElevenLabs files, when there are any,
  // so an unrelated MP3 in Downloads is never taken for a poem.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  let found = walk(folder).filter((f) => /\.mp3$/i.test(f) && !path.basename(f).startsWith("._"));
  if (found.some((f) => /^ElevenLabs_/.test(path.basename(f)))) found = found.filter((f) => /^ElevenLabs_/.test(path.basename(f)));
  const made = (f) => { const m = path.basename(f).match(/(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2})/); return m ? m[1] : new Date(fs.statSync(f).mtimeMs).toISOString(); };
  const mp3s = found.map((full) => ({ f: path.basename(full), full, at: made(full) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-poems.length);
  if (mp3s.length < poems.length) fail(`Found ${mp3s.length} recordings in ${folder}, need ${poems.length}. Use --count ${mp3s.length} if you made only the first ${mp3s.length}.`);
  // The voice and speed are in the name too: …_Vince_ivc_sp100_… is the voice
  // "Vince" at 100% speed. The piece slows playback to its reading pace
  // relative to this, so a take made at normal speed is not slowed twice.
  const voiceName = (mp3s[0].f.match(/^ElevenLabs_\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}_(.+?)_(?:ivc|pvc|pre|gen|cl)(?:_|\.)/) || [])[1];
  const speedPct = (mp3s[0].f.match(/_sp(\d+)(?:_|\.)/) || [])[1];
  let doubtful = 0;
  console.log(`  #  poem${" ".repeat(30)} expected  file length  file`);
  poems.forEach((p, i) => {
    const want = expectedSeconds(script(p)), got = durationOf(mp3s[i].full);
    const off = got != null && (got < want * 0.5 || got > want * 2);
    if (off) doubtful++;
    console.log(`${String(i + 1).padStart(3)}  ${p.title.slice(0, 32).padEnd(34)} ~${want.toFixed(0).padStart(3)}s    ${got == null ? "  ?" : got.toFixed(1).padStart(5) + "s"}${off ? "  ← doesn't look like this poem" : "  "}  ${mp3s[i].f}`);
  });
  if (doubtful) console.log(`\n${doubtful} file(s) look wrong for their poem — probably a take that was downloaded twice or out of order.`);
  if (!args.includes("--yes")) {
    console.log(`\nNothing copied yet. If the pairs above are right, run the same command with --yes.`);
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    const manifest = readManifest();
    for (const [i, p] of poems.entries()) {
      const key = slug(p.title), text = script(p);
      fs.copyFileSync(mp3s[i].full, path.join(OUT, `${key}.mp3`));
      manifest.poems[key] = { file: `${key}.mp3`, hash: crypto.createHash("sha1").update(text).digest("hex").slice(0, 12), title: p.title, chars: text.length };
    }
    manifest.voice = { name: get("--voice") || voiceName || "ElevenLabs", id: null };
    manifest.settings = { made: "by hand on elevenlabs.io", speed: speedPct ? Number(speedPct) / 100 : 1 };
    writeManifest(manifest);
    console.log(`\n${poems.length} recordings in ${path.relative(process.cwd(), OUT)}/`);
  }
} else if (cmd === "voices") {
  const voices = await listVoices(arg);
  for (const v of voices.sort((a, b) => a.name.localeCompare(b.name))) {
    const l = v.labels || {};
    console.log(`${v.name.padEnd(28)} ${[l.gender, l.age, l.accent].filter(Boolean).join(", ").padEnd(30)} ${(l.description || l.use_case || v.description || "").slice(0, 60).padEnd(60)} ${v.voice_id}`);
  }
} else if (cmd === "audition" && arg) {
  const { s, poem, play } = options(rest);
  const poems = loadPoems();
  const p = poems[poem ? Number(poem) - 1 : 11] || poems[0];
  fs.mkdirSync(AUDITION, { recursive: true });
  console.log(`“${p.title}” — ${p.author}\n`);
  for (const name of arg.split(",").map((x) => x.trim()).filter(Boolean)) {
    const voice = await resolveVoice(name);
    const file = path.join(AUDITION, `${slug(voice.name)}--${slug(p.title)}.mp3`);
    fs.writeFileSync(file, await speak(script(p), voice, s));
    console.log(`${voice.name.padEnd(28)} ${file}`);
    if (play) execFileSync("afplay", [file]);
  }
} else if (cmd === "record" && arg) {
  const { s, force } = options(rest);
  const voice = await resolveVoice(arg);
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = readManifest();
  let chars = 0, made = 0;
  for (const p of loadPoems()) {
    const text = script(p);
    const key = slug(p.title);
    const hash = crypto.createHash("sha1").update(JSON.stringify([text, voice.voice_id, s])).digest("hex").slice(0, 12);
    const file = `${key}.mp3`;
    const have = manifest.poems[key];
    if (!force && have && have.hash === hash && fs.existsSync(path.join(OUT, file))) { console.log(`  kept    ${p.title}`); continue; }
    fs.writeFileSync(path.join(OUT, file), await speak(text, voice, s));
    manifest.poems[key] = { file, hash, title: p.title, chars: text.length };
    chars += text.length; made++;
    console.log(`  recorded ${p.title}`);
  }
  manifest.voice = { name: voice.name, id: voice.voice_id };
  manifest.settings = { ...s, format: FORMAT };
  writeManifest(manifest);
  console.log(`\n${made} recorded, ${chars} characters, in ${path.relative(process.cwd(), OUT)}/ — voice: ${voice.name}, model: ${s.model}`);
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 28).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
