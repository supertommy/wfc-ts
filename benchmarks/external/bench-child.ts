// Child runner for a single (external solver, input) bench. Spawned by run.ts
// with a wall-clock kill timeout so a looping solver (e.g. blazin's nondetermin
// istic backtracking on a hard subset) cannot hang the whole benchmark — the
// parent kills this child if it exceeds the budget and records N/A "timed out".
//
// args: <solverId> <specName>
// prints one JSON line: { medianMs, completed, note }  (ResultCell)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseTileset } from "../../helpers/tileset.js";
import { createKchapelierModel } from "./adapters/kchapelier.js";
import { createBlazinModel } from "./adapters/blazin.js";
import { createLiteModel, countTilesAfterSubset } from "./adapters/lite.js";
import { createThreeModel } from "./adapters/three.js";
import { mulberry32 } from "../../helpers/prng.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const INPUTS_DIR = join(ROOT, "performance-test", "inputs");
const TILESETS_DIR = join(ROOT, "performance-test", "tilesets");

interface Spec {
  name: string; tileset: string; subset: string | null;
  width: number; height: number; periodic: boolean; seed: number; limit: number;
}
function loadSpec(n: string): Spec {
  const j = JSON.parse(readFileSync(join(INPUTS_DIR, `${n}.json`), "utf8"));
  return { name: j.name, tileset: j.tileset, subset: j.subset ?? null, width: j.width, height: j.height, periodic: !!j.periodic, seed: j.seed ?? 1, limit: j.limit ?? -1 };
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

interface Cell { medianMs: number | null; completed: boolean | null; note?: string | undefined }

function benchBlazin(spec: Spec, tileset: ReturnType<typeof parseTileset>): Cell {
  const built = createBlazinModel(tileset, spec.subset, spec.width, spec.height, spec.periodic);
  if (!built.canRun) return { medianMs: null, completed: null, note: built.reason };
  const solver = built.solver as any;
  const size = spec.width;
  try { solver.collapse(size); } catch { /* warmup */ }
  const times: number[] = []; let lastOk = false;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    let map: any = null;
    try { map = solver.collapse(size); } catch { map = null; }
    times.push(performance.now() - t0);
    let ok = false;
    if (map && Array.isArray(map) && map.length === size) {
      ok = true;
      outer: for (let x = 0; x < size; x++) {
        const col = map[x];
        if (!col || col.length !== size) { ok = false; break; }
        for (let y = 0; y < size; y++) if (col[y] == null) { ok = false; break outer; }
      }
    }
    lastOk = ok;
  }
  return { medianMs: median(times), completed: lastOk, note: "nondeterministic (no seed param)" };
}

function benchThree(spec: Spec, tileset: ReturnType<typeof parseTileset>): Cell {
  const nonPer = { ...spec, periodic: false };
  const built = createThreeModel(tileset, nonPer.subset, nonPer.width, nonPer.height, false, nonPer.seed);
  if (!built.canRun) return { medianMs: null, completed: null, note: built.reason };
  const runFn = (built as any).run;
  try { runFn(nonPer.seed); } catch { /* warmup */ }
  const times: number[] = []; let lastOk = false;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    try { lastOk = runFn(nonPer.seed + i); } catch { lastOk = false; }
    times.push(performance.now() - t0);
  }
  return { medianMs: median(times), completed: lastOk, note: `non-periodic ${nonPer.width}x${nonPer.height}` };
}

function benchKchap(spec: Spec, tileset: ReturnType<typeof parseTileset>): Cell {
  const { generate } = createKchapelierModel(tileset, spec.subset, spec.width, spec.height, spec.periodic);
  generate(() => 0.5);
  const times: number[] = []; let lastOk = false;
  for (let i = 0; i < 5; i++) {
    const r = mulberry32(spec.seed + i);
    const t0 = performance.now(); const ok = generate(() => r.nextDouble()); times.push(performance.now() - t0); lastOk = ok;
  }
  return { medianMs: median(times), completed: lastOk };
}

function benchLite(spec: Spec, tileset: ReturnType<typeof parseTileset>): Cell {
  const rawT = countTilesAfterSubset(tileset, spec.subset);
  if (rawT > 32) return { medianMs: null, completed: null, note: `lite-wfc max 32 tiles; expands to ${rawT}` };
  if (spec.periodic) return { medianMs: null, completed: null, note: "lite-wfc has no periodic/wrap support" };
  const sub = spec.subset ? tileset.subsets.find((s) => s.name === spec.subset) : null;
  const set = sub ? new Set(sub.tiles) : null;
  if (tileset.tiles.some((t) => (!set || set.has(t.name)) && t.weight !== 1))
    return { medianMs: null, completed: null, note: "lite-wfc does not support per-tile weights" };
  const built = createLiteModel(tileset, spec.subset, spec.width, spec.height, spec.periodic, spec.seed) as any;
  if (!built) return { medianMs: null, completed: null, note: "lite-wfc could not build" };
  built.reset(spec.seed); built.solve();
  const times: number[] = []; let lastOk = false;
  for (let i = 0; i < 5; i++) {
    built.reset(spec.seed + i * 1000);
    const t0 = performance.now(); const ok = built.solve(); times.push(performance.now() - t0); lastOk = ok;
  }
  return { medianMs: median(times), completed: lastOk };
}

const [solverId, specName] = process.argv.slice(2);
const spec = loadSpec(specName);
const tileset = parseTileset(readFileSync(join(TILESETS_DIR, `${spec.tileset}.xml`), "utf8"), spec.tileset);
let cell: Cell;
if (solverId === "blazinwfc") cell = benchBlazin(spec, tileset);
else if (solverId === "three-wfc") cell = benchThree(spec, tileset);
else if (solverId === "kchapelier") cell = benchKchap(spec, tileset);
else if (solverId === "lite-wfc") cell = benchLite(spec, tileset);
else cell = { medianMs: null, completed: null, note: `unknown solver ${solverId}` };
console.log(JSON.stringify(cell));