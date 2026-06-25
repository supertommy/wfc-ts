#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — no-spin full-GPU observe chunks.
 *
 * Hypothesis: WebGPU command ordering may be enough to collapse CPU/GPU crossings:
 * encode select -> weighted observe -> K fixed propagation layers, repeat N times,
 * then do one final readback. This avoids persistent spin barriers and avoids
 * per-observe banned-log readbacks. It is intentionally script-local.
 *
 * This does NOT prove a shippable solver. It tests whether conservative fixed
 * propagation epochs can maintain the fixpoint invariant cheaply enough to be a
 * plausible next path.
 */

/// <reference types="@webgpu/types" />

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../src-optimized/index.js";
import * as RefSimpleMod from "../src/simple-tiled-model.js";

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

function extractWgsl(name: string): string {
  const source = readFileSync(new URL("./debug-gpu-lockstep.ts", import.meta.url), "utf8");
  const startToken = `const ${name} = \``;
  const start = source.indexOf(startToken);
  if (start < 0) throw new Error(`Could not find ${name} in debug-gpu-lockstep.ts`);
  const bodyStart = start + startToken.length;
  const end = source.indexOf("`;", bodyStart);
  if (end < 0) throw new Error(`Could not extract ${name} from debug-gpu-lockstep.ts`);
  return source.slice(bodyStart, end);
}

const RESET_BEST_WGSL = extractWgsl("RESET_BEST_WGSL");
const PARALLEL_SELECT_WGSL = extractWgsl("PARALLEL_SELECT_WGSL");
const OBSERVE_SELECTED_WEIGHTED_WGSL = extractWgsl("OBSERVE_SELECTED_WEIGHTED_WGSL");
const PROPAGATE_WGSL = extractWgsl("PROPAGATE_WGSL");

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

function createMappedBuffer<T extends Uint32Array | Int32Array | Float32Array>(device: GPUDevice, data: T, usage: GPUBufferUsageFlags): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
  if (data instanceof Int32Array) new Int32Array(buffer.getMappedRange()).set(data);
  else if (data instanceof Float32Array) new Float32Array(buffer.getMappedRange()).set(data);
  else new Uint32Array(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
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
    for (let t1 = 0; t1 < T; t1++) for (const t2 of prop[d][t1]) row[t1 * T + t2] = 1;
    allowed[d] = row;
  }
  return { allowed, T };
}

function validateObserved(tileset: Tileset, subsetName: string | null, MX: number, MY: number, observed: Int32Array): { valid: boolean; violations: number; unresolved: number; checks: number } {
  const { allowed, T } = buildAllowedFromRef(tileset, subsetName);
  let violations = 0;
  let unresolved = 0;
  let checks = 0;
  for (let y = 0; y < MY; y++) {
    for (let x = 0; x < MX; x++) {
      const i = x + y * MX;
      const t1 = observed[i];
      if (t1 < 0 || t1 >= T) {
        unresolved++;
        continue;
      }
      for (let d = 0; d < 4; d++) {
        const x2 = (x + DX[d] + MX) % MX;
        const y2 = (y + DY[d] + MY) % MY;
        const t2 = observed[x2 + y2 * MX];
        if (t2 < 0 || t2 >= T) {
          unresolved++;
          continue;
        }
        checks++;
        if (allowed[d][t1 * T + t2] !== 1) violations++;
      }
    }
  }
  return { valid: violations === 0 && unresolved === 0, violations, unresolved, checks };
}

