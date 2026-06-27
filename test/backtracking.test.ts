// Test file for opt-in backtracking search — verifies public search API shape
// and opt-in backtracking behavior (restart-only default vs 'backtrack' strategy).
//
// restartBudget=0 forces exactly one outer attempt (no auto-retry).
// Default/omitted search is restart-only.
// backtracks field appears only for strategy:'backtrack'.
// Determinism: same seed + same SearchOptions => identical output.
// Includes a valid (socket-generated, symmetric) fixture where restart budget=0
// fails for a seed but backtrack (budget=0) succeeds.

import { describe, it, expect } from "vitest";
import { WFCSolver, type TileRule } from "../src/solver.js";
import { WFCSolver3D, type TileRule3D } from "../src/solver-3d.js";
import type { StepStatus } from "../src/types.js";

// 2D rich "pipes" (straights + elbows + tees, NO empty) using 0/1 sockets.
// Generated rules are symmetric by construction.
// Used with periodic to create a case where restart (single attempt) can trap
// but backtracking recovers.
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

function buildRichNoEmpty2DTiles(): Pipe2DTile[] {
  return [
    { name: "straight-H", open: faces2D(0, 2) },
    { name: "straight-V", open: faces2D(1, 3) },
    // elbows
    { name: "elbow-LU", open: faces2D(0, 1) },
    { name: "elbow-RU", open: faces2D(2, 1) },
    { name: "elbow-RD", open: faces2D(2, 3) },
    { name: "elbow-LD", open: faces2D(0, 3) },
    // tees (3 openings)
    { name: "tee-left-up-right", open: faces2D(0, 1, 2) },
    { name: "tee-left-up-down", open: faces2D(0, 1, 3) },
  ];
}

function buildRulesFrom2DTiles(tiles: Pipe2DTile[]): TileRule[] {
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

// Simple fully-compatible tileset (any tile next to any) — always solvable in one attempt.
function buildTrivialRules(T: number): TileRule[] {
  const all = Array.from({ length: T }, (_, i) => i);
  return all.map((forTile) => ({
    forTile,
    left: all,
    right: all,
    up: all,
    down: all,
  }));
}

describe("backtracking search API (opt-in via constructor)", () => {
  it("omitted search or strategy:'restart' is restart-only (default)", () => {
    const tiles = buildRichNoEmpty2DTiles();
    const rules = buildRulesFrom2DTiles(tiles);
    const weights = tiles.map(() => 1);

    // With restartBudget=0 (exactly one attempt) this seed+fixture fails under restart.
    const s1 = new WFCSolver({
      width: 3,
      height: 3,
      periodic: true,
      weights,
      rules,
      heuristic: "mrv",
    });
    const ok1 = s1.run(13, -1, 0);
    expect(ok1).toBe(false);

    const s2 = new WFCSolver({
      width: 3,
      height: 3,
      periodic: true,
      weights,
      rules,
      heuristic: "mrv",
      search: { strategy: "restart" },
    } as any);
    const ok2 = s2.run(13, -1, 0);
    expect(ok2).toBe(false);
  });

  it("restartBudget=0 means exactly one outer attempt (no auto retry)", () => {
    // Trivial set always solvable on first path.
    const rules = buildTrivialRules(2);
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
    const tiles = buildRichNoEmpty2DTiles();
    const rules = buildRulesFrom2DTiles(tiles);
    const weights = tiles.map(() => 1);

    // restart-only budget=0 fails for this seed+fixture (periodic rich no-empty)
    const restart = new WFCSolver({
      width: 3,
      height: 3,
      periodic: true,
      weights,
      rules,
      heuristic: "mrv",
    });
    expect(restart.run(13, -1, 0)).toBe(false);

    // backtracking (budget=0) succeeds
    const backtracker = new WFCSolver({
      width: 3,
      height: 3,
      periodic: true,
      weights,
      rules,
      heuristic: "mrv",
      search: { strategy: "backtrack", maxBacktracks: 4096, maxDepth: 64 },
    } as any);

    const ok = backtracker.run(13, -1, 0);
    expect(ok).toBe(true);
  });

  it("same seed + same search options yields identical result (deterministic)", () => {
    // Use trivial always-solvable to ensure we compare completed results.
    const rules = buildTrivialRules(3);
    const weights = [1, 1, 1];

    const runWith = (search?: any): number[] => {
      const s = new WFCSolver({
        width: 4,
        height: 4,
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

    // also for backtrack options
    const d = runWith({ strategy: "backtrack", maxBacktracks: 128, maxDepth: 32 });
    const e = runWith({ strategy: "backtrack", maxBacktracks: 128, maxDepth: 32 });
    expect(e).toEqual(d);
  });

  it("StepStatus.backtracks is only asserted for search.strategy='backtrack'", () => {
    const tiles = buildRichNoEmpty2DTiles();
    const rules = buildRulesFrom2DTiles(tiles);
    const weights = tiles.map(() => 1);

    const collect = (search?: any): StepStatus[] => {
      const s = new WFCSolver({
        width: 3,
        height: 3,
        periodic: true,
        weights,
        rules,
        search,
      } as any);
      const sts: StepStatus[] = [];
      for (const st of s.stepRun(13, -1, 0, 1)) {
        sts.push(st);
        if (st.done) break;
      }
      return sts;
    };

    // For restart: do not assert presence or value of backtracks (per requirements)
    const restartSts = collect(undefined);
    const lastRestart = restartSts[restartSts.length - 1];
    // Field must be absent for restart mode
    expect((lastRestart as any).backtracks).toBeUndefined();

    const btSts = collect({ strategy: "backtrack", maxBacktracks: 100, maxDepth: 16 });
    const lastBt = btSts[btSts.length - 1];
    // For backtrack mode, field is present and we assert on it
    const btCount = (lastBt as any).backtracks;
    expect(btCount).not.toBeUndefined();
    expect(btCount).toBeGreaterThanOrEqual(0);
    expect(lastBt.done).toBe(true);
  });

  it("3D solver accepts search option (shares engine backtracking)", () => {
    const T = 3;
    const all = Array.from({ length: T }, (_, i) => i);
    const rules3: TileRule3D[] = all.map((forTile) => ({
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
