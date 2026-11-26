/* 팰리세이드 HEV 매물 스와이프 — 의존성 없는 단일 파일 앱 */
(() => {
  'use strict';

  const STORE = 'palisade-swipe-v1';
  const OPT_LABEL = {
    sunroof: '선루프', aroundView: '360 어라운드뷰', hud: 'HUD',
    ecs: '전자제어서스', vent2: '2열 통풍', massage: '마사지시트',
  };

  let DATA = null;
  let listings = [];
  let byId = new Map();
  let today = new Date();
  let undoStack = [];
  let busy = false;
  let flippedId = null;
  /* '넘기기'는 이번 세션에서만 유효하다. localStorage에는 절대 저장하지 않는다
     (새로고침하면 sessionSkips가 비어 있어 넘긴 카드가 다시 앞에 나온다). */
  let sessionSkips = new Set();

  const state = {
    likes: {},   // id -> { t, price }
    passes: {},  // id -> t
    filter: 'all',
    tab: 'deck',
  };

  const $ = (s) => document.querySelector(s);
  const el = {
    deck: $('#deck'), empty: $('#empty'), emptyTitle: $('#emptyTitle'), emptyText: $('#emptyText'),
    chips: $('#chips'), deckline: $('#deckline'), remaining: $('#remaining'), updated: $('#updated'),
    actions: $('#actions'), likeCount: $('#likeCount'), stage: $('#stage'),
    likesView: $('#likesView'), lvList: $('#lvList'), lvCount: $('#lvCount'), lvEmpty: $('#lvEmpty'),
    lvCompare: $('#lvCompare'), lvCompareToggle: $('#lvCompareToggle'),
    btnUndo: $('#btnUndo'), btnLike: $('#btnLike'), btnPass: $('#btnPass'), btnSkip: $('#btnSkip'),
    emptyUndo: $('#emptyUndo'), emptySkip: $('#emptySkip'), emptyReset: $('#emptyReset'), emptyClearPass: $('#emptyClearPass'),
    lvClear: $('#lvClear'), lvBack: $('#lvBack'),
  };

  /* ── helpers ─────────────────────────── */
  const won = (v) => (v == null ? '–' : v.toLocaleString('ko-KR'));
  const kmFmt = (v) => {
    if (v == null) return '–';
    if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '') + '만km';
    return v.toLocaleString('ko-KR') + 'km';
  };
  const mmdd = (iso) => (iso ? iso.slice(5, 10).replace('-', '/') : '');
  const daysBetween = (a, b) => Math.round((b - a) / 86400000);
  const daysSince = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return Math.round((today - d) / 86400000);
  };
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        v: 1, likes: state.likes, passes: state.passes, filter: state.filter,
      }));
    } catch (e) { /* 사파리 프라이빗 모드 등 */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s || s.v !== 1) return;
      state.likes = s.likes || {};
      state.passes = s.passes || {};
      state.filter = s.filter || 'all';
    } catch (e) { /* ignore */ }
  }

  /* ── filters ─────────────────────────── */
  const FILTERS = [
    { key: 'all', label: '전체', test: () => true },
    { key: '4wd', label: '4WD', test: (x) => x.drive === '4WD' },
    { key: 'under5', label: '5,000만 이하', test: (x) => x.price <= 5000 },
    { key: 'sunroof', label: '선루프 O', test: (x) => !!x.options.sunroof },
    { key: 'recent', label: '최근 인하·신규', test: (x) => isHot(x) },
  ];

  function isHot(x) {
    if (x.isNew) return true;
    return !!(x.change && x.change.delta < 0 && daysSince(x.change.lastDate) <= 2);
  }

  function filterFn(key) {
    const f = FILTERS.find((v) => v.key === key) || FILTERS[0];
    return f.test;
  }

  function available(key) {
    const test = filterFn(key);
    return listings.filter((x) => test(x) && !state.likes[x.id] && !state.passes[x.id] && !sessionSkips.has(x.id));
  }

  /* 이번 세션에 넘겨서 지금 덱에서 빠져 있는 카드 (현재 필터 기준) */
  function sessionSkipsIn(key) {
    const test = filterFn(key);
    return listings.filter((x) => test(x) && sessionSkips.has(x.id) && !state.likes[x.id] && !state.passes[x.id]);
  }

  /* ── deck ────────────────────────────── */
  function currentDeck() { return available(state.filter); }

  function render() {
    renderChips();
    renderDeck();
    renderCounter();
    renderLikesPill();
  }

  function renderChips() {
    el.chips.innerHTML = FILTERS.map((f) => {
      const n = available(f.key).length;
      return `<button class="chip ${state.filter === f.key ? 'active' : ''} ${n === 0 ? 'zero' : ''}"
                data-filter="${f.key}">${f.label}<span class="n">${n}</span></button>`;
    }).join('');

    const deck = available(state.filter);
    const total = listings.filter((x) => !state.likes[x.id] && !state.passes[x.id] && !sessionSkips.has(x.id)).length;
    const fname = (FILTERS.find((f) => f.key === state.filter) || FILTERS[0]).label;
    const skipNote = sessionSkips.size ? ` · 넘김 <b>${sessionSkips.size}</b>` : '';
    el.deckline.innerHTML = state.filter === 'all'
      ? `전체 <b>${listings.length}</b>대 중 <b>${deck.length}</b>대 남음 · 찜 <b>${Object.keys(state.likes).length}</b>${skipNote}`
      : `<b>${fname}</b> · 남은 카드 <b>${deck.length}</b>대 · 전체 <b>${total}</b>대 남음${skipNote}`;
  }

  function renderCounter() {
    el.remaining.textContent = available(state.filter).length;
  }

  function renderLikesPill() {
    const n = Object.keys(state.likes).length;
    el.likeCount.textContent = n;
    el.likeCount.classList.toggle('zero', n === 0);
  }

  function historyLabel(x) {
    const n = x.note || '';
    const other = n.match(/대물\s*([\d,]+)\s*건/);
    if (other) return `대물 ${other[1]}건`;
    if (/단순\s*수리/.test(n)) return '단순수리';
    if (/무사고/.test(n)) return '무사고';
    if (/렌트/.test(n)) return '렌트 이력';
    return '비고 참고';
  }

  function renderDeck() {
    const deck = currentDeck();
    el.deck.innerHTML = '';

    if (!deck.length) {
      el.empty.hidden = false;
      const passCount = Object.keys(state.passes).length;
      const liked = Object.keys(state.likes).length;
      if (state.filter === 'all') {
        el.emptyTitle.textContent = '모든 매물을 다 봤어요';
        el.emptyText.textContent = liked
          ? `찜 ${liked}대를 골랐습니다. 찜 목록에서 나란히 비교해 보세요.`
          : '마음에 드는 매물이 없었다면 패스를 지우고 다시 볼 수 있어요.';
      } else {
        el.emptyTitle.textContent = '이 필터엔 남은 카드가 없어요';
        el.emptyText.textContent = '필터를 바꾸거나 되돌려 보세요.';
      }
      el.emptyUndo.hidden = !undoStack.length;
      el.emptyClearPass.hidden = passCount === 0;
      const skipped = sessionSkipsIn(state.filter).length;
      el.emptySkip.hidden = skipped === 0;
      el.emptySkip.textContent = `넘긴 카드 다시 보기 (${skipped})`;
      el.actions.style.visibility = 'hidden';
      busy = false;
      flippedId = null;
      return;
    }

    el.empty.hidden = true;
    el.actions.style.visibility = 'visible';
    el.btnUndo.disabled = !undoStack.length;

    const top3 = deck.slice(0, 3);
    top3.forEach((item, i) => {
      const card = buildCard(item);
      if (i === 0) card.classList.add('top');
      else if (i === 1) card.classList.add('behind1');
      else card.classList.add('behind2');
      el.deck.appendChild(card);
    });
    if (flippedId && flippedId !== deck[0].id) flippedId = null;
    attachGestures(el.deck.querySelector('.card.top'), deck[0]);
  }

  /* ── card build ──────────────────────── */
  function photoFallback(img) {
    const wrap = img.parentElement;
    const fb = wrap.querySelector('.photo-fallback');
    img.style.display = 'none';
    if (fb) fb.hidden = false;
  }

  function buildCard(x) {
    const tpl = document.getElementById('tpl-card');
    const node = tpl.content.firstElementChild.cloneNode(true);
    const q = (s) => node.querySelector(s);

    const img = q('.car-img');
    if (x.photos && x.photos[0]) {
      img.src = x.photos[0];
      img.alt = `${x.trim} ${x.drive}`;
      img.draggable = false;
      img.addEventListener('error', () => photoFallback(img), { once: true });
      img.addEventListener('load', () => { q('.photo-fallback').hidden = true; }, { once: true });
      if (x.photos.length > 1) {
        const strip = document.createElement('div');
        strip.className = 'thumbs';
        strip.innerHTML = x.photos.slice(0, 4).map((u, i) =>
          `<img src="${u}" alt="" class="${i === 0 ? 'on' : ''}" loading="lazy">`).join('');
        strip.addEventListener('pointerdown', (e) => e.stopPropagation());
        strip.addEventListener('click', (e) => {
          const t = e.target.closest('img');
          if (!t) return;
          e.stopPropagation();
          img.src = t.src;
          strip.querySelectorAll('img').forEach((n) => n.classList.toggle('on', n === t));
        });
        q('.photo').appendChild(strip);
      }
    } else {
      photoFallback(img);
    }

    // badges
    const badges = [];
    if (x.isNew) badges.push('<span class="badge new">신규</span>');
    if (x.change && x.change.delta < 0) {
      badges.push(`<span class="badge down">인하 -${won(Math.abs(x.change.delta))}만</span>`);
    } else if (x.change && x.change.delta > 0) {
      badges.push(`<span class="badge up">인상 +${won(x.change.delta)}만</span>`);
    }
    if (x.options.ecs) badges.push('<span class="badge gray">전자서스</span>');
    q('.badges').innerHTML = badges.join('');
    q('.src-badge').textContent = x.source === 'kcar' ? '케이카 직영' : '엔카';

    // front body
    q('.trim').textContent = x.trim || '팰리세이드';
    const drive = q('.drive');
    drive.textContent = `${x.drive} · ${x.seats || ''}`.trim();
    drive.classList.toggle('four', x.drive === '4WD');
    q('.price').textContent = `${won(x.price)}만`;
    if (x.depreciation != null) {
      q('.dep').textContent = `신차비 -${x.depreciation.toFixed(1)}%`;
    } else {
      q('.dep').style.display = 'none';
    }
    q('.spec-line').innerHTML = [
      `${x.yearMonth}식`, kmFmt(x.km), escapeHtml(x.region || ''),
    ].map((t) => `<li>${t}</li>`).join('');

    const onOpts = Object.keys(OPT_LABEL).filter((k) => x.options[k]);
    q('.opt-badges').innerHTML = onOpts.map((k) => {
      const key = k === 'aroundView' || k === 'sunroof' || k === 'ecs';
      return `<li class="${key ? 'key' : ''}">${OPT_LABEL[k]}</li>`;
    }).join('') || '<li>옵션 정보 없음</li>';

    // back
    q('.b-trim').textContent = x.trim || '팰리세이드 HEV';
    q('.b-sub').textContent = [
      x.drive, x.seats, `${x.yearMonth}식`, kmFmt(x.km), x.region,
    ].filter(Boolean).join(' · ');
    q('.b-price').innerHTML = `<b>${won(x.price)}만</b><span>${x.listPrice ? `신차 ${won(x.listPrice)}만` : '신차가 미확인'}</span>`;

    const chart = makeChart(x);
    q('.chart').innerHTML = chart.svg;
    q('.chart-delta').className = `chart-delta ${chart.cls}`;
    q('.chart-delta').textContent = chart.deltaText;
    q('.chart-note').textContent = chart.note;

    q('.spec-grid').innerHTML = [
      ['연식', `${x.yearMonth}식`],
      ['주행', kmFmt(x.km)],
      ['색상', escapeHtml(x.color || '–')],
      ['구동', `${x.drive} · ${x.seats || '–'}`],
      ['지역', escapeHtml(x.region || '–')],
      ['등록', `${mmdd(x.registered)}${x.isNew ? ' (신규)' : ''}`],
      ['신차가', x.listPrice ? `${won(x.listPrice)}만` : '–'],
      ['감가', x.depreciation != null ? `${x.depreciation.toFixed(1)}%` : '–'],
      ['판매처', x.source === 'kcar' ? '케이카 직영' : '엔카'],
      ['사고·이력', historyLabel(x)],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

    q('.opt-list').innerHTML = Object.keys(OPT_LABEL).map((k) => {
      const on = !!x.options[k];
      return `<li class="${on ? 'on' : ''}"><i>${on ? '✓' : '–'}</i>${OPT_LABEL[k]}</li>`;
    }).join('');

    q('.note').textContent = x.note || '기록된 비고가 없습니다.';
    const link = q('.link-btn');
    link.href = x.url;
    link.textContent = x.source === 'kcar' ? '케이카에서 보기 ↗' : '엔카에서 보기 ↗';

    q('.front-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      node.classList.remove('flipped');
      flippedId = null;
    });
    q('.link-btn').addEventListener('click', (e) => e.stopPropagation());

    return node;
  }

  /* ── chart ───────────────────────────── */
  function makeChart(x) {
    const hist = (x.priceHistory || []).slice().sort((a, b) =>
      (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    const cur = x.price;
    const first = hist.length ? hist[0].price : cur;

    if (hist.length <= 1) {
      return {
        svg: `<svg viewBox="0 0 320 92" role="img" aria-label="가격 변동 없음">
          <line class="grid" x1="10" y1="46" x2="310" y2="46" stroke-dasharray="3 4"/>
          <circle class="dot cur" cx="160" cy="46" r="4"/>
          <text class="val" x="160" y="32" text-anchor="middle">${won(cur)}만</text>
          <text class="axis" x="160" y="68" text-anchor="middle">${mmdd(x.registered)} 등록 · 변동 없음</text>
        </svg>`,
        cls: 'flat', deltaText: '변동 없음',
        note: `등록(${mmdd(x.registered)}) 이후 가격이 그대로입니다.`,
      };
    }

    const W = 320, H = 92, padL = 12, padR = 12, padT = 20, padB = 18;
    const t0 = new Date(hist[0].date + 'T00:00:00').getTime();
    const t1 = new Date(hist[hist.length - 1].date + 'T00:00:00').getTime();
    const span = t1 - t0;
    const prices = hist.map((p) => p.price);
    let lo = Math.min(...prices), hi = Math.max(...prices);
    if (hi === lo) { lo -= 20; hi += 20; }
    const padY = (hi - lo) * 0.28;
    lo -= padY; hi += padY;

    const X = (p, i) => {
      if (!span) return padL + ((W - padL - padR) * (i / Math.max(1, hist.length - 1)));
      return padL + ((new Date(p.date + 'T00:00:00').getTime() - t0) / span) * (W - padL - padR);
    };
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

    const pts = hist.map((p, i) => ({ x: X(p, i), y: Y(p.price), p }));

    // step line: 가격은 변동 시점까지 유지된다
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` H ${pts[i].x.toFixed(1)} V ${pts[i].y.toFixed(1)}`;
    }
    const areaD = `${d} L ${pts[pts.length - 1].x.toFixed(1)} ${H - padB} L ${pts[0].x.toFixed(1)} ${H - padB} Z`;

    const showAll = pts.length <= 5;
    const labels = pts.map((pt, i) => {
      const show = showAll || i === 0 || i === pts.length - 1;
      if (!show) return '';
      const anchor = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
      const dy = -7;
      return `<text class="val" x="${pt.x.toFixed(1)}" y="${(pt.y + dy).toFixed(1)}" text-anchor="${anchor}">${won(pt.p.price)}</text>`;
    }).join('');

    const dots = pts.map((pt, i) =>
      `<circle class="dot ${i === pts.length - 1 ? 'cur' : ''}" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === pts.length - 1 ? 4 : 3}"/>`).join('');

    const delta = cur - first;
    const changes = hist.length - 1;
    const cls = delta < 0 ? 'down' : (delta > 0 ? 'up' : 'flat');
    const deltaText = delta === 0
      ? `±0 · ${changes}회 변동`
      : `${delta < 0 ? '▼' : '▲'} ${won(Math.abs(delta))}만`;

    const last = hist[hist.length - 1];
    const note = `${mmdd(first && hist[0].date)} ${won(first)}만 → ${mmdd(last.date)} ${won(cur)}만 · 변동 ${hist.length - 1}회`;

    return {
      svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="가격 추이">
        <defs><linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6ea0ff" stop-opacity=".28"/>
          <stop offset="100%" stop-color="#6ea0ff" stop-opacity="0"/>
        </linearGradient></defs>
        <line class="grid" x1="${padL}" y1="${Y(hi - padY).toFixed(1)}" x2="${W - padR}" y2="${Y(hi - padY).toFixed(1)}"/>
        <line class="grid" x1="${padL}" y1="${((H - padB + padT) / 2).toFixed(1)}" x2="${W - padR}" y2="${((H - padB + padT) / 2).toFixed(1)}"/>
        <line class="grid" x1="${padL}" y1="${(H - padB).toFixed(1)}" x2="${W - padR}" y2="${(H - padB).toFixed(1)}"/>
        <path class="area" d="${areaD}"/>
        <path class="line" d="${d}"/>
        ${dots}${labels}
        <text class="axis" x="${padL}" y="${H - 3}" text-anchor="start">${mmdd(hist[0].date)}</text>
        <text class="axis" x="${W - padR}" y="${H - 3}" text-anchor="end">${mmdd(last.date)}</text>
      </svg>`,
      cls, deltaText, note,
    };
  }

  /* ── gestures ────────────────────────── */
  function attachGestures(card, item) {
    if (!card) return;
    let drag = null;

    const TAP_MS = 400;   // 이 시간 안에 손을 떼야 '탭'으로 본다
    const TAP_SLOP = 9;   // 이 거리(px) 이상 움직이면 스크롤·드래그로 본다
    const SWIPE = 88;     // 이 거리(px)를 넘기면 스와이프 확정 (좌우·위 공통)

    const stamps = () => ({
      like: card.querySelector('.like-stamp'),
      pass: card.querySelector('.pass-stamp'),
      skip: card.querySelector('.skip-stamp'),
    });

    const clearStamps = () => {
      const s = stamps();
      if (s.like) s.like.style.opacity = 0;
      if (s.pass) s.pass.style.opacity = 0;
      if (s.skip) s.skip.style.opacity = 0;
    };

    const resetCard = () => {
      card.style.transition = 'transform .25s cubic-bezier(.2,.9,.3,1)';
      card.style.transform = '';
      clearStamps();
      setTimeout(() => { card.style.transition = ''; }, 260);
    };

    const flipToBack = () => {
      card.classList.add('flipped');
      flippedId = item.id;
    };
    const flipToFront = () => {
      card.classList.remove('flipped');
      flippedId = null;
    };

    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('a, button')) return;

      if (card.classList.contains('flipped')) {
        // 뒷면: 짧은 탭이면 앞면 복귀. 세로 스크롤은 건드리지 않는다.
        drag = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, id: e.pointerId, back: true, mode: null };
        return;
      }

      drag = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, id: e.pointerId, back: false, mode: null };
      try { card.setPointerCapture(e.pointerId); } catch (_) {}
    });

    card.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;

      if (drag.back) {
        if (!drag.moved && (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP)) drag.moved = true;
        return; // 뒷면은 스크롤을 막지 않는다 (위로 밀어도 넘기지 않음)
      }

      if (!drag.moved && Math.hypot(dx, dy) > 7) drag.moved = true;
      if (!drag.moved) return;

      // 처음 몇 px 움직임으로 방향을 정한다: 위쪽이 우세하면 '넘기기'
      if (!drag.mode) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) drag.mode = dy < 0 ? 'up' : 'down';
        else if (Math.abs(dx) > 10) drag.mode = 'side';
      }

      const s = stamps();
      if (drag.mode === 'up') {
        card.style.transform = `translate(${(dx * .3).toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${(dx / 40).toFixed(2)}deg)`;
        const p = Math.min(1, Math.abs(dy) / 120);
        if (s.skip) s.skip.style.opacity = p;
        s.like.style.opacity = 0;
        s.pass.style.opacity = 0;
      } else {
        card.style.transform = `translate(${dx}px, ${dy * 0.28}px) rotate(${(dx / 24).toFixed(2)}deg)`;
        const p = Math.min(1, Math.abs(dx) / 110);
        if (s.skip) s.skip.style.opacity = 0;
        if (dx > 0) { s.like.style.opacity = p; s.pass.style.opacity = 0; }
        else { s.pass.style.opacity = p; s.like.style.opacity = 0; }
      }
      e.preventDefault();
    });

    const end = (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      const dt = Date.now() - drag.t;
      const moved = drag.moved;
      const fromBack = drag.back;
      const mode = drag.mode;
      drag = null;

      if (fromBack) {
        // 움직였으면(스크롤) 또는 길게 눌렀으면 앞면으로 돌리지 않는다
        if (!moved && Math.abs(dx) <= TAP_SLOP && Math.abs(dy) <= TAP_SLOP && dt < TAP_MS) {
          flipToFront();
        }
        return;
      }

      if (!moved) {
        if (dt < TAP_MS) flipToBack();
        return;
      }
      if (mode === 'up') {
        if (dy < -SWIPE) fly(card, 'up', 'skip');
        else resetCard();
        return;
      }
      if (Math.abs(dx) > SWIPE) {
        fly(card, dx > 0 ? 'right' : 'left', dx > 0 ? 'like' : 'pass');
      } else {
        resetCard();
      }
    };

    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', () => {
      // 네이티브 이미지 드래그·스크롤 등으로 취소되면 스와이프로 처리하지 않고 제자리로
      if (!drag) return;
      const fromBack = drag.back;
      drag = null;
      if (fromBack) return;
      resetCard();
    });
  }

  function fly(card, dir, action) {
    if (busy) return;
    busy = true;
    card.classList.add(dir === 'right' ? 'fly-right' : dir === 'left' ? 'fly-left' : 'fly-up');
    const stamp = card.querySelector(
      dir === 'right' ? '.like-stamp' : dir === 'left' ? '.pass-stamp' : '.skip-stamp');
    if (stamp) stamp.style.opacity = 1;
    if (dir === 'up') {
      card.style.transform = 'translateY(-135%) rotate(-4deg) scale(.97)';
    } else {
      card.style.transform = `translate(${dir === 'right' ? '' : '-'}140%, ${dir === 'right' ? 40 : -30}px) rotate(${dir === 'right' ? 22 : -22}deg)`;
    }
    setTimeout(() => {
      commit(action);
      busy = false;
    }, 250);
  }

  function commit(action) {
    const deck = currentDeck();
    const x = deck[0];
    if (!x) return;
    if (action === 'like') state.likes[x.id] = { t: Date.now(), price: x.price };
    else if (action === 'pass') state.passes[x.id] = Date.now();
    else sessionSkips.add(x.id);   // 스킵은 세션 메모리에만
    undoStack.push({ id: x.id, action });
    if (undoStack.length > 40) undoStack.shift();
    flippedId = null;
    if (action !== 'skip') save();  // 스킵은 localStorage에 쓰지 않는다
    render();
  }

  function undo() {
    const last = undoStack.pop();
    if (!last) return;
    if (last.action === 'like') {
      delete state.likes[last.id];
      save();
    } else if (last.action === 'pass') {
      delete state.passes[last.id];
      save();
    } else {
      sessionSkips.delete(last.id);
    }
    render();
  }

  function triggerSwipe(action) {
    if (busy) return;
    const card = el.deck.querySelector('.card.top');
    if (!card) return;
    if (action === 'like') fly(card, 'right', 'like');
    else if (action === 'pass') fly(card, 'left', 'pass');
    else fly(card, 'up', 'skip');
  }

  /* ── likes view ──────────────────────── */
  function renderLikes() {
    const liked = Object.keys(state.likes)
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => state.likes[b.id].t - state.likes[a.id].t);

    el.lvCount.textContent = liked.length;
    el.lvEmpty.hidden = liked.length > 0;
    el.lvList.innerHTML = liked.map((x) => {
      const tags = [];
      if (x.isNew) tags.push('<span class="nw">신규</span>');
      if (x.change && x.change.delta < 0) tags.push(`<span class="dn">-${won(Math.abs(x.change.delta))}만</span>`);
      if (x.options.sunroof) tags.push('<span>선루프</span>');
      if (x.options.aroundView) tags.push('<span>360뷰</span>');
      if (x.options.hud) tags.push('<span>HUD</span>');
      return `<article class="like-item" data-id="${x.id}">
        <div class="li-img">${x.photos && x.photos[0]
          ? `<img src="${x.photos[0]}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}</div>
        <div class="li-main">
          <div class="li-top">
            <span class="li-trim">${escapeHtml(x.trim)}</span>
            <span class="li-price">${won(x.price)}만</span>
          </div>
          <p class="li-meta">${x.drive} · ${x.yearMonth}식 · ${kmFmt(x.km)} · ${escapeHtml(x.region || '')}</p>
          <div class="li-tags">${tags.join('')}</div>
        </div>
        <div class="li-btns">
          <button class="un" data-unlike="${x.id}">찜 해제</button>
          <a href="${x.url}" target="_blank" rel="noopener">원문</a>
        </div>
      </article>`;
    }).join('');

    renderCompare(liked);
  }

  function renderCompare(liked) {
    const show = !el.lvCompare.hidden;
    if (!show) return;
    const rows = liked.slice().sort((a, b) => a.price - b.price);
    if (!rows.length) { el.lvCompare.innerHTML = ''; return; }
    const min = rows[0].price;
    const head = ['매물', '가격', '연식', '주행', '구동', '선루프', '360뷰', 'HUD', '전자서스', '신차비'];
    const body = rows.map((x) => `<tr>
      <td>${escapeHtml(x.trim)} ${escapeHtml(x.region || '')}</td>
      <td class="hi ${x.price === min ? 'cheap' : ''}">${won(x.price)}</td>
      <td>${x.yearMonth}</td>
      <td>${kmFmt(x.km)}</td>
      <td>${x.drive.replace('WD', '')}</td>
      <td class="${x.options.sunroof ? 'y' : 'n'}">${x.options.sunroof ? 'O' : 'X'}</td>
      <td class="${x.options.aroundView ? 'y' : 'n'}">${x.options.aroundView ? 'O' : 'X'}</td>
      <td class="${x.options.hud ? 'y' : 'n'}">${x.options.hud ? 'O' : 'X'}</td>
      <td class="${x.options.ecs ? 'y' : 'n'}">${x.options.ecs ? 'O' : 'X'}</td>
      <td>${x.depreciation != null ? '-' + x.depreciation.toFixed(0) + '%' : '–'}</td>
    </tr>`).join('');
    el.lvCompare.innerHTML = `<table class="compare">
      <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function openTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    el.likesView.hidden = tab !== 'likes';
    if (tab === 'likes') renderLikes();
  }

  /* ── events ──────────────────────────── */
  el.chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    save();
    render();
  });

  el.btnLike.addEventListener('click', () => triggerSwipe('like'));
  el.btnPass.addEventListener('click', () => triggerSwipe('pass'));
  el.btnSkip.addEventListener('click', () => triggerSwipe('skip'));
  el.btnUndo.addEventListener('click', undo);
  el.emptyUndo.addEventListener('click', undo);
  el.emptySkip.addEventListener('click', () => {
    if (!sessionSkips.size) return;
    sessionSkips.clear();
    undoStack = undoStack.filter((u) => u.action !== 'skip');
    render();
  });
  el.emptyReset.addEventListener('click', () => {
    state.filter = 'all';
    save();
    render();
  });
  el.emptyClearPass.addEventListener('click', () => {
    if (!confirm('패스한 매물 기록을 지우고 다시 볼까요?')) return;
    state.passes = {};
    undoStack = undoStack.filter((u) => u.action === 'like');
    save();
    render();
  });

  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => openTab(b.dataset.tab)));
  el.lvBack.addEventListener('click', () => openTab('deck'));

  el.lvList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unlike]');
    if (!b) return;
    const id = b.dataset.unlike;
    delete state.likes[id];
    undoStack = undoStack.filter((u) => !(u.id === id && u.action === 'like'));
    save();
    render();
    renderLikes();
  });

  el.lvClear.addEventListener('click', () => {
    const n = Object.keys(state.likes).length;
    if (!n) return;
    if (!confirm(`찜한 ${n}대를 모두 목록에서 비울까요? (카드로 다시 볼 수 있어요)`)) return;
    state.likes = {};
    undoStack = undoStack.filter((u) => u.action === 'pass');
    save();
    render();
    renderLikes();
  });

  el.lvCompareToggle.addEventListener('click', () => {
    el.lvCompare.hidden = !el.lvCompare.hidden;
    el.lvCompareToggle.textContent = el.lvCompare.hidden ? '비교표' : '비교표 닫기';
    renderLikes();
  });

  document.addEventListener('keydown', (e) => {
    if (state.tab !== 'deck') return;
    if (e.key === 'ArrowLeft') triggerSwipe('pass');
    if (e.key === 'ArrowRight') triggerSwipe('like');
    if (e.key === 'ArrowUp') { e.preventDefault(); triggerSwipe('skip'); }
    if (e.key === ' ') { const c = el.deck.querySelector('.card.top'); if (c) c.classList.toggle('flipped'); }
  });

  /* ── boot ────────────────────────────── */
  async function boot() {
    load();
    try {
      const res = await fetch('data.json', { cache: 'no-store' });
      DATA = await res.json();
      listings = DATA.listings || [];
      byId = new Map(listings.map((x) => [x.id, x]));
      today = DATA.generatedAt ? new Date(DATA.generatedAt) : new Date();
      el.updated.textContent = `${DATA.count || listings.length}대 · ${mmdd((DATA.generatedAt || '').slice(0, 10))} ${(DATA.generatedAt || '').slice(11, 16)} 업데이트`;
    } catch (err) {
      el.updated.textContent = '데이터를 불러오지 못했습니다';
      el.empty.hidden = false;
      el.emptyTitle.textContent = '데이터 로드 실패';
      el.emptyText.textContent = '네트워크를 확인한 뒤 새로고침해 주세요.';
      return;
    }
    render();
    openTab('deck');
  }

  boot();
})();
