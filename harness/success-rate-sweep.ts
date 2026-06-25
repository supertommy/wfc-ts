/**
 * Success Rate Sweep — Measure what % of seeds complete without contradiction.
 * 
 * Usage:
 *   bun run harness/success-rate-sweep.ts [options]
 * 
 * Options:
 *   --tileset <name>   Tileset name (default: Summer)
 *   --size <n>         Grid size NxN (default: 48)
 *   --seeds <n>        Number of seeds to test (default: 100)
 *   --periodic         Enable periodic boundaries (default: true)
 *   --no-periodic      Disable periodic boundaries
 *   --solver <kind>    reference or optimized (default: optimized)
 *   --start <n>        Starting seed (default: 1)
 */

import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tilesetXml } from "./io.js";

const here = dirname(fileURLToPath(import.meta.url));

type SolverKind = "reference" | "optimized";

function solverEntry(kind: SolverKind): string {
  const rel = kind === "reference" ? "../src/index.ts" : "../src-optimized/index.ts";
  return pathToFileURL(join(here, rel)).href;
}

interface SweepOptions {
  tileset: string;
  size: number;
  seeds: number;
  periodic: boolean;
  solver: SolverKind;
  startSeed: number;
}

function parseArgs(): SweepOptions {
  const args = process.argv.slice(2);
  const opts: SweepOptions = {
    tileset: "Summer",
    size: 48,
    seeds: 100,
    periodic: true,
    solver: "optimized",
    startSeed: 1,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tileset" && args[i + 1]) {
      opts.tileset = args[++i];
    } else if (arg === "--size" && args[i + 1]) {
      opts.size = parseInt(args[++i], 10);
    } else if (arg === "--seeds" && args[i + 1]) {
      opts.seeds = parseInt(args[++i], 10);
    } else if (arg === "--periodic") {
      opts.periodic = true;
    } else if (arg === "--no-periodic") {
      opts.periodic = false;
    } else if (arg === "--solver" && args[i + 1]) {
      opts.solver = args[++i] as SolverKind;
    } else if (arg === "--start" && args[i + 1]) {
      opts.startSeed = parseInt(args[++i], 10);
    }
  }

  return opts;
}

async function runSweep(opts: SweepOptions) {
  const mod = await import(solverEntry(opts.solver));
  const SimpleTiledModel = mod.SimpleTiledModel;
  const parseTileset = mod.parseTileset;

  const xml = tilesetXml(opts.tileset);
  const tileset = parseTileset(xml, opts.tileset);

  console.log(`\n📊 Success Rate Sweep`);
  console.log(`   Tileset: ${opts.tileset}`);
  console.log(`   Size: ${opts.size}×${opts.size}`);
  console.log(`   Seeds: ${opts.startSeed} to ${opts.startSeed + opts.seeds - 1} (${opts.seeds} total)`);
  console.log(`   Periodic: ${opts.periodic}`);
  console.log(`   Solver: ${opts.solver}`);
  console.log();

  let successes = 0;
  let totalTimeMs = 0;
  const failedSeeds: number[] = [];

  const progressInterval = Math.max(1, Math.floor(opts.seeds / 20)); // Update every 5%

  for (let i = 0; i < opts.seeds; i++) {
    const seed = opts.startSeed + i;

    const model = new SimpleTiledModel({
      tileset,
      width: opts.size,
      height: opts.size,
      periodic: opts.periodic,
    });

    const t0 = performance.now();
    const ok = model.run(seed, -1); // -1 = unlimited iterations
    const elapsed = performance.now() - t0;
    totalTimeMs += elapsed;

    if (ok && model.isComplete()) {
      successes++;
    } else {
      failedSeeds.push(seed);
    }

    // Progress indicator
    if ((i + 1) % progressInterval === 0 || i === opts.seeds - 1) {
      const pct = ((i + 1) / opts.seeds * 100).toFixed(0);
      const successPct = (successes / (i + 1) * 100).toFixed(1);
      process.stdout.write(`\r   Progress: ${pct}% (${successes}/${i + 1} = ${successPct}% success)`);
    }
  }

  console.log("\n");

  const successRate = successes / opts.seeds * 100;
  const avgTimeMs = totalTimeMs / opts.seeds;

  console.log(`✅ Results:`);
  console.log(`   Success: ${successes}/${opts.seeds} (${successRate.toFixed(1)}%)`);
  console.log(`   Failed: ${opts.seeds - successes}`);
  console.log(`   Avg time: ${avgTimeMs.toFixed(2)}ms`);
  console.log(`   Total time: ${(totalTimeMs / 1000).toFixed(2)}s`);

  if (failedSeeds.length > 0 && failedSeeds.length <= 20) {
    console.log(`   Failed seeds: ${failedSeeds.join(", ")}`);
  } else if (failedSeeds.length > 20) {
    console.log(`   Failed seeds (first 20): ${failedSeeds.slice(0, 20).join(", ")}...`);
  }

  // Return structured result for programmatic use
  return {
    tileset: opts.tileset,
    size: opts.size,
    seeds: opts.seeds,
    periodic: opts.periodic,
    successes,
    failures: opts.seeds - successes,
    successRate,
    avgTimeMs,
    totalTimeMs,
    failedSeeds,
  };
}

if (import.meta.main) {
  const opts = parseArgs();
  runSweep(opts).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { runSweep, type SweepOptions };
