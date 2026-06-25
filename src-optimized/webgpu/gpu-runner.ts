/// <reference types="@webgpu/types" />

// Hybrid CPU-observe / GPU-propagate runner (Stage 2).
// - CPU: selection (bucket PQ MRV + mulberry32 + weightedPick) + wave mirror for observe.
// - GPU: propagation state + compute (via GpuPropagator incremental + cascade-stop).
// Mirrors the run() / observe / nextUnobservedNode / ban bookkeeping of src-optimized/model.ts
// (post H30/H12/H6 etc) for determinism.
// Per-observe: CPU bans for observe cell (T-1), GPU incremental prop with early-stop readbacks on work count,
// CPU applies the returned derived bans O(banned).
// Full state upload only on clear (H10 fixpoint); incremental thereafter.
//
// Determinism: CPU selection deterministic + GPU AC-4 confluent => same (seed,budget) => same observed.
// Validity: by construction if no contradiction + complete; verified externally in bench.
//
// No debug code. Plain TS + WebGPU.

import type { Tileset } from "../tileset.js";
import { SimpleTiledModel } from "../simple-tiled-model.js";
import { Heuristic } from "../index.js";
import { BucketPQ } from "../bucket-pq.js";
import { mulberry32, type Random } from "../prng.js";
import { weightedPick } from "../model.js";
import { GpuPropagator, type GpuPropagatorData } from "./propagate-gpu.js";

class Exposed extends SimpleTiledModel {
  get T_(): number { return this.T; }
  get T4_(): number { return this.T4; }
  get count_(): number { return this.count; }
  get wave_(): Uint8Array { return this.wave; }
  get compatible_(): Uint8Array | Uint16Array | Int32Array { return this.compatible; }
  get sumsOfOnes_(): Uint8Array | Uint16Array | Int32Array { return this.sumsOfOnes; }
  get weights_(): Float64Array { return this.weights; }
  get propData_(): Uint8Array | Uint16Array | Int32Array { return this.propData; }
  get propStart_(): Uint16Array | Int32Array { return this.propStart; }
  get propLen_(): Uint8Array | Uint16Array | Int32Array { return this.propLen; }
  get neighbors_(): Int32Array { return this.neighbors; }
  get MX_(): number { return (this as any).MX as number; }
  get MY_(): number { return (this as any).MY as number; }
  get N_(): number { return (this as any).N as number; }
  get periodic_(): boolean { return (this as any).periodic as boolean; }

  init_(): void { (this as any).init(); }
  clear_(): void { this.clear(); }
}

function normalizeCompatToU8(src: Uint8Array | Uint16Array | Int32Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] | 0;
  return out;
}

/**
 * deriveRestartSeed (H12) — duplicated here (private in model) for restart contract.
 */
