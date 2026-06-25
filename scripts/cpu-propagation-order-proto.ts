#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — H40 propagation work ordering.
 *
 * Tests whether changing only the order of pending AC-4 bans improves cache
 * locality: current LIFO, FIFO, and direction-order variants. The transition is
 * intentionally the same support-count decrement + ban side effects. This is
 * script-local and does not touch the shippable solver.
 */

import { readFileSync } from "node:fs";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../src-optimized/index.js";

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
type StackMode = "lifo" | "fifo";

interface Variant {
  readonly name: string;
  readonly mode: StackMode;
  readonly dirs: readonly number[];
}

interface Snapshot {
  readonly wave: Uint8Array;
  readonly compatible: IntArray;
  readonly sums: IntArray;
  readonly stackI: Int32Array;
  readonly stackT: Int32Array;
  readonly stacksize: number;
}

interface OrderedResult {
  readonly wave: Uint8Array;
  readonly sums: IntArray;
  readonly processed: number;
  readonly pushed: number;
  readonly ok: boolean;
}

const VARIANTS: readonly Variant[] = [
  { name: "lifo-0123", mode: "lifo", dirs: [0, 1, 2, 3] },
  { name: "fifo-0123", mode: "fifo", dirs: [0, 1, 2, 3] },
  { name: "lifo-3210", mode: "lifo", dirs: [3, 2, 1, 0] },
  { name: "fifo-3210", mode: "fifo", dirs: [3, 2, 1, 0] },
  { name: "lifo-1032", mode: "lifo", dirs: [1, 0, 3, 2] },
  { name: "fifo-1032", mode: "fifo", dirs: [1, 0, 3, 2] },
];

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

function snapshot(model: Exposed): Snapshot {
  const n = model.stacksize_;
  const stackI = new Int32Array(model.count_ * model.T_);
  const stackT = new Int32Array(model.count_ * model.T_);
  for (let k = 0; k < n; k++) {
    stackI[k] = model.stackI_[k];
    stackT[k] = model.stackT_[k];
  }
  return {
    wave: new Uint8Array(model.wave_),
    compatible: cloneIntArray(model.compatible_),
    sums: cloneIntArray(model.sumsOfOnes_),
    stackI,
    stackT,
    stacksize: n,
  };
}

function runOrderedInPlace(
  model: Exposed,
  variant: Variant,
  wave: Uint8Array,
  compatible: IntArray,
  sums: IntArray,
  stackI: Int32Array,
  stackT: Int32Array,
  stacksize: number,
): OrderedResult {
  const T = model.T_;
  const T4 = model.T4_;
  const propData = model.propData_;
  const propStart = model.propStart_;
  const propLen = model.propLen_;
  const neighbors = model.neighbors_;
  let head = 0;
  let tail = stacksize;
  let processed = 0;
  let pushed = 0;

  while (variant.mode === "lifo" ? tail > 0 : head < tail) {
    let i1: number;
    let t1: number;
    if (variant.mode === "lifo") {
      tail--;
      i1 = stackI[tail];
      t1 = stackT[tail];
    } else {
      i1 = stackI[head];
      t1 = stackT[head];
      head++;
    }
    processed++;

    for (let di = 0; di < variant.dirs.length; di++) {
      const d = variant.dirs[di];
      const i2 = neighbors[i1 * 4 + d];
      if (i2 < 0) continue;
      const key = d * T + t1;
      const start = propStart[key];
      const len = propLen[key];
      const base2 = i2 * T4;
      for (let l = 0; l < len; l++) {
        const t2 = propData[start + l];
        const cidx = base2 + t2 * 4 + d;
        if (--compatible[cidx] === 0) {
          wave[i2 * T + t2] = 0;
          const cbase = i2 * T4 + t2 * 4;
          compatible[cbase] = 0;
          compatible[cbase + 1] = 0;
          compatible[cbase + 2] = 0;
          compatible[cbase + 3] = 0;
          stackI[tail] = i2;
          stackT[tail] = t2;
          tail++;
          pushed++;
          sums[i2] -= 1;
        }
      }
    }
  }

  return { wave, sums, processed, pushed, ok: sums[0] > 0 };
}

