#!/usr/bin/env bun
/**
 * WebGPU crossover gate for ratchet candidates.
 *
 * Purpose: every GPU hypothesis gets measured against the same large-grid bar:
 * VALID + DET, wall time vs optimized JS, and concrete WebGPU boundary crossings.
 *
 * It can sweep the existing Stage 2 hybrid CPU-observe/GPU-propagate runner across
 * fixed propagation epoch sizes. Future no-spin prototypes should plug into the same
 * Candidate shape instead of inventing bespoke measurement scripts.
 *
 * Default run is intentionally one heavy large case (circuit-turnless-128) so the
 * ratchet loop can run frequently. Pass --sizes=128,256 for a wider check.
 */

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../helpers/index.js";
import { GpuWfcRunner } from "../src-optimized/webgpu/gpu-runner.js";
import * as RefSimpleMod from "../helpers/simple-tiled-model.js";

const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];

interface BoundaryMetrics {
  writeBufferCalls: number;
  writeBufferBytes: number;
  submitCalls: number;
  submittedCommandBuffers: number;
  mapAsyncCalls: number;
}

interface TimedRun {
  ok: boolean;
  ms: number;
  observed: Int32Array;
  observes?: number;
  attempts?: number;
  metrics?: BoundaryMetrics;
}

interface Candidate {
  name: string;
  run(device: GPUDevice, tileset: Tileset, subset: string | null, size: number, seed: number): Promise<TimedRun>;
}

function parseNumberList(flag: string, fallback: number[]): number[] {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return fallback;
  const values = arg.slice(flag.length + 1).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) throw new Error(`${flag} must contain at least one positive integer`);
  return values;
}

function parseSizes(): number[] {
  return parseNumberList("--sizes", [128]);
}

