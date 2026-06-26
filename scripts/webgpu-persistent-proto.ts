#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — persistent full-GPU WFC loop.
 *
 * Goal: answer the performance-path question after the drain-bound root cause:
 * can one WebGPU dispatch own select -> weighted observe -> propagation-to-fixpoint
 * -> repeat, using a device-side cross-workgroup barrier and one final readback?
 *
 * This is intentionally script-local. It is not imported by the library and is
 * only exercised on small periodic cases first because persistent cross-WG
 * barriers are a portability/perf research path, not a WebGPU guarantee.
 */

/// <reference types="@webgpu/types" />

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../helpers/index.js";
import * as RefSimpleMod from "../helpers/simple-tiled-model.js";

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
  init_(): void { (this as any).init(); }
  clear_(): void { this.clear(); }
}

const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];

const STATUS = {
  running: 0,
  complete: 1,
  contradiction: 2,
  maxObserves: 3,
  maxCascade: 4,
  barrierTimeout: 0xbad0bad0,
} as const;

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

function f32Bits(values: ArrayLike<number>): Uint32Array {
  const f = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) f[i] = values[i];
  return new Uint32Array(f.buffer);
}

function buildAllowedFromRef(tileset: Tileset, subsetName: string | null): { allowed: number[][]; T: number } {
  const RefSimple: any = (RefSimpleMod as any).SimpleTiledModel ?? (RefSimpleMod as any).default ?? RefSimpleMod;
  const ref = new RefSimple({ tileset, subsetName: subsetName ?? null, width: 1, height: 1, periodic: true });
  ref.run(0, 0);
  const prop = (ref as any).propagator as number[][][];
  const T = prop[0].length;
  const allowed: number[][] = [];
  for (let d = 0; d < 4; d++) {
    const row = new Array(T * T).fill(0);
    for (let t1 = 0; t1 < T; t1++) {
      for (const t2 of prop[d][t1]) row[t1 * T + t2] = 1;
    }
    allowed[d] = row;
  }
  return { allowed, T };
}

function validateObserved(tileset: Tileset, subsetName: string | null, MX: number, MY: number, observed: Int32Array): { valid: boolean; violations: number; checks: number; unresolved: number } {
  const { allowed, T } = buildAllowedFromRef(tileset, subsetName);
  let violations = 0;
  let checks = 0;
  let unresolved = 0;
  for (let y = 0; y < MY; y++) {
    for (let x = 0; x < MX; x++) {
      const i = x + y * MX;
      const t1 = observed[i];
      if (t1 < 0 || t1 >= T) {
        unresolved++;
        continue;
      }
      for (let d = 0; d < 4; d++) {
        let x2 = x + DX[d];
        let y2 = y + DY[d];
        x2 = (x2 + MX) % MX;
        y2 = (y2 + MY) % MY;
        const t2 = observed[x2 + y2 * MX];
        if (t2 < 0 || t2 >= T) continue;
        checks++;
        if (allowed[d][t1 * T + t2] !== 1) violations++;
      }
    }
  }
  return { valid: violations === 0 && unresolved === 0, violations, checks, unresolved };
}

