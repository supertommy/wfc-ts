// WFCEngine — Dimension-agnostic Wave Function Collapse core.
// Extracted from WFCSolver to enable 2D, 3D, and future graph-based WFC.
//
// The engine owns the algorithm (observe/propagate/ban/run). 
// The topology defines connectivity. The solver builds the propagator from rules.

import { mulberry32, type Random } from "./prng.js";
import { EntropyHeap } from "./entropy-heap.js";
import { BucketPQ } from "./bucket-pq.js";
import type { Topology } from "./topology.js";
import type { Heuristic, StepStatus } from "./types.js";

const HeuristicEnum = {
  mrv: 1,
  entropy: 0,
  scanline: 2,
} as const;

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

/**
 * WFCEngine — The dimension-agnostic WFC state machine.
 * 
 * Requires:
 * - topology: defines cell connectivity (2D grid, 3D grid, or graph)
 * - weights: tile weights (length = T)
 * - propStart/propLen/propData: CSR propagator built by the solver
 * - heuristic: cell selection strategy
 */
export class WFCEngine {
  private readonly topology: Topology;
  private readonly T: number;
  private readonly TD: number;  // T * directionCount
  private readonly D: number;   // directionCount
  private readonly count: number;
  private readonly heuristic: number;

  // Wave state
  private wave: Uint8Array;
  private compatible: Uint8Array | Uint16Array | Int32Array;
  private observed: Int32Array;
  private sumsOfOnes: Uint8Array | Uint16Array | Int32Array;

  // Propagator (CSR format) — provided by solver
  private readonly propData: Uint8Array | Uint16Array | Int32Array;
  private readonly propStart: Uint16Array | Int32Array;
  private readonly propLen: Uint8Array | Uint16Array | Int32Array;
  private propCompatOffset: Uint8Array | Uint16Array | Int32Array;

  // Precomputed neighbor table (from topology)
  private neighbors: Int32Array;
  private neighborCompatBase: Int32Array;

  // Stack for propagation
  private stackI: Uint16Array | Int32Array;
  private stackT: Uint8Array | Uint16Array | Int32Array;
  private stacksize = 0;

  // Weights and distribution
  private readonly weights: Float64Array;
  private distribution: Float64Array;

  // Selection structures
  private entropyHeap: EntropyHeap | null = null;
  private mrvBuckets: BucketPQ | null = null;
  private dirtyHeapCells: Uint16Array | Int32Array;
  private dirtyCount = 0;
  private heapUpdateGen: Uint32Array;
  private heapGen = 0;

  // Entropy heuristic state (only used if heuristic === 'entropy')
  private weightLogWeights: Float64Array;
  private sumsOfWeights: Float64Array;
  private sumsOfWeightLogWeights: Float64Array;
  private entropies: Float64Array;
  private sumOfWeights = 0;
  private sumOfWeightLogWeights = 0;
  private startingEntropy = 0;

  // H10: Cached fixpoint state
  private wave0: Uint8Array;
  private compatible0: Uint8Array | Uint16Array | Int32Array;
  private sumsOfOnes0: Uint8Array | Uint16Array | Int32Array;
  private sumsOfWeights0: Float64Array;
  private sumsOfWeightLogWeights0: Float64Array;
  private entropies0: Float64Array;
  private observed0: Int32Array;
  private hasFixpoint = false;

  // Auto-narrowed constructors
  private CompatibleCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor;
  private SumsOfOnesCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor;
  private StackTCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor;
  private StackICtor: Uint16ArrayConstructor | Int32ArrayConstructor;

  private observedSoFar = 0;

