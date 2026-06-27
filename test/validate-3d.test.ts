// Test file for 3D validation harness (Phase 3 Sprint 0) — written BEFORE implementation (Red phase)
// These tests define expected behavior from the requirements ONLY.
// They will fail to import the not-yet-existing harness/validate-3d until it is created.

import { describe, it, expect } from "vitest";
import { validate3D } from "../harness/validate-3d.js";
import type { TileRule3D } from "../src/types.js";
import { WFCSolver3D } from "../src/solver-3d.js";

// --- helpers that mirror documented 3D convention (left/right/up/down/front/back = -X/+X/+Y/-Y/-Z/+Z)

function allCompatibleRules3D(T: number): TileRule3D[] {
  const allTiles = Array.from({ length: T }, (_, i) => i);
  return allTiles.map((forTile) => ({
    forTile,
    left: allTiles,
    right: allTiles,
    up: allTiles,
    down: allTiles,
    front: allTiles,
    back: allTiles,
  }));
}

function strictSelfRules3D(T: number): TileRule3D[] {
  // each tile only compatible with itself in every direction (good for detecting cross-tile violations)
  return Array.from({ length: T }, (_, forTile) => ({
    forTile,
    left: [forTile],
    right: [forTile],
    up: [forTile],
    down: [forTile],
    front: [forTile],
    back: [forTile],
  }));
}

function makeFilledResult(w: number, h: number, d: number, tile: number): Int32Array {
  const len = w * h * d;
  const arr = new Int32Array(len);
  arr.fill(tile);
  return arr;
}

function makeMixedResult(w: number, h: number, d: number, pattern: number[]): Int32Array {
  const len = w * h * d;
  const arr = new Int32Array(len);
  for (let i = 0; i < len; i++) arr[i] = pattern[i % pattern.length] ?? 0;
  return arr;
}

