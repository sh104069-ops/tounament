/* =========================================================
   トーナメント表  script.js
   - カテゴリーごとのトーナメント表（シード対応）
   - ルーレット／くじ引き／手動で組み合わせを決定
   - 勝者をタップして勝ち上がりを記録
   - 画面分割で複数カテゴリーを同時進行
   - 試合場（最大20）ごとの担当者がスマホで結果を入力し、本部の画面へ即時に反映
   データはブラウザ（localStorage）に自動保存されます。
   共有には Firebase Realtime Database（REST API）を使います。
   ========================================================= */
(() => {
  'use strict';

  /* ========== 定数 ========== */

  const STORAGE_KEY = 'tournament-board-v1';
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 64;
  const MAX_CATS = 12;
  const PANE_MAX = 6;
  const BYE = '__BYE__';
  const MAX_COURTS = 20;
  const DASH = '@courts'; // 分割画面に「試合場の進行状況」を出すときの値

  const LAYOUTS = [
    { id: '1',  cols: 1, rows: 1, label: '1画面' },
    { id: '2c', cols: 2, rows: 1, label: '左右に2分割' },
    { id: '2r', cols: 1, rows: 2, label: '上下に2分割' },
    { id: '3',  cols: 3, rows: 1, label: '3分割' },
    { id: '4',  cols: 2, rows: 2, label: '4分割' },
    { id: '6',  cols: 3, rows: 2, label: '6分割' },
  ];

  // カテゴリーごとの見出し色
  const COLORS = [
    '#1b3a6b', '#2c6a4d', '#6a4788', '#99571a', '#1c6c78', '#766312',
    '#8a3b5a', '#46525e', '#3557a3', '#56782a', '#9c4d2b', '#52568a',
  ];

  // トーナメント表の寸法（px）
  const DIM = { unit: 42, slotH: 32, colW: 184, gapW: 40, headH: 40, pad: 14, champW: 150 };

  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ========== 小道具 ========== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const randInt = (n) => Math.floor(Math.random() * n);

  let uidCounter = 0;
  function uid() {
    uidCounter += 1;
    return Date.now().toString(36) + uidCounter.toString(36) + randInt(1e6).toString(36);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 要素を作る（文字列は必ず textContent 経由で入れる）
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') el.value = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  /* ========== 役割（本部／試合場の担当者） ========== */

  // 共有先（Firebase Realtime Database）のURLとして受け付ける形
  function cleanDb(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }
  function validDb(url) {
    return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)$/i.test(url) ||
           /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url); // 手元での動作確認用
  }
  const validRoom = (room) => /^[a-z0-9]{12,40}$/i.test(room || '');

  // 担当者用リンク（…#db=…&room=…&court=…）で開かれたとき
  function parseJoin() {
    try {
      const p = new URLSearchParams(location.hash.replace(/^#/, ''));
      if (!p.has('db') && !p.has('room')) return null;
      const db = cleanDb(p.get('db'));
      const room = p.get('room') || '';
      return {
        db,
        room,
        ok: validDb(db) && validRoom(room),
        court: clamp(parseInt(p.get('court'), 10) || 1, 1, MAX_COURTS),
      };
    } catch (e) {
      return null;
    }
  }
  const JOIN = parseJoin();
  const IS_COURT = !!JOIN;
  let courtNo = JOIN ? JOIN.court : 0; // 0 = 本部

  /* ========== データ ========== */

  function newPlayer() {
    return { id: uid(), name: '', seed: null };
  }

  function newCategory(index, count = 8) {
    return {
      id: uid(),
      name: `カテゴリー${index + 1}`,
      players: Array.from({ length: count }, newPlayer),
      slots: null,   // 抽選後：表の上から順に 選手ID / null（空き）
      results: {},   // "回戦-試合" → 0（上が勝ち）/ 1（下が勝ち）
      meta: {},      // "回戦-試合" → { by: 入力した試合場（0=本部）, t: 時刻 }
      drawId: uid(), // 組み合わせが変わるたびに新しくする（古い結果を無視するため）
      blocks: 1,     // 山の数
      courts: [1],   // 山ごとの試合場
      finalCourt: 1, // 山の勝者どうしの試合を行う試合場
    };
  }

  // シード番号を 1,2,3… に詰め直す
  function renumberSeeds(players) {
    players
      .filter((p) => p.seed)
      .sort((a, b) => a.seed - b.seed)
      .forEach((p, i) => { p.seed = i + 1; });
  }

  function validSlots(slots, players) {
    const pos = positionsFor(players.length);
    const ids = new Set(players.map((p) => p.id));
    const seen = new Set();
    for (const p of pos) {
      const v = slots[p.pos];
      if (p.bye) { if (v != null) return false; continue; }
      if (!ids.has(v) || seen.has(v)) return false;
      seen.add(v);
    }
    return seen.size === players.length;
  }

  // 保存データ・読み込みデータ・本部から届いたデータを安全な形に整える
  function normalize(src, allowEmpty) {
    const out = {
      title: '', layout: '2c', panes: [], categories: [], setupDone: false,
      courtCount: 1, share: null,
    };
    const srcPanes = src && Array.isArray(src.panes) ? src.panes : [];

    if (src && typeof src === 'object') {
      if (typeof src.title === 'string') out.title = src.title.slice(0, 40);
      if (LAYOUTS.some((l) => l.id === src.layout)) out.layout = src.layout;
      out.setupDone = !!src.setupDone;
      out.courtCount = clamp(parseInt(src.courtCount, 10) || 1, 1, MAX_COURTS);
      if (src.share && validDb(cleanDb(src.share.db)) && validRoom(src.share.room)) {
        out.share = { db: cleanDb(src.share.db), room: src.share.room };
      }

      if (Array.isArray(src.categories)) {
        src.categories.slice(0, MAX_CATS).forEach((c, ci) => {
          if (!c || !Array.isArray(c.players)) return;
          const players = c.players.slice(0, MAX_PLAYERS).map((p) => ({
            id: String((p && p.id) || uid()),
            name: String((p && p.name) || '').slice(0, 30),
            seed: p && Number.isInteger(p.seed) && p.seed > 0 ? p.seed : null,
          }));
          while (players.length < MIN_PLAYERS) players.push(newPlayer());
          renumberSeeds(players);

          const cat = {
            id: String(c.id || uid()),
            name: String(c.name || `カテゴリー${ci + 1}`).slice(0, 30),
            players,
            slots: null,
            results: {},
            meta: {},
            drawId: String(c.drawId || uid()),
            blocks: parseInt(c.blocks, 10) || 1,
            courts: Array.isArray(c.courts) ? c.courts.slice() : [],
            finalCourt: c.finalCourt,
          };
          fixCourts(cat, out.courtCount);

          const size = bracketSize(players.length);
          if (Array.isArray(c.slots) && c.slots.length === size && validSlots(c.slots, players)) {
            cat.slots = c.slots.slice();
            if (c.results && typeof c.results === 'object') {
              for (const [k, v] of Object.entries(c.results)) {
                if (!/^\d+-\d+$/.test(k) || (v !== 0 && v !== 1)) continue;
                cat.results[k] = v;
                const mt = c.meta && c.meta[k];
                if (mt && typeof mt === 'object') {
                  cat.meta[k] = { by: parseInt(mt.by, 10) || 0, t: Number(mt.t) || 0 };
                }
              }
            }
          }
          out.categories.push(cat);
        });
      }
    }

    if (!out.categories.length && !allowEmpty) out.categories = [newCategory(0), newCategory(1)];

    for (let i = 0; i < PANE_MAX; i++) {
      const p = srcPanes[i] || {};
      const fallback = out.categories.length ? out.categories[i % out.categories.length].id : '';
      out.panes.push({
        cat: typeof p.cat === 'string' ? p.cat : fallback,
        zoom: clamp(Number(p.zoom) || 1, 0.3, 1.6),
      });
    }
    return out;
  }

  function loadState() {
    if (IS_COURT) return normalize(null, true); // 担当者用は、本部から届いた内容だけを使う
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* 保存領域が使えない環境でもそのまま動かす */ }
    return normalize(null);
  }

  function save() {
    if (IS_COURT) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* 同上 */ }
    syncTouch(); // 共有中なら、変更を担当者のスマホへ配る
  }

  let state = loadState();

  const categoryById = (id) => state.categories.find((c) => c.id === id);
  const colorOf = (cat) => COLORS[state.categories.indexOf(cat) % COLORS.length];

  function playerInfo(cat) {
    return new Map(cat.players.map((p, i) => [
      p.id,
      { name: p.name.trim() || `選手${i + 1}`, seed: p.seed },
    ]));
  }

  /* ========== トーナメントの計算 ========== */

  function bracketSize(n) {
    let s = 2;
    while (s < n) s *= 2;
    return s;
  }

  // 表の上から順に「何番目に強い枠か」を返す。
  // 1番は一番上、2番は一番下、3・4番は反対の山…となる並び。
  function seedOrder(size) {
    let list = [1];
    while (list.length < size) {
      const n = list.length * 2;
      const half = list.length / 2;
      const next = [];
      list.forEach((x, i) => {
        if (list.length === 1 || i < half) next.push(x, n + 1 - x);
        else next.push(n + 1 - x, x);
      });
      list = next;
    }
    return list;
  }

  // 参加人数から、表の各位置の情報を作る。
  // line が人数を超える位置は「空き」＝隣の人が1回戦なし（シード枠）。
  function positionsFor(n) {
    const size = bracketSize(n);
    let entry = 0;
    return seedOrder(size).map((line, pos) => {
      const bye = line > n;
      if (!bye) entry += 1;
      return { pos, line, bye, entry: bye ? null : entry };
    });
  }

  function seededPlayers(cat) {
    return cat.players.filter((p) => p.seed).sort((a, b) => a.seed - b.seed);
  }

  // 現在の組み合わせと勝敗から、全試合の状態を組み立てる
  function buildRounds(cat) {
    const n = cat.players.length;
    const pos = positionsFor(n);
    const size = pos.length;
    const R = Math.round(Math.log2(size));
    const k = Math.round(Math.log2(cat.blocks || 1)); // 山の数 = 2^k
    const drawn = !!cat.slots;
    const seeds = seededPlayers(cat);

    const base = pos.map((p) => {
      if (p.bye) return BYE;
      if (drawn) return cat.slots[p.pos];
      return seeds[p.line - 1] ? seeds[p.line - 1].id : null; // 抽選前はシードだけ表示
    });

    const rounds = [];
    let matchNo = 0;
    for (let r = 0; r < R; r++) {
      const count = size >> (r + 1);
      const arr = [];
      for (let i = 0; i < count; i++) {
        const a = r === 0 ? base[2 * i] : rounds[r - 1][2 * i].winner;
        const b = r === 0 ? base[2 * i + 1] : rounds[r - 1][2 * i + 1].winner;
        const m = {
          r, i, sides: [a, b], bye: false, side: null, winner: null, no: null,
          block: -1, court: cat.finalCourt, // 山を勝ち抜いた後の試合
        };
        if (r < R - k) {
          m.block = i >> (R - k - 1 - r);
          m.court = cat.courts[m.block];
        }
        if (a === BYE || b === BYE) {
          m.bye = true;
          m.side = a === BYE ? 1 : 0;
          m.winner = m.sides[m.side];
        } else {
          matchNo += 1;
          m.no = matchNo;
          const res = cat.results[`${r}-${i}`];
          if (drawn && (res === 0 || res === 1) && a && b) {
            m.side = res;
            m.winner = m.sides[res];
          }
        }
        arr.push(m);
      }
      rounds.push(arr);
    }
    // 選手ID → 組み合わせ番号
    const entryOf = new Map();
    pos.forEach((p) => {
      if (!p.bye && base[p.pos]) entryOf.set(base[p.pos], p.entry);
    });
    return { rounds, pos, size, R, drawn, base, entryOf };
  }

  function roundName(r, R) {
    const left = R - r;
    if (left === 1) return '決勝';
    if (left === 2) return '準決勝';
    if (left === 3) return '準々決勝';
    return `${r + 1}回戦`;
  }

  /* ========== トーナメント表の描画 ========== */

  function renderBracket(cat, b, opts = {}) {
    const { rounds, pos, size, R, drawn, base } = b;
    const D = DIM;
    const info = playerInfo(cat);
    const W = D.pad * 2 + R * (D.colW + D.gapW) + D.champW;
    const H = D.headH + size * D.unit + D.pad;

    const xOf = (r) => D.pad + r * (D.colW + D.gapW);
    const cyOf = (r, i) => D.headH + (2 * i + 1) * Math.pow(2, r) * D.unit;

    // 選手ID → 組み合わせ番号
    const entryOf = new Map();
    pos.forEach((p) => {
      if (!p.bye && base[p.pos]) entryOf.set(base[p.pos], p.entry);
    });

    const root = h('div', { class: 'bracket', style: `width:${W}px;height:${H}px` });
    const wires = svgEl('svg', { class: 'wires', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    root.append(wires);
    const wonWires = [];

    for (let r = 0; r < R; r++) {
      root.append(h('div', {
        class: 'round-label',
        style: `left:${xOf(r)}px;width:${D.colW}px`,
        text: roundName(r, R),
      }));
    }

    const anim = opts.anim || null; // { r, i }：いま勝者が決まった試合

    function slotEl(m, side) {
      const pid = m.sides[side] === BYE ? null : m.sides[side];
      const playable = !!opts.interactive && drawn && !m.bye && !!m.sides[0] && !!m.sides[1];
      const decided = !m.bye && m.side != null;
      const cls = ['slot'];
      if (!pid) cls.push('is-empty');
      if (decided) cls.push(m.side === side ? 'is-winner' : 'is-loser');
      if (anim && pid && anim.r + 1 === m.r && anim.i >> 1 === m.i && (anim.i & 1) === side) {
        cls.push('arrive');
      }

      let entry = '';
      let name = '';
      if (pid) {
        entry = entryOf.get(pid) || '';
        name = info.get(pid).name;
      } else if (m.r === 0) {
        entry = pos[2 * m.i + side].entry || '';
        name = '抽選待ち';
      }

      const el = h(playable ? 'button' : 'div', {
        class: cls.join(' '),
        type: playable ? 'button' : null,
        title: pid ? name : null,
        'aria-pressed': playable ? String(decided && m.side === side) : null,
        'aria-label': playable ? `${name} を勝者にする` : null,
        dataset: { r: m.r, i: m.i, side },
      });
      el.append(
        h('span', { class: 'slot-no', text: entry }),
        h('span', { class: 'slot-name', text: name }),
      );
      const seed = pid ? info.get(pid).seed : null;
      if (seed) el.append(h('span', { class: 'seed-chip', text: `S${seed}`, title: `第${seed}シード` }));
      if (decided && m.side === side) el.append(h('span', { class: 'slot-mark', text: '○', 'aria-hidden': 'true' }));
      return el;
    }

    rounds.forEach((arr, r) => arr.forEach((m) => {
      const x = xOf(r);
      const cy = cyOf(r, m.i);

      if (m.bye) {
        root.append(h('div', {
          class: 'match is-bye',
          style: `left:${x}px;top:${cy - D.slotH / 2}px;width:${D.colW}px`,
        },
          h('span', { class: 'match-tag', text: 'シード（1回戦なし）' }),
          slotEl(m, m.side),
        ));
      } else {
        root.append(h('div', {
          class: 'match' + (opts.court && m.court === opts.court ? ' is-mine' : ''),
          style: `left:${x}px;top:${cy - D.slotH}px;width:${D.colW}px`,
        },
          h('span', {
            class: 'match-tag',
            text: state.courtCount > 1 ? `第${m.no}試合　試合場${m.court}` : `第${m.no}試合`,
          }),
          slotEl(m, 0),
          slotEl(m, 1),
        ));
      }

      // 次の回戦（または優勝枠）への線
      const sx = x + D.colW;
      let d;
      if (r < R - 1) {
        const px = xOf(r + 1);
        const pcy = cyOf(r + 1, m.i >> 1);
        const ey = pcy + ((m.i & 1) === 0 ? -D.slotH / 2 : D.slotH / 2);
        d = `M${sx} ${cy}H${sx + D.gapW / 2}V${ey}H${px}`;
      } else {
        d = `M${sx} ${cy}H${xOf(R)}`;
      }
      const won = !m.bye && !!m.winner;
      const path = svgEl('path', {
        d,
        class: 'wire' + (m.bye ? ' is-bye' : '') + (won ? ' is-won' : ''),
      });
      if (won && anim && anim.r === r && anim.i === m.i) {
        path.setAttribute('pathLength', '1');
        path.classList.add('draw-in');
      }
      if (won) wonWires.push(path); else wires.append(path);
    }));
    wonWires.forEach((p) => wires.append(p)); // 赤い線は上に重ねる

    // 優勝
    const final = rounds[R - 1][0];
    const champ = final.winner && final.winner !== BYE ? info.get(final.winner).name : '';
    const champCls = ['champion'];
    if (champ) champCls.push('has-winner');
    if (champ && anim && anim.r === R - 1) champCls.push('arrive');
    root.append(h('div', {
      class: champCls.join(' '),
      style: `left:${xOf(R)}px;top:${cyOf(R - 1, 0) - 40}px;width:${D.champW}px`,
    },
      h('span', { class: 'champion-label' }, h('span', { text: '優' }), h('span', { text: '勝' })),
      h('span', { class: 'champion-name', text: champ }),
    ));

    return { el: root, W, H };
  }

  /* ========== 画面分割（ペイン） ========== */

  const board = $('#board');

  function paneCategory(idx) {
    const p = state.panes[idx];
    let cat = categoryById(p.cat);
    if (!cat) {
      cat = state.categories[idx % state.categories.length];
      p.cat = cat.id;
    }
    return cat;
  }

  function currentLayout() {
    return LAYOUTS.find((l) => l.id === state.layout) || LAYOUTS[0];
  }

  function renderLayoutSwitch() {
    const box = $('#layoutSwitch');
    box.replaceChildren(...LAYOUTS.map((l) => {
      const icon = svgEl('svg', { width: 24, height: 16, viewBox: '0 0 24 16', 'aria-hidden': 'true' });
      const cw = 24 / l.cols;
      const ch = 16 / l.rows;
      for (let y = 0; y < l.rows; y++) {
        for (let x = 0; x < l.cols; x++) {
          icon.append(svgEl('rect', {
            x: x * cw + 1, y: y * ch + 1, width: cw - 2, height: ch - 2,
            fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5,
          }));
        }
      }
      return h('button', {
        type: 'button',
        class: 'layout-btn',
        title: l.label,
        'aria-label': l.label,
        'aria-pressed': String(l.id === state.layout),
        onclick: () => { state.layout = l.id; save(); renderLayoutSwitch(); renderBoard(); },
      }, icon);
    }));
  }

  function buildPane(idx) {
    const pane = h('section', { class: 'pane', dataset: { pane: idx } });
    const select = h('select', { class: 'pane-select', 'aria-label': '表示するカテゴリー' });
    select.addEventListener('change', () => {
      state.panes[idx].cat = select.value;
      save();
      updatePane(pane);
    });

    pane.append(
      h('header', { class: 'pane-head' },
        select,
        h('span', { class: 'pane-status' }),
        h('div', { class: 'pane-tools' },
          h('button', { type: 'button', class: 'btn btn-small', dataset: { act: 'edit' }, text: '参加者' }),
          h('button', { type: 'button', class: 'btn btn-small', dataset: { act: 'draw' }, text: '抽選' }),
          h('div', { class: 'zoom', role: 'group', 'aria-label': '表示の大きさ' },
            h('button', { type: 'button', dataset: { act: 'zoom-out' }, 'aria-label': '縮小', text: '−' }),
            h('button', { type: 'button', dataset: { act: 'fit' }, title: '全体が見える大きさにする', text: '全体' }),
            h('button', { type: 'button', dataset: { act: 'zoom-in' }, 'aria-label': '拡大', text: '＋' }),
          ),
        ),
      ),
      h('div', { class: 'pane-notice', hidden: true }),
      h('div', { class: 'pane-body' }, h('div', { class: 'bracket-wrap' })),
    );
    return pane;
  }

  function updatePane(pane, anim) {
    const idx = Number(pane.dataset.pane);
    const isDash = state.panes[idx].cat === DASH;

    // カテゴリー選択（最後の項目は本部用の進行状況）
    const select = $('.pane-select', pane);
    select.replaceChildren(
      ...state.categories.map((c) => h('option', { value: c.id, text: c.name })),
      h('option', { value: DASH, text: '試合場の進行状況' }),
    );
    pane.classList.toggle('is-dash', isDash);

    if (isDash) {
      select.value = DASH;
      pane.style.setProperty('--cat', '#15191e');
      $('.pane-status', pane).replaceChildren(`全${state.courtCount}試合場`);
      const note = $('.pane-notice', pane);
      note.hidden = true;
      note.replaceChildren();
      const box = $('.bracket-wrap', pane);
      box.style.width = '';
      box.style.height = '';
      box.replaceChildren(renderDash());
      return;
    }

    const cat = paneCategory(idx);
    const b = buildRounds(cat);
    const n = cat.players.length;
    pane.style.setProperty('--cat', colorOf(cat));
    select.value = cat.id;

    // 進行状況
    const status = $('.pane-status', pane);
    const total = n - 1;
    let done = 0;
    b.rounds.forEach((arr) => arr.forEach((m) => { if (!m.bye && m.winner) done += 1; }));
    const final = b.rounds[b.R - 1][0];
    if (!b.drawn) {
      status.replaceChildren(`${n}名　抽選前`);
    } else if (final.winner) {
      status.replaceChildren(`${n}名　`, h('b', { text: `優勝 ${playerInfo(cat).get(final.winner).name}` }));
    } else {
      status.replaceChildren(`${n}名　${done} / ${total} 試合終了`);
    }

    $('[data-act="draw"]', pane).textContent = b.drawn ? '再抽選' : '抽選';

    // 案内
    const notice = $('.pane-notice', pane);
    if (!b.drawn) {
      notice.hidden = false;
      notice.className = 'pane-notice';
      notice.replaceChildren(
        h('span', { text: '組み合わせがまだ決まっていません。' }),
        h('button', { type: 'button', class: 'btn btn-accent btn-small', dataset: { act: 'draw' }, text: '抽選をはじめる' }),
      );
    } else if (done === 0) {
      notice.hidden = false;
      notice.className = 'pane-notice is-hint';
      notice.replaceChildren('勝った方の名前をタップすると、次の回戦へ勝ち上がります。もう一度タップで取り消し。');
    } else {
      notice.hidden = true;
      notice.replaceChildren();
    }

    // 表
    const { el, W, H } = renderBracket(cat, b, { interactive: true, anim });
    const z = state.panes[idx].zoom;
    const wrap = $('.bracket-wrap', pane);
    wrap.style.width = `${Math.ceil(W * z)}px`;
    wrap.style.height = `${Math.ceil(H * z)}px`;
    el.style.transform = `scale(${z})`;
    wrap.replaceChildren(el);
    pane._dims = { W, H };
  }

  function renderBoard() {
    const lay = currentLayout();
    board.style.setProperty('--cols', lay.cols);
    board.style.setProperty('--rows', lay.rows);
    const panes = [];
    for (let i = 0; i < lay.cols * lay.rows; i++) panes.push(buildPane(i));
    board.replaceChildren(...panes);
    panes.forEach((p) => updatePane(p));
  }

  function refreshCategory(catId, anim) {
    board.querySelectorAll('.pane').forEach((pane) => {
      const shown = state.panes[Number(pane.dataset.pane)].cat;
      if (shown === catId || shown === DASH) updatePane(pane, anim);
    });
  }

  function setZoom(pane, z) {
    const idx = Number(pane.dataset.pane);
    state.panes[idx].zoom = clamp(Math.round(z * 100) / 100, 0.3, 1.6);
    save();
    updatePane(pane);
  }

  function fitPane(pane) {
    const body = $('.pane-body', pane);
    const { W, H } = pane._dims;
    setZoom(pane, Math.min((body.clientWidth - 14) / W, (body.clientHeight - 14) / H));
  }

  /* ========== 勝ち上がりの記録 ========== */

  function setWinner(cat, r, i, side, sourcePane) {
    const res = recordResult(cat, r, i, side);
    if (!res) return;
    refreshCategory(cat.id, res.anim);

    // 押した場所にフォーカスを戻す（キーボード操作用）
    const again = sourcePane.querySelector(`.slot[data-r="${r}"][data-i="${i}"][data-side="${side}"]`);
    if (again && again.focus) again.focus({ preventScroll: true });
  }

  board.addEventListener('click', (e) => {
    const pane = e.target.closest('.pane');
    if (!pane) return;
    if (state.panes[Number(pane.dataset.pane)].cat === DASH) return;
    const cat = paneCategory(Number(pane.dataset.pane));

    const slot = e.target.closest('button.slot');
    if (slot) {
      setWinner(cat, Number(slot.dataset.r), Number(slot.dataset.i), Number(slot.dataset.side), pane);
      return;
    }

    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const idx = Number(pane.dataset.pane);
    switch (actEl.dataset.act) {
      case 'edit': openEdit(cat.id); break;
      case 'draw': openDraw(cat.id); break;
      case 'zoom-in': setZoom(pane, state.panes[idx].zoom * 1.15); break;
      case 'zoom-out': setZoom(pane, state.panes[idx].zoom / 1.15); break;
      case 'fit': fitPane(pane); break;
      default: break;
    }
  });

  /* ========== 入力部品 ========== */

  function stepper(value, min, max, label, onChange) {
    const input = h('input', {
      type: 'number', class: 'stepper-input', min, max, value,
      inputmode: 'numeric', 'aria-label': label,
    });
    // 値が変わるたびに部品ごと作り直すので、二重に呼ばれないよう1回だけ通す
    let fired = false;
    const set = (v) => {
      if (fired) return;
      fired = true;
      onChange(clamp(Math.round(Number(v) || min), min, max));
    };
    input.addEventListener('change', () => set(input.value));
    return h('div', { class: 'stepper' },
      h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `${label}を減らす`, disabled: value <= min, onclick: () => set(value - 1) }, '−'),
      input,
      h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `${label}を増やす`, disabled: value >= max, onclick: () => set(value + 1) }, '＋'),
    );
  }

  function resizePlayers(players, n) {
    while (players.length < n) players.push(newPlayer());
    players.length = n;
    renumberSeeds(players);
  }

  /* ========== 大会設定 ========== */

  const dlgSetup = $('#dlgSetup');
  const titleInput = $('#titleInput');

  function applyTitle(value, from) {
    state.title = value.slice(0, 40);
    document.title = state.title ? `${state.title}｜トーナメント表` : 'トーナメント表';
    if (from !== titleInput) titleInput.value = state.title;
    save();
  }

  function categoryHasData(cat) {
    return !!cat.slots || cat.players.some((p) => p.name.trim());
  }

  function setCategoryCount(n) {
    while (state.categories.length < n) state.categories.push(newCategory(state.categories.length));
    while (state.categories.length > n) {
      const last = state.categories[state.categories.length - 1];
      if (categoryHasData(last) && !confirm(`「${last.name}」には入力済みの内容があります。削除しますか？`)) break;
      state.categories.pop();
    }
    save();
    renderSetup();
    renderBoard();
  }

  function setCourtCount(n) {
    state.courtCount = n;
    state.categories.forEach((cat) => fixCourts(cat, n));
    save();
    renderSetup();
    renderBoard();
  }

  function setCategorySize(cat, n) {
    if (n !== cat.players.length) {
      if (!cat.slots || confirm(`「${cat.name}」は抽選済みです。人数を変えると、組み合わせと勝敗の記録が消えます。変更しますか？`)) {
        resizePlayers(cat.players, n);
        cat.slots = null;
        resetResults(cat);
        fixCourts(cat, state.courtCount);
        save();
      }
    }
    renderSetup();
    refreshCategory(cat.id);
  }

  function renderSetup() {
    const title = h('input', {
      type: 'text', class: 'text-input', id: 'setupTitleInput', maxlength: 40,
      value: state.title, placeholder: '例：秋季大会', autocomplete: 'off',
    });
    title.addEventListener('input', () => applyTitle(title.value, title));

    const rows = state.categories.map((cat, ci) => {
      const name = h('input', {
        type: 'text', class: 'text-input', maxlength: 30, value: cat.name,
        'aria-label': `カテゴリー${ci + 1}の名前`, autocomplete: 'off',
      });
      name.addEventListener('input', () => {
        cat.name = name.value.trim() || `カテゴリー${ci + 1}`;
        save();
        renderBoard();
      });
      return h('li', { class: 'cat-row', style: `--cat:${COLORS[ci % COLORS.length]}` },
        h('span', { class: 'cat-swatch', 'aria-hidden': 'true' }),
        name,
        h('div', { class: 'cat-count' },
          stepper(cat.players.length, MIN_PLAYERS, MAX_PLAYERS, `${cat.name}の参加人数`, (v) => setCategorySize(cat, v)),
          h('span', { class: 'stepper-unit', text: '名' }),
        ),
        h('button', { type: 'button', class: 'btn btn-small', text: '名前とシードを入力', onclick: () => openEdit(cat.id) }),
      );
    });

    $('#setupBody').replaceChildren(
      h('div', { class: 'field' }, h('label', { for: 'setupTitleInput', text: '大会名' }), title),
      h('div', { class: 'field' },
        h('span', { class: 'field-label', text: 'カテゴリー数' }),
        h('div', null, stepper(state.categories.length, 1, MAX_CATS, 'カテゴリー数', setCategoryCount)),
      ),
      h('div', { class: 'field' },
        h('span', { class: 'field-label', text: '試合場の数' }),
        h('div', { class: 'cat-count' },
          stepper(state.courtCount, 1, MAX_COURTS, '試合場の数', setCourtCount),
          h('button', {
            type: 'button', class: 'btn btn-small', style: 'margin-left:10px',
            text: '山ごとに試合場を割り当てる', onclick: openCourts,
          }),
        ),
      ),
      h('ul', { class: 'cat-list' }, rows),
    );
  }

  function openSetup() {
    renderSetup();
    dlgSetup.showModal();
  }

  dlgSetup.addEventListener('close', () => {
    if (!state.setupDone) {
      // はじめての設定後は、カテゴリー数に合わせて分割数を決める
      const n = state.categories.length;
      state.layout = n === 1 ? '1' : n === 2 ? '2c' : n === 3 ? '3' : '4';
      state.panes.forEach((p, i) => { p.cat = state.categories[i % n].id; });
      state.setupDone = true;
    }
    save();
    renderLayoutSwitch();
    renderBoard();
  });

  dlgSetup.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) dlgSetup.close();
  });

  /* ========== 参加者の設定 ========== */

  const dlgEdit = $('#dlgEdit');
  let edit = null;

  function openEdit(catId) {
    const cat = categoryById(catId);
    if (!cat) return;
    edit = { catId, name: cat.name, players: cat.players.map((p) => ({ ...p })) };
    renderEdit();
    $('#editClearResults').hidden = !Object.keys(cat.results).length;
    dlgEdit.showModal();
  }

  function toggleSeed(players, p) {
    if (p.seed) p.seed = null;
    else p.seed = players.filter((x) => x.seed).length + 1;
    renumberSeeds(players);
  }

  function renderEditList() {
    const list = $('#editList');
    list.replaceChildren(...edit.players.map((p, i) => {
      const input = h('input', {
        type: 'text', class: 'name-input', value: p.name, maxlength: 30,
        placeholder: `選手${i + 1}`, 'aria-label': `${i + 1}人目の名前`, autocomplete: 'off',
      });
      input.addEventListener('input', () => { p.name = input.value; });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        const next = list.querySelectorAll('.name-input')[i + 1];
        if (next) next.focus();
      });
      return h('li', { class: 'entry-row' },
        h('span', { class: 'entry-idx', text: i + 1 }),
        input,
        h('button', {
          type: 'button', class: 'seed-toggle',
          'aria-pressed': String(!!p.seed),
          text: p.seed ? `第${p.seed}シード` : 'シードにする',
          onclick: () => { toggleSeed(edit.players, p); renderEditList(); },
        }),
      );
    }));
  }

  function applyBulk(text) {
    const names = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_PLAYERS);
    if (names.length < MIN_PLAYERS) {
      alert('名前を1行に1人ずつ、2人以上入力してください。');
      return;
    }
    edit.players = names.map((name, i) => {
      const p = edit.players[i] || newPlayer();
      p.name = name.slice(0, 30);
      return p;
    });
    renumberSeeds(edit.players);
    renderEdit();
  }

  function renderEdit() {
    const name = h('input', {
      type: 'text', class: 'text-input', id: 'editName', maxlength: 30,
      value: edit.name, autocomplete: 'off',
    });
    name.addEventListener('input', () => { edit.name = name.value; });

    const bulkArea = h('textarea', {
      class: 'bulk-area', rows: 6, 'aria-label': '名前をまとめて入力',
      placeholder: '山田 太郎\n佐藤 花子\n…',
    });

    $('#editBody').replaceChildren(
      h('div', { class: 'field' }, h('label', { for: 'editName', text: 'カテゴリー名' }), name),
      h('div', { class: 'field' },
        h('span', { class: 'field-label', text: '参加人数' }),
        h('div', { class: 'cat-count' },
          stepper(edit.players.length, MIN_PLAYERS, MAX_PLAYERS, '参加人数', (v) => {
            resizePlayers(edit.players, v);
            renderEdit();
          }),
          h('span', { class: 'stepper-unit', text: `名（${MIN_PLAYERS}〜${MAX_PLAYERS}）` }),
        ),
      ),
      h('details', { class: 'bulk' },
        h('summary', { text: '名簿からまとめて貼り付ける' }),
        h('div', { class: 'bulk-inner' },
          bulkArea,
          h('div', null, h('button', {
            type: 'button', class: 'btn btn-small', text: 'この名簿を反映する',
            onclick: () => applyBulk(bulkArea.value),
          })),
        ),
      ),
      h('p', { class: 'help', text: 'シードにした選手は、第1シードが表の一番上、第2シードが一番下…と離れた位置に固定され、1回戦なしの枠に優先して入ります。それ以外の選手の位置は抽選で決めます。' }),
      h('ol', { class: 'entry-list', id: 'editList' }),
    );
    renderEditList();
  }

  function saveEdit() {
    const cat = categoryById(edit.catId);
    if (!cat) { dlgEdit.close(); return; }
    const sig = (players) => players.map((p) => `${p.id}:${p.seed || 0}`).join('|');
    const structural = sig(cat.players) !== sig(edit.players);
    if (structural && cat.slots &&
        !confirm('人数またはシードを変更したため、組み合わせと勝敗の記録が消えます。保存しますか？')) return;

    cat.name = edit.name.trim() || cat.name;
    cat.players = edit.players;
    if (structural) { cat.slots = null; resetResults(cat); }
    fixCourts(cat, state.courtCount);
    save();
    dlgEdit.close();
    edit = null;
    renderBoard();
    if (dlgSetup.open) renderSetup();
  }

  $('#editSave').addEventListener('click', saveEdit);
  $('#editCancel').addEventListener('click', () => dlgEdit.close());
  $('#editClose').addEventListener('click', () => dlgEdit.close());
  $('#editClearResults').addEventListener('click', () => {
    const cat = edit && categoryById(edit.catId);
    if (!cat || !confirm(`「${cat.name}」の勝敗の記録をすべて消します。組み合わせはそのまま残ります。`)) return;
    resetResults(cat);
    save();
    $('#editClearResults').hidden = true;
    refreshCategory(cat.id);
  });

  /* ========== 抽選 ========== */

  const dlgDraw = $('#dlgDraw');
  const DRAW_MODES = [
    { id: 'roulette', label: 'ルーレット' },
    { id: 'kuji', label: 'くじ引き' },
    { id: 'manual', label: '手動で指定' },
  ];
  let draw = null;
  let lastDrawMode = 'roulette';

  function openDraw(catId) {
    const cat = categoryById(catId);
    if (!cat) return;
    if (cat.slots) {
      const msg = Object.keys(cat.results).length
        ? '抽選をやり直すと、記録した勝敗も消えます。やり直しますか？'
        : 'いまの組み合わせを破棄して、抽選をやり直しますか？';
      if (!confirm(msg)) return;
    }

    const pos = positionsFor(cat.players.length);
    const seeds = seededPlayers(cat);
    const fixed = new Map(); // 組み合わせ番号 → シード選手ID
    pos.forEach((p) => {
      if (!p.bye && p.line <= seeds.length) fixed.set(p.entry, seeds[p.line - 1].id);
    });
    const open = pos.filter((p) => !p.bye && p.line > seeds.length).map((p) => p.entry);

    draw = {
      catId,
      mode: lastDrawMode,
      pos,
      fixed,
      open,                               // 抽選で決める番号
      lots: shuffle(open.slice()),        // くじ札の並び（中身）
      queue: cat.players.filter((p) => !p.seed).map((p) => p.id), // くじを引く順
      assigned: new Map(),                // 番号 → 選手ID
      history: [],
      spinning: false,
      timer: null,
      last: null,
    };
    renderDraw();
    dlgDraw.showModal();
  }

  const drawRemaining = () => draw.open.filter((e) => !draw.assigned.has(e));
  const drawDone = () => draw.assigned.size >= draw.queue.length;

  function stopSpin() {
    if (!draw) return;
    clearInterval(draw.timer);
    clearTimeout(draw.timer);
    draw.timer = null;
    draw.spinning = false;
  }

  function assign(entry) {
    const d = draw;
    if (!d || drawDone() || d.assigned.has(entry) || !d.open.includes(entry)) return;
    stopSpin();
    const pid = d.queue[d.assigned.size];
    d.assigned.set(entry, pid);
    d.history.push(entry);
    d.last = entry;
    renderDraw();
  }

  function showCursor(entry) {
    const num = $('.wheel-num', dlgDraw);
    if (num) num.textContent = entry;
    dlgDraw.querySelectorAll('.draw-row').forEach((row) => {
      row.classList.toggle('is-cursor', Number(row.dataset.entry) === entry);
    });
  }

  function spinStart() {
    const d = draw;
    if (!d || d.spinning || drawDone()) return;
    const rem = drawRemaining();
    if (reduceMotion || rem.length === 1) {
      assign(rem[randInt(rem.length)]);
      return;
    }
    d.spinning = 'run';
    let cur = randInt(rem.length);
    renderDraw();
    showCursor(rem[cur]);
    d.timer = setInterval(() => {
      cur = (cur + 1) % rem.length;
      showCursor(rem[cur]);
    }, 70);
  }

  function spinStop() {
    const d = draw;
    if (!d || d.spinning !== 'run') return;
    clearInterval(d.timer);
    const rem = drawRemaining();
    const target = randInt(rem.length);
    const steps = 12;
    let cur = (((target - steps) % rem.length) + rem.length) % rem.length;
    let k = 0;
    d.spinning = 'slow';
    renderDraw();
    const step = () => {
      if (draw !== d) return;
      cur = (cur + 1) % rem.length;
      k += 1;
      showCursor(rem[cur]);
      if (k < steps) {
        d.timer = setTimeout(step, 80 + Math.pow(k / steps, 2) * 380);
      } else {
        const wheel = $('.wheel', dlgDraw);
        if (wheel) wheel.classList.add('is-landing');
        d.timer = setTimeout(() => { if (draw === d) assign(rem[target]); }, 500);
      }
    };
    step();
  }

  function renderDraw() {
    const d = draw;
    const cat = categoryById(d.catId);
    const info = playerInfo(cat);
    const done = drawDone();
    const curPid = d.queue[d.assigned.size];
    const nameAt = (entry) => {
      const pid = d.fixed.get(entry) || d.assigned.get(entry);
      return pid ? info.get(pid).name : '';
    };

    $('#drawTitle').textContent = `抽選　${cat.name}`;

    // 方式の切り替え
    const modes = h('div', { class: 'draw-modes', role: 'group', 'aria-label': '抽選の方法' },
      DRAW_MODES.map((m) => h('button', {
        type: 'button',
        'aria-pressed': String(m.id === d.mode),
        text: m.label,
        onclick: () => { stopSpin(); d.mode = m.id; lastDrawMode = m.id; renderDraw(); },
      })));

    // 抽選ステージ
    const stage = h('div', { class: 'draw-stage' });
    if (done) {
      stage.append(h('p', { class: 'draw-done' },
        d.queue.length ? '全員の位置が決まりました' : '全員がシードのため、抽選はありません',
        h('small', { text: '右の一覧を確認して「この組み合わせで確定する」を押してください。' })));
    } else {
      stage.append(
        h('p', { class: 'draw-count', text: `${d.assigned.size + 1} / ${d.queue.length} 人目` }),
        h('p', { class: 'draw-name', text: info.get(curPid).name }),
      );

      if (d.mode === 'roulette') {
        const running = d.spinning === 'run';
        const slowing = d.spinning === 'slow';
        const btn = h('button', {
          type: 'button',
          class: `btn btn-big ${running ? 'btn-accent' : 'btn-primary'}`,
          id: 'spinBtn',
          disabled: slowing,
          text: running ? 'ストップ' : slowing ? '…' : 'スタート',
          onclick: () => (draw.spinning === 'run' ? spinStop() : spinStart()),
        });
        stage.append(
          h('div', { class: `wheel${d.spinning ? ' is-running' : ''}`, 'aria-live': 'polite' },
            h('span', { class: 'wheel-num', text: '?' }),
            h('span', { class: 'wheel-unit', text: '番' })),
          btn,
        );
      } else if (d.mode === 'kuji') {
        stage.append(
          h('p', { class: 'help', text: '好きな札を1枚えらんでください。' }),
          h('div', { class: 'lots' }, d.lots.map((entry) => {
            const taken = d.assigned.has(entry);
            if (!taken) {
              return h('button', { type: 'button', class: 'lot is-hidden', 'aria-label': 'くじを引く', onclick: () => assign(entry) },
                h('span', { class: 'lot-num', text: 'くじ' }));
            }
            return h('div', { class: `lot is-taken${entry === d.last ? ' is-new' : ''}` },
              h('span', { class: 'lot-num', text: entry }),
              h('span', { class: 'lot-name', text: nameAt(entry) }));
          })),
        );
      } else {
        stage.append(
          h('p', { class: 'help', text: '入れる番号をえらんでください。' }),
          h('div', { class: 'lots' }, d.open.map((entry) => {
            const taken = d.assigned.has(entry);
            if (!taken) {
              return h('button', { type: 'button', class: 'lot is-open', 'aria-label': `${entry}番に入れる`, onclick: () => assign(entry) },
                h('span', { class: 'lot-num', text: entry }));
            }
            return h('div', { class: `lot is-taken${entry === d.last ? ' is-new' : ''}` },
              h('span', { class: 'lot-num', text: entry }),
              h('span', { class: 'lot-name', text: nameAt(entry) }));
          })),
        );
      }
    }

    if (d.last != null && d.assigned.has(d.last)) {
      stage.append(h('p', { class: 'draw-last', text: `${info.get(d.assigned.get(d.last)).name} さんは ${d.last}番 に決まりました` }));
    }

    // 組み合わせ番号の一覧
    const rows = d.pos.filter((p) => !p.bye).map((p) => {
      const name = nameAt(p.entry);
      const isSeed = d.fixed.has(p.entry);
      const hasBye = d.pos[p.pos ^ 1].bye;
      const cls = ['draw-row'];
      if (!name) cls.push('is-blank');
      if (p.entry === d.last) cls.push('is-new');
      const tag = isSeed
        ? h('span', { class: 'draw-row-tag is-seed', text: `第${info.get(d.fixed.get(p.entry)).seed}シード` })
        : hasBye ? h('span', { class: 'draw-row-tag', text: '1回戦なし' }) : h('span');
      return h('li', { class: cls.join(' '), dataset: { entry: p.entry } },
        h('span', { class: 'draw-row-no', text: p.entry }),
        h('span', { class: 'draw-row-name', text: name || '未定' }),
        tag);
    });

    $('#drawBody').replaceChildren(
      modes,
      h('div', { class: 'draw-main' },
        stage,
        h('div', { class: 'draw-side' },
          h('h3', { text: '組み合わせ番号（表の上から順）' }),
          h('ol', { class: 'draw-list' }, rows)),
      ),
    );

    $('#drawUndo').disabled = !d.history.length || !!d.spinning;
    $('#drawAuto').disabled = done || !!d.spinning;
    $('#drawCommit').disabled = !done;

    // 連続して引けるよう、主ボタンにフォーカスを置く
    const focusEl = done ? $('#drawCommit') : $('#spinBtn');
    if (focusEl && !focusEl.disabled && dlgDraw.open) focusEl.focus({ preventScroll: true });

    const newRow = $('.draw-row.is-new', dlgDraw);
    if (newRow && newRow.scrollIntoView) newRow.scrollIntoView({ block: 'nearest' });
  }

  function closeDraw() {
    if (draw && draw.history.length && !confirm('抽選の途中です。ここまでの結果を破棄して閉じますか？')) return;
    stopSpin();
    draw = null;
    dlgDraw.close();
  }

  $('#drawClose').addEventListener('click', closeDraw);
  dlgDraw.addEventListener('cancel', (e) => { e.preventDefault(); closeDraw(); });

  $('#drawUndo').addEventListener('click', () => {
    if (!draw || !draw.history.length) return;
    stopSpin();
    const entry = draw.history.pop();
    draw.assigned.delete(entry);
    draw.last = draw.history.length ? draw.history[draw.history.length - 1] : null;
    renderDraw();
  });

  $('#drawAuto').addEventListener('click', () => {
    if (!draw || drawDone()) return;
    stopSpin();
    const rem = shuffle(drawRemaining());
    rem.forEach((entry) => {
      draw.assigned.set(entry, draw.queue[draw.assigned.size]);
      draw.history.push(entry);
    });
    draw.last = null;
    renderDraw();
  });

  $('#drawCommit').addEventListener('click', () => {
    if (!draw || !drawDone()) return;
    const cat = categoryById(draw.catId);
    const d = draw;
    stopSpin();
    cat.slots = d.pos.map((p) => (p.bye ? null : d.fixed.get(p.entry) || d.assigned.get(p.entry) || null));
    resetResults(cat);
    save();
    draw = null;
    dlgDraw.close();
    refreshCategory(cat.id);
  });

  /* ========== 印刷・書き出し・読み込み ========== */

  function buildPrint() {
    $('#printArea').replaceChildren(...state.categories.map((cat) => {
      const { el, W, H } = renderBracket(cat, buildRounds(cat), { interactive: false });
      const z = Math.min(1, 700 / W, 930 / H); // A4縦に収まる倍率
      el.style.transform = `scale(${z})`;
      return h('section', { class: 'print-page', style: `--cat:${colorOf(cat)}` },
        h('h1', { text: state.title || 'トーナメント表' }),
        h('h2', { text: `${cat.name}（${cat.players.length}名）` }),
        h('div', { class: 'bracket-wrap', style: `width:${Math.ceil(W * z)}px;height:${Math.ceil(H * z)}px` }, el),
      );
    }));
  }

  let printKind = 'brackets'; // 'qr' のときは担当者用QRコードを印刷する
  window.addEventListener('beforeprint', () => { if (printKind === 'qr') buildQrPrint(); else buildPrint(); });
  window.addEventListener('afterprint', () => { printKind = 'brackets'; });
  $('#btnPrint').addEventListener('click', () => { printKind = 'brackets'; buildPrint(); window.print(); });

  const menu = $('#menu');
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });

  $('#btnExport').addEventListener('click', () => {
    menu.open = false;
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safe = (state.title || 'tournament').replace(/[\\/:*?"<>|\s]+/g, '_');
    const a = h('a', { href: url, download: `${safe}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const fileImport = $('#fileImport');
  $('#btnImport').addEventListener('click', () => { menu.open = false; fileImport.click(); });
  fileImport.addEventListener('change', () => {
    const file = fileImport.files && fileImport.files[0];
    fileImport.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || !Array.isArray(data.categories)) throw new Error('format');
        if (!confirm('いま表示している内容を、読み込んだデータで置き換えます。よろしいですか？')) return;
        state = normalize(data);
        state.setupDone = true;
        save();
        initView();
        syncRestart();
      } catch (err) {
        alert('このファイルは読み込めませんでした。このアプリで書き出した .json ファイルを選んでください。');
      }
    };
    reader.readAsText(file);
  });

  $('#btnReset').addEventListener('click', () => {
    menu.open = false;
    if (!confirm('すべてのカテゴリー・参加者・勝敗の記録を消して、最初の状態に戻します（共有中の場合は共有も終了します）。よろしいですか？')) return;
    if (state.share) stopShare();
    state = normalize(null);
    save();
    initView();
    openSetup();
  });

  /* ========== 試合場の割り当て（山） ========== */

  // 山の数として選べる値（1回戦が1試合以上入る範囲）
  function allowedBlocks(n) {
    const size = bracketSize(n);
    return [1, 2, 4, 8].filter((b) => b === 1 || b <= size / 2);
  }

  // 山の数・試合場番号を、人数と試合場数に合う範囲へ整える
  function fixCourts(cat, courtCount) {
    const allowed = allowedBlocks(cat.players.length);
    if (!allowed.includes(cat.blocks)) cat.blocks = allowed.filter((b) => b <= cat.blocks).pop() || 1;
    const fix = (v) => clamp(parseInt(v, 10) || 1, 1, courtCount);
    const old = Array.isArray(cat.courts) ? cat.courts : [];
    cat.courts = Array.from({ length: cat.blocks }, (_, i) => fix(old[i]));
    cat.finalCourt = fix(cat.finalCourt);
  }

  // 山の範囲を「1〜8番」のように表す
  function blockRange(cat, bi) {
    const pos = positionsFor(cat.players.length);
    const per = pos.length / cat.blocks;
    const entries = pos.slice(bi * per, (bi + 1) * per).filter((p) => !p.bye).map((p) => p.entry);
    return entries.length ? `${entries[0]}〜${entries[entries.length - 1]}番` : '';
  }

  // 山を勝ち抜いた後の試合の呼び名
  function finalStageName(cat) {
    const R = Math.round(Math.log2(bracketSize(cat.players.length)));
    const k = Math.round(Math.log2(cat.blocks));
    return k === 1 ? '決勝' : `${roundName(R - k, R)}から決勝`;
  }

  const dlgCourts = $('#dlgCourts');

  function courtSelect(value, label, onChange) {
    const sel = h('select', { class: 'text-input court-select', 'aria-label': label });
    for (let c = 1; c <= state.courtCount; c++) sel.append(h('option', { value: c, text: `第${c}試合場` }));
    sel.value = String(value);
    sel.addEventListener('change', () => onChange(Number(sel.value)));
    return sel;
  }

  function autoAssign() {
    let c = 0;
    state.categories.forEach((cat) => {
      cat.courts = cat.courts.map(() => (c++ % state.courtCount) + 1);
      cat.finalCourt = cat.courts[0];
    });
    save();
    renderCourts();
  }

  function renderCourts() {
    const cards = state.categories.map((cat, ci) => {
      const blocksSel = h('select', { class: 'text-input court-select', 'aria-label': `${cat.name}の山の分け方` });
      allowedBlocks(cat.players.length).forEach((b) => {
        blocksSel.append(h('option', { value: b, text: b === 1 ? '分けない' : `${b}つの山に分ける` }));
      });
      blocksSel.value = String(cat.blocks);
      blocksSel.addEventListener('change', () => {
        cat.blocks = Number(blocksSel.value);
        fixCourts(cat, state.courtCount);
        save();
        renderCourts();
      });

      const rows = cat.courts.map((c, bi) => h('label', { class: 'assign-row' },
        h('span', { class: 'assign-name' },
          cat.blocks === 1 ? 'すべての試合' : `第${bi + 1}山`,
          cat.blocks > 1 ? h('small', { text: blockRange(cat, bi) }) : null),
        courtSelect(c, `${cat.name} 第${bi + 1}山の試合場`, (v) => { cat.courts[bi] = v; save(); }),
      ));
      if (cat.blocks > 1) {
        rows.push(h('label', { class: 'assign-row' },
          h('span', { class: 'assign-name' }, finalStageName(cat), h('small', { text: '山の勝者どうし' })),
          courtSelect(cat.finalCourt, `${cat.name} ${finalStageName(cat)}の試合場`, (v) => { cat.finalCourt = v; save(); }),
        ));
      }

      return h('section', { class: 'assign-card', style: `--cat:${COLORS[ci % COLORS.length]}` },
        h('header', { class: 'assign-head' },
          h('h3', { text: cat.name }),
          h('span', { class: 'assign-count', text: `${cat.players.length}名` }),
          blocksSel),
        h('div', { class: 'assign-grid' }, rows));
    });

    $('#courtsBody').replaceChildren(
      h('p', { class: 'help', text: 'トーナメント表を上から等分したまとまりが「山」です。山ごとに試合場を決めると、その試合場の担当者のスマホには、担当する山の試合だけが表示されます。' }),
      h('div', { class: 'assign-bar' },
        h('span', { text: `試合場は全部で ${state.courtCount} 面` }),
        h('button', { type: 'button', class: 'btn btn-small', text: '上から順番に割り振る', onclick: autoAssign })),
      ...cards,
    );
  }

  function openCourts() {
    renderCourts();
    dlgCourts.showModal();
  }

  dlgCourts.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) dlgCourts.close();
  });
  dlgCourts.addEventListener('close', () => { if (!IS_COURT) renderBoard(); });

  /* ========== 結果の記録（本部・試合場で共通） ========== */

  // 勝者を記録する。同じ側をもう一度指定すると取り消し。
  // 戻り値：変更したら { anim }、何もしなければ false
  function recordResult(cat, r, i, side) {
    const b = buildRounds(cat);
    const m = b.rounds[r] && b.rounds[r][i];
    if (!m || m.bye || !m.sides[0] || !m.sides[1] || !b.drawn) return false;

    // この試合の結果を変えると、その先の試合は対戦相手が変わるので取り消す
    const changes = {};
    let later = 0;
    for (let rr = r + 1, ii = i >> 1; rr < b.R; rr++, ii >>= 1) {
      if (cat.results[`${rr}-${ii}`] != null) { changes[`${rr}-${ii}`] = null; later += 1; }
    }
    if (later && !confirm('この試合の結果を変えると、その先の試合の記録も取り消されます。変更しますか？')) return false;

    const key = `${r}-${i}`;
    let anim = null;
    if (cat.results[key] === side) {
      changes[key] = null;
    } else {
      changes[key] = side;
      anim = { r, i };
    }

    const t = Date.now();
    const body = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v == null) {
        delete cat.results[k];
        delete cat.meta[k];
        body[k] = null;
      } else {
        cat.results[k] = v;
        cat.meta[k] = { by: courtNo, t };
        body[k] = { w: v, by: courtNo, t, d: cat.drawId };
      }
    }
    save();
    syncEnqueue({ catId: cat.id, d: cat.drawId, body });
    return { anim };
  }

  // 組み合わせが変わったとき：勝敗をすべて消し、古い結果が届いても無視できるようにする
  function resetResults(cat) {
    cat.results = {};
    cat.meta = {};
    cat.drawId = uid();
    syncEnqueue({ catId: cat.id, clear: true });
  }

  /* ========== 共有（Firebase Realtime Database の REST API） ==========
     保存場所： <データベースURL>/rooms/<合言葉>/
       struct  … 大会の構成（本部だけが書く。JSON文字列）
       results … <カテゴリーID>/<回戦-試合> = { w: 勝者の側, by: 試合場, t: 時刻, d: 組み合わせID }
     受信は EventSource（サーバーからの通知）、送信は fetch で行います。 */

  const sync = {
    cfg: null,        // { db, room }
    es: null,
    status: 'off',    // off / connecting / live / offline / error
    mirror: {},       // サーバー上のデータの写し
    queue: [],        // まだ送れていない結果
    busy: false,
    again: false,
    fail: 0,
    retry: null,
    reconnect: null,
    touch: null,
    lastStruct: null,
    lastEvent: 0,
    ended: false,
  };

  const roomUrl = (path = '') => `${sync.cfg.db}/rooms/${sync.cfg.room}${path}.json`;
  const queueKey = () => `tournament-queue-${sync.cfg.room}-${IS_COURT ? 'court' : 'hq'}`;
  const cacheKey = () => `tournament-court-${sync.cfg.room}`;

  function randomKey(len) {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32文字
    const buf = new Uint8Array(len);
    window.crypto.getRandomValues(buf);
    return Array.from(buf, (v) => chars[v % chars.length]).join('');
  }

  function loadQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(queueKey()) || '[]');
      return Array.isArray(q) ? q : [];
    } catch (e) {
      return [];
    }
  }

  function persistQueue() {
    try {
      localStorage.setItem(queueKey(), JSON.stringify(sync.queue));
    } catch (e) { /* 保存できなくても送信は続ける */ }
  }

  // 担当者へ配る「大会の構成」（勝敗は含めない）
  function structJSON() {
    return JSON.stringify({
      v: 1,
      title: state.title,
      courtCount: state.courtCount,
      categories: state.categories.map((c) => ({
        id: c.id, name: c.name, players: c.players, slots: c.slots,
        blocks: c.blocks, courts: c.courts, finalCourt: c.finalCourt, drawId: c.drawId,
      })),
    });
  }

  function localResultsForRemote() {
    const out = {};
    state.categories.forEach((cat) => {
      const o = {};
      for (const [k, w] of Object.entries(cat.results)) {
        const mt = cat.meta[k] || { by: 0, t: 0 };
        o[k] = { w, by: mt.by, t: mt.t, d: cat.drawId };
      }
      if (Object.keys(o).length) out[cat.id] = o;
    });
    return out;
  }

  async function dbFetch(path, method, body) {
    const res = await fetch(roomUrl(path), {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  function syncLabel() {
    const n = sync.queue.length;
    switch (sync.status) {
      case 'off': return { kind: 'off', text: '共有' };
      case 'connecting': return { kind: 'wait', text: '接続中…' };
      case 'live': return n ? { kind: 'wait', text: `送信中 ${n}件` } : { kind: 'live', text: IS_COURT ? '本部とつながっています' : '共有中' };
      case 'error': return { kind: 'error', text: '共有エラー' };
      default: return { kind: 'warn', text: n ? `電波待ち（未送信 ${n}件）` : '再接続中…' };
    }
  }

  function renderSyncStatus() {
    const s = syncLabel();
    const btn = $('#btnShare');
    if (btn) {
      btn.dataset.sync = s.kind;
      $('#btnShareText').textContent = s.text;
    }
    const chip = $('#cSync');
    if (chip) {
      chip.dataset.sync = s.kind;
      chip.textContent = s.text;
    }
    const line = $('#shareStatus');
    if (line) {
      line.dataset.sync = s.kind;
      line.textContent = s.kind === 'live' ? '共有中です。担当者のスマホから結果が届きます。' : s.text;
    }
  }

  function setSyncStatus(status) {
    sync.status = status;
    renderSyncStatus();
  }

  // 本部で内容が変わったら、少し待ってからまとめて送る
  function syncTouch() {
    if (!sync.cfg || IS_COURT) return;
    clearTimeout(sync.touch);
    sync.touch = setTimeout(flush, 400);
  }

  function syncEnqueue(item) {
    if (!sync.cfg) return;
    sync.queue.push(item);
    persistQueue();
    renderSyncStatus();
    flush();
  }

  // 未送信分を順番に送る。失敗したら間隔をあけて自動でやり直す。
  async function flush() {
    if (!sync.cfg) return;
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true;
    clearTimeout(sync.retry);
    const cfg = sync.cfg;
    try {
      if (!IS_COURT) {
        const s = structJSON();
        if (s !== sync.lastStruct) {
          await dbFetch('/struct', 'PUT', s);
          sync.lastStruct = s;
        }
      }
      while (sync.cfg === cfg && sync.queue.length) {
        const q = sync.queue[0];
        const cat = categoryById(q.catId);
        if (q.clear) await dbFetch(`/results/${q.catId}`, 'PUT', null);
        else if (cat && cat.drawId === q.d) await dbFetch(`/results/${q.catId}`, 'PATCH', q.body);
        sync.queue.shift();
        persistQueue();
      }
      sync.fail = 0;
      if (sync.status === 'error') setSyncStatus('live');
    } catch (err) {
      sync.fail += 1;
      if (err.status === 401 || err.status === 403) setSyncStatus('error');
      sync.retry = setTimeout(flush, Math.min(15000, 2000 * sync.fail));
    } finally {
      sync.busy = false;
      renderSyncStatus();
      if (sync.again) {
        sync.again = false;
        flush();
      }
    }
  }

  // 通知の内容を、写し（mirror）へ反映する
  function setAt(root, path, val) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return val && typeof val === 'object' ? val : {};
    let o = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (val == null) delete o[last];
    else o[last] = val;
    return root;
  }

  // 写しの内容を画面用のデータへ取り込む。戻り値：変化したカテゴリー
  function ingest() {
    const mirror = sync.mirror;

    if (IS_COURT && typeof mirror.struct === 'string' && mirror.struct !== sync.lastStruct) {
      try {
        state = normalize(Object.assign(JSON.parse(mirror.struct), { setupDone: true }), true);
        sync.lastStruct = mirror.struct;
      } catch (e) { /* 壊れたデータは使わない */ }
    }

    const remote = mirror.results && typeof mirror.results === 'object' ? mirror.results : {};
    const changed = [];
    state.categories.forEach((cat) => {
      const next = {};
      const meta = {};
      const src = remote[cat.id];
      if (src && typeof src === 'object') {
        for (const [k, v] of Object.entries(src)) {
          if (v && typeof v === 'object' && v.d === cat.drawId && (v.w === 0 || v.w === 1) && /^\d+-\d+$/.test(k)) {
            next[k] = v.w;
            meta[k] = { by: parseInt(v.by, 10) || 0, t: Number(v.t) || 0 };
          }
        }
      }
      // まだ送れていない自分の入力を上に重ねる
      sync.queue.forEach((q) => {
        if (q.catId !== cat.id) return;
        if (q.clear) {
          Object.keys(next).forEach((k) => { delete next[k]; delete meta[k]; });
          return;
        }
        if (q.d !== cat.drawId) return;
        for (const [k, v] of Object.entries(q.body)) {
          if (v == null) { delete next[k]; delete meta[k]; }
          else { next[k] = v.w; meta[k] = { by: v.by, t: v.t }; }
        }
      });

      const keys = new Set([...Object.keys(next), ...Object.keys(cat.results)]);
      const diff = [...keys].filter((k) => next[k] !== cat.results[k]);
      cat.meta = meta;
      if (diff.length) {
        const added = diff.filter((k) => next[k] != null);
        cat.results = next;
        let anim = null;
        if (added.length === 1) {
          const [r, i] = added[0].split('-').map(Number);
          anim = { r, i };
        }
        changed.push({ cat, anim });
      }
    });
    return changed;
  }

  function onStream(e, isPatch) {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (!msg || typeof msg.path !== 'string') return;
    sync.lastEvent = Date.now();

    // 部屋ごと消えた場合
    if (!isPatch && msg.path === '/' && msg.data == null) {
      sync.mirror = {};
      if (IS_COURT) {
        sync.ended = true;
        setSyncStatus('live');
        renderCourt();
      } else {
        republishAll(); // 本部の手元の内容で作り直す
      }
      return;
    }

    if (isPatch) {
      if (msg.data && typeof msg.data === 'object') {
        for (const [k, v] of Object.entries(msg.data)) sync.mirror = setAt(sync.mirror, `${msg.path}/${k}`, v);
      }
    } else {
      sync.mirror = setAt(sync.mirror, msg.path, msg.data);
    }
    sync.ended = false;
    setSyncStatus('live');

    const changed = ingest();
    if (IS_COURT) {
      try { localStorage.setItem(cacheKey(), JSON.stringify(sync.mirror)); } catch (err) { /* なくても動く */ }
      renderCourt();
    } else if (changed.length) {
      save();
      changed.forEach(({ cat, anim }) => refreshCategory(cat.id, anim));
    }
  }

  function connect() {
    if (!sync.cfg) return;
    clearTimeout(sync.reconnect);
    if (sync.es) sync.es.close();
    sync.lastEvent = Date.now();
    setSyncStatus('connecting');
    let es;
    try {
      es = new EventSource(roomUrl());
    } catch (err) {
      setSyncStatus('error');
      return;
    }
    sync.es = es;
    es.onopen = () => { sync.lastEvent = Date.now(); flush(); };
    es.addEventListener('put', (e) => onStream(e, false));
    es.addEventListener('patch', (e) => onStream(e, true));
    es.addEventListener('keep-alive', () => { sync.lastEvent = Date.now(); });
    const denied = () => { if (sync.es === es) setSyncStatus('error'); };
    es.addEventListener('cancel', denied);
    es.addEventListener('auth_revoked', denied);
    es.onerror = () => {
      if (sync.es !== es) return;
      setSyncStatus('offline');
      if (es.readyState === 2) { // ブラウザが自動で再接続しない切れ方
        clearTimeout(sync.reconnect);
        sync.reconnect = setTimeout(connect, 5000);
      }
    };
  }

  function needsReconnect() {
    return !sync.es || sync.es.readyState === 2 || Date.now() - sync.lastEvent > 80000;
  }

  // スマホは画面を消すと接続が切れるので、戻ってきたら確かめ直す
  setInterval(() => {
    if (!sync.cfg || sync.ended || document.hidden) return;
    if (needsReconnect()) connect();
    if (sync.queue.length) flush();
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !sync.cfg) return;
    if (needsReconnect()) connect();
    flush();
  });
  window.addEventListener('online', () => { if (sync.cfg) { connect(); flush(); } });
  window.addEventListener('offline', () => { if (sync.cfg) setSyncStatus('offline'); });

  async function republishAll() {
    try {
      const s = structJSON();
      await dbFetch('', 'PUT', { v: 1, created: Date.now(), struct: s, results: localResultsForRemote() });
      sync.lastStruct = s;
    } catch (err) {
      if (err.status === 401 || err.status === 403) setSyncStatus('error');
    }
  }

  // 本部：共有をはじめる
  async function startShare(dbInput) {
    const db = cleanDb(dbInput);
    if (!validDb(db)) {
      const err = new Error('url');
      err.kind = 'url';
      throw err;
    }
    sync.cfg = { db, room: randomKey(24) };
    try {
      const s = structJSON();
      await dbFetch('', 'PUT', { v: 1, created: Date.now(), struct: s, results: localResultsForRemote() });
      sync.lastStruct = s;
    } catch (err) {
      sync.cfg = null;
      throw err;
    }
    sync.queue = [];
    sync.mirror = {};
    state.share = { db: sync.cfg.db, room: sync.cfg.room };
    save();
    connect();
  }

  // 本部：共有をやめて、サーバー上のデータを消す
  function stopShare() {
    if (sync.cfg) {
      fetch(roomUrl(), { method: 'DELETE' }).catch(() => {});
      try { localStorage.removeItem(queueKey()); } catch (e) { /* なくてもよい */ }
    }
    state.share = null;
    save();
    syncRestart();
  }

  // 保存されている共有設定に合わせて、接続をやり直す（本部用）
  function syncRestart() {
    clearTimeout(sync.retry);
    clearTimeout(sync.reconnect);
    clearTimeout(sync.touch);
    if (sync.es) sync.es.close();
    sync.es = null;
    sync.mirror = {};
    sync.lastStruct = null;
    sync.fail = 0;
    sync.cfg = state.share ? { db: state.share.db, room: state.share.room } : null;
    sync.queue = sync.cfg ? loadQueue() : [];
    if (sync.cfg) connect();
    else setSyncStatus('off');
  }

  /* ========== 本部：試合場の進行状況 ========== */

  function timeText(t) {
    return t ? new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
  }

  function renderDash() {
    const per = Array.from({ length: state.courtCount }, () => ({ total: 0, done: 0, next: '', last: 0, labels: [] }));
    const feed = [];

    state.categories.forEach((cat) => {
      const b = buildRounds(cat);
      const info = playerInfo(cat);
      cat.courts.forEach((c, bi) => {
        if (per[c - 1]) per[c - 1].labels.push(cat.blocks > 1 ? `${cat.name} 第${bi + 1}山` : cat.name);
      });
      if (cat.blocks > 1 && per[cat.finalCourt - 1]) {
        per[cat.finalCourt - 1].labels.push(`${cat.name} ${finalStageName(cat)}`);
      }
      b.rounds.forEach((arr) => arr.forEach((m) => {
        if (m.bye) return;
        const p = per[m.court - 1];
        if (!p) return;
        p.total += 1;
        if (m.winner) {
          p.done += 1;
          const mt = cat.meta[`${m.r}-${m.i}`] || { by: 0, t: 0 };
          p.last = Math.max(p.last, mt.t);
          feed.push({
            t: mt.t, by: mt.by,
            text: `${cat.name} 第${m.no}試合`,
            win: info.get(m.winner).name,
            lose: info.get(m.sides[1 - m.side]).name,
          });
        } else if (b.drawn && m.sides[0] && m.sides[1] && !p.next) {
          p.next = `${cat.name} 第${m.no}試合　${info.get(m.sides[0]).name} 対 ${info.get(m.sides[1]).name}`;
        }
      }));
    });
    feed.sort((a, b) => b.t - a.t);

    const rows = per.map((p, i) => {
      const finished = p.total > 0 && p.done === p.total;
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      let next = '';
      if (finished) next = 'すべて終了';
      else if (p.next) next = `次：${p.next}`;
      else if (p.total) next = '次の試合は、抽選または前の試合の結果待ち';
      return h('li', { class: 'dash-row' + (finished ? ' is-finished' : '') },
        h('span', { class: 'dash-no', text: i + 1 }),
        h('div', { class: 'dash-main' },
          h('p', { class: 'dash-labels', text: p.labels.length ? p.labels.join('、') : '割り当てなし' }),
          h('p', { class: 'dash-next', text: next })),
        h('div', { class: 'dash-prog' },
          h('span', { class: 'dash-count', text: `${p.done} / ${p.total}` }),
          h('span', { class: 'dash-bar' }, h('i', { style: `width:${pct}%` })),
          h('span', { class: 'dash-time', text: p.last ? `${timeText(p.last)} 更新` : '' })));
    });

    return h('div', { class: 'dash' },
      state.share ? null : h('p', { class: 'dash-note' },
        '共有がまだ始まっていません。担当者のスマホから結果を受け取るには、共有を設定してください。',
        h('button', { type: 'button', class: 'btn btn-small', text: '共有を設定する', onclick: openShare })),
      h('ol', { class: 'dash-list' }, rows),
      h('h3', { class: 'dash-h', text: '届いた結果（新しい順）' }),
      feed.length
        ? h('ol', { class: 'feed' }, feed.slice(0, 40).map((f) => h('li', { class: 'feed-row' },
          h('span', { class: 'feed-time', text: timeText(f.t) || '—' }),
          h('span', { class: 'feed-by', text: f.by ? `試合場${f.by}` : '本部' }),
          h('span', { class: 'feed-text' }, `${f.text}　`, h('b', { text: `○ ${f.win}` }), `（対 ${f.lose}）`))))
        : h('p', { class: 'help', text: 'まだ結果はありません。' }),
    );
  }

  /* ========== 本部：共有の設定とQRコード ========== */

  const dlgShare = $('#dlgShare');
  let shareCourt = 1;

  const RULES_TEXT = [
    '{',
    '  "rules": {',
    '    "rooms": {',
    '      "$room": {',
    '        ".read": true,',
    '        ".write": true',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');

  function courtLink(n) {
    const base = location.href.split('#')[0];
    return `${base}#db=${encodeURIComponent(state.share.db)}&room=${state.share.room}&court=${n}`;
  }

  // QRコードをSVGで描く（qrcode-generator を使用）
  function qrSvg(text, px) {
    if (typeof qrcode !== 'function') return null;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 4;
      const size = n + quiet * 2;
      let d = '';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
        }
      }
      const svg = svgEl('svg', {
        class: 'qr', viewBox: `0 0 ${size} ${size}`, width: px, height: px,
        role: 'img', 'aria-label': 'QRコード', 'shape-rendering': 'crispEdges',
      });
      svg.append(svgEl('rect', { width: size, height: size, fill: '#fff' }), svgEl('path', { d, fill: '#000' }));
      return svg;
    } catch (e) {
      return null;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function shareErrorText(err) {
    if (err.kind === 'url') return 'URLの形が違います。Firebaseの「Realtime Database」の画面に表示される、https:// で始まり firebaseio.com または firebasedatabase.app で終わるURLを貼り付けてください。';
    if (err.status === 401 || err.status === 403) return '書き込みが許可されませんでした。手順3の「ルール」が公開されているか確認してください。';
    if (err.status === 404) return 'データベースが見つかりません。URLを確認してください。';
    return '接続できませんでした。URLとインターネット接続を確認してください。';
  }

  function renderShare() {
    const body = $('#shareBody');

    // --- まだ共有していないとき ---
    if (!state.share) {
      const input = h('input', {
        type: 'url', class: 'text-input', id: 'shareDb', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'https://〜.firebaseio.com',
      });
      const error = h('p', { class: 'share-error', role: 'alert' });
      const start = h('button', { type: 'button', class: 'btn btn-primary', text: '共有をはじめる' });
      start.addEventListener('click', async () => {
        error.textContent = '';
        start.disabled = true;
        start.textContent = '接続を確認しています…';
        try {
          await startShare(input.value);
          renderShare();
          renderBoard();
        } catch (err) {
          error.textContent = shareErrorText(err);
          start.disabled = false;
          start.textContent = '共有をはじめる';
        }
      });
      const copyRules = h('button', { type: 'button', class: 'btn btn-small', text: 'ルールをコピー' });
      copyRules.addEventListener('click', async () => {
        copyRules.textContent = (await copyText(RULES_TEXT)) ? 'コピーしました' : 'コピーできませんでした';
      });

      body.replaceChildren(
        h('p', { class: 'share-lead', text: '各試合場の担当者がスマホで入力した結果を、この画面へすぐに反映します。データの受け渡しには、Googleの無料サービス「Firebase」のデータベースを使います。最初に1回だけ、次の準備をしてください。' }),
        h('ol', { class: 'steps' },
          h('li', null, 'Firebaseコンソール（console.firebase.google.com）にGoogleアカウントでログインし、プロジェクトを作成する。'),
          h('li', null, 'メニューから「Realtime Database」を開き、「データベースを作成」を押す（ロックモードのままでよい）。'),
          h('li', null, '「ルール」タブの内容を、次の文に置き換えて「公開」を押す。',
            h('pre', { class: 'rules', text: RULES_TEXT }), copyRules),
          h('li', null, '「データ」タブの上に表示される https:// で始まるURLをコピーして、下の欄に貼り付ける。')),
        h('div', { class: 'field' }, h('label', { for: 'shareDb', text: 'データベースのURL' }), input),
        h('p', { class: 'share-caution', text: '共有をはじめると、大会名・カテゴリー名・選手名・勝敗がこのデータベースに保存され、担当者用のリンクを知っている人は読み書きできます。大会が終わったら「共有を終了する」でデータを消してください。' }),
        error,
        h('div', { class: 'share-actions' }, start),
      );
      return;
    }

    // --- 共有中 ---
    shareCourt = clamp(shareCourt, 1, state.courtCount);
    const link = courtLink(shareCourt);
    const sel = courtSelect(shareCourt, 'QRコードを表示する試合場', (v) => { shareCourt = v; renderShare(); });
    const linkBox = h('input', { type: 'text', class: 'text-input share-link', value: link, readonly: true, 'aria-label': '担当者用リンク' });
    linkBox.addEventListener('focus', () => linkBox.select());
    const copy = h('button', { type: 'button', class: 'btn', text: 'リンクをコピー' });
    copy.addEventListener('click', async () => {
      copy.textContent = (await copyText(link)) ? 'コピーしました' : 'コピーできませんでした';
    });

    body.replaceChildren(
      h('p', { class: 'sync-chip share-status', id: 'shareStatus' }),
      location.protocol === 'file:'
        ? h('p', { class: 'share-caution', text: 'いまはパソコン内のファイルとして開いています。スマホから開けるリンクにするには、GitHub Pagesに公開したページでこの画面を開いてください。' })
        : null,
      h('div', { class: 'share-qr' },
        h('div', { class: 'share-qr-code' }, qrSvg(link, 220) || h('p', { class: 'help', text: 'QRコードを作れませんでした。下のリンクを送ってください。' })),
        h('div', { class: 'share-qr-side' },
          h('label', { class: 'field-label', text: '担当者に渡す試合場' }),
          sel,
          h('p', { class: 'help', text: '担当者がスマホのカメラでQRコードを読み取ると、その試合場の入力画面が開きます。アプリのインストールやログインは不要です。' }),
          h('button', {
            type: 'button', class: 'btn', text: `全${state.courtCount}試合場のQRコードを印刷`,
            onclick: () => { printKind = 'qr'; buildQrPrint(); window.print(); },
          }))),
      h('div', { class: 'share-linkrow' }, linkBox, copy),
      h('div', { class: 'share-actions is-end' },
        h('button', {
          type: 'button', class: 'btn btn-quiet is-danger', text: '共有を終了する（保存先のデータを消す）',
          onclick: () => {
            if (!confirm('共有を終了し、データベース上の大会データを消します。この画面の記録は残ります。担当者のスマホからは入力できなくなります。よろしいですか？')) return;
            stopShare();
            renderShare();
            renderBoard();
          },
        })),
    );
    renderSyncStatus();
  }

  function openShare() {
    renderShare();
    if (!dlgShare.open) dlgShare.showModal();
  }

  dlgShare.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) dlgShare.close();
  });

  function buildQrPrint() {
    if (!state.share) return;
    const cards = [];
    for (let n = 1; n <= state.courtCount; n++) {
      cards.push(h('section', { class: 'qr-card' },
        h('p', { class: 'qr-title', text: state.title || 'トーナメント' }),
        h('h2', { text: `第${n}試合場　結果入力` }),
        qrSvg(courtLink(n), 230) || h('p', { class: 'qr-url', text: courtLink(n) }),
        h('p', { class: 'qr-note', text: 'スマホのカメラで読み取ってください' })));
    }
    $('#printArea').replaceChildren(h('div', { class: 'qr-sheet' }, cards));
  }

  /* ========== 試合場の担当者用画面（スマホ） ========== */

  const courtUi = { tab: 'matches', pick: null, viewCat: null, zoom: 0.75, doneOpen: false };
  let toastTimer = null;

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function courtEmpty(title, text) {
    return h('div', { class: 'c-empty' }, h('h2', { text: title }), h('p', { text }));
  }

  function startCourt() {
    document.body.classList.add('is-court');
    $('.topbar').hidden = true;
    board.hidden = true;
    const app = $('#courtApp');
    app.hidden = false;

    if (!JOIN.ok) {
      app.replaceChildren(courtEmpty('リンクが正しくありません', '本部で表示されたQRコードを、もう一度読み取ってください。'));
      return;
    }

    sync.cfg = { db: JOIN.db, room: JOIN.room };
    sync.queue = loadQueue();
    try { // 前回受け取った内容があれば、接続を待たずに表示する
      const cached = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
      if (cached && typeof cached === 'object') sync.mirror = cached;
    } catch (e) { /* なくても動く */ }
    ingest();
    renderCourt();
    connect();
  }

  function sendPick(cat, m, side) {
    courtUi.pick = null;
    const res = recordResult(cat, m.r, m.i, side);
    renderCourt();
    if (res) toast(sync.status === 'live' && navigator.onLine !== false ? '本部へ送信しました' : '電波が戻りしだい、自動で送信します');
  }

  function undoResult(cat, m) {
    if (!confirm(`第${m.no}試合の結果を取り消しますか？`)) return;
    const res = recordResult(cat, m.r, m.i, m.side);
    renderCourt();
    if (res) toast('結果を取り消しました');
  }

  function matchCard(x, kind) {
    const { cat, b, m, info } = x;
    const key = `${m.r}-${m.i}`;
    const pick = courtUi.pick;
    const picked = pick && pick.catId === cat.id && pick.key === key ? pick.side : null;

    const sideEl = (side) => {
      const pid = m.sides[side];
      let name = '未定';
      let no = '';
      if (pid) {
        name = info.get(pid).name;
        no = b.entryOf.get(pid) || '';
      } else if (m.r > 0) {
        const prev = b.rounds[m.r - 1][2 * m.i + side];
        if (prev && prev.no) name = `第${prev.no}試合の勝者`;
      }
      const cls = ['mc-side'];
      if (!pid) cls.push('is-empty');
      if (kind === 'done') cls.push(m.side === side ? 'is-winner' : 'is-loser');
      if (picked === side) cls.push('is-picked');
      const kids = [
        h('span', { class: 'mc-no', text: no }),
        h('span', { class: 'mc-name', text: name }),
        kind === 'done' && m.side === side ? h('span', { class: 'mc-mark', text: '○ 勝ち' }) : null,
      ];
      if (kind !== 'ready') return h('div', { class: cls.join(' ') }, kids);
      return h('button', {
        type: 'button',
        class: cls.join(' '),
        'aria-pressed': String(picked === side),
        onclick: () => { courtUi.pick = { catId: cat.id, key, side }; renderCourt(); },
      }, kids);
    };

    const card = h('article', { class: `mc is-${kind}`, style: `--cat:${colorOf(cat)}` },
      h('header', { class: 'mc-head' },
        h('span', { class: 'mc-cat', text: cat.name }),
        h('span', { class: 'mc-round', text: `${roundName(m.r, b.R)}　第${m.no}試合` })),
      sideEl(0),
      sideEl(1));

    if (kind === 'ready' && picked == null) {
      card.append(h('p', { class: 'mc-hint', text: '勝った方をタップ' }));
    }
    if (kind === 'ready' && picked != null) {
      card.append(h('div', { class: 'mc-confirm' },
        h('p', { text: `${info.get(m.sides[picked]).name} の勝ち` }),
        h('button', { type: 'button', class: 'btn btn-accent btn-big', text: '本部へ送信する', onclick: () => sendPick(cat, m, picked) }),
        h('button', { type: 'button', class: 'btn btn-quiet', text: '選び直す', onclick: () => { courtUi.pick = null; renderCourt(); } })));
    }
    if (kind === 'done') {
      const mt = cat.meta[key];
      card.append(h('div', { class: 'mc-foot' },
        h('span', { text: mt && mt.t ? `${timeText(mt.t)} 入力` : '' }),
        h('button', { type: 'button', class: 'btn btn-small', text: '結果を取り消す', onclick: () => undoResult(cat, m) })));
    }
    return card;
  }

  function courtMatches() {
    const ready = [];
    const waiting = [];
    const done = [];
    const undrawn = [];

    state.categories.forEach((cat) => {
      const b = buildRounds(cat);
      const mine = [];
      b.rounds.forEach((arr) => arr.forEach((m) => { if (!m.bye && m.court === courtNo) mine.push(m); }));
      if (!mine.length) return;
      if (!b.drawn) { undrawn.push(cat); return; }
      const info = playerInfo(cat);
      mine.forEach((m) => {
        const x = { cat, b, m, info };
        if (m.winner) done.push(x);
        else if (m.sides[0] && m.sides[1]) ready.push(x);
        else waiting.push(x);
      });
    });

    if (!ready.length && !waiting.length && !done.length && !undrawn.length) {
      return courtEmpty('この試合場に割り当てられた試合はありません', '上のメニューで、担当する試合場を確かめてください。');
    }

    const timeOf = (x) => (x.cat.meta[`${x.m.r}-${x.m.i}`] || { t: 0 }).t;
    done.sort((a, b) => timeOf(b) - timeOf(a));

    const secTitle = (text, n) => h('h2', { class: 'c-sec' }, text, h('span', { text: `${n}試合` }));
    const out = [secTitle('いま入力できる試合', ready.length)];
    if (ready.length) {
      ready.forEach((x) => out.push(matchCard(x, 'ready')));
    } else {
      let text = 'この試合場の試合は、すべて終了しました。';
      if (waiting.length) text = '前の試合の結果が入ると、ここに表示されます。';
      else if (undrawn.length) text = '抽選が終わると、ここに表示されます。';
      out.push(h('p', { class: 'c-none', text }));
    }
    undrawn.forEach((cat) => out.push(h('p', { class: 'c-none', text: `「${cat.name}」は抽選待ちです。` })));

    if (waiting.length) {
      out.push(secTitle('対戦相手が決まっていない試合', waiting.length));
      waiting.forEach((x) => out.push(matchCard(x, 'waiting')));
    }
    if (done.length) {
      const det = h('details', { class: 'c-done', open: courtUi.doneOpen },
        h('summary', null, '終了した試合', h('span', { text: `${done.length}試合` })),
        done.map((x) => matchCard(x, 'done')));
      det.addEventListener('toggle', () => { courtUi.doneOpen = det.open; });
      out.push(det);
    }
    return out;
  }

  function courtBracket() {
    const hasMine = (c) => buildRounds(c).rounds.some((arr) => arr.some((m) => !m.bye && m.court === courtNo));
    let cat = categoryById(courtUi.viewCat);
    if (!cat) {
      cat = state.categories.find(hasMine) || state.categories[0];
      courtUi.viewCat = cat.id;
    }
    const sel = h('select', { class: 'text-input', 'aria-label': '表示するカテゴリー' },
      state.categories.map((c) => h('option', { value: c.id, text: c.name })));
    sel.value = cat.id;
    sel.addEventListener('change', () => { courtUi.viewCat = sel.value; renderCourt(); });

    const { el, W, H } = renderBracket(cat, buildRounds(cat), { interactive: false, court: courtNo });
    const z = courtUi.zoom;
    el.style.transform = `scale(${z})`;
    const zoomTo = (v) => { courtUi.zoom = clamp(Math.round(v * 100) / 100, 0.3, 1.4); renderCourt(); };

    return [
      h('div', { class: 'c-bar' },
        sel,
        h('div', { class: 'zoom', role: 'group', 'aria-label': '表示の大きさ' },
          h('button', { type: 'button', 'aria-label': '縮小', text: '−', onclick: () => zoomTo(z / 1.2) }),
          h('button', { type: 'button', 'aria-label': '拡大', text: '＋', onclick: () => zoomTo(z * 1.2) }))),
      h('p', { class: 'c-none', text: '太い枠が、この試合場で行う試合です。結果の入力は「試合の結果入力」で行います。' }),
      h('div', { class: 'c-bracket' },
        h('div', {
          class: 'bracket-wrap',
          style: `width:${Math.ceil(W * z)}px;height:${Math.ceil(H * z)}px;--cat:${colorOf(cat)}`,
        }, el)),
    ];
  }

  function renderCourt() {
    const app = $('#courtApp');
    document.title = `第${courtNo}試合場｜${state.title || 'トーナメント表'}`;

    const sel = h('select', { class: 'c-court', 'aria-label': '担当する試合場' });
    for (let c = 1; c <= Math.max(state.courtCount, courtNo); c++) sel.append(h('option', { value: c, text: `第${c}試合場` }));
    sel.value = String(courtNo);
    sel.addEventListener('change', () => {
      courtNo = Number(sel.value);
      courtUi.pick = null;
      courtUi.viewCat = null;
      try {
        history.replaceState(null, '', `#db=${encodeURIComponent(sync.cfg.db)}&room=${sync.cfg.room}&court=${courtNo}`);
      } catch (e) { /* 書き換えられなくても動く */ }
      renderCourt();
    });

    const tabBtn = (id, text) => h('button', {
      type: 'button',
      'aria-pressed': String(courtUi.tab === id),
      text,
      onclick: () => { courtUi.tab = id; renderCourt(); },
    });

    let content;
    if (sync.ended) {
      content = courtEmpty('共有が終了しています', '本部に確認してください。');
    } else if (!state.categories.length) {
      content = courtEmpty('本部のデータを待っています', 'つながると自動で表示されます。しばらく変わらないときは、電波の状態を確かめてください。');
    } else {
      content = courtUi.tab === 'bracket' ? courtBracket() : courtMatches();
    }

    const old = $('.c-body', app);
    const top = old ? old.scrollTop : 0;
    const left = old ? old.scrollLeft : 0;
    const bodyEl = h('div', { class: 'c-body' }, content);
    app.replaceChildren(
      h('header', { class: 'c-head' },
        h('p', { class: 'c-title', text: state.title || 'トーナメント' }),
        h('div', { class: 'c-row' }, sel, h('span', { class: 'sync-chip', id: 'cSync' })),
        h('div', { class: 'c-tabs', role: 'group', 'aria-label': '表示の切り替え' },
          tabBtn('matches', '試合の結果入力'),
          tabBtn('bracket', 'トーナメント表'))),
      bodyEl,
    );
    bodyEl.scrollTop = top;
    bodyEl.scrollLeft = left;
    renderSyncStatus();
  }

  /* ========== 起動 ========== */

  titleInput.addEventListener('input', () => applyTitle(titleInput.value, titleInput));
  $('#btnSetup').addEventListener('click', openSetup);
  $('#btnShare').addEventListener('click', openShare);

  function initView() {
    titleInput.value = state.title;
    applyTitle(state.title, titleInput);
    renderLayoutSwitch();
    renderBoard();
  }

  if (IS_COURT) {
    startCourt();
  } else {
    initView();
    syncRestart();
    if (!state.setupDone) openSetup();
  }
})();


