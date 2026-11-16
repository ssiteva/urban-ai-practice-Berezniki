/*
 * Расчёт обеспеченности школами — перенос метода BlocksNet 1.0.0a9
 * blocksnet.analysis.provision.competitive_provision (Практика 2):
 *   1) demand = ceil(population / 1000 * 120);
 *   2) самообеспечение: квартал сначала занимает места своих школ, min(demand, capacity);
 *   3) остаток распределяется задачей ЛП (в BlocksNet — PuLP/CBC):
 *        max  Σ w_ij · x_ij,   w_ij = demand_left_i · capacity_left_j / (t_ij + 1)
 *        Σ_j x_ij ≤ demand_left_i,   Σ_i x_ij ≤ capacity_left_j,   x_ij ≥ 0 целые,
 *      только для пар с временем t_ij ≤ 15 мин (max_depth = 1).
 * Это транспортная задача: её матрица ограничений вполне унимодулярна, поэтому
 * целочисленный оптимум совпадает с оптимумом потока минимальной стоимости,
 * который здесь и считается (без внешних солверов).
 */
(function (root) {
  'use strict';

  function minCostMaxWeight(nI, nJ, supplyI, capJ, arcs) {
    // arcs: [{i, j, w}] ; узлы: 0 = источник, 1..nI = спрос, nI+1..nI+nJ = школы, N-1 = сток
    const N = nI + nJ + 2, S = 0, T = N - 1;
    const head = new Int32Array(N).fill(-1);
    const to = [], cap = [], cost = [], next = [];
    function add(u, v, c, w) {
      to.push(v); cap.push(c); cost.push(w); next.push(head[u]); head[u] = to.length - 1;
      to.push(u); cap.push(0); cost.push(-w); next.push(head[v]); head[v] = to.length - 1;
    }
    for (let a = 0; a < nI; a++) add(S, 1 + a, supplyI[a], 0);
    for (let b = 0; b < nJ; b++) add(1 + nI + b, T, capJ[b], 0);
    const arcEdge = new Int32Array(arcs.length);
    for (let k = 0; k < arcs.length; k++) {
      arcEdge[k] = to.length;
      add(1 + arcs[k].i, 1 + nI + arcs[k].j, 1e15, -arcs[k].w);
    }
    const dist = new Float64Array(N), inq = new Uint8Array(N), prevE = new Int32Array(N);
    const queue = new Int32Array(N + 1);
    const EPS = 1e-9;
    for (let guard = 0; guard < 1e6; guard++) {
      dist.fill(Infinity); prevE.fill(-1); dist[S] = 0;
      let qh = 0, qt = 0, qn = 0; queue[qt++] = S; qn++; inq[S] = 1;
      while (qn > 0) {
        const u = queue[qh]; qh = (qh + 1) % (N + 1); qn--; inq[u] = 0;
        for (let e = head[u]; e !== -1; e = next[e]) {
          if (cap[e] > 0) {
            const v = to[e], nd = dist[u] + cost[e];
            if (nd < dist[v] - EPS) {
              dist[v] = nd; prevE[v] = e;
              if (!inq[v]) { queue[qt] = v; qt = (qt + 1) % (N + 1); qn++; inq[v] = 1; }
            }
          }
        }
      }
      if (!(dist[T] < -EPS)) break; // нет улучшающего пути — оптимум
      let f = Infinity;
      for (let v = T; v !== S; v = to[prevE[v] ^ 1]) f = Math.min(f, cap[prevE[v]]);
      for (let v = T; v !== S; v = to[prevE[v] ^ 1]) { cap[prevE[v]] -= f; cap[prevE[v] ^ 1] += f; }
    }
    const flow = new Float64Array(arcs.length);
    for (let k = 0; k < arcs.length; k++) flow[k] = cap[arcEdge[k] ^ 1];
    return flow;
  }

  /**
   * demand: Int array (по кварталам), capacity: Int array (места),
   * matrix: {rowPtr, cols, vals} — время в пути, мин (строка = квартал спроса, столбец = квартал школы)
   * Возвращает показатели по кварталам и итоги — те же поля, что в provision_*.geojson.
   */
  function computeProvision(demand, capacity, matrix, n, accessibility) {
    const dl = new Float64Array(n), cl = new Float64Array(n);
    const dWithin = new Float64Array(n), cWithin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.min(demand[i], capacity[i]);
      dWithin[i] = s; cWithin[i] = s; dl[i] = demand[i] - s; cl[i] = capacity[i] - s;
    }
    const I = [], J = [];
    for (let i = 0; i < n; i++) { if (dl[i] > 0) I.push(i); if (cl[i] > 0) J.push(i); }
    // matrix — разреженная матрица {rowPtr, cols, vals}: только пары с t ≤ accessibility
    const jIndex = new Int32Array(n).fill(-1);
    for (let b = 0; b < J.length; b++) jIndex[J[b]] = b;
    const arcs = [];
    for (let a = 0; a < I.length; a++) {
      const i = I[a];
      for (let k = matrix.rowPtr[i]; k < matrix.rowPtr[i + 1]; k++) {
        const j = matrix.cols[k], b = jIndex[j], t = matrix.vals[k];
        if (b >= 0 && t <= accessibility) arcs.push({ i: a, j: b, w: dl[i] * cl[j] / (t + 1) });
      }
    }
    const links = [];
    if (arcs.length) {
      const flow = minCostMaxWeight(I.length, J.length, I.map(i => dl[i]), J.map(j => cl[j]), arcs);
      for (let k = 0; k < arcs.length; k++) {
        const v = Math.round(flow[k]);
        if (v > 0) {
          const i = I[arcs[k].i], j = J[arcs[k].j];
          dWithin[i] += v; dl[i] -= v; cWithin[j] += v; cl[j] -= v;
          links.push([i, j, v]);
        }
      }
    }
    let totD = 0, totW = 0, totLeft = 0, totCap = 0, totCapLeft = 0;
    const provision = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      provision[i] = demand[i] > 0 ? dWithin[i] / demand[i] : NaN;
      totD += demand[i]; totW += dWithin[i]; totLeft += dl[i]; totCap += capacity[i]; totCapLeft += cl[i];
    }
    return {
      demandWithin: dWithin, demandLeft: dl, capacityWithin: cWithin, capacityLeft: cl, provision, links,
      total: { demand: totD, within: totW, deficit: totLeft, capacity: totCap, capacityLeft: totCapLeft,
               provision: totD > 0 ? totW / totD : (totCap > 0 ? 1 : 0) }
    };
  }

  function b64bytes(s) {
    if (typeof atob === 'function') {
      const bin = atob(s), out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  function decodeMatrix(m) {
    const rp = b64bytes(m.rowPtr), c = b64bytes(m.cols), v = b64bytes(m.vals);
    const rowPtr = new Uint32Array(rp.buffer, rp.byteOffset, rp.byteLength / 4);
    const cols = new Uint16Array(c.buffer, c.byteOffset, c.byteLength / 2);
    const raw = new Uint32Array(v.buffer, v.byteOffset, v.byteLength / 4);
    const vals = new Float64Array(raw.length);
    for (let k = 0; k < raw.length; k++) vals[k] = raw[k] / m.scale; // те же double, что при чтении CSV
    return { rowPtr, cols, vals };
  }

  const api = { computeProvision, minCostMaxWeight, decodeMatrix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ProvisionModel = api;
})(typeof self !== 'undefined' ? self : this);
