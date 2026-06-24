// External benchmark harness: our-optimized vs published WFC libs on committed inputs.
// Policy: construction (parse + model build + propagator) EXCLUDED from timing.
// Warmup 1x, then N=5, median ms. Record completed (no contradiction).
// All numbers are real runs on this machine. Never fabricate.
// If a lib cannot express the input faithfully (symmetry, periodic, tile count, weights, rect), mark N/A + reason.

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tileset } from "../../src-optimized/tileset.js";
import { parseTileset } from "../../src-optimized/tileset.js";
import { SimpleTiledModel } from "../../src-optimized/simple-tiled-model.js";
import { mulberry32 } from "../../src-optimized/prng.js";
import { createKchapelierModel, buildKchapelierData } from "./adapters/kchapelier.js";
import { createBlazinModel } from "./adapters/blazin.js";
import { createLiteModel, countTilesAfterSubset } from "./adapters/lite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const INPUTS_DIR = join(ROOT, "performance-test", "inputs");
const TILESETS_DIR = join(ROOT, "performance-test", "tilesets");

interface InputSpec {
  name: string;
  tileset: string;
  subset: string | null;
  width: number;
  height: number;
  periodic: boolean;
  seed: number;
  limit: number;
}

const INPUT_NAMES = [
  "knots-standard-24",
  "knots-standard-48",
  "knots-fabric-24",
  "knots-dense-24",
  "circuit-turnless-34",
  "rooms-30",
];

function loadSpec(name: string): InputSpec {
  const raw = readFileSync(join(INPUTS_DIR, `${name}.json`), "utf8");
  const j = JSON.parse(raw);
  return {
    name: j.name,
    tileset: j.tileset,
    subset: j.subset ?? null,
    width: j.width,
    height: j.height,
    periodic: !!j.periodic,
    seed: j.seed ?? 1,
    limit: j.limit ?? -1,
  };
}

function loadTilesetXml(tsName: string): string {
  return readFileSync(join(TILESETS_DIR, `${tsName}.xml`), "utf8");
}

function median(arr: number[]): number {
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

type SolverId = "our-optimized" | "kchapelier" | "blazinwfc" | "lite-wfc" | "three-wfc";

interface ResultCell {
  medianMs: number | null;
  completed: boolean | null;
  note?: string | undefined; // for N/A reason or "nondet"
}

const SOLVERS: SolverId[] = ["our-optimized", "kchapelier", "blazinwfc", "lite-wfc", "three-wfc"];

async function benchOur(spec: InputSpec, tileset: Tileset): Promise<ResultCell> {
  const model = new SimpleTiledModel({
    tileset,
    subsetName: spec.subset,
    width: spec.width,
    height: spec.height,
    periodic: spec.periodic,
  });
  // warmup
  model.run(spec.seed, spec.limit);
  const times: number[] = [];
  let lastOk = false;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const ok = model.run(spec.seed, spec.limit);
    const dt = performance.now() - t0;
    times.push(dt);
    lastOk = ok;
  }
  return { medianMs: median(times), completed: lastOk };
}

async function benchKchapelier(spec: InputSpec, tileset: Tileset): Promise<ResultCell> {
  const { generate } = createKchapelierModel(tileset, spec.subset, spec.width, spec.height, spec.periodic);
  const rng = () => Math.random(); // will override with seeded below
  // warmup
  generate(() => 0.5);
  const times: number[] = [];
  let lastOk = false;
  for (let i = 0; i < 5; i++) {
    const r = mulberry32(spec.seed + i); // vary slightly per trial for safety, but same seed base
    const rngSeeded = () => r.nextDouble();
    const t0 = performance.now();
    const ok = generate(rngSeeded);
    const dt = performance.now() - t0;
    times.push(dt);
    lastOk = ok;
  }
  return { medianMs: median(times), completed: lastOk };
}

async function benchBlazin(spec: InputSpec, tileset: Tileset): Promise<ResultCell> {
  const built = createBlazinModel(tileset, spec.subset, spec.width, spec.height, spec.periodic);
  if (!built.canRun) {
    return { medianMs: null, completed: null, note: built.reason };
  }
  const solver = built.solver;
  const size = spec.width; // asserted square
  // warmup (may be slow/rollbacks)
  try { solver.collapse(size); } catch (e) { /* ignore */ }
  const times: number[] = [];
  let lastCompleted = false;
  const MAX_STEPS_GUARD = size * size * 20; // safety, though not used internally
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    let map: any = null;
    try {
      map = solver.collapse(size);
    } catch (e) {
      map = null;
    }
    const dt = performance.now() - t0;
    times.push(dt);
    // detect success: finalMap fully populated (no null/undefined)
    let ok = false;
    if (map && Array.isArray(map) && map.length === size) {
      ok = true;
      outer: for (let x = 0; x < size; x++) {
        const col = map[x];
        if (!col || col.length !== size) { ok = false; break; }
        for (let y = 0; y < size; y++) {
          if (col[y] == null) { ok = false; break outer; }
        }
      }
    }
    lastCompleted = ok;
  }
  return { medianMs: median(times), completed: lastCompleted, note: "nondeterministic (no seed param)" };
}

