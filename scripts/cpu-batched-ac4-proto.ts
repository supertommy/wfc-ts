#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — H38 cell-batched AC-4 propagation.
 *
 * Keeps the current AC-4 support-count semantics, but changes the propagation
 * unit from a stack of `(cell,tile)` bans to a queue of dirty cells with pending
 * banned-tile bitsets. A dirty cell's neighbor lookup/base setup is paid once
 * per direction, then all pending banned tiles for that cell are processed.
 *
 * Script-local only: compare single propagation cascades against the current
 * optimized AC-4 final wave and speed before touching src-optimized/model.ts.
 */

import { readFileSync } from "node:fs";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../src-optimized/index.js";

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

interface BatchContext {
  readonly T: number;
  readonly T4: number;
  readonly count: number;
  readonly lanes: number;
  readonly queue: Int32Array;
  readonly enqueued: Uint8Array;
  readonly pendingBits: Uint32Array;
  readonly tileBuf: Int32Array;
}

interface BatchResult {
  readonly wave: Uint8Array;
  readonly queuePops: number;
  readonly removedTiles: number;
  readonly processedBans: number;
  readonly changedCells: number;
}

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

function buildBatchContext(model: Exposed): BatchContext {
  const T = model.T_;
  const count = model.count_;
  const lanes = Math.ceil(T / 32);
  return {
    T,
    T4: model.T4_,
    count,
    lanes,
    queue: new Int32Array(count),
    enqueued: new Uint8Array(count),
    pendingBits: new Uint32Array(count * lanes),
    tileBuf: new Int32Array(T),
  };
}

function enqueue(ctx: BatchContext, cell: number, tail: number): number {
  if (ctx.enqueued[cell]) return tail;
  ctx.enqueued[cell] = 1;
  ctx.queue[tail++] = cell;
  if (tail > ctx.count) throw new Error("dirty queue overflow");
  return tail;
}

function markPending(ctx: BatchContext, cell: number, tile: number, tail: number): number {
  const idx = cell * ctx.lanes + (tile >>> 5);
  const bit = 1 << (tile & 31);
  if ((ctx.pendingBits[idx] & bit) !== 0) return tail;
  ctx.pendingBits[idx] |= bit;
  return enqueue(ctx, cell, tail);
}

function seedInitialPending(ctx: BatchContext, stackI: Int32Array, stackT: Int32Array): number {
  ctx.pendingBits.fill(0);
  ctx.enqueued.fill(0);
  let tail = 0;
  for (let k = 0; k < stackI.length; k++) tail = markPending(ctx, stackI[k], stackT[k], tail);
  return tail;
}

function snapshotStack(model: Exposed): { stackI: Int32Array; stackT: Int32Array } {
  const n = model.stacksize_;
  const stackI = new Int32Array(n);
  const stackT = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    stackI[k] = model.stackI_[k];
    stackT[k] = model.stackT_[k];
  }
  return { stackI, stackT };
}

function cloneCompat(src: Uint8Array | Uint16Array | Int32Array): Uint8Array | Uint16Array | Int32Array {
  if (src instanceof Uint8Array) return new Uint8Array(src);
  if (src instanceof Uint16Array) return new Uint16Array(src);
  return new Int32Array(src);
}

function banInBatch(ctx: BatchContext, wave: Uint8Array, compatible: Uint8Array | Uint16Array | Int32Array, cell: number, tile: number, tail: number): [number, boolean] {
  const widx = cell * ctx.T + tile;
  if (wave[widx] === 0) return [tail, false];
  wave[widx] = 0;
  const cbase = cell * ctx.T4 + tile * 4;
  compatible[cbase] = 0;
  compatible[cbase + 1] = 0;
  compatible[cbase + 2] = 0;
  compatible[cbase + 3] = 0;
  return [markPending(ctx, cell, tile, tail), true];
}

function drainPendingTiles(ctx: BatchContext, cell: number): number {
  const { lanes, pendingBits, tileBuf } = ctx;
  const base = cell * lanes;
  let n = 0;
  for (let lane = 0; lane < lanes; lane++) {
    let bits = pendingBits[base + lane];
    pendingBits[base + lane] = 0;
    while (bits !== 0) {
      const bit = bits & -bits;
      const bitIndex = 31 - Math.clz32(bit);
      tileBuf[n++] = (lane << 5) + bitIndex;
      bits &= bits - 1;
    }
  }
  return n;
}

function propagateBatchedInPlace(ctx: BatchContext, model: Exposed, wave: Uint8Array, compatible: Uint8Array | Uint16Array | Int32Array, stackI: Int32Array, stackT: Int32Array): BatchResult {
  const { T, T4, queue, enqueued, tileBuf } = ctx;
  const propData = model.propData_;
  const propStart = model.propStart_;
  const propLen = model.propLen_;
  const neighbors = model.neighbors_;

  let head = 0;
  let tail = seedInitialPending(ctx, stackI, stackT);
  let queuePops = 0;
  let removedTiles = 0;
  let processedBans = 0;
  let changedCells = 0;

  while (head < tail) {
    const i1 = queue[head++];
    enqueued[i1] = 0;
    queuePops++;
    const pendingCount = drainPendingTiles(ctx, i1);
    if (pendingCount === 0) continue;
    processedBans += pendingCount;

    for (let d = 0; d < 4; d++) {
      const i2 = neighbors[i1 * 4 + d];
      if (i2 < 0) continue;
      const base2 = i2 * T4;
      let neighborChanged = false;

      for (let p = 0; p < pendingCount; p++) {
        const t1 = tileBuf[p];
        const key = d * T + t1;
        const start = propStart[key];
        const len = propLen[key];
        for (let l = 0; l < len; l++) {
          const t2 = propData[start + l];
          const cidx = base2 + t2 * 4 + d;
          if (--compatible[cidx] === 0) {
            const result = banInBatch(ctx, wave, compatible, i2, t2, tail);
            tail = result[0];
            if (result[1]) {
              removedTiles++;
              neighborChanged = true;
            }
          }
        }
      }

      if (neighborChanged) changedCells++;
    }
  }

  return { wave, queuePops, removedTiles, processedBans, changedCells };
}