function runOrdered(model: Exposed, snap: Snapshot, variant: Variant): OrderedResult {
  return runOrderedInPlace(
    model,
    variant,
    new Uint8Array(snap.wave),
    cloneIntArray(snap.compatible),
    cloneIntArray(snap.sums),
    new Int32Array(snap.stackI),
    new Int32Array(snap.stackT),
    snap.stacksize,
  );
}

async function runCase(tileset: Tileset, subsetName: string | null, size: number, label: string, reps: number): Promise<void> {
  const model = new Exposed({ tileset, subsetName, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (model.count_ === 0) model.init_();
  const [cell, kept, expectedBans] = pickStrongObserveLikeTrigger(model);

  model.clear_();
  applyObserveKeep(model, cell, kept);
  const snap = snapshot(model);
  const before = liveCount(snap.wave);
  const cpuOk = model.propagate_();
  const cpuWave = new Uint8Array(model.wave_);
  const cpuSums = cloneIntArray(model.sumsOfOnes_);
  const removed = before - liveCount(cpuWave);

  const cpuPropMs = benchmarkMedian(() => {
    model.clear_();
    applyObserveKeep(model, cell, kept);
    const t0 = performance.now();
    model.propagate_();
    return performance.now() - t0;
  }, reps);

  console.log(`\n${label} size=${size} cell=${cell} keep=${kept} initStack=${snap.stacksize} bestBan=${expectedBans} removed=${removed} cpuProp=${cpuPropMs.toFixed(4)} ok=${cpuOk ? "ok" : "bad"}`);
  console.log("variant     | drainMs | speed-vs-cpu | processed | pushed | wDiff | sDiff | ok");
  console.log("------------|---------|--------------|-----------|--------|-------|-------|---");
  const reusableWave = new Uint8Array(snap.wave.length);
  const reusableCompat = cloneIntArray(snap.compatible);
  const reusableSums = cloneIntArray(snap.sums);
  const reusableStackI = new Int32Array(snap.stackI.length);
  const reusableStackT = new Int32Array(snap.stackT.length);
  for (const variant of VARIANTS) {
    const first = runOrdered(model, snap, variant);
    const wDiff = diffWave(cpuWave, first.wave);
    const sDiff = diffCounts(cpuSums, first.sums);
    const ms = benchmarkMedian(() => {
      reusableWave.set(snap.wave);
      reusableCompat.set(snap.compatible);
      reusableSums.set(snap.sums);
      reusableStackI.set(snap.stackI);
      reusableStackT.set(snap.stackT);
      const t0 = performance.now();
      runOrderedInPlace(model, variant, reusableWave, reusableCompat, reusableSums, reusableStackI, reusableStackT, snap.stacksize);
      return performance.now() - t0;
    }, reps);
    const speed = cpuPropMs / ms;
    console.log(`${variant.name.padEnd(11)} | ${ms.toFixed(4).padStart(7)} | ${speed.toFixed(3).padStart(12)} | ${String(first.processed).padStart(9)} | ${String(first.pushed).padStart(6)} | ${String(wDiff).padStart(5)} | ${String(sDiff).padStart(5)} | ${first.ok ? "ok" : "bad"}`);
  }
}

async function main(): Promise<void> {
  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const knotsXml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const knots = parseTileset(knotsXml, "Knots");
  const roomsXml = readFileSync(new URL("../performance-test/tilesets/Rooms.xml", import.meta.url), "utf8");
  const rooms = parseTileset(roomsXml, "Rooms");
  const reps = Number(process.env.REPS ?? 300);

  console.log("=== CPU H40 PROPAGATION ORDER PROTOTYPE ===");
  console.log(`median reps=${reps}; drainMs excludes reset/clone like a promoted in-place ordering change; variants use same local AC-4 transition, changing only pending-ban/direction order`);
  await runCase(knots, "Standard", 48, "knots-standard", reps);
  await runCase(circuit, "Turnless", 34, "circuit-turnless", reps);
  await runCase(rooms, null, 30, "rooms", reps);
  await runCase(circuit, "Turnless", 128, "circuit-turnless", reps);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
