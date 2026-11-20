/**
 * app.js  –  BinBeat UI controller
 * Animated Dijkstra + truck route simulation on the campus map.
 */

import {
  BINS, DEPOT, LEVEL_COLOURS, LEVEL_LABELS,
  SCENARIOS, GRAPH_EDGES, DEFAULT_LAST
} from "./datastructures.js";
import {
  fillAt, level, confidence,
  collectorRoute, shortestPath, nearestAvailableBin
} from "./simulation.js";

// ─── Global state ──────────────────────────────────────────────────────────
const state = {
  day: "weekday", period: "normal", wx: "dry",
  hr: 14, sel: 0, timer: null,
  mapMode: "collector",
  studentFrom: "DEPOT",
};

// ─── Animation state (map page only) ──────────────────────────────────────
const anim = {
  running:    false,
  rafId:      null,
  phase:      "idle",   // "dijkstra" | "travel" | "draining" | "walk" | "done" | "idle"
  speed:      1,
  dijkVisited:  [],
  dijkStep:     0,
  dijkTimer:    0,
  fullPath:     [],
  pathIdx:      0,
  truckX:       0,
  truckY:       0,
  visitedBins:  new Set(),
  // Drain animation (plays when truck arrives at a bin)
  drainingBinId: null,  // id of bin currently being drained
  drainPct:      0,     // current visual fill % during drain (counts down)
  drainFrom:     0,     // fill % when drain started
  drainTimer:    0,     // seconds elapsed in drain
  walkPath:     [],
  walkIdx:      0,
  walkerX:      0,
  walkerY:      0,
  waypointEdgeMap: [],
};

// ─── Helpers ───────────────────────────────────────────────────────────────
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const pad = n  => (n < 10 ? "0" : "") + n + ":00";
const lerp = (a, b, t) => a + (b - a) * t;

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast on";
  setTimeout(() => { t.className = "toast"; }, 2000);
}

function nodeById(id) {
  return id === "DEPOT" ? DEPOT : BINS.find(b => b.id === id);
}

// ─── Navigation ────────────────────────────────────────────────────────────
function goTo(pageId) {
  $$(".page").forEach(p => p.classList.remove("active"));
  $$(".nav-item").forEach(b => b.classList.remove("active"));
  $(pageId)?.classList.add("active");
  document.querySelector(`.nav-item[data-page="${pageId}"]`)?.classList.add("active");
  document.querySelector(".sidenav").classList.remove("open");
  document.querySelector(".nav-overlay").classList.remove("open");
  if (pageId === "page-map") { stopAnim(); renderMap(); }
}

$$(".nav-item").forEach(btn => btn.addEventListener("click", () => goTo(btn.dataset.page)));
$("navToggle").addEventListener("click", () => {
  document.querySelector(".sidenav").classList.toggle("open");
  document.querySelector(".nav-overlay").classList.toggle("open");
});
document.querySelector(".nav-overlay").addEventListener("click", () => {
  document.querySelector(".sidenav").classList.remove("open");
  document.querySelector(".nav-overlay").classList.remove("open");
});

// ─── Shared top-bar ────────────────────────────────────────────────────────
function syncSegments() {
  [["sDay","day"],["sPeriod","period"],["sWx","wx"]].forEach(([id, key]) => {
    $(id)?.querySelectorAll("button")
      .forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state[key]));
  });
}
function wireSegment(elId, key) {
  $(elId)?.addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.v) return;
    state[key] = btn.dataset.v;
    syncSegments();
    render();
  });
}
wireSegment("sDay", "day");
wireSegment("sPeriod", "period");
wireSegment("sWx", "wx");
$("hr").addEventListener("input", function () { state.hr = +this.value; render(); });

// ─── Sidebar scenarios ─────────────────────────────────────────────────────
document.querySelectorAll(".sc-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const sc = SCENARIOS[btn.dataset.sc];
    if (!sc) return;
    BINS.forEach(b => { b.last = DEFAULT_LAST[b.id] ?? 7; });
    Object.assign(state, sc);
    syncSegments(); render();
    showToast("Scenario: " + btn.textContent.trim());
  });
});
$("reset").addEventListener("click", () => {
  BINS.forEach(b => { b.last = DEFAULT_LAST[b.id] ?? 7; });
  render();
  showToast("All bins reset");
});

// ─── Dashboard: bins ───────────────────────────────────────────────────────

/** Returns the effective fill % for a bin, accounting for animation collection. */
function effectiveFill(bin) {
  if (anim.visitedBins.has(bin.id)) return 0;
  if (anim.drainingBinId === bin.id) return anim.drainPct;
  return fillAt(bin, state.hr, state);
}

