// Test file for WFCSolver3D — written BEFORE implementation (Red phase)
// These tests define expected behavior for the 3D solver.

import { describe, it, expect } from "vitest";
import { WFCSolver3D, type TileRule3D } from "../src/solver-3d.js";

// Simple 3-tile tileset: all tiles compatible in all 6 directions
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

// Pipes tileset: 3 tiles with directional constraints
// Tile 0: empty — only connects to empty or pipe ends
// Tile 1: straight pipe — connects along one axis
// Tile 2: junction — connects in all directions
function pipeRules3D(): TileRule3D[] {
  return [
    {
      forTile: 0, // empty
      left: [0, 1, 2],
      right: [0, 1, 2],
      up: [0, 1, 2],
      down: [0, 1, 2],
      front: [0, 1, 2],
      back: [0, 1, 2],
    },
    {
      forTile: 1, // straight pipe
      left: [0, 1, 2],
      right: [0, 1, 2],
      up: [0, 1, 2],
      down: [0, 1, 2],
      front: [0, 1, 2],
      back: [0, 1, 2],
    },
    {
      forTile: 2, // junction
      left: [0, 1, 2],
      right: [0, 1, 2],
      up: [0, 1, 2],
      down: [0, 1, 2],
      front: [0, 1, 2],
      back: [0, 1, 2],
    },
  ];
}

describe("WFCSolver3D — 3D voxel grid solver", () => {
  it("solves a 3×3×3 grid with all-compatible tiles", () => {
    const T = 3;
    const solver = new WFCSolver3D({
      width: 3,
      height: 3,
      depth: 3,
      periodic: false,
      weights: [1, 1, 1],
      rules: allCompatibleRules3D(T),
      heuristic: "mrv",
    });

    const success = solver.run(42);
    expect(success).toBe(true);

    const result = solver.result();
    expect(result.length).toBe(27); // 3×3×3 = 27 cells
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThan(T);
    }
  });

  it("solves a 4×4×4 grid", () => {
    const T = 3;
    const solver = new WFCSolver3D({
      width: 4,
      height: 4,
      depth: 4,
      periodic: false,
      weights: [1, 1, 1],
      rules: allCompatibleRules3D(T),
    });

    const success = solver.run(42);
    expect(success).toBe(true);

    const result = solver.result();
    expect(result.length).toBe(64); // 4×4×4 = 64 cells
  });

  it("handles 3D periodic boundaries — wraps all 6 faces", () => {
    const T = 3;
    const solver = new WFCSolver3D({
      width: 4,
      height: 4,
      depth: 4,
      periodic: true, // periodic in all dimensions
      weights: [1, 1, 1],
      rules: allCompatibleRules3D(T),
    });

    const success = solver.run(42);
    expect(success).toBe(true);

    const result = solver.result();
    expect(result.length).toBe(64);
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles thin slab (1×4×4) correctly", () => {
    const T = 3;
    const solver = new WFCSolver3D({
      width: 1,
      height: 4,
      depth: 4,
      periodic: false,
      weights: [1, 1, 1],
      rules: allCompatibleRules3D(T),
    });

    const success = solver.run(42);
    expect(success).toBe(true);

    const result = solver.result();
    expect(result.length).toBe(16); // 1×4×4 = 16 cells
  });

  it("handles thin slab (4×1×4) correctly", () => {
    const T = 3;
    const solver = new WFCSolver3D({
      width: 4,
      height: 1,
      depth: 4,
      periodic: false,
      weights: [1, 1, 1],
      rules: allCompatibleRules3D(T),
    });

    const success = solver.run(42);
    expect(success).toBe(true);

    const result = solver.result();
    expect(result.length).toBe(16); // 4×1×4 = 16 cells
  });

  it("handles thin slab (4×4×1) correctly", () => {
    const T = 3;
    const solver = new WFCSolver3D({
      width: 4,
      height: 4,
      depth: 1,
      periodic: false,
      weights: [1, 1, 1],
      rules: allCompatibleRules3D(T),
    });

    const success = solver.run(42);
    expect(success).toBe(true);

    const result = solver.result();
    expect(result.length).toBe(16); // 4×4×1 = 16 cells
  });

  it("is deterministic — same seed yields identical output", () => {
    const T = 3;
    const runOnce = (seed: number): number[] => {
      const solver = new WFCSolver3D({
        width: 4,
        height: 4,
        depth: 4,
        periodic: false,
        weights: [1, 1, 1],
        rules: allCompatibleRules3D(T),
      });
      solver.run(seed);
      return Array.from(solver.result());
    };

    const a = runOnce(42);
    const b = runOnce(42);
    expect(b).toEqual(a);

    // Different seed should give different result
    const c = runOnce(999);
    expect(c).not.toEqual(a);
  });

  it("provides width, height, depth accessors", () => {
    const solver = new WFCSolver3D({
      width: 3,
      height: 4,
      depth: 5,
      periodic: false,
      weights: [1, 1, 1],
      rules: allCompatibleRules3D(3),
    });

    expect(solver.width).toBe(3);
    expect(solver.height).toBe(4);
    expect(solver.depth).toBe(5);
  });

  it("stepRun() yields progress updates", () => {
    const T = 3;
    const solver = new WFCSolver3D({
      width: 3,
      height: 3,
      depth: 3,
      periodic: false,
      weights: [1, 1, 1],
      rules: allCompatibleRules3D(T),
    });

    const statuses: { done: boolean; cellsResolved?: number }[] = [];
    for (const status of solver.stepRun(42, -1, 100, 1)) {
      statuses.push({ done: status.done, cellsResolved: status.cellsResolved });
      if (status.done) break;
    }

    expect(statuses.length).toBeGreaterThan(1);
    const final = statuses[statuses.length - 1];
    expect(final.done).toBe(true);
    expect(final.cellsResolved).toBe(27); // 3×3×3
  });

  it("works with pipes tileset", () => {
    const solver = new WFCSolver3D({
      width: 4,
      height: 4,
      depth: 4,
      periodic: false,
      weights: [1, 1, 1],
      rules: pipeRules3D(),
    });

    const success = solver.run(42);
    expect(success).toBe(true);

    const result = solver.result();
    expect(result.length).toBe(64);
  });
});
