// Faithful TypeScript port of mxgmn's Model.cs (the WFC observation/propagation
// core). Copyright (C) 2016 Maxim Gumin, MIT. Ported for wfc-ts.
//
// PROFILE COPY (scripts/profile-model.ts): hand-instrumented with per-phase
// accumulators to answer "where do the cycles go?". Not part of src/ or the
// measured baseline.

import { performance } from "node:perf_hooks";
import { mulberry32, type Random } from "../helpers/prng.js";

export const enum Heuristic {
  Entropy = 0,
  MRV = 1,
  Scanline = 2,
}

// Direction layout, identical to mxgmn:
//   dx = [-1, 0, 1, 0]   dy = [0, 1, 0, -1]
//   dir 0 = left (-x), 1 = down (+y), 2 = right (+x), 3 = up (-y)
//   opposite[d]: 0<->2, 1<->3  => [2, 3, 0, 1]
const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];
const OPPOSITE = [2, 3, 0, 1];

/**
 * Abstract base for WFC models. SimpleTiledModel (the only model in this
 * project) fills in `propagator`, `weights`, and `T`; everything else — the
 * wave, the AC-4 compatible-counts, the observe/propagate/ban loop — lives here.
 */
export abstract class Model {
  // Grid + pattern geometry. MX/MY/N/periodic set by base ctor; T/weights/
  // propagator set by the subclass before the first run().
  protected MX = 0;
  protected MY = 0;
  protected T = 0; // pattern (tile-variant) count
  protected N = 1; // tile footprint; 1 for the simple tiled model
  protected periodic = false;
  protected ground = false;

  // The wave: wave[i][t] is true while tile-variant t is still possible at cell i.
  protected wave: boolean[][] = [];
  // propagator[d][t1] = list of tile-variants allowed at the dir-d neighbor of a
  // cell that currently permits t1. Precomputed once from the tileset adjacency.
  protected propagator: number[][][] = [];
  // compatible[i][t][d] = AC-4 support count: how many patterns in the dir-d
  // neighbor of cell i still permit t. Hits 0 => t is banned at i.
  protected compatible: number[][][] = [];
  protected observed: Int32Array = new Int32Array(0);

  // Propagation stack of (cellIndex, tileVariant) pairs that need their
  // neighbors re-checked. Preallocated to MX*MY*T (the worst case). Mirrors
  // mxgmn's `stack = new (int,int)[wave.Length * T]`; split into two parallel
  // arrays for a clean TS representation.
  protected stackI: Int32Array = new Int32Array(0);
  protected stackT: Int32Array = new Int32Array(0);
  protected stacksize = 0;
  protected observedSoFar = 0;

  protected weights: Float64Array = new Float64Array(0);
  protected weightLogWeights: Float64Array = new Float64Array(0);
  protected distribution: Float64Array = new Float64Array(0);

  protected sumsOfOnes: Int32Array = new Int32Array(0);
  protected sumsOfWeights: Float64Array = new Float64Array(0);
  protected sumsOfWeightLogWeights: Float64Array = new Float64Array(0);
  protected entropies: Float64Array = new Float64Array(0);

  protected sumOfWeights = 0;
  protected sumOfWeightLogWeights = 0;
  protected startingEntropy = 0;

  protected heuristic: Heuristic = Heuristic.Entropy;

  protected constructor(width: number, height: number, N: number, periodic: boolean, heuristic: Heuristic) {
    this.MX = width;
    this.MY = height;
    this.N = N;
    this.periodic = periodic;
    this.heuristic = heuristic;
  }

  /**
   * Allocate the wave, compatible counts, entropy accumulators, and stack.
   * Called lazily on the first Run. Requires T, weights, propagator to be set
   * by the subclass first.
   */
  protected init(): void {
    const count = this.MX * this.MY;
    const T = this.T;

    this.wave = new Array(count);
    this.compatible = new Array(count);
    for (let i = 0; i < count; i++) {
      this.wave[i] = new Array<boolean>(T).fill(true);
      const ci: number[][] = new Array(T);
      for (let t = 0; t < T; t++) ci[t] = [0, 0, 0, 0];
      this.compatible[i] = ci;
    }
    this.distribution = new Float64Array(T);
    this.observed = new Int32Array(count);

    this.weightLogWeights = new Float64Array(T);
    this.sumOfWeights = 0;
    this.sumOfWeightLogWeights = 0;
    for (let t = 0; t < T; t++) {
      const w = this.weights[t];
      const wlw = w * Math.log(w);
      this.weightLogWeights[t] = wlw;
      this.sumOfWeights += w;
      this.sumOfWeightLogWeights += wlw;
    }
    this.startingEntropy = Math.log(this.sumOfWeights) - this.sumOfWeightLogWeights / this.sumOfWeights;

    this.sumsOfOnes = new Int32Array(count);
    this.sumsOfWeights = new Float64Array(count);
    this.sumsOfWeightLogWeights = new Float64Array(count);
    this.entropies = new Float64Array(count);

    const stackCap = count * T;
    this.stackI = new Int32Array(stackCap);
    this.stackT = new Int32Array(stackCap);
    this.stacksize = 0;
  }

