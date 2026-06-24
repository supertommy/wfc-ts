// Median-of-N timing protocol. Warms up once, then times N individual run()
// calls per solver and reports each solver's median plus the speedup ratio.
//
// Timing policy (mirrors the collision repo): model construction (XML parse +
// propagator build) is excluded — only run() is timed, and run() is the core
// work being optimized. A warmup run precedes measurement so the first-call
// interpreter/JIT cost does not pollute the median.

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

/** Time N run() calls on a freshly-built model (after one warmup), return ms[]. */
async function timedRuns(kind: SolverKind, spec: InputSpec, N: number): Promise<number[]> {
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

  // Warmup (excluded from measurement).
  model.run(spec.seed, spec.limit);

  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    model.run(spec.seed, spec.limit);
    times.push(performance.now() - t0);
  }
  return times;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export interface SpeedupReport {
  name: string;
  N: number;
  refMedianMs: number;
  optMedianMs: number;
  speedup: number;
  refTimes: number[];
  optTimes: number[];
}

export async function measureSpeedup(spec: InputSpec, N: number): Promise<SpeedupReport> {
  const refTimes = await timedRuns("reference", spec, N);
  const optTimes = await timedRuns("optimized", spec, N);
  const refMedianMs = median(refTimes);
  const optMedianMs = median(optTimes);
  return {
    name: spec.name,
    N,
    refMedianMs,
    optMedianMs,
    speedup: optMedianMs > 0 ? refMedianMs / optMedianMs : 0,
    refTimes,
    optTimes,
  };
}

// CLI: measure-speedup.ts <specName> [N]
if (import.meta.main) {
  const [specName, NArg] = process.argv.slice(2);
  if (!specName) {
    console.error("usage: measure-speedup.ts <specName> [N=5]");
    process.exit(2);
  }
  const N = NArg ? Number(NArg) : 5;
  const spec = loadInputSpec(specName);
  measureSpeedup(spec, N).then((r) => {
    console.log(
      `SPEEDUP ${r.name} (median-of-${r.N}): ref ${r.refMedianMs.toFixed(3)}ms | opt ${r.optMedianMs.toFixed(3)}ms | speedup ${r.speedup.toFixed(2)}x`,
    );
  });
}