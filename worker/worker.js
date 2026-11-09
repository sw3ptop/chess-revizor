#!/usr/bin/env node
/*
 * Chess Revizor scout: downloads a player's games from chess.com, analyses every
 * move with Stockfish and writes the results into ../data for the website.
 *
 *   node worker.js                 fetch new games from chess.com, analyse, write data, git push
 *   node worker.js --pgn a.pgn     analyse games from local PGN files instead (no network)
 *   node worker.js --no-push       do not commit/push
 *
 * Settings (environment): PLAYER, DEPTH, MAX_GAMES, STOCKFISH (path to binary),
 * STOCKFISH_JS (path to stockfish.js + .wasm fallback), CHESSJS (path to chess.js).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const GAMES = path.join(DATA, "games");
const PLAYER = (process.env.PLAYER || "sw3p7").toLowerCase();
const DEPTH = +(process.env.DEPTH || 14);
const MAX_GAMES = +(process.env.MAX_GAMES || 150);
const args = process.argv.slice(2);
const PGN_FILES = args.flatMap((a, i) => (args[i - 1] === "--pgn" ? [a] : []));
const NO_PUSH = args.includes("--no-push") || PGN_FILES.length > 0 && !args.includes("--push");

let Chess;
try { ({ Chess } = require("chess.js")); } catch (e) { ({ Chess } = require(process.env.CHESSJS)); }
// analysis shared with the website (../core.js)
const core = require(path.join(ROOT, "core.js"));
core.setChess(Chess);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------------ engine */
class Engine {
  constructor() { this.buf = ""; this.handler = null; }
  start() {
    return new Promise((resolve, reject) => {
      const bin = process.env.STOCKFISH || "stockfish";
      const onLine = l => this.handler && this.handler(l.trim());
      if (process.env.STOCKFISH_JS) {
        const SF = require(process.env.STOCKFISH_JS);
        this.sf = SF(process.env.STOCKFISH_JS.replace(/\.js$/, ".wasm"));
        this.sf.onmessage = m => String(m).split("\n").forEach(onLine);
        this.send = c => this.sf.postMessage(c);
      } else {
        this.p = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
        this.p.on("error", reject);
        this.p.stdout.on("data", d => { this.buf += d; const parts = this.buf.split("\n"); this.buf = parts.pop(); parts.forEach(onLine); });
        this.send = c => this.p.stdin.write(c + "\n");
      }
      this.handler = l => { if (l === "readyok") { this.handler = null; resolve(); } };
      this.send("uci");
      this.send("setoption name MultiPV value 2");
      if (!process.env.STOCKFISH_JS) this.send("setoption name Threads value " + (process.env.THREADS || 1));
      this.send("isready");
    });
  }
  analyse(fen, depth) {
    return new Promise(res => {
      const L = {};
      this.handler = l => { if (core.uciLine(L, l)) { this.handler = null; res(L); } };
      this.send("position fen " + fen);
      this.send("go depth " + depth);
    });
  }
  stop() { try { this.send("quit"); } catch (e) {} if (this.p) this.p.kill(); }
}

