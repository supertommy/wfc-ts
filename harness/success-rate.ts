// Success-rate metric — the gate for the success/robustness axis.
//
// The speed gate (prove-harness) only checks the committed seeds, which all
// complete. But WFC's real-world quality is: over MANY seeds, how often does
// the solver actually produce a complete valid tiling vs. hit a contradiction?
// Hard inputs (e.g. knots-dense) contradict frequently without backtracking.
// Success-axis candidates (restart-with-derived-seeds, CDCL conflict learning,
// look-ahead selection) are judged here: does the optimized complete MORE often
// than the reference (no-backtracking) baseline, and at what time cost?
//
// Protocol: build the model once (construction excluded), then run seed s for
// s in [0, N). A run "completes" iff run() returns true AND isComplete().
// Reports: completion count / N, contradiction count, median ms of COMPLETED
// runs only (contradictions are fast; including them would skew the time).
// Runs both reference and optimized so the baseline-vs-candidate gap is visible.
//
// Trusted: lives in harness/ (optimizers may not edit it). CLI:
//   bun run harness/success-rate.ts <specName> [N=100]

import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadInputSpec, tilesetXml } from "./io.js";
import type { InputSpec } from "./types.js";
import type { SolverKind } from "./run.js";

const here = dirname(fileURLToPath(import.meta.url));

function solverEntry(kind: SolverKind): string {
  const rel = kind === "reference" ? "../src/index.ts" : "../src-optimized/index.ts";
  return pathToFileURL(join(here, rel)).href;
}

interface RateResult {
  kind: SolverKind;
  N: number;
  completed: number;
  contradicted: number;
  completionRate: number;
  medianCompletedMs: number;
}

async function measureRate(kind: SolverKind, spec: InputSpec, N: number): Promise<RateResult> {
  const mod = await import(solverEntry(kind));
  const xml = tilesetXml(spec.tileset);
  const tileset = mod.parseTileset(xml, spec.tileset);
  const model = new mod.SimpleTiledModel({
    tileset,
    subsetName: spec.subset,
    width: spec.width,
    height: spec.height,
    periodic: spec.periodic,
  });

  // Warmup (excluded).
  model.run(0, spec.limit);

  let completed = 0;
  let contradicted = 0;
  const completedTimes: number[] = [];
  for (let s = 0; s < N; s++) {
    const t0 = performance.now();
    const ok = model.run(s, spec.limit);
    const dt = performance.now() - t0;
    if (ok && model.isComplete()) {
      completed++;
      completedTimes.push(dt);
    } else {
      contradicted++;
    }
  }
  const sorted = completedTimes.sort((a, b) => a - b);
  const medianCompletedMs = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) >> 1]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : NaN;
  return {
    kind,
    N,
    completed,
    contradicted,
    completionRate: completed / N,
    medianCompletedMs,
  };
}

if (import.meta.main) {
  const [specName, NArg] = process.argv.slice(2);
  if (!specName) {
    console.error("usage: success-rate.ts <specName> [N=100]");
    process.exit(2);
  }
  const N = NArg ? Number(NArg) : 100;
  const spec = loadInputSpec(specName);
  const ref = await measureRate("reference", spec, N);
  const opt = await measureRate("optimized", spec, N);
  const fmt = (r: RateResult) =>
    `${r.kind.padEnd(10)} completed ${String(r.completed).padStart(3)}/${r.N} (${(r.completionRate * 100).toFixed(1)}%)  contradicted ${String(r.contradicted).padStart(3)}  median(completed) ${isNaN(r.medianCompletedMs) ? "n/a" : r.medianCompletedMs.toFixed(3) + "ms"}`;
  console.log(`SUCCESS-RATE ${spec.name} (N=${N}, seeds 0..${N - 1})`);
  console.log(fmt(ref));
  console.log(fmt(opt));
  console.log(`delta (opt-ref completion): ${((opt.completionRate - ref.completionRate) * 100).toFixed(1)} pts`);
}