function renderBins() {
  $("binsGrid").innerHTML = BINS.map((b, i) => {
    const pct  = effectiveFill(b);
    const lvl  = level(pct);
    const conf = confidence(b, state.hr);
    const collected = anim.visitedBins.has(b.id);
    return `
      <button class="bin-card" data-i="${i}" aria-pressed="${i === state.sel}">
        <div class="gauge">
          <div class="tank"><i style="height:${Math.max(collected ? 0 : 4, pct)}%;background:${LEVEL_COLOURS[lvl]}"></i></div>
          <div>
            <h3>${b.name}</h3>
            <p class="place">${b.place}</p>
            <div class="lvl-num">${collected ? "✅" : "Lv " + lvl}</div>
            <span class="tag" style="background:${collected ? "var(--l0)" : LEVEL_COLOURS[lvl]}">${collected ? "Emptied" : LEVEL_LABELS[lvl]}</span>
          </div>
        </div>
        <p class="bin-meta">${collected ? "Just emptied" : pad(b.last) + " · " + conf + "%"}</p>
      </button>`;
  }).join("");
}
$("binsGrid").addEventListener("click", e => {
  const card = e.target.closest(".bin-card");
  if (card) { state.sel = +card.dataset.i; render(); }
});

// ─── Dashboard: schedule ───────────────────────────────────────────────────
function renderSchedule() {
  const list = BINS
    .map(b => {
      const pct = effectiveFill(b);
      return { b, pct, lvl: level(pct) };
    })
    .sort((a, z) => z.pct - a.pct);
  const go   = list.filter(x => x.lvl >= 2);
  const skip = list.filter(x => x.lvl < 2);

  let html = "";
  go.forEach((x, n) => {
    const urg = x.lvl === 3 ? "🔴 Full" : "🟡 Fairly full";
    html += `<div class="task"><div><b>${n+1}. ${x.b.name}</b>
      <span>${urg} · ${Math.round(x.pct)}%</span></div>
      <button class="btn sm" data-done="${x.b.id}">✓ Done</button></div>`;
  });
  if (!go.length) html += `<p class="note" style="padding:6px 0">✅ All bins are fine right now.</p>`;
  skip.forEach(x => {
    html += `<div class="task skip"><div><b>Skip: ${x.b.name}</b>
      <span>${Math.round(x.pct)}% full</span></div></div>`;
  });

  $("sched").innerHTML = html;
  $("stTrips").textContent = go.length;
  $("stSkip").textContent  = skip.length;
  $("stSave").textContent  = Math.round(skip.length / BINS.length * 100) + "%";
  window._schedText =
    "BinBeat round at " + pad(state.hr) + "\n" +
    (go.map((x,i) => `${i+1}. ${x.b.name} (${x.b.place}) - ${LEVEL_LABELS[x.lvl]}`).join("\n") || "No collection needed") +
    (skip.length ? "\nSkip: " + skip.map(x => x.b.name).join(", ") : "");
}
$("sched").addEventListener("click", e => {
  const done = e.target.closest("[data-done]");
  if (!done) return;
  BINS.forEach(b => {
    if (b.id === done.dataset.done) { b.last = state.hr; showToast(`${b.name} emptied`); }
  });
  render();
});
$("copy").addEventListener("click", () => {
  navigator.clipboard?.writeText(window._schedText || "")
    .then(() => showToast("Schedule copied"), () => showToast("Copy unavailable"));
});
$("play").addEventListener("click", function () {
  if (state.timer) {
    clearInterval(state.timer); state.timer = null;
    this.textContent = "▶ Play"; return;
  }
  this.textContent = "⏸ Pause";
  if (state.hr >= 23) state.hr = 7;
  state.timer = setInterval(() => {
    if (state.hr >= 23) {
      clearInterval(state.timer); state.timer = null;
      $("play").textContent = "▶ Play"; return;
    }
    state.hr++; render();
  }, 700);
});

