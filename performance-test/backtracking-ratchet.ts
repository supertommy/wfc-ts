#!/usr/bin/env bun
// Phase 4 Sprint 0 independent verification harness.
// backtracking-ratchet.ts — emits DIAGNOSTICS only (no guessed thresholds, no enforced gates).
//
// Reports for fixed fixtures:
// - default restart speed
// - opt-in backtrack speed
// - success rate (over fixed seeds)
// - backtrack counts
//
// Run: bun run performance-test/backtracking-ratchet.ts
// Always exits 0 in Sprint 0. Thresholds added in later sprints after measurement.

import { performance } from "node:perf_hooks";
import { WFCSolver, type TileRule } from "../src/solver.js";
import type { StepStatus } from "../src/types.js";

const OPP_2D = [2, 3, 0, 1];

function faces2D(...fs: number[]): number[] {
  const m = [0, 0, 0, 0];
  for (const i of fs) m[i] = 1;
  return m;
}

interface Pipe2DTile {
  name: string;
  open: number[];
}

function buildRichNoEmpty2DTiles(): Pipe2DTile[] {
  return [
    { name: "straight-H", open: faces2D(0, 2) },
    { name: "straight-V", open: faces2D(1, 3) },
    // elbows
    { name: "elbow-LU", open: faces2D(0, 1) },
    { name: "elbow-RU", open: faces2D(2, 1) },
    { name: "elbow-RD", open: faces2D(2, 3) },
    { name: "elbow-LD", open: faces2D(0, 3) },
    // tees (3 openings)
    { name: "tee-left-up-right", open: faces2D(0, 1, 2) },
    { name: "tee-left-up-down", open: faces2D(0, 1, 3) },
  ];
}

function buildRulesFrom2DTiles(tiles: Pipe2DTile[]): TileRule[] {
  const dirKeys = ["left", "up", "right", "down"] as const;
  return tiles.map((tile, i) => {
    const rule = { forTile: i } as any;
    for (let d = 0; d < 4; d++) {
      const allowed: number[] = [];
      const oppD = OPP_2D[d];
      for (let j = 0; j < tiles.length; j++) {
        if (tiles[j].open[oppD] === tile.open[d]) allowed.push(j);
      }
      rule[dirKeys[d]] = allowed;
    }
    return rule as TileRule;
  });
}

// Simple fully-compatible tileset (any tile next to any) — always solvable in one attempt.
function buildTrivialRules(T: number): TileRule[] {
  const all = Array.from({ length: T }, (_, i) => i);
  return all.map((forTile) => ({
    forTile,
    left: all,
    right: all,
    up: all,
    down: all,
  }));
}

interface RunMetrics {
  success: boolean;
  timeMs: number;
  backtracks?: number;
  attempts: number;
}

function timeRunWithBudget(
  opts: any,
  seed: number,
  restartBudget: number
): { timeMs: number; success: boolean } {
  const solver = new WFCSolver(opts);
  const t0 = performance.now();
  const ok = solver.run(seed, -1, restartBudget);
  const dt = performance.now() - t0;
  return { timeMs: dt, success: !!ok };
}

function collectFinalStatus(
  opts: any,
  seed: number,
  restartBudget: number
): StepStatus | undefined {
  const solver = new WFCSolver(opts);
  let last: StepStatus | undefined;
  for (const st of solver.stepRun(seed, -1, restartBudget, 999999)) {
    last = st;
    if (st.done) break;
  }
  return last;
}

function fmtMs(x: number): string {
  return x.toFixed(3) + "ms";
}

