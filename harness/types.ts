// Shared types for the proof harness. The harness runs the reference (src/)
// and optimized (src-optimized/) solvers on identical committed inputs and
// judges the optimized output against the reference.

/** A committed, never-edited benchmark input. Fixed tileset + subset + size +
 * seed so the same input always exercises the same collapse path. */
export interface InputSpec {
  name: string;
  tileset: string;
  subset: string | null;
  width: number;
  height: number;
  periodic: boolean;
  seed: number;
  /** Max observe steps; -1 = run to completion. Always -1 in committed inputs. */
  limit: number;
}

/** A committed 3D benchmark input. 3D fixtures use JSON tile rules, not XML subsets. */
export interface InputSpec3D {
  name: string;
  tileset: string;
  width: number;
  height: number;
  depth: number;
  periodic: boolean;
  seed: number;
  /** Max observe steps; -1 or omitted = run to completion. */
  limit?: number;
}

/** The outcome of one solver run. */
export interface RunResult {
  spec: InputSpec;
  ok: boolean; // solver returned true (no contradiction / limit not hit at a contradiction)
  complete: boolean; // every cell collapsed to exactly one variant
  /** Tile-variant index per cell, length width*height; -1 where unresolved. */
  observed: Int32Array;
  /** sha256 of the observed Int32Array's bytes — the determinism + match key. */
  checksum: string;
  /** Wall-clock ms of the solver run() call (excludes model construction). */
  elapsedMs: number;
}

export const DX = [-1, 0, 1, 0];
export const DY = [0, 1, 0, -1];
export const OPPOSITE = [2, 3, 0, 1];