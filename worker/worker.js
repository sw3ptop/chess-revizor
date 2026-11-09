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
      this.handler = l => {
        if (l.startsWith("info ") && l.includes(" pv ") && l.includes(" score ")) {
          if (/\b(lowerbound|upperbound)\b/.test(l)) return;
          const k = +((l.match(/\bmultipv (\d+)/) || [])[1] || 1);
          const sc = l.match(/\bscore (cp|mate) (-?\d+)/), pv = (l.match(/\bpv (.+)$/) || [])[1];
          if (sc && pv) L[k] = { t: sc[1], v: +sc[2], pv: pv.split(" ") };
        } else if (l.startsWith("bestmove")) { this.handler = null; res(L); }
      };
      this.send("position fen " + fen);
      this.send("go depth " + depth);
    });
  }
  stop() { try { this.send("quit"); } catch (e) {} if (this.p) this.p.kill(); }
}

/* ------------------------------------------------------------------ math */
const winp = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
const stmWin = ln => !ln ? null : ln.t === "mate" ? (ln.v > 0 ? 100 : 0) : winp(ln.v);
const stmDisp = ln => !ln ? "" : ln.t === "mate" ? (ln.v > 0 ? "" : "-") + "M" + Math.abs(ln.v) : (ln.v >= 0 ? "+" : "") + (ln.v / 100).toFixed(1);
const accOf = loss => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
const V = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const ACC = { p: "пешку", n: "коня", b: "слона", r: "ладью", q: "ферзя", k: "короля" };
const GEN = { p: "пешки", n: "коня", b: "слона", r: "ладьи", q: "ферзя", k: "короля" };
const material = (fen, c) => [...fen.split(" ")[0]].reduce((a, ch) => {
  const t = ch.toLowerCase(); if (!(t in V)) return a;
  const w = ch === ch.toUpperCase(); return a + ((w ? "w" : "b") === c ? V[t] : -V[t]);
}, 0);
const pts = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "очко" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? "очка" : "очков"}`;
function play(fen, ucis, n) {
  const c = new Chess(fen), out = [];
  for (const u of ucis.slice(0, n)) { const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); if (!m) break; out.push(m); }
  return { moves: out, fen: c.fen() };
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
      const base = +(tcRaw.split("+")[0]) || 0;
      out.push({ id, pgn: g, url: link, tc: tcRaw.includes("/") || tcRaw === "-" ? "daily" : base < 180 ? "bullet" : base < 600 ? "blitz" : "rapid" });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ analysis */
function parse(pgn) {
  const hdr = {}; pgn.replace(/^\[(\w+) "([^"]*)"\]$/gm, (_, k, v) => { hdr[k] = v; });
  const body = pgn.replace(/^\[.*\]$/gm, "");
  const clocks = [...body.matchAll(/%clk (\d+):(\d+):(\d+(?:\.\d+)?)/g)].map(m => +m[1] * 3600 + +m[2] * 60 + +m[3]);
  let t = body.replace(/\{[^}]*\}/g, " ").replace(/\$\d+/g, " "); let p;
  do { p = t; t = t.replace(/\([^()]*\)/g, " "); } while (t !== p);
  t = t.replace(/(\d+)\.\.\./g, "$1.").replace(/\s+/g, " ").trim();
  const c = new Chess(); if (!c.load_pgn(t, { sloppy: true })) return null;
  return { hdr, hist: c.history({ verbose: true }), clocks };
}

function explain(fen, side, played, ref, best, refMate, bestMate, loss, gain) {
  // plain-language coaching for one mistake
  const pm = played, r0 = ref[0];
  const parts = [];
  if (refMate) parts.push(`После ${pm.san} у соперника мат: ${ref.map(m => m.san).join(" ")}.`);
  else if (r0 && r0.captured) {
    const sq = r0.to;
    if (sq === pm.to) parts.push(`${pm.san}: фигура встала под удар, и соперник забирает ${ACC[r0.captured]} ходом ${r0.san}.`);
    else parts.push(`После ${pm.san} соперник забирает ${ACC[r0.captured]} на ${sq} ходом ${r0.san}.`);
  } else if (r0 && r0.san.includes("+")) parts.push(`После ${pm.san} соперник отвечает шахом ${r0.san}.`);
  else if (r0) parts.push(`После ${pm.san} соперник отвечает ${r0.san}.`);
  if (!refMate && loss > 0) parts.push(`В итоге ты теряешь ${pts(loss)} материала.`);
  const b0 = best[0];
  if (bestMate) parts.push(`А был мат в ${bestMate}: ${best.map(m => m.san).join(" ")}.`);
  else if (b0 && b0.captured && gain > 0) parts.push(`Надо было забрать ${ACC[b0.captured]}: ${b0.san}.`);
  else if (b0 && b0.san.includes("+")) parts.push(`Сильнее шах ${b0.san}${best.length > 1 ? ": " + best.map(m => m.san).join(" ") : ""}.`);
  else if (b0) parts.push(`Лучше было ${b0.san}${best.length > 1 ? " — дальше " + best.slice(1).map(m => m.san).join(" ") : ""}.`);
  let kind = "position";
  if (refMate) kind = "mate_allowed";
  else if (bestMate) kind = "mate_missed";
  else if (r0 && r0.captured && loss >= 2) kind = "hung";
  else if (b0 && b0.captured && gain >= 2) kind = "missed_win";
  return { text: parts.join(" "), kind };
}

async function analyseGame(eng, g) {
  const P = parse(g.pgn); if (!P) return null;
  const h = P.hdr, white = h.White, black = h.Black;
  const me = white.toLowerCase() === PLAYER ? "w" : black.toLowerCase() === PLAYER ? "b" : null;
  if (!me) return null;
  const r = new Chess(), plies = [];
  for (let i = 0; i <= P.hist.length; i++) {
    const fen = r.fen(); let a;
    if (r.in_checkmate()) a = { ww: r.turn() === "w" ? 0 : 100, w1: 0, w2: null, best: null, pv: [], disp: "#", mate: null };
    else if (r.game_over()) a = { ww: 50, w1: 50, w2: null, best: null, pv: [], disp: "0.0", mate: null };
    else {
      const L = await eng.analyse(fen, DEPTH);
      const w1 = stmWin(L[1]), w2 = stmWin(L[2]);
      a = { ww: r.turn() === "w" ? w1 : 100 - w1, w1, w2, best: L[1] && L[1].pv[0], pv: L[1] ? L[1].pv.slice(0, 8) : [], disp: stmDisp(L[1]), mate: L[1] && L[1].t === "mate" ? L[1].v : null };
    }
    const m = P.hist[i];
    plies.push({ fen, ...a, m });
    if (m) r.move({ from: m.from, to: m.to, promotion: m.promotion });
  }
  const pov = (c, x) => c === "w" ? x : 100 - x;
  const acc = { w: [], b: [] }, cls = { w: {}, b: {} }, mistakes = [];
  for (let i = 0; i < plies.length - 1; i++) {
    const p = plies[i], q = plies[i + 1], m = p.m; if (!m) break;
    const before = pov(m.color, p.ww), after = pov(m.color, q.ww), loss = Math.max(0, before - after);
    acc[m.color].push(accOf(loss));
    const uci = m.from + m.to + (m.promotion || "");
    const c = uci === p.best ? "best" : loss < 2 ? "excellent" : loss < 5 ? "good" : loss < 10 ? "inaccuracy" : loss < 20 ? "mistake" : "blunder";
    cls[m.color][c] = (cls[m.color][c] || 0) + 1;
    if (m.color === me && loss >= 10 && p.best && uci !== p.best) {
      // what happened after the played move, and what was better
      const ref = play(q.fen, q.pv, 3).moves;
      const refMate = q.mate && q.mate > 0 ? q.mate : null;
      const bestLine = play(p.fen, p.pv, 5);
      const best = bestLine.moves.slice(0, Math.max(1, bestLine.moves.length % 2 ? bestLine.moves.length : bestLine.moves.length - 1));
      const endBest = play(p.fen, best.map(x => x.from + x.to + (x.promotion || "")), 9).fen;
      const endRef = play(q.fen, ref.map(x => x.from + x.to + (x.promotion || "")), 9).fen;
      const lossMat = Math.max(0, material(p.fen, me) - material(endRef, me));
      const gainMat = material(endBest, me) - material(p.fen, me);
      const bestMate = p.mate && p.mate > 0 ? p.mate : null;
      const ex = explain(p.fen, me, m, ref, best, refMate, bestMate, lossMat, gainMat);
      const clear = p.w2 == null || p.w1 - p.w2 >= 8;
      const moveNo = Math.floor(i / 2) + 1;
      mistakes.push({
        ply: i, move: moveNo, label: `${moveNo}${m.color === "w" ? "." : "..."}${m.san}`,
        fen: p.fen, last: plies[i - 1] && plies[i - 1].m ? plies[i - 1].m.from + plies[i - 1].m.to : null,
        played: m.san, best: best.map(x => x.san), ref: ref.map(x => x.san),
        loss: Math.round(loss), cls: c, lossMat, gainMat, mate: bestMate, refMate,
        text: ex.text, kind: ex.kind, phase: i < 20 ? "дебют" : i < 60 ? "миттельшпиль" : "эндшпиль",
        evalBefore: p.disp, evalAfter: q.disp, clock: P.clocks[i] ?? null, puzzle: clear
      });
    }
  }
  const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
  const res = h.Result;
  const result = res === "1/2-1/2" ? "draw" : (res === "1-0") === (me === "w") ? "win" : "loss";
  const myClocks = P.clocks.filter((_, i) => (i % 2 === 0) === (me === "w"));
  return {
    id: g.id, url: g.url || h.Link || "", date: (h.UTCDate || h.Date || "").replace(/\./g, "-"), time: h.UTCTime || "",
    tc: g.tc, me, opp: me === "w" ? black : white, myElo: +(me === "w" ? h.WhiteElo : h.BlackElo) || null, oppElo: +(me === "w" ? h.BlackElo : h.WhiteElo) || null,
    result, termination: h.Termination || "", eco: (h.ECOUrl || "").split("/").pop().replace(/-/g, " "),
    opening: P.hist.slice(0, 6).map(x => x.san), plies: P.hist.length,
    acc: avg(acc[me]), accOpp: avg(acc[me === "w" ? "b" : "w"]), cls: cls[me], clsOpp: cls[me === "w" ? "b" : "w"],
    minClock: myClocks.length ? Math.min(...myClocks) : null,
    curve: plies.map(p => Math.round(pov(me, p.ww))),
    moves: P.hist.map(x => x.san),
    mistakes
  };
}

/* ------------------------------------------------------------------ summary */
function buildProfile(all) {
  all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
  const by = (key) => { const o = {}; for (const g of all) { const k = key(g); (o[k] = o[k] || []).push(g); } return o; };
  const stat = gs => ({ n: gs.length, win: gs.filter(g => g.result === "win").length, loss: gs.filter(g => g.result === "loss").length, draw: gs.filter(g => g.result === "draw").length, acc: avg(gs.map(g => g.acc).filter(x => x != null)) });
  const kinds = {}; const phases = {};
  for (const g of all) for (const m of g.mistakes) { if (m.cls === "blunder" || m.cls === "mistake") { kinds[m.kind] = (kinds[m.kind] || 0) + 1; phases[m.phase] = (phases[m.phase] || 0) + 1; } }
  const openings = Object.entries(by(g => g.me + "|" + g.opening.slice(0, g.me === "w" ? 3 : 2).join(" ")))
    .map(([k, gs]) => ({ me: k[0], line: k.slice(2), ...stat(gs) })).filter(o => o.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10);
  const last = all.slice(-20);
  return {
    player: PLAYER, updated: new Date().toISOString(),
    total: stat(all), recent: stat(last),
    byColor: { w: stat(all.filter(g => g.me === "w")), b: stat(all.filter(g => g.me === "b")) },
    byTc: Object.fromEntries(Object.entries(by(g => g.tc)).map(([k, gs]) => [k, stat(gs)])),
    rating: all.filter(g => g.myElo && g.tc === "blitz").map(g => ({ d: g.date, r: g.myElo })),
    blundersPerGame: all.length ? +(all.reduce((a, g) => a + (g.cls.blunder || 0), 0) / all.length).toFixed(2) : 0,
    kinds, phases, openings,
    timeTrouble: all.filter(g => g.minClock != null && g.minClock < 30 && g.tc !== "daily").length,
    games: all.slice().reverse().map(g => ({ id: g.id, date: g.date, tc: g.tc, me: g.me, opp: g.opp, oppElo: g.oppElo, myElo: g.myElo, result: g.result, acc: g.acc, accOpp: g.accOpp, blunders: g.cls.blunder || 0, mistakes: g.cls.mistake || 0, opening: g.opening.slice(0, 4).join(" "), eco: g.eco, termination: g.termination }))
  };
}
function buildPuzzles(all) {
  const out = [];
  for (const g of all.slice().sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))) {
    for (const m of g.mistakes) {
      if (!m.puzzle || m.loss < 15) continue;
      out.push({ id: `g${g.id}-${m.ply}`, tab: "m", side: g.me, fen: m.fen, last: m.last, san: m.best, alt: [m.best[0]], played: m.played, ref: m.ref,
        loss: m.lossMat, gain: m.gainMat, mate: m.mate, title: `Ход ${m.move}`, sub: `${g.opp} · ${m.move}-й ход`, why: m.text,
        notes: {}, hints: { "0": "Сначала посмотри на все шахи и взятия — свои и его." }, ev: "", tag: "ошибка", tc: "r" });
    }
    if (out.length >= 80) break;
  }
  return out;
}

function writeSummary() {
  const all = fs.readdirSync(GAMES).filter(f => f.endsWith(".json")).map(f => { try { return JSON.parse(fs.readFileSync(path.join(GAMES, f), "utf8")); } catch (e) { return null; } }).filter(Boolean);
  fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify(buildProfile(all)));
  fs.writeFileSync(path.join(DATA, "puzzles.json"), JSON.stringify(buildPuzzles(all)));
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
        const a = await analyseGame(eng, g);
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