/* ------------------------------------------------------------------ chess.com */
const UA = { "User-Agent": "chess-revizor-scout/1.0 (github.com/sw3ptop/chess-revizor)" };
async function getJSON(u) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(u, { headers: UA });
    if (r.ok) return r.json();
    if (r.status === 404) throw new Error("404 " + u);
    await new Promise(s => setTimeout(s, 2000 * (i + 1)));
  }
  throw new Error("chess.com не отвечает: " + u);
}
async function fetchGames(done) {
  const arch = ((await getJSON(`https://api.chess.com/pub/player/${PLAYER}/games/archives`)).archives || []).reverse();
  const out = [];
  const firstRun = done.size === 0;
  for (const a of arch.slice(0, firstRun ? 12 : 2)) {
    const gs = ((await getJSON(a)).games || []).filter(g => g.rules === "chess" && g.pgn);
    for (const g of gs) { const id = (g.url.match(/(\d+)$/) || [])[1]; if (id && !done.has(id)) out.push({ id, pgn: g.pgn, tc: g.time_class, url: g.url }); }
    if (out.length >= MAX_GAMES) break;
  }
  return out.slice(0, MAX_GAMES);
}
function readPgnFiles(files, done) {
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8").replace(/\r/g, "");
    for (const g of raw.split(/\n(?=\[Event )/).filter(x => x.trim())) {
      const link = (g.match(/\[Link "([^"]+)"\]/) || [])[1] || "";
      const id = (link.match(/(\d+)$/) || [])[1]; if (!id || done.has(id)) continue;
      const tcRaw = (g.match(/\[TimeControl "([^"]+)"\]/) || [])[1] || "";
      out.push({ id, pgn: g, url: link, tc: core.timeClass(tcRaw) });
    }
  }
  return out;
}

function writeSummary() {
  const all = fs.readdirSync(GAMES).filter(f => f.endsWith(".json")).map(f => { try { return JSON.parse(fs.readFileSync(path.join(GAMES, f), "utf8")); } catch (e) { return null; } }).filter(Boolean);
  fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify(core.buildProfile(all, PLAYER)));
  fs.writeFileSync(path.join(DATA, "puzzles.json"), JSON.stringify(core.buildPuzzles(all)));
  return all.length;
}

/* ------------------------------------------------------------------ git */
const sh = c => execSync(c, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
function publish(msg) {
  if (NO_PUSH) return true;
  try {
    sh("git add -A data");
    if (sh("git status --porcelain data")) sh(`git -c user.name="chess-scout" -c user.email="scout@localhost" commit -q -m "${msg}"`);
    sh("git pull -q --rebase -X theirs origin main");
    if (sh("git rev-list --count origin/main..HEAD") !== "0") { sh("git push -q origin main"); log("выложено на сайт"); }
    return true;
  } catch (e) {
    const err = (e.stderr ? e.stderr.toString() : e.message).trim().split("\n").slice(-3).join(" | ");
    log("git: " + err);
    if (/read only|denied|Permission/i.test(err)) log("ключ без права записи: в GitHub → Settings → Deploy keys включи «Allow write access»");
    try { sh("git rebase --abort"); } catch (_) {}
    return false;
  }
}

/* ------------------------------------------------------------------ main */
(async () => {
  fs.mkdirSync(GAMES, { recursive: true });
  // push anything left from an earlier run (e.g. a failed push), and pick up site updates
  if (!NO_PUSH) publish("Анализ партий");
  const done = new Set(fs.readdirSync(GAMES).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)));
  const fresh = PGN_FILES.length ? readPgnFiles(PGN_FILES, done) : await fetchGames(done);
  log(`новых партий: ${fresh.length}`);
  if (fresh.length) {
    const eng = new Engine(); await eng.start();
    for (const [i, g] of fresh.entries()) {
      const t0 = Date.now();
      try {
        const a = await core.analyseGame(eng, g, { player: PLAYER, depth: DEPTH });
        if (a) { fs.writeFileSync(path.join(GAMES, g.id + ".json"), JSON.stringify(a)); log(`${i + 1}/${fresh.length} ${a.date} против ${a.opp}: точность ${a.acc}, ошибок ${a.mistakes.length} (${((Date.now() - t0) / 1000).toFixed(0)} с)`); }
      } catch (e) { log(`${i + 1}/${fresh.length} партия ${g.id} пропущена: ${e.message}`); }
      if ((i + 1) % 15 === 0 && i + 1 < fresh.length) { writeSummary(); publish(`Анализ партий: ${i + 1} из ${fresh.length}`); }
    }
    eng.stop();
  }
  const n = writeSummary();
  log(`профиль: ${n} партий`);
  if (!publish(`Анализ партий: +${fresh.length}`)) process.exitCode = 1;
  process.exit();
})().catch(e => { log("ошибка: " + e.message); process.exit(1); });
