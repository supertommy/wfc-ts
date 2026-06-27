#!/usr/bin/env bun
// Learning guide build check for Phase 4 Sprint 0/4 independent verification harness.
//
// Targeted for after Sprint 4 (interactive learning guide).
// Must be safe (diagnostic/skip, exit 0) before any guide files exist.
//
// What it will do once files exist (Sprint 4+):
// - Confirm expected guide structure (e.g. docs/learning/index.mdx + per-guide .mdx)
// - Basic "build" hygiene: files parse as text, contain required sections (hook, mental model, etc.)
// - (Future: could invoke make-pages-interactive or mdx compile dry-run)
//
// Current (pre-Sprint 4):
// - If guide dir/files absent: print clear DIAGNOSTIC/SKIP + target sprint, exit 0.
// - No hard failure ever before the files are added by docs work.
//
// Run: bun test/learning-guide-check.ts
// (Explicit harness script; not part of `bun test`.)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const learningDir = join(here, "..", "docs", "learning");
const indexPath = join(learningDir, "index.mdx");

const EXPECTED_GUIDE_MARKERS = [
  "hook",
  "mental model",
  "worked trace",
  "interactive proof",
  "retrieval close",
];

function main() {
  console.log("Phase 4 learning-guide build check (target: post Sprint 4)");
  console.log(`Looking for ${learningDir}`);

  if (!existsSync(learningDir)) {
    console.log("DIAGNOSTIC/SKIP: docs/learning/ directory does not exist yet.");
    console.log("This check is intentionally non-fatal before Sprint 4 guide creation.");
    console.log("Once guide files land, this script will perform real structure + content checks.");
    process.exit(0);
  }

  if (!existsSync(indexPath)) {
    console.log("DIAGNOSTIC/SKIP: docs/learning/index.mdx not present (other guides may be partial).");
    console.log("Safe before full Sprint 4 deliverables.");
    process.exit(0);
  }

  // Files exist — perform minimal build hygiene check (expandable later).
  let indexContent: string;
  try {
    indexContent = readFileSync(indexPath, "utf8");
  } catch (e: any) {
    console.error(`DIAGNOSTIC: failed to read index.mdx: ${e.message}`);
    process.exit(0);
  }

  // Very light "build" validation: look for guide anatomy hints or at least links.
  const hasAnyMarker = EXPECTED_GUIDE_MARKERS.some((m) =>
    indexContent.toLowerCase().includes(m)
  );
  const hasMdxFrontmatter = /^---\s*$/m.test(indexContent);

  console.log("Guide files present — running basic build hygiene:");
  console.log(`  index.mdx size: ${indexContent.length} bytes`);
  console.log(`  has frontmatter: ${hasMdxFrontmatter}`);
  console.log(`  mentions guide anatomy keywords: ${hasAnyMarker}`);

  // For Sprint 0/early, do not fail even if markers missing — just report.
  // Real enforcement comes after Sprint 4 when the content is written.
  if (!hasAnyMarker && !hasMdxFrontmatter) {
    console.log("DIAGNOSTIC: index.mdx exists but looks empty/minimal. (OK pre-Sprint 4)");
  } else {
    console.log("OK: learning guide index present and has basic structure signals.");
  }

  // Future expansion: scan for sibling .mdx guides, verify each has sections, etc.
  try {
    const entries = readdirSync(learningDir).filter((f) => f.endsWith(".mdx"));
    console.log(`  sibling .mdx guides found: ${entries.length} (${entries.join(", ") || "none"})`);
  } catch {
    // ignore
  }

  console.log("Learning guide check complete (exits 0; gates added post-Sprint 4).");
  process.exit(0);
}

if (import.meta.main) {
  main();
}