  // Profiling accumulators (profile-model.ts only; not in src/).
  pubProf = { nextMs: 0, obsMs: 0, propMs: 0, initMs: 0, clearMs: 0, banCalls: 0, banMs: 0, decrements: 0, scanIters: 0, observeSteps: 0 };

  /**
   * Run the observe-propagate loop.
   * @param seed  PRNG seed (mulberry32). Same seed => same collapse sequence.
   * @param limit max observe steps; -1 = run to completion (the usual case).
   * @returns true on success (or limit reached), false on contradiction.
   */
  run(seed: number, limit: number): boolean {
    if (this.wave.length === 0) {
      const ti = performance.now();
      this.init();
      this.pubProf.initMs += performance.now() - ti;
    }
    const tc = performance.now();
    this.clear();
    this.pubProf.clearMs += performance.now() - tc;

    const random: Random = mulberry32(seed);
    const limitNeg = limit < 0;

    for (let l = 0; limitNeg || l < limit; l++) {
      const tn = performance.now();
      const node = this.nextUnobservedNode(random);
      this.pubProf.nextMs += performance.now() - tn;
      if (node >= 0) {
        this.pubProf.observeSteps++;
        const to = performance.now();
        this.observe(node, random);
        this.pubProf.obsMs += performance.now() - to;
        const tp = performance.now();
        const success = this.propagate();
        this.pubProf.propMs += performance.now() - tp;
        if (!success) return false;
      } else {
        // No unobserved node remains: every cell has collapsed to one variant.
        const { wave, T, observed } = this;
        for (let i = 0; i < wave.length; i++) {
          const w = wave[i];
          for (let t = 0; t < T; t++) {
            if (w[t]) {
              observed[i] = t;
              break;
            }
          }
        }
        return true;
      }
    }
    return true;
  }

  private nextUnobservedNode(random: Random): number {
    if (this.heuristic === Heuristic.Scanline) {
      for (let i = this.observedSoFar; i < this.wave.length; i++) {
        if (!this.periodic && (i % this.MX + this.N > this.MX || ((i / this.MX) | 0) + this.N > this.MY)) continue;
        if (this.sumsOfOnes[i] > 1) {
          this.observedSoFar = i + 1;
          return i;
        }
      }
      return -1;
    }

    let min = 1e4;
    let argmin = -1;
    const { wave, sumsOfOnes, entropies, MX, MY, N, periodic, heuristic } = this;
    for (let i = 0; i < wave.length; i++) {
      this.pubProf.scanIters++;
      if (!periodic && (i % MX + N > MX || ((i / MX) | 0) + N > MY)) continue;
      const remainingValues = sumsOfOnes[i];
      const entropy = heuristic === Heuristic.Entropy ? entropies[i] : remainingValues;
      if (remainingValues > 1 && entropy <= min) {
        const noise = 1e-6 * random.nextDouble();
        if (entropy + noise < min) {
          min = entropy + noise;
          argmin = i;
        }
      }
    }
    return argmin;
  }

  private observe(node: number, random: Random): void {
    const w = this.wave[node];
    const dist = this.distribution;
    const weights = this.weights;
    for (let t = 0; t < this.T; t++) {
      dist[t] = w[t] ? weights[t] : 0;
    }
    const r = weightedPick(dist, random.nextDouble());
    for (let t = 0; t < this.T; t++) {
      if (w[t] !== (t === r)) this.ban(node, t);
    }
  }

  private propagate(): boolean {
    const { propagator, compatible, stackI, stackT, MX, N, periodic } = this;
    while (this.stacksize > 0) {
      this.stacksize--;
      const i1 = stackI[this.stacksize];
      const t1 = stackT[this.stacksize];

      const x1 = i1 % MX;
      const y1 = (i1 / MX) | 0;

      for (let d = 0; d < 4; d++) {
        let x2 = x1 + DX[d];
        let y2 = y1 + DY[d];
        if (!periodic && (x2 < 0 || y2 < 0 || x2 + N > MX || y2 + N > this.MY)) continue;

        if (x2 < 0) x2 += MX;
        else if (x2 >= MX) x2 -= MX;
        if (y2 < 0) y2 += this.MY;
        else if (y2 >= this.MY) y2 -= this.MY;

        const i2 = x2 + y2 * MX;
        const p = propagator[d][t1];
        const compat = compatible[i2];

        for (let l = 0; l < p.length; l++) {
          const t2 = p[l];
          const comp = compat[t2];

          this.pubProf.decrements++;
          comp[d]--;
          if (comp[d] === 0) this.ban(i2, t2);
        }
      }
    }
    return this.sumsOfOnes[0] > 0;
  }

