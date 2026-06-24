// The independent VALIDITY gate. Shares NO code with either solver: it imports
// only the tileset parser (parsing is not the algorithm) and re-derives the
// allowed-adjacency relation with separately-written code, then checks the
// solver's *output* tiling directly.
//
// Why this matters: compare.ts guarantees ref==opt (byte-identical), so if the
// reference is correct the optimized is correct. validate.ts is what proves the
// *reference itself* is correct — independently confirming its output is a valid
// tiling, so the whole ratchet rests on a verified anchor rather than the
// solver's own claim about what it enforced.
//
// Independence boundary (stated honestly): the symmetry math is inherent to the
// mxgmn tileset spec, not an implementation choice, so this re-derives the same
// relation the spec defines — but via a separate implementation that validates
// the output rather than trusting the solver's internal propagation state.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadInputSpec, tilesetXml } from "./io.js";
import type { InputSpec } from "./types.js";
import { parseTileset, type Tileset } from "../src/tileset.js";
import { DX, DY } from "./types.js";

interface Symmetry {
  cardinality: number;
  a: (i: number) => number;
  b: (i: number) => number;
}

// Separate copy of the symmetry definitions. Written fresh here (not imported
// from simple-tiled-model.ts) so a bug in the solver's copy cannot mask a bug in
// the validator's — and vice versa.
function symmetryOf(sym: string): Symmetry {
  switch (sym) {
    case "L":
      return { cardinality: 4, a: (i) => (i + 1) % 4, b: (i) => (i % 2 === 0 ? i + 1 : i - 1) };
    case "T":
      return { cardinality: 4, a: (i) => (i + 1) % 4, b: (i) => (i % 2 === 0 ? i : 4 - i) };
    case "I":
      return { cardinality: 2, a: (i) => 1 - i, b: (i) => i };
    case "\\":
      return { cardinality: 2, a: (i) => 1 - i, b: (i) => 1 - i };
    case "F":
      return {
        cardinality: 8,
        a: (i) => (i < 4 ? (i + 1) % 4 : 4 + ((i - 1) % 4)),
        b: (i) => (i < 4 ? i + 4 : i - 4),
      };
    default:
      return { cardinality: 1, a: (i) => i, b: (i) => i };
  }
}

/**
 * Independently derive the allowed adjacency: allowed[d][t1][t2] is true iff
 * tile-variant t2 may sit in direction d of a cell holding variant t1.
 * Direction layout matches the solver: 0=left, 1=down, 2=right, 3=up.
 */
function buildAllowedAdjacency(tileset: Tileset, subsetName: string | null): {
  allowed: Uint8Array[]; // allowed[d] is a flattened Uint8Array of T*T
  T: number;
  tilenames: string[];
} {
  let subset: Set<string> | null = null;
  if (subsetName != null) {
    const found = tileset.subsets.find((s) => s.name === subsetName);
    if (found) subset = new Set(found.tiles);
    else throw new Error(`subset "${subsetName}" not found`);
  }

  const action: number[][] = [];
  const firstOccurrence = new Map<string, number>();

  for (const xtile of tileset.tiles) {
    if (subset && !subset.has(xtile.name)) continue;
    const { cardinality, a, b } = symmetryOf(xtile.symmetry);
    const T = action.length;
    firstOccurrence.set(xtile.name, T);
    for (let t = 0; t < cardinality; t++) {
      const row = new Array<number>(8);
      row[0] = t;
      row[1] = a(t);
      row[2] = a(a(t));
      row[3] = a(a(a(t)));
      row[4] = b(t);
      row[5] = b(a(t));
      row[6] = b(a(a(t)));
      row[7] = b(a(a(a(t))));
      for (let s = 0; s < 8; s++) row[s] += T;
      action.push(row);
    }
  }

  const T = action.length;
  const tilenames: string[] = [];
  let idx = 0;
  for (const xtile of tileset.tiles) {
    if (subset && !subset.has(xtile.name)) continue;
    const { cardinality } = symmetryOf(xtile.symmetry);
    for (let t = 0; t < cardinality; t++) tilenames.push(`${xtile.name} ${t}`);
    idx += cardinality;
  }

  // dense[d] as a flat Uint8Array of T*T (row-major: t1*T + t2).
  const dense: Uint8Array[] = [];
  for (let d = 0; d < 4; d++) dense.push(new Uint8Array(T * T));

  const set = (d: number, t1: number, t2: number) => {
    dense[d][t1 * T + t2] = 1;
  };

  for (const xn of tileset.neighbors) {
    const left = xn.left.split(/\s+/).filter((s) => s.length > 0);
    const right = xn.right.split(/\s+/).filter((s) => s.length > 0);
    if (subset && (!subset.has(left[0] ?? "") || !subset.has(right[0] ?? ""))) continue;
    const foL = firstOccurrence.get(left[0] ?? "");
    const foR = firstOccurrence.get(right[0] ?? "");
    if (foL === undefined || foR === undefined) throw new Error(`neighbor refs unknown tile: ${xn.left}/${xn.right}`);

    const L = action[foL][left.length === 1 ? 0 : Number(left[1])];
    const D = action[L][1];
    const R = action[foR][right.length === 1 ? 0 : Number(right[1])];
    const U = action[R][1];

    set(0, R, L);
    set(0, action[R][6], action[L][6]);
    set(0, action[L][4], action[R][4]);
    set(0, action[L][2], action[R][2]);

    set(1, U, D);
    set(1, action[D][6], action[U][6]);
    set(1, action[U][4], action[D][4]);
    set(1, action[D][2], action[U][2]);
  }

  // dir 2 = transpose of dir 0; dir 3 = transpose of dir 1.
  for (let t2 = 0; t2 < T; t2++) {
    for (let t1 = 0; t1 < T; t1++) {
      dense[2][t2 * T + t1] = dense[0][t1 * T + t2];
      dense[3][t2 * T + t1] = dense[1][t1 * T + t2];
    }
  }

  return { allowed: dense, T, tilenames };
}

