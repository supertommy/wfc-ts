// Faithful TypeScript port of mxgmn's SimpleTiledModel.cs.
// Copyright (C) 2016 Maxim Gumin, MIT. Ported for wfc-ts.
//
// Builds the propagator (adjacency tables) from a tileset's tile symmetry +
// neighbor rules, then inherits the observe/propagate/ban core from Model.
//
// Bitmap loading is omitted (rendering-only); the algorithm needs only names,
// symmetry, weights, and adjacency. Tile-variant bitmaps can be added later by
// the visualizer without touching the solver.

import { Heuristic, Model } from "./model.js";
import { parseTileset, type Tileset } from "./tileset.js";

// Rotation (a = 90deg) and reflection (b) action functions per symmetry class.
// These are the exact mxgmn definitions; `cardinality` is how many distinct
// variants a tile of this symmetry produces.
interface Symmetry {
  cardinality: number;
  a: (i: number) => number; // rotate 90
  b: (i: number) => number; // reflect
}

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
    default: // 'X' and anything else: a single, fully symmetric variant
      return { cardinality: 1, a: (i) => i, b: (i) => i };
  }
}

export interface SimpleTiledModelOptions {
  tileset: Tileset;
  subsetName?: string | null;
  width: number;
  height: number;
  periodic: boolean;
  heuristic?: Heuristic;
}

export class SimpleTiledModel extends Model {
  /** Human-readable name per tile-variant, e.g. "corner 1". For debugging/output. */
  readonly tilenames: string[] = [];

  constructor(opts: SimpleTiledModelOptions) {
    super(opts.width, opts.height, 1, opts.periodic, opts.heuristic ?? Heuristic.MRV);

    const { tileset, subsetName } = opts;

    // Resolve the subset (a named allow-list of tile names), if given.
    let subset: Set<string> | null = null;
    if (subsetName != null) {
      const found = tileset.subsets.find((s) => s.name === subsetName);
      if (found) subset = new Set(found.tiles);
      else throw new Error(`subset "${subsetName}" is not found in tileset "${tileset.name}"`);
    }

    const action: number[][] = []; // action[t][s] = absolute variant index under symmetry op s
    const firstOccurrence = new Map<string, number>();
    const tilenames: string[] = [];
    const weightList: number[] = [];

    for (const xtile of tileset.tiles) {
      if (subset && !subset.has(xtile.name)) continue;

      const { cardinality, a, b } = symmetryOf(xtile.symmetry);

      // T here is the offset = firstOccurrence of this tile's variant block.
      this.T = action.length;
      firstOccurrence.set(xtile.name, this.T);

      // map[t][0..7] = { t, a(t), a(a(t)), a(a(a(t))), b(t), b(a(t)), b(a(a(t))),
      //                  b(a(a(a(t)))) } + offset T. (mxgmn builds map[t] then
      // adds T to make indices absolute.)
      const map: number[][] = [];
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
        for (let s = 0; s < 8; s++) row[s] += this.T;
        map.push(row);
        action.push(row);
      }

      // No bitmaps (rendering-only). We still record variant names for output.
      for (let t = 0; t < cardinality; t++) {
        tilenames.push(`${xtile.name} ${t}`);
        weightList.push(xtile.weight);
      }
    }

    this.T = action.length;
    this.tilenames = tilenames;
    this.weights = new Float64Array(weightList);

    // Build the dense adjacency, then the sparse propagator.
    // densePropagator[d][t1][t2] = true iff variant t2 may sit in direction d
    // of a cell that currently allows t1.
    const T = this.T;
    const dense: boolean[][][] = [];
    for (let d = 0; d < 4; d++) {
      const dir = new Array<boolean[]>(T);
      for (let t = 0; t < T; t++) dir[t] = new Array<boolean>(T).fill(false);
      dense.push(dir);
    }

