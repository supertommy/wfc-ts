// Test file for opt-in backtracking search — written BEFORE implementation (Red phase)
// These tests verify the public search API shape and expected behavior for
// restart-only default vs opt-in decision-stack backtracking.
//
// Fixtures chosen so that:
// - restartBudget=0 forces exactly one outer attempt
// - a crafted 2D "pipe+elbow" tileset admits solutions but a greedy first path
//   (specific seed) leads to contradiction under restart-only
// - backtracking should recover within the attempt
//
// 2D and 3D share the underlying engine improvements once implemented.

import { describe, it, expect } from "vitest";
import { WFCSolver, type TileRule } from "../src/solver.js";
import { WFCSolver3D } from "../src/solver-3d.js";
import type { StepStatus } from "../src/types.js";

// 2D socket-style "rich pipes" (straights + elbows) for a fixture that can trap restart
// Direction order for faces: 0=left, 1=up, 2=right, 3=down (matches solver 2D)
const OPP_2D = [2, 3, 0, 1];

function faces2D(...fs: number[]): number[] {
  const m = [0, 0, 0, 0];
  for (const i of fs) m[i] = 1;
  return m;
}

interface Pipe2DTile {
  name: string;
  open: number[];
}

function buildHard2DPipeTiles(): Pipe2DTile[] {
  return [
    { name: "empty", open: faces2D() },
    { name: "straight-H", open: faces2D(0, 2) },
    { name: "straight-V", open: faces2D(1, 3) },
    // 4 elbow rotations (exactly two adjacent openings)
    { name: "elbow-LU", open: faces2D(0, 1) }, // left + up
    { name: "elbow-RU", open: faces2D(2, 1) }, // right + up
    { name: "elbow-RD", open: faces2D(2, 3) }, // right + down
    { name: "elbow-LD", open: faces2D(0, 3) }, // left + down
  ];
}

function buildRulesFrom2DTiles(tiles: Pipe2DTile[]): TileRule[] {
  // dir order matches face indices and solver 2D: 0=left, 1=up, 2=right, 3=down
  const dirKeys = ["left", "up", "right", "down"] as const;
  return tiles.map((tile, i) => {
    const rule = { forTile: i } as any;
    for (let d = 0; d < 4; d++) {
      const allowed: number[] = [];
      const oppD = OPP_2D[d];
      for (let j = 0; j < tiles.length; j++) {
        if (tiles[j].open[oppD] === tile.open[d]) allowed.push(j);
      }
      rule[dirKeys[d]] = allowed;
    }
    return rule as TileRule;
  });
}

