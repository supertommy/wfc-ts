#!/usr/bin/env bun
/**
 * THROWAWAY PROTOTYPE — WebGPU parallel-AC-4 propagation (de-risk "real wall").
 * ONLY answers Q1 (correctness) + Q2 (crossover). NOT committed to solver.
 * Run: bun scripts/webgpu-prototype.ts
 *
 * Hard rules respected: no edits to src*, src-optimized/, harness/, test/, performance-test/.
 * Only this script + devDep + log append.
 */

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import { SimpleTiledModel, Heuristic, parseTileset, type Tileset } from "../src-optimized/index.js";

// WGSL: APPLY — mirror CPU: for each newlyBanned (i1,t1), for each d, for each t2 in prop[d][t1],
//       i2 = neighbors[i1*4+d], if >=0: atomicDecr( compatible[ i2*T4 + t2*4 + d ] )
// NOTE: only declare USED resources (WGSL 'auto' layout prunes unused; bind counts must match).
const APPLY_WGSL = `
@group(0) @binding(0) var<storage, read_write> compatible: array<atomic<i32>>;
@group(0) @binding(1) var<storage, read> propData: array<u32>;
@group(0) @binding(2) var<storage, read> propStart: array<u32>;
@group(0) @binding(3) var<storage, read> propLen: array<u32>;
@group(0) @binding(4) var<storage, read> neighbors: array<i32>;
@group(0) @binding(5) var<storage, read_write> banned: array<atomic<u32>>;
@group(0) @binding(6) var<uniform> params: vec4<u32>; // [T, T4, count, 0]

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx: u32 = gid.x;
  let num: u32 = atomicLoad(&banned[0]);
  if (idx >= num) { return; }
  let i1: u32 = atomicLoad(&banned[1u + idx * 2u]);
  let t1: u32 = atomicLoad(&banned[1u + idx * 2u + 1u]);
  let T: u32 = params[0];
  let T4: u32 = params[1];
  for (var d: u32 = 0u; d < 4u; d = d + 1u) {
    let i2i: i32 = neighbors[i1 * 4u + d];
    if (i2i < 0) { continue; }
    let i2: u32 = u32(i2i);
    let key: u32 = d * T + t1;
    let start: u32 = propStart[key];
    let len: u32 = propLen[key];
    let base2: u32 = i2 * T4;
    for (var l: u32 = 0u; l < len; l = l + 1u) {
      let t2: u32 = propData[start + l];
      let cidx: u32 = base2 + t2 * 4u + d;
      atomicSub(&compatible[cidx], 1);
    }
  }
}
`;

// WGSL: DETECT — for every live (wave==1) (i,t), if ANY dir compat==0 => ban it:
//         wave=0, zero its 4 compats, append to nextBanned, flag changed.
const DETECT_WGSL = `
@group(0) @binding(0) var<storage, read_write> wave: array<u32>;
@group(0) @binding(1) var<storage, read_write> compatible: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> nextBanned: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> changed: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> params: vec4<u32>; // [T, T4, count, 0]

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let flat: u32 = gid.x;
  let T: u32 = params[0];
  let T4: u32 = params[1];
  let count: u32 = params[2];
  let total: u32 = count * T;
  if (flat >= total) { return; }
  let i: u32 = flat / T;
  let t: u32 = flat % T;
  if (wave[i * T + t] == 0u) { return; }
  let cbase: u32 = i * T4 + t * 4u;
  var unsup = false;
  for (var d: u32 = 0u; d < 4u; d = d + 1u) {
    if (atomicLoad(&compatible[cbase + d]) <= 0) {
      unsup = true;
      break;
    }
  }
  if (unsup) {
    wave[i * T + t] = 0u;
    for (var d: u32 = 0u; d < 4u; d = d + 1u) {
      atomicStore(&compatible[cbase + d], 0);
    }
    let nextNum: u32 = atomicAdd(&nextBanned[0], 1u);
    atomicStore(&nextBanned[1u + nextNum * 2u], i);
    atomicStore(&nextBanned[1u + nextNum * 2u + 1u], t);
    atomicAdd(&changed[0], 1u);
  }
}
`;

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
  get stacksize_(): number { return this.stacksize; }
  get stackI_(): Uint16Array | Int32Array { return this.stackI; }
  get stackT_(): Uint8Array | Uint16Array | Int32Array { return this.stackT; }

  init_(): void { (this as any).init(); }
  clear_(): void { this.clear(); }
  ban_(i: number, t: number): void { this.ban(i, t); }
  propagate_(): boolean { return (this as any).propagate() as boolean; }
}



function normalizeToU32(src: Uint8Array | Uint16Array | Int32Array): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Number(src[i]) >>> 0;
  return out;
}