describe("validate3D — Sprint 0 verification tests (defines Phase 3 harness contract from requirements)", () => {
  it("is importable as validate3D(result, width, height, depth, rules, periodic, complete = true)", () => {
    expect(typeof validate3D).toBe("function");
  });

  it("validates positive integer dimensions (width, height, depth)", () => {
    const rules = allCompatibleRules3D(2);
    const good = makeFilledResult(2, 2, 2, 0);

    // zero, negative, non-integer, float, NaN, Infinity all invalid
    for (const badDim of [0, -1, 1.5, NaN, Infinity, -0]) {
      expect(() => validate3D(good, badDim as any, 2, 2, rules, false)).toThrow();
      expect(() => validate3D(good, 2, badDim as any, 2, rules, false)).toThrow();
      expect(() => validate3D(good, 2, 2, badDim as any, rules, false)).toThrow();
    }

    // positive integers ok (will be exercised by later assertions once module exists)
    const r = validate3D(good, 2, 2, 2, rules, false, true);
    expect(r.valid).toBe(true);
  });

  it("validates result length matches width*height*depth exactly", () => {
    const rules = allCompatibleRules3D(1);
    const w = 3, h = 2, d = 4; // 24
    const badLen = new Int32Array(23);
    expect(() => validate3D(badLen, w, h, d, rules, false)).toThrow();

    const exact = makeFilledResult(w, h, d, 0);
    const r = validate3D(exact, w, h, d, rules, false);
    expect(r.valid).toBe(true);
  });

  it("validates rule tile ids and adjacency lists (ids in [0..T), lists are arrays of valid ids)", () => {
    const res = makeFilledResult(1, 1, 1, 0);

    // tile id >= T (here T implicit from rules length)
    const badId: TileRule3D[] = [{ forTile: 99, left: [0], right: [0], up: [0], down: [0], front: [0], back: [0] }];
    expect(() => validate3D(res, 1, 1, 1, badId, false)).toThrow();

    // missing direction or non-array
    const malformed = [{ forTile: 0, left: [0], right: [0], up: [0], down: [0], front: [0] /* missing back */ }] as any;
    expect(() => validate3D(res, 1, 1, 1, malformed, false)).toThrow();

    const badNeighbor: TileRule3D[] = [{ forTile: 0, left: [5], right: [], up: [], down: [], front: [], back: [] }];
    expect(() => validate3D(res, 1, 1, 1, badNeighbor, false)).toThrow();
  });

  it("treats unresolved -1 cells as invalid ONLY when complete=true (when false, -1s are tolerated)", () => {
    const rules = allCompatibleRules3D(2);
    const w = 2, h = 2, d = 2;
    const withUnresolved = new Int32Array([0, -1, 0, 0, 0, 0, 0, 0]);

    const whenNotComplete = validate3D(withUnresolved, w, h, d, rules, false, false);
    expect(whenNotComplete.valid).toBe(true);
    expect(whenNotComplete.unresolvedCells).toBe(1);

    const whenComplete = validate3D(withUnresolved, w, h, d, rules, false, true);
    expect(whenComplete.valid).toBe(false);
    expect(whenComplete.unresolvedCells).toBe(1);
    expect(whenComplete.violations).toBe(0); // the invalidity comes only from unresolved when complete
  });

  it("reports the required shape: valid, violations, (directed) adjacencyChecks, unresolvedCells, optional firstViolation", () => {
    const rules = allCompatibleRules3D(3);
    const res = makeFilledResult(4, 3, 2, 0);
    const report = validate3D(res, 4, 3, 2, rules, true, true);

    expect(report).toHaveProperty("valid");
    expect(report).toHaveProperty("violations");
    expect(report).toHaveProperty("adjacencyChecks");
    expect(report).toHaveProperty("unresolvedCells");
    // firstViolation is optional
    if ("firstViolation" in report) {
      // may be present or absent; just accessing is fine
      expect(report.firstViolation === undefined || typeof report.firstViolation === "object").toBe(true);
    }

    expect(typeof report.valid).toBe("boolean");
    expect(typeof report.violations).toBe("number");
    expect(typeof report.adjacencyChecks).toBe("number"); // directed checks performed (scalar total or directed aggregate)
    expect(typeof report.unresolvedCells).toBe("number");
  });

  it("uses direction order left/right/up/down/front/back corresponding to -X/+X/+Y/-Y/-Z/+Z (and detects violation in correct directed slot)", () => {
    // 2 tiles that are mutually incompatible
    const rules = strictSelfRules3D(2);
    // 2x1x1 grid: cell0 (x=0) right-neighbor cell1 (x=1) has different tile => must violate on +X from cell0 and equivalently -X from cell1
    const badPair = new Int32Array([0, 1]);
    const r = validate3D(badPair, 2, 1, 1, rules, false, true);

    expect(r.valid).toBe(false);
    expect(r.violations).toBeGreaterThan(0);
    expect(r.firstViolation).toBeDefined();
    expect(["left", "right"]).toContain(r.firstViolation!.direction);
    // depending on walk order, but first should be from lower index typically
    expect(r.firstViolation!.fromTile).not.toBe(r.firstViolation!.toTile);
  });

  it("periodic=true wraps on ALL axes (X/Y/Z) for adjacency checks", () => {
    const rules = strictSelfRules3D(2);
    const w = 2, h = 2, d = 2;
    // all 0s is fine
    const allSame = makeFilledResult(w, h, d, 0);
    expect(validate3D(allSame, w, h, d, rules, true, true).valid).toBe(true);

    // put a foreign tile; because of wrap, every cell sees every other via toroidal
    // With strict self, any 0/1 mix will cause violations on the wrap links
    const mixed = new Int32Array([0, 0, 0, 1, 0, 0, 0, 0]);
    const rp = validate3D(mixed, w, h, d, rules, true, true);
    expect(rp.valid).toBe(false);
    expect(rp.violations).toBeGreaterThan(0);
  });

  it("periodic=false never checks out-of-bounds neighbors (boundary cells have fewer directed checks)", () => {
    // Rule that forbids any neighbor on -X (left) and -Z (front)
    const rules: TileRule3D[] = [{
      forTile: 0,
      left: [],   // no tile allowed to the left
      right: [0],
      up: [0],
      down: [0],
      front: [],  // no tile allowed in front
      back: [0],
    }];
    const w = 2, h = 1, d = 2;

    const res = makeFilledResult(w, h, d, 0);

    // non-periodic: the left-face cells have no left neighbor => their empty-left rule is never consulted => valid
    const nonPer = validate3D(res, w, h, d, rules, false, true);
    expect(nonPer.valid).toBe(true);
    // fewer checks than a full interior would require
    expect(nonPer.adjacencyChecks).toBeLessThan(2 * 2 * 6); // rough

    // periodic would force wrap checks and hit the empty lists => invalid
    const per = validate3D(res, w, h, d, rules, true, true);
    expect(per.valid).toBe(false);
  });

  it("can be used post-solve to confirm a WFCSolver3D result is valid (or surfaces firstViolation)", () => {
    const T = 2;
    const solver = new WFCSolver3D({
      width: 3,
      height: 3,
      depth: 3,
      periodic: false,
      weights: [1, 1],
      rules: allCompatibleRules3D(T),
    });
    expect(solver.run(123)).toBe(true);

    const result = solver.result();
    const report = validate3D(result, 3, 3, 3, allCompatibleRules3D(T), false, true);

    expect(report.valid).toBe(true);
    expect(report.unresolvedCells).toBe(0);
    expect(report.violations).toBe(0);
  });

  it("firstViolation (when present) identifies a concrete directed adjacency failure", () => {
    const rules = strictSelfRules3D(2);
    // 1x1x2 stack along Z: different tiles violate either front or back
    const badZ = new Int32Array([0, 1]);
    const r = validate3D(badZ, 1, 1, 2, rules, false, true);
    expect(r.valid).toBe(false);
    expect(r.firstViolation).toBeDefined();
    expect(["front", "back"]).toContain(r.firstViolation!.direction);
    expect(r.firstViolation!.fromTile).toBe(0);
    expect(r.firstViolation!.toTile).toBe(1);
  });
});