function sameObserved(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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

interface ChunkResult {
  ms: number;
  observed: Int32Array;
  valid: boolean;
  violations: number;
  unresolved: number;
  submits: number;
  dispatches: number;
}

async function runNoSpinChunk(device: GPUDevice, tileset: Tileset, subset: string | null, size: number, seed: number, epoch: number): Promise<ChunkResult> {
  const cpu = new Exposed({ tileset, subsetName: subset, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (cpu.count_ === 0) cpu.init_();
  cpu.clear_();

  const T = cpu.T_;
  const T4 = cpu.T4_;
  const count = cpu.count_;
  const maxBans = count * T;
  const workBufSize = (1 + 2 * maxBans) * 4;
  const maxWorkgroups = Math.ceil(maxBans / 64);
  const selectWorkgroups = Math.ceil(count / 64);

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

  const waveBuf = createMappedBuffer(device, waveU32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const compatBuf = createMappedBuffer(device, compatI32, GPUBufferUsage.STORAGE);
  const sumsBuf = createMappedBuffer(device, sumsU32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const workA = device.createBuffer({ size: workBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const workB = device.createBuffer({ size: workBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const propDataBuf = createMappedBuffer(device, propDataU32, GPUBufferUsage.STORAGE);
  const propMetaBuf = createMappedBuffer(device, propMetaU32, GPUBufferUsage.STORAGE);
  const neighborsBuf = createMappedBuffer(device, new Int32Array(cpu.neighbors_), GPUBufferUsage.STORAGE);
  const weightsBuf = createMappedBuffer(device, new Float32Array(cpu.weights_), GPUBufferUsage.STORAGE);
  const rngBuf = createMappedBuffer(device, new Uint32Array([seed >>> 0]), GPUBufferUsage.STORAGE);
  const paramsBuf = createMappedBuffer(device, new Uint32Array([T >>> 0, T4 >>> 0, count >>> 0, 0]), GPUBufferUsage.UNIFORM);
  const bestBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const debugBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const zeroBuf = createMappedBuffer(device, new Uint32Array([0]), GPUBufferUsage.COPY_SRC);

  const waveRead = device.createBuffer({ size: waveU32.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const sumsRead = device.createBuffer({ size: sumsU32.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const resetBestPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: RESET_BEST_WGSL }), entryPoint: "main" } });
  const selectPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: PARALLEL_SELECT_WGSL }), entryPoint: "main" } });
  const observePipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: OBSERVE_SELECTED_WEIGHTED_WGSL }), entryPoint: "main" } });
  const propPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: PROPAGATE_WGSL }), entryPoint: "main" } });

  const resetBestBind = device.createBindGroup({ layout: resetBestPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bestBuf } }] });
  const selectBind = device.createBindGroup({
    layout: selectPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: sumsBuf } },
      { binding: 1, resource: { buffer: bestBuf } },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  });
  const observeBind = device.createBindGroup({
    layout: observePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: waveBuf } },
      { binding: 1, resource: { buffer: compatBuf } },
      { binding: 2, resource: { buffer: sumsBuf } },
      { binding: 3, resource: { buffer: workA } },
      { binding: 4, resource: { buffer: debugBuf } },
      { binding: 5, resource: { buffer: paramsBuf } },
      { binding: 6, resource: { buffer: bestBuf } },
      { binding: 7, resource: { buffer: weightsBuf } },
      { binding: 8, resource: { buffer: rngBuf } },
    ],
  });
  const propBindAB = device.createBindGroup({
    layout: propPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: waveBuf } },
      { binding: 1, resource: { buffer: compatBuf } },
      { binding: 2, resource: { buffer: sumsBuf } },
      { binding: 3, resource: { buffer: workA } },
      { binding: 4, resource: { buffer: workB } },
      { binding: 5, resource: { buffer: propDataBuf } },
      { binding: 6, resource: { buffer: propMetaBuf } },
      { binding: 7, resource: { buffer: neighborsBuf } },
      { binding: 8, resource: { buffer: paramsBuf } },
    ],
  });
  const propBindBA = device.createBindGroup({
    layout: propPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: waveBuf } },
      { binding: 1, resource: { buffer: compatBuf } },
      { binding: 2, resource: { buffer: sumsBuf } },
      { binding: 3, resource: { buffer: workB } },
      { binding: 4, resource: { buffer: workA } },
      { binding: 5, resource: { buffer: propDataBuf } },
      { binding: 6, resource: { buffer: propMetaBuf } },
      { binding: 7, resource: { buffer: neighborsBuf } },
      { binding: 8, resource: { buffer: paramsBuf } },
    ],
  });

  let dispatches = 0;
  const enc = device.createCommandEncoder();
  for (let observe = 0; observe < count; observe++) {
    enc.copyBufferToBuffer(zeroBuf, 0, workA, 0, 4);
    enc.copyBufferToBuffer(zeroBuf, 0, workB, 0, 4);
    enc.copyBufferToBuffer(zeroBuf, 0, debugBuf, 0, 4);

    let pass = enc.beginComputePass();
    pass.setPipeline(resetBestPipeline);
    pass.setBindGroup(0, resetBestBind);
    pass.dispatchWorkgroups(1);
    pass.end();
    dispatches++;

    pass = enc.beginComputePass();
    pass.setPipeline(selectPipeline);
    pass.setBindGroup(0, selectBind);
    pass.dispatchWorkgroups(selectWorkgroups);
    pass.end();
    dispatches++;

    pass = enc.beginComputePass();
    pass.setPipeline(observePipeline);
    pass.setBindGroup(0, observeBind);
    pass.dispatchWorkgroups(1);
    pass.end();
    dispatches++;

    let curIsA = true;
    for (let k = 0; k < epoch; k++) {
      if (curIsA) enc.copyBufferToBuffer(zeroBuf, 0, workB, 0, 4);
      else enc.copyBufferToBuffer(zeroBuf, 0, workA, 0, 4);
      pass = enc.beginComputePass();
      pass.setPipeline(propPipeline);
      pass.setBindGroup(0, curIsA ? propBindAB : propBindBA);
      pass.dispatchWorkgroups(maxWorkgroups);
      pass.end();
      curIsA = !curIsA;
      dispatches++;
    }
  }

  enc.copyBufferToBuffer(waveBuf, 0, waveRead, 0, waveU32.byteLength);
  enc.copyBufferToBuffer(sumsBuf, 0, sumsRead, 0, sumsU32.byteLength);

  const t0 = performance.now();
  device.queue.submit([enc.finish()]);
  await withTimeout(Promise.all([waveRead.mapAsync(GPUMapMode.READ), sumsRead.mapAsync(GPUMapMode.READ)]), 60_000, `no-spin chunk ${size} epoch=${epoch}`);
  const ms = performance.now() - t0;

  const outWaveU32 = new Uint32Array(waveRead.getMappedRange()).slice(0);
  waveRead.unmap();
  const outSums = new Uint32Array(sumsRead.getMappedRange()).slice(0);
  sumsRead.unmap();

  const observed = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const sum = outSums[i] >>> 0;
    if (sum !== 1) {
      observed[i] = -1;
      continue;
    }
    observed[i] = -1;
    for (let t = 0; t < T; t++) {
      if (outWaveU32[i * T + t] !== 0) {
        observed[i] = t;
        break;
      }
    }
  }

  const v = validateObserved(tileset, subset, size, size, observed);
  return { ms, observed, valid: v.valid, violations: v.violations, unresolved: v.unresolved, submits: 1, dispatches };
}