  constructor(
    topology: Topology,
    weights: Float64Array,
    propStart: Uint16Array | Int32Array,
    propLen: Uint8Array | Uint16Array | Int32Array,
    propData: Uint8Array | Uint16Array | Int32Array,
    heuristic: Heuristic = 'mrv'
  ) {
    this.topology = topology;
    this.count = topology.cellCount;
    this.D = topology.directionCount;
    this.T = weights.length;
    this.TD = this.T * this.D;
    this.heuristic = HeuristicEnum[heuristic];
    this.weights = weights;
    this.propStart = propStart;
    this.propLen = propLen;
    this.propData = propData;

    this.distribution = new Float64Array(this.T);

    // Initialize state arrays
    const { T, TD, D, count } = this;

    // Determine max prop length for compatible narrowing
    let maxPropLen = 0;
    for (let i = 0; i < propLen.length; i++) {
      if (propLen[i] > maxPropLen) maxPropLen = propLen[i];
    }

    // Auto-narrow constructors
    this.CompatibleCtor = maxPropLen < 256 ? Uint8Array : maxPropLen < 65536 ? Uint16Array : Int32Array;
    this.SumsOfOnesCtor = T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
    this.StackTCtor = T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
    this.StackICtor = count < 65536 ? Uint16Array : Int32Array;

    // Build neighbor table from topology
    this.neighbors = new Int32Array(count * D);
    this.neighborCompatBase = new Int32Array(count * D);
    for (let i = 0; i < count; i++) {
      for (let d = 0; d < D; d++) {
        const nei = topology.neighbor(i, d);
        const nidx = i * D + d;
        this.neighbors[nidx] = nei;
        this.neighborCompatBase[nidx] = nei < 0 ? -1 : nei * TD;
      }
    }

    // Precompute propCompatOffset (H43 optimization)
    const propTotal = propData.length;
    const PropCompatOffsetCtor = TD < 256 ? Uint8Array : TD < 65536 ? Uint16Array : Int32Array;
    this.propCompatOffset = new PropCompatOffsetCtor(propTotal);
    
    // Fill propCompatOffset: for each entry, compute t2 * D + d
    let offset = 0;
    for (let d = 0; d < D; d++) {
      for (let t = 0; t < T; t++) {
        const key = d * T + t;
        const start = propStart[key];
        const len = propLen[key];
        for (let l = 0; l < len; l++) {
          const t2 = propData[start + l];
          this.propCompatOffset[start + l] = t2 * D + d;
        }
      }
    }

    // Wave and compatible
    this.wave = new Uint8Array(count * T);
    this.compatible = new this.CompatibleCtor(count * TD);
    this.observed = new Int32Array(count);

    // Entropy heuristic state
    this.weightLogWeights = new Float64Array(T);
    this.sumsOfWeights = new Float64Array(0);
    this.sumsOfWeightLogWeights = new Float64Array(0);
    this.entropies = new Float64Array(0);

    if (this.heuristic === HeuristicEnum.entropy) {
      this.sumOfWeights = 0;
      this.sumOfWeightLogWeights = 0;
      for (let t = 0; t < T; t++) {
        const w = weights[t];
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
    if (this.heuristic === HeuristicEnum.entropy) {
      this.entropyHeap = new EntropyHeap(count);
    } else if (this.heuristic === HeuristicEnum.mrv) {
      this.mrvBuckets = new BucketPQ(count, T);
    }

    // Stack
    const stackCap = count * T;
    this.stackI = new this.StackICtor(stackCap);
    this.stackT = new this.StackTCtor(stackCap);

    // Dirty list for batched heap updates
    this.dirtyHeapCells = new this.StackICtor(stackCap);
    this.heapUpdateGen = new Uint32Array(count);

    // Fixpoint snapshots
    this.wave0 = new Uint8Array(count * T);
    this.compatible0 = new this.CompatibleCtor(count * TD);
    this.sumsOfOnes0 = new this.SumsOfOnesCtor(count);
    this.sumsOfWeights0 = new Float64Array(0);
    this.sumsOfWeightLogWeights0 = new Float64Array(0);
    this.entropies0 = new Float64Array(0);
    if (this.heuristic === HeuristicEnum.entropy) {
      this.sumsOfWeights0 = new Float64Array(count);
      this.sumsOfWeightLogWeights0 = new Float64Array(count);
      this.entropies0 = new Float64Array(count);
    }
    this.observed0 = new Int32Array(count);
  }

  /**
   * Clear and reset to initial state.
   */
  private clear(): void {
    const { T, TD, D, count, wave, compatible, sumsOfOnes, observed, heuristic, propLen } = this;

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
      for (let i = 0; i < count; i++) {
        for (let t = 0; t < T; t++) {
          for (let d = 0; d < D; d++) {
            compatible[i * TD + t * D + d] = propLen[d * T + t];
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
   * @returns Int32Array of tile indices (length = cellCount)
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
   * Get tile count.
   */
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
    const { wave, distribution: dist, weights, T, D, neighbors, propStart, propLen, propData } = this;
    const base = node * T;

    // H54: LCV (Least Constraining Value) with (1 + freedom)^3 weighting
    for (let t = 0; t < T; t++) {
      if (!wave[base + t]) {
        dist[t] = 0;
        continue;
      }

      // Count neighbor freedom if we pick tile t
      let freedom = 0;
      const nbase = node * D;
      for (let d = 0; d < D; d++) {
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
    const { propData, propCompatOffset, propStart, propLen, compatible, stackI, stackT, neighbors, neighborCompatBase, T, D } = this;

    while (this.stacksize > 0) {
      this.stacksize--;
      const i1 = stackI[this.stacksize];
      const t1 = stackT[this.stacksize];

      for (let d = 0; d < D; d++) {
        const compatBase = neighborCompatBase[i1 * D + d];
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
            const i2 = neighbors[i1 * D + d];
            const success = this.ban(i2, t2);
            if (!success) return false;
          }
        }
      }
    }
    return true;
  }

  private ban(i: number, t: number): boolean {
    const { wave, T, TD, D, sumsOfOnes, compatible, heuristic } = this;
    const idx = i * T + t;
    if (wave[idx] === 0) return true;

    wave[idx] = 0;

    // Zero out compatible for this (cell, tile)
    const cbase = i * TD + t * D;
    for (let d = 0; d < D; d++) {
      compatible[cbase + d] = 0;
    }

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
