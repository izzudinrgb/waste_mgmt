/**
 * simulation.js
 * Fill-rate prediction + Dijkstra shortest-path solver.
 * All functions are pure – no DOM access.
 */

import { TICK_MINUTES, BINS, GRAPH_EDGES, DEPOT } from "./datastructures.js";

// ─── Fill prediction ───────────────────────────────────────────────────────

/**
 * Hourly fill rate for one bin under the given conditions (0–1 multiplier).
 */
export function rate(bin, h, state) {
  let r = 0;
  const isWeekend = state.day === "weekend";

  if (bin.type === "cafe") {
    if      (h >= 7  && h < 10) r = 0.6;
    else if (h >= 12 && h < 15) r = 1.0;
    else if (h >= 18 && h < 21) r = 0.9;
    else                        r = 0.15;
    if (isWeekend) r *= 0.55;

  } else if (bin.type === "hostel") {
    r = h >= 16 ? 0.55 : 0.12;
    if (h >= 22) r = 0.3;
    if (isWeekend) r = Math.max(r, 0.4);
    if (state.period === "exam") r *= 1.5;
    // Upper floors fill slightly slower (more stairs = less casual use)
    if (bin.floor >= 3) r *= 0.80;
    else if (bin.floor === 2) r *= 0.90;

  } else {
    // walkway
    r = (h >= 8 && h < 18) ? 0.3 : 0.05;
    if (h >= 12 && h < 14) r = 0.5;
    if (isWeekend) r *= 0.4;
    if (state.wx === "rain") r *= 0.6;
  }

  if (state.period === "event" && h >= 14 && h <= 20)
    r *= bin.type === "walk" ? 2.4 : bin.type === "cafe" ? 1.5 : 1;

  if (state.period === "exam" && bin.type === "cafe") r *= 1.15;

  // Per-bin variance: shifts the rate slightly so same-type bins differ.
  // variance is a small ± fraction stored on each bin in datastructures.js.
  r *= (1 + (bin.variance ?? 0));

  return r;
}

/** Predicted fill % for a bin at hour h. */
export function fillAt(bin, h, state) {
  let sum = 0;
  for (let t = bin.last; t < h; t++) sum += rate(bin, t, state) * TICK_MINUTES;
  return Math.min(100, sum);
}

/** Level index 0-3 from fill %. */
export function level(pct) {
  if (pct < 15) return 0;
  if (pct < 45) return 1;
  if (pct < 80) return 2;
  return 3;
}

/** Confidence % (degrades with time since last empty). */
export function confidence(bin, h) {
  return Math.max(55, Math.round(90 - 4 * (h - bin.last)));
}

// ─── Dijkstra shortest path ────────────────────────────────────────────────

/**
 * Build an adjacency map from GRAPH_EDGES.
 * Cached after first call — the graph never changes at runtime.
 * @returns {Map<string, {to:string, d:number}[]>}
 */
let _graphCache = null;
function buildGraph() {
  if (_graphCache) return _graphCache;
  const g = new Map();
  const allNodes = [...BINS.map(b => b.id), DEPOT.id];
  allNodes.forEach(n => g.set(n, []));
  GRAPH_EDGES.forEach(({ a, b, d }) => {
    g.get(a).push({ to: b, d });
    g.get(b).push({ to: a, d });
  });
  _graphCache = g;
  return g;
}

/**
 * Dijkstra from `start` to all nodes. Returns { dist, prev } maps.
 */
function dijkstra(graph, start) {
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();

  graph.forEach((_, n) => dist.set(n, Infinity));
  dist.set(start, 0);

  while (true) {
    // Pick unvisited node with smallest dist
    let u = null;
    dist.forEach((d, n) => {
      if (!visited.has(n) && (u === null || d < dist.get(u))) u = n;
    });
    if (u === null || dist.get(u) === Infinity) break;
    visited.add(u);

    for (const { to, d } of (graph.get(u) || [])) {
      const alt = dist.get(u) + d;
      if (alt < dist.get(to)) {
        dist.set(to, alt);
        prev.set(to, u);
      }
    }
  }
  return { dist, prev };
}

/** Reconstruct path array from prev map. */
function buildPath(prev, target) {
  const path = [];
  let cur = target;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return path;
}

/**
 * All-pairs shortest distances + paths, computed once per unique source.
 * Cached so repeated calls (e.g. animation frames) don't re-run Dijkstra.
 */