async function timeJsRun(tileset: Tileset, subset: string | null, size: number, seed: number): Promise<{ ok: boolean; ms: number }> {
  const model = new SimpleTiledModel({ tileset, subsetName: subset, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  const t0 = performance.now();
  const ok = model.run(seed, -1, 100);
  return { ok, ms: performance.now() - t0 };
}

async function main(): Promise<void> {
  await setupGlobals();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const cases = [
    { label: "circuit-turnless", tileset: circuit, subset: "Turnless", size: 8, seed: 0, epochs: [8, 16, 32] },
    { label: "circuit-turnless", tileset: circuit, subset: "Turnless", size: 16, seed: 0, epochs: [16, 32, 64] },
    { label: "circuit-turnless", tileset: circuit, subset: "Turnless", size: 32, seed: 0, epochs: [16, 32] },
  ];

  console.log("=== NO-SPIN FULL-GPU OBSERVE CHUNK PROTOTYPE ===");
  console.log("case                | epoch | JS ms  | GPU ms  | speedup | valid | det  | violations | unresolved | dispatches | submits");
  console.log("--------------------|-------|--------|---------|---------|-------|------|------------|------------|------------|--------");

  for (const c of cases) {
    const js = await timeJsRun(c.tileset, c.subset, c.size, c.seed);
    for (const epoch of c.epochs) {
      const r1 = await runNoSpinChunk(device, c.tileset, c.subset, c.size, c.seed, epoch);
      const r2 = await runNoSpinChunk(device, c.tileset, c.subset, c.size, c.seed, epoch);
      const det = sameObserved(r1.observed, r2.observed);
      const speedup = r1.ms > 0 ? js.ms / r1.ms : Infinity;
      console.log(`${`${c.label}-${c.size}`.padEnd(19)} | ${String(epoch).padStart(5)} | ${js.ms.toFixed(2).padStart(6)} | ${r1.ms.toFixed(2).padStart(7)} | ${speedup.toFixed(3).padStart(7)}x | ${r1.valid ? "PASS" : "FAIL"} | ${det ? "PASS" : "FAIL"} | ${String(r1.violations).padStart(10)} | ${String(r1.unresolved).padStart(10)} | ${String(r1.dispatches).padStart(10)} | ${String(r1.submits).padStart(6)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
