// WFCSolver3D — Wave Function Collapse solver for 3D voxel grids.
// Uses 6 directions: left(-X), right(+X), up(+Y), down(-Y), front(-Z), back(+Z)
//
// Usage:
//   const solver = new WFCSolver3D({
//     width: 8,
//     height: 8,
//     depth: 8,
//     periodic: false,
//     weights: [1, 1, 1],
//     rules: [
//       { forTile: 0, left: [0,1], right: [0,1], up: [0,1], down: [0,1], front: [0,1], back: [0,1] },
//       // ...
//     ],
//   });
//   if (solver.run(42)) {
//     const grid = solver.result(); // Int32Array of tile indices (length = width*height*depth)
//   }

import { WFCEngine } from "./engine.js";
import { GridTopology3D } from "./topology.js";
import type { TileRule3D, WFCSolver3DOptions, StepStatus, Heuristic } from "./types.js";

// Re-export types for convenience
export type { TileRule3D, WFCSolver3DOptions, StepStatus, Heuristic };

// Direction mapping: left=0, right=1, up=2, down=3, front=4, back=5
const DIR_LEFT = 0;
const DIR_RIGHT = 1;
const DIR_UP = 2;
const DIR_DOWN = 3;
const DIR_FRONT = 4;
const DIR_BACK = 5;

export class WFCSolver3D {
  private engine: WFCEngine;
  private MX: number;
  private MY: number;
  private MZ: number;
  private T: number;

  constructor(opts: WFCSolver3DOptions) {
    const { width, height, depth, periodic, weights, rules, heuristic = 'mrv', search } = opts;

    this.MX = width;
    this.MY = height;
    this.MZ = depth;
    this.T = weights.length;

    // Create topology
    const topology = new GridTopology3D(width, height, depth, periodic);

    // Copy weights to Float64Array
    const weightArr = weights instanceof Float64Array ? weights : new Float64Array(weights);

    // Build propagator from rules
    const { propStart, propLen, propData } = this.buildPropagator(rules, this.T);

    // Create engine
    this.engine = new WFCEngine(topology, weightArr, propStart, propLen, propData, heuristic, search);
  }

  /**
   * Convert 3D rules array to CSR propagator format.
   */
  private buildPropagator(rules: TileRule3D[], T: number): {
    propStart: Uint16Array | Int32Array;
    propLen: Uint8Array | Uint16Array | Int32Array;
    propData: Uint8Array | Uint16Array | Int32Array;
  } {
    // Build propagator[d][t] = list of allowed tiles
    // Direction order: left=0, right=1, up=2, down=3, front=4, back=5
    const propagator: number[][][] = [[], [], [], [], [], []];
    for (let d = 0; d < 6; d++) {
      propagator[d] = new Array(T).fill(null).map(() => []);
    }

    for (const rule of rules) {
      const t = rule.forTile;
      if (t < 0 || t >= T) continue;
      propagator[DIR_LEFT][t] = rule.left;
      propagator[DIR_RIGHT][t] = rule.right;
      propagator[DIR_UP][t] = rule.up;
      propagator[DIR_DOWN][t] = rule.down;
      propagator[DIR_FRONT][t] = rule.front;
      propagator[DIR_BACK][t] = rule.back;
    }

    // Convert to CSR format
    // First pass: compute total size and max lengths
    let total = 0;
    let maxLen = 0;
    for (let d = 0; d < 6; d++) {
      for (let t = 0; t < T; t++) {
        const len = propagator[d][t].length;
        total += len;
        if (len > maxLen) maxLen = len;
      }
    }

    // Choose narrow types
    const PropDataCtor = T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
    const PropLenCtor = maxLen < 256 ? Uint8Array : maxLen < 65536 ? Uint16Array : Int32Array;
    const PropStartCtor = total < 65536 ? Uint16Array : Int32Array;

    const propData = new PropDataCtor(total);
    const propStart = new PropStartCtor(6 * T);
    const propLen = new PropLenCtor(6 * T);

    // Second pass: fill CSR arrays
    let offset = 0;
    for (let d = 0; d < 6; d++) {
      for (let t = 0; t < T; t++) {
        const key = d * T + t;
        const list = propagator[d][t];
        propStart[key] = offset;
        propLen[key] = list.length;
        for (let i = 0; i < list.length; i++) {
          propData[offset] = list[i];
          offset++;
        }
      }
    }

    return { propStart, propLen, propData };
  }

  /**
   * Run the solver to completion.
   * @param seed - Random seed for determinism
   * @param limit - Max observations (-1 = unlimited)
   * @param restartBudget - Max restart attempts on contradiction (default: 100)
   * @returns true if solved, false if all attempts failed
   */
  run(seed: number, limit = -1, restartBudget = 100): boolean {
    return this.engine.run(seed, limit, restartBudget);
  }

  /**
   * Generator form for step-by-step visualization.
   */
  *stepRun(
    seed: number,
    limit = -1,
    restartBudget = 100,
    yieldEvery = 1,
    signal: AbortSignal | null = null
  ): Generator<StepStatus> {
    yield* this.engine.stepRun(seed, limit, restartBudget, yieldEvery, signal);
  }

  /**
   * Get the result after a successful run.
   * @returns Int32Array of tile indices (length = width * height * depth)
   */
  result(): Int32Array {
    return this.engine.result();
  }

  /**
   * Get the current wave state for visualization.
   */
  getWave(): Uint8Array {
    return this.engine.getWave();
  }

  /**
   * Get dimensions.
   */
  get width(): number { return this.MX; }
  get height(): number { return this.MY; }
  get depth(): number { return this.MZ; }
  get tileCount(): number { return this.T; }

  /**
   * Memory footprint in bytes.
   */
  footprintBytes(): number {
    return this.engine.footprintBytes();
  }
}
