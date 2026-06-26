// Adapter for three-wfc core (extracted)
// Source: trimmed copy of ../references/three-wfc/lib/* (WFC2DBuffer + deps).
// This is an extraction solely for headless benchmarking in this repo; not a fork or modification for use.
// We build WFCTile2D[] programmatically with synthetic edge tags (derived from expanded propagator profiles)
// so that compatibility exactly matches our neighbor rules for representable tilesets (knots subsets are).
// three-wfc has no periodic support (borders always clip); comparisons use non-periodic only.
// three-wfc uses its own indexedPrng (seeded).

import type { Tileset } from "../../../helpers/tileset.js";
import { WFC2DBuffer } from "../three-wfc-core/WFC2DBuffer.js";
import { WFCTile2D } from "../three-wfc-core/WFCTile2D.js";
import { buildExpandedPropagator } from "./lite.js";

export interface ThreeSolver {
  collapseAll(): boolean;
  collapsedTile(index: number): number;
}

const OUR_D_TO_THREE = [
  { fromSide: 2, oppSide: 3 }, // our 0 left
  { fromSide: 1, oppSide: 0 }, // our 1 down
  { fromSide: 3, oppSide: 2 }, // our 2 right
  { fromSide: 0, oppSide: 1 }, // our 3 up
];

function trySynthesizeTags(propagator: number[][][]): { ok: boolean; reason?: string; tags?: (string | number)[][][] } {
  const T = propagator[0].length;
  const tags: (string | number)[][][] = Array.from({ length: T }, () => [[], [], [], []]);
  for (let d = 0; d < 4; d++) {
    const { fromSide, oppSide } = OUR_D_TO_THREE[d];
    const profileToSock = new Map<string, string>();
    const t1ToSock: string[] = new Array(T);
    let ctr = 0;
    for (let t1 = 0; t1 < T; t1++) {
      const al = propagator[d][t1].slice().sort((a, b) => a - b);
      const key = al.join(",");
      if (!profileToSock.has(key)) profileToSock.set(key, `d${d}-p${ctr++}`);
      t1ToSock[t1] = profileToSock.get(key)!;
    }
    for (let t1 = 0; t1 < T; t1++) {
      tags[t1][fromSide] = [t1ToSock[t1]];
    }
    const recvToSock = new Map<number, string>();
    for (let t1 = 0; t1 < T; t1++) {
      const sock = t1ToSock[t1];
      for (const t2 of propagator[d][t1]) {
        const prev = recvToSock.get(t2);
        if (prev !== undefined && prev !== sock) {
          return { ok: false, reason: `conflict dir ${d}: t2=${t2} would require ${prev} and ${sock} (different out-profiles share target; non-rectangular)` };
        }
        recvToSock.set(t2, sock);
      }
    }
    for (const [t2, sock] of recvToSock.entries()) {
      tags[t2][oppSide] = [sock];
    }
    for (let t = 0; t < T; t++) {
      if (tags[t][oppSide].length === 0) {
        tags[t][oppSide] = [`d${d}-unmatched-t${t}`];
      }
    }
  }
  return { ok: true, tags };
}

export function createThreeModel(
  tileset: Tileset,
  subsetName: string | null,
  width: number,
  height: number,
  periodic: boolean,
  seed: number,
): { solver: ThreeSolver | null; canRun: boolean; reason?: string; run: (s: number) => boolean } {
  if (periodic) {
    return {
      solver: null,
      canRun: false,
      reason: "three-wfc has no periodic/wrap support (always non-periodic clipping at borders)",
      run: (_s: number) => false,
    };
  }
  const built = buildExpandedPropagator(tileset, subsetName);
  const { T, propagator, weights } = built as any;
  if (T === 0) {
    return { solver: null, canRun: false, reason: "no tiles after subset", run: (_s: number) => false };
  }
  const syn = trySynthesizeTags(propagator);
  if (!syn.ok || !syn.tags) {
    return { solver: null, canRun: false, reason: `three-wfc socket synth: ${syn.reason}`, run: (_s: number) => false };
  }
  // build one base WFCTile2D per concrete variant (no further rot/refl)
  const base: WFCTile2D[] = [];
  for (let t = 0; t < T; t++) {
    const w = (weights as number[])[t] ?? 1;
    base.push(
      new WFCTile2D({
        content: { __headlessDummy: true },
        name: `t${t}`,
        weight: w,
        rotations: [],
        reflectX: false,
        reflectY: false,
        top: syn.tags[t][0],
        bottom: syn.tags[t][1],
        left: syn.tags[t][2],
        right: syn.tags[t][3],
      })
    );
  }
  // Note: WFC2DBuffer ctor will call WFCTileBuffer which appends transformClones (0 here) and computes compat from tags.
  const solver = new WFC2DBuffer(base, width, height, seed) as ThreeSolver;
  const run = (s: number) => {
    // reconstruct for fresh (since stateful); use same seed for det
    const freshBase: WFCTile2D[] = [];
    for (let t = 0; t < T; t++) {
      const w = (weights as number[])[t] ?? 1;
      freshBase.push(
        new WFCTile2D({
          content: { __headlessDummy: true },
          name: `t${t}`,
          weight: w,
          rotations: [],
          reflectX: false,
          reflectY: false,
          top: syn.tags![t][0],
          bottom: syn.tags![t][1],
          left: syn.tags![t][2],
          right: syn.tags![t][3],
        })
      );
    }
    const w = new WFC2DBuffer(freshBase, width, height, s) as ThreeSolver;
    return w.collapseAll();
  };
  return { solver, canRun: true, run };
}
