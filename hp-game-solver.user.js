// ==UserScript==
// @name         HP Game Solver
// @namespace    hp-game-solver
// @version      1.0.0
// @description  Hub minimal pour Android : un bouton "résoudre" par jeu (Voisins, Coffre, Connexions, Cartodle, Voltorb Flip). Pas de log, pas d'auto : un bouton, ça résout (relance la partie si elle est finie).
// @include      /^https:\/\/holo[p]ocket\.fr\/.*/
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      pokeapi.co
// @connect      api.tcgdex.net
// @connect      voltorbflip.com
// ==/UserScript==

(function () {
  'use strict';

  if (document.getElementById('hps-hub')) return;

  // ----------------------------------------------------------- shared
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // JSON helper bound to one game API (same origin, session cookies).
  function mkApi(base) {
    return async function (path, body) {
      const opts = body === undefined
        ? { credentials: 'same-origin' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      const r = await fetch(base + path, opts);
      if (!r.ok) {
        let t = '';
        try { t = await r.text(); } catch (e) { /* ignore */ }
        throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 80));
      }
      return r.json();
    };
  }


  // ================================================================= Voisins
  const voisins = (() => {
    const api = mkApi('/api/games/neighbors');

  // Two Pokemon are neighbours if they share a type OR the same generation.
  function areNeighbors(a, b) {
    return a.gen === b.gen || a.types.some((t) => b.types.includes(t));
  }

  // Finds a size x size layout where every horizontally/vertically adjacent pair is valid.
  // `slots` = dex numbers already placed (null = empty); they are kept in place.
  // Returns the cards in row-major order, or null.
  function solve(cards, size, slots) {
    const n = size * size;
    if (cards.length !== n) return null;
    const byDex = new Map(cards.map((c, i) => [c.dex, i]));
    const grid = new Array(n).fill(-1);
    const used = new Array(n).fill(false);

    for (let p = 0; p < n; p++) {
      const d = slots && slots[p];
      if (d != null) {
        const i = byDex.get(d);
        if (i === undefined || used[i]) return null;
        grid[p] = i;
        used[i] = true;
      }
    }
    const fixed = grid.map((v) => v >= 0);

    function ok(p, i) {
      const x = p % size, y = Math.floor(p / size);
      const around = [];
      if (x > 0) around.push(p - 1);
      if (x < size - 1) around.push(p + 1);
      if (y > 0) around.push(p - size);
      if (y < size - 1) around.push(p + size);
      return around.every((q) => grid[q] < 0 || areNeighbors(cards[grid[q]], cards[i]));
    }

    for (let p = 0; p < n; p++) if (fixed[p] && !ok(p, grid[p])) return null;
    const free = [];
    for (let p = 0; p < n; p++) if (!fixed[p]) free.push(p);

    function bt(k) {
      if (k === free.length) return true;
      const p = free[k];
      for (let i = 0; i < n; i++) {
        if (used[i] || !ok(p, i)) continue;
        used[i] = true;
        grid[p] = i;
        if (bt(k + 1)) return true;
        used[i] = false;
        grid[p] = -1;
      }
      return false;
    }
    return bt(0) ? grid.map((i) => cards[i]) : null;
  }
  
    async function run(say) {
      let st = await api('');
      if (st.over) st = await api('/rejouer', {});
      const size = st.size || 3;
      const solution = solve(st.cards, size, st.slots);
      if (!solution) throw new Error('aucune grille valide');
      const slots = st.slots.slice();
      for (let p = 0; p < solution.length; p++) {
        if (slots[p] != null) continue;
        slots[p] = solution[p].dex;
        st = await api('/place', { slots: slots.slice() });
        say('Voisins ' + (p + 1) + '/' + solution.length);
        await wait(500);
      }
      return { played: true, text: st.solved ? 'Gagné · +' + st.coins + ' pièces · +' + st.energy + ' énergie' : 'Terminé, mais non résolu' };
    }
    return { run };
  })();

  // ================================================================== Coffre
  const coffre = (() => {
    const api = mkApi('/api/games/vault');

  // Mastermind: `nColors` types, `nSlots` positions, repeats allowed. Codes/guesses are arrays of color indexes.
  const cntCode = new Int8Array(16);
  const cntGuess = new Int8Array(16);

  // Feedback key = exact * 10 + misplaced (same scoring as the site: right type + place / right type, wrong place).
  function feedback(code, guess, nColors) {
    cntCode.fill(0, 0, nColors);
    cntGuess.fill(0, 0, nColors);
    let exact = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === guess[i]) exact++;
      else { cntCode[code[i]]++; cntGuess[guess[i]]++; }
    }
    let mis = 0;
    for (let c = 0; c < nColors; c++) mis += Math.min(cntCode[c], cntGuess[c]);
    return exact * 10 + mis;
  }

  function allCodes(nColors, nSlots) {
    const out = [];
    const cur = new Array(nSlots).fill(0);
    (function rec(i) {
      if (i === nSlots) { out.push(cur.slice()); return; }
      for (let c = 0; c < nColors; c++) { cur[i] = c; rec(i + 1); }
    })(0);
    return out;
  }

  // history = [{ guess: [idx...], exact, misplaced }]. Returns the next guess (indexes) or null if inconsistent.
  // Strategy: among all possible guesses, take the one whose feedback splits the remaining candidates best
  // (max entropy); on ties prefer a guess that can itself be the code.
  function nextGuess(history, nColors, nSlots) {
    const all = allCodes(nColors, nSlots);
    const cand = all.filter((c) =>
      history.every((h) => feedback(c, h.guess, nColors) === h.exact * 10 + h.misplaced)
    );
    if (!cand.length) return null;
    if (history.length === 0 && nColors >= 2 && nSlots >= 4) {
      const first = new Array(nSlots).fill(0);
      for (let i = Math.floor(nSlots / 2); i < nSlots; i++) first[i] = 1;   // e.g. A A B B
      return first;
    }
    if (cand.length <= 2) return cand[0];

    const candKeys = new Set(cand.map((c) => c.join(',')));
    let best = null, bestH = -1, bestInCand = false;
    for (const g of all) {
      const counts = new Map();
      for (const c of cand) {
        const k = feedback(c, g, nColors);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let H = 0;
      for (const n of counts.values()) { const p = n / cand.length; H -= p * Math.log(p); }
      const inCand = candKeys.has(g.join(','));
      if (H > bestH + 1e-9 || (Math.abs(H - bestH) <= 1e-9 && inCand && !bestInCand)) {
        best = g; bestH = H; bestInCand = inCand;
      }
    }
    return best;
  }
  
    async function run(say) {
      let st = await api('');
      if (st.over) st = await api('/rejouer', {});
      const names = st.energies;
      const nColors = names.length, nSlots = st.slots;
      const idx = new Map(names.map((n, i) => [n, i]));
      const history = (st.guesses || []).map((g) => ({ guess: g.guess.map((n) => idx.get(n)), exact: g.exact, misplaced: g.misplaced }));
      let played = false;
      while (!st.over && history.length < st.maxTries) {
        say('Coffre · essai ' + (history.length + 1) + '/' + st.maxTries);
        await wait(30);
        const g = nextGuess(history, nColors, nSlots);
        if (!g) throw new Error('aucun code possible');
        st = await api('/guess', { guess: g.map((i) => names[i]) });
        played = true;
        const last = st.guesses[st.guesses.length - 1];
        history.push({ guess: g, exact: last.exact, misplaced: last.misplaced });
        await wait(500);
      }
      return { played, text: st.won ? 'Gagné en ' + st.guesses.length + ' essais · +' + st.coins + ' pièces · +' + st.energy + ' énergie' : 'Terminé sans victoire' };
    }
    return { run };
  })();

  // =============================================================== Connexions
  const connexions = (() => {
    const CONFIG = { pokeApi: 'https://pokeapi.co/api/v2', maxScriptMistakes: 3 };
    const api = mkApi('/api/games/connect');

  const FREE_W = 0.15;                // weight of a group we cannot explain (e.g. the "rarer" kinds: card kind, HP...)
  const POP = new Uint8Array(65536);
  for (let i = 1; i < 65536; i++) POP[i] = POP[i >> 1] + (i & 1);

  const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Properties of one tile (a = { name, types?, gen?, stage?, family? }).
  // Returns [key, label, weight] triples; tiles sharing a key can form a group.
  function propsOf(a) {
    const out = [];
    if (a.types && a.types.length) {
      out.push(['tp:' + a.types[0], 'Type ' + a.types[0], 1.0]);                 // usual (primary) type
      a.types.forEach((t) => out.push(['ta:' + t, 'Type ' + t + ' (any)', 0.7]));
    }
    if (a.gen) out.push(['g:' + a.gen, 'Génération ' + a.gen, 1.0]);
    if (a.stage) out.push(['s:' + a.stage, 'Place : ' + a.stage, 0.9]);
    if (a.family) out.push(['f:' + a.family, 'Même famille', 1.3]);
    const clean = norm(a.name);
    out.push(['l:' + clean[0].toUpperCase(), 'Initiale ' + clean[0].toUpperCase(), 1.0]);
    const len = clean.replace(/[-\s.']/g, '').length;
    if (len <= 5) out.push(['n:short', 'Nom court (≤5)', 0.9]);
    if (len >= 10) out.push(['n:long', 'Nom long (≥10)', 0.9]);
    return out;
  }

  // All candidate groups: every 4-subset of tiles that share a property. Returns [{ mask, w, label }].
  function buildGroups(attrs) {
    const byKey = new Map();
    attrs.forEach((a, i) => {
      for (const [key, label, w] of propsOf(a)) {
        let e = byKey.get(key);
        if (!e) { e = { label, w, idx: [] }; byKey.set(key, e); }
        e.idx.push(i);
      }
    });
    const groups = new Map();
    for (const e of byKey.values()) {
      const n = e.idx.length;
      if (n < 4) continue;
      // A grid has a single solution, so a property shared by exactly 4 tiles is much more likely to be a real
      // group than one shared by 8 tiles: weight / (number of 4-subsets of that property).
      const w = e.w / ((n * (n - 1) * (n - 2) * (n - 3)) / 24);
      for (let a = 0; a < n - 3; a++) for (let b = a + 1; b < n - 2; b++)
        for (let c = b + 1; c < n - 1; c++) for (let d = c + 1; d < n; d++) {
          const mask = (1 << e.idx[a]) | (1 << e.idx[b]) | (1 << e.idx[c]) | (1 << e.idx[d]);
          const cur = groups.get(mask);
          if (!cur || w > cur.w) groups.set(mask, { mask, w, label: e.label });
        }
    }
    return Array.from(groups.values());
  }

  // Splits the tiles of `mask` into `k` groups of 4 in every possible way.
  function splitFree(mask, k) {
    if (k === 0) return [[]];
    const bits = [];
    for (let i = 0; i < 16; i++) if (mask & (1 << i)) bits.push(i);
    const low = bits[0], rest = bits.slice(1), res = [];
    for (let a = 0; a < rest.length - 2; a++) for (let b = a + 1; b < rest.length - 1; b++)
      for (let c = b + 1; c < rest.length; c++) {
        const g = (1 << low) | (1 << rest[a]) | (1 << rest[b]) | (1 << rest[c]);
        for (const tail of splitFree(mask & ~g, k - 1)) res.push([g, ...tail]);
      }
    return res;
  }

  // Every way to cover the remaining tiles (universe) with nGroups groups of 4: (nGroups - free) explained groups
  // + `free` unexplained ones. Tries free = 1, then 2 if nothing fits. Returns [{ masks, w }].
  function enumeratePartitions(groups, universe, nGroups, cap) {
    const byMask = new Map(groups.map((g) => [g.mask, g]));
    for (let free = 1; free <= Math.min(2, nGroups); free++) {
      const need = nGroups - free;
      const res = new Map();
      let overflow = false;
      const dfs = (start, used, chosen, w) => {
        if (overflow) return;
        if (chosen.length === need) {
          const left = universe & ~used;
          const splits = free === 1 ? [[left]] : splitFree(left, free);
          for (const parts of splits) {
            let pw = w;
            for (const m of parts) { const g = byMask.get(m); pw *= g ? g.w : FREE_W; }
            const masks = [...chosen, ...parts].sort((x, y) => x - y);
            const key = masks.join(',');
            if (!res.has(key)) { res.set(key, { masks, w: pw }); if (res.size > cap) { overflow = true; return; } }
          }
          return;
        }
        for (let i = start; i < groups.length; i++) {
          const g = groups[i];
          if (g.mask & used) continue;
          chosen.push(g.mask);
          dfs(i + 1, used | g.mask, chosen, w * g.w);
          chosen.pop();
        }
      };
      dfs(0, 0, [], 1);
      if (res.size) return Array.from(res.values());
    }
    return [];
  }

  // Keeps the partitions that agree with the site's answer to a guess (mask).
  // outcome: "correct" | "close" (3 of the 4 go together) | anything else = wrong.
  function applyOutcome(parts, mask, outcome) {
    if (outcome === 'correct') return parts.filter((p) => p.masks.includes(mask));
    if (outcome === 'close') return parts.filter((p) => p.masks.some((m) => POP[m & mask] === 3));
    return parts.filter((p) => p.masks.every((m) => POP[m & mask] <= 2));
  }

  // Most probable group not yet found: the mask that appears in the largest share of (weighted) partitions.
  function bestGuess(parts, foundMasks) {
    const score = new Map();
    let total = 0;
    for (const p of parts) {
      total += p.w;
      for (const m of p.masks) if (!foundMasks.has(m)) score.set(m, (score.get(m) || 0) + p.w);
    }
    let best = null, bs = -1;
    for (const [m, s] of score) if (s > bs) { best = m; bs = s; }
    return best === null ? null : { mask: best, prob: bs / total };
  }
  

  // --------------------------------------------------- Pokemon data (PokeAPI)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gm(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 25000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          } else reject(new Error('HTTP ' + r.status + ' ' + url));
        },
        onerror: () => reject(new Error('network ' + url)),
        ontimeout: () => reject(new Error('timeout ' + url)),
      });
    });
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    }));
    return out;
  }

  const cacheGet = (k) => { try { const v = localStorage.getItem('hpn1:' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  const cacheSet = (k, v) => { try { localStorage.setItem('hpn1:' + k, JSON.stringify(v)); } catch (e) { /* quota: ignore */ } };
  const idOf = (url) => parseInt((url.match(/\/(\d+)\/?$/) || [])[1], 10);

  // Table dex -> { types, gen } built from the 18 type lists and the 9 generation lists (cached once).
  async function loadTables() {
    const cached = cacheGet('tables');
    if (cached) return cached;
    const table = {};
    const types = await gm(CONFIG.pokeApi + '/type?limit=30');
    const names = types.results.map((t) => t.name).filter((n) => n !== 'unknown' && n !== 'shadow' && n !== 'stellar');
    await mapLimit(names, 6, async (name) => {
      const t = await gm(CONFIG.pokeApi + '/type/' + name);
      for (const e of t.pokemon) {
        const id = idOf(e.pokemon.url);
        if (!(id >= 1 && id <= 1100)) continue;                // base species only (forms have ids > 10000)
        (table[id] = table[id] || { types: [] }).types[e.slot - 1] = name;
      }
    });
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 5, async (n) => {
      const g = await gm(CONFIG.pokeApi + '/generation/' + n);
      for (const s of g.pokemon_species) {
        const id = idOf(s.url);
        (table[id] = table[id] || { types: [] }).gen = n;
      }
    });
    for (const id of Object.keys(table)) table[id].types = (table[id].types || []).filter(Boolean);
    cacheSet('tables', table);
    return table;
  }

  // Evolution family id + place in the family (first / middle / last / single) for one dex number.
  async function loadEvo(dex, chains) {
    const cached = cacheGet('evo:' + dex);
    if (cached) return cached;
    const sp = await gm(CONFIG.pokeApi + '/pokemon-species/' + dex);
    const url = sp.evolution_chain.url;
    if (!chains.has(url)) chains.set(url, gm(url));
    const chain = await chains.get(url);
    const nodes = new Map();
    (function walk(n, hasPre) {
      nodes.set(n.species.name, { hasPre, hasNext: n.evolves_to.length > 0 });
      n.evolves_to.forEach((c) => walk(c, true));
    })(chain.chain, false);
    const me = nodes.get(sp.name) || { hasPre: false, hasNext: false };
    let stage;
    if (nodes.size === 1) stage = 'single';
    else if (!me.hasPre) stage = 'first';
    else if (me.hasNext) stage = 'middle';
    else stage = 'last';
    const out = { family: chain.id, stage };
    cacheSet('evo:' + dex, out);
    return out;
  }

  async function loadAttrs(tiles) {
    const chains = new Map();
    let tables = null;
    try { tables = await loadTables(); } catch (e) { /* types/gens unknown: only name-based groups */ }
    return mapLimit(tiles, 6, async (t) => {
      const a = { name: t.name, dex: t.dex };
      const row = tables && tables[t.dex];
      if (row) { a.types = row.types; a.gen = row.gen; }
      try { Object.assign(a, await loadEvo(t.dex, chains)); } catch (e) { /* stage/family unknown */ }
      return a;
    });
  }


    async function run(say) {
      let st = await api('');
      if (st.over) st = await api('/rejouer', {});
      say('Connexions · données Pokémon...');
      const tiles = st.tiles.slice();
      const attrs = await loadAttrs(tiles);
      const nGroups = tiles.length / 4;
      const groups = buildGroups(attrs);
      const universe = tiles.reduce((m, _, i) => m | (1 << i), 0);
      let parts = enumeratePartitions(groups, universe, nGroups, 400000);
      if (!parts.length) throw new Error('aucune combinaison plausible');
      const foundMasks = new Set();
      let played = false, stopped = '';
      while (!st.over && st.mistakes < CONFIG.maxScriptMistakes) {
        const pick = bestGuess(parts, foundMasks);
        if (!pick) { stopped = 'plus d\'hypothèse'; break; }
        const dex = tiles.filter((_, i) => pick.mask & (1 << i)).map((t) => t.dex);
        say('Connexions · groupe ' + (foundMasks.size + 1) + ' (confiance ~' + Math.round(pick.prob * 100) + '%)');
        st = await api('/guess', { dex });
        played = true;
        parts = applyOutcome(parts, pick.mask, st.outcome);
        if (st.outcome === 'correct') foundMasks.add(pick.mask);
        if (!parts.length) { stopped = 'hypothèses incompatibles'; break; }
        await wait(800);
      }
      if (st.won) return { played, text: 'Gagné · +' + st.coins + ' pièces · +' + st.energy + ' énergie' };
      if (st.over) return { played, text: 'Perdu : trop d\'erreurs' };
      return { played, text: 'Arrêt (' + (stopped || st.mistakes + ' erreurs') + ') : il reste des vies pour finir à la main' };
    }
    return { run };
  })();

  // ================================================================ Cartodle
  const cartodle = (() => {
    const CONFIG = {
      api: '/api/games/cartodle', gamesApi: '/api/games', tcg: 'https://api.tcgdex.net/v2/fr',
      maxDex: 1025, detailLimit: 300,
    };
    let progressCb = () => {};
    const setProgress = (m) => progressCb(m);
    const setButtons = () => {};
    const showStats = () => {};

  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  // TCGdex and the site may pad local ids differently ("xy10-063" / "xy10-63").
  const normId = (id) => String(id).toLowerCase().replace(/-0+(\d)/, '-$1');
  const STAGE_MAP = { basic: 'basic', 'de base': 'basic', stage1: 'stage1', 'niveau 1': 'stage1', stage2: 'stage2', 'niveau 2': 'stage2' };
  const stageKey = (s) => { const n = norm(s); return STAGE_MAP[n] || n; };
  const TYPE_MAP = {
    plante: 'grass', feu: 'fire', eau: 'water', electrique: 'lightning', psy: 'psychic', combat: 'fighting',
    obscurite: 'darkness', metal: 'metal', fee: 'fairy', dragon: 'dragon', incolore: 'colorless',
  };
  const typeKey = (s) => { const n = norm(s); return TYPE_MAP[n] || n; };

  // Series of a set, from its id: bw7 -> bw, xy8 -> xy, xyp (Promo XY) -> xy, ex10 -> ex...
  const SERIES_KNOWN = new Set(['bw', 'xy', 'sm', 'swsh', 'sv', 'dp', 'hgss', 'pl', 'ex', 'base', 'neo', 'ecard', 'pop', 'col', 'me', 'np', 'si']);
  function seriesOf(setId) {
    const m = String(setId || '').toLowerCase().match(/^[a-z]+/);
    if (!m) return null;
    let p = m[0];
    if (p.length > 2 && p.endsWith('p') && SERIES_KNOWN.has(p.slice(0, -1))) p = p.slice(0, -1);
    return p;
  }

  // What the game told us about a guessed card (F = one entry of state.guesses, dbCard = our copy if any).
  function guessInfo(F, dbCard) {
    return {
      id: F.card.id,
      dex: F.pokemon.dex,
      type: dbCard && dbCard.type ? typeKey(dbCard.type) : typeKey(F.types.label),
      stage: dbCard && dbCard.stage ? stageKey(dbCard.stage) : stageKey(F.stage.label),
      rank: F.card.rank,
      rarity: F.rarity.label,
      setName: F.set.label,
      se: seriesOf(F.card.setId),
      year: F.set.year,
      hp: F.hp.value,
      ill: norm(F.illustrator.label),
    };
  }

  // Meaning of the orange "close" hint (confirmed): same series of sets / one type in common /
  // HP within 20 / same rarity level (same rank, other rarity). Arrows point toward the secret card's value.
  // Why can candidate C NOT be the secret card, given the feedback F for guess G? null = it still can.
  // lvl 0 = every rule, 1 = equal/different rules only (no arrows, no HP/illustrator/series), 2 = Pokedex + stage only.
  function failReason(C, F, G, lvl) {
    const d = C.d;
    if (d && d.length) {
      const hit = d.includes(G.dex);
      if (F.pokemon.hint === 'match' && !hit) return 'dex:match';
      if (F.pokemon.hint === 'miss' && hit) return 'dex:miss';
      if (F.pokemon.arrow === 'up' && !d.some((x) => x > G.dex)) return 'dex:up';
      if (F.pokemon.arrow === 'down' && !d.some((x) => x < G.dex)) return 'dex:down';
    }
    if (C.st && G.stage) {
      if (F.stage.hint === 'match' && C.st !== G.stage) return 'stage:match';
      if (F.stage.hint === 'miss' && C.st === G.stage) return 'stage:miss';
    }
    if (lvl >= 2) return null;
    if (C.t && G.type) {
      if (F.types.hint === 'match' && C.t !== G.type) return 'type:match';
      if (F.types.hint === 'miss' && C.t === G.type) return 'type:miss';   // "close" (a type in common) is not used: cards have one type here
    }
    if (F.rarity.hint === 'match' && C.rarity !== G.rarity) return 'rarity:match';
    if (F.rarity.hint === 'miss' && C.rarity === G.rarity) return 'rarity:miss';
    if (F.set.hint === 'match' && C.setName !== G.setName) return 'set:match';
    if (F.set.hint === 'miss' && C.setName === G.setName) return 'set:miss';
    if (lvl >= 1) return null;

    // rarity: close = same rank but another rarity; miss = other rank; arrows by rank
    if (F.rarity.hint === 'close' && !(C.rank === G.rank && C.rarity !== G.rarity)) return 'rarity:close';
    if (F.rarity.hint === 'miss' && C.rank === G.rank) return 'rarity:miss(rank)';
    if (F.rarity.arrow === 'up' && !(C.rank > G.rank)) return 'rarity:up';
    if (F.rarity.arrow === 'down' && !(C.rank < G.rank)) return 'rarity:down';
    // set: close = same series but another set; miss = another series; arrows by year (same year is possible)
    if (C.se && G.se) {
      if (F.set.hint === 'close' && !(C.se === G.se && C.setName !== G.setName)) return 'set:close(series)';
      if (F.set.hint === 'miss' && C.se === G.se) return 'set:miss(series)';
    }
    if (F.set.arrow === 'up' && !(C.year >= G.year)) return 'set:up';
    if (F.set.arrow === 'down' && !(C.year <= G.year)) return 'set:down';
    // HP: close = within 20 (not equal); miss = more than 20 away
    if (C.hp != null && G.hp != null) {
      const dl = Math.abs(C.hp - G.hp);
      if (F.hp.hint === 'match' && dl !== 0) return 'hp:match';
      if (F.hp.hint === 'close' && !(dl > 0 && dl <= 20)) return 'hp:close';
      if (F.hp.hint === 'miss' && dl <= 20) return 'hp:miss';
      if (F.hp.arrow === 'up' && !(C.hp > G.hp)) return 'hp:up';
      if (F.hp.arrow === 'down' && !(C.hp < G.hp)) return 'hp:down';
    }
    if (C.ill && G.ill) {
      if (F.illustrator.hint === 'match' && C.ill !== G.ill) return 'ill:match';
      if (F.illustrator.hint === 'miss' && C.ill === G.ill) return 'ill:miss';
    }
    return null;
  }
  const passes = (C, F, G, lvl) => failReason(C, F, G, lvl) === null;

  function filterCandidates(all, fbs, lvl) {
    return all.filter((C) => fbs.every((x) => passes(C, x.F, x.G, lvl)));
  }

  // Feedback class of guess g against candidate c (as the game would colour it), as a small integer.
  function sigCode(g, c) {
    const gd = g.d && g.d[0], cd = c.d && c.d[0];
    let k = (gd == null || cd == null) ? 3 : gd === cd ? 0 : cd > gd ? 1 : 2;
    k = k * 3 + ((g.t && c.t) ? (g.t === c.t ? 0 : 1) : 2);
    k = k * 3 + ((g.st && c.st) ? (g.st === c.st ? 0 : 1) : 2);
    k = k * 4 + (g.rarity === c.rarity ? 0 : g.rank === c.rank ? 1 : c.rank > g.rank ? 2 : 3);
    k = k * 5 + (g.setName === c.setName ? 0 : (g.se && g.se === c.se) ? 1 : c.year > g.year ? 2 : c.year < g.year ? 3 : 4);
    if (g.hp != null && c.hp != null) {
      const dl = Math.abs(c.hp - g.hp);
      k = k * 6 + (dl === 0 ? 0 : dl <= 20 ? (c.hp > g.hp ? 1 : 2) : (c.hp > g.hp ? 3 : 4));
    } else k = k * 6 + 5;
    k = k * 3 + ((g.ill && c.ill) ? (g.ill === c.ill ? 0 : 1) : 2);
    return k;
  }

  function sample(arr, n) {
    if (arr.length <= n) return arr.slice();
    const a = arr.slice();
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (a.length - i));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a.slice(0, n);
  }

  // The guess whose possible feedbacks split the remaining candidates best (max entropy).
  function pickGuess(cands, guessedIds) {
    const pool = cands.filter((c) => !guessedIds.has(c.id));
    if (pool.length <= 2) return pool[0] || cands[0];
    const guesses = sample(pool, 250);
    const targets = sample(cands, 1200);
    let best = null, bestH = -1;
    for (const g of guesses) {
      const counts = new Map();
      for (const c of targets) {
        const k = sigCode(g, c);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let H = 0;
      for (const n of counts.values()) { const p = n / targets.length; H -= p * Math.log(p); }
      if (H > bestH) { bestH = H; best = g; }
    }
    return best;
  }

  // The feedback my rules predict for guess G against the real answer C (null = cannot be predicted).
  // arrow: undefined = unknown (e.g. same year), null = no arrow expected.
  function expectedFeedback(G, C) {
    const e = {};
    const cd = C.d && C.d.length ? C.d[0] : null;
    if (cd != null) {
      const hit = C.d.includes(G.dex);
      e.pokemon = { hint: hit ? 'match' : 'miss', arrow: hit ? null : (cd > G.dex ? 'up' : 'down') };
    }
    if (C.t && G.type) e.types = { hint: C.t === G.type ? 'match' : 'miss' };
    if (C.st && G.stage) e.stage = { hint: C.st === G.stage ? 'match' : 'miss' };
    if (C.hp != null && G.hp != null) {
      const dl = Math.abs(C.hp - G.hp);
      e.hp = { hint: dl === 0 ? 'match' : dl <= 20 ? 'close' : 'miss', arrow: dl === 0 ? null : (C.hp > G.hp ? 'up' : 'down') };
    }
    const sameRar = C.rarity === G.rarity, sameRank = C.rank === G.rank;
    e.rarity = { hint: sameRar ? 'match' : sameRank ? 'close' : 'miss', arrow: sameRar ? null : (sameRank ? undefined : (C.rank > G.rank ? 'up' : 'down')) };
    const sameSet = C.setName === G.setName;
    e.set = {
      hint: sameSet ? 'match' : (C.se && C.se === G.se) ? 'close' : 'miss',
      arrow: sameSet ? null : (C.year === G.year ? undefined : (C.year > G.year ? 'up' : 'down')),
    };
    if (C.ill && G.ill) e.illustrator = { hint: C.ill === G.ill ? 'match' : 'miss' };
    return e;
  }

  // Differences between predicted and received feedback, as readable strings.
  function diffFeedback(e, F, n) {
    const out = [];
    const cols = { pokemon: 'dex', types: 'type', stage: 'stade', hp: 'PV', rarity: 'rareté', set: 'extension', illustrator: 'illustrateur' };
    const fmt = (h, a) => h + (a === 'up' ? '↑' : a === 'down' ? '↓' : '');
    for (const col of Object.keys(cols)) {
      const exp = e[col], act = F[col];
      if (!exp || !act) continue;
      if (col === 'types' && act.hint === 'close') continue;                 // a type in common: not predictable
      const bad = exp.hint !== act.hint || (exp.arrow !== undefined && (act.arrow || null) !== exp.arrow);
      if (bad) out.push('#' + n + ' ' + cols[col] + ' : prévu ' + fmt(exp.hint, exp.arrow) + ' / reçu ' + fmt(act.hint, act.arrow));
    }
    return out;
  }

  // After a game: was the answer still a candidate at each step, which rule dropped it, and where does my
  // understanding of the hints differ from the game's? C = the answer's record (null if not in my database).
  function analyzeGame(all, C, fbs, trace) {
    const out = { answerInDb: !!C, steps: [], firstElimination: null, mismatches: [] };
    for (const t of trace) {
      const rows = fbs.slice(0, t.i);
      out.steps.push({
        n: t.i + 1, pick: t.pick, cands: t.cands, lvl: t.lvl,
        answerIn: C ? rows.every((x) => passes(C, x.F, x.G, t.lvl)) : false,
      });
    }
    if (C) {
      for (let j = 0; j < fbs.length; j++) {
        const why = failReason(C, fbs[j].F, fbs[j].G, 0);
        if (why && !out.firstElimination) out.firstElimination = { guess: j + 1, rule: why };
        out.mismatches.push(...diffFeedback(expectedFeedback(fbs[j].G, C), fbs[j].F, j + 1));
      }
    }
    return out;
  }
  
  // ------------------------------------------------- persistent database
  // IndexedDB: survives page reloads and browser restarts.
  //  cards   : site card records (id, name, set, year, rarity, rank, type, stage)
  //  dex     : TCGdex card list per Pokedex number
  //  details : TCGdex details per card (hp, illustrator)
  //  meta    : build progress
  //  games   : finished games (feedback + answer), kept for later calibration
  let dbp = null;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open('hp_cartodle', 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        d.createObjectStore('cards', { keyPath: 'id' });
        d.createObjectStore('dex', { keyPath: 'n' });
        d.createObjectStore('details', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'key' });
        d.createObjectStore('games', { keyPath: 'day' });
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      let out;
      try { out = fn(t.objectStore(store)); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const dbAll = (store) => tx(store, 'readonly', (s) => s.getAll());
  const dbPutMany = (store, arr) => tx(store, 'readwrite', (s) => { arr.forEach((o) => s.put(o)); });
  const dbClearAll = async () => { for (const s of ['cards', 'dex', 'details', 'meta', 'games']) await tx(s, 'readwrite', (o) => o.clear()); };

  // In-memory copy of the database.
  const mem = {
    loaded: false,
    cards: new Map(),          // id -> site record (+ derived fields t, st, d, hp, ill)
    dexRecords: new Map(),     // n -> [{id, name}]
    dexByNorm: new Map(),      // normId -> [dex numbers]
    details: new Map(),        // id -> { id, hp, ill }
    meta: { doneDex: [], doneTerms: [], built: 0 },
  };

  function prep(rec) {
    rec.t = typeKey(rec.type);
    rec.st = stageKey(rec.stage);
    rec.se = seriesOf(rec.setId);
    rec.d = mem.dexByNorm.get(normId(rec.id)) || null;
    const det = mem.details.get(rec.id);
    rec.hp = det ? det.hp : null;
    rec.ill = det && det.ill ? norm(det.ill) : null;
    return rec;
  }

  function addDex(n, cards) {
    mem.dexRecords.set(n, cards);
    for (const c of cards) {
      const k = normId(c.id);
      const arr = mem.dexByNorm.get(k) || [];
      if (!arr.includes(n)) arr.push(n);
      mem.dexByNorm.set(k, arr);
    }
  }

  async function ensureMem() {
    if (mem.loaded) return;
    const [cards, dex, details, meta] = await Promise.all([dbAll('cards'), dbAll('dex'), dbAll('details'), dbAll('meta')]);
    for (const d of dex) addDex(d.n, d.cards);
    for (const d of details) mem.details.set(d.id, d);
    for (const c of cards) mem.cards.set(c.id, c);
    const m = meta.find((x) => x.key === 'state');
    if (m) mem.meta = Object.assign(mem.meta, m.value);
    mem.loaded = true;
  }

  const saveMeta = () => dbPutMany('meta', [{ key: 'state', value: mem.meta }]);

  // --------------------------------------------------------- network helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gm(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 25000,
        onload: (r) => {
          if (r.status === 404) { resolve(null); return; }
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          } else reject(new Error('HTTP ' + r.status + ' ' + url));
        },
        onerror: () => reject(new Error('network ' + url)),
        ontimeout: () => reject(new Error('timeout ' + url)),
      });
    });
  }

  async function retry(fn, tries = 3) {
    let err;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) { err = e; await sleep(500 * (i + 1)); }
    }
    throw err;
  }

  async function mapLimit(items, limit, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; await fn(items[i], i); }
    }));
  }

  async function api(path, body) {
    const opts = body === undefined
      ? { credentials: 'same-origin' }
      : {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
    const r = await fetch(CONFIG.api + path, opts);
    if (!r.ok) {
      let t = '';
      try { t = await r.text(); } catch (e) { /* ignore */ }
      throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 100));
    }
    return r.json();
  }

  // ------------------------------------------------------- step 1: scraping
  let building = false;
  let stopBuild = false;

  async function buildDb() {
    if (building) return;
    building = true;
    stopBuild = false;
    setButtons();
    try {
      await ensureMem();

      // --- A) TCGdex: which cards exist for each Pokedex number (gives the Pokedex number of every card).
      const doneDex = new Set(mem.meta.doneDex);
      const todoDex = [];
      for (let n = 1; n <= CONFIG.maxDex; n++) if (!doneDex.has(n)) todoDex.push(n);
      let buf = [], k = 0;
      const flushDex = async () => { if (buf.length) { const b = buf; buf = []; await dbPutMany('dex', b); } };
      await mapLimit(todoDex, 6, async (n) => {
        if (stopBuild) return;
        try {
          const r = await retry(() => gm(CONFIG.tcg + '/dex-ids/' + n));
          const cards = ((r && r.cards) || []).map((c) => ({ id: c.id, name: c.name }));
          addDex(n, cards);
          buf.push({ n, cards });
          doneDex.add(n);
        } catch (e) { /* retried at the next build */ }
        if (++k % 25 === 0) { setProgress('Étape 1/2 · Pokédex ' + doneDex.size + '/' + CONFIG.maxDex); await flushDex(); }
      });
      await flushDex();
      mem.meta.doneDex = Array.from(doneDex);
      await saveMeta();
      if (stopBuild) { setProgress('Construction arrêtée.'); return; }

      // --- B) Site search: one query per Pokemon name (the search returns at most 200 cards per query).
      const terms = new Map();
      for (const cards of mem.dexRecords.values()) {
        if (!cards.length) continue;
        const names = Array.from(new Set(cards.map((c) => c.name)));
        const term = names.reduce((a, b) => (b.length < a.length ? b : a));
        const key = norm(term);
        const e = terms.get(key) || { term, names: new Set() };
        names.forEach((x) => e.names.add(x));
        terms.set(key, e);
      }
      const doneTerms = new Set(mem.meta.doneTerms);
      const todo = Array.from(terms.entries()).filter(([key]) => !doneTerms.has(key));
      let cbuf = [], j = 0;
      const flushCards = async () => { if (cbuf.length) { const b = cbuf; cbuf = []; await dbPutMany('cards', b); } };
      const search = async (q) => {
        const r = await fetch(CONFIG.api + '/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const list = await r.json();
        for (const c of list) {
          const rec = {
            id: c.id, name: c.name, setId: c.setId, setName: c.setName, localId: c.localId,
            rarity: c.rarity, rank: c.rank, tier: c.tier, type: c.type, stage: c.stage, year: c.year,
          };
          mem.cards.set(rec.id, prep(rec));
          cbuf.push(rec);
        }
        return list.length;
      };
      await mapLimit(todo, 3, async ([key, e]) => {
        if (stopBuild) return;
        try {
          const n = await retry(() => search(e.term));
          if (n >= 200) {                                   // capped: query every exact card name of this Pokemon
            for (const name of e.names) {
              if (stopBuild) return;
              const nk = norm(name);
              if (nk === key || doneTerms.has(nk)) continue;
              await retry(() => search(name));
              doneTerms.add(nk);
              await sleep(120);
            }
          }
          doneTerms.add(key);
        } catch (err) { /* retried at the next build */ }
        await sleep(120);
        if (++j % 20 === 0) {
          setProgress('Étape 2/2 · recherches ' + (todo.length ? Math.min(j, todo.length) : 0) + '/' + todo.length + ' · ' + mem.cards.size + ' cartes');
          await flushCards();
        }
      });
      await flushCards();
      mem.meta.doneTerms = Array.from(doneTerms);
      if (!stopBuild && todo.every(([key]) => doneTerms.has(key))) mem.meta.built = Date.now();
      await saveMeta();
      for (const rec of mem.cards.values()) prep(rec);
      setProgress(stopBuild ? 'Construction arrêtée.' : 'Base prête : ' + mem.cards.size + ' cartes.');
    } catch (e) {
      setProgress('Erreur construction : ' + e.message);
    } finally {
      building = false;
      setButtons();
      showStats();
    }
  }

  // HP + illustrator (TCGdex) for the candidates that remain; cached forever.
  async function fetchDetails(list) {
    let buf = [];
    await mapLimit(list, 8, async (c) => {
      let det;
      try {
        const r = await retry(() => gm(CONFIG.tcg + '/cards/' + c.id));
        det = { id: c.id, hp: r && typeof r.hp === 'number' ? r.hp : null, ill: r && r.illustrator ? r.illustrator : null };
      } catch (e) { return; }                               // retried next time
      mem.details.set(c.id, det);
      c.hp = det.hp;
      c.ill = det.ill ? norm(det.ill) : null;
      buf.push(det);
    });
    if (buf.length) await dbPutMany('details', buf);
  }


    async function run(say) {
      progressCb = (m) => say('Cartodle · ' + m);
      await ensureMem();
      if (!mem.cards.size || !mem.meta.built) {
        say('Cartodle · construction de la base (quelques minutes)...');
        await buildDb();
        return { text: mem.meta.built ? 'Base prête : touche encore pour résoudre' : 'Base incomplète : touche encore pour continuer' };
      }
      let st = await api('');
      if (st.status !== 'playing') st = await api('/rejouer', {});
      for (const rec of mem.cards.values()) prep(rec);
      const all = Array.from(mem.cards.values());
      let played = false;
      while (st.status === 'playing' && st.guesses.length < st.maxGuesses) {
        const fbs = st.guesses.map((F) => ({ F, G: guessInfo(F, mem.cards.get(F.card.id)) }));
        let lvl = 0, cands = [];
        for (lvl = 0; lvl <= 2; lvl++) { cands = filterCandidates(all, fbs, lvl); if (cands.length) break; }
        if (!cands.length) throw new Error('aucune carte compatible avec les indices');
        if (lvl === 0 && cands.length <= CONFIG.detailLimit) {
          const need = cands.filter((c) => !mem.details.has(c.id));
          if (need.length) {
            say('Cartodle · PV / illustrateurs (' + need.length + ')...');
            await fetchDetails(need);
            const refined = filterCandidates(cands, fbs, 0);
            if (refined.length) cands = refined;
          }
        }
        const pick = pickGuess(cands, new Set(fbs.map((x) => x.G.id)));
        say('Cartodle · essai ' + (st.guesses.length + 1) + '/' + st.maxGuesses + ' (' + cands.length + ' cartes)');
        st = await api('/guess', { cardId: pick.id });
        played = true;
        await wait(500);
      }
      const won = st.status === 'found' || st.status === 'won';
      return { played, text: won ? 'Gagné en ' + st.guesses.length + ' essais · +' + st.coins + ' pièces · +' + st.energy + ' énergie' : 'Perdu (' + st.guesses.length + ' essais)' };
    }
    return { run };
  })();

  // ============================================================ Voltorb Flip
  const voltorb = (() => {
    const SIZE = 5;
    const SOLVER_URL = 'https://voltorbflip.com/api/solve';
    const sleep = wait;
    const hp = mkApi('/api/games/voltorb');
  // Build the solver payload from the game state.
  // Tile candidates are [voltorb, 1, 2, 3]. Unrevealed = all true, revealed = only its value.
  function buildPayload(state) {
    const g = state.grid;
    return {
      BoardTotals: {
        RowTotals: g.rows.map((r) => ({ Points: r.points, Voltorbs: r.voltorbs })),
        ColumnTotals: g.cols.map((c) => ({ Points: c.points, Voltorbs: c.voltorbs })),
      },
      Tiles: Array.from({ length: SIZE }, (_, y) =>
        Array.from({ length: SIZE }, (_, x) => {
          const v = g.tiles[y * SIZE + x];
          return v == null ? [true, true, true, true] : [v === 0, v === 1, v === 2, v === 3];
        })
      ),
    };
  }

  function solve(state) {
    const payload = buildPayload(state);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: SOLVER_URL,
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://voltorbflip.com',
          Referer: 'https://voltorbflip.com/',
        },
        data: JSON.stringify(payload),
        timeout: 20000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          } else {
            reject(new Error('Solver HTTP ' + r.status));
          }
        },
        onerror: () => reject(new Error('Solver network error')),
        ontimeout: () => reject(new Error('Solver timeout')),
      });
    });
  }

  // Plan B when the solver gives no usable suggestion: use its narrowed candidates ([voltorb,1,2,3] per tile)
  // and pick an unrevealed tile that cannot be a voltorb. Prefer tiles that may hold a 2 or a 3.
  function pickFallback(state, sol) {
    const g = state.grid;
    let best = -1, bestScore = -1;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (g.tiles[i] != null) continue;                      // already revealed
      const c = sol && sol.Tiles && sol.Tiles[Math.floor(i / SIZE)] && sol.Tiles[Math.floor(i / SIZE)][i % SIZE];
      if (!c || c[0]) continue;                              // may be a voltorb -> not safe
      const score = (c[2] || c[3]) ? 2 : 1;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best;
  }

  async function withRetry(fn, tries = 3) {
    let err;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) { err = e; await sleep(800 * (i + 1)); }
    }
    throw err;
  }


    // Plays until level 5 (the last level) is won, or the run is over.
    async function run(say) {
      let state = await hp('');
      if (state.over || !state.grid) state = await hp('/rejouer', {});
      const target = state.maxLevel || 5;
      let played = false, wins = 0, losses = 0;
      for (let guard = 0; guard < 400; guard++) {
        const g = state.grid;
        if (!g) break;
        const sol = await withRetry(() => solve(state));
        if (!sol.IsPossible) throw new Error('le solveur juge la grille impossible');
        let idx = sol.SafestPosition ? sol.SafestPosition.Y * SIZE + sol.SafestPosition.X : -1;
        if (idx < 0 || g.tiles[idx] != null || sol.IsWon) {
          idx = pickFallback(state, sol);
          if (idx < 0) throw new Error('plus de case sûre');
        }
        say('Voltorb · niveau ' + state.level + ' · ' + g.tiles.filter((v) => v == null).length + ' cases');
        const prevNumber = g.number;
        state = await hp('/flip', { index: idx });
        played = true;
        const last = state.last;
        if (last && last.number === prevNumber) {
          if (last.won) {
            wins++;
            if (last.level >= target) return { played, text: 'Niveau ' + target + ' gagné' };
          } else losses++;
          if (state.over) break;
        }
        await wait(400);
      }
      return { played, text: 'Terminé · ' + wins + ' niveaux gagnés, ' + losses + ' perdus' };
    }
    return { run };
  })();

  // ====================================================================== UI
  const GAMES = [
    { label: 'Voisins', page: '/jeux/voisins', run: voisins.run },
    { label: 'Coffre', page: '/jeux/coffre', run: coffre.run },
    { label: 'Connexions', page: '/jeux/connexions', run: connexions.run },
    { label: 'Cartodle', page: '/jeux/cartodle', run: cartodle.run },
    { label: 'Voltorb Flip', page: '/jeux/voltorbe-flip', run: voltorb.run },
  ];

  let busy = false;

  const root = document.createElement('div');
  root.id = 'hps-hub';
  root.style.cssText = 'position:fixed;right:10px;top:calc(env(safe-area-inset-top,0px) + 76px);z-index:2147483647;' +
    'display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:15px/1.3 system-ui,sans-serif';

  const fab = document.createElement('button');
  fab.textContent = '🧩';
  fab.setAttribute('aria-label', 'Solveurs');
  fab.style.cssText = 'width:46px;height:46px;border-radius:50%;border:2px solid #111;background:#ffd60a;color:#111;' +
    'font-size:22px;line-height:1;cursor:pointer;box-shadow:0 3px 12px #0007;padding:0';

  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;width:min(84vw,280px);max-height:70vh;overflow:auto;padding:10px;background:#18181b;' +
    'color:#fff;border:1px solid #71717a;border-radius:14px;box-shadow:0 8px 30px #000a';

  const buttons = GAMES.map((g) => {
    const b = document.createElement('button');
    b.textContent = g.label;
    b.style.cssText = 'display:block;width:100%;height:48px;margin:0 0 8px;border-radius:10px;border:1px solid #52525b;' +
      'background:#2a2e3a;color:#fff;font:600 16px system-ui,sans-serif;cursor:pointer';
    b.addEventListener('click', () => solveGame(g));
    panel.append(b);
    return b;
  });

  const status = document.createElement('div');
  status.style.cssText = 'min-height:18px;font-size:13px;color:#d4d4d8;overflow-wrap:anywhere';
  panel.append(status);

  function setStatus(msg, bad) {
    status.textContent = msg;
    status.style.color = bad ? '#fca5a5' : '#d4d4d8';
  }

  function setBusy(on) {
    busy = on;
    buttons.forEach((b) => { b.disabled = on; b.style.opacity = on ? '0.5' : '1'; });
  }

  async function solveGame(g) {
    if (busy) return;
    setBusy(true);
    setStatus(g.label + '...');
    let played = false;
    try {
      const res = await g.run((m) => setStatus(m));
      played = !!res.played;
      setStatus(g.label + ' : ' + res.text);
    } catch (e) {
      setStatus(g.label + ' : erreur · ' + e.message, true);
    } finally {
      setBusy(false);
      // The page does not follow API calls: refresh it when it shows the game that was just played.
      if (played && location.pathname.startsWith(g.page)) setTimeout(() => location.reload(), 1800);
    }
  }

  fab.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    try { localStorage.setItem('hps_open', open ? '1' : '0'); } catch (e) { /* ignore */ }
  });
  try { if (localStorage.getItem('hps_open') === '1') panel.style.display = 'block'; } catch (e) { /* ignore */ }

  root.append(fab, panel);
  document.body.appendChild(root);
})();
