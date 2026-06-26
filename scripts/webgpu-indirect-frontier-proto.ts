#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — WebGPU indirect frontier dispatch.
 *
 * Hypothesis: the safe worklist GPU propagation over-dispatches every frontier
 * layer by launching ceil(count*T/64) workgroups even when the frontier is tiny.
 * Have the GPU write dispatchWorkgroupsIndirect args from curBanned[0], then
 * dispatch only ceil(frontier/64) workgroups for that layer.
 *
 * This is a script-local single-propagation backend test. It still reads the
 * frontier count each layer to prove fixpoint; the test isolates over-dispatch.
 */

/// <reference types="@webgpu/types" />

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../helpers/index.js";
import { GpuPropagator, type GpuPropagatorData } from "../src-optimized/webgpu/propagate-gpu.js";

class Exposed extends SimpleTiledModel {
  get T_(): number { return this.T; }
  get T4_(): number { return this.T4; }
  get count_(): number { return this.count; }
  get wave_(): Uint8Array { return this.wave; }
  get compatible_(): Uint8Array | Uint16Array | Int32Array { return this.compatible; }
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

const FUSED_WGSL = `
@group(0) @binding(0) var<storage, read_write> wave: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> compatible: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> curBanned: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> nextBanned: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> propData: array<u32>;
@group(0) @binding(5) var<storage, read> propMeta: array<u32>;
@group(0) @binding(6) var<storage, read> neighbors: array<i32>;
@group(0) @binding(7) var<uniform> params: vec4<u32>; // [T, T4, count, 0]

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
        if (atomicLoad(&wave[waddr]) == 1u) {
          let res = atomicCompareExchangeWeak(&wave[waddr], 1u, 0u);
          if (res.old_value == 1u) {
            let cbase: u32 = i2 * T4 + t2 * 4u;
            atomicStore(&compatible[cbase + 0u], 0i);
            atomicStore(&compatible[cbase + 1u], 0i);
            atomicStore(&compatible[cbase + 2u], 0i);
            atomicStore(&compatible[cbase + 3u], 0i);
            let pos: u32 = atomicAdd(&nextBanned[0], 1u);
            atomicStore(&nextBanned[1u + pos * 2u], i2);
            atomicStore(&nextBanned[1u + pos * 2u + 1u], t2);
          }
        }
      }
    }
  }
}
`;

const PREPARE_INDIRECT_WGSL = `
@group(0) @binding(0) var<storage, read_write> curBanned: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> indirectArgs: array<u32>;

@compute @workgroup_size(1)
fn main() {
  let n: u32 = atomicLoad(&curBanned[0]);
  indirectArgs[0] = (n + 63u) / 64u;
  indirectArgs[1] = 1u;
  indirectArgs[2] = 1u;
}
`;

function toU32(src: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] >>> 0;
  return out;
}

function toI32(src: ArrayLike<number>): Int32Array {
  const out = new Int32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] | 0;
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
  for (let t = 0; t < T; t++) if (t !== kept && exposed.wave_[cell * T + t] === 1) exposed.ban_(cell, t);
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
    if (bans > bestBans) { bestBans = bans; bestKept = kept; }
  }
  if (bestKept < 0) throw new Error("could not pick trigger");
  exposed.clear_();
  applyObserveKeep(exposed, cell, bestKept);
  return [cell, bestKept, bestBans];
}

function diffWave(a: Uint8Array, b: Uint8Array): number {
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  return diffs;
}

async function runCurrentWorklist(device: GPUDevice, exposed: Exposed, preWave: Uint8Array, preCompat: Uint8Array, initBanned: Array<[number, number]>): Promise<{ wave: Uint8Array; ms: number }> {
  const data: GpuPropagatorData = {
    T: exposed.T_, T4: exposed.T4_, count: exposed.count_,
    MX: (exposed as any).MX as number, MY: (exposed as any).MY as number, periodic: true,
    propData: exposed.propData_, propStart: exposed.propStart_, propLen: exposed.propLen_, neighbors: exposed.neighbors_,
  };
  const propagator = new GpuPropagator(device, data);
  const t0 = performance.now();
  const res = await propagator.propagate(preWave, preCompat, initBanned);
  return { wave: res.wave, ms: performance.now() - t0 };
}