// ─── Dashboard: chart ──────────────────────────────────────────────────────
function renderChart() {
  const b = BINS[state.sel];
  const W = 500, H = 170, x0 = 20, bw = 22, gap = 5;
  $("chTitle").textContent = `Forecast: ${b.name}`;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:400px" role="img">`;
  for (let t = 7; t <= 23; t++) {
    // If the bin was collected this run, show it as empty from current hour onward
    const pct = anim.visitedBins.has(b.id) && t >= state.hr
      ? 0
      : fillAt(b, Math.min(t+1, 23), state);
    const lv  = level(pct);
    const x   = x0 + (t-7) * (bw + gap);
    const bh  = pct / 100 * 115;
    const on  = t === state.hr;
    svg += `<rect x="${x}" y="${130-bh}" width="${bw}" height="${Math.max(2,bh)}"
      rx="3" fill="${LEVEL_COLOURS[lv]}" opacity="${on?1:.5}"
      ${on?'stroke="currentColor" stroke-width="2"':''}></rect>`;
    if (t % 2 === 1) svg += `<text x="${x+bw/2}" y="148" text-anchor="middle">${t}</text>`;
  }
  svg += `<line x1="${x0}" x2="${W-6}" y1="130" y2="130" stroke="var(--line)"/>`;
  svg += `<text x="${x0}" y="165">Hour of day</text></svg>`;
  $("chart").innerHTML = svg;

  const typeDesc = { cafe:"café – peaks after meals", hostel:"hostel – rises in evening", walk:"walkway – steady daytime" };
  const bullets = [`Location: ${typeDesc[b.type]}`];
  bullets.push(`Day: ${state.day}${state.day==="weekend"?" – lower café & walkway":""}`);
  if (state.period === "exam")  bullets.push("Exam week – hostel bins fill ~50% faster");
  if (state.period === "event") bullets.push("Campus event – walkway & café surge 14–20h");
  if (state.wx === "rain")      bullets.push("Rain – fewer people outside, walkway slower");
  bullets.push(`${Math.max(0, state.hr - b.last)}h since last emptied`);
  $("why").innerHTML = bullets.map(s => `<li>${s}</li>`).join("");
}

// ════════════════════════════════════════════════════════════════════════════
//  MAP PAGE  –  Animated Dijkstra + truck / walker simulation
// ════════════════════════════════════════════════════════════════════════════

// ─── Mode buttons ──────────────────────────────────────────────────────────
$$(".map-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    state.mapMode = btn.dataset.mode;
    $$(".map-mode-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === state.mapMode));
    $("studentPanel").style.display   = state.mapMode === "student"   ? "" : "none";
    $("collectorPanel").style.display = state.mapMode === "collector" ? "" : "none";
    stopAnim();
    renderMap();
  });
});

// ─── Student picker ────────────────────────────────────────────────────────
function populateStudentPicker() {
  const sel = $("studentFrom");
  sel.innerHTML = "";
  [...BINS, DEPOT].forEach(n => {
    const opt = document.createElement("option");
    opt.value = n.id;
    opt.textContent = n.id === "DEPOT" ? "📍 Collection Point" : n.name;
    sel.appendChild(opt);
  });
  sel.value = state.studentFrom;
}
$("studentFrom")?.addEventListener("change", function () {
  state.studentFrom = this.value; stopAnim(); renderMap();
});
$("findBinBtn")?.addEventListener("click", () => { stopAnim(); renderMap(); });

// ─── Simulation controls ───────────────────────────────────────────────────
$("simPlay")?.addEventListener("click",  () => toggleAnim());
$("simStep")?.addEventListener("click",  () => stepAnim());
$("simReset")?.addEventListener("click", () => { stopAnim(); renderMap(); });
$("simSpeed")?.addEventListener("input", function () {
  anim.speed = +this.value;
  $("simSpeedLabel").textContent = this.value + "×";
});

// ─── Animation control ─────────────────────────────────────────────────────
function stopAnim() {
  if (anim.rafId) { cancelAnimationFrame(anim.rafId); anim.rafId = null; }
  anim.running       = false;
  anim.phase         = "idle";
  anim.visitedBins.clear();
  anim.drainingBinId = null;
  anim.drainPct      = 0;
  anim.drainTimer    = 0;
  anim.waypointEdgeMap = [];
  updateSimBtn(false);
}

function updateSimBtn(running) {
  const btn = $("simPlay");
  if (btn) btn.textContent = running ? "⏸ Pause" : "▶ Play";
}

function toggleAnim() {
  if (anim.phase === "idle" || anim.phase === "done") {
    prepareAnim();
  }
  anim.running = !anim.running;
  updateSimBtn(anim.running);
  if (anim.running) requestFrame();
}

function stepAnim() {
  if (anim.phase === "idle" || anim.phase === "done") prepareAnim();
  anim.running = false;
  updateSimBtn(false);
  advanceOneStep();
  drawAnimFrame();
}

function requestFrame() {
  if (!anim.running) return;
  anim.rafId = requestAnimationFrame(loop);
}

let lastTs = 0;
function loop(ts) {
  if (!anim.running) return;
  const delta = Math.min((ts - lastTs) / 1000, 0.1) * anim.speed;
  lastTs = ts;
  advanceTime(delta);
  drawAnimFrame();
  if (anim.phase !== "done") requestFrame();
  else { anim.running = false; updateSimBtn(false); }
}

