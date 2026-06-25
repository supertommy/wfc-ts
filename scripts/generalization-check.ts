/**
 * Phase 4c generalization check: verify optimized solver on larger grids and alt seeds.
 * Gates: VALID (all constraints satisfied) + DET (same seed → same output).
 */

import { SimpleTiledModel, parseTileset, Heuristic } from "../src-optimized/index.js";
import { validateTiling } from "../harness/validate.js";
import { tilesetXml, checksum } from "../harness/io.js";
import type { InputSpec } from "../harness/types.js";

interface TestCase {
  name: string;
  tileset: string;
  subset?: string;
  width: number;
  height: number;
  periodic: boolean;
  seeds: number[];
}

const cases: TestCase[] = [
  // Standard committed sizes with alt seeds
  { name: "knots-48-altseeds", tileset: "Knots", width: 48, height: 48, periodic: true, seeds: [1, 42, 123, 999, 2024] },
  { name: "circuit-34-altseeds", tileset: "Circuit", subset: "Turnless", width: 34, height: 34, periodic: true, seeds: [1, 42, 123, 999, 2024] },
  { name: "rooms-30-altseeds", tileset: "Rooms", width: 30, height: 30, periodic: false, seeds: [1, 42, 123, 999, 2024] },
  
  // Larger grids
  { name: "knots-64", tileset: "Knots", width: 64, height: 64, periodic: true, seeds: [1, 42] },
  { name: "knots-96", tileset: "Knots", width: 96, height: 96, periodic: true, seeds: [1] },
  { name: "circuit-64", tileset: "Circuit", subset: "Turnless", width: 64, height: 64, periodic: true, seeds: [1, 42] },
  { name: "circuit-128", tileset: "Circuit", subset: "Turnless", width: 128, height: 128, periodic: true, seeds: [1] },
  { name: "rooms-64", tileset: "Rooms", width: 64, height: 64, periodic: false, seeds: [1, 42] },
  { name: "rooms-128", tileset: "Rooms", width: 128, height: 128, periodic: false, seeds: [1] },
  
  // Dense (hard) subset at larger sizes
  { name: "knots-dense-48", tileset: "Knots", subset: "Dense", width: 48, height: 48, periodic: true, seeds: [1, 42] },
  { name: "knots-dense-64", tileset: "Knots", subset: "Dense", width: 64, height: 64, periodic: true, seeds: [1] },
];

async function main() {
  console.log("=== Phase 4c Generalization Check ===\n");
  console.log("Testing optimized solver on larger grids and alt seeds...\n");
  
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  
  for (const c of cases) {
    const xml = tilesetXml(c.tileset);
    const tileset = parseTileset(xml, c.tileset);
    
    for (const seed of c.seeds) {
      const label = `${c.name} seed=${seed}`;
      process.stdout.write(`${label.padEnd(35)}`);
      
      // Run 1
      const model1 = new SimpleTiledModel({
        tileset,
        subsetName: c.subset ?? null,
        width: c.width,
        height: c.height,
        periodic: c.periodic,
        heuristic: Heuristic.MRV,
      });
      const t0 = performance.now();
      const complete1 = model1.run(seed, 0);
      const t1 = performance.now();
      const ms = t1 - t0;
      
      if (!complete1) {
        console.log(`FAIL (incomplete) ${ms.toFixed(1)}ms`);
        failed++;
        failures.push(`${label}: incomplete`);
        continue;
      }
      
      const observed1 = model1.result();
      
      // Build spec for validateTiling
      const spec: InputSpec = {
        name: c.name,
        tileset: c.tileset,
        subset: c.subset ?? null,
        width: c.width,
        height: c.height,
        periodic: c.periodic,
        seed,
        limit: 0,
      };
      
      // Validate
      const v = validateTiling(spec, observed1, complete1);
      if (v.violations > 0) {
        console.log(`FAIL (invalid: v=${v.violations}) ${ms.toFixed(1)}ms`);
        failed++;
        failures.push(`${label}: invalid tiling`);
        continue;
      }
      
      const cs1 = checksum(observed1);
      
      // Run 2 for determinism
      const model2 = new SimpleTiledModel({
        tileset,
        subsetName: c.subset ?? null,
        width: c.width,
        height: c.height,
        periodic: c.periodic,
        heuristic: Heuristic.MRV,
      });
      const complete2 = model2.run(seed, 0);
      const cs2 = checksum(model2.result());
      
      if (cs1 !== cs2) {
        console.log(`FAIL (non-deterministic: ${cs1} != ${cs2}) ${ms.toFixed(1)}ms`);
        failed++;
        failures.push(`${label}: non-deterministic`);
        continue;
      }
      
      console.log(`PASS ${ms.toFixed(1)}ms (${cs1.slice(0,8)})`);
      passed++;
    }
  }
  
  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  
  console.log(`\nGeneralization check PASSED ✓`);
}

main();
