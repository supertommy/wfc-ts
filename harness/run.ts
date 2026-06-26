// Runs a solver (reference or optimized) on a committed input and writes the
// result. Both src/ and src-optimized/ export the same SimpleTiledModel +
// parseTileset, so the harness treats them symmetrically — pass the solver's
// entry path as the first argument.
//
// Timing policy (mirrors the collision repo excluding build-stage precompute):
// model construction (XML parse + propagator build) is NOT timed. The timed
// region is run(), which includes the lazy wave init + the observe/propagate
// loop — the core work being optimized.

import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadInputSpec, tilesetXml, checksum, writeResult } from "./io.js";
import type { RunResult, InputSpec } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export type SolverKind = "reference" | "optimized";

/** Map a solver kind to its absolute entry path. */
export function solverEntry(kind: SolverKind): string {
  const rel = kind === "reference" ? "../reference/index.ts" : "../helpers/index.ts";
  return pathToFileURL(join(here, rel)).href;
}

export async function runSolver(
  kind: SolverKind,
  spec: InputSpec,
): Promise<RunResult> {
  const mod = await import(solverEntry(kind));
  const SimpleTiledModel = mod.SimpleTiledModel;
  const parseTileset = mod.parseTileset;

  const xml = tilesetXml(spec.tileset);
  const tileset = parseTileset(xml, spec.tileset);

  const model = new SimpleTiledModel({
    tileset,
    subsetName: spec.subset,
    width: spec.width,
    height: spec.height,
    periodic: spec.periodic,
  });

  // Warm the JIT once before timing so we measure steady-state, not first-run
  // interpreter cost. (The median-of-N protocol in measure-speedup.ts is the
  // real measurement; this single-run path is for producing result files.)
  model.run(spec.seed, spec.limit);

  const t0 = performance.now();
  const ok = model.run(spec.seed, spec.limit);
  const elapsedMs = performance.now() - t0;

  const observed = model.result();
  return {
    spec,
    ok,
    complete: model.isComplete(),
    observed,
    checksum: checksum(observed),
    elapsedMs,
  };
}

// CLI: run.ts <reference|optimized> <specName> <outputPath>
if (import.meta.main) {
  const [kindArg, specName, outPath] = process.argv.slice(2);
  if (!kindArg || !specName || !outPath || (kindArg !== "reference" && kindArg !== "optimized")) {
    console.error("usage: run.ts <reference|optimized> <specName> <outputPath>");
    process.exit(2);
  }
  const spec = loadInputSpec(specName);
  runSolver(kindArg as SolverKind, spec).then((r) => {
    writeResult(r, outPath);
    console.log(`${r.spec.name}: ok=${r.ok} complete=${r.complete} checksum=${r.checksum.slice(0, 16)}… ${r.elapsedMs.toFixed(2)}ms`);
  });
}