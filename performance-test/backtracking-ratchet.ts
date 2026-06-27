#!/usr/bin/env bun
// Backtracking performance ratchet.
//
// Policy:
// - Emits JSON lines for every measured sample.
// - Uses fixed fixtures and fixed seeds so changes are comparable.
// - Enforces only broad p95 thresholds established from 20 measured samples,
//   with >2x headroom over observed Sprint 1 noise. No single guessed timing
//   threshold was written before measurement.

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SimpleTiledModel, parseTileset } from "../helpers/index.js";
import { WFCSolver, WFCSolver3D, type TileRule, type TileRule3D } from "../src/index.js";
import type { SearchOptions, StepStatus } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REPEATS = 20;
const SEEDS = Array.from({ length: REPEATS }, (_, seed) => seed);

interface Threshold {
  /** Max allowed p95 elapsed time across the 20 fixed samples. */
  maxP95Ms: number;
  /** Optional success-rate floor across the 20 fixed samples. */
  minOkRate?: number;
}

// Established in Phase 4 Sprint 1 after a 20-sample measurement run on this
// machine. Each maxP95Ms has >2x headroom over the observed p95 to avoid
// timing-noise flakes while still catching algorithmic regressions.
const THRESHOLDS: Record<string, Threshold> = {
  "summer-16-default-helper": { maxP95Ms: 5, minOkRate: 1 },
  "wfc-2d-rich-default-restart": { maxP95Ms: 1, minOkRate: 0.9 },
  "wfc-2d-rich-opt-in-backtrack": { maxP95Ms: 0.5, minOkRate: 1 },
  "wfc-3d-rich-6cube-backtrack": { maxP95Ms: 15, minOkRate: 1 },
  "wfc-3d-rich-8cube-backtrack": { maxP95Ms: 35, minOkRate: 1 },
};

interface SampleLine {
  kind: "sample";
  scenario: string;
  ok: boolean;
  elapsedMs: number;
  attempts: number;
  backtracks: number | null;
  cells: number;
  seed: number;
}

interface SummaryLine {
  kind: "summary";
  scenario: string;
  ok: boolean;
  runs: number;
  okRate: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  avgBacktracks: number | null;
  maxBacktracks: number | null;
  threshold?: Threshold;
}

const OPP_2D = [2, 3, 0, 1] as const;
const OPP_3D = [1, 0, 3, 2, 5, 4] as const;
const DIR_2D = ["left", "up", "right", "down"] as const;
const DIR_3D = ["left", "right", "up", "down", "front", "back"] as const;
const FACE_NAMES = ["left", "right", "up", "down", "front", "back"] as const;

interface Pipe2DTile {
  name: string;
  open: number[];
}

interface Pipe3DTile {
  name: string;
  open: number[];
  weight: number;
}

function faces2D(...fs: number[]): number[] {
  const m = [0, 0, 0, 0];
  for (const i of fs) m[i] = 1;
  return m;
}

function faces3D(...fs: number[]): number[] {
  const m = [0, 0, 0, 0, 0, 0];
  for (const i of fs) m[i] = 1;
  return m;
}

function buildRichNoEmpty2DTiles(): Pipe2DTile[] {
  return [
    { name: "straight-H", open: faces2D(0, 2) },
    { name: "straight-V", open: faces2D(1, 3) },
    { name: "elbow-LU", open: faces2D(0, 1) },
    { name: "elbow-RU", open: faces2D(2, 1) },
    { name: "elbow-RD", open: faces2D(2, 3) },
    { name: "elbow-LD", open: faces2D(0, 3) },
    { name: "tee-left-up-right", open: faces2D(0, 1, 2) },
    { name: "tee-left-up-down", open: faces2D(0, 1, 3) },
  ];
}

function buildRulesFrom2DTiles(tiles: Pipe2DTile[]): TileRule[] {
  return tiles.map((tile, i) => {
    const rule: TileRule = { forTile: i, left: [], right: [], up: [], down: [] };
    for (let d = 0; d < DIR_2D.length; d++) {
      const allowed: number[] = [];
      const oppD = OPP_2D[d];
      for (let j = 0; j < tiles.length; j++) {
        if (tiles[j].open[oppD] === tile.open[d]) allowed.push(j);
      }
      rule[DIR_2D[d]] = allowed;
    }
    return rule;
  });
}

