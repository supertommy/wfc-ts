#!/usr/bin/env bun
/**
 * DEBUG PROTOTYPE — CPU/GPU lockstep for full-GPU WFC state.
 *
 * Purpose: find the first chained observe→propagate divergence after the Stage 3
 * full-GPU prototype proved single-observe propagation correct but multi-observe
 * solves invalid. This is a script-local probe, not a shipped API.
 *
 * Determinism simplification:
 * - selection: MRV by lowest sumsOfOnes, tie lowest cell index
 * - observe: keep lowest live tile; ban every other live tile in that cell
 *
 * After every observe+propagate step, compare:
 * - selected cell + kept tile
 * - wave (all cells/tiles)
 * - sumsOfOnes (GPU-owned selection state)
 * - compatible only for live tile slots (dead slots may differ legitimately)
 * - final frontier count after propagation drain
 *
 * Run: bun run scripts/debug-gpu-lockstep.ts
 */

/// <reference types="@webgpu/types" />

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import { Heuristic, mulberry32, parseTileset, SimpleTiledModel, weightedPick, type Random, type Tileset } from "../src-optimized/index.js";

class Exposed extends SimpleTiledModel {
  get T_(): number { return this.T; }
  get T4_(): number { return this.T4; }
  get count_(): number { return this.count; }
  get MX_(): number { return (this as any).MX as number; }
  get MY_(): number { return (this as any).MY as number; }
  get N_(): number { return (this as any).N as number; }
  get periodic_(): boolean { return (this as any).periodic as boolean; }
  get wave_(): Uint8Array { return this.wave; }
  get compatible_(): Uint8Array | Uint16Array | Int32Array { return this.compatible; }
  get sumsOfOnes_(): Uint8Array | Uint16Array | Int32Array { return this.sumsOfOnes; }
  get propData_(): Uint8Array | Uint16Array | Int32Array { return this.propData; }
  get propStart_(): Uint16Array | Int32Array { return this.propStart; }
  get propLen_(): Uint8Array | Uint16Array | Int32Array { return this.propLen; }
  get neighbors_(): Int32Array { return this.neighbors; }

  init_(): void { (this as any).init(); }
  clear_(): void { this.clear(); }
  ban_(i: number, t: number): void { this.ban(i, t); }
  propagate_(): boolean { return (this as any).propagate() as boolean; }
}

interface CpuStep {
  status: "observe" | "complete" | "contradiction";
  cell: number;
  kept: number;
  seedBans: number;
  ok: boolean;
}

interface GpuStep {
  status: "observe" | "complete";
  cell: number;
  kept: number;
  seedBans: number;
  finalFrontierCount: number;
  frontierCounts: number[];
}

interface GpuSnapshot {
  wave: Uint8Array;
  compatible: Int32Array;
  sums: Uint32Array;
  workA: number;
  workB: number;
}

interface DiffSummary {
  waveDiffs: number;
  firstWaveDiff: number;
  sumsDiffs: number;
  firstSumsDiff: number;
  liveCompatDiffs: number;
  firstLiveCompatDiff: number;
}

const SELECT_OBSERVE_WGSL = `
@group(0) @binding(0) var<storage, read_write> wave: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> compatible: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> sums: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> work: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> debug: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> params: vec4<u32>; // [T, T4, count, 0]

@compute @workgroup_size(1)
fn main() {
  let T: u32 = params[0];
  let T4: u32 = params[1];
  let count: u32 = params[2];

  atomicStore(&work[0], 0u);
  atomicStore(&debug[0], 0u); // status: 0 complete, 1 observed
  atomicStore(&debug[1], 0xffffffffu);
  atomicStore(&debug[2], 0xffffffffu);
  atomicStore(&debug[3], 0u);

  var bestCell: u32 = 0xffffffffu;
  var bestSum: u32 = 0xffffffffu;
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let s: u32 = atomicLoad(&sums[i]);
    if (s > 1u && s < bestSum) {
      bestSum = s;
      bestCell = i;
    }
  }

  if (bestCell == 0xffffffffu) {
    return;
  }

  let base: u32 = bestCell * T;
  var kept: u32 = 0xffffffffu;
  for (var t: u32 = 0u; t < T; t = t + 1u) {
    if (atomicLoad(&wave[base + t]) == 1u) {
      kept = t;
      break;
    }
  }
  if (kept == 0xffffffffu) {
    return;
  }

  var seedBans: u32 = 0u;
  for (var t: u32 = 0u; t < T; t = t + 1u) {
    if (t == kept) { continue; }
    let waddr: u32 = base + t;
    if (atomicLoad(&wave[waddr]) == 1u) {
      atomicStore(&wave[waddr], 0u);
      let cbase: u32 = bestCell * T4 + t * 4u;
      atomicStore(&compatible[cbase + 0u], 0i);
      atomicStore(&compatible[cbase + 1u], 0i);
      atomicStore(&compatible[cbase + 2u], 0i);
      atomicStore(&compatible[cbase + 3u], 0i);
      atomicSub(&sums[bestCell], 1u);
      let pos: u32 = atomicAdd(&work[0], 1u);
      atomicStore(&work[1u + pos * 2u], bestCell);
      atomicStore(&work[1u + pos * 2u + 1u], t);
      seedBans = seedBans + 1u;
    }
  }

  atomicStore(&debug[0], 1u);
  atomicStore(&debug[1], bestCell);
  atomicStore(&debug[2], kept);
  atomicStore(&debug[3], seedBans);
}
`;

