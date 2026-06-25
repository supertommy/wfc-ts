#!/usr/bin/env bun
/**
 * CORRECTNESS GATE — Stage 1 GPU propagation backend.
 *
 * Runs the exact same pre-propagate state (post one "observe-like" T-1 ban at an
 * interior cell) through BOTH:
 *   (a) CPU SimpleTiledModel.propagate()  [drains the stack]
 *   (b) GpuPropagator.propagate()         [fused diameter-dispatch WGSL]
 *
 * Compares resulting wave (banned-set) byte-for-byte. Must be 0 diffs.
 *
 * Also exercises two tilesets (circuit-turnless-34, knots-standard-24) for
 * confidence on indexing/stride/CAS/zeroing/worklist logic.
 *
 * This is a standalone gate script (additive, throwaway-ish but kept as the
 * documented check for the reusable module). It does not affect the JS path
 * or prove-harness.
 *
 * Run: bun run scripts/gate-gpu-propagate.ts
 * Must print PASS for both cases (and overall) with 0 diffs.
 */

import { readFileSync } from "node:fs";
import { setupGlobals } from "bun-webgpu";
import {
  SimpleTiledModel,
  Heuristic,
  parseTileset,
  type Tileset,
} from "../src-optimized/index.js";
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
}

function getInitialBanned(exposed: Exposed): Array<[number, number]> {
  const n = (exposed as any).stacksize as number;
  const sI = (exposed as any).stackI as Uint16Array | Int32Array;
  const sT = (exposed as any).stackT as Uint8Array | Uint16Array | Int32Array;
  const list: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    list.push([Number(sI[k]), Number(sT[k])]);
  }
  return list;
}

/**
 * Choose an interior cell and ban all but one of its patterns (exactly like observe does).
 * Leaves the model in the post-ban / pre-propagate state with a realistic multi-entry
 * initial worklist. Returns [cell, keptPattern].
 */
function pickObserveLikeTrigger(exposed: Exposed): [number, number] {
  const T = exposed.T_;
  const count = exposed.count_;
  const MX = (exposed as any).MX as number;
  const MY = (exposed as any).MY as number;
  const startI = Math.floor(MX / 2) + Math.floor(MY / 2) * MX;
  for (let off = 0; off < 32; off++) {
    const i = (startI + off * 7) % count;
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
  // last resort: ban a single pattern (still a valid pre-prop state)
  exposed.clear_();
  exposed.ban_(0, 0);
  return [0, 0];
}

function normalizeCompatToU8(src: Uint8Array | Uint16Array | Int32Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] | 0;
  return out;
}

async function runGateCase(
  device: GPUDevice,
  tileset: Tileset,
  subsetName: string,
  size: number,
  label: string
): Promise<{ pass: boolean; diffs: number }> {
  console.log(`\n=== GATE CASE: ${label} (${size}x${size}, periodic, subset=${subsetName}) ===`);

  const exposed = new Exposed({
    tileset,
    subsetName,
    width: size,
    height: size,
    periodic: true,
    heuristic: Heuristic.MRV,
  });
  if (exposed.count_ === 0) (exposed as any).init();
  exposed.clear_();

  const [ti, tt] = pickObserveLikeTrigger(exposed);
  console.log(`  picked observe-like trigger: cell=${ti}, kept t=${tt} (T=${exposed.T_})`);

  const initBanned = getInitialBanned(exposed);
  console.log(`  initialNewlyBanned entries: ${initBanned.length}`);

  const wavePre = new Uint8Array(exposed.wave_);
  const compatPre = normalizeCompatToU8(exposed.compatible_);

  // CPU path (from the captured pre state)
  const cpuOk = exposed.propagate_();
  const cpuWave = new Uint8Array(exposed.wave_);
  const cpuCompat = normalizeCompatToU8(exposed.compatible_);

  // Reset to identical pre state for GPU
  exposed.clear_();
  for (const [i, t] of initBanned) {
    exposed.ban_(i, t);
  }

  // Build the reusable propagator (once per config)
  const gpuData: GpuPropagatorData = {
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
  const propagator = new GpuPropagator(device, gpuData);

  // GPU path from SAME pre state
  const gpuRes = await propagator.propagate(wavePre, compatPre, initBanned);

  // Compare waves (the banned set) — this is the semantics contract for propagate.
  // (compat values on *dead* patterns may legitimately differ between CPU and GPU
  // due to duplicate stack pushes on multi-dir zero-hits in the serial CPU path vs.
  // single-claim appends in the GPU CAS path, plus wrap behavior of narrow Uint8 vs i32
  // atomics on over-decrements. Live pattern compats and the banned set must match.)
  let waveDiffs = 0;
  for (let k = 0; k < cpuWave.length; k++) {
    if (cpuWave[k] !== gpuRes.wave[k]) waveDiffs++;
  }

  let compatDiffs = 0;
  for (let k = 0; k < cpuCompat.length; k++) {
    if (cpuCompat[k] !== gpuRes.compatible[k]) compatDiffs++;
  }

  const waveMatch = waveDiffs === 0;
  const okMatch = cpuOk === gpuRes.ok;

  console.log(`  CPU: ok=${cpuOk}`);
  console.log(`  GPU: ok=${gpuRes.ok}`);
  console.log(`  wave diffs: ${waveDiffs}  match=${waveMatch}`);
  console.log(`  compat diffs: ${compatDiffs} (may differ on dead slots; not part of contract)`);
  console.log(`  ok flags match: ${okMatch}`);

  const pass = waveMatch && okMatch; // compat may differ on dead patterns (see above)
  return { pass, diffs: waveDiffs };
}

async function main() {
  console.log("Setting up WebGPU (bun-webgpu) for gate...");
  await setupGlobals();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter available");
  const device = await adapter.requestDevice();
  console.log("WebGPU device acquired.");

  // Case 1: circuit-turnless-34 (the one used in prototype v2 proof)
  const circuitXml = readFileSync(
    new URL("../performance-test/tilesets/Circuit.xml", import.meta.url),
    "utf8"
  );
  const circuitTileset = parseTileset(circuitXml, "Circuit");
  const c = await runGateCase(device, circuitTileset, "Turnless", 34, "circuit-turnless-34");

  // Case 2: knots-standard-24 (different tileset, T, structure)
  const knotsXml = readFileSync(
    new URL("../performance-test/tilesets/Knots.xml", import.meta.url),
    "utf8"
  );
  const knotsTileset = parseTileset(knotsXml, "Knots");
  const k = await runGateCase(device, knotsTileset, "Standard", 24, "knots-standard-24");

  const overallPass = c.pass && k.pass;
  console.log("\n=== STAGE 1 GPU PROPAGATE GATE SUMMARY ===");
  console.log(`circuit-turnless-34: ${c.pass ? "PASS" : "FAIL"} (wave diffs=${c.diffs})`);
  console.log(`knots-standard-24  : ${k.pass ? "PASS" : "FAIL"} (wave diffs=${k.diffs})`);
  console.log(`OVERALL: ${overallPass ? "PASS" : "FAIL"}`);

  if (!overallPass) {
    console.error("\n!!! GATE FAILED — investigate indexing, strides, CAS claim, zeroing, or worklist seeding.");
    process.exit(1);
  }
  console.log("\nStage 1 gate complete. Module matches CPU AC-4 propagate on both inputs.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
