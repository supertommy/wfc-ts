#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — H37 dirty-cell + bitset support propagation.
 *
 * This is script-local on purpose. It tests a different propagation formulation
 * without touching the shippable optimized solver:
 *
 *   current AC-4: pop banned (cell,tile), decrement neighbor support counts.
 *   H37 bitset:   pop dirty cell, recompute neighbor tile support by bitset
 *                 intersection against the dirty cell's current domain.
 *
 * The prototype measures a single observe-like propagation cascade. If the core
 * propagation loop cannot beat current optimized AC-4 here, it is not worth
 * promoting into src-optimized/model.ts.
 */

import { readFileSync } from "node:fs";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../helpers/index.js";

class Exposed extends SimpleTiledModel {
  get T_(): number { return this.T; }
  get count_(): number { return this.count; }
  get wave_(): Uint8Array { return this.wave; }
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
}

interface BitsetContext {
  readonly T: number;
  readonly count: number;
  readonly lanes: number;
  readonly supportMasks: Uint32Array;
  readonly queue: Int32Array;
  readonly enqueued: Uint8Array;
  readonly waveMask: Uint32Array;
}

interface BitsetResult {
  readonly wave: Uint8Array;
  readonly changedCells: number;
  readonly removedTiles: number;
  readonly queuePops: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
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
  for (let t = 0; t < T; t++) {
    if (t !== kept && model.wave_[base + t] === 1) model.ban_(cell, t);
  }
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

function getDirtyCellsFromStack(model: Exposed): Int32Array {
  const seen = new Uint8Array(model.count_);
  const out = new Int32Array(model.stacksize_);
  let n = 0;
  const stack = model.stackI_;
  for (let k = 0; k < model.stacksize_; k++) {
    const cell = stack[k];
    if (seen[cell]) continue;
    seen[cell] = 1;
    out[n++] = cell;
  }
  return out.slice(0, n);
}

function buildBitsetContext(model: Exposed): BitsetContext {
  const T = model.T_;
  const count = model.count_;
  const lanes = Math.ceil(T / 32);
  const supportMasks = new Uint32Array(4 * T * lanes);
  const { propData_, propStart_, propLen_ } = model;

  // supportMasks[(d*T + t2)*lanes + lane] contains all neighbor tiles t1
  // such that prop[d][t1] allows t2. This mirrors the AC-4 decrement relation:
  // when neighbor tile t1 is banned, compatible[i2,t2,d] loses one support.
  for (let d = 0; d < 4; d++) {
    for (let t1 = 0; t1 < T; t1++) {
      const key = d * T + t1;
      const start = propStart_[key];
      const len = propLen_[key];
      const bit = 1 << (t1 & 31);
      const lane = t1 >>> 5;
      for (let l = 0; l < len; l++) {
        const t2 = propData_[start + l];
        supportMasks[(d * T + t2) * lanes + lane] |= bit;
      }
    }
  }

  return {
    T,
    count,
    lanes,
    supportMasks,
    queue: new Int32Array(count),
    enqueued: new Uint8Array(count),
    waveMask: new Uint32Array(count * lanes),
  };
}

function seedWaveMask(ctx: BitsetContext, wave: Uint8Array): void {
  const { T, count, lanes, waveMask } = ctx;
  waveMask.fill(0);
  for (let i = 0; i < count; i++) {
    const wbase = i * T;
    const mbase = i * lanes;
    for (let t = 0; t < T; t++) {
      if (wave[wbase + t]) waveMask[mbase + (t >>> 5)] |= 1 << (t & 31);
    }
  }
}

function enqueue(ctx: BitsetContext, cell: number, tail: number): number {
  if (ctx.enqueued[cell]) return tail;
  ctx.enqueued[cell] = 1;
  ctx.queue[tail++] = cell;
  return tail;
}

function propagateBitset(ctx: BitsetContext, model: Exposed, preWave: Uint8Array, dirtyCells: Int32Array): BitsetResult {
  const { T, count, lanes, supportMasks, queue, enqueued, waveMask } = ctx;
  const neighbors = model.neighbors_;
  seedWaveMask(ctx, preWave);
  enqueued.fill(0);

  const wave = new Uint8Array(preWave);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < dirtyCells.length; k++) tail = enqueue(ctx, dirtyCells[k], tail);

  let changedCells = 0;
  let removedTiles = 0;
  let queuePops = 0;

