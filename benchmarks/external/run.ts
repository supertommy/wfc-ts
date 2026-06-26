// External benchmark harness: our-optimized vs published WFC libs on committed inputs.
// Policy: construction (parse + model build + propagator) EXCLUDED from timing.
// Warmup 1x, then N=5, median ms. Record completed (no contradiction).
// All numbers are real runs on this machine. Never fabricate.
// External solvers run in a CHILD PROCESS with a kill timeout so a looping solver
// (blazin's backtracking on a hard subset) cannot hang the whole benchmark.
// If a lib cannot express the input faithfully, mark N/A + reason.

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tileset } from "../../helpers/tileset.js";
import { parseTileset } from "../../helpers/tileset.js";
import { SimpleTiledModel } from "../../helpers/simple-tiled-model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const INPUTS_DIR = join(ROOT, "performance-test", "inputs");
const TILESETS_DIR = join(ROOT, "performance-test", "tilesets");

interface InputSpec {
  name: string; tileset: string; subset: string | null;
  width: number; height: number; periodic: boolean; seed: number; limit: number;
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
  const j = JSON.parse(readFileSync(join(INPUTS_DIR, `${name}.json`), "utf8"));
  return { name: j.name, tileset: j.tileset, subset: j.subset ?? null, width: j.width, height: j.height, periodic: !!j.periodic, seed: j.seed ?? 1, limit: j.limit ?? -1 };
}

function median(arr: number[]): number {
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

type SolverId = "our-optimized" | "kchapelier" | "blazinwfc" | "lite-wfc" | "three-wfc";
const SOLVERS: SolverId[] = ["our-optimized", "kchapelier", "blazinwfc", "lite-wfc", "three-wfc"];

interface ResultCell { medianMs: number | null; completed: boolean | null; note?: string | undefined }

// our-optimized runs inline (safe, fast, deterministic). External solvers run in
// a child process (bench-child.ts) with a wall-clock kill timeout.
const EXT_TIMEOUT_MS = 20000;
async function runChildTimeout(solverId: string, specName: string): Promise<ResultCell> {
  const childPath = join(__dirname, "bench-child.ts");
  const proc = Bun.spawn({ cmd: ["bun", "run", childPath, solverId, specName], stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* already exited */ } }, EXT_TIMEOUT_MS);
  try {
    const text = await new Response(proc.stdout).text();
    if (timedOut) return { medianMs: null, completed: null, note: `timed out (>${EXT_TIMEOUT_MS / 1000}s; likely backtracking loop on a hard subset)` };
    try { return JSON.parse(text.trim()) as ResultCell; }
    catch { return { medianMs: null, completed: null, note: `no JSON output: ${text.trim().slice(0, 100)}` }; }
  } finally { clearTimeout(killer); }
}

async function benchOur(spec: InputSpec, tileset: Tileset): Promise<ResultCell> {
  const model = new SimpleTiledModel({ tileset, subsetName: spec.subset, width: spec.width, height: spec.height, periodic: spec.periodic });
  model.run(spec.seed, spec.limit); // warmup
  const times: number[] = []; let lastOk = false;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    lastOk = model.run(spec.seed, spec.limit);
    times.push(performance.now() - t0);
  }
  return { medianMs: median(times), completed: lastOk };
}

async function runAll() {
  console.log("External WFC benchmark — real runs, median-of-5, this machine (macOS arm64 Bun).");
  console.log("Inputs from performance-test/inputs; tilesets/*.xml. Construction time excluded.\n");

  const rows: Array<{ input: string; cells: Record<SolverId, ResultCell> }> = [];
  for (const iname of INPUT_NAMES) {
    const spec = loadSpec(iname);
    const tileset = parseTileset(readFileSync(join(TILESETS_DIR, `${spec.tileset}.xml`), "utf8"), spec.tileset);
    const cells = {} as Record<SolverId, ResultCell>;
    for (const sid of SOLVERS) {
      process.stdout.write(`  [${spec.name}/${sid}] `);
      try {
        cells[sid] = sid === "our-optimized" ? await benchOur(spec, tileset) : await runChildTimeout(sid, spec.name);
      } catch (e: any) {
        cells[sid] = { medianMs: null, completed: null, note: `ERROR: ${e?.message || e}` };
      }
    }
    rows.push({ input: spec.name, cells });
  }

  printTable(rows);
  console.log("\n--- RAW JSON for verification ---");
  console.log(JSON.stringify(rows, null, 2));
}

function fmtCell(c: ResultCell, ourMedian: number | null): string {
  if (c.medianMs == null) {
    const short = c.note ? (c.note.length > 80 ? c.note.slice(0, 77) + "…" : c.note) : "";
    return short ? `N/A (${short})` : "N/A";
  }
  const rel = ourMedian && ourMedian > 0 ? ` (${(c.medianMs / ourMedian).toFixed(2)}x)` : "";
  return `${c.medianMs.toFixed(2)}ms${rel} ${c.completed ? "OK" : "FAIL"}`;
}

function printTable(rows: Array<{ input: string; cells: Record<SolverId, ResultCell> }>) {
  const headers = ["input", ...SOLVERS];
  console.log("| " + headers.join(" | ") + " |");
  console.log("| " + headers.map(() => "---").join(" | ") + " |");
  for (const r of rows) {
    const our = r.cells["our-optimized"]?.medianMs ?? null;
    console.log(`| ${r.input} | ${SOLVERS.map((s) => fmtCell(r.cells[s], our)).join(" | ")} |`);
  }
  console.log("\nNotes:");
  console.log("- Median of 5 runs after 1 warmup. Times are generation only (construction excluded).");
  console.log("- OK = produced complete valid tiling; FAIL = contradiction before completion.");
  console.log("- x factor is vs our-optimized on same input (>1 = slower than us).");
  console.log("- N/A reasons are explicit; no silent skips. three-wfc runs non-periodic (no periodic support); blazinwfc is always-periodic.");
}

if (import.meta.main) {
  runAll().catch((e) => { console.error(e); process.exit(1); });
}