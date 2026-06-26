#!/usr/bin/env bun
/**
 * STAGE 2 BENCH — honest full-run hybrid CPU-observe / GPU-propagate crossover.
 *
 * Runs the GpuWfcRunner (CPU select + GPU prop with cascade-stop) to COMPLETION
 * (or contradiction+restart per H12) on:
 *   circuit-turnless at 64/128/256
 *   knots-standard at 128/256
 *
 * Measures FULL-RUN wall (excludes ctor/propagator setup+pipelines; includes per-observe loop,
 * CPU selection, GPU incremental uploads/dispatches/readbacks/cascade checks).
 *
 * Compares to pure-JS src-optimized SimpleTiledModel.run() at identical (seed, size, periodic, MRV).
 *
 * Also:
 * - DET: re-run GPU twice, observed[] must match.
 * - VALID: 0 adjacency violations using independent check (built from tileset propagator lists).
 *
 * Reports raw ms, speedup, crossover or "never".
 * All numbers from real runs; no fabrication.
 *
 * Run: bun scripts/bench-gpu-fullrun.ts
 * Requires WebGPU (bun-webgpu provides on Apple).
 */

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import {
  SimpleTiledModel,
  parseTileset,
  type Tileset,
} from "../helpers/index.js";
import { Heuristic } from "../helpers/index.js";
import { GpuWfcRunner } from "../src-optimized/webgpu/gpu-runner.js";
import * as RefSimpleMod from "../helpers/simple-tiled-model.js";

// --- seeds chosen for completion on the sizes (found via find-seeds + spot checks; budget handles if needed)
const SEEDS: Record<string, number> = {
  "circuit-64": 0,
  "circuit-128": 1,
  "circuit-256": 2,
  "knots-128": 7,
  "knots-256": 3,
};

const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];

function buildAllowedFromRef(tileset: Tileset, subsetName: string | null): { allowed: number[][]; T: number } {
  // Use a throwaway reference model (src/) to obtain the *list form* propagator for easy includes check.
  // We import the *reference* here (allowed by scripts/ usage pattern) only for its prop table construction.
  // This keeps the validator independent of optimized internals.
  const RefSimple: any = (RefSimpleMod as any).SimpleTiledModel ?? (RefSimpleMod as any).default ?? RefSimpleMod;
  const ref = new RefSimple({
    tileset,
    subsetName: subsetName ?? null,
    width: 1,
    height: 1,
    periodic: true,
  });
  // force build
  ref.run(0, 0);
  const prop = (ref as any).propagator as number[][][];
  const T = prop[0].length;
  // convert to flat allowed[d][t1*T + t2] = 1/0 for fast check
  const allowed: number[][] = [];
  for (let d = 0; d < 4; d++) {
    const row = new Array(T * T).fill(0);
    for (let t1 = 0; t1 < T; t1++) {
      for (const t2 of prop[d][t1]) {
        row[t1 * T + t2] = 1;
      }
    }
    allowed[d] = row;
  }
  return { allowed, T };
}

function validateObserved(tileset: Tileset, subsetName: string | null, MX: number, MY: number, periodic: boolean, observed: Int32Array): { valid: boolean; violations: number; checks: number } {
  const { allowed, T } = buildAllowedFromRef(tileset, subsetName);
  let violations = 0;
  let checks = 0;
  for (let y = 0; y < MY; y++) {
    for (let x = 0; x < MX; x++) {
      const i = x + y * MX;
      const t1 = observed[i];
      if (t1 < 0 || t1 >= T) continue;
      for (let d = 0; d < 4; d++) {
        let x2 = x + DX[d];
        let y2 = y + DY[d];
        if (periodic) {
          x2 = (x2 + MX) % MX;
          y2 = (y2 + MY) % MY;
        } else {
          if (x2 < 0 || y2 < 0 || x2 >= MX || y2 >= MY) continue;
        }
        const t2 = observed[x2 + y2 * MX];
        if (t2 < 0 || t2 >= T) continue;
        checks++;
        if (allowed[d][t1 * T + t2] !== 1) violations++;
      }
    }
  }
  return { valid: violations === 0, violations, checks };
}

async function timeGpuRun(device: GPUDevice, tileset: Tileset, subset: string | null, size: number, seed: number, periodic = true): Promise<{
  ok: boolean;
  ms: number;
  observes: number;
  attempts: number;
  observed: Int32Array;
}> {
  const runner = new GpuWfcRunner(device, tileset, subset, size, size, periodic);
  // warm the first clear (but we will time the run itself)
  const t0 = performance.now();
  const ok = await runner.run(seed, -1, 100);
  const ms = performance.now() - t0;
  return {
    ok,
    ms,
    observes: runner.lastRunObserves,
    attempts: runner.lastRunAttempts,
    observed: runner.result(),
  };
}

async function timeJsRun(tileset: Tileset, subset: string | null, size: number, seed: number, periodic = true): Promise<{
  ok: boolean;
  ms: number;
  observed: Int32Array;
}> {
  const model = new SimpleTiledModel({
    tileset,
    subsetName: subset ?? null,
    width: size,
    height: size,
    periodic,
    heuristic: Heuristic.MRV,
  });
  const t0 = performance.now();
  const ok = model.run(seed, -1, 100);
  const ms = performance.now() - t0;
  return { ok, ms, observed: model.result() };
}