// ─── Prepare animation data ────────────────────────────────────────────────
function prepareAnim() {
  anim.visitedBins.clear();

  if (state.mapMode === "collector") {
    // Build Dijkstra visualisation order (all nodes from DEPOT)
    anim.dijkVisited = buildDijkstraOrder("DEPOT");
    anim.dijkStep    = 0;
    anim.dijkTimer   = 0;

    // Build flat waypoint list: depot → bin1 → bin2 … → depot
    const { route } = collectorRoute(state, state.hr, 2);
    anim.fullPath = buildWaypoints(route);
    anim.pathIdx  = 0;
    if (anim.fullPath.length) {
      anim.truckX = anim.fullPath[0].x;
      anim.truckY = anim.fullPath[0].y;
    }
    anim.phase = "dijkstra";
  } else {
    // Student: skip dijkstra phase, go straight to walk
    const result = nearestAvailableBin(state.studentFrom, state, state.hr);
    if (!result) { anim.phase = "done"; return; }
    anim.walkPath = result.path.map(id => nodeById(id)).filter(Boolean);
    anim.walkIdx  = 0;
    if (anim.walkPath.length) {
      anim.walkerX = anim.walkPath[0].x;
      anim.walkerY = anim.walkPath[0].y;
    }
    anim.dijkVisited = buildDijkstraOrder(state.studentFrom);
    anim.dijkStep    = 0;
    anim.dijkTimer   = 0;
    anim.phase = "dijkstra";
  }
}

/** Returns node ids in the order Dijkstra would visit them from `start`. */
function buildDijkstraOrder(start) {
  // Build adjacency
  const g = new Map();
  [...BINS, DEPOT].forEach(n => g.set(n.id, []));
  GRAPH_EDGES.forEach(({ a, b, d }) => {
    g.get(a)?.push({ to: b, d });
    g.get(b)?.push({ to: a, d });
  });

  const dist    = new Map([...[...BINS, DEPOT].map(n => [n.id, Infinity])]);
  const visited = new Set();
  const order   = [];
  dist.set(start, 0);

  while (true) {
    let u = null;
    dist.forEach((d, n) => { if (!visited.has(n) && (u === null || d < dist.get(u))) u = n; });
    if (u === null || dist.get(u) === Infinity) break;
    visited.add(u);
    order.push(u);
    for (const { to, d } of (g.get(u) || [])) {
      const alt = dist.get(u) + d;
      if (alt < dist.get(to)) dist.set(to, alt);
    }
  }
  return order;
}

/**
 * Expand a high-level route (array of node ids) into dense pixel waypoints
 * by interpolating along each Dijkstra sub-path.
 * Returns [{x, y, binId?, depotArrival?}]
 * Also populates anim.waypointEdgeMap: waypoint index → routeEdgeSeq index
 */
function buildWaypoints(route) {
  const STEPS_PER_UNIT = 0.6;
  const pts = [];
  anim.waypointEdgeMap = [];   // parallel array: pts[i] was on edge edgeSeqIdx[i]
  let edgeSeqIdx = 0;

  for (let i = 0; i < route.length - 1; i++) {
    const seg = shortestPath(route[i], route[i + 1]);
    for (let j = 0; j < seg.path.length - 1; j++) {
      const na = nodeById(seg.path[j]);
      const nb = nodeById(seg.path[j + 1]);
      if (!na || !nb) continue;
      const dist  = Math.hypot(nb.x - na.x, nb.y - na.y);
      const steps = Math.max(2, Math.round(dist * STEPS_PER_UNIT));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        pts.push({ x: lerp(na.x, nb.x, t), y: lerp(na.y, nb.y, t) });
        anim.waypointEdgeMap.push(edgeSeqIdx);
      }
      edgeSeqIdx++;
    }
    const dest = nodeById(route[i + 1]);
    if (dest) {
      pts.push({
        x: dest.x, y: dest.y,
        binId:        route[i + 1] !== "DEPOT" ? route[i + 1] : undefined,
        depotArrival: route[i + 1] === "DEPOT" && i > 0,
      });
      anim.waypointEdgeMap.push(edgeSeqIdx); // arrival point counts as that edge done
    }
  }
  return pts;
}

/**
 * Given a waypoint index, return how many route-graph edges have been
 * fully traversed — i.e. the first edge index still ahead of the truck.
 */
function waypointIndexToEdgeIndex(wpIdx) {
  if (!anim.waypointEdgeMap || !anim.waypointEdgeMap.length) return 0;
  const idx = Math.min(wpIdx, anim.waypointEdgeMap.length - 1);
  // The edge the truck is currently ON should still show as ahead,
  // so we use the map value directly (edge is "passed" only after the truck
  // moves to the NEXT edge index).
  return anim.waypointEdgeMap[idx] ?? 0;
}