function parseEpochs(): number[] {
  return parseNumberList("--epochs", [8]);
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

function validateObserved(tileset: Tileset, subsetName: string | null, MX: number, MY: number, periodic: boolean, observed: Int32Array): { valid: boolean; violations: number; unresolved: number; checks: number } {
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
        let x2 = x + DX[d];
        let y2 = y + DY[d];
        if (periodic) {
          x2 = (x2 + MX) % MX;
          y2 = (y2 + MY) % MY;
        } else if (x2 < 0 || y2 < 0 || x2 >= MX || y2 >= MY) {
          continue;
        }
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

async function timeJsRun(tileset: Tileset, subset: string | null, size: number, seed: number): Promise<TimedRun> {
  const model = new SimpleTiledModel({
    tileset,
    subsetName: subset ?? null,
    width: size,
    height: size,
    periodic: true,
    heuristic: Heuristic.MRV,
  });
  const t0 = performance.now();
  const ok = model.run(seed, -1, 100);
  const ms = performance.now() - t0;
  return { ok, ms, observed: model.result() };
}

function sameObserved(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function instrumentDevice<T>(device: GPUDevice, fn: () => Promise<T>): Promise<{ result: T; metrics: BoundaryMetrics }> {
  const metrics: BoundaryMetrics = {
    writeBufferCalls: 0,
    writeBufferBytes: 0,
    submitCalls: 0,
    submittedCommandBuffers: 0,
    mapAsyncCalls: 0,
  };

  const queue = device.queue as unknown as {
    writeBuffer: GPUQueue["writeBuffer"];
    submit: GPUQueue["submit"];
  };
  const originalWriteBuffer = queue.writeBuffer.bind(device.queue);
  const originalSubmit = queue.submit.bind(device.queue);

  const sample = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bufferProto = Object.getPrototypeOf(sample) as { mapAsync: GPUBuffer["mapAsync"] };
  const originalMapAsync = bufferProto.mapAsync;

  queue.writeBuffer = ((buffer: GPUBuffer, bufferOffset: number, data: any, dataOffset?: number, size?: number) => {
    metrics.writeBufferCalls++;
    const byteLength = typeof data?.byteLength === "number" ? data.byteLength : 0;
    metrics.writeBufferBytes += size ?? Math.max(0, byteLength - (dataOffset ?? 0));
    return originalWriteBuffer(buffer, bufferOffset, data, dataOffset as any, size as any);
  }) as GPUQueue["writeBuffer"];

  queue.submit = ((commandBuffers: Iterable<GPUCommandBuffer>) => {
    metrics.submitCalls++;
    const submitted = Array.isArray(commandBuffers) ? commandBuffers.length : Array.from(commandBuffers).length;
    metrics.submittedCommandBuffers += submitted;
    return originalSubmit(commandBuffers);
  }) as GPUQueue["submit"];

  bufferProto.mapAsync = (function (this: GPUBuffer, ...args: Parameters<GPUBuffer["mapAsync"]>) {
    metrics.mapAsyncCalls++;
    return originalMapAsync.apply(this, args);
  }) as GPUBuffer["mapAsync"];

  return fn().then(
    (result) => {
      queue.writeBuffer = originalWriteBuffer as GPUQueue["writeBuffer"];
      queue.submit = originalSubmit as GPUQueue["submit"];
      bufferProto.mapAsync = originalMapAsync;
      return { result, metrics };
    },
    (error) => {
      queue.writeBuffer = originalWriteBuffer as GPUQueue["writeBuffer"];
      queue.submit = originalSubmit as GPUQueue["submit"];
      bufferProto.mapAsync = originalMapAsync;
      throw error;
    }
  );
}

function makeHybridCandidate(epoch: number): Candidate {
  return {
    name: `hybrid-fixed-epoch-${epoch}`,
    async run(device, tileset, subset, size, seed) {
      const runner = new GpuWfcRunner(device, tileset, subset, size, size, true, epoch);
      const { result, metrics } = await instrumentDevice(device, async () => {
        const t0 = performance.now();
        const ok = await runner.run(seed, -1, 100);
        const ms = performance.now() - t0;
        return {
          ok,
          ms,
          observed: runner.result(),
          observes: runner.lastRunObserves,
          attempts: runner.lastRunAttempts,
        } satisfies TimedRun;
      });
      return { ...result, metrics };
    },
  };
}

async function detCheck(candidate: Candidate, device: GPUDevice, tileset: Tileset, subset: string | null, size: number, seed: number): Promise<boolean> {
  const a = await candidate.run(device, tileset, subset, size, seed);
  const b = await candidate.run(device, tileset, subset, size, seed);
  return a.ok && b.ok && sameObserved(a.observed, b.observed);
}

async function main(): Promise<void> {
  await setupGlobals();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const sizes = parseSizes();
  const epochs = parseEpochs();
  const seeds = new Map<number, number>([[64, 0], [128, 1], [256, 2], [512, 3]]);
  const candidates: Candidate[] = epochs.map(makeHybridCandidate);

  console.log("=== WEBGPU LARGE-GRID CROSSOVER GATE ===");
  console.log(`cases: circuit-turnless sizes=${sizes.join(",")} epochs=${epochs.join(",")} periodic=true`);
  console.log("candidate                         | size | JS ms   | GPU ms   | speedup | valid | det  | observes | writeBuffer | submit | mapAsync");
  console.log("----------------------------------|------|---------|----------|---------|-------|------|----------|-------------|--------|---------");

  for (const size of sizes) {
    const seed = seeds.get(size) ?? 0;
    const js = await withTimeout(timeJsRun(circuit, "Turnless", size, seed), 30_000, `JS circuit-${size}`);
    for (const candidate of candidates) {
      const gpu = await withTimeout(candidate.run(device, circuit, "Turnless", size, seed), 120_000, `${candidate.name} circuit-${size}`);
      const valid = validateObserved(circuit, "Turnless", size, size, true, gpu.observed);
      const det = await withTimeout(detCheck(candidate, device, circuit, "Turnless", size, seed), 120_000, `${candidate.name} det circuit-${size}`);
      const speedup = gpu.ms > 0 ? js.ms / gpu.ms : Infinity;
      const m = gpu.metrics;
      console.log(
        `${candidate.name.padEnd(33)} | ${String(size).padStart(4)} | ${js.ms.toFixed(1).padStart(7)} | ${gpu.ms.toFixed(1).padStart(8)} | ${speedup.toFixed(3).padStart(7)}x | ${valid.valid ? "PASS" : "FAIL"} | ${det ? "PASS" : "FAIL"} | ${String(gpu.observes ?? 0).padStart(8)} | ${String(m?.writeBufferCalls ?? 0).padStart(11)} | ${String(m?.submitCalls ?? 0).padStart(6)} | ${String(m?.mapAsyncCalls ?? 0).padStart(7)}`
      );
      if (!gpu.ok || !valid.valid || !det) {
        console.log(`  detail: ok=${gpu.ok} violations=${valid.violations} unresolved=${valid.unresolved} attempts=${gpu.attempts ?? 0}`);
      }
      if (m) {
        console.log(`  boundary: writeBufferBytes=${m.writeBufferBytes} submittedCommandBuffers=${m.submittedCommandBuffers}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