const FORCED_OBSERVE_WGSL = `
@group(0) @binding(0) var<storage, read_write> wave: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> compatible: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> sums: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> work: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> debug: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> params: vec4<u32>; // [T, T4, count, 0]
@group(0) @binding(6) var<uniform> observe: vec4<u32>; // [cell, keep, 0, 0]

@compute @workgroup_size(1)
fn main() {
  let T: u32 = params[0];
  let T4: u32 = params[1];
  let count: u32 = params[2];
  let cell: u32 = observe[0];
  let kept: u32 = observe[1];

  atomicStore(&work[0], 0u);
  atomicStore(&debug[0], 0u);
  atomicStore(&debug[1], cell);
  atomicStore(&debug[2], kept);
  atomicStore(&debug[3], 0u);

  if (cell >= count || kept >= T) {
    return;
  }

  let base: u32 = cell * T;
  if (atomicLoad(&wave[base + kept]) != 1u) {
    return;
  }

  var seedBans: u32 = 0u;
  for (var t: u32 = 0u; t < T; t = t + 1u) {
    if (t == kept) { continue; }
    let waddr: u32 = base + t;
    if (atomicLoad(&wave[waddr]) == 1u) {
      atomicStore(&wave[waddr], 0u);
      let cbase: u32 = cell * T4 + t * 4u;
      atomicStore(&compatible[cbase + 0u], 0i);
      atomicStore(&compatible[cbase + 1u], 0i);
      atomicStore(&compatible[cbase + 2u], 0i);
      atomicStore(&compatible[cbase + 3u], 0i);
      atomicSub(&sums[cell], 1u);
      let pos: u32 = atomicAdd(&work[0], 1u);
      atomicStore(&work[1u + pos * 2u], cell);
      atomicStore(&work[1u + pos * 2u + 1u], t);
      seedBans = seedBans + 1u;
    }
  }

  atomicStore(&debug[0], 1u);
  atomicStore(&debug[3], seedBans);
}
`;

const PROPAGATE_WGSL = `
@group(0) @binding(0) var<storage, read_write> wave: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> compatible: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> sums: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> curBanned: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> nextBanned: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> propData: array<u32>;
@group(0) @binding(6) var<storage, read> propMeta: array<u32>; // [start, len] pairs for each key
@group(0) @binding(7) var<storage, read> neighbors: array<i32>;
@group(0) @binding(8) var<uniform> params: vec4<u32>; // [T, T4, count, 0]

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx: u32 = gid.x;
  let num: u32 = atomicLoad(&curBanned[0]);
  if (idx >= num) { return; }

  let i1: u32 = atomicLoad(&curBanned[1u + idx * 2u]);
  let t1: u32 = atomicLoad(&curBanned[1u + idx * 2u + 1u]);
  let T: u32 = params[0];
  let T4: u32 = params[1];

  for (var d: u32 = 0u; d < 4u; d = d + 1u) {
    let i2i: i32 = neighbors[i1 * 4u + d];
    if (i2i < 0) { continue; }
    let i2: u32 = u32(i2i);
    let key: u32 = d * T + t1;
    let start: u32 = propMeta[key * 2u];
    let len: u32 = propMeta[key * 2u + 1u];
    let base2: u32 = i2 * T4;

    for (var l: u32 = 0u; l < len; l = l + 1u) {
      let t2: u32 = propData[start + l];
      let cidx: u32 = base2 + t2 * 4u + d;
      let prev: i32 = atomicSub(&compatible[cidx], 1i);
      if (prev == 1i) {
        let waddr: u32 = i2 * T + t2;
        let res = atomicCompareExchangeWeak(&wave[waddr], 1u, 0u);
        if (res.old_value == 1u) {
          let cbase: u32 = i2 * T4 + t2 * 4u;
          atomicStore(&compatible[cbase + 0u], 0i);
          atomicStore(&compatible[cbase + 1u], 0i);
          atomicStore(&compatible[cbase + 2u], 0i);
          atomicStore(&compatible[cbase + 3u], 0i);
          atomicSub(&sums[i2], 1u);
          let pos: u32 = atomicAdd(&nextBanned[0], 1u);
          atomicStore(&nextBanned[1u + pos * 2u], i2);
          atomicStore(&nextBanned[1u + pos * 2u + 1u], t2);
        }
      }
    }
  }
}
`;

