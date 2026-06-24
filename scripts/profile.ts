// Profile driver: runs the instrumented reference on the big inputs and dumps
// where the cycles go. The DOD "sample the live solution" step — instrument the
// hot paths, run on real input, read where time accumulates, remove the probes.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTileset } from "../src/tileset.js";
import { SimpleTiledModel as ProfileSTM } from "./profile-stm.js";

const dir = dirname(fileURLToPath(import.meta.url));
const tilesetsDir = join(dir, "..", "performance-test", "tilesets");
const xml = (n: string) => readFileSync(join(tilesetsDir, `${n}.xml`), "utf8");

interface Case {
  name: string;
  tileset: string;
  subset: string | null;
  w: number;
  h: number;
  periodic: boolean;
  seed: number;
}
const cases: Case[] = [
  { name: "knots-standard-48", tileset: "Knots", subset: "Standard", w: 48, h: 48, periodic: true, seed: 7 },
  { name: "circuit-turnless-34", tileset: "Circuit", subset: "Turnless", w: 34, h: 34, periodic: true, seed: 1 },
  { name: "rooms-30", tileset: "Rooms", subset: null, w: 30, h: 30, periodic: false, seed: 1 },
];

function row(name: string, ms: number, share: number) {
  return `${name.padEnd(14)} ${ms.toFixed(2).padStart(8)} ms  ${share.toFixed(1).padStart(5)}%`;
}

for (const c of cases) {
  const ts = parseTileset(xml(c.tileset), c.tileset);
  const m = new ProfileSTM({ tileset: ts, subsetName: c.subset, width: c.w, height: c.h, periodic: c.periodic });
  // Warmup + measured run (profile accumulators accumulate across both; we
  // report the measured run by resetting after warmup).
  m.run(c.seed, -1);
  m.pubProf.nextMs = 0; m.pubProf.obsMs = 0; m.pubProf.propMs = 0;
  m.pubProf.initMs = 0; m.pubProf.clearMs = 0; m.pubProf.banCalls = 0;
  m.pubProf.decrements = 0; m.pubProf.scanIters = 0; m.pubProf.observeSteps = 0;

  const t0 = performance.now();
  m.run(c.seed, -1);
  const total = performance.now() - t0;
  const p = m.pubProf;

  const loopMs = p.nextMs + p.obsMs + p.propMs;
  console.log(`\n=== ${c.name} (${c.w}x${c.h}, T=${m.tilenames.length}, ${p.observeSteps} observe steps) ===`);
  console.log(`total run() wall: ${total.toFixed(2)} ms`);
  console.log(`init:    ${row("init", p.initMs, (p.initMs / total) * 100)}`);
  console.log(`clear:   ${row("clear", p.clearMs, (p.clearMs / total) * 100)}`);
  console.log(`nextUnobserved:  ${row("scan", p.nextMs, (p.nextMs / total) * 100)}  (${p.scanIters.toLocaleString()} cell-scan iterations)`);
  console.log(`observe:         ${row("obs", p.obsMs, (p.obsMs / total) * 100)}  (${p.banCalls.toLocaleString()} bans from observe)`);
  console.log(`propagate:       ${row("prop", p.propMs, (p.propMs / total) * 100)}  (${p.decrements.toLocaleString()} compatible-decrements)`);
  console.log(`loop share of total: ${((loopMs / total) * 100).toFixed(1)}%`);
  console.log(`ban calls total: ${p.banCalls.toLocaleString()}  | decrements/ban: ${(p.decrements / Math.max(1, p.banCalls)).toFixed(1)}`);
}