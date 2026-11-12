/*
 * Chess Revizor opening courses (browser).
 * Data: openings.json — the lichess-org/chess-openings list (CC0): every named line with its ECO code,
 * each extended by a few Stockfish moves. From a player's chess.com games this module finds the two
 * openings they play most with White and with Black, and turns each into a course: the player's own
 * moves are fixed to one system (their habit, else the main line), every popular reply of the
 * opponent becomes its own section.
 */
(function () {
  "use strict";
  const RU = {
    "Sicilian Defense": "Сицилианская защита", "Ruy Lopez": "Испанская партия", "French Defense": "Французская защита",
    "Queen's Gambit": "Ферзевый гамбит", "Italian Game": "Итальянская партия", "English Opening": "Английское начало",
    "King's Gambit": "Королевский гамбит", "King's Indian Defense": "Староиндийская защита", "Caro-Kann Defense": "Защита Каро-Канн",
    "Nimzo-Indian Defense": "Защита Нимцовича", "Queen's Pawn Game": "Дебют ферзевой пешки", "Semi-Slav Defense": "Полуславянская защита",
    "Dutch Defense": "Голландская защита", "Benoni Defense": "Защита Бенони", "Grünfeld Defense": "Защита Грюнфельда",
    "Queen's Indian Defense": "Новоиндийская защита", "Alekhine Defense": "Защита Алехина", "Scotch Game": "Шотландская партия",
    "Indian Defense": "Индийская защита", "Slav Defense": "Славянская защита", "Petrov's Defense": "Русская партия", "Russian Game": "Русская партия",
    "Four Knights Game": "Партия четырёх коней", "Three Knights Opening": "Дебют трёх коней", "Zukertort Opening": "Дебют Цукерторта",
    "Scandinavian Defense": "Скандинавская защита", "Philidor Defense": "Защита Филидора", "Réti Opening": "Дебют Рети",
    "Nimzowitsch Defense": "Защита Нимцовича (1...Nc6)", "Vienna Game": "Венская партия", "Vienna Gambit": "Венский гамбит",
    "Bishop's Opening": "Дебют слона", "Modern Defense": "Современная защита", "King's Pawn Game": "Дебют королевской пешки",
    "Van Geet Opening": "Дебют Ван Гета", "Pterodactyl Defense": "Защита «Птеродактиль»", "Catalan Opening": "Каталонское начало",
    "Pirc Defense": "Защита Пирца", "Bird Opening": "Дебют Берда", "Tarrasch Defense": "Защита Тарраша", "Polish Opening": "Польское начало",
    "Neo-Grünfeld Defense": "Защита Нео-Грюнфельда", "Blackmar-Diemer Gambit": "Гамбит Блэкмара — Димера", "Bogo-Indian Defense": "Защита Боголюбова",
    "King's Indian Attack": "Королевско-индийская атака", "Hungarian Opening": "Венгерское начало", "Grob Opening": "Дебют Гроба",
    "Nimzo-Larsen Attack": "Атака Нимцовича — Ларсена", "Center Game": "Центральный дебют", "Latvian Gambit": "Латышский гамбит",
    "Ponziani Opening": "Дебют Понциани", "Old Indian Defense": "Защита Чигорина (Old Indian)", "Trompowsky Attack": "Атака Тромповского",
    "Benko Gambit": "Волжский гамбит", "Englund Gambit": "Гамбит Энглунда", "Owen Defense": "Защита Оуэна", "St. George Defense": "Защита Святого Георгия",
    "London System": "Лондонская система", "Colle System": "Система Колле", "Stonewall Attack": "Атака «Стонуолл»", "Torre Attack": "Атака Торре",
    "Rapport-Jobava System": "Система Рапорта — Жобавы", "Budapest Defense": "Будапештский гамбит", "Elephant Gambit": "Гамбит «Элефант»",
    "Danish Gambit": "Датский гамбит", "Philidor": "Защита Филидора", "Semi-Italian Opening": "Полуитальянская партия", "Portuguese Opening": "Португальское начало",
    "Kádas Opening": "Дебют Кадаша", "Mieses Opening": "Дебют Мизеса", "Saragossa Opening": "Сарагосское начало", "Ware Opening": "Дебют Уэра",
    "Amar Opening": "Дебют Амара", "Anderssen Opening": "Дебют Андерсена", "Clemenz Opening": "Дебют Клеменса", "Durkin Opening": "Дебют Дуркина",
    "Barnes Opening": "Дебют Барнса", "Sodium Attack": "Атака «Натрий»", "Lemberger Countergambit": "Контргамбит Лембергера", "Horwitz Defense": "Защита Горвица",
    "Rat Defense": "Защита «Крыса»", "Borg Defense": "Защита Борга", "Carr Defense": "Защита Карра", "Duras Gambit": "Гамбит Дураса",
    "Goldsmith Defense": "Защита Голдсмита", "Mikenas Defense": "Защита Микенаса", "Czech Defense": "Чешская защита", "Robatsch Defense": "Защита Робача",
    "Lion Defense": "Защита «Лев»", "Kangaroo Defense": "Защита «Кенгуру»", "Queen's Gambit Refused": "Ферзевый гамбит", "Wade Defense": "Защита Уэйда",
    "Ponziani": "Дебют Понциани", "Gunderam Defense": "Защита Гундерама", "Greek Gambit": "Греческий гамбит", "Hippopotamus Defense": "Защита «Бегемот»",
    "Valencia Opening": "Валенсийское начало", "Tarrasch Defence": "Защита Тарраша", "Australian Defense": "Австралийская защита"
  };
  const SYSTEMS = ["London System", "Colle System", "Stonewall Attack", "Torre Attack", "Rapport-Jobava System"];
  const UMBRELLA = new Set(["Queen's Pawn Game", "King's Pawn Game", "Indian Defense", "Zukertort Opening"]);

  let DATA = null, TRIE = null;
  const VER = ((document.currentScript && document.currentScript.src || "").match(/[?&]v=(\w+)/) || [])[1] || "1";
  const san2 = s => s.split(" ").filter(Boolean);

  function courseKey(name) {
    for (const s of SYSTEMS) if (name.includes(s)) return s;
    const parts = name.split(":");
    let base = parts[0].split(",")[0].trim().replace(/ (Accepted|Declined)$/, "");
    if (UMBRELLA.has(base) && parts[1]) base += ": " + parts[1].split(",")[0].trim();
    return base;
  }
  const ruName = key => {
    const [a, b] = key.split(": ");
    return (RU[a] || a) + (b ? " · " + b : "");
  };

  async function load() {
    if (DATA) return DATA;
    const r = await fetch("openings.json?v=" + VER);
    if (!r.ok) throw new Error("openings.json " + r.status);
    const rows = await r.json();
    DATA = rows.map(([eco, name, book, ext], i) => ({ i, eco, name, book: san2(book), ext: san2(ext || ""), key: courseKey(name) }));
    TRIE = { k: new Map(), row: null };
    for (const row of DATA) {
      let n = TRIE;
      for (const s of row.book) { if (!n.k.has(s)) n.k.set(s, { k: new Map(), row: null }); n = n.k.get(s); }
      if (!n.row) n.row = row;
    }
    return DATA;
  }
  // deepest named line that a game follows
  function classify(moves) {
    let n = TRIE, row = null;
    for (const s of moves.slice(0, 30)) { n = n.k.get(s); if (!n) break; if (n.row) row = n.row; }
    return row;
  }

  /* games: [{s:"w"|"b", r:"win"|"loss"|"draw", m:[san…]}] → {w:[course…], b:[course…], n} */
  function forPlayer(games, perSide) {
    perSide = perSide || 2;
    const by = { w: {}, b: {} };
    for (const g of games) {
      const row = classify(g.m); if (!row) continue;
      const o = by[g.s][row.key] = by[g.s][row.key] || { key: row.key, side: g.s, games: [], win: 0, draw: 0, loss: 0 };
      o.games.push(g); o[g.r] = (o[g.r] || 0) + 1;
    }
    const out = { w: [], b: [] };
    for (const side of ["w", "b"]) {
      const list = Object.values(by[side]).sort((a, b) => b.games.length - a.games.length);
      for (const o of list) {
        if (out[side].length >= perSide) break;
        const c = build(o.key, side, o.games);
        if (c && c.sections.length >= 3) { Object.assign(c, { n: o.games.length, win: o.win, draw: o.draw, loss: o.loss }); out[side].push(c); }
      }
    }
    return out;
  }

  // the course for one opening key from one side; `games` give the player's habits
  function build(key, side, games) {
    const rows = DATA.filter(r => r.key === key);
    if (!rows.length) return null;
    const root = { k: new Map(), rows: [], size: 0 };
    for (const r of rows) {
      let n = root; n.size++;
      for (const s of r.book) { if (!n.k.has(s)) n.k.set(s, { k: new Map(), rows: [], size: 0 }); n = n.k.get(s); n.size++; }
      n.rows.push(r);
    }
    const mine = ply => (ply % 2 === 0) === (side === "w");
    // player's own move counts at each position: "e4 e5" → {Nf3: 7}
    const habit = {};
    for (const g of games || []) for (let i = 0; i < Math.min(24, g.m.length); i++) if (mine(i)) {
      const p = g.m.slice(0, i).join(" "); (habit[p] = habit[p] || {})[g.m[i]] = (habit[p][g.m[i]] || 0) + 1;
    }
    const reach = path => (games || []).filter(g => { for (let i = 0; i < path.length; i++) if (g.m[i] !== path[i]) return false; return true; }).length;
    const leaves = [];
    (function walk(n, path, prob) {
      const kids = [...n.k.entries()];
      if (!kids.length) { leaves.push({ path, row: n.rows[0], prob }); return; }
      // a named position where the opponent is to move is a section of its own when the engine's
      // reply is not already covered by a deeper named line
      if (n.rows.length && path.length && !mine(path.length) && n.rows[0].ext.length && !n.k.has(n.rows[0].ext[0]))
        leaves.push({ path, row: n.rows[0], prob: prob * 0.5 });
      if (mine(path.length)) {
        const h = habit[path.join(" ")] || {};
        kids.sort((a, b) => (h[b[0]] || 0) - (h[a[0]] || 0) || b[1].size - a[1].size);
        n.pick = kids[0][0];
        walk(kids[0][1], path.concat(kids[0][0]), prob);
      } else for (const [s, c] of kids) walk(c, path.concat(s), prob * c.size / n.size);
    })(root, [], 1);
    for (const l of leaves) l.score = l.prob * (1 + reach(l.path.slice(0, Math.min(l.path.length, 8))));
    const keep = new Set(leaves.slice().sort((a, b) => b.score - a.score).slice(0, 24));
    const picked = leaves.filter(l => keep.has(l));
    // chapters from the names, in tree order
    const kp = key.split(": "), last = kp[kp.length - 1];
    const chapters = [], byCh = {};
    const sections = picked.map(l => {
      const parts = l.row.name.split(/[:,]/).map(x => x.trim());
      let j = parts.findIndex(p => p.replace(/ (Accepted|Declined)$/, "").includes(last.replace(/ (Accepted|Declined)$/, "")));
      if (j < 0) j = 0;
      const ch = parts[j + 1] || "Основные линии", label = parts.slice(j + 2).join(", ");
      // full line: book moves + engine moves, ending on the player's move
      let san = l.path.concat(l.row.ext);
      const want = Math.min(san.length, Math.max(l.path.length + 4, 12), 20);
      san = san.slice(0, want);
      while (san.length > l.path.length && !mine(san.length - 1)) san.pop();
      const n = san.filter((_, i) => mine(i)).length;
      const k = l.path.length, from = Math.max(0, k - 2);
      const tail = l.path.slice(from).map((s, i) => { const ply = from + i; return (ply % 2 === 0 ? (ply / 2 + 1) + "." : i === 0 ? (ply + 1) / 2 + "..." : "") + s; }).join(" ");
      const sec = { id: "c|" + side + "|" + l.path.join(" "), side, san, book: l.path.length, n, eco: l.row.eco, name: l.row.name, chapter: ch, title: label || tail, moves: tail };
      if (!byCh[ch]) { byCh[ch] = { title: ch, sections: [] }; chapters.push(byCh[ch]); }
      byCh[ch].sections.push(sec);
      return sec;
    });
    // the player's own games: opponent replies that leave the theory above become sections too
    const dev = {};
    for (const g of games || []) {
      let n = root;
      for (let i = 0; i < Math.min(16, g.m.length); i++) {
        const mv = g.m[i];
        if (mine(i)) { if (n.pick === mv) n = n.k.get(mv); else break; }
        else if (n.k.has(mv)) n = n.k.get(mv);
        else { if (n.k.size || i < 2) { const p = g.m.slice(0, i + 1).join(" "); dev[p] = dev[p] || { path: g.m.slice(0, i + 1), cnt: 0, eco: (n.rows[0] || {}).eco }; dev[p].cnt++; } break; }
      }
    }
    const minCnt = (games || []).length >= 10 ? 2 : 1;
    const devs = Object.values(dev).filter(d => d.cnt >= minCnt).sort((a, b) => b.cnt - a.cnt).slice(0, 10);
    if (devs.length) {
      const ch = { title: "Как тебе отвечали в партиях", sections: [] };
      chapters.unshift(ch);
      for (const d of devs) {
        const k = d.path.length, ply = k - 1, mv = (ply % 2 === 0 ? (ply / 2 + 1) + "." : (ply + 1) / 2 + "...") + d.path[ply];
        const id = "c|" + side + "|" + d.path.join(" ");
        const ext = extCache()[id];
        let san = ext ? d.path.concat(ext) : d.path.slice();
        // planned length (8 more plies, ending on the player's move) so the points are known before the engine runs
        let L = ext ? san.length : k + 8; while (L > k && !mine(L - 1)) L--;
        const n = Array.from({ length: L }, (_, i) => i).filter(mine).length;
        ch.sections.push({ id, side, san, book: k, dev: ply, cnt: d.cnt, need: !ext, plan: L, n, eco: d.eco || "A00",
          name: `Из твоих партий: ${mv}`, chapter: ch.title, title: `${mv} — ${d.cnt} ${d.cnt % 10 === 1 && d.cnt % 100 !== 11 ? "раз" : (d.cnt % 10 >= 2 && d.cnt % 10 <= 4 && (d.cnt % 100 < 10 || d.cnt % 100 >= 20)) ? "раза" : "раз"} в твоих партиях`, moves: d.path.map((s, i) => (i % 2 === 0 ? (i / 2 + 1) + "." : "") + s).join(" ") });
      }
    }
    const ecos = {}; picked.forEach(l => { ecos[l.row.eco] = (ecos[l.row.eco] || 0) + 1; });
    const eco = Object.entries(ecos).sort((a, b) => b[1] - a[1])[0][0];
    // number sections chapter by chapter (1.1, 1.2, 2.1 …)
    const ordered = [];
    chapters.forEach((c, ci) => c.sections.forEach((s, si) => { s.num = `${ci + 1}.${si + 1}`; ordered.push(s); }));
    return { id: side + "|" + key, key, side, ru: ruName(key), en: key, eco, chapters, sections: ordered, habit, points: ordered.reduce((a, s) => a + s.n, 0) };
  }

  /* ------------------------------------------------------------ engine continuation for game sections */
  const EXK = "revizor-ext";
  function extCache() { try { return JSON.parse(localStorage.getItem(EXK) || "{}") || {}; } catch (e) { return {}; } }
  let ENG = null;
  const engine = () => ENG || (ENG = new window.RevPlayer.Engine().init().catch(e => { ENG = null; throw e; }));
  const cp = ln => !ln ? -1e5 : ln.t === "mate" ? (ln.v > 0 ? 1e5 - ln.v : -1e5 - ln.v) : ln.v;
  // continues sec.san to sec.plan plies: engine's best moves, but the player's habitual move where it is
  // no worse than 0.6 pawns below the best one
  async function extend(sec, habit) {
    if (!sec.need) return sec;
    const eng = await engine(), C = window.Chess, c = new C();
    for (const s of sec.san) c.move(s);
    const out = [], mine = ply => (ply % 2 === 0) === (sec.side === "w");
    for (let ply = sec.san.length; ply < sec.plan && !c.game_over(); ply++) {
      const fen = c.fen(), L = await eng.go(fen, "go depth 12");
      if (!L[1]) break;
      let mv = L[1].pv[0];
      if (mine(ply)) {
        const h = habit[sec.san.concat(out).join(" ")] || {}, top = Object.entries(h).sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= 2) {
          const hm = new C(fen).move(top[0]);
          if (hm) { const u = hm.from + hm.to + (hm.promotion || ""); if (u !== mv) { const H = await eng.go(fen, "go depth 12 searchmoves " + u); if (cp(H[1]) >= cp(L[1]) - 60) mv = u; } }
        }
      }
      const m = c.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] });
      if (!m) break; out.push(m.san);
    }
    while (out.length && !mine(sec.san.length + out.length - 1)) out.pop();
    sec.san = sec.san.concat(out); sec.need = false;
    sec.n = sec.san.filter((_, i) => mine(i)).length;
    const X = extCache(); X[sec.id] = out;
    try { localStorage.setItem(EXK, JSON.stringify(X)); } catch (e) {}
    return sec;
  }

  /* ------------------------------------------------------------ player games (cached) */
  const LSK = n => "revizor-op:" + String(n).trim().toLowerCase();
  function cached(nick) { try { return JSON.parse(localStorage.getItem(LSK(nick)) || "null"); } catch (e) { return null; } }
  async function playerGames(nick, force) {
    const c = cached(nick);
    if (c && !force && Date.now() - c.t < 3 * 3600e3) return c.games;
    const RP = window.RevPlayer, core = window.RevCore, me = String(nick).trim().toLowerCase();
    let games = [];
    try {
      const list = await RP.fetchList(nick, 150);
      for (const g of list.slice(0, 150)) {
        const P = core.parse(g.pgn); if (!P) continue;
        const s = (P.hdr.White || "").toLowerCase() === me ? "w" : (P.hdr.Black || "").toLowerCase() === me ? "b" : null; if (!s) continue;
        const res = P.hdr.Result, r = res === "1/2-1/2" ? "draw" : (res === "1-0") === (s === "w") ? "win" : "loss";
        games.push({ s, r, m: P.hist.slice(0, 24).map(x => x.san) });
      }
    } catch (e) {
      // offline / chess.com unreachable: fall back to games analysed earlier in this browser
      games = RP.games(nick).map(g => ({ s: g.me, r: g.result, m: (g.moves || g.opening || []).slice(0, 24) }));
      if (!games.length && c) return c.games;
      if (!games.length) throw e;
    }
    try { localStorage.setItem(LSK(nick), JSON.stringify({ t: Date.now(), games })); } catch (e) {}
    return games;
  }

  window.RevOpenings = { extend, load, classify, forPlayer, build, courseKey, ruName, playerGames, cached };
})();
