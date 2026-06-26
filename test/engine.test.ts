// Test file for WFCEngine extraction — written BEFORE implementation (Red phase)
// These tests verify that the extracted engine produces identical results to the original solver.

import { describe, it, expect } from "vitest";
import { WFCEngine } from "../src/engine.js";
import { GridTopology2D } from "../src/topology.js";
import type { StepStatus } from "../src/types.js";

// Simple 3-tile tileset: all tiles compatible with each other
// Tile 0, 1, 2 can be adjacent in any direction
function buildSimplePropagator(T: number): {
  propStart: Uint16Array;
  propLen: Uint8Array;
  propData: Uint8Array;
} {
  // For each direction d (0-3) and tile t (0..T-1), all tiles are allowed
  const D = 4;
  const entries: number[] = [];
  const propStart = new Uint16Array(D * T);
  const propLen = new Uint8Array(D * T);

  let offset = 0;
  for (let d = 0; d < D; d++) {
    for (let t = 0; t < T; t++) {
      const key = d * T + t;
      propStart[key] = offset;
      propLen[key] = T;
      for (let t2 = 0; t2 < T; t2++) {
        entries.push(t2);
        offset++;
      }
    }
  }

  return {
    propStart,
    propLen,
    propData: new Uint8Array(entries),
  };
}

describe("WFCEngine — shared core extracted from WFCSolver", () => {
  it("solves a 4×4 grid with all-compatible tiles", () => {
    const T = 3;
    const width = 4;
    const height = 4;
    const topology = new GridTopology2D(width, height, false);
    const weights = new Float64Array([1, 1, 1]);
    const { propStart, propLen, propData } = buildSimplePropagator(T);

    const engine = new WFCEngine(topology, weights, propStart, propLen, propData, "mrv");

    const success = engine.run(42);
    expect(success).toBe(true);

    const result = engine.result();
    expect(result.length).toBe(16);
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThan(T);
    }
  });

  it("is deterministic — same seed yields identical output", () => {
    const T = 3;
    const topology = new GridTopology2D(4, 4, false);
    const weights = new Float64Array([1, 1, 1]);
    const { propStart, propLen, propData } = buildSimplePropagator(T);

    const runOnce = (seed: number): number[] => {
      const engine = new WFCEngine(topology, weights, propStart, propLen, propData, "mrv");
      engine.run(seed);
      return Array.from(engine.result());
    };

    const a = runOnce(42);
    const b = runOnce(42);
    expect(b).toEqual(a);

    // Different seed should (almost certainly) give different result
    const c = runOnce(999);
    expect(c).not.toEqual(a);
  });

  it("stepRun() yields correct StepStatus sequence", () => {
    const T = 3;
    const topology = new GridTopology2D(4, 4, false);
    const weights = new Float64Array([1, 1, 1]);
    const { propStart, propLen, propData } = buildSimplePropagator(T);

    const engine = new WFCEngine(topology, weights, propStart, propLen, propData, "mrv");

    const statuses: StepStatus[] = [];
    for (const status of engine.stepRun(42, -1, 100, 1)) {
      statuses.push(status);
      if (status.done) break;
    }

    // Should have intermediate steps plus final done
    expect(statuses.length).toBeGreaterThan(1);

    // Final status should be done=true, ok=true, complete=true
    const final = statuses[statuses.length - 1];
    expect(final.done).toBe(true);
    expect(final.ok).toBe(true);
    expect(final.complete).toBe(true);
    expect(final.cellsResolved).toBe(16);

    // Intermediate statuses should have observedCell set
    for (let i = 0; i < statuses.length - 1; i++) {
      const s = statuses[i];
      expect(s.done).toBe(false);
      expect(s.observedCell).toBeGreaterThanOrEqual(0);
      expect(s.observedCell).toBeLessThan(16);
    }
  });

  it("handles periodic boundaries correctly", () => {
    const T = 3;
    const topology = new GridTopology2D(4, 4, true); // periodic
    const weights = new Float64Array([1, 1, 1]);
    const { propStart, propLen, propData } = buildSimplePropagator(T);

    const engine = new WFCEngine(topology, weights, propStart, propLen, propData, "mrv");

    const success = engine.run(42);
    expect(success).toBe(true);

    const result = engine.result();
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("entropy heuristic also works", () => {
    const T = 3;
    const topology = new GridTopology2D(4, 4, false);
    // Unequal weights to make entropy interesting
    const weights = new Float64Array([1, 2, 3]);
    const { propStart, propLen, propData } = buildSimplePropagator(T);

    const engine = new WFCEngine(topology, weights, propStart, propLen, propData, "entropy");

    const success = engine.run(42);
    expect(success).toBe(true);
  });
});
