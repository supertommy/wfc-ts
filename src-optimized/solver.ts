// WFCSolver — Wave Function Collapse solver with clean injection API.
// Optimized under Mike Acton's ratchet methodology.
//
// Usage:
//   const solver = new WFCSolver({
//     width: 16,
//     height: 16,
//     periodic: false,
//     weights: [1, 1, 1],
//     rules: [
//       { forTile: 0, left: [0, 1], right: [0, 1], up: [0, 1], down: [0, 1] },
//       { forTile: 1, left: [0, 1, 2], right: [0, 1, 2], up: [0, 1, 2], down: [0, 1, 2] },
//       { forTile: 2, left: [1, 2], right: [1, 2], up: [1, 2], down: [1, 2] },
//     ],
//   });
//   if (solver.run(42)) {
//     const grid = solver.result(); // Int32Array of tile indices
//   }

import { mulberry32, type Random } from "./prng.js";
import { EntropyHeap } from "./entropy-heap.js";
import { BucketPQ } from "./bucket-pq.js";

export type Heuristic = 'mrv' | 'entropy' | 'scanline';

const HeuristicEnum = {
  mrv: 1,
  entropy: 0,
  scanline: 2,
} as const;

/**
 * Adjacency rule for a single tile.
 * Lists which tiles can be adjacent in each direction.
 */
export interface TileRule {
  forTile: number;
  left: number[];
  right: number[];
  up: number[];
  down: number[];
}

export interface WFCSolverOptions {
  width: number;
  height: number;
  periodic: boolean;
  
  /** Weight per tile (length = number of tiles). Higher = more likely to be picked. */
  weights: number[] | Float64Array;
  
  /** Adjacency rules for each tile. */
  rules: TileRule[];
  
  /** Selection heuristic. Default: 'mrv' (fastest). */
  heuristic?: Heuristic;
}

/**
 * Progress / result status yielded by stepRun().
 */
export interface StepStatus {
  done: boolean;
  observedCell?: number;
  attempt: number;
  cellsResolved: number;
  ok?: boolean;
  complete?: boolean;
}

const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];

// Direction mapping: left=0, up=1, right=2, down=3 (matches mxgmn)
const DIR_LEFT = 0;
const DIR_UP = 1;
const DIR_RIGHT = 2;
const DIR_DOWN = 3;

/**
 * Derive a deterministic restart seed from the base seed and attempt number.
 * Pure function (no state) so restarts are reproducible.
 */
