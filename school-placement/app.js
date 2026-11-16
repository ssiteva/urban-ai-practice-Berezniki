/* Приложение «Размещение школ» (Практика 3). Без сети, без внешних библиотек. */
(function () {
  'use strict';
  const D = window.BASE_DATA, PM = window.ProvisionModel;
  const $ = (id) => document.getElementById(id);
  const N = D.n, ACC = D.params.accessibility_min;
  const MODE_RU = { walk: 'пешком', drive: 'на машине' };

  if (!D || !PM) { document.body.innerHTML = '<p style="padding:20px;color:#b42318">Не найдены data/base_data.js или model.js. Запустите prepare_data.py.</p>'; return; }

  const matrices = { walk: PM.decodeMatrix(D.matrices.walk), drive: PM.decodeMatrix(D.matrices.drive) };
  const fmt = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x)) ? '—' : Number(x).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (x) => Number.isNaN(x) ? '—' : fmt(x * 100, 1) + '%';
  const sgn = (x, d = 0) => (x > 0 ? '+' : '') + fmt(x, d);

  const state = {
    mode: 'walk', view: 'base', selected: null,
    schools: [],          // [{block, seats}] — планируемые школы текущего сценария
    calcSchools: null,    // снимок schools, по которому посчитан scenario
    base: {}, scenario: null,
    auto: null, saved: [],
  };

  // ---------- Расчёт ----------
  function capacityWith(schools) {
    const cap = D.capacity.slice();             // исходные данные не меняются
    for (const s of schools) cap[s.block] += s.seats;
    return cap;
  }
  function calc(cap, mode) { return PM.computeProvision(D.demand, cap, matrices[mode], N, ACC); }
  function baseline(mode) {
    if (!state.base[mode]) state.base[mode] = calc(D.capacity, mode);
    return state.base[mode];
  }

  // Проверка: без новых школ = Практика 2
  function checkBaseline() {
    const out = [];
    for (const mode of ['walk', 'drive']) {
      const b = baseline(mode), ref = D.practice2[mode];
      let bad = 0;
      for (let i = 0; i < N; i++) if (b.demandWithin[i] !== ref.demand_within[i] || b.demandLeft[i] !== ref.demand_left[i]) bad++;
      out.push({ mode, bad, deficit: b.total.deficit, refDeficit: ref.demand_left.reduce((a, c) => a + c, 0) });
    }
    $('baselineCheck').innerHTML = out.map(o =>
      `<div><span class="pill ${o.bad ? 'err' : 'ok'}">${o.bad ? '✗' : '✓'}</span> Исходный расчёт ${MODE_RU[o.mode]}: дефицит ${fmt(o.deficit)} мест, в Практике 2 — ${fmt(o.refDeficit)}; расхождений по кварталам: ${o.bad}</div>`).join('');
  }

  // ---------- Карта (canvas, без внешних библиотек) ----------
  const canvas = $('map'), ctx = canvas.getContext('2d');
  const feats = D.geojson.features;
  let lat0 = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  { let s = 0, c = 0; for (const f of feats) for (const p of rings(f.geometry)[0]) { s += p[1]; c++; } lat0 = s / c; }
  const kx = Math.cos(lat0 * Math.PI / 180);
  function rings(g) { return g.type === 'Polygon' ? g.coordinates : g.coordinates.flat(); }
  const shapes = feats.map(f => {
    const rs = rings(f.geometry).map(r => r.map(([lon, lat]) => { const x = lon * kx, y = -lat; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); return [x, y]; }));
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, cx = 0, cy = 0;
    for (const [x, y] of rs[0]) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); cx += x; cy += y; }
    return { rs, bbox: [bx0, by0, bx1, by1], c: [cx / rs[0].length, cy / rs[0].length] };
  });
  const schoolPts = D.schools.map(s => ({ ...s, x: s.lon * kx, y: -s.lat }));
  let view = { s: 1, tx: 0, ty: 0 };

  function resize() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function fit() {
    const r = canvas.getBoundingClientRect();
    const s = Math.min(r.width / (maxX - minX), r.height / (maxY - minY)) * 0.94;
    view = { s, tx: (r.width - (maxX - minX) * s) / 2 - minX * s, ty: (r.height - (maxY - minY) * s) / 2 - minY * s };
    draw();
  }
  const toScreen = (x, y) => [x * view.s + view.tx, y * view.s + view.ty];
  const toWorld = (sx, sy) => [(sx - view.tx) / view.s, (sy - view.ty) / view.s];

  // Цвета
  function lerp(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    for (let k = 1; k < stops.length; k++) if (t <= stops[k][0]) { const [t0, c0] = stops[k - 1], [t1, c1] = stops[k]; return lerp(c0, c1, (t - t0) / (t1 - t0 || 1)); }
    return stops[stops.length - 1][1];
  }
  const PROV = [[0, [190, 30, 45]], [0.5, [244, 196, 64]], [0.8, [166, 217, 106]], [1, [26, 152, 80]]];
  const DIFF = [[0, [235, 241, 250]], [0.25, [158, 202, 225]], [1, [8, 81, 156]]];
  const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function currentResult() { return state.view === 'base' || !state.scenario ? baseline(state.mode) : state.scenario; }
  function maxDiff() {
    if (!state.scenario) return 0;
    const b = baseline(state.mode); let m = 0;
    for (let i = 0; i < N; i++) if (D.demand[i] > 0) m = Math.max(m, state.scenario.provision[i] - b.provision[i]);
    return m;
  }
  function blockColor(i) {
    if (D.demand[i] === 0) return 'rgba(205,210,218,0.55)';
    if (state.view === 'diff') {
      if (!state.scenario) return 'rgba(205,210,218,0.55)';
      const d = state.scenario.provision[i] - baseline(state.mode).provision[i];
      if (d < -1e-9) return rgb([190, 30, 45]);
      const m = maxDiff() || 1;
      return d > 1e-9 ? rgb(ramp(DIFF, 0.15 + 0.85 * d / m)) : 'rgba(225,230,238,0.9)';
    }
    return rgb(ramp(PROV, currentResult().provision[i]));
  }

  function draw() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    const [wx0, wy0] = toWorld(0, 0), [wx1, wy1] = toWorld(r.width, r.height);
    const planned = new Set(state.schools.map(s => s.block));
    const bestSet = new Set(state.auto && state.auto.complete ? state.auto.best : []);
    for (let i = 0; i < N; i++) {
      const sh = shapes[i], b = sh.bbox;
      if (b[2] < wx0 || b[0] > wx1 || b[3] < wy0 || b[1] > wy1) continue;
      ctx.beginPath();
      for (const ring of sh.rs) { ring.forEach(([x, y], k) => { const [sx, sy] = toScreen(x, y); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.closePath(); }
      ctx.fillStyle = blockColor(i); ctx.fill('evenodd');
      ctx.lineWidth = 0.5; ctx.strokeStyle = 'rgba(60,70,90,0.35)'; ctx.stroke();
    }
    // выделения поверх
    const outline = (i, color, w) => {
      const sh = shapes[i]; ctx.beginPath();
      for (const ring of sh.rs) { ring.forEach(([x, y], k) => { const [sx, sy] = toScreen(x, y); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.closePath(); }
      ctx.lineWidth = w; ctx.strokeStyle = color; ctx.stroke();
    };
    bestSet.forEach(i => outline(i, '#7a1fa2', 3));
    planned.forEach(i => outline(i, '#2457c5', 3));
    if (state.selected !== null) outline(state.selected, '#111', 2.5);
    // существующие школы
    for (const s of schoolPts) {
      const [sx, sy] = toScreen(s.x, s.y);
      ctx.beginPath(); ctx.arc(sx, sy, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#1d2433'; ctx.stroke();
    }
    // планируемые школы
    for (const s of state.schools) {
      const [sx, sy] = toScreen(...shapes[s.block].c);
      star(sx, sy, 9, '#2457c5');
      ctx.font = '600 11px Segoe UI, sans-serif'; ctx.fillStyle = '#10255a'; ctx.fillText(s.seats + ' мест', sx + 10, sy - 6);
    }
    bestSet.forEach(i => { const [sx, sy] = toScreen(...shapes[i].c); star(sx, sy, 8, '#7a1fa2'); });
    drawLegend();
  }
  function star(x, y, r, color) {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r; ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
    ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
  function drawLegend() {
    const L = $('legend');
    const common = `<div style="margin-top:4px"><span style="display:inline-block;width:10px;height:10px;border:2px solid #1d2433;border-radius:50%;vertical-align:middle"></span> существующая школа &nbsp; <span style="color:#2457c5">★</span> новая школа &nbsp; <span style="color:#7a1fa2">★</span> лучший квартал автоподбора</div><div class="muted">Серым — кварталы без жителей (нет спроса)</div>`;
    if (state.view === 'diff') {
      const m = maxDiff();
      L.innerHTML = `<b>Изменение обеспеченности</b> (сценарий − исходное), п.п.<div class="bar" style="background:linear-gradient(90deg,rgb(225,230,238),rgb(158,202,225),rgb(8,81,156))"></div><div style="display:flex;justify-content:space-between"><span>0</span><span>+${fmt(m * 100, 1)}</span></div>${state.scenario ? '' : '<div class="stale">Сценарий не рассчитан</div>'}${common}`;
    } else {
      L.innerHTML = `<b>Обеспеченность местами</b> в пределах ${ACC} мин ${MODE_RU[state.mode]} — ${state.view === 'base' ? 'исходное' : 'сценарий'}<div class="bar" style="background:linear-gradient(90deg,rgb(190,30,45),rgb(244,196,64) 50%,rgb(166,217,106) 80%,rgb(26,152,80))"></div><div style="display:flex;justify-content:space-between"><span>0%</span><span>50%</span><span>100%</span></div>${state.view === 'scen' && !state.scenario ? '<div class="stale">Сценарий не рассчитан — показано исходное</div>' : ''}${common}`;
    }
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xi, yi] = ring[a], [xj, yj] = ring[b];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function hit(sx, sy) {
    const [x, y] = toWorld(sx, sy);
    for (let i = 0; i < N; i++) {
      const b = shapes[i].bbox; if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      let ins = false; for (const r of shapes[i].rs) if (pointInRing(x, y, r)) ins = !ins;
      if (ins) return i;
    }
    return null;
  }
  // взаимодействие с картой
  let drag = null;
  canvas.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false }; });
  window.addEventListener('mousemove', e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; canvas.classList.add('drag'); }
      if (drag.moved) { view.tx = drag.tx + dx; view.ty = drag.ty + dy; draw(); }
      return;
    }
    const r = canvas.getBoundingClientRect(), tip = $('tip');
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { tip.style.display = 'none'; return; }
    const i = hit(e.clientX - r.left, e.clientY - r.top);
    if (i === null) { tip.style.display = 'none'; return; }
    const b = baseline(state.mode), s = state.scenario;
    tip.innerHTML = `Квартал ${i} · жителей ${fmt(D.population[i])} · мест ${fmt(D.capacity[i])}<br>обеспеченность: ${pct(b.provision[i])}${s ? ' → ' + pct(s.provision[i]) : ''}`;
    tip.style.display = 'block'; tip.style.left = (e.clientX - r.left + 14) + 'px'; tip.style.top = (e.clientY - r.top + 10) + 'px';
  });
  window.addEventListener('mouseup', e => {
    if (!drag) return;
    const moved = drag.moved; drag = null; canvas.classList.remove('drag');
    if (!moved) { const r = canvas.getBoundingClientRect(); const i = hit(e.clientX - r.left, e.clientY - r.top); if (i !== null) selectBlock(i); }
  });
  canvas.addEventListener('wheel', e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
  function zoomAt(sx, sy, k) { view.tx = sx - (sx - view.tx) * k; view.ty = sy - (sy - view.ty) * k; view.s *= k; draw(); }
  $('zin').onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.4); };
  $('zout').onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.4); };
  $('zfit').onclick = fit;
  function zoomTo(i) {
    const r = canvas.getBoundingClientRect(), [cx, cy] = shapes[i].c;
    const s = Math.max(view.s, (Math.min(r.width, r.height) / 0.03)); // ~3 км в кадре
    view = { s, tx: r.width / 2 - cx * s, ty: r.height / 2 - cy * s }; draw();
  }

  // ---------- Карточка квартала ----------
  function selectBlock(i, zoom) {
    state.selected = i; $('selBlock').value = 'Квартал ' + i;
    renderCard(); if (zoom) zoomTo(i); else draw();
    document.querySelectorAll('#cmpTable tr[data-id]').forEach(tr => tr.classList.toggle('sel', +tr.dataset.id === i));
  }
  function renderCard() {
    const i = state.selected; if (i === null) return;
    const b = baseline(state.mode), s = state.scenario;
    const added = (s ? state.calcSchools : state.schools).filter(x => x.block === i).reduce((a, x) => a + x.seats, 0);
    const p2 = D.practice2[state.mode];
    $('blockCard').innerHTML = `
      <div style="font-size:15px;font-weight:650;margin-bottom:6px">Квартал ${i} <span class="tag">${D.land_use[i] || 'без преобладающей функции'}</span></div>
      <div class="kv">
        <div>Население, чел. <span class="tag p2">Практика 2</span></div><div>${fmt(D.population[i])}</div>
        <div>Спрос: школьники, чел. (120 на 1000)</div><div>${fmt(D.demand[i])}</div>
        <div>Места в школах квартала, исходно <span class="tag p2">Практика 2</span></div><div>${fmt(D.capacity[i])}</div>
        <div>Добавлено мест в сценарии</div><div>${added ? '+' + fmt(added) : '0'}</div>
        <div>Места в школах квартала, сценарий</div><div>${fmt(D.capacity[i] + added)}</div>
      </div>
      <h3>Обеспеченность (${MODE_RU[state.mode]}, ≤ ${ACC} мин)</h3>
      <div class="kv">
        <div>Исходная (Практика 2: ${pct(p2.provision_strong[i] ?? NaN)})</div><div>${pct(b.provision[i])}</div>
        <div>Сценарий</div><div>${s ? pct(s.provision[i]) : '—'}</div>
        <div>Получили место, чел.: исходно → сценарий</div><div>${fmt(b.demandWithin[i])} → ${s ? fmt(s.demandWithin[i]) : '—'}</div>
        <div>Дефицит мест, чел.: исходно → сценарий</div><div>${fmt(b.demandLeft[i])} → ${s ? fmt(s.demandLeft[i]) : '—'}</div>
        <div>Свободных мест в школах квартала</div><div>${fmt(b.capacityLeft[i])} → ${s ? fmt(s.capacityLeft[i]) : '—'}</div>
      </div>`;
  }

  // ---------- Сценарий ----------
  function parseSeats(v) {
    const s = String(v).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    return n > 0 && n <= 100000 ? n : null;
  }
  function setMsg(id, text, cls) { const el = $(id); el.textContent = text; el.className = 'msg ' + (cls || ''); }
  function schoolsKey(arr) { return JSON.stringify(arr.map(s => [s.block, s.seats]).sort((a, b) => a[0] - b[0] || a[1] - b[1])); }
  function isStale() { return state.scenario && schoolsKey(state.schools) !== schoolsKey(state.calcSchools); }

  function renderSchools() {
    $('schoolsList').innerHTML = state.schools.map((s, k) =>
      `<li><span>★ Квартал <a href="#" data-goto="${s.block}">${s.block}</a> — <b>${fmt(s.seats)}</b> мест</span><button class="btn small" data-del="${k}">удалить</button></li>`).join('')
      || '<li class="muted" style="justify-content:center">Новых школ нет — сценарий равен исходному состоянию</li>';
    $('schoolsList').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { state.schools.splice(+b.dataset.del, 1); renderSchools(); renderStale(); draw(); });
    $('schoolsList').querySelectorAll('[data-goto]').forEach(a => a.onclick = (e) => { e.preventDefault(); selectBlock(+a.dataset.goto, true); });
  }
  function renderStale() {
    $('resultState').innerHTML = !state.scenario ? '<span class="muted">(сценарий не рассчитан)</span>'
      : isStale() ? '<span class="stale">(состав школ изменён — нажмите «Рассчитать сценарий»)</span>' : '';
  }

  $('addSchool').onclick = () => {
    if (state.selected === null) return setMsg('addMsg', 'Сначала выберите квартал на карте.', 'err');
    const seats = parseSeats($('seatsInput').value);
    if (seats === null) return setMsg('addMsg', 'Вместимость должна быть целым положительным числом мест.', 'err');
    state.schools.push({ block: state.selected, seats });
    setMsg('addMsg', `Добавлена школа на ${seats} мест в квартал ${state.selected}.`, 'ok');
    renderSchools(); renderStale(); draw();
  };

  function runScenario() {
    const t0 = performance.now();
    state.scenario = calc(capacityWith(state.schools), state.mode);
    state.calcSchools = state.schools.map(s => ({ ...s }));
    const dt = performance.now() - t0;
    setMsg('calcMsg', `Рассчитано по всей территории (${fmt(N)} кварталов, ${MODE_RU[state.mode]}) за ${fmt(dt)} мс.`, 'ok');
    if (state.view === 'base') setView('scen');
    renderAll();
  }
  $('calcBtn').onclick = runScenario;

  $('resetBtn').onclick = () => {
    state.schools = []; state.scenario = null; state.calcSchools = null; state.selected = null; state.auto = null;
    $('selBlock').value = ''; $('blockCard').innerHTML = 'Выберите квартал на карте.';
    $('autoProg').value = 0; setMsg('autoMsg', ''); setMsg('calcMsg', 'Изменения сброшены, показано исходное состояние.', 'ok'); setMsg('addMsg', '');
    $('applyBest').disabled = true; $('exportAuto').disabled = true;
    setView('base'); renderAll(); renderAuto();
  };

  // Сценарии эксперимента (выбор и обоснование — в README.md)
  const PRESETS = {
    A: { name: 'A — одна школа 600 мест (вручную)', schools: [{ block: 55, seats: 600 }] },
    B: { name: 'B — две школы по 300 мест (вручную)', schools: [{ block: 55, seats: 300 }, { block: 244, seats: 300 }] },
  };
  function loadPreset(k) {
    state.schools = PRESETS[k].schools.map(s => ({ ...s })); $('scName').value = PRESETS[k].name;
    renderSchools(); runScenario();
  }
  $('presetA').onclick = () => loadPreset('A');
  $('presetB').onclick = () => loadPreset('B');

  // ---------- Итоги ----------
  function renderMetrics() {
    const b = baseline(state.mode).total, s = state.scenario ? state.scenario.total : null;
    const added = state.scenario ? state.calcSchools.reduce((a, x) => a + x.seats, 0) : 0;
    const m = (k, v, sub) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="k">${sub}</div>` : ''}</div>`;
    $('metrics').innerHTML =
      m('Прирост вместимости сети, мест', s ? '+' + fmt(added) : '0', `всего мест: ${fmt(b.capacity)} → ${s ? fmt(s.capacity) : '—'}`) +
      m('Остаточный дефицит мест, чел.', s ? fmt(s.deficit) : fmt(b.deficit), `исходно: ${fmt(b.deficit)}`) +
      m('Сокращение дефицита к исходному, мест', s ? `<span class="${b.deficit - s.deficit > 0 ? 'pos' : ''}">${fmt(b.deficit - s.deficit)}</span>` : '—',
        s ? `${pct(b.deficit ? (b.deficit - s.deficit) / b.deficit : 0)} исходного дефицита` : 'рассчитайте сценарий') +
      m('Обеспеченность по территории', s ? pct(s.provision) : pct(b.provision), `исходно: ${pct(b.provision)} · спрос ${fmt(b.demand)} чел.`) +
      m('Новые места использованы детьми', s ? fmt(Math.max(0, (s.capacity - s.capacityLeft) - (b.capacity - b.capacityLeft))) : '—', s ? `из ${fmt(added)} добавленных` : '') +
      m('Кварталов с дефицитом', s ? `${countDef(state.scenario)}` : `${countDef(baseline(state.mode))}`, `исходно: ${countDef(baseline(state.mode))}`);
  }
  const countDef = (r) => { let c = 0; for (let i = 0; i < N; i++) if (r.demandLeft[i] > 0) c++; return c; };

  // ---------- Таблица сравнения по кварталам ----------
  let cmpSort = { key: 'dDef', dir: -1 };
  function cmpRows() {
    const b = baseline(state.mode), s = state.scenario;
    const added = new Array(N).fill(0);
    if (s) state.calcSchools.forEach(x => added[x.block] += x.seats);
    const rows = [];
    for (let i = 0; i < N; i++) {
      const r = {
        id: i, pop: D.population[i], dem: D.demand[i], cap0: D.capacity[i], cap1: D.capacity[i] + added[i],
        p0: b.provision[i], p1: s ? s.provision[i] : b.provision[i],
        def0: b.demandLeft[i], def1: s ? s.demandLeft[i] : b.demandLeft[i],
      };
      r.dP = (Number.isNaN(r.p1) || Number.isNaN(r.p0)) ? 0 : r.p1 - r.p0; r.dDef = r.def0 - r.def1;
      r.changed = added[i] > 0 || r.def0 !== r.def1 || (s && s.demandWithin[i] !== b.demandWithin[i]) || (s && s.capacityLeft[i] !== b.capacityLeft[i]);
      rows.push(r);
    }
    return rows;
  }
  const CMP_COLS = [
    ['id', 'Квартал', r => r.id], ['pop', 'Население, чел. (П2)', r => fmt(r.pop)], ['dem', 'Спрос, мест', r => fmt(r.dem)],
    ['cap0', 'Места исходно (П2)', r => fmt(r.cap0)], ['cap1', 'Места сценарий', r => r.cap1 !== r.cap0 ? `<b>${fmt(r.cap1)}</b>` : fmt(r.cap1)],
    ['p0', 'Обеспеч. исходно', r => pct(r.p0)], ['p1', 'Обеспеч. сценарий', r => pct(r.p1)],
    ['dP', 'Δ обеспеч., п.п.', r => r.dP ? `<span class="${r.dP > 0 ? 'pos' : 'neg'}">${sgn(r.dP * 100, 1)}</span>` : '0'],
    ['def0', 'Дефицит исходно, мест', r => fmt(r.def0)], ['def1', 'Дефицит сценарий, мест', r => fmt(r.def1)],
    ['dDef', 'Сокращение дефицита', r => r.dDef ? `<span class="${r.dDef > 0 ? 'pos' : 'neg'}">${fmt(r.dDef)}</span>` : '0'],
  ];
  function renderCmp() {
    let rows = cmpRows();
    const changed = rows.filter(r => r.changed).length;
    if ($('onlyChanged').checked) rows = rows.filter(r => r.changed);
    const k = cmpSort.key, d = cmpSort.dir;
    rows.sort((a, b) => ((Number.isNaN(a[k]) ? -1e9 : a[k]) - (Number.isNaN(b[k]) ? -1e9 : b[k])) * d || a.id - b.id);
    $('cmpInfo').textContent = state.scenario ? `Изменения затронули ${changed} кварталов. Показано строк: ${rows.length}. Щелчок по строке — квартал на карте.` : 'Сценарий не рассчитан: показаны исходные значения.';
    $('cmpTable').innerHTML = `<thead><tr>${CMP_COLS.map(([key, t]) => `<th data-k="${key}">${t}${cmpSort.key === key ? (cmpSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>` +
      (rows.length ? rows.map(r => `<tr data-id="${r.id}" class="${r.id === state.selected ? 'sel' : ''}">${CMP_COLS.map(c => `<td>${c[2](r)}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${CMP_COLS.length}" style="text-align:center" class="muted">Нет изменённых кварталов</td></tr>`) + '</tbody>';
    $('cmpTable').querySelectorAll('th').forEach(th => th.onclick = () => { cmpSort = { key: th.dataset.k, dir: cmpSort.key === th.dataset.k ? -cmpSort.dir : -1 }; renderCmp(); });
    $('cmpTable').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => selectBlock(+tr.dataset.id, true));
  }
  $('onlyChanged').onchange = renderCmp;

  // ---------- CSV ----------
  function download(name, rows) {
    const csv = '﻿' + rows.map(r => r.map(v => { const s = v === null || v === undefined || Number.isNaN(v) ? '' : String(v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const num = (x, d = 4) => Number.isNaN(x) ? '' : String(+x.toFixed(d)).replace('.', ',');
  $('exportCmp').onclick = () => {
    const rows = cmpRows();
    const head = ['квартал', 'население_чел_П2', 'спрос_мест', 'места_исходно_П2', 'места_сценарий', 'добавлено_мест', 'обеспеченность_исходно', 'обеспеченность_сценарий', 'дефицит_исходно', 'дефицит_сценарий', 'сокращение_дефицита'];
    const meta = [['# граф', MODE_RU[state.mode]], ['# доступность_мин', ACC], ['# новые школы', state.scenario ? state.calcSchools.map(s => `кв.${s.block}:${s.seats}`).join(' ') : 'нет (исходное состояние)']];
    download(`school_placement_${state.mode}_${new Date().toISOString().slice(0, 10)}.csv`,
      [...meta, head, ...rows.map(r => [r.id, num(r.pop, 1), r.dem, r.cap0, r.cap1, r.cap1 - r.cap0, num(r.p0), num(r.p1), r.def0, r.def1, r.dDef])]);
  };

  // ---------- Автоподбор ----------
  let autoRunning = false;
  $('autoBtn').onclick = async () => {
    if (autoRunning) return;
    const seats = parseSeats($('autoSeats').value);
    if (seats === null) return setMsg('autoMsg', 'Вместимость новой школы должна быть целым положительным числом мест.', 'err');
    autoRunning = true; $('autoBtn').disabled = true; $('applyBest').disabled = true; $('exportAuto').disabled = true;
    const mode = state.mode, base = baseline(mode), prog = $('autoProg');
    prog.max = N; prog.value = 0;
    const results = [], errors = [];
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      try {
        const cap = D.capacity.slice(); cap[i] += seats;            // каждый вариант — от исходных данных
        const r = calc(cap, mode);
        if (!Number.isFinite(r.total.deficit)) throw new Error('некорректный результат');
        results.push({ block: i, deficit: r.total.deficit, reduction: base.total.deficit - r.total.deficit, provision: r.total.provision,
          used: (r.capacity - r.capacityLeft), improved: countImproved(base, r) });
      } catch (err) { errors.push({ block: i, error: String(err && err.message || err) }); }
      if (i % (mode === 'walk' ? 40 : 6) === 0 || i === N - 1) {
        prog.value = i + 1; setMsg('autoMsg', `Проверено кварталов: ${i + 1} из ${N}…`);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    results.sort((a, b) => b.reduction - a.reduction || a.block - b.block);
    const bestVal = results.length ? results[0].reduction : null;
    const best = results.filter(r => r.reduction === bestVal).map(r => r.block);
    state.auto = { mode, seats, results, errors, best, bestVal, complete: errors.length === 0 && results.length === N, ms: performance.now() - t0, baseDeficit: base.total.deficit };
    autoRunning = false; $('autoBtn').disabled = false; $('exportAuto').disabled = false;
    if (state.auto.complete) {
      setMsg('autoMsg', `Готово: проверены все ${N} кварталов из ${N} за ${fmt(state.auto.ms / 1000, 1)} с.`, 'ok');
      $('applyBest').disabled = false;
    } else {
      setMsg('autoMsg', `Внимание: поиск неполный — успешно ${results.length} из ${N}, ошибок ${errors.length}. Результат НЕ является проверкой всех кварталов.`, 'err');
    }
    renderAuto(); draw();
    if (best.length) selectBlock(best[0], true);
  };
  function countImproved(b, r) { let c = 0; for (let i = 0; i < N; i++) if (r.demandWithin[i] > b.demandWithin[i]) c++; return c; }

  function renderAuto() {
    const A = state.auto;
    if (!A) { $('autoSummary').innerHTML = 'Ещё не запускался.'; $('autoTable').innerHTML = ''; return; }
    const stale = A.mode !== state.mode ? `<div class="stale">Результаты получены для графа «${MODE_RU[A.mode]}» — запустите поиск заново.</div>` : '';
    $('autoSummary').innerHTML = `${stale}
      <div class="kv">
        <div>Школа, мест</div><div>${fmt(A.seats)}</div>
        <div>Граф</div><div>${MODE_RU[A.mode]}, ≤ ${ACC} мин</div>
        <div>Проверено кварталов</div><div>${fmt(A.results.length)} из ${fmt(N)}${A.errors.length ? ` · <span class="neg">ошибок: ${A.errors.length}</span>` : ''}</div>
        <div>Дефицит исходно, мест</div><div>${fmt(A.baseDeficit)}</div>
        <div>Наибольшее сокращение, мест</div><div>${fmt(A.bestVal)}</div>
        <div>${A.best.length > 1 ? 'Лучшие кварталы (равный результат)' : 'Лучший квартал'}</div><div>${A.best.map(b => `<a href="#" data-goto="${b}">${b}</a>`).join(', ')}</div>
      </div>
      ${A.errors.length ? `<div class="msg err">Не рассчитаны кварталы: ${A.errors.map(e => e.block + ' (' + e.error + ')').join('; ')}</div>` : ''}`;
    $('autoSummary').querySelectorAll('[data-goto]').forEach(a => a.onclick = (e) => { e.preventDefault(); selectBlock(+a.dataset.goto, true); });
    const rows = A.results;
    $('autoTable').innerHTML = `<thead><tr><th>№</th><th>Квартал</th><th>Сокращение дефицита, мест</th><th>Остаток дефицита</th><th>Обеспеч.</th><th>Улучшено кварт.</th></tr></thead><tbody>` +
      rows.map((r, k) => `<tr data-id="${r.block}" class="${A.best.includes(r.block) ? 'best' : ''}"><td>${k + 1}</td><td>${r.block}</td><td>${fmt(r.reduction)}</td><td>${fmt(r.deficit)}</td><td>${pct(r.provision)}</td><td>${r.improved}</td></tr>`).join('') + '</tbody>';
    $('autoTable').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => selectBlock(+tr.dataset.id, true));
  }
  $('applyBest').onclick = () => {
    const A = state.auto; if (!A || !A.complete) return;
    if (A.mode !== state.mode) return setMsg('autoMsg', 'Граф изменился после поиска — запустите поиск заново.', 'err');
    state.schools = [{ block: A.best[0], seats: A.seats }];
    $('scName').value = `C — авто: кв. ${A.best[0]}, ${A.seats} мест`;
    renderSchools(); runScenario();
    const red = baseline(state.mode).total.deficit - state.scenario.total.deficit;
    setMsg('calcMsg', red === A.bestVal ? `Проверка: ручное размещение в квартал ${A.best[0]} дало то же сокращение (${fmt(red)} мест), что и автоподбор ✓` : `Расхождение с автоподбором: ${fmt(red)} против ${fmt(A.bestVal)}`, red === A.bestVal ? 'ok' : 'err');
  };
  $('exportAuto').onclick = () => {
    const A = state.auto; if (!A) return;
    download(`auto_search_${A.mode}_${A.seats}_мест.csv`, [
      ['# граф', MODE_RU[A.mode]], ['# мест в школе', A.seats], ['# проверено', `${A.results.length} из ${N}`], ['# ошибок', A.errors.length], ['# дефицит исходно', A.baseDeficit],
      ['ранг', 'квартал', 'сокращение_дефицита', 'остаток_дефицита', 'обеспеченность_территории', 'кварталов_с_улучшением', 'лучший'],
      ...A.results.map((r, k) => [k + 1, r.block, r.reduction, r.deficit, num(r.provision), r.improved, A.best.includes(r.block) ? 'да' : '']),
      ...A.errors.map(e => ['ошибка', e.block, e.error])]);
  };

  // ---------- Сохранённые сценарии ----------
  $('saveScenario').onclick = () => {
    if (!state.scenario) return setMsg('saveMsg', 'Сначала рассчитайте сценарий.', 'err');
    if (isStale()) return setMsg('saveMsg', 'Состав школ изменён после расчёта — пересчитайте сценарий.', 'err');
    const b = baseline(state.mode).total, s = state.scenario.total;
    const name = $('scName').value.trim() || `Сценарий ${state.saved.length + 1}`;
    state.saved.push({ name, mode: state.mode, schools: state.calcSchools.map(x => ({ ...x })), added: state.calcSchools.reduce((a, x) => a + x.seats, 0),
      base: b.deficit, deficit: s.deficit, reduction: b.deficit - s.deficit, prov0: b.provision, prov1: s.provision, improved: countImproved(baseline(state.mode), state.scenario) });
    setMsg('saveMsg', `Сохранено: «${name}».`, 'ok'); $('scName').value = ''; renderSaved();
  };
  function renderSaved() {
    const best = Math.max(...state.saved.map(s => s.reduction), -Infinity);
    $('savedTable').innerHTML = `<thead><tr><th>Сценарий</th><th>Граф</th><th>Школы (кв.:мест)</th><th>+мест</th><th>Дефицит</th><th>Сокращение</th><th>Обеспеч.</th><th></th></tr></thead><tbody>
      <tr><td>Исходное состояние</td><td>${MODE_RU[state.mode]}</td><td>—</td><td>0</td><td>${fmt(baseline(state.mode).total.deficit)}</td><td>0</td><td>${pct(baseline(state.mode).total.provision)}</td><td></td></tr>` +
      state.saved.map((s, k) => `<tr class="${s.reduction === best ? 'best' : ''}"><td>${s.name}</td><td>${MODE_RU[s.mode]}</td><td>${s.schools.map(x => x.block + ':' + x.seats).join(', ')}</td><td>${fmt(s.added)}</td><td>${fmt(s.deficit)}</td><td>${fmt(s.reduction)}</td><td>${pct(s.prov1)}</td><td><button class="btn small" data-rm="${k}">×</button></td></tr>`).join('') + '</tbody>';
    $('savedTable').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { state.saved.splice(+b.dataset.rm, 1); renderSaved(); });
  }
  $('exportSaved').onclick = () => download('scenarios_comparison.csv', [
    ['сценарий', 'граф', 'школы_квартал_мест', 'добавлено_мест', 'дефицит_исходно', 'дефицит_сценарий', 'сокращение_дефицита', 'доля_сокращения', 'обеспеченность_исходно', 'обеспеченность_сценарий', 'кварталов_с_улучшением'],
    ...state.saved.map(s => [s.name, MODE_RU[s.mode], s.schools.map(x => x.block + ':' + x.seats).join(' '), s.added, s.base, s.deficit, s.reduction, num(s.base ? s.reduction / s.base : 0), num(s.prov0), num(s.prov1), s.improved])]);

  // ---------- Переключатели ----------
  function setView(v) { state.view = v; document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === v)); draw(); }
  document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => setView(b.dataset.view));
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => {
    if (autoRunning) return;
    state.mode = b.dataset.mode; document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x === b));
    if (state.scenario) { state.scenario = calc(capacityWith(state.calcSchools), state.mode); setMsg('calcMsg', `Сценарий пересчитан для графа «${MODE_RU[state.mode]}».`, 'ok'); }
    renderAll(); renderAuto();
  });

  function renderAll() { renderStale(); renderMetrics(); renderCmp(); renderSaved(); if (state.selected !== null) renderCard(); draw(); }

  // ---------- Справка ----------
  const capSum = D.capacity.reduce((a, c) => a + c, 0), popSum = D.population.reduce((a, c) => a + c, 0), demSum = D.demand.reduce((a, c) => a + c, 0);
  $('about').innerHTML = `
    <div class="kv" style="max-width:760px;margin-bottom:10px">
      <div>Территория</div><div>${D.city}, ${fmt(N)} кварталов (BlocksNet, Практика 2)</div>
      <div>Население, всего <span class="tag p2">рассчитано в Практике 2</span></div><div>${fmt(popSum)} чел.</div>
      <div>Спрос на места (120 на 1000 жителей, округление вверх по кварталу)</div><div>${fmt(demSum)} мест</div>
      <div>Вместимость существующих школ <span class="tag p2">рассчитано в Практике 2</span></div><div>${fmt(capSum)} мест, ${D.schools.length} объектов OSM</div>
      <div>Медианное время между кварталами: пешком / на машине</div><div>${fmt(D.matrices.walk.medianMin, 1)} / ${fmt(D.matrices.drive.medianMin, 1)} мин</div>
    </div>
    <ul class="muted" style="font-size:13px;line-height:1.55">
      <li><b>Единицы:</b> население и спрос — человек (школьников); вместимость и дефицит — мест; время — минуты; обеспеченность — доля спроса квартала, получившего место в пределах ${ACC} мин (0–100%).</li>
      <li><b>Население</b> — модельная оценка BlocksNet по зданиям OSM, откалиброванная к численности Росстата (132 841 чел. на 01.01.2025); файл <code>examples/data/berezniki/processed/buildings_blocks.geojson</code> (Практика 2, § 7).</li>
      <li><b>Вместимость школ</b> — фактическая численность учеников с портала schoolotzyv.ru (<code>raw/schools_capacity.csv</code>), для школы без данных — 250 мест по умолчанию BlocksNet; агрегирована по кварталам в <code>processed/schools_blocks.geojson</code> (Практика 2, § 8). Дробная часть отбрасывается, как в BlocksNet.</li>
      <li><b>Матрицы времени</b> — <code>processed/accessibility_matrix_walk.csv</code> и <code>_drive.csv</code> (Практика 2, § 6), графы OSM через iduedu: пешеход 5 км/ч, автомобиль — скорость по типу дороги; без общественного транспорта.</li>
      <li><b>Метод</b> — тот же, что в Практике 2: BlocksNet 1.0.0a9 <code>competitive_provision(self_supply=True, max_depth=1)</code>, норматив <code>service_types_config['school']</code>: 120 мест на 1000 жителей, доступность ${ACC} мин. Сначала квартал обеспечивается своими школами, затем остаток спроса распределяется между доступными школами (≤ ${ACC} мин) задачей ЛП: максимум Σ спрос·места/(время+1). В браузере та же задача решается точно как поток минимальной стоимости (транспортная задача, целочисленный оптимум совпадает). Это <i>не</i> простое вычитание вместимости из спроса: новая школа может обеспечить и соседние кварталы в пределах ${ACC} мин.</li>
      <li><b>Дефицит мест</b> — сумма <code>demand_left</code>: школьники, не получившие места в пределах ${ACC} мин с учётом вместимости и доступности.</li>
      <li><b>Неизменные параметры:</b> население, спрос, матрица времени, вместимость существующих школ. Сценарий меняет только вместимость выбранных кварталов.</li>
      <li><b>Ограничения:</b> сравниваются кварталы, а не земельные участки — выбор участка и возможность строительства требуют отдельного градостроительного обоснования. Численность учеников ≠ проектная мощность (возможны вторая смена и переполнение). Население оценено по OSM; в зоне провалов часть домов расселена.</li>
    </ul>`;

  // ---------- Старт ----------
  window.addEventListener('resize', () => { resize(); draw(); });
  resize(); fit(); renderSchools(); checkBaseline(); renderAll();
  window.__app = { state, calc, capacityWith, baseline }; // для проверки из консоли
})();
