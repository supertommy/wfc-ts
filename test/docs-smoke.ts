#!/usr/bin/env bun
// Documentation smoke check for the Phase 4 docs gate.
// Verifies README.md documents the opt-in backtracking API and the restart-only default.
//
// Run: bun test/docs-smoke.ts
// (Explicit harness script, like smoke-solve-3d-instant-rich.ts.)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readmePath = join(here, "..", "README.md");

const REQUIRED = [
  "search: { strategy: 'backtrack' }",
  "restart-only default",
] as const;

function main() {
  console.log("Phase 4 docs smoke: README.md search strategy + restart-only default");
  console.log(`Reading ${readmePath}`);

  let content: string;
  try {
    content = readFileSync(readmePath, "utf8");
  } catch (e: any) {
    console.error(`FAIL: could not read README.md: ${e.message}`);
    process.exit(1);
  }

  const missing: string[] = [];
  for (const s of REQUIRED) {
    if (!content.includes(s)) {
      missing.push(s);
    }
  }

  if (missing.length === 0) {
    console.log("OK: README.md contains both required strings:");
    for (const s of REQUIRED) console.log("  - " + s);
    process.exit(0);
  }

  console.error("FAIL: README.md is missing required search docs.");
  for (const m of missing) {
    console.error("  MISSING: " + m);
  }
  process.exit(1);
}

if (import.meta.main) {
  main();
}