function propagateBatched(ctx: BatchContext, model: Exposed, preWave: Uint8Array, preCompat: Uint8Array | Uint16Array | Int32Array, stackI: Int32Array, stackT: Int32Array): BatchResult {
  const wave = new Uint8Array(preWave);
  const compatible = cloneCompat(preCompat);
  return propagateBatchedInPlace(ctx, model, wave, compatible, stackI, stackT);
}

async function runCase(tileset: Tileset, subsetName: string | null, size: number, label: string, reps: number): Promise<void> {
  const model = new Exposed({ tileset, subsetName, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (model.count_ === 0) model.init_();
  const [cell, kept, expectedBans] = pickStrongObserveLikeTrigger(model);
  const ctx = buildBatchContext(model);

  model.clear_();
  applyObserveKeep(model, cell, kept);
  const preWave = new Uint8Array(model.wave_);
  const preCompat = cloneCompat(model.compatible_);
  const initialStack = model.stacksize_;
  const initial = snapshotStack(model);
  const before = liveCount(preWave);
  const batched = propagateBatched(ctx, model, preWave, preCompat, initial.stackI, initial.stackT);
  const cpuOk = model.propagate_();
  const cpuWave = new Uint8Array(model.wave_);
  const after = liveCount(cpuWave);
  const diffs = diffWave(cpuWave, batched.wave);

  const cpuPropMs = benchmarkMedian(() => {
    model.clear_();
    applyObserveKeep(model, cell, kept);
    const t0 = performance.now();
    model.propagate_();
    return performance.now() - t0;
  }, reps);

  const cpuSetupMs = benchmarkMedian(() => {
    model.clear_();
    applyObserveKeep(model, cell, kept);
    model.propagate_();
  }, reps);

  const batchWave = new Uint8Array(preWave.length);
  const batchCompat = cloneCompat(preCompat);
  const batchDrainMs = benchmarkMedian(() => {
    batchWave.set(preWave);
    batchCompat.set(preCompat);
    const t0 = performance.now();
    propagateBatchedInPlace(ctx, model, batchWave, batchCompat, initial.stackI, initial.stackT);
    return performance.now() - t0;
  }, reps);

  const batchCoreMs = benchmarkMedian(() => {
    propagateBatched(ctx, model, preWave, preCompat, initial.stackI, initial.stackT);
  }, reps);

  const batchSetupMs = benchmarkMedian(() => {
    model.clear_();
    applyObserveKeep(model, cell, kept);
    const pw = new Uint8Array(model.wave_);
    const pc = cloneCompat(model.compatible_);
    const st = snapshotStack(model);
    propagateBatched(ctx, model, pw, pc, st.stackI, st.stackT);
  }, reps);

  const removed = before - after;
  console.log(`${label.padEnd(22)} | ${String(size).padStart(4)} | ${String(cell).padStart(5)} | ${String(kept).padStart(4)} | ${String(initialStack).padStart(5)} | ${String(expectedBans).padStart(7)} | ${String(removed).padStart(7)} | ${cpuPropMs.toFixed(4).padStart(8)} | ${cpuSetupMs.toFixed(4).padStart(8)} | ${batchDrainMs.toFixed(4).padStart(10)} | ${batchCoreMs.toFixed(4).padStart(9)} | ${batchSetupMs.toFixed(4).padStart(10)} | ${String(batched.queuePops).padStart(5)} | ${String(batched.processedBans).padStart(7)} | ${String(batched.changedCells).padStart(7)} | ${String(diffs).padStart(5)} | ${cpuOk ? "ok" : "bad"}`);
}

async function main(): Promise<void> {
  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const knotsXml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const knots = parseTileset(knotsXml, "Knots");
  const roomsXml = readFileSync(new URL("../performance-test/tilesets/Rooms.xml", import.meta.url), "utf8");
  const rooms = parseTileset(roomsXml, "Rooms");
  const reps = Number(process.env.REPS ?? 200);

  console.log("=== CPU H38 CELL-BATCHED AC-4 PROPAGATION PROTOTYPE ===");
  console.log(`median reps=${reps}; cpuProp=current propagate only; batchDrain excludes reset like a promoted in-place solver; batchCore clones wave/compat; setup columns include observe bans`);
  console.log("case                   | size |  cell | keep | stack | bestBan | removed | cpuProp | cpuFull | batchDrain | batchCore | batchFull |  pops | banProc | changed | diffs | cpu");
  console.log("-----------------------|------|-------|------|-------|---------|---------|---------|---------|------------|-----------|-----------|-------|---------|---------|-------|----");
  await runCase(knots, "Standard", 48, "knots-standard", reps);
  await runCase(circuit, "Turnless", 34, "circuit-turnless", reps);
  await runCase(rooms, null, 30, "rooms", reps);
  await runCase(circuit, "Turnless", 128, "circuit-turnless", reps);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