function normalizeCompatToI32(src: Uint8Array | Uint16Array | Int32Array): Int32Array {
  const out = new Int32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] | 0;
  return out;
}

function getInitialBanned(exposed: Exposed): Array<[number, number]> {
  const n = exposed.stacksize_;
  const sI = exposed.stackI_;
  const sT = exposed.stackT_;
  const list: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    list.push([Number(sI[k]), Number(sT[k])]);
  }
  return list;
}

// Use a cell-collapse (ban T-1 variants at one interior cell, like observe) as the
// 'trigger'. This produces a realistic multi-entry initial banned list + cascade work.
// State left post-bans/pre-prop. Matches the hot path in real solves.
function pickPropagatingTrigger(exposed: Exposed): [number, number] {
  const T = exposed.T_;
  const count = exposed.count_;
  const MX = (exposed as any).MX as number;
  const MY = (exposed as any).MY as number;
  const startI = Math.floor(MX / 2) + Math.floor(MY / 2) * MX;
  for (let off = 0; off < 32; off++) {
    const i = (startI + off * 7) % count; // spread a bit
    exposed.clear_();
    const wave = exposed.wave_;
    let kept = -1;
    let bannedCount = 0;
    for (let t = 0; t < T; t++) {
      if (wave[i * T + t] === 1) {
        if (kept < 0) kept = t;
        else { exposed.ban_(i, t); bannedCount++; }
      }
    }
    if (bannedCount >= 1 && kept >= 0) {
      return [i, kept];
    }
  }
  // last resort
  exposed.clear_();
  exposed.ban_(0, 0);
  return [0, 0];
}

interface GpuResult {
  finalWave: Uint8Array;
  timeMs: number;
  iters: number;
  maxBannedInFlight: number;
}

