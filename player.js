/*
 * Chess Revizor player library (browser): whose profile is open, that player's analysed games
 * (kept in this browser's localStorage), and a pool of Stockfish workers that analyses new games
 * from chess.com with the shared core (core.js). Players listed in SERVER are analysed by the
 * project's own server instead and read from data/.
 */
(function () {
  "use strict";
  const SF_URL = "https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js";
  const SERVER = { sw3p7: "data/" };
  const norm = n => String(n || "").trim().toLowerCase();
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  /* ------------------------------------------------------------ whose profile */
  function getMe() {
    const q = new URLSearchParams(location.search).get("u");
    if (q && /^[\w-]{2,40}$/.test(q.trim())) { setMe(q); return q.trim(); }
    return (LS.get("revizor-me") || "").trim();
  }
  function setMe(n) { n = String(n || "").trim(); if (n) LS.set("revizor-me", n); else LS.del("revizor-me"); }
  const isServer = n => Object.prototype.hasOwnProperty.call(SERVER, norm(n));

  /* ------------------------------------------------------------ storage */
  const key = n => "revizor-lib:" + norm(n);
  function load(n) {
    try { const o = JSON.parse(LS.get(key(n)) || "null"); if (o && o.games) return o; } catch (e) {}
    return { games: {}, skip: [], name: String(n || "").trim() };
  }
  function save(n, lib) {
    let s = JSON.stringify(lib);
    if (LS.set(key(n), s)) return true;
    // out of space: drop the oldest games of this player and try again
    const ids = Object.values(lib.games).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(g => g.id);
    while (ids.length > 10) {
      ids.splice(0, 10).forEach(id => delete lib.games[id]);
      if (LS.set(key(n), JSON.stringify(lib))) return true;
    }
    return false;
  }
  function forget(n) { LS.del(key(n)); }
  const games = n => Object.values(load(n).games);
  const profile = n => { const L = load(n); return core().buildProfile(Object.values(L.games), L.name || n); };
  const puzzles = n => core().buildPuzzles(games(n));
  const core = () => window.RevCore;

  /* ------------------------------------------------------------ chess.com */
  async function getJSON(u) {
    let r;
    try { r = await fetch(u); } catch (e) { const x = new Error("net"); x.code = "net"; throw x; }
    if (r.status === 404) { const x = new Error("404"); x.code = 404; throw x; }
    if (!r.ok) { const x = new Error("HTTP " + r.status); x.code = r.status; throw x; }
    return r.json();
  }
  const player = n => getJSON(`https://api.chess.com/pub/player/${encodeURIComponent(norm(n))}`);
  // newest first; standard chess only; reads monthly archives until `want` games are found
  async function fetchList(n, want) {
    const arch = ((await getJSON(`https://api.chess.com/pub/player/${encodeURIComponent(norm(n))}/games/archives`)).archives || []).reverse();
    const out = [];
    for (const a of arch.slice(0, 24)) {
      const gs = ((await getJSON(a)).games || []).filter(g => g.rules === "chess" && g.pgn);
      for (const g of gs) {
        const id = (String(g.url || "").match(/(\d+)$/) || [])[1];
        if (id) out.push({ id, pgn: g.pgn, tc: g.time_class, url: g.url, end: g.end_time || 0 });
      }
      if (out.length >= want) break;
    }
    return out.sort((a, b) => b.end - a.end);
  }

  /* ------------------------------------------------------------ engine */
  class Engine {
    init() {
      return new Promise((res, rej) => {
        try { this.w = new Worker(URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(SF_URL)});`], { type: "text/javascript" }))); }
        catch (e) { rej(e); return; }
        const t = setTimeout(() => rej(new Error("движок не ответил за 30 секунд")), 30000);
        this.w.onerror = e => { clearTimeout(t); rej(new Error(e.message || "движок не загрузился")); };
        this.w.onmessage = e => String(e.data).split("\n").forEach(l => this.h && this.h(l.trim()));
        this.h = l => {
          if (l === "uciok") { this.send("setoption name MultiPV value 2"); this.send("setoption name Hash value 16"); this.send("isready"); }
          else if (l === "readyok") { clearTimeout(t); this.h = null; res(this); }
        };
        this.send("uci");
      });
    }
    send(c) { this.w.postMessage(c); }
    analyse(fen, depth) {
      return new Promise((res, rej) => {
        const L = {};
        this.fail = rej;
        this.h = l => { if (core().uciLine(L, l)) { this.h = null; this.fail = null; res(L); } };
        this.send("position fen " + fen);
        this.send("go depth " + depth);
      });
    }
    kill() { try { this.w.terminate(); } catch (e) {} if (this.fail) this.fail(new Error("stopped")); }
  }
  const workers = () => Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

  /* ------------------------------------------------------------ sync */
  // Analyses up to `limit` not-yet-analysed games (newest first).
  // onProgress({phase, done, total, frac, game}) — phase: "list" | "engine" | "game" | "end"
  // Returns a controller {stop(), done: Promise<{added, left, error}>}.
  function sync(n, opts) {
    opts = opts || {};
    const limit = opts.limit || 20, depth = opts.depth || 12, on = opts.onProgress || (() => {});
    let stopped = false; const engines = [];
    const done = (async () => {
      const lib = load(n);
      const have = new Set(Object.keys(lib.games).concat(lib.skip || []));
      on({ phase: "list", done: 0, total: 0, frac: 0 });
      let list;
      try { list = await fetchList(n, have.size + limit); }
      catch (e) { return { added: 0, left: 0, error: e.code === 404 ? "notfound" : "net" }; }
      if (stopped) return { added: 0, left: 0, stopped: true };
      const all = list.filter(g => !have.has(g.id));
      const todo = all.slice(0, limit);
      if (!todo.length) { on({ phase: "end", done: 0, total: 0, frac: 1 }); return { added: 0, left: 0, total: list.length }; }
      on({ phase: "engine", done: 0, total: todo.length, frac: 0 });
      const k = Math.min(workers(), todo.length);
      try { for (let i = 0; i < k; i++) engines.push(await new Engine().init()); }
      catch (e) { engines.forEach(x => x.kill()); return { added: 0, left: all.length, error: "engine", message: e.message }; }
      let next = 0, added = 0; const part = {};
      const report = g => {
        const frac = (added + Object.values(part).reduce((a, b) => a + b, 0)) / todo.length;
        on({ phase: "game", done: added, total: todo.length, frac: Math.min(1, frac), game: g });
      };
      await Promise.all(engines.map(async (eng, wi) => {
        while (!stopped && next < todo.length) {
          const g = todo[next++];
          let a = null;
          try { a = await core().analyseGame(eng, g, { player: n, depth, onPly: (i, N) => { part[wi] = i / N; report(null); } }); }
          catch (e) { if (stopped) return; }
          part[wi] = 0;
          if (stopped) return;
          const L = load(n);
          if (a) { L.games[a.id] = a; added++; } else { L.skip = (L.skip || []).concat(g.id); }
          if (!L.name) L.name = String(n).trim();
          save(n, L);
          report(a);
        }
      }));
      engines.forEach(x => x.kill());
      on({ phase: "end", done: added, total: todo.length, frac: 1 });
      return { added, left: Math.max(0, all.length - todo.length), stopped };
    })();
    return { stop() { stopped = true; engines.forEach(x => x.kill()); }, done };
  }

  window.RevPlayer = { SERVER, norm, getMe, setMe, isServer, load, save, forget, games, profile, puzzles, player, fetchList, sync, workers };
})();
