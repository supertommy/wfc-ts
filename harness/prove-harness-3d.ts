// Prove the 3D validation harness against the committed 3D fixture.
// This is the 3D companion to prove-harness.ts: it gates the 3D output contract
// (complete, valid adjacencies, deterministic repeat) without sharing validation
// logic with WFCSolver3D.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checksum } from "./io.js";
import type { InputSpec3D } from "./types.js";
import { validate3D } from "./validate-3d.js";
import { WFCSolver3D, type TileRule3D } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inputs3DDir = join(root, "performance-test", "inputs-3d");
const tilesets3DDir = join(root, "performance-test", "tilesets-3d");

interface Tileset3D {
  name: string;
  weights: number[];
  rules: TileRule3D[];
}

interface Row {
  name: string;
  ok: boolean;
  complete: boolean;
  valid: boolean;
  deterministic: boolean;
  violations: number;
  adjacencyChecks: number;
  unresolvedCells: number;
  checksum: string;
  elapsedMs: number;
  err?: string;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadInputSpec3D(name: string): InputSpec3D {
  return loadJson<InputSpec3D>(join(inputs3DDir, `${name}.json`));
}

function loadTileset3D(name: string): Tileset3D {
  return loadJson<Tileset3D>(join(tilesets3DDir, `${name}.json`));
}

function solve(spec: InputSpec3D, tileset: Tileset3D) {
  const solver = new WFCSolver3D({
    width: spec.width,
    height: spec.height,
    depth: spec.depth,
    periodic: spec.periodic,
    weights: tileset.weights,
    rules: tileset.rules,
  });

  const start = performance.now();
  const ok = solver.run(spec.seed, spec.limit ?? -1);
  const elapsedMs = performance.now() - start;
  const result = solver.result();
  const complete = result.every((tile) => tile >= 0);
  return { ok, complete, result, checksum: checksum(result), elapsedMs };
}

async function main() {
  const inputNames = ["pipes-4"];
  const rows: Row[] = [];
  let allPass = true;

  for (const name of inputNames) {
    try {
      const spec = loadInputSpec3D(name);
      const tileset = loadTileset3D(spec.tileset);
      const first = solve(spec, tileset);
      const second = solve(spec, tileset);
      const validation = validate3D(
        first.result,
        spec.width,
        spec.height,
        spec.depth,
        tileset.rules,
        spec.periodic,
        true,
      );
      const deterministic = second.checksum === first.checksum;
      const row: Row = {
        name,
        ok: first.ok,
        complete: first.complete,
        valid: validation.valid,
        deterministic,
        violations: validation.violations,
        adjacencyChecks: validation.adjacencyChecks,
        unresolvedCells: validation.unresolvedCells,
        checksum: first.checksum,
        elapsedMs: first.elapsedMs,
      };
      if (!(row.ok && row.complete && row.valid && row.deterministic)) allPass = false;
      rows.push(row);
    } catch (e) {
      rows.push({
        name,
        ok: false,
        complete: false,
        valid: false,
        deterministic: false,
        violations: -1,
        adjacencyChecks: 0,
        unresolvedCells: -1,
        checksum: "",
        elapsedMs: 0,
        err: String(e),
      });
      allPass = false;
    }
  }

  console.log("=".repeat(78));
  console.log("3D HARNESS PROOF");
  console.log("=".repeat(78));
  console.log("name".padEnd(16) + "ok    complete valid  determ checks viol unresolved ms");
  console.log("-".repeat(78));
  for (const row of rows) {
    console.log(
      row.name.padEnd(16) +
        (row.ok ? "OK    " : "FAIL  ") +
        (row.complete ? "COMPLETE " : "PARTIAL  ") +
        (row.valid ? "VALID " : "INVAL ") +
        (row.deterministic ? "DET   " : "NODET ") +
        `${String(row.adjacencyChecks).padStart(6)} ` +
        `${String(row.violations).padStart(4)} ` +
        `${String(row.unresolvedCells).padStart(10)} ` +
        row.elapsedMs.toFixed(2).padStart(6),
    );
    if (row.err) console.log(`    ERROR: ${row.err}`);
  }
  console.log("-".repeat(78));
  console.log(`FINAL 3D HARNESS ${allPass ? "PASS" : "FAIL"}`);
  console.log("=".repeat(78));

  process.exit(allPass ? 0 : 1);
}

main();
