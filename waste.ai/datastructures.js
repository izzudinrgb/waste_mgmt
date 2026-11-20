/**
 * datastructures.js
 * Static data: bins, campus graph, scenarios, labels, colours.
 */

// ─── Bins ──────────────────────────────────────────────────────────────────
// 4 hostel bins (one per hostel block, each on a different floor)
// 2 walkway bins
// 1 café bin
// Collection point = where the cleaner starts / ends (not a bin)
//
// x, y  →  position on the SVG campus map (0–800 × 0–520)
// last  = hour the bin was last emptied (simulates a realistic staggered history)
// variance = ±multiplier applied to fill rate so same-type bins diverge (0 = no shift)
export const BINS = [
  // Hostel blocks – emptied at different times; ground floor fills fastest
  { id: "H1", name: "Hostel 1 – Blk A",  place: "Block A, Ground floor", type: "hostel", floor: 0, last:  7, variance:  0.15, x: 120, y: 120 },
  { id: "H2", name: "Hostel 2 – Blk B",  place: "Block B, Level 2",      type: "hostel", floor: 2, last: 10, variance: -0.10, x: 310, y: 100 },
  { id: "H3", name: "Hostel 3 – Blk C",  place: "Block C, Level 3",      type: "hostel", floor: 3, last:  8, variance: -0.20, x: 500, y: 120 },
  { id: "H4", name: "Hostel 4 – Blk D",  place: "Block D, Level 1",      type: "hostel", floor: 1, last: 12, variance:  0.05, x: 680, y: 110 },
  // Walkways – one was emptied recently, the other earlier in the morning
  { id: "W1", name: "Walkway Bin 1",      place: "Main walkway, North",   type: "walk",   floor: 0, last: 11, variance:  0.10, x: 200, y: 300 },
  { id: "W2", name: "Walkway Bin 2",      place: "Main walkway, South",   type: "walk",   floor: 0, last:  7, variance: -0.05, x: 560, y: 310 },
  // Café – emptied after breakfast rush
  { id: "C1", name: "Café Bin",           place: "Student café",          type: "cafe",   floor: 0, last:  9, variance:  0.08, x: 390, y: 430 },
];

// Collection / depot point (not a bin – cleaner's start & end)
export const DEPOT = { id: "DEPOT", name: "Collection Point", x: 390, y: 490 };

// ─── Campus road graph ────────────────────────────────────────────────────
// Undirected weighted graph – edges represent walkable paths (metres).
// Node ids map to BINS[].id or "DEPOT".
export const GRAPH_EDGES = [
  // Hostel row connections
  { a: "H1", b: "H2", d: 60 },
  { a: "H2", b: "H3", d: 60 },
  { a: "H3", b: "H4", d: 60 },
  // Hostels down to walkway
  { a: "H1", b: "W1", d: 70 },
  { a: "H2", b: "W1", d: 55 },
  { a: "H3", b: "W2", d: 55 },
  { a: "H4", b: "W2", d: 70 },
  // Walkway spine
  { a: "W1", b: "W2", d: 120 },
  // Walkway to café
  { a: "W1", b: "C1", d: 80 },
  { a: "W2", b: "C1", d: 80 },
  // Café to depot
  { a: "C1",   b: "DEPOT", d: 30 },
  // Walkways to depot (shortcut path)
  { a: "W1",   b: "DEPOT", d: 100 },
  { a: "W2",   b: "DEPOT", d: 100 },
  // Cross-links (diagonal paths on campus)
  { a: "H1", b: "DEPOT", d: 160 },
  { a: "H4", b: "DEPOT", d: 160 },
];

// ─── Fill-level colours ───────────────────────────────────────────────────
export const LEVEL_COLOURS = [
  "var(--l0)",  // 0 – Empty
  "var(--l1)",  // 1 – Low
  "var(--l2)",  // 2 – Fairly full
  "var(--l3)",  // 3 – Full
];

export const LEVEL_LABELS = ["Empty", "Low", "Fairly full", "Full"];

// ─── Scenario presets ─────────────────────────────────────────────────────
export const SCENARIOS = {
  lunch: { day: "weekday", period: "normal", wx: "dry",  hr: 13, sel: 0 },
  exam:  { day: "weekday", period: "exam",   wx: "dry",  hr: 21, sel: 1 },
  event: { day: "weekday", period: "event",  wx: "dry",  hr: 17, sel: 5 },
  rain:  { day: "weekend", period: "normal", wx: "rain", hr: 15, sel: 4 },
};

// ─── Default "last emptied" times (used by Reset) ─────────────────────────
// Mirrors the `last` values above so Reset restores a varied baseline, not all-7.
export const DEFAULT_LAST = { H1: 7, H2: 10, H3: 8, H4: 12, W1: 11, W2: 7, C1: 9 };

// ─── Simulation tick ──────────────────────────────────────────────────────
export const TICK_MINUTES = 24;