function toU32(src: Uint8Array | Uint16Array | Int32Array): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] >>> 0;
  return out;
}

function toI32(src: Uint8Array | Uint16Array | Int32Array): Int32Array {
  const out = new Int32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] | 0;
  return out;
}

function selectLowestMrv(cpu: Exposed): { cell: number; kept: number } | null {
  let bestCell = -1;
  let bestSum = Number.POSITIVE_INFINITY;
  const sums = cpu.sumsOfOnes_;
  for (let i = 0; i < cpu.count_; i++) {
    if (!cpu.periodic_ && (i % cpu.MX_ + cpu.N_ > cpu.MX_ || ((i / cpu.MX_) | 0) + cpu.N_ > cpu.MY_)) continue;
    const s = sums[i];
    if (s > 1 && s < bestSum) {
      bestSum = s;
      bestCell = i;
    }
  }
  if (bestCell < 0) return null;

  const base = bestCell * cpu.T_;
  for (let t = 0; t < cpu.T_; t++) {
    if (cpu.wave_[base + t]) return { cell: bestCell, kept: t };
  }
  throw new Error(`cell ${bestCell} has sums>1 but no live tile`);
}

function applyCpuObserveAndPropagate(cpu: Exposed, cell: number, kept: number): CpuStep {
  let seedBans = 0;
  const base = cell * cpu.T_;
  for (let t = 0; t < cpu.T_; t++) {
    if (t !== kept && cpu.wave_[base + t]) {
      cpu.ban_(cell, t);
      seedBans++;
    }
  }
  const ok = cpu.propagate_();
  return { status: ok ? "observe" : "contradiction", cell, kept, seedBans, ok };
}

function runCpuStep(cpu: Exposed): CpuStep {
  const selected = selectLowestMrv(cpu);
  if (!selected) return { status: "complete", cell: -1, kept: -1, seedBans: 0, ok: true };
  return applyCpuObserveAndPropagate(cpu, selected.cell, selected.kept);
}

function runCpuRandomForcedStep(cpu: Exposed, random: Random): CpuStep {
  const selected = selectLowestMrv(cpu);
  if (!selected) return { status: "complete", cell: -1, kept: -1, seedBans: 0, ok: true };

  const dist = new Float64Array(cpu.T_);
  const base = selected.cell * cpu.T_;
  for (let t = 0; t < cpu.T_; t++) {
    // Unit weights are sufficient here: the goal is to exercise non-lowest live
    // choices, not to validate weighted distribution math.
    dist[t] = cpu.wave_[base + t] ? 1 : 0;
  }
  const kept = weightedPick(dist, random.nextDouble());
  return applyCpuObserveAndPropagate(cpu, selected.cell, kept);
}

class DebugGpuState {
  private readonly device: GPUDevice;
  private readonly T: number;
  private readonly T4: number;
  private readonly count: number;
  private readonly maxWorkgroups: number;
  private readonly diameter: number;
  private readonly workBufSize: number;

  private readonly selectPipeline: GPUComputePipeline;
  private readonly forcedPipeline: GPUComputePipeline;
  private readonly propPipeline: GPUComputePipeline;
  private readonly waveBuf: GPUBuffer;
  private readonly compatBuf: GPUBuffer;
  private readonly sumsBuf: GPUBuffer;
  private readonly workA: GPUBuffer;
  private readonly workB: GPUBuffer;
  private readonly propDataBuf: GPUBuffer;
  private readonly propMetaBuf: GPUBuffer;
  private readonly neighborsBuf: GPUBuffer;
  private readonly paramsBuf: GPUBuffer;
  private readonly observeParamsBuf: GPUBuffer;
  private readonly debugBuf: GPUBuffer;

