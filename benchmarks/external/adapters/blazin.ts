// Adapter for blazinwfc
// API: import WFC from 'blazinwfc'; const w = WFC(def); const map = w.collapse(size); // square only
// def = { options: {baseWeight, startCell?}, tiles: [{edges: string[4], weight?, type? }] }
// edges[0 up,1 right,2 down,3 left]; compat by edges[a] === reverse(edges[b]) for facing
// ALWAYS wraps (periodic); no non-periodic mode. Uses weights.

import type { Tileset } from "../../../src-optimized/tileset.js";
import WFCdefault from "blazinwfc";

const WFC: any = (WFCdefault as any).default ?? WFCdefault;

export interface BlazinSolver {
  collapse(size: number): number[][];
}

const BLZ_DIR_ORDER = [3, 2, 1, 0]; // for edges[0]=our-up(3), [1]=right(2), [2]=down(1), [3]=left(0)

export function createBlazinModel(
  tileset: Tileset,
  subsetName: string | null,
  width: number,
  height: number,
  periodic: boolean,
): { solver: BlazinSolver; canRun: boolean; reason?: string } {
  // Per task: if adapter cannot *faithfully* express (without wrong conversion), mark N/A with reason.
  // Socket synthesis from propagator leads to either assign conflicts or generations that contradict
  // while reference impls succeed. Lib is also periodic-only. We do not force bad rules.
  return {
    solver: null as any,
    canRun: false,
    reason: "blazinwfc: cannot faithfully map neighbor-pair rules + symmetries to its edge-socket format without conflicts or under-constraint (in adapter tests, either crashed or produced contradictions where our/kchap succeed); lib also always periodic (wraps) and square-only",
  };
}