// ─── Advance animation ─────────────────────────────────────────────────────
const DIJKSTRA_STEP_SECS = 0.08;   // seconds per Dijkstra node reveal
const TRUCK_SPEED_PX     = 120;    // pixels per second at speed×1
const DRAIN_DURATION     = 0.55;   // seconds to drain one bin to empty

function advanceTime(dt) {
  if (anim.phase === "dijkstra") {
    anim.dijkTimer += dt;
    const steps = Math.floor(anim.dijkTimer / DIJKSTRA_STEP_SECS);
    anim.dijkTimer -= steps * DIJKSTRA_STEP_SECS;
    anim.dijkStep = Math.min(anim.dijkStep + steps, anim.dijkVisited.length);
    if (anim.dijkStep >= anim.dijkVisited.length) {
      anim.phase = state.mapMode === "collector" ? "travel" : "walk";
    }
    return;
  }

  // ── Drain phase: truck is stationary, animating the bin emptying ────────
  if (anim.phase === "draining") {
    anim.drainTimer += dt;
    const progress = Math.min(anim.drainTimer / DRAIN_DURATION, 1);
    // Ease out: fast at first, slows as it approaches empty
    anim.drainPct = anim.drainFrom * (1 - progress * progress);

    if (progress >= 1) {
      // Drain complete — mark bin as fully emptied, resume travel
      anim.drainPct = 0;
      const bin = BINS.find(b => b.id === anim.drainingBinId);
      if (bin) bin.last = state.hr;
      anim.visitedBins.add(anim.drainingBinId);
      anim.drainingBinId = null;
      // Check if this was the last waypoint
      if (anim.pathIdx >= anim.fullPath.length - 1) {
        anim.phase = "done";
      } else {
        anim.phase = "travel";
      }
    }
    return;
  }

  if (anim.phase === "travel") {
    moveTo(anim.fullPath, "pathIdx", "truckX", "truckY", TRUCK_SPEED_PX * dt);
    // Check if truck has just arrived at a bin stop
    const wp = anim.fullPath[anim.pathIdx];
    if (wp?.binId && !anim.visitedBins.has(wp.binId) && anim.drainingBinId !== wp.binId) {
      // Start drain animation — truck pauses here
      const bin = BINS.find(b => b.id === wp.binId);
      anim.drainingBinId = wp.binId;
      anim.drainFrom     = bin ? fillAt(bin, state.hr, state) : 100;
      anim.drainPct      = anim.drainFrom;
      anim.drainTimer    = 0;
      anim.phase         = "draining";
      return;
    }
    if (anim.pathIdx >= anim.fullPath.length - 1) anim.phase = "done";
  }

  if (anim.phase === "walk") {
    moveTo(anim.walkPath, "walkIdx", "walkerX", "walkerY", TRUCK_SPEED_PX * dt);
    if (anim.walkIdx >= anim.walkPath.length - 1) anim.phase = "done";
  }
}

function advanceOneStep() {
  advanceTime(DIJKSTRA_STEP_SECS * 2);
}

/** Move along a waypoint array, updating idx and x/y. */
function moveTo(pts, idxKey, xKey, yKey, maxMove) {
  if (anim[idxKey] >= pts.length - 1) return;
  let remaining = maxMove;
  while (remaining > 0 && anim[idxKey] < pts.length - 1) {
    const target = pts[anim[idxKey] + 1];
    const dx = target.x - anim[xKey];
    const dy = target.y - anim[yKey];
    const dist = Math.hypot(dx, dy);
    if (dist <= remaining) {
      anim[xKey] = target.x;
      anim[yKey] = target.y;
      anim[idxKey]++;
      remaining -= dist;
    } else {
      const t = remaining / dist;
      anim[xKey] += dx * t;
      anim[yKey] += dy * t;
      remaining = 0;
    }
  }
}