const _dijkCache = new Map();
function dijkstraFrom(start) {
  if (_dijkCache.has(start)) return _dijkCache.get(start);
  const result = dijkstra(buildGraph(), start);
  _dijkCache.set(start, result);
  return result;
}

/**
 * Shortest path between two node ids.
 * @returns {{ path: string[], dist: number }}
 */
export function shortestPath(fromId, toId) {
  const { dist, prev } = dijkstraFrom(fromId);
  return {
    path: buildPath(prev, toId),
    dist: dist.get(toId) ?? Infinity,
  };
}

/**
 * Collector route: TRUE optimal TSP via brute-force permutation search.
 * With ≤10 targets this is instant (10! = 3.6M, but we prune early).
 * Falls back to nearest-neighbour for >10 targets.
 *
 * Returns { route: string[], totalDist: number }
 * route starts and ends at "DEPOT".
 */
export function collectorRoute(state, hr, minLevel = 2) {
  const graph = buildGraph();
  const targets = BINS
    .filter(b => level(fillAt(b, hr, state)) >= minLevel)
    .map(b => b.id);

  if (targets.length === 0) return { route: ["DEPOT"], totalDist: 0 };

  // Pre-compute all pairwise shortest distances (Dijkstra from each node once, cached)
  const nodes = ["DEPOT", ...targets];
  const distCache = new Map();
  nodes.forEach(n => {
    const { dist } = dijkstraFrom(n);
    distCache.set(n, dist);
  });
  const getD = (a, b) => distCache.get(a)?.get(b) ?? Infinity;

  // ── Brute-force optimal permutation (≤10 targets) ──────────────────────
  if (targets.length <= 10) {
    let bestDist = Infinity;
    let bestPerm = null;

    // Generate permutations with branch-and-bound pruning
    // current = last node visited, soFar = nodes visited in order, remaining = unvisited
    function permute(remaining, current, soFar, currentDist) {
      if (currentDist >= bestDist) return; // prune
      if (remaining.length === 0) {
        const total = currentDist + getD(current, "DEPOT");
        if (total < bestDist) { bestDist = total; bestPerm = [...soFar]; }
        return;
      }
      for (let i = 0; i < remaining.length; i++) {
        const next = remaining[i];
        const d    = getD(current, next);
        if (currentDist + d >= bestDist) continue; // prune
        const rest = remaining.filter((_, j) => j !== i);
        permute(rest, next, [...soFar, next], currentDist + d);
      }
    }

    // Seed upper bound from nearest-neighbour so pruning kicks in early
    const nnRoute = nearestNeighbour(targets, getD);
    bestDist = nnRoute.totalDist;
    bestPerm = nnRoute.order;

    permute(targets, "DEPOT", [], 0);

    const route = ["DEPOT", ...bestPerm, "DEPOT"];
    return { route, totalDist: bestDist };
  }

  // ── Fallback: nearest-neighbour for large sets ──────────────────────────
  const { order, totalDist } = nearestNeighbour(targets, getD);
  return { route: ["DEPOT", ...order, "DEPOT"], totalDist };
}

/** Greedy nearest-neighbour heuristic. Returns { order, totalDist }. */
function nearestNeighbour(targets, getD) {
  const unvisited = new Set(targets);
  let current = "DEPOT";
  const order = [];
  let totalDist = 0;
  while (unvisited.size > 0) {
    let nearest = null, nearD = Infinity;
    unvisited.forEach(n => { const d = getD(current, n); if (d < nearD) { nearest = n; nearD = d; } });
    if (!nearest) break;
    order.push(nearest);
    totalDist += nearD;
    unvisited.delete(nearest);
    current = nearest;
  }
  totalDist += getD(current, "DEPOT");
  return { order, totalDist };
}

/**
 * Student path: shortest path from a given node to the nearest bin
 * that has available space (level < 3).
 *
 * @returns {{ binId: string, path: string[], dist: number } | null}
 */
export function nearestAvailableBin(fromId, state, hr) {
  const { dist, prev } = dijkstraFrom(fromId);

  let best = null;
  BINS.forEach(b => {
    const pct = fillAt(b, hr, state);
    const lvl = level(pct);
    if (lvl < 3 && b.id !== fromId) {
      const d = dist.get(b.id) ?? Infinity;
      if (best === null || d < best.dist) {
        best = { binId: b.id, path: buildPath(prev, b.id), dist: d };
      }
    }
  });

  return best;
}