function deriveRestartSeed(base: number, attempt: number): number {
  let h = (base ^ (attempt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Weighted random selection. Returns the index where cumulative weight exceeds threshold.
 */
function weightedPick(distribution: Float64Array, threshold: number): number {
  let sum = 0;
  for (let i = 0; i < distribution.length; i++) sum += distribution[i];
  const r = threshold * sum;
  let acc = 0;
  for (let i = 0; i < distribution.length; i++) {
    acc += distribution[i];
    if (r <= acc) return i;
  }
  // Fallback: find last non-zero
  for (let i = distribution.length - 1; i >= 0; i--) {
    if (distribution[i] > 0) return i;
  }
  return 0;
}

export class WFCSolver {
  private MX: number;
  private MY: number;
  private T: number;
  private T4: number;
  private count: number;
  private periodic: boolean;
  private heuristic: number;

  // Wave state
  private wave: Uint8Array = new Uint8Array(0);
  private compatible: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  private observed: Int32Array = new Int32Array(0);
  private sumsOfOnes: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);

  // Propagator (CSR format)
  private propData: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  private propStart: Uint16Array | Int32Array = new Int32Array(0);
  private propLen: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  private propCompatOffset: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);

  // Neighbor table
  private neighbors: Int32Array = new Int32Array(0);
  private neighborCompatBase: Int32Array = new Int32Array(0);

  // Stack for propagation
  private stackI: Uint16Array | Int32Array = new Int32Array(0);
  private stackT: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  private stacksize = 0;

  // Weights and distribution
  private weights: Float64Array;
  private distribution: Float64Array;

  // Selection structures
  private entropyHeap: EntropyHeap | null = null;
  private mrvBuckets: BucketPQ | null = null;
  private dirtyHeapCells: Uint16Array | Int32Array = new Int32Array(0);
  private dirtyCount = 0;
  private heapUpdateGen: Uint32Array = new Uint32Array(0);
  private heapGen = 0;

  // Entropy heuristic state (only used if heuristic === 'entropy')
  private weightLogWeights: Float64Array = new Float64Array(0);
  private sumsOfWeights: Float64Array = new Float64Array(0);
  private sumsOfWeightLogWeights: Float64Array = new Float64Array(0);
  private entropies: Float64Array = new Float64Array(0);
  private sumOfWeights = 0;
  private sumOfWeightLogWeights = 0;
  private startingEntropy = 0;

  // H10: Cached fixpoint state
  private wave0: Uint8Array = new Uint8Array(0);
  private compatible0: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  private sumsOfOnes0: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  private sumsOfWeights0: Float64Array = new Float64Array(0);
  private sumsOfWeightLogWeights0: Float64Array = new Float64Array(0);
  private entropies0: Float64Array = new Float64Array(0);
  private observed0: Int32Array = new Int32Array(0);
  private hasFixpoint = false;

  // Auto-narrowed constructors
  private CompatibleCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;
  private SumsOfOnesCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;
  private StackTCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;
  private StackICtor: Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;

  private observedSoFar = 0;

  constructor(opts: WFCSolverOptions) {
    const { width, height, periodic, weights, rules, heuristic = 'mrv' } = opts;

    this.MX = width;
    this.MY = height;
    this.periodic = periodic;
    this.heuristic = HeuristicEnum[heuristic];
    this.T = weights.length;
    this.T4 = this.T * 4;
    this.count = width * height;

    // Copy weights
    this.weights = weights instanceof Float64Array ? weights : new Float64Array(weights);
    this.distribution = new Float64Array(this.T);

    // Build propagator from rules
    this.buildPropagator(rules);

    // Initialize state arrays
    this.initState();
  }

  /**
   * Convert rules array to CSR propagator format.
   */
  private buildPropagator(rules: TileRule[]): void {
    const T = this.T;
    
    // Build propagator[d][t] = list of allowed tiles
    // Direction order: left=0, up=1, right=2, down=3
    const propagator: number[][][] = [[], [], [], []];
    for (let d = 0; d < 4; d++) {
      propagator[d] = new Array(T).fill(null).map(() => []);
    }

    for (const rule of rules) {
      const t = rule.forTile;
      if (t < 0 || t >= T) continue;
      propagator[DIR_LEFT][t] = rule.left;
      propagator[DIR_UP][t] = rule.up;
      propagator[DIR_RIGHT][t] = rule.right;
      propagator[DIR_DOWN][t] = rule.down;
    }

    // Convert to CSR format
    // First pass: compute total size and max lengths
    let total = 0;
    let maxLen = 0;
    for (let d = 0; d < 4; d++) {
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
    const PropCompatOffsetCtor = T * 4 < 256 ? Uint8Array : T * 4 < 65536 ? Uint16Array : Int32Array;

    this.propData = new PropDataCtor(total);
    this.propStart = new PropStartCtor(4 * T);
    this.propLen = new PropLenCtor(4 * T);
    this.propCompatOffset = new PropCompatOffsetCtor(total);

    // Second pass: fill CSR arrays
    let offset = 0;
    for (let d = 0; d < 4; d++) {
      for (let t = 0; t < T; t++) {
        const key = d * T + t;
        const list = propagator[d][t];
        this.propStart[key] = offset;
        this.propLen[key] = list.length;
        for (let i = 0; i < list.length; i++) {
          const t2 = list[i];
          this.propData[offset] = t2;
          // H43: precompute compatible offset for faster propagation
          this.propCompatOffset[offset] = t2 * 4 + d;
          offset++;
        }
      }
    }
  }

  /**
   * Initialize state arrays after propagator is built.
   */
  private initState(): void {
    const { T, T4, count, heuristic } = this;

    // Determine max prop length for compatible narrowing
    let maxPropLen = 0;
    for (let i = 0; i < this.propLen.length; i++) {
      if (this.propLen[i] > maxPropLen) maxPropLen = this.propLen[i];
    }

    // Auto-narrow constructors
    this.CompatibleCtor = maxPropLen < 256 ? Uint8Array : maxPropLen < 65536 ? Uint16Array : Int32Array;
    this.SumsOfOnesCtor = T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
    this.StackTCtor = T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
    this.StackICtor = count < 65536 ? Uint16Array : Int32Array;

    // Build neighbor table
    this.neighbors = new Int32Array(count * 4);
    this.neighborCompatBase = new Int32Array(count * 4);
    const { MX, MY, periodic } = this;
    for (let i = 0; i < count; i++) {
      const x1 = i % MX;
      const y1 = (i / MX) | 0;
      for (let d = 0; d < 4; d++) {
        let x2 = x1 + DX[d];
        let y2 = y1 + DY[d];
        let nei: number;
        if (!periodic && (x2 < 0 || y2 < 0 || x2 >= MX || y2 >= MY)) {
          nei = -1;
        } else {
          if (x2 < 0) x2 += MX;
          else if (x2 >= MX) x2 -= MX;
          if (y2 < 0) y2 += MY;
          else if (y2 >= MY) y2 -= MY;
          nei = x2 + y2 * MX;
        }
        const nidx = i * 4 + d;
        this.neighbors[nidx] = nei;
        this.neighborCompatBase[nidx] = nei < 0 ? -1 : nei * T4;
      }
    }

    // Wave and compatible
    this.wave = new Uint8Array(count * T);
    this.compatible = new this.CompatibleCtor(count * T4);
    this.observed = new Int32Array(count);

    // Entropy heuristic state
    if (heuristic === HeuristicEnum.entropy) {
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
      this.sumsOfWeights = new Float64Array(count);
      this.sumsOfWeightLogWeights = new Float64Array(count);
      this.entropies = new Float64Array(count);
    }

    this.sumsOfOnes = new this.SumsOfOnesCtor(count);

    // Selection structures
    if (heuristic === HeuristicEnum.entropy) {
      this.entropyHeap = new EntropyHeap(count);
    } else if (heuristic === HeuristicEnum.mrv) {
      this.mrvBuckets = new BucketPQ(count, T);
    }

    // Stack
    const stackCap = count * T;
    this.stackI = new this.StackICtor(stackCap);
    this.stackT = new this.StackTCtor(stackCap);
    this.stacksize = 0;

    // Dirty list for batched heap updates
    this.dirtyHeapCells = new this.StackICtor(stackCap);
    this.dirtyCount = 0;
    this.heapUpdateGen = new Uint32Array(count);
    this.heapGen = 0;

    // Fixpoint snapshots
    this.wave0 = new Uint8Array(count * T);
    this.compatible0 = new this.CompatibleCtor(count * T4);
    this.sumsOfOnes0 = new this.SumsOfOnesCtor(count);
    if (heuristic === HeuristicEnum.entropy) {
      this.sumsOfWeights0 = new Float64Array(count);
      this.sumsOfWeightLogWeights0 = new Float64Array(count);
      this.entropies0 = new Float64Array(count);
    }
    this.observed0 = new Int32Array(count);
    this.hasFixpoint = false;
  }

  /**
   * Clear and reset to initial state.
   */
  private clear(): void {
    const { T, T4, count, wave, compatible, sumsOfOnes, observed, heuristic } = this;

    // H10: If we have a cached fixpoint, restore it
    if (this.hasFixpoint) {
      wave.set(this.wave0);
      compatible.set(this.compatible0);
      sumsOfOnes.set(this.sumsOfOnes0);
      observed.set(this.observed0);
      if (heuristic === HeuristicEnum.entropy) {
        this.sumsOfWeights.set(this.sumsOfWeights0);
        this.sumsOfWeightLogWeights.set(this.sumsOfWeightLogWeights0);
        this.entropies.set(this.entropies0);
      }
    } else {
      // First clear: compute fixpoint from scratch
      
      // Initialize wave to all possible
      wave.fill(1);

      // Initialize compatible counts from propagator
      const { propStart, propLen } = this;
      for (let i = 0; i < count; i++) {
        for (let t = 0; t < T; t++) {
          for (let d = 0; d < 4; d++) {
            compatible[i * T4 + t * 4 + d] = propLen[d * T + t];
          }
        }
      }

      // Initialize sumsOfOnes
      sumsOfOnes.fill(T);

      // Initialize entropy state
      if (heuristic === HeuristicEnum.entropy) {
        const { sumsOfWeights, sumsOfWeightLogWeights, entropies, sumOfWeights, startingEntropy } = this;
        sumsOfWeights.fill(sumOfWeights);
        sumsOfWeightLogWeights.fill(this.sumOfWeightLogWeights);
        entropies.fill(startingEntropy);
      }

      // Initialize observed
      observed.fill(-1);

      // Initial propagation (boundary constraints for non-periodic)
      if (!this.periodic) {
        // Ban tiles at boundaries that can't fit
        // For simple model (N=1), no boundary bans needed
      }

      // Cache fixpoint
      this.wave0.set(wave);
      this.compatible0.set(compatible);
      this.sumsOfOnes0.set(sumsOfOnes);
      this.observed0.set(observed);
      if (heuristic === HeuristicEnum.entropy) {
        this.sumsOfWeights0.set(this.sumsOfWeights);
        this.sumsOfWeightLogWeights0.set(this.sumsOfWeightLogWeights);
        this.entropies0.set(this.entropies);
      }
      this.hasFixpoint = true;
    }

    // Reset stack and heap
    this.stacksize = 0;
    this.observedSoFar = 0;
    this.heapGen++;
    this.dirtyCount = 0;

    // Rebuild selection structure
    if (heuristic === HeuristicEnum.entropy && this.entropyHeap) {
      this.entropyHeap.clear();
      for (let i = 0; i < count; i++) {
        if (sumsOfOnes[i] > 1) {
          this.entropyHeap.push(i, this.entropies[i]);
        }
      }
    } else if (heuristic === HeuristicEnum.mrv && this.mrvBuckets) {
      this.mrvBuckets.clear();
      for (let i = 0; i < count; i++) {
        const s = sumsOfOnes[i];
        if (s > 1) this.mrvBuckets.updateCell(i, s);
      }
    }
  }

  /**
   * Run the solver to completion.
   * @param seed - Random seed for determinism
   * @param limit - Max observations (-1 = unlimited)
   * @param restartBudget - Max restart attempts on contradiction (default: 100)
   * @returns true if solved, false if all attempts failed
   */
  run(seed: number, limit = -1, restartBudget = 100): boolean {
    for (let attempt = 0; attempt <= restartBudget; attempt++) {
      this.clear();
      const s = attempt === 0 ? seed : deriveRestartSeed(seed, attempt);
      const random: Random = mulberry32(s);
      const limitNeg = limit < 0;

      let contradicted = false;
      for (let l = 0; limitNeg || l < limit; l++) {
        const node = this.nextUnobservedNode(random);
        if (node >= 0) {
          this.observe(node, random);
          const success = this.propagate();
          if (!success) {
            contradicted = true;
            break;
          }
        } else {
          // All cells collapsed - success!
          this.finalizeObserved();
          return true;
        }
      }
      if (!contradicted) {
        // Limit reached without contradiction
        return true;
      }
      // Contradiction: retry with derived seed
    }
    return false;
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
    let totalObserves = 0;

    for (let attempt = 0; attempt <= restartBudget; attempt++) {
      this.clear();
      const s = attempt === 0 ? seed : deriveRestartSeed(seed, attempt);
      const random: Random = mulberry32(s);
      const limitNeg = limit < 0;

      let contradicted = false;
      for (let l = 0; limitNeg || l < limit; l++) {
        const node = this.nextUnobservedNode(random);
        if (node >= 0) {
          this.observe(node, random);
          const success = this.propagate();
          totalObserves++;

          const cellsResolved = this.countResolved();

          if (signal && signal.aborted) {
            yield { done: true, ok: false, complete: false, attempt, cellsResolved, observedCell: node };
            return;
          }

          if (yieldEvery > 0 && totalObserves % yieldEvery === 0) {
            yield { done: false, observedCell: node, attempt, cellsResolved };
          }

          if (!success) {
            contradicted = true;
            break;
          }
        } else {
          // Success!
          this.finalizeObserved();
          yield { done: true, ok: true, complete: true, attempt, cellsResolved: this.count };
          return;
        }
      }
      if (!contradicted) {
        const cellsResolved = this.countResolved();
        const complete = this.isComplete();
        yield { done: true, ok: true, complete, attempt, cellsResolved };
        return;
      }
      // Contradiction: continue to next attempt
      if (signal && signal.aborted) {
        yield { done: true, ok: false, complete: false, attempt, cellsResolved: this.countResolved() };
        return;
      }
    }
    yield { done: true, ok: false, complete: false, attempt: restartBudget, cellsResolved: this.countResolved() };
  }

  /**
   * Get the result after a successful run.
   * @returns Int32Array of tile indices (length = width * height)
   */
  result(): Int32Array {
    return this.observed;
  }

  /**
   * Get the current wave state for visualization.
   */
  getWave(): Uint8Array {
    return this.wave;
  }

  /**
   * Get dimensions.
   */
  get width(): number { return this.MX; }
  get height(): number { return this.MY; }
  get tileCount(): number { return this.T; }

  // === Private methods ===

  private flushHeapUpdates(): void {
    const { dirtyHeapCells, dirtyCount, heapUpdateGen, heapGen, sumsOfOnes, heuristic } = this;
    if (dirtyCount === 0) return;

    if (heuristic === HeuristicEnum.entropy && this.entropyHeap) {
      const heap = this.entropyHeap;
      for (let j = 0; j < dirtyCount; j++) {
        const i = dirtyHeapCells[j];
        if (heapUpdateGen[i] !== heapGen) continue;
        heapUpdateGen[i] = 0;
        const s = sumsOfOnes[i];
        if (s <= 1) {
          heap.remove(i);
        } else {
          heap.update(i, this.entropies[i]);
        }
      }
    } else if (heuristic === HeuristicEnum.mrv && this.mrvBuckets) {
      const bq = this.mrvBuckets;
      for (let j = 0; j < dirtyCount; j++) {
        const i = dirtyHeapCells[j];
        if (heapUpdateGen[i] !== heapGen) continue;
        heapUpdateGen[i] = 0;
        bq.updateCell(i, sumsOfOnes[i]);
      }
    }
    this.dirtyCount = 0;
  }

  private nextUnobservedNode(random: Random): number {
    const { heuristic, sumsOfOnes, count } = this;

    if (heuristic === HeuristicEnum.scanline) {
      for (let i = this.observedSoFar; i < count; i++) {
        if (sumsOfOnes[i] > 1) {
          this.observedSoFar = i + 1;
          return i;
        }
      }
      return -1;
    }

    this.flushHeapUpdates();

    if (heuristic === HeuristicEnum.mrv) {
      const bq = this.mrvBuckets;
      if (!bq || bq.isEmpty()) return -1;
      const i = bq.popMin();
      if (i == null || i < 0) return -1;
      if (sumsOfOnes[i] <= 1) return -1;
      return i;
    }

    // Entropy heuristic
    const heap = this.entropyHeap;
    if (!heap) return -1;
    while (!heap.isEmpty()) {
      const entry = heap.popEntry();
      if (!entry) break;
      const i = entry.key;
      if (sumsOfOnes[i] <= 1) continue;
      if (entry.entropy !== this.entropies[i]) continue;
      return i;
    }
    return -1;
  }

  private observe(node: number, random: Random): void {
    const { wave, distribution: dist, weights, T, neighbors, propStart, propLen, propData } = this;
    const base = node * T;

    // H54: LCV (Least Constraining Value) with (1 + freedom)^3 weighting
    for (let t = 0; t < T; t++) {
      if (!wave[base + t]) {
        dist[t] = 0;
        continue;
      }

      // Count neighbor freedom if we pick tile t
      let freedom = 0;
      const nbase = node * 4;
      for (let d = 0; d < 4; d++) {
        const i2 = neighbors[nbase + d];
        if (i2 < 0) continue;

        const key = d * T + t;
        const start = propStart[key];
        const len = propLen[key];
        const nwbase = i2 * T;

        for (let l = 0; l < len; l++) {
          const t2 = propData[start + l];
          if (wave[nwbase + t2]) freedom++;
        }
      }

      // Weight = original weight * (1 + freedom)^3
      const f = 1 + freedom;
      dist[t] = weights[t] * f * f * f;
    }

    const r = weightedPick(dist, random.nextDouble());
    for (let t = 0; t < T; t++) {
      if (wave[base + t] !== (t === r ? 1 : 0)) this.ban(node, t);
    }
  }

  private propagate(): boolean {
    const { propData, propCompatOffset, propStart, propLen, compatible, stackI, stackT, neighbors, neighborCompatBase, T } = this;

    while (this.stacksize > 0) {
      this.stacksize--;
      const i1 = stackI[this.stacksize];
      const t1 = stackT[this.stacksize];

      for (let d = 0; d < 4; d++) {
        const compatBase = neighborCompatBase[i1 * 4 + d];
        if (compatBase < 0) continue;

        const key = d * T + t1;
        const start = propStart[key];
        const len = propLen[key];

        for (let l = 0; l < len; l++) {
          const coff = propCompatOffset[start + l];
          const cidx = compatBase + coff;
          const c = compatible[cidx];
          if (c === 0) continue;

          (compatible as any)[cidx] = c - 1;
          if (c === 1) {
            const t2 = propData[start + l];
            const i2 = neighbors[i1 * 4 + d];
            const success = this.ban(i2, t2);
            if (!success) return false;
          }
        }
      }
    }
    return true;
  }

  private ban(i: number, t: number): boolean {
    const { wave, T, T4, sumsOfOnes, compatible, heuristic } = this;
    const idx = i * T + t;
    if (wave[idx] === 0) return true;

    wave[idx] = 0;

    // Zero out compatible for this (cell, tile)
    const cbase = i * T4 + t * 4;
    compatible[cbase] = 0;
    compatible[cbase + 1] = 0;
    compatible[cbase + 2] = 0;
    compatible[cbase + 3] = 0;

    // Push to propagation stack
    this.stackI[this.stacksize] = i;
    this.stackT[this.stacksize] = t;
    this.stacksize++;

    // Update sumsOfOnes
    const newSum = sumsOfOnes[i] - 1;
    (sumsOfOnes as any)[i] = newSum;

    if (newSum === 0) return false; // Contradiction

    // Update entropy state if needed
    if (heuristic === HeuristicEnum.entropy) {
      const w = this.weights[t];
      const wlw = this.weightLogWeights[t];
      this.sumsOfWeights[i] -= w;
      this.sumsOfWeightLogWeights[i] -= wlw;
      const sw = this.sumsOfWeights[i];
      this.entropies[i] = Math.log(sw) - this.sumsOfWeightLogWeights[i] / sw;
    }

    // Mark cell dirty for heap update
    if (this.heapUpdateGen[i] !== this.heapGen) {
      this.heapUpdateGen[i] = this.heapGen;
      this.dirtyHeapCells[this.dirtyCount++] = i;
    }

    return true;
  }

  private finalizeObserved(): void {
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
  }

  private countResolved(): number {
    let c = 0;
    const { sumsOfOnes, count } = this;
    for (let i = 0; i < count; i++) {
      if (sumsOfOnes[i] === 1) c++;
    }
    return c;
  }

  private isComplete(): boolean {
    const { sumsOfOnes, count } = this;
    for (let i = 0; i < count; i++) {
      if (sumsOfOnes[i] !== 1) return false;
    }
    return true;
  }

  /**
   * Memory footprint in bytes.
   */
  footprintBytes(): number {
    let bytes = 0;
    bytes += this.wave.byteLength;
    bytes += this.compatible.byteLength;
    bytes += this.observed.byteLength;
    bytes += this.sumsOfOnes.byteLength;
    bytes += this.propData.byteLength;
    bytes += this.propStart.byteLength;
    bytes += this.propLen.byteLength;
    bytes += this.propCompatOffset.byteLength;
    bytes += this.neighbors.byteLength;
    bytes += this.neighborCompatBase.byteLength;
    bytes += this.stackI.byteLength;
    bytes += this.stackT.byteLength;
    bytes += this.weights.byteLength;
    bytes += this.distribution.byteLength;
    bytes += this.dirtyHeapCells.byteLength;
    bytes += this.heapUpdateGen.byteLength;
    bytes += this.wave0.byteLength;
    bytes += this.compatible0.byteLength;
    bytes += this.sumsOfOnes0.byteLength;
    bytes += this.observed0.byteLength;
    if (this.heuristic === HeuristicEnum.entropy) {
      bytes += this.weightLogWeights.byteLength;
      bytes += this.sumsOfWeights.byteLength;
      bytes += this.sumsOfWeightLogWeights.byteLength;
      bytes += this.entropies.byteLength;
      bytes += this.sumsOfWeights0.byteLength;
      bytes += this.sumsOfWeightLogWeights0.byteLength;
      bytes += this.entropies0.byteLength;
    }
    if (this.entropyHeap) bytes += this.entropyHeap.footprintBytes();
    if (this.mrvBuckets) bytes += this.mrvBuckets.footprintBytes();
    return bytes;
  }
}