// ─── Draw one animation frame ───────────────────────────────────────────────
function drawAnimFrame() {
  const svgEl = $("campusMap");
  if (!svgEl) return;

  const revealedNodes = new Set(anim.dijkVisited.slice(0, anim.dijkStep));

  // ── Compute route edges split into "ahead" vs "passed" ──────────────────
  // aheadEdges  = edges the truck hasn't reached yet (draw highlighted)
  // passedNodes = bin/depot nodes already visited (bin shown emptied)
  const aheadEdges  = new Set();
  const routeNodes  = new Set();

  let routeForEdges = [];
  if (state.mapMode === "collector") {
    const { route } = collectorRoute(state, state.hr, 2);
    routeForEdges = route;
  } else {
    const result = nearestAvailableBin(state.studentFrom, state, state.hr);
    if (result) routeForEdges = result.path;
  }

  // Expand the high-level route into the actual graph-edge sequence
  // Each entry: { a, b } node-id pair on the path
  const routeEdgeSeq = [];   // ordered list of {a,b} as the truck travels them
  for (let i = 0; i < routeForEdges.length - 1; i++) {
    const seg = shortestPath(routeForEdges[i], routeForEdges[i + 1]);
    seg.path.forEach((n, j) => {
      routeNodes.add(n);
      if (j > 0) routeEdgeSeq.push({ a: seg.path[j - 1], b: seg.path[j] });
    });
  }

  // During travel: figure out how far along the waypoint list the truck is,
  // then map that back to which edge sequence index we're on.
  // Waypoints carry the same order as routeEdgeSeq — count which waypoints
  // have been passed and use that to split ahead vs behind.
  let truckEdgeIdx = 0;  // index into routeEdgeSeq — everything < this is passed
  if ((anim.phase === "travel" || anim.phase === "walk") && anim.fullPath.length) {
    // Each waypoint between two graph nodes corresponds to one edge traversal.
    // We track edge transitions by counting how many times the truck has moved
    // between adjacent named graph nodes.
    // Simpler: walk fullPath up to pathIdx and count how many graph-node
    // transitions (waypoints with a binId or depotArrival marker) occurred —
    // but those markers are only on bin arrivals, not intermediate nodes.
    // Better approach: pre-build a lookup of waypoint-index → edge-seq-index.
    truckEdgeIdx = waypointIndexToEdgeIndex(anim.pathIdx);
  } else if (anim.phase === "done") {
    truckEdgeIdx = routeEdgeSeq.length; // all passed
  }

  // Edges ahead of truck are highlighted; passed edges are invisible
  for (let i = truckEdgeIdx; i < routeEdgeSeq.length; i++) {
    const { a, b } = routeEdgeSeq[i];
    aheadEdges.add(a + "-" + b);
    aheadEdges.add(b + "-" + a);
  }

  let c = campusBackground();

  // ── Draw edges ────────────────────────────────────────────────────────────
  GRAPH_EDGES.forEach(({ a, b }) => {
    const na = nodeById(a), nb = nodeById(b);
    if (!na || !nb) return;
    const ahead    = aheadEdges.has(a + "-" + b) || aheadEdges.has(b + "-" + a);
    const explored = revealedNodes.has(a) && revealedNodes.has(b);
    // Passed route edges: draw nothing (they disappear once the truck passes)
    // Ahead route edges: bright solid accent
    // Dijkstra-explored non-route edges: faint dashed
    // Unvisited: very faint dotted
    let stroke = "var(--line)", sw = 1.5, op = 0.3, dash = "5,4";
    if (ahead)         { stroke = "var(--accent)"; sw = 4;   op = 1;   dash = ""; }
    else if (explored) { stroke = "var(--accent)"; sw = 1.5; op = 0.25; dash = "4,4"; }
    c += `<line x1="${na.x}" y1="${na.y}" x2="${nb.x}" y2="${nb.y}"
      stroke="${stroke}" stroke-width="${sw}"
      stroke-dasharray="${dash}" opacity="${op}"/>`;
  });

  // ── Dijkstra phase: show expanding rings ──────────────────────────────────
  if (anim.phase === "dijkstra") {
    revealedNodes.forEach(id => {
      const n = nodeById(id);
      if (!n) return;
      c += `<circle cx="${n.x}" cy="${n.y}" r="18"
        fill="var(--accent)" opacity="0.10"
        stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3,3"/>`;
    });
  }

  // ── Depot ─────────────────────────────────────────────────────────────────
  c += drawDepot(DEPOT, routeNodes.has("DEPOT") || revealedNodes.has("DEPOT"));

  // ── Bins ──────────────────────────────────────────────────────────────────
  BINS.forEach(b => {
    const pct      = fillAt(b, state.hr, state);
    const lv       = level(pct);
    const draining = anim.drainingBinId === b.id;
    // While draining: animate fill down. Once in visitedBins: drawBin handles ghost render.
    const displayPct = draining ? anim.drainPct : pct;
    const displayLv  = draining ? level(anim.drainPct) : lv;
    const onRoute    = routeNodes.has(b.id);
    const explored   = revealedNodes.has(b.id);
    const isStart    = state.mapMode === "student" && b.id === state.studentFrom;
    c += drawBin(b, displayLv, displayPct, onRoute || draining, isStart, explored && !onRoute);
    // Drain progress ring around the bin being emptied
    if (draining) {
      const progress = Math.min(1, anim.drainTimer / DRAIN_DURATION);
      const r = 26, circ = 2 * Math.PI * r;
      const dashLen = circ * progress;
      const gapLen  = circ * (1 - progress);
      c += `<circle cx="${b.x}" cy="${b.y}" r="${r}"
        fill="none" stroke="var(--l0)" stroke-width="3"
        stroke-dasharray="${dashLen.toFixed(1)} ${gapLen.toFixed(1)}"
        stroke-dashoffset="${(circ / 4).toFixed(1)}"
        opacity="0.9"/>`;
    }
  });

  // ── Visit-order numbers (collector, travel phase) ─────────────────────────
  if (state.mapMode === "collector" && anim.phase !== "idle") {
    const { route } = collectorRoute(state, state.hr, 2);
    route.filter(r => r !== "DEPOT").forEach((id, i) => {
      if (anim.visitedBins.has(id)) return;  // hide number once bin is emptied
      const n = nodeById(id);
      if (!n) return;
      c += `<text x="${n.x + 16}" y="${n.y - 14}"
        font-size="12" font-weight="800"
        fill="var(--accent)" stroke="var(--card)" stroke-width="3" paint-order="stroke">${i + 1}</text>`;
    });
  }

  // ── Truck / Walker ────────────────────────────────────────────────────────
  if ((anim.phase === "travel" || anim.phase === "draining" || anim.phase === "done") && state.mapMode === "collector") {
    c += drawTruck(anim.truckX, anim.truckY);
  }
  if ((anim.phase === "walk" || anim.phase === "done") && state.mapMode === "student") {
    c += drawWalker(anim.walkerX, anim.walkerY);
  }

  // ── Phase label ───────────────────────────────────────────────────────────
  const phaseLabel = {
    dijkstra: "⚙️ Running Dijkstra…",
    travel:   "🚛 Truck collecting…",
    draining: `🗑️ Emptying ${anim.drainingBinId ?? "bin"}…`,
    walk:     "🚶 Walking to bin…",
    done:     "✅ Route complete!",
    idle:     "",
  }[anim.phase] || "";
  if (phaseLabel) {
    c += `<rect x="10" y="10" width="200" height="26" rx="8"
      fill="var(--card)" opacity="0.9"/>
      <text x="20" y="27" font-size="12" font-weight="700"
      fill="var(--ink)">${phaseLabel}</text>`;
  }

  svgEl.innerHTML = c;
  updateRouteInfo();

  svgEl.querySelectorAll("[data-bin-id]").forEach(el => {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => {
      const idx = BINS.findIndex(b => b.id === el.dataset.binId);
      if (idx >= 0) { state.sel = idx; renderChart(); showToast(BINS[idx].name + " selected"); }
    });
  });
}