  private readonly waveRead: GPUBuffer;
  private readonly compatRead: GPUBuffer;
  private readonly sumsRead: GPUBuffer;
  private readonly countRead: GPUBuffer;
  private readonly debugRead: GPUBuffer;

  constructor(device: GPUDevice, cpu: Exposed) {
    this.device = device;
    this.T = cpu.T_;
    this.T4 = cpu.T4_;
    this.count = cpu.count_;
    this.maxWorkgroups = Math.ceil((this.count * this.T) / 64);
    this.diameter = cpu.periodic_ ? Math.max(cpu.MX_, cpu.MY_) : (cpu.MX_ + cpu.MY_);

    const maxBans = this.count * this.T;
    this.workBufSize = (1 + 2 * maxBans) * 4;

    const waveU32 = new Uint32Array(cpu.wave_.length);
    for (let i = 0; i < cpu.wave_.length; i++) waveU32[i] = cpu.wave_[i] ? 1 : 0;
    const compatI32 = toI32(cpu.compatible_);
    const sumsU32 = toU32(cpu.sumsOfOnes_);
    const propDataU32 = toU32(cpu.propData_);
    const propMetaU32 = new Uint32Array(cpu.propStart_.length * 2);
    for (let i = 0; i < cpu.propStart_.length; i++) {
      propMetaU32[i * 2] = cpu.propStart_[i] >>> 0;
      propMetaU32[i * 2 + 1] = cpu.propLen_[i] >>> 0;
    }

    this.waveBuf = this.createMappedBuffer(waveU32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.compatBuf = this.createMappedBuffer(compatI32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.sumsBuf = this.createMappedBuffer(sumsU32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.propDataBuf = this.createMappedBuffer(propDataU32, GPUBufferUsage.STORAGE);
    this.propMetaBuf = this.createMappedBuffer(propMetaU32, GPUBufferUsage.STORAGE);
    this.neighborsBuf = this.createMappedBuffer(new Int32Array(cpu.neighbors_), GPUBufferUsage.STORAGE);

    const params = new Uint32Array([this.T >>> 0, this.T4 >>> 0, this.count >>> 0, 0]);
    this.paramsBuf = this.createMappedBuffer(params, GPUBufferUsage.UNIFORM);
    this.observeParamsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.workA = device.createBuffer({ size: this.workBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.workB = device.createBuffer({ size: this.workBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.debugBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.workA, 0, new Uint32Array([0]));
    device.queue.writeBuffer(this.workB, 0, new Uint32Array([0]));
    device.queue.writeBuffer(this.debugBuf, 0, new Uint32Array(4));

    this.waveRead = device.createBuffer({ size: waveU32.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.compatRead = device.createBuffer({ size: compatI32.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.sumsRead = device.createBuffer({ size: sumsU32.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.countRead = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.debugRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    this.selectPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: SELECT_OBSERVE_WGSL }), entryPoint: "main" },
    });
    this.forcedPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: FORCED_OBSERVE_WGSL }), entryPoint: "main" },
    });
    this.propPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: PROPAGATE_WGSL }), entryPoint: "main" },
    });
  }

  async step(): Promise<GpuStep> {
    this.device.queue.writeBuffer(this.workA, 0, new Uint32Array([0]));
    this.device.queue.writeBuffer(this.workB, 0, new Uint32Array([0]));
    this.device.queue.writeBuffer(this.debugBuf, 0, new Uint32Array(4));

    const encObserve = this.device.createCommandEncoder();
    const observeBind = this.device.createBindGroup({
      layout: this.selectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.waveBuf } },
        { binding: 1, resource: { buffer: this.compatBuf } },
        { binding: 2, resource: { buffer: this.sumsBuf } },
        { binding: 3, resource: { buffer: this.workA } },
        { binding: 4, resource: { buffer: this.debugBuf } },
        { binding: 5, resource: { buffer: this.paramsBuf } },
      ],
    });
    const passObserve = encObserve.beginComputePass();
    passObserve.setPipeline(this.selectPipeline);
    passObserve.setBindGroup(0, observeBind);
    passObserve.dispatchWorkgroups(1);
    passObserve.end();
    this.device.queue.submit([encObserve.finish()]);

    const debug = await this.readDebug();
    if (debug[0] === 0) {
      return { status: "complete", cell: -1, kept: -1, seedBans: 0, finalFrontierCount: 0, frontierCounts: [] };
    }

    const drained = await this.drainFrontier();
    return {
      status: "observe",
      cell: debug[1] | 0,
      kept: debug[2] | 0,
      seedBans: debug[3] | 0,
      finalFrontierCount: drained.finalFrontierCount,
      frontierCounts: drained.frontierCounts,
    };
  }

  async stepForced(cell: number, kept: number): Promise<GpuStep> {
    this.device.queue.writeBuffer(this.workA, 0, new Uint32Array([0]));
    this.device.queue.writeBuffer(this.workB, 0, new Uint32Array([0]));
    this.device.queue.writeBuffer(this.debugBuf, 0, new Uint32Array(4));
    this.device.queue.writeBuffer(this.observeParamsBuf, 0, new Uint32Array([cell >>> 0, kept >>> 0, 0, 0]));

    const encObserve = this.device.createCommandEncoder();
    const observeBind = this.device.createBindGroup({
      layout: this.forcedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.waveBuf } },
        { binding: 1, resource: { buffer: this.compatBuf } },
        { binding: 2, resource: { buffer: this.sumsBuf } },
        { binding: 3, resource: { buffer: this.workA } },
        { binding: 4, resource: { buffer: this.debugBuf } },
        { binding: 5, resource: { buffer: this.paramsBuf } },
        { binding: 6, resource: { buffer: this.observeParamsBuf } },
      ],
    });
    const passObserve = encObserve.beginComputePass();
    passObserve.setPipeline(this.forcedPipeline);
    passObserve.setBindGroup(0, observeBind);
    passObserve.dispatchWorkgroups(1);
    passObserve.end();
    this.device.queue.submit([encObserve.finish()]);

    const debug = await this.readDebug();
    if (debug[0] === 0) {
      return { status: "complete", cell, kept, seedBans: 0, finalFrontierCount: 0, frontierCounts: [] };
    }

    const drained = await this.drainFrontier();
    return {
      status: "observe",
      cell: debug[1] | 0,
      kept: debug[2] | 0,
      seedBans: debug[3] | 0,
      finalFrontierCount: drained.finalFrontierCount,
      frontierCounts: drained.frontierCounts,
    };
  }

  private async drainFrontier(): Promise<{ finalFrontierCount: number; frontierCounts: number[] }> {
    let curBuf = this.workA;
    let nxtBuf = this.workB;
    let curCount = await this.readWorkCount(curBuf);
    const frontierCounts: number[] = [curCount];

    for (let it = 0; it < this.diameter; it++) {
      if (curCount === 0) break;
      this.device.queue.writeBuffer(nxtBuf, 0, new Uint32Array([0]));

      const encProp = this.device.createCommandEncoder();
      const propBind = this.device.createBindGroup({
        layout: this.propPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.waveBuf } },
          { binding: 1, resource: { buffer: this.compatBuf } },
          { binding: 2, resource: { buffer: this.sumsBuf } },
          { binding: 3, resource: { buffer: curBuf } },
          { binding: 4, resource: { buffer: nxtBuf } },
          { binding: 5, resource: { buffer: this.propDataBuf } },
          { binding: 6, resource: { buffer: this.propMetaBuf } },
          { binding: 7, resource: { buffer: this.neighborsBuf } },
          { binding: 8, resource: { buffer: this.paramsBuf } },
        ],
      });
      const passProp = encProp.beginComputePass();
      passProp.setPipeline(this.propPipeline);
      passProp.setBindGroup(0, propBind);
      passProp.dispatchWorkgroups(this.maxWorkgroups);
      passProp.end();
      this.device.queue.submit([encProp.finish()]);

      const tmp = curBuf;
      curBuf = nxtBuf;
      nxtBuf = tmp;
      curCount = await this.readWorkCount(curBuf);
      frontierCounts.push(curCount);
    }

    return { finalFrontierCount: curCount, frontierCounts };
  }

  async snapshot(): Promise<GpuSnapshot> {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.waveBuf, 0, this.waveRead, 0, this.waveRead.size);
    enc.copyBufferToBuffer(this.compatBuf, 0, this.compatRead, 0, this.compatRead.size);
    enc.copyBufferToBuffer(this.sumsBuf, 0, this.sumsRead, 0, this.sumsRead.size);
    enc.copyBufferToBuffer(this.workA, 0, this.countRead, 0, 4);
    enc.copyBufferToBuffer(this.workB, 0, this.countRead, 4, 4);
    this.device.queue.submit([enc.finish()]);

    await this.waveRead.mapAsync(GPUMapMode.READ);
    const waveU32 = new Uint32Array(this.waveRead.getMappedRange()).slice(0);
    this.waveRead.unmap();

    await this.compatRead.mapAsync(GPUMapMode.READ);
    const compatible = new Int32Array(this.compatRead.getMappedRange()).slice(0);
    this.compatRead.unmap();

    await this.sumsRead.mapAsync(GPUMapMode.READ);
    const sums = new Uint32Array(this.sumsRead.getMappedRange()).slice(0);
    this.sumsRead.unmap();

    await this.countRead.mapAsync(GPUMapMode.READ);
    const counts = new Uint32Array(this.countRead.getMappedRange()).slice(0, 2);
    this.countRead.unmap();

    const wave = new Uint8Array(waveU32.length);
    for (let i = 0; i < wave.length; i++) wave[i] = waveU32[i] ? 1 : 0;

    return { wave, compatible, sums, workA: counts[0] >>> 0, workB: counts[1] >>> 0 };
  }

  private createMappedBuffer<T extends Uint32Array | Int32Array>(data: T, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
    if (data instanceof Int32Array) new Int32Array(buffer.getMappedRange()).set(data);
    else new Uint32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }

  private async readWorkCount(buffer: GPUBuffer): Promise<number> {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(buffer, 0, this.countRead, 0, 4);
    this.device.queue.submit([enc.finish()]);
    await this.countRead.mapAsync(GPUMapMode.READ);
    const value = new Uint32Array(this.countRead.getMappedRange())[0] >>> 0;
    this.countRead.unmap();
    return value;
  }

  private async readDebug(): Promise<Uint32Array> {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.debugBuf, 0, this.debugRead, 0, 16);
    this.device.queue.submit([enc.finish()]);
    await this.debugRead.mapAsync(GPUMapMode.READ);
    const debug = new Uint32Array(this.debugRead.getMappedRange()).slice(0, 4);
    this.debugRead.unmap();
    return debug;
  }
}