function buildRichPipe3DTiles(): Pipe3DTile[] {
  const tiles: Pipe3DTile[] = [];
  tiles.push({ name: "empty", open: faces3D(), weight: 1.2 });
  tiles.push({ name: "straight-X", open: faces3D(0, 1), weight: 1.4 });
  tiles.push({ name: "straight-Y", open: faces3D(2, 3), weight: 1.4 });
  tiles.push({ name: "straight-Z", open: faces3D(4, 5), weight: 1.4 });

  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) {
      if (OPP_3D[a] === b) continue;
      tiles.push({
        name: `elbow-${FACE_NAMES[a]}-${FACE_NAMES[b]}`,
        open: faces3D(a, b),
        weight: 0.9,
      });
    }
  }

  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) {
      for (let c = b + 1; c < 6; c++) {
        tiles.push({
          name: `tee-${FACE_NAMES[a]}-${FACE_NAMES[b]}-${FACE_NAMES[c]}`,
          open: faces3D(a, b, c),
          weight: 0.65,
        });
      }
    }
  }

  tiles.push({ name: "junction-6", open: faces3D(0, 1, 2, 3, 4, 5), weight: 0.35 });
  return tiles;
}

function buildRulesFrom3DTiles(tiles: Pipe3DTile[]): TileRule3D[] {
  return tiles.map((tile, i) => {
    const rule: TileRule3D = {
      forTile: i,
      left: [],
      right: [],
      up: [],
      down: [],
      front: [],
      back: [],
    };
    for (let d = 0; d < DIR_3D.length; d++) {
      const allowed: number[] = [];
      const oppD = OPP_3D[d];
      for (let j = 0; j < tiles.length; j++) {
        if (tiles[j].open[oppD] === tile.open[d]) allowed.push(j);
      }
      rule[DIR_3D[d]] = allowed;
    }
    return rule;
  });
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1);
  return sorted[index];
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return Number.NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundMs(n: number): number {
  return Number(n.toFixed(3));
}

function emit(line: SampleLine | SummaryLine): void {
  console.log(JSON.stringify(line));
}

function loadSummerFixture() {
  const xml = readFileSync(join(root, "performance-test", "tilesets", "Summer.xml"), "utf8");
  const tileset = parseTileset(xml, "Summer");
  return {
    tileset,
    width: 16,
    height: 16,
    periodic: false,
  };
}

function runSummerDefault(seed: number): SampleLine {
  const fixture = loadSummerFixture();
  const model = new SimpleTiledModel({
    tileset: fixture.tileset,
    width: fixture.width,
    height: fixture.height,
    periodic: fixture.periodic,
  });

  const t0 = performance.now();
  const ok = model.run(seed, -1);
  const elapsedMs = performance.now() - t0;

  return {
    kind: "sample",
    scenario: "summer-16-default-helper",
    ok: ok && model.isComplete(),
    elapsedMs: roundMs(elapsedMs),
    attempts: 1,
    backtracks: null,
    cells: fixture.width * fixture.height,
    seed,
  };
}

function finalStatus2D(opts: ConstructorParameters<typeof WFCSolver>[0], seed: number, restartBudget: number): StepStatus {
  const solver = new WFCSolver(opts);
  let last: StepStatus | undefined;
  for (const st of solver.stepRun(seed, -1, restartBudget, 999999)) {
    last = st;
    if (st.done) break;
  }
  if (!last) throw new Error("WFCSolver.stepRun produced no status");
  return last;
}

function finalStatus3D(opts: ConstructorParameters<typeof WFCSolver3D>[0], seed: number, restartBudget: number): StepStatus {
  const solver = new WFCSolver3D(opts);
  let last: StepStatus | undefined;
  for (const st of solver.stepRun(seed, -1, restartBudget, 999999)) {
    last = st;
    if (st.done) break;
  }
  if (!last) throw new Error("WFCSolver3D.stepRun produced no status");
  return last;
}

function runSolver2D(
  scenario: string,
  opts: ConstructorParameters<typeof WFCSolver>[0],
  cells: number,
  seed: number,
  restartBudget: number
): SampleLine {
  const t0 = performance.now();
  const st = finalStatus2D(opts, seed, restartBudget);
  const elapsedMs = performance.now() - t0;
  return {
    kind: "sample",
    scenario,
    ok: st.ok === true && st.complete === true,
    elapsedMs: roundMs(elapsedMs),
    attempts: st.attempt + 1,
    backtracks: typeof st.backtracks === "number" ? st.backtracks : null,
    cells,
    seed,
  };
}