/* =========================================================
   ここから下は、QRコードを作るための外部ライブラリです（編集不要）。
   QR Code Generator for JavaScript  v2.0.4
   Copyright (c) 2009 Kazuhiko Arase   http://www.d-project.com/
   Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
   The word 'QR Code' is registered trademark of DENSO WAVE INCORPORATED
   ========================================================= */
var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=M(t);break;case"Alphanumeric":e=x(t);break;case"Byte":e=m(t);break;case"Kanji":e=L(t);break;default:throw"mode:"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+","+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<f.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=f.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},f.createSvgTag=function(t,r,e,n){var o={};"object"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l="";for(c="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",l+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',l+=o.scalable?"":' width="'+g+'px" height="'+g+'px"',l+=' viewBox="0 0 '+g+" "+g+'" ',l+=' preserveAspectRatio="xMinYMin meet"',l+=n.text||e.text?' role="img" aria-labelledby="'+y([n.id,e.id].join(" ").trim())+'"':"",l+=">",l+=n.text?'<title id="'+y(n.id)+'">'+y(n.text)+"</title>":"",l+=e.text?'<description id="'+y(e.id)+'">'+y(e.text)+"</description>":"",l+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',l+='<path d="',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+="M"+(i*t+r)+","+u+c);return l+='" stroke="transparent" fill="black"/>',l+="</svg>"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1})},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=f.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=y(e),o+='"'),o+="/>"};var y=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={"██":"█","█ ":"▀"," █":"▄","  ":" "},l={"██":"▀","█ ":"▀"," █":" ","  ":" "},h="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",h+=t<1&&r+1>=c?l[i]:g[i];h+="\n"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join("▀"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join("██"),l=Array(t+1).join("  "),h="",s="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s="",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+"\n"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?"black":"white",t.fillRect(o*r,n*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw"eof";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+" != "+r;return i}(),n="?".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];"number"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw"mode:"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw"glog("+t+")";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+"/"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw"bad rs block @ typeNumber:"+e+"/errorCorrectionLevel:"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw"sjis not supported.";!function(){var t=n("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r="";r+="[";for(var e=0;e<t.length;e+=1)e>0&&(r+=","),r+=t[e];return r+="]"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw"unexpected end of file./"+o}var t=r.charAt(e);if(e+=1,"="==t)return o=0,-1;t.match(/^\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString("GIF87a"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(";")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw"length over";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw"dup key:"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n="",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+="="},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return t}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){"function"==typeof define&&define.amd?define([],t):"object"==typeof exports&&(module.exports=t())}(function(){return qrcode});
