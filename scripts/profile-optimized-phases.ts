#!/usr/bin/env bun
/**
 * Script-local optimized-solver phase profiler.
 *
 * Drives the optimized model through the same run loop while timing the private
 * runtime methods. This avoids editing src-optimized/model.ts for temporary
 * instrumentation. The timings include performance.now() overhead per observe,
 * so use them for phase shares and candidate triage, not absolute benchmark
 * claims.
 */

import { readFileSync } from "node:fs";
import { Heuristic, parseTileset, SimpleTiledModel, type Tileset } from "../src-optimized/index.js";
import { mulberry32, type Random } from "../src-optimized/prng.js";

class Exposed extends SimpleTiledModel {
  get count_(): number { return this.count; }
  get observed_(): Int32Array { return this.observed; }
  get wave_(): Uint8Array { return this.wave; }
  get T_(): number { return this.T; }
  init_(): void { (this as any).init(); }
  clear_(): void { this.clear(); }
  next_(random: Random): number { return (this as any).nextUnobservedNode(random) as number; }
  observe_(node: number, random: Random): void { (this as any).observe(node, random); }
  propagate_(): boolean { return (this as any).propagate() as boolean; }
}

interface CaseDef {
  readonly label: string;
  readonly tileset: Tileset;
  readonly subsetName: string | null;
  readonly width: number;
  readonly height: number;
  readonly periodic: boolean;
  readonly seed: number;
}

interface ProfileResult {
  readonly ok: boolean;
  readonly wallMs: number;
  readonly clearMs: number;
  readonly nextMs: number;
  readonly observeMs: number;
  readonly propagateMs: number;
  readonly finalizeMs: number;
  readonly attempts: number;
  readonly observes: number;
  readonly propagates: number;
  readonly contradictions: number;
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

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))] ?? 0;
}

function instrumentedRun(model: Exposed, seed: number, limit = -1, restartBudget = 100): ProfileResult {
  if (model.count_ === 0) model.init_();
  let clearMs = 0;
  let nextMs = 0;
  let observeMs = 0;
  let propagateMs = 0;
  let finalizeMs = 0;
  let observes = 0;
  let propagates = 0;
  let contradictions = 0;
  const wall0 = performance.now();

  for (let attempt = 0; attempt <= restartBudget; attempt++) {
    let t0 = performance.now();
    model.clear_();
    clearMs += performance.now() - t0;
    const s = attempt === 0 ? seed : deriveRestartSeed(seed, attempt);
    const random = mulberry32(s);
    const limitNeg = limit < 0;
    let contradicted = false;

    for (let l = 0; limitNeg || l < limit; l++) {
      t0 = performance.now();
      const node = model.next_(random);
      nextMs += performance.now() - t0;
      if (node >= 0) {
        t0 = performance.now();
        model.observe_(node, random);
        observeMs += performance.now() - t0;
        observes++;

        t0 = performance.now();
        const success = model.propagate_();
        propagateMs += performance.now() - t0;
        propagates++;
        if (!success) {
          contradicted = true;
          contradictions++;
          break;
        }
      } else {
        t0 = performance.now();
        const { wave_, T_, observed_, count_ } = model;
        for (let i = 0; i < count_; i++) {
          const base = i * T_;
          for (let t = 0; t < T_; t++) {
            if (wave_[base + t]) {
              observed_[i] = t;
              break;
            }
          }
        }
        finalizeMs += performance.now() - t0;
        return { ok: true, wallMs: performance.now() - wall0, clearMs, nextMs, observeMs, propagateMs, finalizeMs, attempts: attempt + 1, observes, propagates, contradictions };
      }
    }
    if (!contradicted) return { ok: true, wallMs: performance.now() - wall0, clearMs, nextMs, observeMs, propagateMs, finalizeMs, attempts: attempt + 1, observes, propagates, contradictions };
  }
  return { ok: false, wallMs: performance.now() - wall0, clearMs, nextMs, observeMs, propagateMs, finalizeMs, attempts: restartBudget + 1, observes, propagates, contradictions };
}

function fmt(ms: number, wall: number): string {
  return `${ms.toFixed(3).padStart(7)}ms ${((ms / wall) * 100).toFixed(1).padStart(5)}%`;
}

function runCase(c: CaseDef, reps: number): void {
  const results: ProfileResult[] = [];
  // one warmup
  instrumentedRun(new Exposed({ tileset: c.tileset, subsetName: c.subsetName, width: c.width, height: c.height, periodic: c.periodic, heuristic: Heuristic.MRV }), c.seed);
  for (let r = 0; r < reps; r++) {
    const model = new Exposed({ tileset: c.tileset, subsetName: c.subsetName, width: c.width, height: c.height, periodic: c.periodic, heuristic: Heuristic.MRV });
    results.push(instrumentedRun(model, c.seed));
  }

  const walls = results.map((r) => r.wallMs);
  const medWall = median(walls);
  const med = results.reduce((best, r) => Math.abs(r.wallMs - medWall) < Math.abs(best.wallMs - medWall) ? r : best, results[0]);
  console.log(`\n=== ${c.label} (${c.width}x${c.height}) ===`);
  console.log(`ok=${med.ok} attempts=${med.attempts} observes=${med.observes} propagates=${med.propagates} contradictions=${med.contradictions}`);
  console.log(`wall median=${medWall.toFixed(3)}ms p25=${percentile(walls, 0.25).toFixed(3)}ms p75=${percentile(walls, 0.75).toFixed(3)}ms`);
  console.log(`clear      ${fmt(med.clearMs, med.wallMs)}`);
  console.log(`next       ${fmt(med.nextMs, med.wallMs)}`);
  console.log(`observe    ${fmt(med.observeMs, med.wallMs)}`);
  console.log(`propagate  ${fmt(med.propagateMs, med.wallMs)} avg/prop=${(med.propagateMs / Math.max(1, med.propagates)).toFixed(4)}ms`);
  console.log(`finalize   ${fmt(med.finalizeMs, med.wallMs)}`);
  const cycle = med.nextMs + med.observeMs + med.propagateMs;
  console.log(`cycle(next+observe+prop) ${fmt(cycle, med.wallMs)}`);
}

function main(): void {
  const circuitXml = readFileSync(new URL("../performance-test/tilesets/Circuit.xml", import.meta.url), "utf8");
  const circuit = parseTileset(circuitXml, "Circuit");
  const knotsXml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
  const knots = parseTileset(knotsXml, "Knots");
  const roomsXml = readFileSync(new URL("../performance-test/tilesets/Rooms.xml", import.meta.url), "utf8");
  const rooms = parseTileset(roomsXml, "Rooms");
  const reps = Number(process.env.REPS ?? 9);
  console.log(`=== OPTIMIZED PHASE PROFILE (script-local, reps=${reps}) ===`);
  runCase({ label: "knots-standard-48", tileset: knots, subsetName: "Standard", width: 48, height: 48, periodic: true, seed: 7 }, reps);
  runCase({ label: "circuit-turnless-34", tileset: circuit, subsetName: "Turnless", width: 34, height: 34, periodic: true, seed: 1 }, reps);
  runCase({ label: "rooms-30", tileset: rooms, subsetName: null, width: 30, height: 30, periodic: false, seed: 1 }, reps);
}

main();