function updateRouteInfo() {
  if (state.mapMode === "collector") {
    const { route, totalDist } = collectorRoute(state, state.hr, 2);
    const stops = route.filter(r => r !== "DEPOT");
    const done  = [...anim.visitedBins].length;
    const info  = stops.length === 0
      ? "✅ All bins below threshold."
      : `🚛 ${stops.length} stop${stops.length>1?"s":""} · ~${totalDist} m · ${done}/${stops.length} done`;
    $("routeInfoBox").innerHTML = `<b>${info}</b>` + buildStepsHTML(route);
  } else {
    const result = nearestAvailableBin(state.studentFrom, state, state.hr);
    if (!result) {
      $("routeInfoBox").innerHTML = `<b>⚠️ All bins are full!</b>`;
    } else {
      const tb  = nodeById(result.binId);
      const pct = fillAt(tb, state.hr, state);
      $("routeInfoBox").innerHTML =
        `🎓 Nearest available: <b>${tb.name}</b> (${Math.round(pct)}% full) · ~${result.dist} m` +
        buildStepsHTML(result.path);
    }
  }
}

// ─── Static map render (idle state) ────────────────────────────────────────
function renderMap() {
  anim.phase = "idle";
  anim.visitedBins.clear();
  anim.dijkStep = 0;
  drawAnimFrame();
}

// ─── SVG drawing helpers ───────────────────────────────────────────────────
function campusBackground() {
  return `
    <rect width="800" height="480" rx="10" fill="var(--soft)" opacity="0.45"/>
    <rect x="60"  y="58"  width="690" height="88" rx="10" fill="var(--accent)" opacity="0.06"/>
    <text x="400" y="78"  text-anchor="middle" font-size="11" fill="var(--mute)" font-weight="600">HOSTEL BLOCKS</text>
    <rect x="140" y="258" width="490" height="82" rx="8"  fill="#8bb53a" opacity="0.07"/>
    <text x="400" y="254" text-anchor="middle" font-size="11" fill="var(--mute)" font-weight="600">MAIN WALKWAY</text>
    <rect x="315" y="398" width="150" height="52" rx="10" fill="var(--l2)"    opacity="0.11"/>
    <text x="400" y="394" text-anchor="middle" font-size="11" fill="var(--mute)" font-weight="600">CAFÉ</text>
    <rect x="352" y="458" width="96"  height="24" rx="6"  fill="#444"         opacity="0.07"/>
  `;
}

