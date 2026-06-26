#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — H39 generated/specialized AC-4 propagation kernel.
 *
 * Tests whether the current propagation wall is partly JS genericity: property
 * access through `this`, dynamic `T/T4`, method call to ban(), and a small
 * direction loop. The generated kernel bakes T/T4, unrolls four directions, and
 * inlines the default MRV ban side effects (wave/compatible/stack/sums/dirty).
 *
 * Script-local only. If this does not beat current propagate() as a drain-only
 * kernel, do not promote generated code into src-optimized/.
 */

import { readFileSync } from "node:fs";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../helpers/index.js";

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

type IntArray = Uint8Array | Uint16Array | Int32Array;
type StackIArray = Uint16Array | Int32Array;
type StackTArray = Uint8Array | Uint16Array | Int32Array;
type DirtyArray = Uint16Array | Int32Array;

type GeneratedPropagate = (
  wave: Uint8Array,
  compatible: IntArray,
  sumsOfOnes: IntArray,
  stackI: StackIArray,
  stackT: StackTArray,
  stacksize: number,
  propData: IntArray,
  propStart: Uint16Array | Int32Array,
  propLen: IntArray,
  neighbors: Int32Array,
  dirtyHeapCells: DirtyArray,
) => { ok: boolean; stacksize: number; dirtyCount: number };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

function benchmarkMedian(fn: () => void | number, reps: number): number {
  const samples: number[] = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    const measured = fn();
    samples.push(typeof measured === "number" ? measured : performance.now() - t0);
  }
  return median(samples);
}

function liveCount(wave: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < wave.length; i++) n += wave[i];
  return n;
}

