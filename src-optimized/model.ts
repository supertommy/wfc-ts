// Optimized Model — the WFC observation/propagation core.
// Copyright (C) 2016 Maxim Gumin, MIT. Faithful port for wfc-ts, then optimized
// under the ratchet. This is NOT the reference (src/model.ts); it is the
// optimized solver that the harness measures and gates.
//
// HYPOTHESIS 1 (kept): flatten `wave` and `compatible` to typed arrays (SoA).
//
//   The reference stored `wave: boolean[][]` and `compatible: number[][][]`
//   (arrays-of-arrays-of-arrays). The propagation hot loop — the dominant cost
//   on the larger-T inputs (66-78% on circuit/rooms per the profile) — did
//   `compatible[i2][t2][d]--`, chasing three JS array objects per access: cache-
//   hostile and allocation-heavy. This change flattens both into single typed
//   arrays indexed arithmetically:
//     wave      -> Uint8Array  of length count*T,        wave[i*T + t]
//     compatible-> Int32Array of length count*T*4,      compatible[i*T4 + t*4 + d]
//   Same counts, same decrements, same bans, same selection sequence — so the
//   output is unchanged (valid AND byte-identical to the reference). The win is
//   cache locality + zero object indirection in the inner loop. (Mike Acton
//   DOD: indices over references, SoA over AoS, data layout as first-class.)
//
// HYPOTHESIS 2 (this iteration): flatten `propagator` to flat CSR typed arrays.
//
//   propagator[d][t1] was a number[][] list of allowed t2. In propagate() hot
//   path and in clear() .length checks we chased two array objects per access.
//   CSR layout: one Int32Array propData (concat all lists, d then t1 order),
//   plus propStart/propLen indexed by (d*T + t1). Build once in ctor (untimed).
//   Same lists + same iteration order over t2 => byte-identical outputs.
//   Targets propagation-bound inputs (circuit/rooms). Pure layout, Tier-1.
//
// PRNG: mulberry32, same as the reference (deterministic contract).

import { mulberry32, type Random } from "./prng.js";

export const enum Heuristic {
  Entropy = 0,
  MRV = 1,
  Scanline = 2,
}

const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];
const OPPOSITE = [2, 3, 0, 1];

export abstract class Model {
  protected MX = 0;
  protected MY = 0;
  protected T = 0;
  protected T4 = 0; // T*4 — compatible-array stride (per cell)
  protected count = 0; // MX*MY — number of cells
  protected N = 1;
  protected periodic = false;
  protected ground = false;

  // Flattened wave: wave[i*T + t] is 1 while variant t is still possible at cell i.
  protected wave: Uint8Array = new Uint8Array(0);
  // Flattened propagator (CSR): propData concatenated lists (d outer, t1 inner),
  // propStart/propLen indexed d*T + t1. Same order as old lists => byte-id.
  protected propData: Int32Array = new Int32Array(0);
  protected propStart: Int32Array = new Int32Array(0);
  protected propLen: Int32Array = new Int32Array(0);
  // Flattened AC-4 support counts: compatible[i*T4 + t*4 + d]. Hits 0 => ban.
  protected compatible: Int32Array = new Int32Array(0);
  protected observed: Int32Array = new Int32Array(0);

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

