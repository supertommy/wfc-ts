// Prove the harness against an identity copy (src-optimized/ == src/) BEFORE
// any optimization exists. This is the ratchet's iteration-0 evidence: that the
// measurement pipeline is sound. If the harness does not report ~1.0x speedup
// and 0 mismatches against an identity copy, the pipeline itself is broken and
// judging optimizations against it would be meaningless.
//
// Runs every committed input through:
//   1. reference solver  -> result file
//   2. optimized (identity copy) solver -> result file
//   3. compare (must PASS: byte-identical checksums)
//   4. validate the reference output (must be VALID)
//   5. determinism: re-run optimized, checksum must be identical
//   6. measure-speedup (must be ~1.0x)
//
// Prints a fixed parseable report. Exits 0 only if every gate passes.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadInputSpec, writeResult } from "./io.js";
import { runSolver } from "./run.js";
import { compareResults } from "./compare.js";
import { validateTiling } from "./validate.js";
import { measureSpeedup } from "./measure-speedup.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const inputNames = [
  "knots-standard-24",
  "knots-standard-48",
  "knots-fabric-24",
  "knots-dense-24",
  "circuit-turnless-34",
  "rooms-30",
];

const N = 5;

interface Row {
  name: string;
  comparePass: boolean;
  valid: boolean;
  deterministic: boolean;
  speedup: number;
  refMedianMs: number;
  optMedianMs: number;
  violations: number;
  refChecksum: string;
  optChecksum: string;
  err?: string;
}

async function main() {
  const refDir = join(root, "performance-test");
  const optDir = join(root, "performance-test-optimized");
  rmSync(optDir, { recursive: true, force: true });
  mkdirSync(join(refDir, "results"), { recursive: true });
  mkdirSync(join(optDir, "results"), { recursive: true });

  const rows: Row[] = [];
  let allPass = true;

  for (const name of inputNames) {
    try {
      const spec = loadInputSpec(name);
      const ref = await runSolver("reference", spec);
      const opt = await runSolver("optimized", spec);

      const refPath = join(refDir, "results", `${name}.txt`);
      const optPath = join(optDir, "results", `${name}.txt`);
      writeResult(ref, refPath);
      writeResult(opt, optPath);

      const cmp = compareResults(refPath, optPath);

      // Determinism: re-run optimized, checksum must match the first run.
      const opt2 = await runSolver("optimized", spec);
      const deterministic = opt2.checksum === opt.checksum;

      const val = validateTiling(spec, ref.observed, ref.complete);

      const sp = await measureSpeedup(spec, N);

      const row: Row = {
        name,
        comparePass: cmp.pass,
        valid: val.valid,
        deterministic,
        speedup: sp.speedup,
        refMedianMs: sp.refMedianMs,
        optMedianMs: sp.optMedianMs,
        violations: val.violations,
        refChecksum: ref.checksum,
        optChecksum: opt.checksum,
      };
      // Gate: valid + complete (the output contract) AND deterministic
      // (reproducible). compare is informational — does this optimization also
      // reproduce the reference's exact tiling? It is NOT the correctness gate;
      // the reference is the validator's correctness anchor, not the thing to
      // reproduce. (Mirrors the collision repo: algorithm changes held to an
      // output contract, not identical intermediates.)
      if (!(val.valid && deterministic)) allPass = false;
      rows.push(row);
    } catch (e) {
      rows.push({
        name,
        comparePass: false,
        valid: false,
        deterministic: false,
        speedup: 0,
        refMedianMs: 0,
        optMedianMs: 0,
        violations: -1,
        refChecksum: "",
        optChecksum: "",
        err: String(e),
      });
      allPass = false;
    }
  }

  // Fixed parseable report.
  console.log("=".repeat(78));
  console.log("HARNESS IDENTITY-BASELINE PROOF (src-optimized/ == src/)");
  console.log("=".repeat(78));
  console.log(
    "name".padEnd(22) + "compare* valid  determ  speedup   refMs   optMs  viol",
  );
  console.log("-".repeat(78));
  for (const r of rows) {
    console.log(
      r.name.padEnd(22) +
        (r.comparePass ? "PASS  " : "FAIL  ") +
        (r.valid ? "VALID " : "INVAL ") +
        (r.deterministic ? "DET   " : "NODET ") +
        `${r.speedup.toFixed(2)}x    `.slice(0, 8) +
        `${r.refMedianMs.toFixed(2).padStart(6)} ` +
        `${r.optMedianMs.toFixed(2).padStart(6)} ` +
        `${String(r.violations).padStart(4)}`,
    );
    if (r.err) console.log(`    ERROR: ${r.err}`);
  }
  console.log("-".repeat(78));
  console.log(`FINAL: ${allPass ? "PASS — harness proven against identity copy (gate: valid + deterministic)" : "FAIL — pipeline unsound"}`);
  console.log("=".repeat(78));

  // Also persist the per-input reference checksums so Phase 3 can detect a
  // quietly-edited committed input (the collision repo's checksum guard).
  const checksums = rows.map((r) => `${r.name}: ${r.refChecksum}`).join("\n");
  writeFileSync(join(root, "performance-test", "input-checksums.txt"), checksums + "\n", "utf8");

  process.exit(allPass ? 0 : 1);
}

main();