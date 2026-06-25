#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — WebGPU bulk relaxation propagation.
 *
 * Hypothesis: replace AC-4 frontier propagation with GPU-native full-grid epochs:
 * scan every live (cell,tile), recompute whether it has support in every direction
 * from the current wave, mark unsupported tiles, apply all marks, repeat to fixpoint.
 *
 * This is a script-local single-propagation backend test. It does not integrate with
 * the full solver. The bar: match CPU AC-4's final banned set and show whether this
 * coarser GPU formulation has a plausible performance profile.
 */

/// <reference types="@webgpu/types" />

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../src-optimized/index.js";
import { GpuPropagator, type GpuPropagatorData } from "../src-optimized/webgpu/propagate-gpu.js";

class Exposed extends SimpleTiledModel {
  get T_(): number { return this.T; }
  get T4_(): number { return this.T4; }
  get count_(): number { return this.count; }
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
  get stacksize_(): number { return (this as any).stacksize as number; }
  get stackI_(): Uint16Array | Int32Array { return (this as any).stackI as Uint16Array | Int32Array; }
  get stackT_(): Uint8Array | Uint16Array | Int32Array { return (this as any).stackT as Uint8Array | Uint16Array | Int32Array; }
}

const BULK_SCAN_WGSL = `
@group(0) @binding(0) var<storage, read_write> wave: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> marks: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> banCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> allowed: array<u32>;
@group(0) @binding(4) var<storage, read> neighbors: array<i32>;
@group(0) @binding(5) var<uniform> params: vec4<u32>; // [T, count, 0, 0]

fn opposite(d: u32) -> u32 {
  if (d == 0u) { return 2u; }
  if (d == 1u) { return 3u; }
  if (d == 2u) { return 0u; }
  return 1u;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx: u32 = gid.x;
  let T: u32 = params[0];
  let count: u32 = params[1];
  if (idx >= count * T) { return; }
  if (atomicLoad(&wave[idx]) == 0u) { return; }

  let cell: u32 = idx / T;
  let tile: u32 = idx - cell * T;

  for (var d: u32 = 0u; d < 4u; d = d + 1u) {
    let supportCellI: i32 = neighbors[cell * 4u + opposite(d)];
    if (supportCellI < 0) { continue; }
    let supportCell: u32 = u32(supportCellI);
    var hasSupport: bool = false;
    for (var nt: u32 = 0u; nt < T; nt = nt + 1u) {
      if (atomicLoad(&wave[supportCell * T + nt]) == 0u) { continue; }
      if (allowed[d * T * T + nt * T + tile] != 0u) {
        hasSupport = true;
        break;
      }
    }
    if (!hasSupport) {
      atomicStore(&marks[idx], 1u);
      atomicAdd(&banCount[0], 1u);
      return;
    }
  }
}
`;

const BULK_APPLY_WGSL = `
@group(0) @binding(0) var<storage, read_write> wave: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> marks: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> sums: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> params: vec4<u32>; // [T, count, 0, 0]

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx: u32 = gid.x;
  let T: u32 = params[0];
  let count: u32 = params[1];
  if (idx >= count * T) { return; }
  if (atomicLoad(&marks[idx]) == 0u) { return; }
  atomicStore(&marks[idx], 0u);
  let old = atomicCompareExchangeWeak(&wave[idx], 1u, 0u);
  if (old.old_value == 1u) {
    let cell: u32 = idx / T;
    atomicSub(&sums[cell], 1u);
  }
}
`;

function toU32(src: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] >>> 0;
  return out;
}

function normalizeCompatToU8(src: Uint8Array | Uint16Array | Int32Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] | 0;
  return out;
}

function createMappedBuffer<T extends Uint32Array | Int32Array>(device: GPUDevice, data: T, usage: GPUBufferUsageFlags): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
  if (data instanceof Int32Array) new Int32Array(buffer.getMappedRange()).set(data);
  else new Uint32Array(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

function getInitialBanned(exposed: Exposed): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < exposed.stacksize_; k++) out.push([Number(exposed.stackI_[k]), Number(exposed.stackT_[k])]);
  return out;
}

function liveCount(wave: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < wave.length; i++) n += wave[i];
  return n;
}

function applyObserveKeep(exposed: Exposed, cell: number, kept: number): void {
  const T = exposed.T_;
  for (let t = 0; t < T; t++) {
    if (t !== kept && exposed.wave_[cell * T + t] === 1) exposed.ban_(cell, t);
  }
}