function compare(cpu: Exposed, gpu: GpuSnapshot): DiffSummary {
  let waveDiffs = 0;
  let firstWaveDiff = -1;
  for (let k = 0; k < cpu.wave_.length; k++) {
    if (cpu.wave_[k] !== gpu.wave[k]) {
      if (firstWaveDiff < 0) firstWaveDiff = k;
      waveDiffs++;
    }
  }

  let sumsDiffs = 0;
  let firstSumsDiff = -1;
  for (let i = 0; i < cpu.count_; i++) {
    if ((cpu.sumsOfOnes_[i] >>> 0) !== (gpu.sums[i] >>> 0)) {
      if (firstSumsDiff < 0) firstSumsDiff = i;
      sumsDiffs++;
    }
  }

  let liveCompatDiffs = 0;
  let firstLiveCompatDiff = -1;
  for (let i = 0; i < cpu.count_; i++) {
    for (let t = 0; t < cpu.T_; t++) {
      const widx = i * cpu.T_ + t;
      if (cpu.wave_[widx] !== 1 || gpu.wave[widx] !== 1) continue;
      const cbase = i * cpu.T4_ + t * 4;
      for (let d = 0; d < 4; d++) {
        const cidx = cbase + d;
        if ((cpu.compatible_[cidx] | 0) !== (gpu.compatible[cidx] | 0)) {
          if (firstLiveCompatDiff < 0) firstLiveCompatDiff = cidx;
          liveCompatDiffs++;
        }
      }
    }
  }

  return { waveDiffs, firstWaveDiff, sumsDiffs, firstSumsDiff, liveCompatDiffs, firstLiveCompatDiff };
}

