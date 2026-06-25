// Adapter for blazinwfc
// API: import WFC from 'blazinwfc'; const w = WFC(def); const map = w.collapse(size); // square only, always periodic wrap
// def = { options: {baseWeight, ...}, tiles: [{edges: string[4], weight? }] }
// edges[0=up,1=right,2=down,3=left]; compat: edges[a] === reverse( edges[b] ) for facing sides.
// We synthesize edge strings from expanded propagator using profile groups (same as three-wfc).
// Since knots* are exactly representable (bicliques), faithful on those.
// For inputs that conflict (non-rectangular), returns canRun=false with specific conflict reason.

import type { Tileset } from "../../../src-optimized/tileset.js";
import WFCdefault from "blazinwfc";
import { buildExpandedPropagator } from "./lite.js";

const WFC: any = (WFCdefault as any).default ?? WFCdefault;

export interface BlazinSolver {
  collapse(size: number): number[][] | null;
}

const OUR_D_TO_BLAZIN = [
  { from: 3, opp: 1 }, // our0 left -> blazin from left(3) opp right(1)
  { from: 2, opp: 0 }, // our1 down
  { from: 1, opp: 3 }, // our2 right
  { from: 0, opp: 2 }, // our3 up
];

function reverseStr(s: string): string {
  return s.split("").reverse().join("");
}

function trySynthesizeBlazinTags(propagator: number[][][]): { ok: boolean; reason?: string; tags?: string[][] } {
  const T = propagator[0].length;
  const tags: string[][] = Array.from({ length: T }, () => ["", "", "", ""]);
  for (let d = 0; d < 4; d++) {
    const { from, opp } = OUR_D_TO_BLAZIN[d];
    const profileToSock = new Map<string, string>();
    const t1ToSock: string[] = new Array(T);
    let ctr = 0;
    for (let t1 = 0; t1 < T; t1++) {
      const al = propagator[d][t1].slice().sort((a, b) => a - b);
      const key = al.join(",");
      if (!profileToSock.has(key)) profileToSock.set(key, `Sd${d}p${ctr++}`);
      t1ToSock[t1] = profileToSock.get(key)!;
    }
    for (let t1 = 0; t1 < T; t1++) {
      tags[t1][from] = t1ToSock[t1];
    }
    const recvToSock = new Map<number, string>();
    for (let t1 = 0; t1 < T; t1++) {
      const sock = t1ToSock[t1];
      for (const t2 of propagator[d][t1]) {
        const prev = recvToSock.get(t2);
        if (prev !== undefined && prev !== sock) {
          return { ok: false, reason: `blazin conflict dir ${d}: t2=${t2} would require ${prev} and ${sock} (different profiles share target; cannot exact without extra allows)` };
        }
        recvToSock.set(t2, sock);
      }
    }
    for (const [t2, sock] of recvToSock.entries()) {
      tags[t2][opp] = reverseStr(sock);
    }
    for (let t = 0; t < T; t++) {
      if (!tags[t][opp]) {
        tags[t][opp] = `Ud${d}t${t}`; // unique unmatched, rev not needed since no from will match
      }
    }
  }
  return { ok: true, tags };
}

export function createBlazinModel(
  tileset: Tileset,
  subsetName: string | null,
  width: number,
  height: number,
  periodic: boolean,
): { solver: BlazinSolver; canRun: boolean; reason?: string } {
  if (width !== height) {
    return { solver: null as any, canRun: false, reason: "blazinwfc requires square grids (width==height)" as string };
  }
  if (!periodic) {
    // lib has no non-periodic mode; always wraps
    return { solver: null as any, canRun: false, reason: "blazinwfc is always periodic (wraps); no non-periodic mode" as string };
  }
  const { T, propagator, weights } = buildExpandedPropagator(tileset, subsetName) as any;
  if (T === 0) return { solver: null as any, canRun: false, reason: "no tiles" as string };
  const syn = trySynthesizeBlazinTags(propagator);
  if (!syn.ok || !syn.tags) {
    return { solver: null as any, canRun: false, reason: (syn.reason || "synth failed") as string };
  }
  const tiles: any[] = [];
  for (let i = 0; i < T; i++) {
    const w = (weights as number[])[i] ?? 10;
    tiles.push({
      edges: syn.tags[i] as [string, string, string, string],
      weight: w,
    });
  }
  let solver: any;
  try {
    solver = WFC({
      options: {
        baseWeight: 10,
        saveInterval: 0.05,
        startCell: { cell: 'middle', index: 0 },
      },
      tiles,
    });
  } catch (e: any) {
    return { solver: null as any, canRun: false, reason: `blazin WFC ctor error: ${e?.message || e}` as string };
  }
  return {
    solver: {
      collapse: (size: number) => {
        try {
          return solver.collapse(size);
        } catch (e) {
          return null;
        }
      },
    },
    canRun: true,
  };
}
