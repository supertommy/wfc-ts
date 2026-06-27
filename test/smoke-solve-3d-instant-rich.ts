#!/usr/bin/env bun
// API smoke script for Phase 3 Sprint 0 independent verification harness.
// Run focused: bun test/smoke-solve-3d-instant-rich.ts
// (server on 3457 must be up for full rich-missing detection; otherwise reports API reachability)
//
// Requests /api/solve-3d-instant?width=6&height=6&depth=6&seed=42 (and augments for rich when available)
// Expects: ok:true  AND rich pipes tiles (elbow + tee + six-way junction) present in server.
//
// Before rich tileset implemented in viz3d/server.ts:
//   - Fails with message that explicitly identifies "missing rich pipes/API behavior"
//     (distinct from any solver runtime errors or unrelated test failures).
//
// This script uses plain asserts (no vitest) so it is not auto-discovered by `bun test` / vitest.

import { strict as assert } from "node:assert";

const SERVER = "http://localhost:3457";

async function main() {
  console.log("Phase 3 Sprint 0 smoke: /api/solve-3d-instant (rich pipes)");
  console.log(`Targeting ${SERVER}`);

  // 1. Check tilesets for rich pipe content (elbows, tees, 6-way). This is the Phase 3 deliverable.
  let tilesets: Record<string, { name?: string; tiles?: string[] }> = {};
  try {
    const tsRes = await fetch(`${SERVER}/api/tilesets`, { signal: AbortSignal.timeout(2500) });
    assert(tsRes.ok, `tilesets HTTP ${tsRes.status}`);
    tilesets = await tsRes.json();
  } catch (err: any) {
    console.error("FAIL: could not fetch /api/tilesets");
    console.error("  This indicates the visualizer server is not running or /api not serving rich pipes yet.");
    console.error("  Error:", err?.message || err);
    console.error("  (To see rich-missing message specifically, start: bun run viz3d/server.ts )");
    process.exit(1);
  }

  const allTileNames: string[] = Object.values(tilesets).flatMap((ts) => ts.tiles || []);
  const hasElbow = allTileNames.some((n) => /elbow/i.test(String(n)));
  const hasTee = allTileNames.some((n) => /tee/i.test(String(n)));
  const hasSixWay = allTileNames.some((n) => /junction-?6|six.?way/i.test(String(n)));

  try {
    assert(
      hasElbow && hasTee && hasSixWay,
      `Rich pipes tileset not registered. Saw tiles: ${JSON.stringify(allTileNames)}. ` +
      `Require at least one elbow, one tee, and one six-way junction.`
    );
  } catch (e: any) {
    console.error("RED (expected before Phase 3 rich tileset lands):", e.message);
    console.error("This failure pinpoints missing rich pipes in the API/visualizer server,");
    console.error("not an unrelated solver failure or WFC algorithm bug.");
    process.exit(1);
  }

  console.log("  tilesets contain rich pipes: elbow + tee + 6-way ✓");

  // 2. Hit the solve endpoint (use exact query + tileset= for rich when available)
  const richKey = Object.keys(tilesets).find((k) => {
    const ns = tilesets[k].tiles || [];
    return ns.some((n: string) => /elbow|tee|junction/i.test(n));
  });
  const solveUrlBase = "/api/solve-3d-instant?width=6&height=6&depth=6&seed=42";
  const solveUrl = richKey
    ? `${SERVER}${solveUrlBase}&tileset=${encodeURIComponent(richKey)}`
    : `${SERVER}${solveUrlBase}`;

  console.log("  requesting:", solveUrl);
  let data: any;
  try {
    const res = await fetch(solveUrl, { signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    data = JSON.parse(text);
  } catch (err: any) {
    console.error("FAIL on solve-3d-instant:", err?.message || err);
    console.error("Expected ok:true with rich once Phase 3 lands. This identifies missing rich/API behavior.");
    process.exit(1);
  }

  try {
    assert.equal(data.ok, true, `expected data.ok === true, got ${data.ok}`);
    assert.equal(data.width, 6);
    assert.equal(data.height, 6);
    assert.equal(data.depth, 6);
    assert(Array.isArray(data.result) && data.result.length === 6*6*6, "result must be 216 entries");
  } catch (e: any) {
    console.error("RED on solve assertions:", e.message);
    console.error("Response was:", JSON.stringify(data).slice(0, 200));
    process.exit(1);
  }

  console.log("  solve-3d-instant ok:true ✓ (width/height/depth/result present)");
  console.log("");
  console.log("GREEN: smoke passed (would be when rich tileset present and 6^3 solves)");
}

main().catch((e) => {
  console.error("UNEXPECTED:", e);
  process.exit(1);
});