async function runGpuParallelAC4(
  device: GPUDevice,
  exposed: Exposed,
  initBannedList: Array<[number, number]>
): Promise<GpuResult> {
  const T = exposed.T_;
  const T4 = exposed.T4_;
  const count = exposed.count_;
  const initWaveU8 = exposed.wave_;
  const initCompatSrc = exposed.compatible_;
  const propDataU32 = normalizeToU32(exposed.propData_);
  const propStartU32 = normalizeToU32(exposed.propStart_);
  const propLenU32 = normalizeToU32(exposed.propLen_);
  const neighborsI32 = new Int32Array(exposed.neighbors_);

  const initWave = new Uint32Array(initWaveU8.length);
  for (let i = 0; i < initWaveU8.length; i++) initWave[i] = initWaveU8[i] ? 1 : 0;
  const initCompat = normalizeCompatToI32(initCompatSrc);

  const maxBans = count * T;
  const bannedBufSize = (1 + 2 * maxBans) * 4; // bytes

  // Buffers (storage)
  const waveBuffer = device.createBuffer({
    size: initWave.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  new Uint32Array(waveBuffer.getMappedRange()).set(initWave);
  waveBuffer.unmap();

  const compatBuffer = device.createBuffer({
    size: initCompat.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  new Int32Array(compatBuffer.getMappedRange()).set(initCompat);
  compatBuffer.unmap();

  const propDataBuf = device.createBuffer({
    size: propDataU32.byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Uint32Array(propDataBuf.getMappedRange()).set(propDataU32);
  propDataBuf.unmap();

  const propStartBuf = device.createBuffer({
    size: propStartU32.byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Uint32Array(propStartBuf.getMappedRange()).set(propStartU32);
  propStartBuf.unmap();

  const propLenBuf = device.createBuffer({
    size: propLenU32.byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Uint32Array(propLenBuf.getMappedRange()).set(propLenU32);
  propLenBuf.unmap();

  const neighborsBuf = device.createBuffer({
    size: neighborsI32.byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Int32Array(neighborsBuf.getMappedRange()).set(neighborsI32);
  neighborsBuf.unmap();

  const bannedA = device.createBuffer({
    size: bannedBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const bannedB = device.createBuffer({
    size: bannedBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });

  const changedBuf = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });

  const paramsData = new Uint32Array([T, T4, count, 0]);
  const paramsBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM,
    mappedAtCreation: true,
  });
  new Uint32Array(paramsBuf.getMappedRange()).set(paramsData);
  paramsBuf.unmap();

  // initial banned write (prefix only)
  const initBData = new Uint32Array(1 + 2 * initBannedList.length);
  initBData[0] = initBannedList.length;
  for (let k = 0; k < initBannedList.length; k++) {
    initBData[1 + k * 2] = initBannedList[k][0];
    initBData[1 + k * 2 + 1] = initBannedList[k][1];
  }
  device.queue.writeBuffer(bannedA, 0, initBData);

  // pipelines
  const applyModule = device.createShaderModule({ code: APPLY_WGSL });
  const applyPipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: applyModule, entryPoint: "main" },
  });

  const detectModule = device.createShaderModule({ code: DETECT_WGSL });
  const detectPipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: detectModule, entryPoint: "main" },
  });

  // stagings for small reads (count + changed)
  const stagingCount = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const stagingChanged = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // final wave staging
  const waveReadback = device.createBuffer({
    size: initWave.byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  let curBuf = bannedA;
  let nxtBuf = bannedB;
  let curCount = initBannedList.length;
  let iters = 0;
  let maxFlight = curCount;
  const t0 = performance.now();

  while (true) {
    iters++;
    // reset next + changed (bytes)
    device.queue.writeBuffer(nxtBuf, 0, new Uint32Array([0]));
    device.queue.writeBuffer(changedBuf, 0, new Uint32Array([0]));

    const enc = device.createCommandEncoder();

    // APPLY (if work)
    if (curCount > 0) {
      const bind = device.createBindGroup({
        layout: applyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: compatBuffer } },
          { binding: 1, resource: { buffer: propDataBuf } },
          { binding: 2, resource: { buffer: propStartBuf } },
          { binding: 3, resource: { buffer: propLenBuf } },
          { binding: 4, resource: { buffer: neighborsBuf } },
          { binding: 5, resource: { buffer: curBuf } },
          { binding: 6, resource: { buffer: paramsBuf } },
        ],
      });
      const pass = enc.beginComputePass();
      pass.setPipeline(applyPipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(curCount / 64));
      pass.end();
    }

    // DETECT (always full scan)
    const totalCellsT = count * T;
    const detectBind = device.createBindGroup({
      layout: detectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: waveBuffer } },
        { binding: 1, resource: { buffer: compatBuffer } },
        { binding: 2, resource: { buffer: nxtBuf } },
        { binding: 3, resource: { buffer: changedBuf } },
        { binding: 4, resource: { buffer: paramsBuf } },
      ],
    });
    const dpass = enc.beginComputePass();
    dpass.setPipeline(detectPipeline);
    dpass.setBindGroup(0, detectBind);
    dpass.dispatchWorkgroups(Math.ceil(totalCellsT / 64));
    dpass.end();

    // copy scalars for host decision
    enc.copyBufferToBuffer(nxtBuf, 0, stagingCount, 0, 4);
    enc.copyBufferToBuffer(changedBuf, 0, stagingChanged, 0, 4);

    device.queue.submit([enc.finish()]);

    // readback count + flag (serializing)
    await stagingCount.mapAsync(GPUMapMode.READ);
    const nextNum = new Uint32Array(stagingCount.getMappedRange())[0];
    stagingCount.unmap();

    await stagingChanged.mapAsync(GPUMapMode.READ);
    const ch = new Uint32Array(stagingChanged.getMappedRange())[0];
    stagingChanged.unmap();

    if (nextNum > maxFlight) maxFlight = nextNum;

    curCount = nextNum;
    // swap
    const tmp = curBuf;
    curBuf = nxtBuf;
    nxtBuf = tmp;

    if (ch === 0 && nextNum === 0) break;
    if (iters > 100000) break; // safety
  }

  const gpuTime = performance.now() - t0;

  // read final wave
  const encFinal = device.createCommandEncoder();
  encFinal.copyBufferToBuffer(waveBuffer, 0, waveReadback, 0, waveBuffer.size);
  device.queue.submit([encFinal.finish()]);

  await waveReadback.mapAsync(GPUMapMode.READ);
  const gpuWaveU32 = new Uint32Array(waveReadback.getMappedRange()).slice(0);
  waveReadback.unmap();

  const finalU8 = new Uint8Array(count * T);
  for (let k = 0; k < finalU8.length; k++) finalU8[k] = gpuWaveU32[k] ? 1 : 0;

  // cleanup (optional for throwaway)
  // (buffers GC'd)

  return { finalWave: finalU8, timeMs: gpuTime, iters, maxBannedInFlight: maxFlight };
}