  protected init(): void {
    const count = this.MX * this.MY;
    const T = this.T;
    const T4 = T * 4;
    this.count = count;
    this.T4 = T4;

    // wave: all 1 (everything possible). compatible: filled by clear().
    this.wave = new Uint8Array(count * T); // zeroed; clear() sets the valid cells to 1
    this.compatible = new Int32Array(count * T4);
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

  run(seed: number, limit: number): boolean {
    if (this.count === 0) this.init();
    this.clear();

    const random: Random = mulberry32(seed);
    const limitNeg = limit < 0;

    for (let l = 0; limitNeg || l < limit; l++) {
      const node = this.nextUnobservedNode(random);
      if (node >= 0) {
        this.observe(node, random);
        const success = this.propagate();
        if (!success) return false;
      } else {
        // No unobserved node remains: every cell has collapsed to one variant.
        const { wave, T, observed, count } = this;
        for (let i = 0; i < count; i++) {
          const base = i * T;
          for (let t = 0; t < T; t++) {
            if (wave[base + t]) {
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
    const { count, sumsOfOnes, entropies, MX, MY, N, periodic, heuristic } = this;
    if (heuristic === Heuristic.Scanline) {
      for (let i = this.observedSoFar; i < count; i++) {
        if (!periodic && (i % MX + N > MX || ((i / MX) | 0) + N > MY)) continue;
        if (sumsOfOnes[i] > 1) {
          this.observedSoFar = i + 1;
          return i;
        }
      }
      return -1;
    }

    let min = 1e4;
    let argmin = -1;
    for (let i = 0; i < count; i++) {
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
    const { wave, distribution: dist, weights, T } = this;
    const base = node * T;
    for (let t = 0; t < T; t++) {
      dist[t] = wave[base + t] ? weights[t] : 0;
    }
    const r = weightedPick(dist, random.nextDouble());
    for (let t = 0; t < T; t++) {
      if (wave[base + t] !== (t === r ? 1 : 0)) this.ban(node, t);
    }
  }

  private propagate(): boolean {
    const { propData, propStart, propLen, compatible, stackI, stackT, MX, MY, N, periodic, T4, T } = this;
    while (this.stacksize > 0) {
      this.stacksize--;
      const i1 = stackI[this.stacksize];
      const t1 = stackT[this.stacksize];

      const x1 = i1 % MX;
      const y1 = (i1 / MX) | 0;

      for (let d = 0; d < 4; d++) {
        let x2 = x1 + DX[d];
        let y2 = y1 + DY[d];
        if (!periodic && (x2 < 0 || y2 < 0 || x2 + N > MX || y2 + N > MY)) continue;

        if (x2 < 0) x2 += MX;
        else if (x2 >= MX) x2 -= MX;
        if (y2 < 0) y2 += MY;
        else if (y2 >= MY) y2 -= MY;

        const i2 = x2 + y2 * MX;
        const key = d * T + t1;
        const start = propStart[key];
        const len = propLen[key];
        const base2 = i2 * T4;

        for (let l = 0; l < len; l++) {
          const t2 = propData[start + l];
          const cidx = base2 + t2 * 4 + d;
          if (--compatible[cidx] === 0) this.ban(i2, t2);
        }
      }
    }
    return this.sumsOfOnes[0] > 0;
  }

  protected ban(i: number, t: number): void {
    const base = i * this.T;
    this.wave[base + t] = 0;

    const cbase = i * this.T4 + t * 4;
    this.compatible[cbase] = 0;
    this.compatible[cbase + 1] = 0;
    this.compatible[cbase + 2] = 0;
    this.compatible[cbase + 3] = 0;
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
    const { wave, compatible, propStart, propLen, weights, T, T4, count } = this;

    for (let i = 0; i < count; i++) {
      const wbase = i * T;
      const cbase = i * T4;
      for (let t = 0; t < T; t++) {
        wave[wbase + t] = 1;
        // support count = how many patterns the opposite-direction neighbor
        // lists as compatible with t (i.e. patterns that can sit on the d side).
        const ct = cbase + t * 4;
        compatible[ct] = propLen[OPPOSITE[0] * T + t];
        compatible[ct + 1] = propLen[OPPOSITE[1] * T + t];
        compatible[ct + 2] = propLen[OPPOSITE[2] * T + t];
        compatible[ct + 3] = propLen[OPPOSITE[3] * T + t];
      }

      this.sumsOfOnes[i] = weights.length;
      this.sumsOfWeights[i] = this.sumOfWeights;
      this.sumsOfWeightLogWeights[i] = this.sumOfWeightLogWeights;
      this.entropies[i] = this.startingEntropy;
      this.observed[i] = -1;
    }
    this.observedSoFar = 0;

    // Ban patterns with no compatible neighbor in some direction at the
    // boundary (when not periodic). Mirrors mxgmn's Clear no-neighbor bans.
    const { MX, MY, N, periodic } = this;
    for (let y = 0; y < MY; y++) {
      for (let x = 0; x < MX; x++) {
        if (!periodic && (x + N > MX || y + N > MY)) continue;

        const i = x + y * MX;
        const wbase = i * T;
        for (let t = 0; t < T; t++) {
          const noRight = (periodic || x < MX - N) && propLen[2 * T + t] === 0;
          const noTop = (periodic || y > 0) && propLen[3 * T + t] === 0;
          const noLeft = (periodic || x > 0) && propLen[0 * T + t] === 0;
          const noBottom = (periodic || y < MY - N) && propLen[1 * T + t] === 0;

          if (noRight || noTop || noLeft || noBottom) this.ban(i, t);
        }
      }
    }

    if (this.ground) {
      for (let x = 0; x < MX; x++) {
        const bottom = x + (MY - 1) * MX;
        const wbot = bottom * T;
        for (let t = 0; t < T - 1; t++) if (this.wave[wbot + t]) this.ban(bottom, t);
        for (let y = 0; y < MY - 1; y++) {
          const i = x + y * MX;
          if (this.wave[i * T + (T - 1)]) this.ban(i, T - 1);
        }
      }
    }

    if (this.stacksize > 0) this.propagate();
  }

  result(): Int32Array {
    return this.observed;
  }

  isComplete(): boolean {
    const { sumsOfOnes, count } = this;
    for (let i = 0; i < count; i++) {
      if (sumsOfOnes[i] !== 1) return false;
    }
    return true;
  }
}

/**
 * Weighted pick over a distribution: returns the index i where the running sum
 * of `values` first reaches r * total. Direct port of mxgmn's Helper.Random.
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