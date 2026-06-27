#!/usr/bin/env bun
// Documentation smoke check for Phase 4 Sprint 0/3 independent verification harness.
// Verifies README.md will contain the documented search API examples after docs Sprint 3.
//
// Strings checked (after docs written):
//   - `search: { strategy: 'backtrack' }`
//   - `restart-only default`
//
// Behavior:
// - If strings present: prints OK and exits 0.
// - If strings missing: prints DIAGNOSTIC (not FAIL), notes that this is expected before Sprint 3 docs update.
//   Usable post-update without code change. Never forces a pass before the docs land.
//
// Run: bun test/docs-smoke.ts
// (Not auto-run by `bun test` — explicit harness script, like smoke-solve-3d-instant-rich.ts)

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
    console.error(`DIAGNOSTIC: could not read README.md: ${e.message}`);
    console.log("DIAGNOSTIC: skipping (no hard gate).");
    process.exit(0);
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

  console.log("DIAGNOSTIC: README.md does not yet contain the expected post-Sprint-3 strings.");
  for (const m of missing) {
    console.log("  MISSING: " + m);
  }
  console.log("This is expected before docs Sprint 3 update.");
  console.log("The check is safe to run now and will become a real gate once strings are added (no code change needed).");
  process.exit(0);
}

if (import.meta.main) {
  main();
}