async function testCorrectness(device: GPUDevice, tileset: Tileset, size: number): Promise<boolean> {
  console.log(`\n=== Q1 CORRECTNESS: knots-standard ${size}x${size} periodic ===`);
  const exposed = new Exposed({
    tileset,
    subsetName: "Standard",
    width: size,
    height: size,
    periodic: true,
    heuristic: Heuristic.MRV,
  });
  if (exposed.count_ === 0) (exposed as any).init();
  exposed.clear_();

  const [ti, tt] = pickPropagatingTrigger(exposed);
  console.log(`Picked propagating trigger: cell=${ti}, t=${tt}`);

  exposed.ban_(ti, tt);
  const initBanned = getInitialBanned(exposed);

  // CPU path
  const tCpu0 = performance.now();
  const cpuSuccess = exposed.propagate_();
  const cpuTime = performance.now() - tCpu0;
  const cpuWave = new Uint8Array(exposed.wave_); // post-prop

  // reset to identical pre-prop state
  exposed.clear_();
  exposed.ban_(ti, tt);

  // GPU path
  const gpuRes = await runGpuParallelAC4(device, exposed, initBanned);

  // compare waves
  let diffs = 0;
  const N = cpuWave.length;
  for (let k = 0; k < N; k++) {
    if (cpuWave[k] !== gpuRes.finalWave[k]) diffs++;
  }
  const match = diffs === 0;

  console.log(`CPU propagate: success=${cpuSuccess} time=${cpuTime.toFixed(3)}ms`);
  console.log(`GPU parallel:  iters=${gpuRes.iters} maxFlight=${gpuRes.maxBannedInFlight} time=${gpuRes.timeMs.toFixed(3)}ms`);
  console.log(`Wave match: ${match ? "YES" : "NO"} (diff cells*T slots: ${diffs}/${N})`);

  if (!match) {
    // dump a few diffs for debug
    let shown = 0;
    for (let k = 0; k < N && shown < 5; k++) {
      if (cpuWave[k] !== gpuRes.finalWave[k]) {
        const i = Math.floor(k / exposed.T_);
        const t = k % exposed.T_;
        console.log(`  first diff @ i=${i} t=${t}: cpu=${cpuWave[k]} gpu=${gpuRes.finalWave[k]}`);
        shown++;
      }
    }
  }
  return match;
}

async function measureCrossover(device: GPUDevice, tileset: Tileset): Promise<void> {
  console.log(`\n=== Q2 CROSSOVER: knots-standard (T=9) periodic, CPU vs GPU parallel-AC-4 ===`);
  const sizes = [24, 48, 128, 256];
  const results: Array<{ size: number; cpuMs: number; gpuMs: number; gpuIters: number; match: boolean }> = [];

  for (const sz of sizes) {
    const exposed = new Exposed({
      tileset,
      subsetName: "Standard",
      width: sz,
      height: sz,
      periodic: true,
      heuristic: Heuristic.MRV,
    });
    if (exposed.count_ === 0) (exposed as any).init();
    exposed.clear_();

    const [ti, tt] = pickPropagatingTrigger(exposed);
    exposed.ban_(ti, tt);
    const initB = getInitialBanned(exposed);

    // CPU time
    const t0 = performance.now();
    exposed.propagate_();
    const cpuMs = performance.now() - t0;
    const cpuWaveSnap = new Uint8Array(exposed.wave_);

    // reset + GPU
    exposed.clear_();
    exposed.ban_(ti, tt);
    const g = await runGpuParallelAC4(device, exposed, initB);

    // verify still match at this size
    let diffs = 0;
    for (let k = 0; k < cpuWaveSnap.length; k++) if (cpuWaveSnap[k] !== g.finalWave[k]) diffs++;
    const match = diffs === 0;

    results.push({ size: sz, cpuMs, gpuMs: g.timeMs, gpuIters: g.iters, match });
    console.log(
      `size ${sz}x${sz}: CPU=${cpuMs.toFixed(3)}ms | GPU=${g.timeMs.toFixed(3)}ms (iters=${g.iters}) match=${match}`
    );
  }

  console.log("\n--- Summary (wall ms, per trigger+propagate) ---");
  let crossover: number | null = null;
  for (const r of results) {
    const gpuWins = r.gpuMs < r.cpuMs;
    if (gpuWins && crossover === null) crossover = r.size;
    console.log(
      `${r.size}: cpu ${r.cpuMs.toFixed(2)}ms > gpu ${r.gpuMs.toFixed(2)}ms ? ${gpuWins ? "GPU WINS" : "CPU wins"} (match=${r.match})`
    );
  }
  console.log(
    crossover
      ? `Crossover: GPU first beats CPU at ${crossover}x${crossover}`
      : "GPU never wins (readback/dispatch overhead dominates in measured range)"
  );
}

async function main() {
  console.log("Setting up WebGPU (bun-webgpu)...");
  await setupGlobals();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter available");
  const device = await adapter.requestDevice();
  console.log("WebGPU device acquired.");

  const xml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const tileset = parseTileset(xml, "Knots");
  console.log(`Tileset loaded: Knots (Standard subset => T=9)`);

  const q1ok = await testCorrectness(device, tileset, 24);
  if (!q1ok) {
    console.error("\n!!! Q1 FAILED — correctness mismatch. Direction/index convention or ban/apply/detect logic bug.");
    // continue to Q2 for data, but verdict will note
  }

  await measureCrossover(device, tileset);

  console.log("\nPrototype complete. See report appended to OPTIMIZATION-LOG.md.");
  // device.destroy(); // optional
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
