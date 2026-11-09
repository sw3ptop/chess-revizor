/*
 * Chess Revizor core: the analysis shared by the server worker (Node) and the website (browser).
 * Turns a PGN into a per-game review (accuracy, move classes, mistakes with plain-language
 * explanations) and builds the player profile and the mistake puzzles from those reviews.
 *
 *   Node:    const core = require("../core.js"); core.setChess(Chess);
 *   Browser: <script src="core.js"></script>  → window.RevCore (uses the global Chess)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RevCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  let Chess = typeof globalThis !== "undefined" && globalThis.Chess ? globalThis.Chess : null;
  const setChess = C => { Chess = C; };

  /* ---------------------------------------------------------------- math */
  const winp = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  const stmWin = ln => !ln ? null : ln.t === "mate" ? (ln.v > 0 ? 100 : 0) : winp(ln.v);
  const stmDisp = ln => !ln ? "" : ln.t === "mate" ? (ln.v > 0 ? "" : "-") + "M" + Math.abs(ln.v) : (ln.v >= 0 ? "+" : "") + (ln.v / 100).toFixed(1);
  const accOf = loss => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
  const V = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const ACC = { p: "пешку", n: "коня", b: "слона", r: "ладью", q: "ферзя", k: "короля" };
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

  /* ---------------------------------------------------------------- UCI */
  // feeds engine output lines into a {multipv: {t, v, pv}} map; returns true on "bestmove"
  function uciLine(L, l) {
    if (l.startsWith("info ") && l.includes(" pv ") && l.includes(" score ")) {
      if (/\b(lowerbound|upperbound)\b/.test(l)) return false;
      const k = +((l.match(/\bmultipv (\d+)/) || [])[1] || 1);
      const sc = l.match(/\bscore (cp|mate) (-?\d+)/), pv = (l.match(/\bpv (.+)$/) || [])[1];
      if (sc && pv) L[k] = { t: sc[1], v: +sc[2], pv: pv.split(" ") };
      return false;
    }
    return l.startsWith("bestmove");
  }

  /* ---------------------------------------------------------------- games */
  function timeClass(tcRaw) {
    const base = +(String(tcRaw || "").split("+")[0]) || 0;
    return String(tcRaw).includes("/") || tcRaw === "-" ? "daily" : base < 180 ? "bullet" : base < 600 ? "blitz" : "rapid";
  }
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

  // eng.analyse(fen, depth) → Promise<{1:{t,v,pv}, 2:{…}}> (MultiPV 2)
  // g = {id, pgn, tc, url}; opts = {player, depth, onPly(i, n)}
  async function analyseGame(eng, g, opts) {
    const PLAYER = String(opts.player || "").toLowerCase(), DEPTH = opts.depth || 14;
    const P = parse(g.pgn); if (!P) return null;
    const h = P.hdr, white = h.White || "", black = h.Black || "";
    const me = white.toLowerCase() === PLAYER ? "w" : black.toLowerCase() === PLAYER ? "b" : null;
    if (!me) return null;
    const r = new Chess(), plies = [];
    for (let i = 0; i <= P.hist.length; i++) {
      const fen = r.fen(); let a;
      if (r.in_checkmate()) a = { ww: r.turn() === "w" ? 0 : 100, w1: 0, w2: null, best: null, pv: [], disp: "#", mate: null };
      else if (r.game_over()) a = { ww: 50, w1: 50, w2: null, best: null, pv: [], disp: "0.0", mate: null };
      else {
        const L = await eng.analyse(fen, DEPTH);
        if (!L[1]) throw new Error("движок не дал оценку");
        const w1 = stmWin(L[1]), w2 = stmWin(L[2]);
        a = { ww: r.turn() === "w" ? w1 : 100 - w1, w1, w2, best: L[1] && L[1].pv[0], pv: L[1] ? L[1].pv.slice(0, 8) : [], disp: stmDisp(L[1]), mate: L[1] && L[1].t === "mate" ? L[1].v : null };
      }
      const m = P.hist[i];
      plies.push({ fen, ...a, m });
      if (m) r.move({ from: m.from, to: m.to, promotion: m.promotion });
      if (opts.onPly) opts.onPly(i + 1, P.hist.length + 1);
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
      tc: g.tc || timeClass(h.TimeControl), me, opp: me === "w" ? black : white, myElo: +(me === "w" ? h.WhiteElo : h.BlackElo) || null, oppElo: +(me === "w" ? h.BlackElo : h.WhiteElo) || null,
      result, termination: h.Termination || "", eco: (h.ECOUrl || "").split("/").pop().replace(/-/g, " "),
      opening: P.hist.slice(0, 6).map(x => x.san), plies: P.hist.length,
      acc: avg(acc[me]), accOpp: avg(acc[me === "w" ? "b" : "w"]), cls: cls[me], clsOpp: cls[me === "w" ? "b" : "w"],
      minClock: myClocks.length ? Math.min(...myClocks) : null,
      curve: plies.map(p => Math.round(pov(me, p.ww))),
      moves: P.hist.map(x => x.san), depth: DEPTH,
      mistakes
    };
  }

  /* ---------------------------------------------------------------- summary */
  function buildProfile(all, player) {
    all = all.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
    const by = (key) => { const o = {}; for (const g of all) { const k = key(g); (o[k] = o[k] || []).push(g); } return o; };
    const stat = gs => ({ n: gs.length, win: gs.filter(g => g.result === "win").length, loss: gs.filter(g => g.result === "loss").length, draw: gs.filter(g => g.result === "draw").length, acc: avg(gs.map(g => g.acc).filter(x => x != null)) });
    const kinds = {}; const phases = {};
    for (const g of all) for (const m of g.mistakes) { if (m.cls === "blunder" || m.cls === "mistake") { kinds[m.kind] = (kinds[m.kind] || 0) + 1; phases[m.phase] = (phases[m.phase] || 0) + 1; } }
    const openings = Object.entries(by(g => g.me + "|" + g.opening.slice(0, g.me === "w" ? 3 : 2).join(" ")))
      .map(([k, gs]) => ({ me: k[0], line: k.slice(2), ...stat(gs) })).filter(o => o.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10);
    const last = all.slice(-20);
    return {
      player, updated: new Date().toISOString(),
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

  return { setChess, winp, accOf, uciLine, timeClass, parse, explain, analyseGame, buildProfile, buildPuzzles };
});
