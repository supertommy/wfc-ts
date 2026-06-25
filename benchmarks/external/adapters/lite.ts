// Adapter for @zakkster/lite-wfc
// API from source+docs: new WFC(cols, rows, numTiles, seed?)
// addRule(tileA, dir, tileB) or addSymmetricRule
// solve(maxSteps?) -> 1 solved, -1 contrad, 0 progress
// grid: Int8Array after
// Dirs: 0=up,1=right,2=down,3=left
// NOTE: always non-periodic (clips); no weights; max 32 tiles.

import type { Tileset } from "../../../src-optimized/tileset.js";
import { WFC } from "@zakkster/lite-wfc";

export interface LiteSolver {
  solve(maxSteps?: number): -1 | 0 | 1;
  grid: Int8Array;
  reset(seed?: number): void;
}

const OUR_TO_LITE_DIR = [3, 2, 1, 0]; // our 0left->3, 1down->2, 2right->1, 3up->0

export function countTilesAfterSubset(tileset: Tileset, subsetName: string | null): number {
  const sub = subsetName ? tileset.subsets.find((s) => s.name === subsetName) : null;
  const subsetSet = sub ? new Set(sub.tiles) : null;
  return tileset.tiles.filter((t) => !subsetSet || subsetSet.has(t.name)).length;
}

export function createLiteModel(
  tileset: Tileset,
  subsetName: string | null,
  width: number,
  height: number,
  _periodic: boolean, // ignored; lib has no periodic support
  seed: number,
): { solver: LiteSolver; numTiles: number; reset: (s: number) => void; solve: () => boolean } | null {
  const rawCount = countTilesAfterSubset(tileset, subsetName);
  if (rawCount > 32) {
    // caller should treat as N/A; we return null to signal
    return null;
  }

  // Expand using local faithful copy of mxgmn/kchap logic (see buildExpandedPropagator below).
  const { T, propagator, weights: _weights } = buildExpandedPropagator(tileset, subsetName);

  if (T > 32 || T === 0) return null;

  const solver = new WFC(width, height, T, seed);

  // populate rules: for each our_d, for each t1, t2 in prop[our_d][t1] => addRule(t1, lite_d, t2)
  for (let d = 0; d < 4; d++) {
    const liteD = OUR_TO_LITE_DIR[d];
    const row = propagator[d];
    for (let t1 = 0; t1 < T; t1++) {
      const allowed = row[t1];
      for (const t2 of allowed) {
        solver.addRule(t1, liteD, t2);
      }
    }
  }

  return {
    solver,
    numTiles: T,
    reset: (s: number) => solver.reset(s),
    solve: () => {
      const res = solver.solve(-1);
      return res === 1;
    },
  };
}

// --- local expansion (duplicated from mxgmn/kchap logic, read from references to ensure faithful) ---
export function buildExpandedPropagator(tileset: Tileset, subsetName: string | null): { T: number; propagator: number[][][]; weights: number[] } {
  const sub = subsetName ? tileset.subsets.find((s) => s.name === subsetName) : null;
  const subset = sub ? new Set(sub.tiles) : null;

  const tiles = tileset.tiles.filter((t) => !subset || subset.has(t.name));

  const firstOccurrence = new Map<string, number>();
  const action: number[][] = [];
  const weightList: number[] = [];

  for (const tile of tiles) {
    const name = tile.name;
    const sym = tile.symmetry;
    const w = tile.weight;

    let cardinality: number;
    let funcA: (i: number) => number;
    let funcB: (i: number) => number;

    switch (sym) {
      case "L":
        cardinality = 4;
        funcA = (i) => (i + 1) % 4;
        funcB = (i) => (i % 2 === 0 ? i + 1 : i - 1);
        break;
      case "T":
        cardinality = 4;
        funcA = (i) => (i + 1) % 4;
        funcB = (i) => (i % 2 === 0 ? i : 4 - i);
        break;
      case "I":
        cardinality = 2;
        funcA = (i) => 1 - i;
        funcB = (i) => i;
        break;
      case "\\":
        cardinality = 2;
        funcA = (i) => 1 - i;
        funcB = (i) => 1 - i;
        break;
      case "F":
        cardinality = 8;
        funcA = (i) => (i < 4 ? (i + 1) % 4 : 4 + ((i - 1) % 4));
        funcB = (i) => (i < 4 ? i + 4 : i - 4);
        break;
      default: // X
        cardinality = 1;
        funcA = (i) => i;
        funcB = (i) => i;
        break;
    }

    const base = action.length;
    firstOccurrence.set(name, base);

    for (let t = 0; t < cardinality; t++) {
      const row = [
        base + t,
        base + funcA(t),
        base + funcA(funcA(t)),
        base + funcA(funcA(funcA(t))),
        base + funcB(t),
        base + funcB(funcA(t)),
        base + funcB(funcA(funcA(t))),
        base + funcB(funcA(funcA(funcA(t)))),
      ];
      action.push(row);
      weightList.push(w);
    }
  }

  const T = action.length;

  // dense like our/kchap
  const dense: boolean[][][] = [];
  for (let d = 0; d < 4; d++) {
    const dirr = Array.from({ length: T }, () => new Array<boolean>(T).fill(false));
    dense.push(dirr);
  }

  for (const xn of tileset.neighbors) {
    const left = xn.left.split(/\s+/).filter(Boolean);
    const right = xn.right.split(/\s+/).filter(Boolean);
    if (subset && (!subset.has(left[0] ?? "") || !subset.has(right[0] ?? ""))) continue;
    const foL = firstOccurrence.get(left[0] ?? "");
    const foR = firstOccurrence.get(right[0] ?? "");
    if (foL === undefined || foR === undefined) continue;
    const L = action[foL][left.length === 1 ? 0 : Number(left[1])];
    const D = action[L][1];
    const R = action[foR][right.length === 1 ? 0 : Number(right[1])];
    const U = action[R][1];

    dense[0][R][L] = true;
    dense[0][action[R][6]][action[L][6]] = true;
    dense[0][action[L][4]][action[R][4]] = true;
    dense[0][action[L][2]][action[R][2]] = true;

    dense[1][U][D] = true;
    dense[1][action[D][6]][action[U][6]] = true;
    dense[1][action[U][4]][action[D][4]] = true;
    dense[1][action[D][2]][action[U][2]] = true;
  }

  for (let t2 = 0; t2 < T; t2++) {
    for (let t1 = 0; t1 < T; t1++) {
      dense[2][t2][t1] = dense[0][t1][t2];
      dense[3][t2][t1] = dense[1][t1][t2];
    }
  }

  const propagator: number[][][] = [];
  for (let d = 0; d < 4; d++) {
    const prows: number[][] = [];
    for (let t1 = 0; t1 < T; t1++) {
      const lst: number[] = [];
      for (let t2 = 0; t2 < T; t2++) if (dense[d][t1][t2]) lst.push(t2);
      prows.push(lst);
    }
    propagator.push(prows);
  }

  return { T, propagator, weights: weightList };
}