async function runIndirect(device: GPUDevice, exposed: Exposed, preWave: Uint8Array, preCompat: Uint8Array, initBanned: Array<[number, number]>): Promise<{ wave: Uint8Array; ms: number; layers: number; sumFrontier: number; maxFrontier: number }> {
  const T = exposed.T_;
  const T4 = exposed.T4_;
  const count = exposed.count_;
  const maxBans = count * T;
  const workBufSize = (1 + 2 * maxBans) * 4;

  const waveU32 = new Uint32Array(preWave.length);
  for (let i = 0; i < preWave.length; i++) waveU32[i] = preWave[i] ? 1 : 0;
  const compatI32 = toI32(preCompat);
  const propDataU32 = toU32(exposed.propData_);
  const propMeta = new Uint32Array(exposed.propStart_.length * 2);
  for (let i = 0; i < exposed.propStart_.length; i++) {
    propMeta[i * 2] = exposed.propStart_[i] >>> 0;
    propMeta[i * 2 + 1] = exposed.propLen_[i] >>> 0;
  }

  const waveBuf = createMappedBuffer(device, waveU32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const compatBuf = createMappedBuffer(device, compatI32, GPUBufferUsage.STORAGE);
  const workA = device.createBuffer({ size: workBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const workB = device.createBuffer({ size: workBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const propDataBuf = createMappedBuffer(device, propDataU32, GPUBufferUsage.STORAGE);
  const propMetaBuf = createMappedBuffer(device, propMeta, GPUBufferUsage.STORAGE);
  const neighborsBuf = createMappedBuffer(device, new Int32Array(exposed.neighbors_), GPUBufferUsage.STORAGE);
  const paramsBuf = createMappedBuffer(device, new Uint32Array([T >>> 0, T4 >>> 0, count >>> 0, 0]), GPUBufferUsage.UNIFORM);
  const zeroBuf = createMappedBuffer(device, new Uint32Array([0]), GPUBufferUsage.COPY_SRC);
  const indirectBuf = createMappedBuffer(device, new Uint32Array([0, 1, 1]), GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
  const countRead = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const waveRead = device.createBuffer({ size: waveU32.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const init = new Uint32Array(1 + 2 * initBanned.length);
  init[0] = initBanned.length;
  for (let k = 0; k < initBanned.length; k++) {
    init[1 + k * 2] = initBanned[k][0] >>> 0;
    init[1 + k * 2 + 1] = initBanned[k][1] >>> 0;
  }
  device.queue.writeBuffer(workA, 0, init);

  const propPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: FUSED_WGSL }), entryPoint: "main" } });
  const prepPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: PREPARE_INDIRECT_WGSL }), entryPoint: "main" } });

  let cur = workA;
  let nxt = workB;
  let curCount = initBanned.length;
  let layers = 0;
  let sumFrontier = 0;
  let maxFrontier = curCount;
  const maxLayers = count * T;
  const t0 = performance.now();

  for (; layers < maxLayers && curCount !== 0; layers++) {
    sumFrontier += curCount;
    if (curCount > maxFrontier) maxFrontier = curCount;

    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(zeroBuf, 0, nxt, 0, 4);

    const prepBind = device.createBindGroup({
      layout: prepPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: cur } },
        { binding: 1, resource: { buffer: indirectBuf } },
      ],
    });
    let pass = enc.beginComputePass();
    pass.setPipeline(prepPipeline);
    pass.setBindGroup(0, prepBind);
    pass.dispatchWorkgroups(1);
    pass.end();

    const propBind = device.createBindGroup({
      layout: propPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: waveBuf } },
        { binding: 1, resource: { buffer: compatBuf } },
        { binding: 2, resource: { buffer: cur } },
        { binding: 3, resource: { buffer: nxt } },
        { binding: 4, resource: { buffer: propDataBuf } },
        { binding: 5, resource: { buffer: propMetaBuf } },
        { binding: 6, resource: { buffer: neighborsBuf } },
        { binding: 7, resource: { buffer: paramsBuf } },
      ],
    });
    pass = enc.beginComputePass();
    pass.setPipeline(propPipeline);
    pass.setBindGroup(0, propBind);
    pass.dispatchWorkgroupsIndirect(indirectBuf, 0);
    pass.end();
    enc.copyBufferToBuffer(nxt, 0, countRead, 0, 4);
    device.queue.submit([enc.finish()]);

    await countRead.mapAsync(GPUMapMode.READ);
    curCount = new Uint32Array(countRead.getMappedRange())[0] >>> 0;
    countRead.unmap();
    const tmp = cur; cur = nxt; nxt = tmp;
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
  return { wave, ms, layers, sumFrontier, maxFrontier };
}

async function runCase(device: GPUDevice, tileset: Tileset, subsetName: string, size: number, label: string): Promise<void> {
  const model = new Exposed({ tileset, subsetName, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (model.count_ === 0) model.init_();
  model.clear_();
  const [cell, kept, expectedBans] = pickStrongObserveLikeTrigger(model);
  const initBanned = getInitialBanned(model);
  const preWave = new Uint8Array(model.wave_);
  const preCompat = normalizeCompatToU8(model.compatible_);

  const tCpu0 = performance.now();
  const cpuOk = model.propagate_();
  const cpuMs = performance.now() - tCpu0;
  const cpuWave = new Uint8Array(model.wave_);

  const current = await runCurrentWorklist(device, model, preWave, preCompat, initBanned);
  const indirect = await runIndirect(device, model, preWave, preCompat, initBanned);
  const currentDiffs = diffWave(cpuWave, current.wave);
  const indirectDiffs = diffWave(cpuWave, indirect.wave);

  console.log(`${label.padEnd(20)} | ${String(size).padStart(4)} | ${String(cell).padStart(5)} | ${String(kept).padStart(4)} | ${String(expectedBans).padStart(7)} | ${cpuMs.toFixed(3).padStart(7)} | ${current.ms.toFixed(3).padStart(9)} | ${indirect.ms.toFixed(3).padStart(11)} | ${String(indirect.layers).padStart(6)} | ${String(indirect.sumFrontier).padStart(8)} | ${String(indirect.maxFrontier).padStart(8)} | ${String(currentDiffs).padStart(7)} | ${String(indirectDiffs).padStart(8)} | ${cpuOk ? "ok" : "bad"}`);
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

  console.log("=== WEBGPU INDIRECT FRONTIER PROPAGATION PROTOTYPE ===");
  console.log("case                 | size |  cell | keep | banTot | CPU ms  | work GPU | indirect GPU | layers | sumFront | maxFront | workDf | indDiff | cpu");
  console.log("---------------------|------|-------|------|--------|---------|----------|--------------|--------|----------|----------|--------|---------|----");
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
