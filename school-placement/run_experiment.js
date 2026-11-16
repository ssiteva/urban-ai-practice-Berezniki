// Эксперимент Практики 3 (A, B, C) тем же модулем model.js, что и в приложении.
// Запуск (нужен Node.js): node school-placement/run_experiment.js  → school-placement/results/
const fs = require('fs'), path = require('path');
const HERE = __dirname; global.window = {};
eval(fs.readFileSync(path.join(HERE, 'data', 'base_data.js'), 'utf8'));
const D = window.BASE_DATA, PM = require(path.join(HERE, 'model.js'));
const OUT = path.join(HERE, 'results'); fs.mkdirSync(OUT, { recursive: true });
const ACC = D.params.accessibility_min, N = D.n;
const SC = {
  A: { title: 'A — одна школа 600 мест, вручную', schools: [[55, 600]] },
  B: { title: 'B — две школы по 300 мест, вручную', schools: [[55, 300], [244, 300]] },
};
const csv = (rows) => '﻿' + rows.map(r => r.join(';')).join('\r\n');
const summary = {};
for (const mode of ['walk', 'drive']) {
  const M = PM.decodeMatrix(D.matrices[mode]);
  const calc = (adds) => { const cap = D.capacity.slice(); adds.forEach(([b, s]) => cap[b] += s); return PM.computeProvision(D.demand, cap, M, N, ACC); };
  const base = calc([]);
  // C: автоподбор, каждый квартал — от исходных данных
  const auto = [];
  for (let i = 0; i < N; i++) { const r = calc([[i, 600]]); auto.push({ block: i, reduction: base.total.deficit - r.total.deficit, deficit: r.total.deficit }); }
  if (auto.length !== N) throw new Error('неполный перебор');
  auto.sort((a, b) => b.reduction - a.reduction || a.block - b.block);
  const best = auto.filter(a => a.reduction === auto[0].reduction).map(a => a.block);
  fs.writeFileSync(path.join(OUT, `auto_search_${mode}_600.csv`), csv([['ранг', 'квартал', 'сокращение_дефицита', 'остаток_дефицита', 'лучший'], ...auto.map((a, k) => [k + 1, a.block, a.reduction, a.deficit, best.includes(a.block) ? 'да' : ''])]));
  const scen = { ...SC, C: { title: `C — одна школа 600 мест, автоподбор (кв. ${best.join(', ')})`, schools: [[best[0], 600]] } };
  summary[mode] = { baseDeficit: base.total.deficit, baseProvision: base.total.provision, best, bestReduction: auto[0].reduction, top10: auto.slice(0, 10), scenarios: {} };
  const rows = [['квартал', 'население', 'спрос', 'места_исходно', 'обеспеч_исходно', 'дефицит_исходно']];
  const res = {};
  for (const [k, s] of Object.entries(scen)) { res[k] = calc(s.schools); rows[0].push(`места_${k}`, `обеспеч_${k}`, `дефицит_${k}`); }
  for (let i = 0; i < N; i++) {
    const r = [i, D.population[i].toFixed(1), D.demand[i], D.capacity[i], base.provision[i].toFixed(4), base.demandLeft[i]];
    for (const [k, s] of Object.entries(scen)) r.push(D.capacity[i] + s.schools.filter(x => x[0] === i).reduce((a, x) => a + x[1], 0), res[k].provision[i].toFixed(4), res[k].demandLeft[i]);
    rows.push(r.map(v => String(v).replace('NaN', '')));
  }
  fs.writeFileSync(path.join(OUT, `blocks_ABC_${mode}.csv`), csv(rows));
  for (const [k, s] of Object.entries(scen)) {
    const r = res[k], improved = [], remain = [];
    for (let i = 0; i < N; i++) { if (r.demandWithin[i] > base.demandWithin[i]) improved.push([i, base.demandWithin[i], r.demandWithin[i], D.demand[i]]); if (r.demandLeft[i] > 0) remain.push([i, r.demandLeft[i]]); }
    remain.sort((a, b) => b[1] - a[1]);
    summary[mode].scenarios[k] = { title: s.title, schools: s.schools, deficit: r.total.deficit, reduction: base.total.deficit - r.total.deficit, provision: r.total.provision,
      improvedCount: improved.length, improved, remainCount: remain.length, remainTop: remain.slice(0, 10) };
  }
}
fs.writeFileSync(path.join(OUT, 'experiment_summary.json'), JSON.stringify(summary, null, 1));
const t = [['граф', 'сценарий', 'школы_квартал_мест', 'дефицит_исходно', 'дефицит', 'сокращение', 'обеспеченность_исходно', 'обеспеченность', 'кварталов_с_улучшением', 'кварталов_с_дефицитом']];
for (const [mode, s] of Object.entries(summary)) for (const [k, v] of Object.entries(s.scenarios))
  t.push([mode === 'walk' ? 'пешком' : 'на машине', v.title, v.schools.map(x => x.join(':')).join(' '), s.baseDeficit, v.deficit, v.reduction, s.baseProvision.toFixed(4), v.provision.toFixed(4), v.improvedCount, v.remainCount]);
fs.writeFileSync(path.join(OUT, 'scenarios_ABC.csv'), csv(t));
console.log(t.map(r => r.join(' | ')).join('\n'));