function runSolver3D(
  scenario: string,
  opts: ConstructorParameters<typeof WFCSolver3D>[0],
  cells: number,
  seed: number,
  restartBudget: number
): SampleLine {
  const t0 = performance.now();
  const st = finalStatus3D(opts, seed, restartBudget);
  const elapsedMs = performance.now() - t0;
  return {
    kind: "sample",
    scenario,
    ok: st.ok === true && st.complete === true,
    elapsedMs: roundMs(elapsedMs),
    attempts: st.attempt + 1,
    backtracks: typeof st.backtracks === "number" ? st.backtracks : null,
    cells,
    seed,
  };
}

function summarize(scenario: string, samples: SampleLine[]): SummaryLine {
  const times = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const backtracks = samples
    .map((s) => s.backtracks)
    .filter((n): n is number => typeof n === "number");
  const okRate = samples.filter((s) => s.ok).length / samples.length;
  const avgBacktracks = backtracks.length
    ? backtracks.reduce((a, b) => a + b, 0) / backtracks.length
    : null;
  const maxBacktracks = backtracks.length ? Math.max(...backtracks) : null;
  const threshold = THRESHOLDS[scenario];
  const p95Ms = percentile(times, 95);
  const summary: SummaryLine = {
    kind: "summary",
    scenario,
    ok: true,
    runs: samples.length,
    okRate,
    minMs: roundMs(times[0]),
    medianMs: roundMs(median(times)),
    p95Ms: roundMs(p95Ms),
    maxMs: roundMs(times[times.length - 1]),
    avgBacktracks: avgBacktracks == null ? null : Number(avgBacktracks.toFixed(2)),
    maxBacktracks,
    threshold,
  };

  if (threshold) {
    if (p95Ms > threshold.maxP95Ms) summary.ok = false;
    if (threshold.minOkRate != null && okRate < threshold.minOkRate) summary.ok = false;
  }

  return summary;
}

function runScenario(scenario: string, fn: (seed: number) => SampleLine): SummaryLine {
  const samples: SampleLine[] = [];
  // Warm one fixed seed outside the measured 20-sample window.
  fn(999);
  for (const seed of SEEDS) {
    const sample = fn(seed);
    samples.push(sample);
    emit(sample);
  }
  const summary = summarize(scenario, samples);
  emit(summary);
  return summary;
}

function main(): void {
  const rich2D = buildRichNoEmpty2DTiles();
  const rich2DRules = buildRulesFrom2DTiles(rich2D);
  const rich2DWeights = rich2D.map(() => 1);
  const rich2DBase = {
    width: 3,
    height: 3,
    periodic: true,
    weights: rich2DWeights,
    rules: rich2DRules,
    heuristic: "mrv" as const,
  };
  const richBacktrack: SearchOptions = { strategy: "backtrack", maxBacktracks: 4096, maxDepth: 64 };

  const rich3D = buildRichPipe3DTiles();
  const rich3DRules = buildRulesFrom3DTiles(rich3D);
  const rich3DWeights = rich3D.map((t) => t.weight);

  const summaries: SummaryLine[] = [];
  summaries.push(runScenario("summer-16-default-helper", runSummerDefault));
  summaries.push(
    runScenario("wfc-2d-rich-default-restart", (seed) =>
      runSolver2D("wfc-2d-rich-default-restart", rich2DBase, 9, seed, 0)
    )
  );
  summaries.push(
    runScenario("wfc-2d-rich-opt-in-backtrack", (seed) =>
      runSolver2D(
        "wfc-2d-rich-opt-in-backtrack",
        { ...rich2DBase, search: richBacktrack },
        9,
        seed,
        0
      )
    )
  );

  for (const size of [6, 8] as const) {
    const base3D = {
      width: size,
      height: size,
      depth: size,
      periodic: false,
      weights: rich3DWeights,
      rules: rich3DRules,
      heuristic: "mrv" as const,
      search: { strategy: "backtrack" as const, maxBacktracks: 4096, maxDepth: 256 },
    };
    summaries.push(
      runScenario(`wfc-3d-rich-${size}cube-backtrack`, (seed) =>
        runSolver3D(`wfc-3d-rich-${size}cube-backtrack`, base3D, size * size * size, seed, 0)
      )
    );
  }

  const failed = summaries.filter((s) => !s.ok);
  if (failed.length > 0) {
    console.error(
      JSON.stringify({
        kind: "ratchet-failure",
        scenarios: failed.map((s) => s.scenario),
      })
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