function pickStrongObserveLikeTrigger(exposed: Exposed): [number, number, number] {
  const T = exposed.T_;
  const MX = (exposed as any).MX as number;
  const MY = (exposed as any).MY as number;
  const cell = Math.floor(MX / 2) + Math.floor(MY / 2) * MX;
  let bestKept = -1;
  let bestBans = -1;

  for (let kept = 0; kept < T; kept++) {
    exposed.clear_();
    if (exposed.wave_[cell * T + kept] !== 1) continue;
    const before = liveCount(exposed.wave_);
    applyObserveKeep(exposed, cell, kept);
    exposed.propagate_();
    const bans = before - liveCount(exposed.wave_);
    if (bans > bestBans) {
      bestBans = bans;
      bestKept = kept;
    }
  }

  if (bestKept < 0) throw new Error("could not pick observe-like trigger");
  exposed.clear_();
  applyObserveKeep(exposed, cell, bestKept);
  return [cell, bestKept, bestBans];
}

function makeAllowed(exposed: Exposed): Uint32Array {
  const T = exposed.T_;
  const allowed = new Uint32Array(4 * T * T);
  const data = exposed.propData_;
  const start = exposed.propStart_;
  const len = exposed.propLen_;
  for (let d = 0; d < 4; d++) {
    for (let t1 = 0; t1 < T; t1++) {
      const key = d * T + t1;
      for (let l = 0; l < len[key]; l++) {
        const t2 = data[start[key] + l];
        allowed[d * T * T + t1 * T + t2] = 1;
      }
    }
  }
  return allowed;
}

function diffWave(a: Uint8Array, b: Uint8Array): number {
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  return diffs;
}

async function runBulkRelax(device: GPUDevice, exposed: Exposed, preWave: Uint8Array, preSums: Uint32Array): Promise<{ wave: Uint8Array; ms: number; epochs: number; totalBans: number }> {
  const T = exposed.T_;
  const count = exposed.count_;
  const waveU32 = new Uint32Array(preWave.length);
  for (let i = 0; i < preWave.length; i++) waveU32[i] = preWave[i] ? 1 : 0;
  const marks = new Uint32Array(preWave.length);
  const allowed = makeAllowed(exposed);
  const params = new Uint32Array([T >>> 0, count >>> 0, 0, 0]);
  const zero = new Uint32Array([0]);

  const waveBuf = createMappedBuffer(device, waveU32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const sumsBuf = createMappedBuffer(device, preSums, GPUBufferUsage.STORAGE);
  const marksBuf = createMappedBuffer(device, marks, GPUBufferUsage.STORAGE);
  const countBuf = createMappedBuffer(device, zero, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const allowedBuf = createMappedBuffer(device, allowed, GPUBufferUsage.STORAGE);
  const neighborsBuf = createMappedBuffer(device, new Int32Array(exposed.neighbors_), GPUBufferUsage.STORAGE);
  const paramsBuf = createMappedBuffer(device, params, GPUBufferUsage.UNIFORM);
  const zeroBuf = createMappedBuffer(device, zero, GPUBufferUsage.COPY_SRC);
  const waveRead = device.createBuffer({ size: waveU32.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const countRead = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const scanPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: BULK_SCAN_WGSL }), entryPoint: "main" } });
  const applyPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: BULK_APPLY_WGSL }), entryPoint: "main" } });
  const scanBind = device.createBindGroup({
    layout: scanPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: waveBuf } },
      { binding: 1, resource: { buffer: marksBuf } },
      { binding: 2, resource: { buffer: countBuf } },
      { binding: 3, resource: { buffer: allowedBuf } },
      { binding: 4, resource: { buffer: neighborsBuf } },
      { binding: 5, resource: { buffer: paramsBuf } },
    ],
  });
  const applyBind = device.createBindGroup({
    layout: applyPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: waveBuf } },
      { binding: 1, resource: { buffer: marksBuf } },
      { binding: 2, resource: { buffer: sumsBuf } },
      { binding: 3, resource: { buffer: paramsBuf } },
    ],
  });

  const maxEpochs = count * T;
  const workgroups = Math.ceil((count * T) / 64);
  let epochs = 0;
  let totalBans = 0;
  const t0 = performance.now();

  for (; epochs < maxEpochs; epochs++) {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(zeroBuf, 0, countBuf, 0, 4);
    let pass = enc.beginComputePass();
    pass.setPipeline(scanPipeline);
    pass.setBindGroup(0, scanBind);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    pass = enc.beginComputePass();
    pass.setPipeline(applyPipeline);
    pass.setBindGroup(0, applyBind);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    enc.copyBufferToBuffer(countBuf, 0, countRead, 0, 4);
    device.queue.submit([enc.finish()]);
    await countRead.mapAsync(GPUMapMode.READ);
    const bans = new Uint32Array(countRead.getMappedRange())[0] >>> 0;
    countRead.unmap();
    totalBans += bans;
    if (bans === 0) break;
  }

  const encFinal = device.createCommandEncoder();
  encFinal.copyBufferToBuffer(waveBuf, 0, waveRead, 0, waveU32.byteLength);
  device.queue.submit([encFinal.finish()]);
  await waveRead.mapAsync(GPUMapMode.READ);
  const got = new Uint32Array(waveRead.getMappedRange()).slice(0);
  waveRead.unmap();
  const ms = performance.now() - t0;

  const wave = new Uint8Array(got.length);
  for (let i = 0; i < got.length; i++) wave[i] = got[i] ? 1 : 0;
  return { wave, ms, epochs: epochs + 1, totalBans };
}