  protected ban(i: number, t: number): void {
    this.pubProf.banCalls++;
    this.wave[i][t] = false;

    const comp = this.compatible[i][t];
    comp[0] = 0;
    comp[1] = 0;
    comp[2] = 0;
    comp[3] = 0;
    this.stackI[this.stacksize] = i;
    this.stackT[this.stacksize] = t;
    this.stacksize++;

    this.sumsOfOnes[i] -= 1;
    this.sumsOfWeights[i] -= this.weights[t];
    this.sumsOfWeightLogWeights[i] -= this.weightLogWeights[t];

    const sum = this.sumsOfWeights[i];
    this.entropies[i] = Math.log(sum) - this.sumsOfWeightLogWeights[i] / sum;
  }

  protected clear(): void {
    const { wave, compatible, propagator, weights } = this;
    const T = this.T;

    for (let i = 0; i < wave.length; i++) {
      const wi = wave[i];
      const ci = compatible[i];
      for (let t = 0; t < T; t++) {
        wi[t] = true;
        // support count = how many patterns the opposite-direction neighbor
        // lists as compatible with t (i.e. patterns that can sit on the d side).
        const c = ci[t];
        c[0] = propagator[OPPOSITE[0]][t].length;
        c[1] = propagator[OPPOSITE[1]][t].length;
        c[2] = propagator[OPPOSITE[2]][t].length;
        c[3] = propagator[OPPOSITE[3]][t].length;
      }

      this.sumsOfOnes[i] = weights.length;
      this.sumsOfWeights[i] = this.sumOfWeights;
      this.sumsOfWeightLogWeights[i] = this.sumOfWeightLogWeights;
      this.entropies[i] = this.startingEntropy;
      this.observed[i] = -1;
    }
    this.observedSoFar = 0;

    // Ban patterns that have no compatible neighbor in some direction at the
    // grid boundary (when not periodic). Mirrors mxgmn's Clear no-neighbor bans.
    for (let y = 0; y < this.MY; y++) {
      for (let x = 0; x < this.MX; x++) {
        if (!this.periodic && (x + this.N > this.MX || y + this.N > this.MY)) continue;

        const i = x + y * this.MX;
        for (let t = 0; t < T; t++) {
          const noRight = (this.periodic || x < this.MX - this.N) && propagator[2][t].length === 0;
          const noTop = (this.periodic || y > 0) && propagator[3][t].length === 0;
          const noLeft = (this.periodic || x > 0) && propagator[0][t].length === 0;
          const noBottom = (this.periodic || y < this.MY - this.N) && propagator[1][t].length === 0;

          if (noRight || noTop || noLeft || noBottom) this.ban(i, t);
        }
      }
    }

    if (this.ground) {
      for (let x = 0; x < this.MX; x++) {
        const bottom = x + (this.MY - 1) * this.MX;
        for (let t = 0; t < T - 1; t++) if (this.wave[bottom][t]) this.ban(bottom, t);
        for (let y = 0; y < this.MY - 1; y++) {
          const i = x + y * this.MX;
          if (this.wave[i][T - 1]) this.ban(i, T - 1);
        }
      }
    }

    if (this.stacksize > 0) this.propagate();
  }

  /** The collapsed tile-variant index per cell, or -1 where unresolved/contradicted. */
  result(): Int32Array {
    return this.observed;
  }

  /** True if every cell collapsed to exactly one variant (no contradiction). */
  isComplete(): boolean {
    for (let i = 0; i < this.wave.length; i++) {
      if (this.sumsOfOnes[i] !== 1) return false;
    }
    return true;
  }
}

/**
 * Weighted pick over a distribution: returns the index i where the running sum
 * of `values` first reaches r * total. Direct port of mxgmn's Helper.Random.
 * Returns 0 if all weights are zero (matches mxgmn's tail return).
 */
export function weightedPick(values: Float64Array | number[], r: number): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const threshold = r * sum;

  let partialSum = 0;
  for (let i = 0; i < values.length; i++) {
    partialSum += values[i];
    if (partialSum >= threshold) return i;
  }
  return 0;
}