function statusName(status: number): string {
  for (const [k, v] of Object.entries(STATUS)) if (v === status) return k;
  return `unknown(${status})`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PERSISTENT_WGSL = `
@group(0) @binding(0) var<storage, read_write> waveSums: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> compatible: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> workA: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> workB: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> propDataWeights: array<u32>;
@group(0) @binding(5) var<storage, read> propMeta: array<u32>;
@group(0) @binding(6) var<storage, read> neighbors: array<i32>;
@group(0) @binding(7) var<storage, read> params: array<u32>;

const STATUS_RUNNING: u32 = 0u;
const STATUS_COMPLETE: u32 = 1u;
const STATUS_CONTRADICTION: u32 = 2u;
const STATUS_MAX_OBSERVES: u32 = 3u;
const STATUS_MAX_CASCADE: u32 = 4u;
const STATUS_BARRIER_TIMEOUT: u32 = 0xBAD0BAD0u;
const BEST_SENTINEL: u32 = 0xffffffffu;

fn wave_index(cell: u32, tile: u32) -> u32 {
  return cell * params[0] + tile;
}

fn sums_index(cell: u32) -> u32 {
  return params[2] * params[0] + cell;
}

fn ctrl(idx: u32) -> u32 {
  return params[6] + idx;
}

fn global_barrier(_lid: u32) {
  // All invocations participate. This avoids WGSL's workgroupBarrier uniformity
  // restriction while still testing the persistent-kernel path on this backend.
  let gen: u32 = atomicLoad(&workA[ctrl(1u)]);
  let prev: u32 = atomicAdd(&workA[ctrl(0u)], 1u);
  if (prev + 1u == params[7]) {
    atomicStore(&workA[ctrl(0u)], 0u);
    atomicStore(&workA[ctrl(1u)], gen + 1u);
  } else {
    var spins: u32 = 0u;
    loop {
      if (atomicLoad(&workA[ctrl(1u)]) != gen) { break; }
      spins = spins + 1u;
      if (spins > params[8]) {
        atomicStore(&workA[ctrl(2u)], STATUS_BARRIER_TIMEOUT);
        break;
      }
    }
  }
}

fn mulberry32_next(seed: u32) -> u32 {
  var z: u32 = seed + 0x6D2B79F5u;
  z = (z ^ (z >> 15u)) * (z | 1u);
  z = z ^ (z + ((z ^ (z >> 7u)) * (z | 61u)));
  return z ^ (z >> 14u);
}

fn weight(tile: u32) -> f32 {
  return bitcast<f32>(propDataWeights[params[3] + tile]);
}

fn append_work_a(cell: u32, tile: u32) {
  let pos: u32 = atomicAdd(&workA[0], 1u);
  atomicStore(&workA[1u + pos * 2u], cell);
  atomicStore(&workA[1u + pos * 2u + 1u], tile);
}

fn append_work_b(cell: u32, tile: u32) {
  let pos: u32 = atomicAdd(&workB[0], 1u);
  atomicStore(&workB[1u + pos * 2u], cell);
  atomicStore(&workB[1u + pos * 2u + 1u], tile);
}

fn observe_weighted_leader() {
  let packed: u32 = atomicLoad(&workA[ctrl(4u)]);
  if (packed == BEST_SENTINEL) {
    atomicStore(&workA[ctrl(2u)], STATUS_COMPLETE);
    return;
  }

  let cell: u32 = packed & 0x000fffffu;
  let base: u32 = cell * params[0];
  var total: f32 = 0.0;
  var fallback: u32 = BEST_SENTINEL;
  for (var t: u32 = 0u; t < params[0]; t = t + 1u) {
    if (atomicLoad(&waveSums[base + t]) == 1u) {
      total = total + weight(t);
      fallback = t;
    }
  }
  if (fallback == BEST_SENTINEL || total <= 0.0) {
    atomicStore(&workA[ctrl(2u)], STATUS_CONTRADICTION);
    return;
  }

  let seed: u32 = atomicLoad(&workA[ctrl(5u)]);
  let nextSeed: u32 = mulberry32_next(seed);
  atomicStore(&workA[ctrl(5u)], nextSeed);
  let threshold: f32 = (f32(nextSeed) / 4294967296.0) * total;

  var kept: u32 = fallback;
  var acc: f32 = 0.0;
  for (var t2: u32 = 0u; t2 < params[0]; t2 = t2 + 1u) {
    if (atomicLoad(&waveSums[base + t2]) == 1u) {
      acc = acc + weight(t2);
      if (threshold <= acc) {
        kept = t2;
        break;
      }
    }
  }

  var seedBans: u32 = 0u;
  for (var t3: u32 = 0u; t3 < params[0]; t3 = t3 + 1u) {
    if (t3 == kept) { continue; }
    let waddr: u32 = base + t3;
    if (atomicLoad(&waveSums[waddr]) == 1u) {
      atomicStore(&waveSums[waddr], 0u);
      let cbase: u32 = cell * params[1] + t3 * 4u;
      atomicStore(&compatible[cbase + 0u], 0i);
      atomicStore(&compatible[cbase + 1u], 0i);
      atomicStore(&compatible[cbase + 2u], 0i);
      atomicStore(&compatible[cbase + 3u], 0i);
      atomicSub(&waveSums[sums_index(cell)], 1u);
      append_work_a(cell, t3);
      seedBans = seedBans + 1u;
    }
  }

  atomicStore(&workA[ctrl(6u)], cell);
  atomicStore(&workA[ctrl(7u)], kept);
  atomicStore(&workA[ctrl(8u)], seedBans);
}

fn process_frontier(worker: u32, parity: u32, n: u32) {
  var idx: u32 = worker;
  loop {
    if (idx >= n) { break; }
    var i1: u32;
    var t1: u32;
    if (parity == 0u) {
      i1 = atomicLoad(&workA[1u + idx * 2u]);
      t1 = atomicLoad(&workA[1u + idx * 2u + 1u]);
    } else {
      i1 = atomicLoad(&workB[1u + idx * 2u]);
      t1 = atomicLoad(&workB[1u + idx * 2u + 1u]);
    }

    for (var d: u32 = 0u; d < 4u; d = d + 1u) {
      let i2i: i32 = neighbors[i1 * 4u + d];
      if (i2i < 0) { continue; }
      let i2: u32 = u32(i2i);
      let key: u32 = d * params[0] + t1;
      let start: u32 = propMeta[key * 2u];
      let len: u32 = propMeta[key * 2u + 1u];
      let base2: u32 = i2 * params[1];
      for (var l: u32 = 0u; l < len; l = l + 1u) {
        let t2: u32 = propDataWeights[start + l];
        let cidx: u32 = base2 + t2 * 4u + d;
        let prev: i32 = atomicSub(&compatible[cidx], 1i);
        if (prev == 1i) {
          let waddr: u32 = wave_index(i2, t2);
          if (atomicLoad(&waveSums[waddr]) == 1u) {
            let res = atomicCompareExchangeWeak(&waveSums[waddr], 1u, 0u);
            if (res.old_value == 1u) {
              let cbase: u32 = i2 * params[1] + t2 * 4u;
              atomicStore(&compatible[cbase + 0u], 0i);
              atomicStore(&compatible[cbase + 1u], 0i);
              atomicStore(&compatible[cbase + 2u], 0i);
              atomicStore(&compatible[cbase + 3u], 0i);
              atomicSub(&waveSums[sums_index(i2)], 1u);
              if (parity == 0u) {
                append_work_b(i2, t2);
              } else {
                append_work_a(i2, t2);
              }
            }
          }
        }
      }
    }
    idx = idx + params[7];
  }
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let lid: u32 = lid3.x;
  if (lid != 0u) { return; }
  let worker: u32 = wg.x;
  let leader: bool = (worker == 0u);

  var outer: u32 = 0u;
  loop {
    global_barrier(lid);
    if (atomicLoad(&workA[ctrl(2u)]) != STATUS_RUNNING) { break; }
    if (outer >= params[4]) {
      if (leader) { atomicStore(&workA[ctrl(2u)], STATUS_MAX_OBSERVES); }
      global_barrier(lid);
      break;
    }

    if (leader) {
      atomicStore(&workA[ctrl(4u)], BEST_SENTINEL);
      atomicStore(&workA[0], 0u);
      atomicStore(&workB[0], 0u);
    }
    global_barrier(lid);

    var cellScan: u32 = worker;
    loop {
      if (cellScan >= params[2]) { break; }
      let s: u32 = atomicLoad(&waveSums[sums_index(cellScan)]);
      if (s == 0u) {
        atomicStore(&workA[ctrl(2u)], STATUS_CONTRADICTION);
      } else if (s > 1u) {
        let packed: u32 = (s << 20u) | cellScan;
        atomicMin(&workA[ctrl(4u)], packed);
      }
      cellScan = cellScan + params[7];
    }
    global_barrier(lid);

    if (atomicLoad(&workA[ctrl(2u)]) != STATUS_RUNNING) { break; }
    if (leader) { observe_weighted_leader(); }
    global_barrier(lid);
    if (atomicLoad(&workA[ctrl(2u)]) != STATUS_RUNNING) { break; }

    var parity: u32 = 0u;
    var cascade: u32 = 0u;
    loop {
      var n: u32;
      if (parity == 0u) {
        n = atomicLoad(&workA[0]);
      } else {
        n = atomicLoad(&workB[0]);
      }
      if (n == 0u) { break; }
      if (cascade >= params[5]) {
        if (leader) { atomicStore(&workA[ctrl(2u)], STATUS_MAX_CASCADE); }
        global_barrier(lid);
        break;
      }
      if (leader) {
        if (parity == 0u) {
          atomicStore(&workB[0], 0u);
        } else {
          atomicStore(&workA[0], 0u);
        }
      }
      global_barrier(lid);
      process_frontier(worker, parity, n);
      global_barrier(lid);
      parity = 1u - parity;
      cascade = cascade + 1u;
    }

    if (atomicLoad(&workA[ctrl(2u)]) != STATUS_RUNNING) { break; }
    outer = outer + 1u;
    if (leader) {
      atomicStore(&workA[ctrl(3u)], outer);
    }
  }
}
`;

interface PersistentResult {
  status: number;
  ms: number;
  observes: number;
  control: number[];
  observed: Int32Array;
  valid: boolean;
  violations: number;
  unresolved: number;
}

function createMappedBuffer<T extends Uint32Array | Int32Array>(device: GPUDevice, data: T, usage: number): GPUBuffer {
  const buf = device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
  if (data instanceof Int32Array) new Int32Array(buf.getMappedRange()).set(data);
  else new Uint32Array(buf.getMappedRange()).set(data);
  buf.unmap();
  return buf;
}

async function runPersistent(device: GPUDevice, tileset: Tileset, subset: string | null, size: number, seed: number): Promise<PersistentResult> {
  const cpu = new Exposed({ tileset, subsetName: subset, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (cpu.count_ === 0) cpu.init_();
  cpu.clear_();

  const T = cpu.T_;
  const T4 = cpu.T4_;
  const count = cpu.count_;
  const maxBans = count * T;
  const maxWgs = Math.min(64, Math.max(1, maxBans));
  const ctrlOffset = 1 + 2 * maxBans;
  const ctrlWords = 16;
  const workWords = ctrlOffset + ctrlWords;

  const waveSums = new Uint32Array(count * T + count);
  for (let i = 0; i < count * T; i++) waveSums[i] = cpu.wave_[i] ? 1 : 0;
  const sums = cpu.sumsOfOnes_;
  for (let i = 0; i < count; i++) waveSums[count * T + i] = (sums as any)[i] >>> 0;

  const compat = toI32(cpu.compatible_);
  const propData = toU32(cpu.propData_);
  const weightBits = f32Bits(cpu.weights_);
  const propDataWeights = new Uint32Array(propData.length + weightBits.length);
  propDataWeights.set(propData, 0);
  propDataWeights.set(weightBits, propData.length);

  const propMeta = new Uint32Array(cpu.propStart_.length * 2);
  for (let i = 0; i < cpu.propStart_.length; i++) {
    propMeta[i * 2] = cpu.propStart_[i] >>> 0;
    propMeta[i * 2 + 1] = cpu.propLen_[i] >>> 0;
  }

  const workInit = new Uint32Array(workWords);
  workInit[ctrlOffset + 0] = 0; // arrived
  workInit[ctrlOffset + 1] = 0; // generation
  workInit[ctrlOffset + 2] = STATUS.running;
  workInit[ctrlOffset + 3] = 0; // observes
  workInit[ctrlOffset + 4] = 0xffffffff; // best
  workInit[ctrlOffset + 5] = seed >>> 0; // rng

  const waveSumsBuf = createMappedBuffer(device, waveSums, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const compatBuf = createMappedBuffer(device, compat, GPUBufferUsage.STORAGE);
  const workABuf = createMappedBuffer(device, workInit, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const workBBuf = device.createBuffer({ size: workWords * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(workBBuf, 0, new Uint32Array(workWords));
  const propDataBuf = createMappedBuffer(device, propDataWeights, GPUBufferUsage.STORAGE);
  const propMetaBuf = createMappedBuffer(device, propMeta, GPUBufferUsage.STORAGE);
  const neighborsBuf = createMappedBuffer(device, new Int32Array(cpu.neighbors_), GPUBufferUsage.STORAGE);

  const params = new Uint32Array([
    T >>> 0,
    T4 >>> 0,
    count >>> 0,
    propData.length >>> 0,
    count >>> 0, // max observes
    maxBans >>> 0, // max cascade per observe
    ctrlOffset >>> 0,
    maxWgs >>> 0,
    500_000_000,
    0,
    0,
    0,
  ]);
  const paramsBuf = createMappedBuffer(device, params, GPUBufferUsage.STORAGE);

  const waveRead = device.createBuffer({ size: waveSums.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const controlRead = device.createBuffer({ size: ctrlWords * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code: PERSISTENT_WGSL });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const pipelineError = await device.popErrorScope();
  if (pipelineError) throw new Error(`pipeline validation error: ${pipelineError.message}`);

  device.pushErrorScope("validation");
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: waveSumsBuf } },
      { binding: 1, resource: { buffer: compatBuf } },
      { binding: 2, resource: { buffer: workABuf } },
      { binding: 3, resource: { buffer: workBBuf } },
      { binding: 4, resource: { buffer: propDataBuf } },
      { binding: 5, resource: { buffer: propMetaBuf } },
      { binding: 6, resource: { buffer: neighborsBuf } },
      { binding: 7, resource: { buffer: paramsBuf } },
    ],
  });
  const bindError = await device.popErrorScope();
  if (bindError) throw new Error(`bind validation error: ${bindError.message}`);

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(maxWgs);
  pass.end();
  enc.copyBufferToBuffer(waveSumsBuf, 0, waveRead, 0, waveSums.byteLength);
  enc.copyBufferToBuffer(workABuf, ctrlOffset * 4, controlRead, 0, ctrlWords * 4);

  const start = performance.now();
  device.pushErrorScope("validation");
  device.queue.submit([enc.finish()]);
  const submitError = await device.popErrorScope();
  if (submitError) throw new Error(`submit validation error: ${submitError.message}`);
  await withTimeout(Promise.all([waveRead.mapAsync(GPUMapMode.READ), controlRead.mapAsync(GPUMapMode.READ)]), 30_000, `${subset}-${size} persistent dispatch`);
  const ms = performance.now() - start;

  const gotWaveSums = new Uint32Array(waveRead.getMappedRange()).slice(0);
  const gotControl = new Uint32Array(controlRead.getMappedRange()).slice(0);
  waveRead.unmap();
  controlRead.unmap();

  const observed = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    let found = -1;
    let live = 0;
    const base = i * T;
    for (let t = 0; t < T; t++) {
      if (gotWaveSums[base + t] === 1) {
        found = t;
        live++;
      }
    }
    observed[i] = live === 1 ? found : -1;
  }
  const v = validateObserved(tileset, subset, size, size, observed);
  return {
    status: gotControl[2] >>> 0,
    ms,
    observes: gotControl[3] >>> 0,
    control: Array.from(gotControl),
    observed,
    valid: v.valid,
    violations: v.violations,
    unresolved: v.unresolved,
  };
}

async function timeJs(tileset: Tileset, subset: string | null, size: number, seed: number): Promise<{ ok: boolean; ms: number; valid: boolean }> {
  const model = new SimpleTiledModel({ tileset, subsetName: subset, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  const start = performance.now();
  const ok = model.run(seed, -1, 100);
  const ms = performance.now() - start;
  const v = validateObserved(tileset, subset, size, size, model.result());
  return { ok, ms, valid: v.valid };
}

async function main(): Promise<void> {
  setupGlobals();
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  console.log("adapter", adapter.info ?? "(no adapter info)");
  console.log("limits", {
    maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
  });
  const device = await adapter.requestDevice();

  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const cases: Array<{ label: string; ts: Tileset; subset: string; size: number; seed: number }> = [
    // Keep this script to the smallest known-finishing case. Wider cases are
    // documented in OPTIMIZATION-LOG.md: circuit-16 and knots-8 exceeded the
    // safety timeout with this barrier shape.
    { label: "circuit-turnless", ts: circuit, subset: "Turnless", size: 8, seed: 0 },
  ];

  console.log("\n=== PERSISTENT FULL-GPU WFC PROTOTYPE ===");
  for (const c of cases) {
    console.log(`\n--- ${c.label}-${c.size} seed=${c.seed} ---`);
    const js = await timeJs(c.ts, c.subset, c.size, c.seed);
    console.log(`JS:         ok=${js.ok} valid=${js.valid} ms=${js.ms.toFixed(3)}`);
    const gpu1 = await runPersistent(device, c.ts, c.subset, c.size, c.seed);
    const gpu2 = await runPersistent(device, c.ts, c.subset, c.size, c.seed);
    let det = gpu1.observed.length === gpu2.observed.length && gpu1.status === gpu2.status;
    for (let i = 0; det && i < gpu1.observed.length; i++) if (gpu1.observed[i] !== gpu2.observed[i]) det = false;
    console.log(`GPU:        status=${statusName(gpu1.status)} observes=${gpu1.observes} valid=${gpu1.valid} violations=${gpu1.violations} unresolved=${gpu1.unresolved} ms=${gpu1.ms.toFixed(3)} control=${gpu1.control.slice(0, 9).join(",")}`);
    console.log(`GPU repeat: status=${statusName(gpu2.status)} observes=${gpu2.observes} valid=${gpu2.valid} ms=${gpu2.ms.toFixed(3)} det=${det ? "PASS" : "FAIL"} control=${gpu2.control.slice(0, 9).join(",")}`);
    console.log(`GPU vs JS:  ${(js.ms / gpu1.ms).toFixed(3)}x`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