describe("backtracking search API (opt-in via constructor)", () => {
  it("omitted search or strategy:'restart' is restart-only (default)", () => {
    const tiles = buildHard2DPipeTiles();
    const rules = buildRulesFrom2DTiles(tiles);
    const weights = [2, 0.8, 0.8, 0.5, 0.5, 0.5, 0.5];

    const s1 = new WFCSolver({
      width: 5,
      height: 5,
      periodic: false,
      weights,
      rules,
      heuristic: "mrv",
    });
    const ok1 = s1.run(0, -1, 0);
    expect(ok1).toBe(false); // known for this seed+budget=0 on this fixture

    const s2 = new WFCSolver({
      width: 5,
      height: 5,
      periodic: false,
      weights,
      rules,
      heuristic: "mrv",
      search: { strategy: "restart" },
    } as any);
    const ok2 = s2.run(0, -1, 0);
    expect(ok2).toBe(false);
  });

  it("restartBudget=0 means exactly one outer attempt (no auto retry)", () => {
    // Use a simple always-solvable set; with budget=0 still succeeds if first path ok
    const T = 2;
    const all = Array.from({ length: T }, (_, i) => i);
    const rules: TileRule[] = all.map((forTile) => ({
      forTile,
      left: all,
      right: all,
      up: all,
      down: all,
    }));
    const s = new WFCSolver({
      width: 3,
      height: 3,
      periodic: false,
      weights: [1, 1],
      rules,
    });
    const ok = s.run(123, -1, 0);
    expect(ok).toBe(true);

    // step statuses should only show attempt 0
    const statuses: StepStatus[] = [];
    for (const st of s.stepRun(123, -1, 0, 1)) {
      statuses.push(st);
      if (st.done) break;
    }
    for (const st of statuses) {
      expect(st.attempt).toBe(0);
    }
  });

  it("opt-in backtracking solves a fixture where restart with restartBudget=0 fails", () => {
    const tiles = buildHard2DPipeTiles();
    const rules = buildRulesFrom2DTiles(tiles);
    const weights = [2, 0.8, 0.8, 0.5, 0.5, 0.5, 0.5];

    // restart-only budget=0 must fail for seed 0 on this fixture
    const restart = new WFCSolver({
      width: 5,
      height: 5,
      periodic: false,
      weights,
      rules,
      heuristic: "mrv",
    });
    expect(restart.run(0, -1, 0)).toBe(false);

    // backtracking (same outer budget=0) should succeed once implemented
    const backtracker = new WFCSolver({
      width: 5,
      height: 5,
      periodic: false,
      weights,
      rules,
      heuristic: "mrv",
      search: { strategy: "backtrack", maxBacktracks: 4096, maxDepth: 64 },
    } as any);

    const ok = backtracker.run(0, -1, 0);
    expect(ok).toBe(true); // currently red: backtracking engine path not present
  });

  it("same seed + same search options yields identical result (deterministic)", () => {
    const tiles = buildHard2DPipeTiles();
    const rules = buildRulesFrom2DTiles(tiles);
    const weights = [2, 0.8, 0.8, 0.5, 0.5, 0.5, 0.5];

    const runWith = (search?: any): number[] => {
      const s = new WFCSolver({
        width: 5,
        height: 5,
        periodic: false,
        weights,
        rules,
        search,
      } as any);
      s.run(42, -1, 0);
      return Array.from(s.result());
    };

    const a = runWith(undefined);
    const b = runWith(undefined);
    expect(b).toEqual(a);

    const c = runWith({ strategy: "restart" });
    expect(c).toEqual(a);
  });

  it("StepStatus.backtracks is only present (or non-zero capable) in backtrack mode", () => {
    const tiles = buildHard2DPipeTiles();
    const rules = buildRulesFrom2DTiles(tiles);
    const weights = [2, 0.8, 0.8, 0.5, 0.5, 0.5, 0.5];

    const collect = (search?: any): StepStatus[] => {
      const s = new WFCSolver({
        width: 5,
        height: 5,
        periodic: false,
        weights,
        rules,
        search,
      } as any);
      const sts: StepStatus[] = [];
      for (const st of s.stepRun(0, -1, 0, 1)) {
        sts.push(st);
        if (st.done) break;
      }
      return sts;
    };

    const restartSts = collect(undefined);
    const lastRestart = restartSts[restartSts.length - 1];
    // In restart mode we do not assert or require a backtracks field (may be absent or 0)
    // The field is only meaningful for backtrack strategy.
    if ("backtracks" in (lastRestart as any)) {
      // tolerate 0 but do not require the key
      expect((lastRestart as any).backtracks).toBe(0);
    }

    const btSts = collect({ strategy: "backtrack", maxBacktracks: 100, maxDepth: 16 });
    const lastBt = btSts[btSts.length - 1];
    // Once implemented, backtracks count must be reported for backtrack mode
    // Use any-cast because the field is added in the same phase as behavior
    const btCount = (lastBt as any).backtracks;
    expect(btCount).not.toBeUndefined();
    expect(btCount).toBeGreaterThanOrEqual(0);
    // and at least the final done status carries it
    expect(lastBt.done).toBe(true);
  });

  it("3D solver accepts search option (shares engine backtracking)", () => {
    // Use the simple compatible 3D pipes from test helper style (always solvable)
    const T = 3;
    const all = Array.from({ length: T }, (_, i) => i);
    const rules3: any[] = all.map((forTile) => ({
      forTile,
      left: all,
      right: all,
      up: all,
      down: all,
      front: all,
      back: all,
    }));

    const s = new WFCSolver3D({
      width: 3,
      height: 3,
      depth: 3,
      periodic: false,
      weights: [1, 1, 1],
      rules: rules3,
      search: { strategy: "backtrack" },
    } as any);

    const ok = s.run(7, -1, 0);
    expect(ok).toBe(true);
  });
});