export interface ValidateReport {
  valid: boolean;
  name: string;
  cells: number;
  adjacencyChecks: number;
  violations: number;
  unresolvedCells: number; // cells with observed == -1 (contradiction)
  complete: boolean;
}

export function validateTiling(spec: InputSpec, observed: Int32Array, complete: boolean): ValidateReport {
  const tileset = parseTileset(tilesetXml(spec.tileset), spec.tileset);
  const { allowed, T } = buildAllowedAdjacency(tileset, spec.subset);
  const { width: MX, height: MY, periodic } = spec;

  let violations = 0;
  let adjacencyChecks = 0;
  let unresolved = 0;

  for (let y = 0; y < MY; y++) {
    for (let x = 0; x < MX; x++) {
      const i = x + y * MX;
      const t1 = observed[i];
      if (t1 < 0 || t1 >= T) {
        unresolved++;
        continue;
      }
      for (let d = 0; d < 4; d++) {
        let x2 = x + DX[d];
        let y2 = y + DY[d];
        if (periodic) {
          x2 = (x2 + MX) % MX;
          y2 = (y2 + MY) % MY;
        } else {
          if (x2 < 0 || y2 < 0 || x2 >= MX || y2 >= MY) continue;
        }
        const t2 = observed[x2 + y2 * MX];
        if (t2 < 0 || t2 >= T) continue; // neighbor unresolved — checked on its own iteration
        adjacencyChecks++;
        if (allowed[d][t1 * T + t2] !== 1) violations++;
      }
    }
  }

  const valid = violations === 0 && (!complete || unresolved === 0);
  return {
    valid,
    name: spec.name,
    cells: MX * MY,
    adjacencyChecks,
    violations,
    unresolvedCells: unresolved,
    complete,
  };
}

// CLI: validate.ts <specName> <resultFile>
// Re-runs the reference solver to obtain the observed array, then validates it.
if (import.meta.main) {
  const [specName, resultPath] = process.argv.slice(2);
  if (!specName) {
    console.error("usage: validate.ts <specName> [resultFile]");
    process.exit(2);
  }
  const spec = loadInputSpec(specName);
  // If a result file is given, we re-run the reference to get the observed array
  // (the result file only stores the checksum). Using the reference here is fine:
  // validate is proving the reference's own output valid.
  import("./run.js").then(async ({ runSolver }) => {
    const r = await runSolver("reference", spec);
    const report = validateTiling(spec, r.observed, r.complete);
    console.log(
      `VALIDATE ${report.name}: ${report.valid ? "VALID" : "INVALID"} | ` +
        `${report.adjacencyChecks} adjacency checks, ${report.violations} violations, ` +
        `${report.unresolvedCells} unresolved | complete=${report.complete}`,
    );
    if (resultPath) console.log(`  (result file ${resultPath} checksum: ${r.checksum.slice(0, 16)}…)`);
    process.exit(report.valid ? 0 : 1);
  });
}