function deriveRestartSeed(baseSeed: number, k: number): number {
  let z = ((baseSeed >>> 0) ^ ((k * 0x9e3779b9) >>> 0)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  z = Math.imul(z, 0x85ebca6b) >>> 0;
  z = (z ^ (z >>> 13)) >>> 0;
  z = Math.imul(z, 0xc2b2ae35) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  return z;
}

/**
 * Hybrid runner: CPU selection + GPU propagation with cascade-stop.
 */
export class GpuWfcRunner {
  private readonly exposed: Exposed;
  private readonly propagator: GpuPropagator;

  private readonly T: number;
  private readonly count: number;
  private readonly MX: number;
  private readonly MY: number;
  private readonly N: number;
  private readonly periodic: boolean;

  // CPU selection state (mirrors model for observe + bucket PQ)
  private cpuWave: Uint8Array;
  private cpuSums: Uint8Array; // T<256 => Uint8 sufficient for all our tilesets
  private readonly buckets: BucketPQ;
  private readonly weights: Float64Array;

  private random: Random | null = null;
  private observed: Int32Array;
  private readonly propagateEpoch: number;

  // stats for measurement (internal, no side effects on hot path)
  private _lastRunObserves = 0;
  private _lastRunAttempts = 0;

  constructor(device: GPUDevice, tileset: Tileset, subsetName: string | null, width: number, height: number, periodic: boolean, propagateEpoch = 8) {
    this.exposed = new Exposed({
      tileset,
      subsetName: subsetName ?? null,
      width,
      height,
      periodic,
      heuristic: Heuristic.MRV,
    });
    if (this.exposed.count_ === 0) this.exposed.init_();

    this.T = this.exposed.T_;
    this.count = this.exposed.count_;
    this.MX = this.exposed.MX_;
    this.MY = this.exposed.MY_;
    this.N = this.exposed.N_;
    this.periodic = this.exposed.periodic_;

    const gpuData: GpuPropagatorData = {
      T: this.T,
      T4: this.exposed.T4_,
      count: this.count,
      MX: this.MX,
      MY: this.MY,
      periodic: this.periodic,
      propData: this.exposed.propData_,
      propStart: this.exposed.propStart_,
      propLen: this.exposed.propLen_,
      neighbors: this.exposed.neighbors_,
    };
    this.propagator = new GpuPropagator(device, gpuData);

    this.cpuWave = new Uint8Array(this.count * this.T);
    this.cpuSums = new Uint8Array(this.count);
    this.buckets = new BucketPQ(this.count, this.T);
    this.weights = new Float64Array(this.exposed.weights_);
    this.observed = new Int32Array(this.count);
    this.propagateEpoch = Math.max(1, propagateEpoch | 0);
  }

  /** Returns last run's observe count (for diagnostics). */
  get lastRunObserves(): number { return this._lastRunObserves; }
  get lastRunAttempts(): number { return this._lastRunAttempts; }

  /**
   * Full WFC run with hybrid loop. Mirrors model.run() structure + H12 restarts.
   * Timing of the loop body (clear + observes) is what bench captures; ctor/setup excluded by caller.
   */
  async run(seed: number, limit: number, restartBudget = 100): Promise<boolean> {
    this._lastRunObserves = 0;
    this._lastRunAttempts = 0;

    for (let attempt = 0; attempt <= restartBudget; attempt++) {
      this._lastRunAttempts = attempt;
      const s = attempt === 0 ? seed : deriveRestartSeed(seed, attempt);
      this.random = mulberry32(s);
      await this.clear();

      const limitNeg = limit < 0;
      let contradicted = false;

      for (let l = 0; limitNeg || l < limit; l++) {
        const node = this.nextUnobservedNode();
        if (node >= 0) {
          const seedBans = this.observe(node);
          this._lastRunObserves++;

          const propRes = await this.propagator.propagateIncremental(seedBans, this.propagateEpoch);
          this.applyBans(propRes.newlyBanned);

          if (this.cpuSums[0] <= 0) {
            contradicted = true;
            break;
          }
        } else {
          this.buildObserved();
          return true;
        }
      }
      if (!contradicted) {
        this.buildObserved();
        return true;
      }
    }
    this.buildObserved();
    return false;
  }

  result(): Int32Array {
    return this.observed;
  }

  // --- internal: mirror clear/observe/next/apply using only CPU selection state + one GPU init ---

  private async clear(): Promise<void> {
    this.exposed.clear_();

    // snapshot post-fixpoint state (wave/compat/sums/weights already populated)
    this.cpuWave.set(this.exposed.wave_);
    const srcSums = this.exposed.sumsOfOnes_;
    // narrow copy (safe cast for T<256)
    for (let i = 0; i < this.count; i++) {
      this.cpuSums[i] = (srcSums as any)[i] | 0;
    }

    // init bucket PQ from current sums (same cells as model would)
    this.buckets.clear();
    for (let i = 0; i < this.count; i++) {
      if (!this.periodic && (i % this.MX + this.N > this.MX || ((i / this.MX) | 0) + this.N > this.MY)) continue;
      if (this.cpuSums[i] > 1) {
        this.buckets.updateCell(i, this.cpuSums[i]);
      }
    }

    // one-time full upload to GPU (thereafter incremental)
    const compatU8 = normalizeCompatToU8(this.exposed.compatible_);
    await this.propagator.initializeState(this.cpuWave, compatU8);
  }

  private nextUnobservedNode(): number {
    // MRV + bucket (no dirty batch needed: updates are applied at phase end before next select)
    if (this.buckets.isEmpty()) return -1;
    const i = this.buckets.popMin();
    if (i == null || i < 0) return -1;
    if (this.cpuSums[i] <= 1) return -1;
    return i;
  }

  /** Perform observe on node: weighted pick via PRNG, ban T-1 others on CPU mirror, return the seed list for GPU. */
  private observe(node: number): Array<[number, number]> {
    const { cpuWave, weights, T, random } = this;
    const base = node * T;
    const dist = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      dist[t] = cpuWave[base + t] ? weights[t] : 0;
    }
    const r = weightedPick(dist, random!.nextDouble());

    const bans: Array<[number, number]> = [];
    for (let t = 0; t < T; t++) {
      if (t !== r && cpuWave[base + t]) {
        cpuWave[base + t] = 0;
        this.cpuSums[node] = (this.cpuSums[node] - 1) | 0;
        bans.push([node, t]);
      }
    }
    // update bucket for this cell (final prio after its observe bans)
    this.buckets.updateCell(node, this.cpuSums[node]);
    return bans;
  }

  /** Apply derived bans returned by GPU to CPU mirror + sums + bucket (O(banned)). */
  private applyBans(bans: Array<[number, number]>): void {
    const { cpuWave, T } = this;
    for (const [i, t] of bans) {
      const base = i * T + t;
      if (cpuWave[base]) {
        cpuWave[base] = 0;
        this.cpuSums[i] = (this.cpuSums[i] - 1) | 0;
        this.buckets.updateCell(i, this.cpuSums[i]);
      }
    }
  }

  private buildObserved(): void {
    const { cpuWave, T, count, observed } = this;
    for (let i = 0; i < count; i++) {
      const base = i * T;
      observed[i] = -1;
      for (let t = 0; t < T; t++) {
        if (cpuWave[base + t]) {
          observed[i] = t;
          break;
        }
      }
    }
  }
}