async function runWorklistGpu(device: GPUDevice, exposed: Exposed, preWave: Uint8Array, preCompat: Uint8Array, initBanned: Array<[number, number]>): Promise<{ wave: Uint8Array; ms: number }> {
  const data: GpuPropagatorData = {
    T: exposed.T_,
    T4: exposed.T4_,
    count: exposed.count_,
    MX: (exposed as any).MX as number,
    MY: (exposed as any).MY as number,
    periodic: true,
    propData: exposed.propData_,
    propStart: exposed.propStart_,
    propLen: exposed.propLen_,
    neighbors: exposed.neighbors_,
  };
  const propagator = new GpuPropagator(device, data);
  const t0 = performance.now();
  const res = await propagator.propagate(preWave, preCompat, initBanned);
  return { wave: res.wave, ms: performance.now() - t0 };
}

async function runCase(device: GPUDevice, tileset: Tileset, subsetName: string, size: number, label: string): Promise<void> {
  const model = new Exposed({ tileset, subsetName, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (model.count_ === 0) model.init_();
  model.clear_();
  const [cell, kept, expectedBans] = pickStrongObserveLikeTrigger(model);
  const initBanned = getInitialBanned(model);
  const preWave = new Uint8Array(model.wave_);
  const preCompat = normalizeCompatToU8(model.compatible_);
  const preSums = toU32(model.sumsOfOnes_);

  const tCpu0 = performance.now();
  const cpuOk = model.propagate_();
  const cpuMs = performance.now() - tCpu0;
  const cpuWave = new Uint8Array(model.wave_);

  const bulk = await runBulkRelax(device, model, preWave, preSums);
  const worklist = await runWorklistGpu(device, model, preWave, preCompat, initBanned);
  const bulkDiffs = diffWave(cpuWave, bulk.wave);
  const worklistDiffs = diffWave(cpuWave, worklist.wave);

  console.log(`${label.padEnd(20)} | ${String(size).padStart(4)} | ${String(cell).padStart(5)} | ${String(kept).padStart(4)} | ${String(initBanned.length).padStart(4)} | ${String(expectedBans).padStart(8)} | ${cpuMs.toFixed(3).padStart(7)} | ${worklist.ms.toFixed(3).padStart(9)} | ${bulk.ms.toFixed(3).padStart(8)} | ${String(bulk.epochs).padStart(6)} | ${String(bulk.totalBans).padStart(8)} | ${String(worklistDiffs).padStart(8)} | ${String(bulkDiffs).padStart(8)} | ${cpuOk ? "ok" : "bad"}`);
}

async function main(): Promise<void> {
  await setupGlobals();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const knotsXml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const knots = parseTileset(knotsXml, "Knots");

  console.log("=== WEBGPU BULK RELAXATION PROPAGATION PROTOTYPE ===");
  console.log("case                 | size |  cell | keep | seed | bestBan | CPU ms  | work GPU | bulk ms  | epochs | bulkBan | workDiff | bulkDiff | cpu");
  console.log("---------------------|------|-------|------|------|---------|---------|----------|----------|--------|---------|----------|----------|----");
  await runCase(device, circuit, "Turnless", 34, "circuit-turnless");
  await runCase(device, circuit, "Turnless", 64, "circuit-turnless");
  await runCase(device, circuit, "Turnless", 128, "circuit-turnless");
  await runCase(device, circuit, "Turnless", 256, "circuit-turnless");
  await runCase(device, knots, "Standard", 48, "knots-standard");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