async function benchLite(spec: InputSpec, tileset: Tileset): Promise<ResultCell> {
  const rawT = countTilesAfterSubset(tileset, spec.subset);
  if (rawT > 32) {
    return { medianMs: null, completed: null, note: `lite-wfc max 32 tiles; this input expands to ${rawT}` };
  }
  if (spec.periodic) {
    return { medianMs: null, completed: null, note: "lite-wfc has no periodic/wrap support (always clips at edges)" };
  }
  // weights?
  // inspect if any weight !=1 ; for faithful, if non-uniform cannot
  const sub = spec.subset ? tileset.subsets.find((s) => s.name === spec.subset) : null;
  const subsetSet = sub ? new Set(sub.tiles) : null;
  const hasNonUnitWeight = tileset.tiles.some((t) => (!subsetSet || subsetSet.has(t.name)) && t.weight !== 1);
  if (hasNonUnitWeight) {
    return { medianMs: null, completed: null, note: "lite-wfc does not support per-tile weights (uniform choice only)" };
  }

  const built = createLiteModel(tileset, spec.subset, spec.width, spec.height, spec.periodic, spec.seed);
  if (!built) {
    return { medianMs: null, completed: null, note: "lite-wfc could not build (limit or other)" };
  }
  // warmup + 5
  built.reset(spec.seed);
  built.solve();
  const times: number[] = [];
  let lastOk = false;
  for (let i = 0; i < 5; i++) {
    built.reset(spec.seed + i * 1000); // reseed per trial for variety, still deterministic per call
    const t0 = performance.now();
    const ok = built.solve();
    const dt = performance.now() - t0;
    times.push(dt);
    lastOk = ok;
  }
  return { medianMs: median(times), completed: lastOk };
}

async function benchThree(): Promise<ResultCell> {
  // Low-effort attempt skipped per task guidance: coupled to Three.js Vector/Color, HTML* elements for tile content,
  // transformClones for symmetries (different from neighbor-pair expansion), edge tag arrays for sockets.
  // WFC2DBuffer clips (no periodic). Not practical to map our inputs faithfully without non-trivial work and risk of mismatch.
  return { medianMs: null, completed: null, note: "N/A: browser/Three-coupled (requires canvas + image content; no periodic; symmetry via per-tile rotations not neighbor decls); low-effort extract not possible" };
}

async function runAll() {
  console.log("External WFC benchmark — real runs, median-of-5, this machine (macOS arm64 Bun).");
  console.log("Inputs from performance-test/inputs; tilesets/*.xml. Construction time excluded.");
  console.log("");

  const rows: Array<{ input: string; cells: Record<SolverId, ResultCell> }> = [];

  for (const iname of INPUT_NAMES) {
    const spec = loadSpec(iname);
    const xml = loadTilesetXml(spec.tileset);
    const tileset = parseTileset(xml, spec.tileset);

    const cells: Record<SolverId, ResultCell> = {} as any;

    for (const sid of SOLVERS) {
      try {
        if (sid === "our-optimized") {
          cells[sid] = await benchOur(spec, tileset);
        } else if (sid === "kchapelier") {
          cells[sid] = await benchKchapelier(spec, tileset);
        } else if (sid === "blazinwfc") {
          cells[sid] = await benchBlazin(spec, tileset);
        } else if (sid === "lite-wfc") {
          cells[sid] = await benchLite(spec, tileset);
        } else if (sid === "three-wfc") {
          cells[sid] = await benchThree();
        }
      } catch (e: any) {
        cells[sid] = { medianMs: null, completed: null, note: `ERROR: ${e?.message || e}` };
      }
    }
    rows.push({ input: spec.name, cells });
  }

  // Print table
  printTable(rows);

  // Also write RESULTS.md ? The script prints; user will capture or we edit after.
  // For now, also dump a machine readable for verification.
  console.log("\n--- RAW JSON for verification ---");
  console.log(JSON.stringify(rows, null, 2));
}

function fmtCell(c: ResultCell, ourMedian: number | null): string {
  if (c.medianMs == null) {
    const short = c.note ? (c.note.length > 80 ? c.note.slice(0,77)+'…' : c.note) : '';
    return short ? `N/A (${short})` : "N/A";
  }
  const ms = c.medianMs.toFixed(2);
  let rel = "";
  if (ourMedian != null && ourMedian > 0) {
    const ratio = c.medianMs / ourMedian;
    rel = ` (${ratio.toFixed(2)}x)`;
  }
  const done = c.completed ? "OK" : "FAIL";
  return `${ms}ms${rel} ${done}`;
}

function printTable(rows: Array<{ input: string; cells: Record<SolverId, ResultCell> }>) {
  const headers = ["input", ...SOLVERS];
  // compute our baseline per row for x factor
  console.log("| " + headers.join(" | ") + " |");
  console.log("| " + headers.map(() => "---").join(" | ") + " |");
  for (const r of rows) {
    const our = r.cells["our-optimized"]?.medianMs ?? null;
    const vals = SOLVERS.map((s) => fmtCell(r.cells[s], our));
    console.log(`| ${r.input} | ${vals.join(" | ")} |`);
  }
  console.log("");
  console.log("Notes:");
  console.log("- Median of 5 runs after 1 warmup. Times are generation only (model construction excluded).");
  console.log("- OK = produced complete valid tiling; FAIL = contradiction before completion.");
  console.log("- x factor is vs our-optimized on same input ( >1 means slower than us).");
  console.log("- N/A reasons are explicit; no silent skips.");
}

if (import.meta.main) {
  runAll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