function describeWaveIndex(cpu: Exposed, widx: number): string {
  if (widx < 0) return "n/a";
  const cell = Math.floor(widx / cpu.T_);
  const tile = widx % cpu.T_;
  const x = cell % cpu.MX_;
  const y = (cell / cpu.MX_) | 0;
  return `idx=${widx} cell=${cell} (${x},${y}) tile=${tile} cpu=${cpu.wave_[widx]}`;
}

function describeSumsIndex(cpu: Exposed, gpu: GpuSnapshot, i: number): string {
  if (i < 0) return "n/a";
  const x = i % cpu.MX_;
  const y = (i / cpu.MX_) | 0;
  return `cell=${i} (${x},${y}) cpu=${cpu.sumsOfOnes_[i]} gpu=${gpu.sums[i]}`;
}

function describeCompatIndex(cpu: Exposed, gpu: GpuSnapshot, cidx: number): string {
  if (cidx < 0) return "n/a";
  const cell = Math.floor(cidx / cpu.T4_);
  const rem = cidx - cell * cpu.T4_;
  const tile = Math.floor(rem / 4);
  const d = rem % 4;
  const x = cell % cpu.MX_;
  const y = (cell / cpu.MX_) | 0;
  return `idx=${cidx} cell=${cell} (${x},${y}) tile=${tile} dir=${d} cpu=${cpu.compatible_[cidx]} gpu=${gpu.compatible[cidx]}`;
}