function diffWave(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function diffCounts(a: IntArray, b: IntArray): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function cloneIntArray<T extends IntArray>(src: T): T {
  if (src instanceof Uint8Array) return new Uint8Array(src) as T;
  if (src instanceof Uint16Array) return new Uint16Array(src) as T;
  return new Int32Array(src) as T;
}

function createLike<T extends IntArray>(src: T): T {
  if (src instanceof Uint8Array) return new Uint8Array(src.length) as T;
  if (src instanceof Uint16Array) return new Uint16Array(src.length) as T;
  return new Int32Array(src.length) as T;
}

function applyObserveKeep(model: Exposed, cell: number, kept: number): void {
  const T = model.T_;
  const base = cell * T;
  for (let t = 0; t < T; t++) if (t !== kept && model.wave_[base + t] === 1) model.ban_(cell, t);
}

function pickStrongObserveLikeTrigger(model: Exposed): [cell: number, kept: number, bans: number] {
  const T = model.T_;
  const MX = (model as any).MX as number;
  const MY = (model as any).MY as number;
  const cell = Math.floor(MX / 2) + Math.floor(MY / 2) * MX;
  let bestKept = -1;
  let bestBans = -1;
  for (let kept = 0; kept < T; kept++) {
    model.clear_();
    if (model.wave_[cell * T + kept] !== 1) continue;
    const before = liveCount(model.wave_);
    applyObserveKeep(model, cell, kept);
    model.propagate_();
    const bans = before - liveCount(model.wave_);
    if (bans > bestBans) {
      bestBans = bans;
      bestKept = kept;
    }
  }
  if (bestKept < 0) throw new Error("could not pick observe-like trigger");
  return [cell, bestKept, bestBans];
}

function snapshotStack(model: Exposed): { stackI: StackIArray; stackT: StackTArray; stacksize: number } {
  const n = model.stacksize_;
  const stackI = model.stackI_ instanceof Uint16Array ? new Uint16Array(model.stackI_.length) : new Int32Array(model.stackI_.length);
  const stackT = model.stackT_ instanceof Uint8Array
    ? new Uint8Array(model.stackT_.length)
    : model.stackT_ instanceof Uint16Array
      ? new Uint16Array(model.stackT_.length)
      : new Int32Array(model.stackT_.length);
  stackI.set(model.stackI_);
  stackT.set(model.stackT_);
  return { stackI, stackT, stacksize: n };
}

function makeDirtyBuffer(model: Exposed): DirtyArray {
  const cap = model.count_ * model.T_;
  return model.count_ < 65536 ? new Uint16Array(cap) : new Int32Array(cap);
}

function dirBlock(d: number, T: number, T4: number): string {
  const keyExpr = d === 0 ? "t1" : `${d * T} + t1`;
  return `
      {
        const i2 = neighbors[i1 * 4 + ${d}];
        if (i2 >= 0) {
          const key = ${keyExpr};
          const start = propStart[key];
          const len = propLen[key];
          const base2 = i2 * ${T4};
          for (let l = 0; l < len; l++) {
            const t2 = propData[start + l];
            const cidx = base2 + t2 * 4 + ${d};
            if (--compatible[cidx] === 0) {
              const widx = i2 * ${T} + t2;
              wave[widx] = 0;
              const cbase = i2 * ${T4} + t2 * 4;
              compatible[cbase] = 0;
              compatible[cbase + 1] = 0;
              compatible[cbase + 2] = 0;
              compatible[cbase + 3] = 0;
              stackI[stacksize] = i2;
              stackT[stacksize] = t2;
              stacksize++;
              sumsOfOnes[i2] -= 1;
              dirtyHeapCells[dirtyCount++] = i2;
            }
          }
        }
      }`;
}

function makeGeneratedPropagate(T: number, T4: number): GeneratedPropagate {
  const body = `
    "use strict";
    return function generatedPropagate(wave, compatible, sumsOfOnes, stackI, stackT, stacksize, propData, propStart, propLen, neighbors, dirtyHeapCells) {
      let dirtyCount = 0;
      while (stacksize > 0) {
        stacksize--;
        const i1 = stackI[stacksize];
        const t1 = stackT[stacksize];
        ${dirBlock(0, T, T4)}
        ${dirBlock(1, T, T4)}
        ${dirBlock(2, T, T4)}
        ${dirBlock(3, T, T4)}
      }
      return { ok: sumsOfOnes[0] > 0, stacksize, dirtyCount };
    };
  `;
  return new Function(body)() as GeneratedPropagate;
}

async function runCase(tileset: Tileset, subsetName: string | null, size: number, label: string, reps: number): Promise<void> {
  const model = new Exposed({ tileset, subsetName, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (model.count_ === 0) model.init_();
  const [cell, kept, expectedBans] = pickStrongObserveLikeTrigger(model);
  const gen = makeGeneratedPropagate(model.T_, model.T4_);

  model.clear_();
  applyObserveKeep(model, cell, kept);
  const preWave = new Uint8Array(model.wave_);
  const preCompat = cloneIntArray(model.compatible_);
  const preSums = cloneIntArray(model.sumsOfOnes_);
  const initial = snapshotStack(model);
  const before = liveCount(preWave);

  const wave = new Uint8Array(preWave);
  const compatible = cloneIntArray(preCompat);
  const sums = cloneIntArray(preSums);
  const stackI = initial.stackI instanceof Uint16Array ? new Uint16Array(initial.stackI) : new Int32Array(initial.stackI);
  const stackT = initial.stackT instanceof Uint8Array ? new Uint8Array(initial.stackT) : initial.stackT instanceof Uint16Array ? new Uint16Array(initial.stackT) : new Int32Array(initial.stackT);
  const dirty = makeDirtyBuffer(model);
  const genResult = gen(wave, compatible, sums, stackI, stackT, initial.stacksize, model.propData_, model.propStart_, model.propLen_, model.neighbors_, dirty);

  const cpuOk = model.propagate_();
  const cpuWave = new Uint8Array(model.wave_);
  const cpuSums = cloneIntArray(model.sumsOfOnes_);
  const after = liveCount(cpuWave);
  const waveDiffs = diffWave(cpuWave, wave);
  const sumsDiffs = diffCounts(cpuSums, sums);

  const cpuPropMs = benchmarkMedian(() => {
    model.clear_();
    applyObserveKeep(model, cell, kept);
    const t0 = performance.now();
    model.propagate_();
    return performance.now() - t0;
  }, reps);

  const reusableWave = new Uint8Array(preWave.length);
  const reusableCompat = createLike(preCompat);
  const reusableSums = createLike(preSums);
  const reusableStackI = initial.stackI instanceof Uint16Array ? new Uint16Array(initial.stackI.length) : new Int32Array(initial.stackI.length);
  const reusableStackT = initial.stackT instanceof Uint8Array ? new Uint8Array(initial.stackT.length) : initial.stackT instanceof Uint16Array ? new Uint16Array(initial.stackT.length) : new Int32Array(initial.stackT.length);
  const reusableDirty = makeDirtyBuffer(model);

  const genDrainMs = benchmarkMedian(() => {
    reusableWave.set(preWave);
    reusableCompat.set(preCompat);
    reusableSums.set(preSums);
    reusableStackI.set(initial.stackI);
    reusableStackT.set(initial.stackT);
    const t0 = performance.now();
    gen(reusableWave, reusableCompat, reusableSums, reusableStackI, reusableStackT, initial.stacksize, model.propData_, model.propStart_, model.propLen_, model.neighbors_, reusableDirty);
    return performance.now() - t0;
  }, reps);

  const genResetMs = benchmarkMedian(() => {
    reusableWave.set(preWave);
    reusableCompat.set(preCompat);
    reusableSums.set(preSums);
    reusableStackI.set(initial.stackI);
    reusableStackT.set(initial.stackT);
    gen(reusableWave, reusableCompat, reusableSums, reusableStackI, reusableStackT, initial.stacksize, model.propData_, model.propStart_, model.propLen_, model.neighbors_, reusableDirty);
  }, reps);

  const removed = before - after;
  console.log(`${label.padEnd(22)} | ${String(size).padStart(4)} | ${String(cell).padStart(5)} | ${String(kept).padStart(4)} | ${String(initial.stacksize).padStart(5)} | ${String(expectedBans).padStart(7)} | ${String(removed).padStart(7)} | ${cpuPropMs.toFixed(4).padStart(8)} | ${genDrainMs.toFixed(4).padStart(8)} | ${genResetMs.toFixed(4).padStart(8)} | ${String(genResult.dirtyCount).padStart(5)} | ${String(waveDiffs).padStart(5)} | ${String(sumsDiffs).padStart(5)} | ${cpuOk && genResult.ok ? "ok" : "bad"}`);
}

async function main(): Promise<void> {
  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const knotsXml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const knots = parseTileset(knotsXml, "Knots");
  const roomsXml = readFileSync(new URL("../performance-test/tilesets/Rooms.xml", import.meta.url), "utf8");
  const rooms = parseTileset(roomsXml, "Rooms");
  const reps = Number(process.env.REPS ?? 300);

  console.log("=== CPU H39 GENERATED PROPAGATE KERNEL PROTOTYPE ===");
  console.log(`median reps=${reps}; genDrain excludes reset like a promoted in-place kernel; genReset includes typed-array reset`);
  console.log("case                   | size |  cell | keep | stack | bestBan | removed | cpuProp | genDrain | genReset | dirty | wDiff | sDiff | ok");
  console.log("-----------------------|------|-------|------|-------|---------|---------|---------|----------|----------|-------|-------|-------|----");
  await runCase(knots, "Standard", 48, "knots-standard", reps);
  await runCase(circuit, "Turnless", 34, "circuit-turnless", reps);
  await runCase(rooms, null, 30, "rooms", reps);
  await runCase(circuit, "Turnless", 128, "circuit-turnless", reps);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
