#!/usr/bin/env node
// MAGNETIC POETRY — record the poems with an ElevenLabs voice, once.
//
// The piece plays these recordings when a poem is completed. They are made
// here, ahead of time, and committed with the project, so the piece itself
// never needs the network or an API key: at the venue it just plays files.
//
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

function loadPoems() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(POEMS_FILE, "utf8"), sandbox);
  return [...sandbox.window.POEMS, ...sandbox.window.POEMS_LONGER];
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

if (cmd === "voices") {
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
  const manifestFile = path.join(OUT, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { poems: {} };
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
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\n${made} recorded, ${chars} characters, in ${path.relative(process.cwd(), OUT)}/ — voice: ${voice.name}, model: ${s.model}`);
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
