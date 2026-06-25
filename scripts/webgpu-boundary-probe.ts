#!/usr/bin/env bun
/**
 * WebGPU boundary-crossing feasibility probe.
 *
 * Answers two questions before building a full GPU WFC solve:
 * 1. How expensive are many dispatches with one final readback (no per-step mapAsync)?
 * 2. Does a simple cross-workgroup atomic barrier complete on this WebGPU backend, or
 *    does it hang/deadlock (a prerequisite risk for a persistent mega-kernel)?
 *
 * This is intentionally not imported by the library.
 */

import { setupGlobals } from "bun-webgpu";

const MANY_DISPATCHES_WGSL = `
@group(0) @binding(0) var<storage, read_write> out: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x == 0u) {
    atomicAdd(&out[0], 1u);
  }
}
`;

const BARRIER_WGSL = `
@group(0) @binding(0) var<storage, read_write> state: array<atomic<u32>>;
// state[0] = arrived, state[1] = generation, state[2] = completed, state[3] = checksum
@group(0) @binding(1) var<uniform> params: vec4<u32>; // [workgroups, rounds, spinsPerWait, 0]

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  if (lid.x != 0u) { return; }
  let numWg = params[0];
  let rounds = params[1];
  let spinBudget = params[2];
  for (var r: u32 = 0u; r < rounds; r = r + 1u) {
    let gen = atomicLoad(&state[1]);
    let prev = atomicAdd(&state[0], 1u);
    if (prev + 1u == numWg) {
      atomicStore(&state[0], 0u);
      atomicAdd(&state[3], 1u);
      atomicStore(&state[1], gen + 1u);
    } else {
      var spins: u32 = 0u;
      loop {
        if (atomicLoad(&state[1]) != gen) { break; }
        spins = spins + 1u;
        if (spins > spinBudget) {
          // Do not spin forever in the probe: mark timeout-ish and return.
          atomicStore(&state[2], 0xBAD0BAD0u);
          return;
        }
      }
    }
  }
  atomicAdd(&state[2], 1u);
}
`;

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

async function getDevice(): Promise<GPUDevice> {
  setupGlobals();
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  console.log("adapter", adapter.info ?? "(no adapter info)");
  console.log("limits", {
    maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
    maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
    maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
  });
  return await adapter.requestDevice();
}

async function manyDispatches(device: GPUDevice, dispatches: number): Promise<void> {
  const module = device.createShaderModule({ code: MANY_DISPATCHES_WGSL });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const out = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const read = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(out, 0, new Uint32Array([0]));
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: out } }] });

  const encodeStart = performance.now();
  const enc = device.createCommandEncoder();
  for (let i = 0; i < dispatches; i++) {
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(1);
    pass.end();
  }
  enc.copyBufferToBuffer(out, 0, read, 0, 4);
  const cmd = enc.finish();
  const encodeMs = performance.now() - encodeStart;

  const runStart = performance.now();
  device.queue.submit([cmd]);
  await read.mapAsync(GPUMapMode.READ);
  const got = new Uint32Array(read.getMappedRange())[0];
  read.unmap();
  const runMs = performance.now() - runStart;
  console.log("many-dispatches", { dispatches, encodeMs: +encodeMs.toFixed(3), submitToReadMs: +runMs.toFixed(3), got });
}

async function barrierProbe(device: GPUDevice, workgroups: number, rounds: number): Promise<void> {
  const module = device.createShaderModule({ code: BARRIER_WGSL });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const state = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(state, 0, new Uint32Array([0, 0, 0, 0]));
  // Big enough to allow real waits, finite so the probe reports instead of hanging forever.
  device.queue.writeBuffer(params, 0, new Uint32Array([workgroups, rounds, 50_000_000, 0]));
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: state } },
      { binding: 1, resource: { buffer: params } },
    ],
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(workgroups);
  pass.end();
  enc.copyBufferToBuffer(state, 0, read, 0, 16);
  const start = performance.now();
  device.queue.submit([enc.finish()]);
  await withTimeout(read.mapAsync(GPUMapMode.READ), 5000, `barrier ${workgroups}wg/${rounds}r`);
  const got = Array.from(new Uint32Array(read.getMappedRange()).slice(0));
  read.unmap();
  const ms = performance.now() - start;
  console.log("barrier", { workgroups, rounds, ms: +ms.toFixed(3), state: got });
}

async function main(): Promise<void> {
  const device = await getDevice();
  for (const n of [1_000, 10_000, 50_000]) {
    await manyDispatches(device, n);
  }
  for (const wg of [1, 2, 4, 8, 16, 32, 64]) {
    await barrierProbe(device, wg, 100);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