    for (const xn of tileset.neighbors) {
      const left = xn.left.split(/\s+/).filter((s) => s.length > 0);
      const right = xn.right.split(/\s+/).filter((s) => s.length > 0);

      if (subset && (!subset.has(left[0] ?? "") || !subset.has(right[0] ?? ""))) continue;

      const foL = firstOccurrence.get(left[0] ?? "");
      const foR = firstOccurrence.get(right[0] ?? "");
      if (foL === undefined || foR === undefined) {
        throw new Error(`neighbor references unknown tile: left="${xn.left}" right="${xn.right}"`);
      }

      const L = action[foL][left.length === 1 ? 0 : Number(left[1])];
      const D = action[L][1];
      const R = action[foR][right.length === 1 ? 0 : Number(right[1])];
      const U = action[R][1];

      // dir 0 (left): the four symmetry-equivalent (R,L) adjacencies.
      dense[0][R][L] = true;
      dense[0][action[R][6]][action[L][6]] = true;
      dense[0][action[L][4]][action[R][4]] = true;
      dense[0][action[L][2]][action[R][2]] = true;

      // dir 1 (down): the four symmetry-equivalent (U,D) adjacencies.
      dense[1][U][D] = true;
      dense[1][action[D][6]][action[U][6]] = true;
      dense[1][action[U][4]][action[D][4]] = true;
      dense[1][action[D][2]][action[U][2]] = true;
    }

    // dir 2 = transpose of dir 0; dir 3 = transpose of dir 1.
    for (let t2 = 0; t2 < T; t2++) {
      for (let t1 = 0; t1 < T; t1++) {
        dense[2][t2][t1] = dense[0][t1][t2];
        dense[3][t2][t1] = dense[1][t1][t2];
      }
    }

    // Sparse propagator (H2 CSR flat): build lists to preserve warn + exact order,
    // then flatten to propData / propStart / propLen. Indexed d*T + t1.
    // Same concatenation order over (d,t1) and within each list => byte-identical.
    const propLists: number[][] = [];
    for (let d = 0; d < 4; d++) {
      for (let t1 = 0; t1 < T; t1++) {
        const list: number[] = [];
        const row = dense[d][t1];
        if (row === undefined) throw new Error(`internal: dense[d][t1] undefined for d=${d} t1=${t1}`);
        for (let t2 = 0; t2 < T; t2++) if (row[t2]) list.push(t2);
        if (list.length === 0) {
          console.warn(`WARNING: tile ${tilenames[t1]} has no neighbors in direction ${d}`);
        }
        propLists.push(list);
      }
    }
    const PT = 4 * T;
    let total = 0;
    for (let k = 0; k < PT; k++) total += propLists[k].length;

    // H26: auto-select narrow element types by max stored value (mirror H23's pattern for compatible).
    // propData: stores t2 ids (0 <= t2 < T) → if T<256 Uint8 else ... (exact for our tilesets).
    // propLen: stores list lengths (≤ T) → Uint8 auto (same rule).
    // propStart: stores offsets into propData (0 <= start < total); for committed <65536 → Uint16 (optional).
    // prop* built ONCE here (ctor); constant across runs; H10 fixpoint does NOT snapshot them.
    // No arithmetic on propData values (pure ids, read-only in propagate) → no wrap concern.
    const PropDataCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor =
      T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
    const PropLenCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor =
      T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
    const PropStartCtor: Uint16ArrayConstructor | Int32ArrayConstructor =
      total < 65536 ? Uint16Array : Int32Array;

    const propData = new PropDataCtor(total);
    const propStart = new PropStartCtor(PT);
    const propLen = new PropLenCtor(PT);
    let pos = 0;
    for (let k = 0; k < PT; k++) {
      const lst = propLists[k];
      propStart[k] = pos;
      propLen[k] = lst.length;
      for (let i = 0; i < lst.length; i++) propData[pos + i] = lst[i];
      pos += lst.length;
    }
    this.propData = propData;
    this.propStart = propStart;
    this.propLen = propLen;
    this.PropDataCtor = PropDataCtor;
    this.PropLenCtor = PropLenCtor;
    this.PropStartCtor = PropStartCtor;
  }

  /** Debug grid of resolved tile-variant names. Empty where unresolved. */
  textOutput(): string {
    const { MX, MY, observed, tilenames } = this;
    const lines: string[] = [];
    for (let y = 0; y < MY; y++) {
      const row: string[] = [];
      for (let x = 0; x < MX; x++) {
        const t = observed[x + y * MX];
        row.push(t >= 0 ? (tilenames[t] ?? `?${t}`) : "   .   ");
      }
      lines.push(row.join(", "));
    }
    return lines.join("\n");
  }
}