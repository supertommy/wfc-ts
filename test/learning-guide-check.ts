#!/usr/bin/env bun
// Learning guide build check for Phase 4.
// Requires the backtracking guide files and runs the make-pages-interactive MDX build.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const learningDir = join(root, "docs", "learning");
const indexPath = join(learningDir, "index.mdx");
const guidePath = join(learningDir, "backtracking-wfc.mdx");
const componentPath = join(learningDir, "components", "BacktrackingTrace.tsx");
const buildScript = join(
  process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".navi", "agent"),
  "skills",
  "make-pages-interactive",
  "build.ts"
);

const REQUIRED_GUIDE_MARKERS = [
  "## Hook",
  "## Mental model",
  "## Worked trace",
  "## Interactive proof",
  "## Retrieval close",
  "restart-only",
  "decision stack",
  "propagation stack",
  "rich pipes",
];

function requireFile(path: string): void {
  if (!existsSync(path)) {
    console.error(`FAIL: missing ${path}`);
    process.exit(1);
  }
}

function main() {
  console.log("Phase 4 learning-guide build check");
  requireFile(indexPath);
  requireFile(guidePath);
  requireFile(componentPath);
  requireFile(buildScript);

  const guide = readFileSync(guidePath, "utf8");
  const missing = REQUIRED_GUIDE_MARKERS.filter((marker) => !guide.includes(marker));
  if (missing.length > 0) {
    console.error("FAIL: backtracking guide is missing required anatomy/teaching markers:");
    for (const marker of missing) console.error(`  MISSING: ${marker}`);
    process.exit(1);
  }

  const component = readFileSync(componentPath, "utf8");
  if (!component.includes("useEffect")) {
    console.error("FAIL: BacktrackingTrace must use useEffect for browser-only hydration work.");
    process.exit(1);
  }

  const result = spawnSync("bun", [buildScript, learningDir], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    console.error(`FAIL: learning guide build exited ${result.status}`);
    process.exit(result.status ?? 1);
  }

  console.log("OK: learning guide files exist, contain the required structure, and build.");
}

if (import.meta.main) {
  main();
}