  while (head < tail) {
    const i1 = queue[head++];
    enqueued[i1] = 0;
    queuePops++;
    const maskBase1 = i1 * lanes;

    for (let d = 0; d < 4; d++) {
      const i2 = neighbors[i1 * 4 + d];
      if (i2 < 0) continue;

      const waveBase2 = i2 * T;
      const maskBase2 = i2 * lanes;
      let changed = false;

      for (let t2 = 0; t2 < T; t2++) {
        const lane2 = t2 >>> 5;
        const bit2 = 1 << (t2 & 31);
        if ((waveMask[maskBase2 + lane2] & bit2) === 0) continue;

        const supportBase = (d * T + t2) * lanes;
        let supported = false;
        for (let lane = 0; lane < lanes; lane++) {
          if ((waveMask[maskBase1 + lane] & supportMasks[supportBase + lane]) !== 0) {
            supported = true;
            break;
          }
        }

        if (!supported) {
          waveMask[maskBase2 + lane2] &= ~bit2;
          wave[waveBase2 + t2] = 0;
          changed = true;
          removedTiles++;
        }
      }

      if (changed) {
        changedCells++;
        tail = enqueue(ctx, i2, tail);
        if (tail > count) throw new Error("dirty queue overflow: duplicate enqueue guard failed");
      }
    }
  }

  return { wave, changedCells, removedTiles, queuePops };
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

async function runCase(tileset: Tileset, subsetName: string | null, size: number, label: string, reps: number): Promise<void> {
  const model = new Exposed({ tileset, subsetName, width: size, height: size, periodic: true, heuristic: Heuristic.MRV });
  if (model.count_ === 0) model.init_();
  const [cell, kept, expectedBans] = pickStrongObserveLikeTrigger(model);
  const ctx = buildBitsetContext(model);

  model.clear_();
  applyObserveKeep(model, cell, kept);
  const preWave = new Uint8Array(model.wave_);
  const dirty = getDirtyCellsFromStack(model);
  const before = liveCount(preWave);
  const cpuOk = model.propagate_();
  const cpuWave = new Uint8Array(model.wave_);
  const after = liveCount(cpuWave);
  const bit = propagateBitset(ctx, model, preWave, dirty);
  const diffs = diffWave(cpuWave, bit.wave);

  const cpuPropMs = benchmarkMedian(() => {
    model.clear_();
    applyObserveKeep(model, cell, kept);
    const t0 = performance.now();
    model.propagate_();
    return performance.now() - t0;
  }, reps);

  const cpuWithSetupMs = benchmarkMedian(() => {
    model.clear_();
    applyObserveKeep(model, cell, kept);
    model.propagate_();
  }, reps);

  const bitCoreMs = benchmarkMedian(() => {
    propagateBitset(ctx, model, preWave, dirty);
  }, reps);

  const bitWithSetupMs = benchmarkMedian(() => {
    model.clear_();
    applyObserveKeep(model, cell, kept);
    const pw = new Uint8Array(model.wave_);
    const dc = getDirtyCellsFromStack(model);
    propagateBitset(ctx, model, pw, dc);
  }, reps);

  const removed = before - after;
  console.log(`${label.padEnd(22)} | ${String(size).padStart(4)} | ${String(cell).padStart(5)} | ${String(kept).padStart(4)} | ${String(dirty.length).padStart(5)} | ${String(expectedBans).padStart(7)} | ${String(removed).padStart(7)} | ${cpuPropMs.toFixed(4).padStart(8)} | ${cpuWithSetupMs.toFixed(4).padStart(9)} | ${bitCoreMs.toFixed(4).padStart(10)} | ${bitWithSetupMs.toFixed(4).padStart(12)} | ${String(bit.queuePops).padStart(5)} | ${String(bit.changedCells).padStart(7)} | ${String(bit.removedTiles).padStart(7)} | ${String(diffs).padStart(5)} | ${cpuOk ? "ok" : "bad"}`);
}

async function main(): Promise<void> {
  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const knotsXml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const knots = parseTileset(knotsXml, "Knots");
  const roomsXml = readFileSync(new URL("../performance-test/tilesets/Rooms.xml", import.meta.url), "utf8");
  const rooms = parseTileset(roomsXml, "Rooms");

  const reps = Number(process.env.REPS ?? 200);
  console.log("=== CPU H37 DIRTY-CELL BITSET PROPAGATION PROTOTYPE ===");
  console.log(`median reps=${reps}; cpuProp is current AC-4 propagate only; cpuSetup/bitSetup include observe/setup; bitCore includes prototype mask seeding + propagation`);
  console.log("case                   | size |  cell | keep | dirty | bestBan | removed | cpuProp | cpuSetup | bit core | bit+setup ms |  pops | changed | removed | diffs | cpu");
  console.log("-----------------------|------|-------|------|-------|---------|---------|---------|----------|----------|--------------|-------|---------|---------|-------|----");
  await runCase(knots, "Standard", 48, "knots-standard", reps);
  await runCase(circuit, "Turnless", 34, "circuit-turnless", reps);
  await runCase(rooms, null, 30, "rooms", reps);
  await runCase(circuit, "Turnless", 128, "circuit-turnless", reps);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