async function runCase(device: GPUDevice, tileset: Tileset, subsetName: string, size: number, maxSteps: number): Promise<boolean> {
  const label = `${tileset.name}-${subsetName}-${size}`;
  console.log(`\n=== LOCKSTEP ${label} ===`);
  const cpu = new Exposed({ tileset, subsetName, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (cpu.count_ === 0) cpu.init_();
  cpu.clear_();
  const gpu = new DebugGpuState(device, cpu);

  for (let step = 1; step <= maxSteps; step++) {
    const cpuStep = runCpuStep(cpu);
    const gpuStep = await gpu.step();
    const snap = await gpu.snapshot();
    const diff = compare(cpu, snap);

    const selectionMismatch = cpuStep.status !== gpuStep.status || cpuStep.cell !== gpuStep.cell || cpuStep.kept !== gpuStep.kept || cpuStep.seedBans !== gpuStep.seedBans;
    const stateMismatch = diff.waveDiffs > 0 || diff.sumsDiffs > 0 || diff.liveCompatDiffs > 0;
    const notDrained = gpuStep.finalFrontierCount !== 0;

    if (step <= 5 || selectionMismatch || stateMismatch || notDrained || cpuStep.status !== "observe") {
      console.log(
        `step=${step} cpu=${cpuStep.status}(${cpuStep.cell}, keep=${cpuStep.kept}, bans=${cpuStep.seedBans}) ` +
        `gpu=${gpuStep.status}(${gpuStep.cell}, keep=${gpuStep.kept}, bans=${gpuStep.seedBans}) ` +
        `frontier=${gpuStep.frontierCounts.join("->") || "-"} ` +
        `diffs wave=${diff.waveDiffs} sums=${diff.sumsDiffs} liveCompat=${diff.liveCompatDiffs} ` +
        `workA=${snap.workA} workB=${snap.workB}`
      );
    }

    if (selectionMismatch || stateMismatch || notDrained) {
      console.error(`\nDIVERGENCE in ${label} at step ${step}`);
      if (selectionMismatch) {
        console.error(`selection mismatch: CPU ${JSON.stringify(cpuStep)} GPU ${JSON.stringify(gpuStep)}`);
      }
      if (diff.waveDiffs > 0) console.error(`first wave diff: ${describeWaveIndex(cpu, diff.firstWaveDiff)} gpu=${snap.wave[diff.firstWaveDiff]}`);
      if (diff.sumsDiffs > 0) console.error(`first sums diff: ${describeSumsIndex(cpu, snap, diff.firstSumsDiff)}`);
      if (diff.liveCompatDiffs > 0) console.error(`first live compatible diff: ${describeCompatIndex(cpu, snap, diff.firstLiveCompatDiff)}`);
      if (notDrained) console.error(`propagation did not drain within diameter; final frontier=${gpuStep.finalFrontierCount}`);
      return false;
    }

    if (cpuStep.status === "complete") {
      console.log(`PASS ${label}: completed in ${step - 1} observes with no divergence.`);
      return true;
    }
    if (cpuStep.status === "contradiction") {
      console.log(`PASS ${label}: CPU contradiction matched state through step ${step}; stopping debug case.`);
      return true;
    }
  }

  console.log(`PASS ${label}: no divergence through ${maxSteps} observes (case still incomplete).`);
  return true;
}

async function runCaseForcedRandom(
  device: GPUDevice,
  tileset: Tileset,
  subsetName: string,
  size: number,
  seed: number,
  maxSteps: number
): Promise<boolean> {
  const label = `${tileset.name}-${subsetName}-${size}-forced-random-seed${seed}`;
  console.log(`\n=== LOCKSTEP ${label} ===`);
  const cpu = new Exposed({ tileset, subsetName, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (cpu.count_ === 0) cpu.init_();
  cpu.clear_();
  const gpu = new DebugGpuState(device, cpu);
  const random = mulberry32(seed);

  for (let step = 1; step <= maxSteps; step++) {
    const selected = selectLowestMrv(cpu);
    if (!selected) {
      const gpuStep = await gpu.stepForced(0xffffffff, 0xffffffff);
      const snap = await gpu.snapshot();
      const diff = compare(cpu, snap);
      const ok = gpuStep.status === "complete" && diff.waveDiffs === 0 && diff.sumsDiffs === 0 && diff.liveCompatDiffs === 0;
      console.log(`step=${step} complete check gpu=${gpuStep.status} diffs wave=${diff.waveDiffs} sums=${diff.sumsDiffs} liveCompat=${diff.liveCompatDiffs}`);
      if (!ok) return false;
      console.log(`PASS ${label}: completed in ${step - 1} observes with no divergence.`);
      return true;
    }

    const cpuStep = runCpuRandomForcedStep(cpu, random);
    const gpuStep = await gpu.stepForced(cpuStep.cell, cpuStep.kept);
    const snap = await gpu.snapshot();
    const diff = compare(cpu, snap);

    const selectionMismatch = gpuStep.status !== "observe" || cpuStep.cell !== gpuStep.cell || cpuStep.kept !== gpuStep.kept || cpuStep.seedBans !== gpuStep.seedBans;
    const stateMismatch = diff.waveDiffs > 0 || diff.sumsDiffs > 0 || diff.liveCompatDiffs > 0;
    const notDrained = gpuStep.finalFrontierCount !== 0;

    if (step <= 5 || selectionMismatch || stateMismatch || notDrained || cpuStep.status !== "observe") {
      console.log(
        `step=${step} cpu=${cpuStep.status}(${cpuStep.cell}, keep=${cpuStep.kept}, bans=${cpuStep.seedBans}) ` +
        `gpu=${gpuStep.status}(${gpuStep.cell}, keep=${gpuStep.kept}, bans=${gpuStep.seedBans}) ` +
        `frontier=${gpuStep.frontierCounts.join("->") || "-"} ` +
        `diffs wave=${diff.waveDiffs} sums=${diff.sumsDiffs} liveCompat=${diff.liveCompatDiffs} ` +
        `workA=${snap.workA} workB=${snap.workB}`
      );
    }

    if (selectionMismatch || stateMismatch || notDrained) {
      console.error(`\nDIVERGENCE in ${label} at step ${step}`);
      if (selectionMismatch) console.error(`selection mismatch: CPU ${JSON.stringify(cpuStep)} GPU ${JSON.stringify(gpuStep)}`);
      if (diff.waveDiffs > 0) console.error(`first wave diff: ${describeWaveIndex(cpu, diff.firstWaveDiff)} gpu=${snap.wave[diff.firstWaveDiff]}`);
      if (diff.sumsDiffs > 0) console.error(`first sums diff: ${describeSumsIndex(cpu, snap, diff.firstSumsDiff)}`);
      if (diff.liveCompatDiffs > 0) console.error(`first live compatible diff: ${describeCompatIndex(cpu, snap, diff.firstLiveCompatDiff)}`);
      if (notDrained) console.error(`propagation did not drain within diameter; final frontier=${gpuStep.finalFrontierCount}`);
      return false;
    }

    if (cpuStep.status === "contradiction") {
      console.log(`PASS ${label}: CPU contradiction matched state through step ${step}; stopping debug case.`);
      return true;
    }
  }

  console.log(`PASS ${label}: no divergence through ${maxSteps} observes (case still incomplete).`);
  return true;
}

async function main(): Promise<void> {
  await setupGlobals();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter available");
  const device = await adapter.requestDevice();

  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const knotsXml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const knots = parseTileset(knotsXml, "Knots");

  const cases: Array<[Tileset, string, number, number]> = [
    [circuit, "Turnless", 8, 128],
    [circuit, "Turnless", 16, 512],
    [knots, "Standard", 8, 128],
    [knots, "Standard", 16, 512],
  ];

  let allPass = true;
  for (const [tileset, subset, size, maxSteps] of cases) {
    const ok = await runCase(device, tileset, subset, size, maxSteps);
    allPass = allPass && ok;
    if (!ok) break;
  }

  if (allPass) {
    const forcedCases: Array<[Tileset, string, number, number, number]> = [
      [circuit, "Turnless", 16, 0, 512],
      [knots, "Standard", 16, 0, 512],
      [knots, "Standard", 16, 12345, 512],
    ];
    for (const [tileset, subset, size, seed, maxSteps] of forcedCases) {
      const ok = await runCaseForcedRandom(device, tileset, subset, size, seed, maxSteps);
      allPass = allPass && ok;
      if (!ok) break;
    }
  }

  console.log(`\nLOCKSTEP SUMMARY: ${allPass ? "PASS" : "FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
