#!/usr/bin/env bun
/**
 * RESEARCH PROTOTYPE — H45 speculative multi-observe batching.
 *
 * Script-local only. Runs the optimized model with N observe() calls before each
 * propagate() drain, hoping to reduce the number of expensive drains. This
 * changes search behavior, so every result is independently validated and tested
 * for determinism/success before any promotion can be considered.
 */

import { readFileSync } from "node:fs";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../helpers/index.js";
import { mulberry32, type Random } from "../helpers/prng.js";
import { checksum } from "../harness/io.js";
import { loadInputSpec, tilesetXml } from "../harness/io.js";
import { validateTiling } from "../harness/validate.js";
import type { InputSpec } from "../harness/types.js";

class Exposed extends SimpleTiledModel {
  get count_(): number { return this.count; }
  get observed_(): Int32Array { return this.observed; }
  get wave_(): Uint8Array { return this.wave; }
  get sumsOfOnes_(): Uint8Array | Uint16Array | Int32Array { return this.sumsOfOnes; }
  get neighbors_(): Int32Array { return this.neighbors; }
  get T_(): number { return this.T; }
  init_(): void { (this as any).init(); }
  clear_(): void { this.clear(); }
  next_(random: Random): number { return (this as any).nextUnobservedNode(random) as number; }
  observe_(node: number, random: Random): void { (this as any).observe(node, random); }
  propagate_(): boolean { return (this as any).propagate() as boolean; }
}

interface BatchResult {
  readonly ok: boolean;
  readonly complete: boolean;
  readonly observed: Int32Array;
  readonly checksum: string;
  readonly attempts: number;
  readonly observes: number;
  readonly propagates: number;
  readonly contradictions: number;
}

interface CaseDef {
  readonly specName: string;
  readonly tileset: Tileset;
  readonly spec: InputSpec;
}