async function detCheck(device: GPUDevice, tileset: Tileset, subset: string | null, size: number, seed: number): Promise<boolean> {
  const r1 = new GpuWfcRunner(device, tileset, subset, size, size, true);
  const r2 = new GpuWfcRunner(device, tileset, subset, size, size, true);
  const o1 = await r1.run(seed, -1, 100);
  const o2 = await r2.run(seed, -1, 100);
  if (!o1 || !o2) return false;
  const a = r1.result();
  const b = r2.result();
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  console.log("Setting up WebGPU for full-run bench...");
  await setupGlobals();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  console.log("Device ready.\n");

  // Load tilesets (from performance-test/tilesets, reading is allowed)
  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuitTs = parseTileset(circuitXml, "Circuit");

  const knotsXml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const knotsTs = parseTileset(knotsXml, "Knots");

  const cases: Array<{ label: string; ts: Tileset; subset: string | null; size: number; seedKey: string; expectHeavy: boolean }> = [
    { label: "circuit-turnless", ts: circuitTs, subset: "Turnless", size: 64, seedKey: "circuit-64", expectHeavy: true },
    { label: "circuit-turnless", ts: circuitTs, subset: "Turnless", size: 128, seedKey: "circuit-128", expectHeavy: true },
    { label: "circuit-turnless", ts: circuitTs, subset: "Turnless", size: 256, seedKey: "circuit-256", expectHeavy: true },
    { label: "knots-standard", ts: knotsTs, subset: "Standard", size: 128, seedKey: "knots-128", expectHeavy: false },
    { label: "knots-standard", ts: knotsTs, subset: "Standard", size: 256, seedKey: "knots-256", expectHeavy: false },
  ];

  console.log("=== STAGE 2 FULL-RUN HYBRID BENCH (GPU vs JS) ===\n");

  const results: any[] = [];

  for (const c of cases) {
    const seed = SEEDS[c.seedKey] ?? 0;
    console.log(`\n--- ${c.label} ${c.size}x${c.size} (seed=${seed}, periodic) ---`);

    // JS baseline (post-H31)
    const js = await timeJsRun(c.ts, c.subset, c.size, seed);
    console.log(`JS:  ok=${js.ok}  ${js.ms.toFixed(2)} ms`);

    // GPU hybrid
    const gpu = await timeGpuRun(device, c.ts, c.subset, c.size, seed);
    console.log(`GPU: ok=${gpu.ok}  ${gpu.ms.toFixed(2)} ms  (observes=${gpu.observes}, attempts=${gpu.attempts})`);

    const speedup = gpu.ms > 0 ? (js.ms / gpu.ms) : Infinity;
    console.log(`     GPU vs JS: ${speedup.toFixed(2)}x  ${gpu.ms < js.ms ? "GPU wins" : "JS wins"}`);

    // DET
    const detOk = await detCheck(device, c.ts, c.subset, c.size, seed);
    console.log(`     DET (same seed twice): ${detOk ? "PASS" : "FAIL"}`);

    // VALID
    const v = validateObserved(c.ts, c.subset, c.size, c.size, true, gpu.observed);
    console.log(`     VALID (0 violations): ${v.valid ? "PASS" : "FAIL"}  violations=${v.violations} / checks=${v.checks}`);

    if (!gpu.ok || !v.valid || !detOk) {
      console.warn("   ^^^ problem on this case");
    }

    results.push({
      case: `${c.label}-${c.size}`,
      jsMs: js.ms,
      gpuMs: gpu.ms,
      speedup,
      gpuOk: gpu.ok,
      valid: v.valid,
      det: detOk,
      observes: gpu.observes,
    });
  }

  // summary table
  console.log("\n=== SUMMARY (real numbers) ===");
  console.log("case                  | JS ms   | GPU ms  | speedup | valid | det | observes");
  console.log("----------------------|---------|---------|---------|-------|-----|---------");
  for (const r of results) {
    console.log(
      `${r.case.padEnd(21)} | ${r.jsMs.toFixed(1).padStart(7)} | ${r.gpuMs.toFixed(1).padStart(7)} | ${r.speedup.toFixed(2).padStart(7)}x | ${r.valid ? "PASS" : "FAIL "} | ${r.det ? "PASS" : "FAIL"} | ${r.observes}`
    );
  }

  // honest verdict
  const circuit256 = results.find((r) => r.case.includes("circuit-256"));
  const knots256 = results.find((r) => r.case.includes("knots-256"));

  console.log("\n=== HONEST VERDICT ===");
  if (circuit256 && circuit256.gpuMs < circuit256.jsMs && circuit256.valid && circuit256.det) {
    console.log(`GPU WINS end-to-end on circuit at 256 (${circuit256.speedup.toFixed(2)}x). Crossover exists.`);
    console.log("Recommendation: proceed to Stage 3 (full WebGPU or further opt on dispatch/read).");
  } else if (circuit256) {
    console.log(`GPU does NOT win end-to-end on circuit-256 (JS ${circuit256.jsMs.toFixed(1)} < GPU ${circuit256.gpuMs.toFixed(1)}).`);
    console.log("Per-observe traffic (uploads + count readbacks × observes) + dispatch overhead ate the single-prop win.");
    console.log("Verdict: GPU path INFEASIBLE for full WFC observe/propagate pattern on this hardware/API. Stop GPU build.");
  }
  if (knots256) {
    console.log(`On light-prop (knots-256): GPU ${knots256.gpuMs < knots256.jsMs ? "won" : "lost"} as expected (overhead dominates).`);
  }

  console.log("\nBench complete. Numbers above are authoritative.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