function runDiagnostics() {
  console.log("=== BACKTRACKING RATCHET DIAGNOSTICS (Phase 4 Sprint 0) ===");
  console.log("No thresholds enforced — raw measurements only. Always exits 0.");
  console.log("Fixed fixtures only. Uses public WFCSolver + stepRun for backtrack counts.");
  console.log("");

  // === FIXTURE 1: trivial (baseline restart speed, no backtrack needed) ===
  const trivialRules = buildTrivialRules(4);
  const trivialWeights = [1, 1, 1, 1];
  const trivialOptsDefault = {
    width: 8,
    height: 8,
    periodic: false,
    weights: trivialWeights,
    rules: trivialRules,
    heuristic: "mrv" as const,
  };
  const trivialOptsBack = {
    ...trivialOptsDefault,
    search: { strategy: "backtrack" as const, maxBacktracks: 4096, maxDepth: 256 },
  };

  const r1 = timeRunWithBudget(trivialOptsDefault, 42, 100);
  const r1b = timeRunWithBudget(trivialOptsBack, 42, 0);
  const st1b = collectFinalStatus(trivialOptsBack, 42, 0);

  console.log("FIXTURE: trivial-8x8 (always succeeds, measures pure strategy overhead)");
  console.log(`  default-restart (budget=100): success=${r1.success} time=${fmtMs(r1.timeMs)}`);
  console.log(
    `  opt-in-backtrack (budget=0):   success=${r1b.success} time=${fmtMs(r1b.timeMs)} backtracks=${st1b?.backtracks ?? "n/a"}`
  );
  console.log("");

  // === FIXTURE 2: rich-pipes (restart single fails; backtrack recovers) ===
  const tiles = buildRichNoEmpty2DTiles();
  const richRules = buildRulesFrom2DTiles(tiles);
  const richWeights = tiles.map(() => 1);
  const richOptsDefault = {
    width: 3,
    height: 3,
    periodic: true,
    weights: richWeights,
    rules: richRules,
    heuristic: "mrv" as const,
  };
  const richOptsBack = {
    ...richOptsDefault,
    search: { strategy: "backtrack" as const, maxBacktracks: 4096, maxDepth: 64 },
  };

  // default restart single attempt
  const r2s0 = timeRunWithBudget(richOptsDefault, 13, 0);
  // default restart with budget (may recover via restarts)
  const r2s100 = timeRunWithBudget(richOptsDefault, 13, 100);
  // backtrack single attempt
  const r2b0 = timeRunWithBudget(richOptsBack, 13, 0);
  const st2b = collectFinalStatus(richOptsBack, 13, 0);

  console.log("FIXTURE: rich-pipes-3x3-periodic (seed 13: restart@0 fails, backtrack recovers)");
  console.log(`  default-restart (budget=0):  success=${r2s0.success} time=${fmtMs(r2s0.timeMs)}`);
  console.log(`  default-restart (budget=100): success=${r2s100.success} time=${fmtMs(r2s100.timeMs)}`);
  console.log(
    `  opt-in-backtrack (budget=0): success=${r2b0.success} time=${fmtMs(r2b0.timeMs)} backtracks=${st2b?.backtracks ?? "n/a"}`
  );
  console.log("");

  // === SUCCESS RATES over fixed seeds (budget=0 single attempt) ===
  const SEEDS = 20;
  let restartSuccess = 0;
  let backSuccess = 0;
  const btCounts: number[] = [];

  for (let s = 0; s < SEEDS; s++) {
    const rs = timeRunWithBudget(richOptsDefault, s, 0);
    if (rs.success) restartSuccess++;

    const bs = timeRunWithBudget(richOptsBack, s, 0);
    if (bs.success) backSuccess++;

    const st = collectFinalStatus(richOptsBack, s, 0);
    if (st && typeof st.backtracks === "number") {
      btCounts.push(st.backtracks);
    }
  }

  const restartRate = (restartSuccess / SEEDS) * 100;
  const backRate = (backSuccess / SEEDS) * 100;

  console.log(`SUCCESS RATES (seeds 0..${SEEDS - 1}, restartBudget=0, 3x3 rich-pipes periodic, mrv)`);
  console.log(`  restart-only: ${restartSuccess}/${SEEDS} (${restartRate.toFixed(1)}%)`);
  console.log(`  backtrack:    ${backSuccess}/${SEEDS} (${backRate.toFixed(1)}%)`);
  console.log("");

  // === BACKTRACK COUNTS (for the backtrack runs that succeeded) ===
  if (btCounts.length > 0) {
    const sorted = [...btCounts].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const sum = btCounts.reduce((a, b) => a + b, 0);
    const avg = sum / btCounts.length;
    const med = sorted.length % 2 ? sorted[(sorted.length - 1) >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    console.log(`BACKTRACK COUNTS (observed on ${btCounts.length} successful backtrack runs, seeds 0..${SEEDS-1})`);
    console.log(`  min=${min} max=${max} avg=${avg.toFixed(2)} median=${med}`);
  } else {
    console.log("BACKTRACK COUNTS: no successful backtrack runs in sample");
  }
  console.log("");

  console.log("=== END DIAGNOSTICS (Sprint 0 — thresholds not yet enforced) ===");
}

if (import.meta.main) {
  runDiagnostics();
  // Always success in Sprint 0; later sprints may add threshold checks that exit(1) on regression.
  process.exit(0);
}