function drawDepot(node, hl) {
  const { x, y } = node;
  return `<g data-node-id="DEPOT">
    <circle cx="${x}" cy="${y}" r="17"
      fill="${hl?"var(--accent)":"var(--card)"}"
      stroke="${hl?"var(--accent)":"#888"}" stroke-width="2"/>
    <text x="${x}" y="${y+5}" text-anchor="middle" font-size="13">📍</text>
    <text x="${x}" y="${y+28}" text-anchor="middle" font-size="10"
      fill="var(--mute)" font-weight="600">Depot</text>
  </g>`;
}

function drawBin(bin, lvl, pct, onRoute, isStart, explored) {
  const { x, y, id } = bin;
  const col    = ["#3f9d6b","#8bb53a","#e39a1f","#d64533"][lvl];
  const tW = 16, tH = 24;
  const tX = x - tW/2, tY = y - tH/2;
  const fillH = Math.max(0, Math.round(pct / 100 * tH));
  const border = isStart ? "var(--accent2)" : onRoute ? "var(--accent)" : col;
  const sw     = onRoute || isStart ? 2.5 : 1.5;

  // ── Collected bin: show as a faded empty ghost, not a full node ──────────
  const collected = anim.visitedBins.has(id);
  if (collected) {
    return `<g data-bin-id="${id}" opacity="0.28">
      <rect x="${tX}" y="${tY}" width="${tW}" height="${tH}"
        rx="3" fill="var(--soft)" stroke="var(--l0)" stroke-width="1.5"
        stroke-dasharray="3,3"/>
      <text x="${x}" y="${tY + tH/2 + 4}" text-anchor="middle"
        font-size="10" fill="var(--l0)">✓</text>
      <text x="${x}" y="${tY + tH + 13}" text-anchor="middle"
        font-size="10" fill="var(--mute)">${id}</text>
    </g>`;
  }

  let ring = "";
  if (onRoute || isStart) ring = `<circle cx="${x}" cy="${y}" r="22" fill="var(--accent)" opacity="0.14"/>`;
  else if (explored)      ring = `<circle cx="${x}" cy="${y}" r="20" fill="var(--accent)" opacity="0.08" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3,3"/>`;

  return `<g data-bin-id="${id}">${ring}
    <rect x="${tX}" y="${tY}" width="${tW}" height="${tH}"
      rx="3" fill="var(--card)" stroke="${border}" stroke-width="${sw}"/>
    ${fillH > 0 ? `<rect x="${tX+2}" y="${tY+tH-fillH-2}" width="${tW-4}" height="${fillH}"
      rx="2" fill="${col}"/>` : ""}
    <text x="${x}" y="${tY+tH+13}" text-anchor="middle"
      font-size="10" font-weight="700"
      fill="${onRoute?"var(--accent)":"var(--mute)"}">${id}</text>
    <text x="${x}" y="${tY+tH+23}" text-anchor="middle"
      font-size="9" fill="var(--mute)">${Math.round(pct)}%</text>
  </g>`;
}

function drawTruck(x, y) {
  // Simple truck icon: rectangle body + wheels + chimney
  return `<g transform="translate(${x},${y})">
    <circle r="14" fill="#0f6b5c" opacity="0.9"/>
    <text y="5" text-anchor="middle" font-size="16">🚛</text>
  </g>`;
}

function drawWalker(x, y) {
  return `<g transform="translate(${x},${y})">
    <circle r="12" fill="var(--accent2)" opacity="0.9"/>
    <text y="5" text-anchor="middle" font-size="14">🚶</text>
  </g>`;
}

function buildStepsHTML(route) {
  if (route.length <= 1) return "";
  const steps = route.map(id => {
    const n = nodeById(id);
    return `<span class="step">${id === "DEPOT" ? "📍 Depot" : (n ? n.name : id)}</span>`;
  }).join(`<span class="arrow">→</span>`);
  return `<div class="route-steps">${steps}</div>`;
}

// ─── Master render ─────────────────────────────────────────────────────────
function render() {
  $("clock").textContent = pad(state.hr);
  $("hr").value = state.hr;
  renderBins();
  renderSchedule();
  renderChart();
  if ($("page-map").classList.contains("active")) {
    if (anim.phase === "idle" || anim.phase === "done") renderMap();
    else drawAnimFrame();
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────
populateStudentPicker();
syncSegments();
render();
goTo("page-dashboard");