function deriveRestartSeed(baseSeed: number, k: number): number {
  let z = ((baseSeed >>> 0) ^ ((k * 0x9e3779b9) >>> 0)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  z = Math.imul(z, 0x85ebca6b) >>> 0;
  z = (z ^ (z >>> 13)) >>> 0;
  z = Math.imul(z, 0xc2b2ae35) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  return z;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

function finalize(model: Exposed): Int32Array {
  const { wave_, T_, observed_, count_ } = model;
  for (let i = 0; i < count_; i++) {
    const base = i * T_;
    observed_[i] = -1;
    for (let t = 0; t < T_; t++) {
      if (wave_[base + t]) {
        observed_[i] = t;
        break;
      }
    }
  }
  const out = new Int32Array(observed_.length);
  out.set(observed_);
  return out;
}

function selectSeparated(model: Exposed, blocked: Uint8Array): number {
  const sums = model.sumsOfOnes_;
  let best = -1;
  let bestCount = 1 << 30;
  for (let i = 0; i < model.count_; i++) {
    if (blocked[i]) continue;
    const s = sums[i];
    if (s <= 1) continue;
    if (s < bestCount) {
      best = i;
      bestCount = s;
    }
  }
  return best;
}

function blockCellAndNeighbors(model: Exposed, blocked: Uint8Array, cell: number): void {
  blocked[cell] = 1;
  const neighbors = model.neighbors_;
  const base = cell * 4;
  for (let d = 0; d < 4; d++) {
    const n = neighbors[base + d];
    if (n >= 0) blocked[n] = 1;
  }
}

function runBatched(model: Exposed, seed: number, limit: number, batchSize: number, separated: boolean, restartBudget = 100): BatchResult {
  if (model.count_ === 0) model.init_();
  let observes = 0;
  let propagates = 0;
  let contradictions = 0;

  for (let attempt = 0; attempt <= restartBudget; attempt++) {
    model.clear_();
    const random = mulberry32(attempt === 0 ? seed : deriveRestartSeed(seed, attempt));
    const limitNeg = limit < 0;
    let contradicted = false;
    let complete = false;
    let l = 0;

    while (limitNeg || l < limit) {
      let observedThisBatch = 0;
      const blocked = separated && batchSize > 1 ? new Uint8Array(model.count_) : null;
      for (; observedThisBatch < batchSize && (limitNeg || l < limit); observedThisBatch++, l++) {
        let node: number;
        if (observedThisBatch === 0 || !blocked) {
          node = model.next_(random);
          if (node < 0) {
            complete = true;
            break;
          }
        } else {
          node = selectSeparated(model, blocked);
          if (node < 0) break;
        }
        if (blocked) blockCellAndNeighbors(model, blocked, node);
        model.observe_(node, random);
        observes++;
      }

      if (observedThisBatch > 0) {
        const success = model.propagate_();
        propagates++;
        if (!success) {
          contradicted = true;
          contradictions++;
          break;
        }
      }

      if (complete) {
        const observed = finalize(model);
        return { ok: true, complete: true, observed, checksum: checksum(observed), attempts: attempt + 1, observes, propagates, contradictions };
      }

      if (observedThisBatch === 0) break;
    }

    if (!contradicted) {
      const observed = finalize(model);
      // Matches normal run() behavior for limit-reached: ok true, complete maybe false.
      let completeOut = true;
      for (let i = 0; i < observed.length; i++) if (observed[i] < 0) { completeOut = false; break; }
      return { ok: true, complete: completeOut, observed, checksum: checksum(observed), attempts: attempt + 1, observes, propagates, contradictions };
    }
  }

  const observed = finalize(model);
  return { ok: false, complete: false, observed, checksum: checksum(observed), attempts: restartBudget + 1, observes, propagates, contradictions };
}

function timeCurrent(c: CaseDef, reps: number): { ms: number; ok: boolean; checksum: string } {
  const model = new Exposed({ tileset: c.tileset, subsetName: c.spec.subset, width: c.spec.width, height: c.spec.height, periodic: c.spec.periodic, heuristic: Heuristic.MRV });
  model.run(c.spec.seed, c.spec.limit);
  const times: number[] = [];
  let ok = false;
  let sum = "";
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    ok = model.run(c.spec.seed, c.spec.limit);
    times.push(performance.now() - t0);
    sum = checksum(model.result());
  }
  return { ms: median(times), ok, checksum: sum };
}

function timeBatched(c: CaseDef, batchSize: number, separated: boolean, reps: number): { ms: number; result: BatchResult; det: boolean; valid: boolean; violations: number; unresolved: number } {
  const warm = new Exposed({ tileset: c.tileset, subsetName: c.spec.subset, width: c.spec.width, height: c.spec.height, periodic: c.spec.periodic, heuristic: Heuristic.MRV });
  runBatched(warm, c.spec.seed, c.spec.limit, batchSize, separated);

  const times: number[] = [];
  let first: BatchResult | null = null;
  let det = true;
  for (let r = 0; r < reps; r++) {
    const model = new Exposed({ tileset: c.tileset, subsetName: c.spec.subset, width: c.spec.width, height: c.spec.height, periodic: c.spec.periodic, heuristic: Heuristic.MRV });
    const t0 = performance.now();
    const result = runBatched(model, c.spec.seed, c.spec.limit, batchSize, separated);
    times.push(performance.now() - t0);
    if (!first) first = result;
    else if (result.checksum !== first.checksum || result.ok !== first.ok || result.complete !== first.complete) det = false;
  }
  if (!first) throw new Error("no runs");
  const report = validateTiling(c.spec, first.observed, first.complete);
  return { ms: median(times), result: first, det, valid: report.valid, violations: report.violations, unresolved: report.unresolvedCells };
}

function successCurrent(c: CaseDef, n: number): number {
  let ok = 0;
  const model = new Exposed({ tileset: c.tileset, subsetName: c.spec.subset, width: c.spec.width, height: c.spec.height, periodic: c.spec.periodic, heuristic: Heuristic.MRV });
  for (let seed = 0; seed < n; seed++) if (model.run(seed, c.spec.limit)) ok++;
  return ok;
}

function successBatched(c: CaseDef, batchSize: number, separated: boolean, n: number): { ok: number; valid: number; det: boolean } {
  let ok = 0;
  let valid = 0;
  let det = true;
  for (let seed = 0; seed < n; seed++) {
    const m1 = new Exposed({ tileset: c.tileset, subsetName: c.spec.subset, width: c.spec.width, height: c.spec.height, periodic: c.spec.periodic, heuristic: Heuristic.MRV });
    const r1 = runBatched(m1, seed, c.spec.limit, batchSize, separated);
    const m2 = new Exposed({ tileset: c.tileset, subsetName: c.spec.subset, width: c.spec.width, height: c.spec.height, periodic: c.spec.periodic, heuristic: Heuristic.MRV });
    const r2 = runBatched(m2, seed, c.spec.limit, batchSize, separated);
    if (r1.checksum !== r2.checksum || r1.ok !== r2.ok || r1.complete !== r2.complete) det = false;
    const report = validateTiling(c.spec, r1.observed, r1.complete);
    if (r1.ok && r1.complete) ok++;
    if (report.valid && r1.complete) valid++;
  }
  return { ok, valid, det };
}

function loadCase(specName: string): CaseDef {
  const spec = loadInputSpec(specName);
  const tileset = parseTileset(tilesetXml(spec.tileset), spec.tileset);
  return { specName, spec, tileset };
}

function main(): void {
  const reps = Number(process.env.REPS ?? 7);
  const successN = Number(process.env.SUCCESS_N ?? 30);
  const cases = ["knots-standard-48", "circuit-turnless-34", "rooms-30"].map(loadCase);
  console.log("=== CPU H45 BATCHED OBSERVE PROTOTYPE ===");
  console.log(`reps=${reps}; successN=${successN}; batch observes before propagate, then validates final tiling`);
  console.log("case                 | mode   | ms     | speed | ok | complete | valid | det | attempts | observes | props | contradictions | checksum");
  console.log("---------------------|--------|--------|-------|----|----------|-------|-----|----------|----------|-------|----------------|---------");
  for (const c of cases) {
    const cur = timeCurrent(c, reps);
    console.log(`${c.specName.padEnd(20)} | current| ${cur.ms.toFixed(3).padStart(6)} | 1.000 | ${cur.ok ? "ok" : "no"} |     true |  true | true|        1 |        ? |     ? |              ? | ${cur.checksum.slice(0, 8)}`);
    for (const [batch, separated] of [[2, false], [2, true], [4, true]] as const) {
      const b = timeBatched(c, batch, separated, reps);
      const mode = `b${batch}${separated ? "sep" : ""}`;
      console.log(`${c.specName.padEnd(20)} | ${mode.padEnd(6)} | ${b.ms.toFixed(3).padStart(6)} | ${(cur.ms / b.ms).toFixed(3).padStart(5)} | ${b.result.ok ? "ok" : "no"} | ${String(b.result.complete).padStart(8)} | ${String(b.valid).padStart(5)} | ${String(b.det).padStart(4)}| ${String(b.result.attempts).padStart(8)} | ${String(b.result.observes).padStart(8)} | ${String(b.result.propagates).padStart(5)} | ${String(b.result.contradictions).padStart(14)} | ${b.result.checksum.slice(0, 8)} v=${b.violations} u=${b.unresolved}`);
    }
  }

  const dense = loadCase("knots-dense-24");
  console.log(`\n--- success sanity on ${dense.specName} (N=${successN}) ---`);
  const curOk = successCurrent(dense, successN);
  console.log(`current: ok+complete ${curOk}/${successN}`);
  for (const [batch, separated] of [[2, false], [2, true], [4, true]] as const) {
    const s = successBatched(dense, batch, separated, successN);
    console.log(`b${batch}${separated ? "sep" : ""}: ok+complete ${s.ok}/${successN} valid+complete ${s.valid}/${successN} det=${s.det}`);
  }
}

main();
