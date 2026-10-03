/* =========================================================
   トーナメント表  script.js
   - カテゴリーごとのトーナメント表（シード対応）
   - ルーレット／くじ引き／手動で組み合わせを決定
   - 勝者をタップして勝ち上がりを記録
   - 画面分割で複数カテゴリーを同時進行
   データはブラウザ（localStorage）に自動保存されます。
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

  // 保存データ・読み込みデータを安全な形に整える
  function normalize(src) {
    const out = { title: '', layout: '2c', panes: [], categories: [], setupDone: false };
    const srcPanes = src && Array.isArray(src.panes) ? src.panes : [];

    if (src && typeof src === 'object') {
      if (typeof src.title === 'string') out.title = src.title.slice(0, 40);
      if (LAYOUTS.some((l) => l.id === src.layout)) out.layout = src.layout;
      out.setupDone = !!src.setupDone;

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
          };
          const size = bracketSize(players.length);
          if (Array.isArray(c.slots) && c.slots.length === size && validSlots(c.slots, players)) {
            cat.slots = c.slots.slice();
            if (c.results && typeof c.results === 'object') {
              for (const [k, v] of Object.entries(c.results)) {
                if (/^\d+-\d+$/.test(k) && (v === 0 || v === 1)) cat.results[k] = v;
              }
            }
          }
          out.categories.push(cat);
        });
      }
    }

    if (!out.categories.length) out.categories = [newCategory(0), newCategory(1)];

    for (let i = 0; i < PANE_MAX; i++) {
      const p = srcPanes[i] || {};
      out.panes.push({
        cat: typeof p.cat === 'string' ? p.cat : out.categories[i % out.categories.length].id,
        zoom: clamp(Number(p.zoom) || 1, 0.3, 1.6),
      });
    }
    return out;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* 保存領域が使えない環境でもそのまま動かす */ }
    return normalize(null);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* 同上 */ }
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
        const m = { r, i, sides: [a, b], bye: false, side: null, winner: null, no: null };
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
    return { rounds, pos, size, R, drawn, base };
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
          class: 'match',
          style: `left:${x}px;top:${cy - D.slotH}px;width:${D.colW}px`,
        },
          h('span', { class: 'match-tag', text: `第${m.no}試合` }),
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
    const cat = paneCategory(idx);
    const b = buildRounds(cat);
    const n = cat.players.length;
    pane.style.setProperty('--cat', colorOf(cat));

    // カテゴリー選択
    const select = $('.pane-select', pane);
    select.replaceChildren(...state.categories.map((c) =>
      h('option', { value: c.id, text: c.name })));
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
      if (state.panes[Number(pane.dataset.pane)].cat === catId) updatePane(pane, anim);
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
    const b = buildRounds(cat);
    const m = b.rounds[r] && b.rounds[r][i];
    if (!m || m.bye || !m.sides[0] || !m.sides[1] || !b.drawn) return;

    // この試合の結果を変えると、その先の試合は対戦相手が変わるので取り消す
    const later = [];
    for (let rr = r + 1, ii = i >> 1; rr < b.R; rr++, ii >>= 1) {
      if (cat.results[`${rr}-${ii}`] != null) later.push(`${rr}-${ii}`);
    }
    if (later.length && !confirm('この試合の結果を変えると、その先の試合の記録も取り消されます。変更しますか？')) return;
    later.forEach((k) => delete cat.results[k]);

    const key = `${r}-${i}`;
    let anim = null;
    if (cat.results[key] === side) {
      delete cat.results[key];
    } else {
      cat.results[key] = side;
      anim = { r, i };
    }
    save();
    refreshCategory(cat.id, anim);

    // 押した場所にフォーカスを戻す（キーボード操作用）
    const again = sourcePane.querySelector(`.slot[data-r="${r}"][data-i="${i}"][data-side="${side}"]`);
    if (again && again.focus) again.focus({ preventScroll: true });
  }

  board.addEventListener('click', (e) => {
    const pane = e.target.closest('.pane');
    if (!pane) return;
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

  function setCategorySize(cat, n) {
    if (n !== cat.players.length) {
      if (!cat.slots || confirm(`「${cat.name}」は抽選済みです。人数を変えると、組み合わせと勝敗の記録が消えます。変更しますか？`)) {
        resizePlayers(cat.players, n);
        cat.slots = null;
        cat.results = {};
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
    if (structural) { cat.slots = null; cat.results = {}; }
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
    cat.results = {};
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
    cat.results = {};
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

  window.addEventListener('beforeprint', buildPrint);
  $('#btnPrint').addEventListener('click', () => { buildPrint(); window.print(); });

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
      } catch (err) {
        alert('このファイルは読み込めませんでした。このアプリで書き出した .json ファイルを選んでください。');
      }
    };
    reader.readAsText(file);
  });

  $('#btnReset').addEventListener('click', () => {
    menu.open = false;
    if (!confirm('すべてのカテゴリー・参加者・勝敗の記録を消して、最初の状態に戻します。よろしいですか？')) return;
    state = normalize(null);
    save();
    initView();
    openSetup();
  });

  /* ========== 起動 ========== */

  titleInput.addEventListener('input', () => applyTitle(titleInput.value, titleInput));
  $('#btnSetup').addEventListener('click', openSetup);

  function initView() {
    titleInput.value = state.title;
    applyTitle(state.title, titleInput);
    renderLayoutSwitch();
    renderBoard();
  }

  initView();
  if (!state.setupDone) openSetup();
})();
