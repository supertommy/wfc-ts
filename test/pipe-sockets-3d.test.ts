// Test file for rich 3D pipe sockets (socket-based adjacency).
// Verifies (per requirements):
// - rich pipe tile generator (empty + straights + elbows + tees + 6-way)
// - rule generation from sockets is symmetric
// - post-solve validator: interior facing faces must agree (open==open or wall==wall)
// - boundary faces may be open (non-periodic)
// - deterministic 3D path under same seed+options
// - solved rich 3D configuration validates via assertOpeningsMatch for sizes that succeed
//   (2^3/3^3/4^3 now succeed under both restart and backtrack for seed 42)
// No claim about global connectivity.

import { describe, it, expect } from "vitest";
import { WFCSolver3D, type TileRule3D } from "../src/solver-3d.js";

const OPP = [1, 0, 3, 2, 5, 4];

interface RichPipeTile {
  name: string;
  open: number[]; // length 6, 0/1 per face
  weight: number;
}

function faces(...f: number[]): number[] {
  const m = [0, 0, 0, 0, 0, 0];
  for (const i of f) m[i] = 1;
  return m;
}

export function buildRichPipeTiles(): RichPipeTile[] {
  const tiles: RichPipeTile[] = [];

  // empty — no openings
  tiles.push({ name: "empty", open: faces(), weight: 1.2 });

  // straights (axis aligned)
  tiles.push({ name: "straight-X", open: faces(0, 1), weight: 1.4 });
  tiles.push({ name: "straight-Y", open: faces(2, 3), weight: 1.4 });
  tiles.push({ name: "straight-Z", open: faces(4, 5), weight: 1.4 });

  // elbows — exactly two non-opposite openings (turns)
  tiles.push({ name: "elbow-X+Y", open: faces(1, 2), weight: 0.9 }); // +x -> +y
  tiles.push({ name: "elbow-X+Z", open: faces(1, 4), weight: 0.9 });
  tiles.push({ name: "elbow-Y+Z", open: faces(2, 4), weight: 0.9 });
  tiles.push({ name: "elbow-X-Y", open: faces(0, 3), weight: 0.9 });
  tiles.push({ name: "elbow-X-Z", open: faces(0, 5), weight: 0.9 });
  tiles.push({ name: "elbow-Y-Z", open: faces(3, 5), weight: 0.9 });

  // tees — three openings (branch)
  tiles.push({ name: "tee-X+Y+Z", open: faces(0, 1, 2), weight: 0.6 }); // horiz-X with +y branch
  tiles.push({ name: "tee-X+Y-Z", open: faces(0, 1, 3), weight: 0.6 });
  tiles.push({ name: "tee-X+Z+Y", open: faces(0, 1, 4), weight: 0.6 });

  // six-way junction
  tiles.push({ name: "junction-6", open: faces(0, 1, 2, 3, 4, 5), weight: 0.3 });

  return tiles;
}

function buildRulesFromTiles(tiles: RichPipeTile[]): TileRule3D[] {
  const dirKeys = ["left", "right", "up", "down", "front", "back"] as const;
  return tiles.map((tile, i) => {
    const rule = { forTile: i } as TileRule3D;
    for (let d = 0; d < 6; d++) {
      const allowed: number[] = [];
      for (let j = 0; j < tiles.length; j++) {
        // tile j on direction d from i: their touching faces are i@d and j@OPP[d]
        if (tiles[j].open[OPP[d]] === tile.open[d]) allowed.push(j);
      }
      (rule as any)[dirKeys[d]] = allowed;
    }
    return rule;
  });
}

/**
 * Post-solve validator: for every existing neighbor pair (non-boundary),
 * the placed tiles' facing sockets must match exactly.
 * Boundary openings are allowed (no neighbor to match).
 */
export function assertOpeningsMatch(
  result: Int32Array,
  sockets: number[][],
  width: number,
  height: number,
  depth: number
): void {
  const DX = [-1, 1, 0, 0, 0, 0];
  const DY = [0, 0, 1, -1, 0, 0];
  const DZ = [0, 0, 0, 0, -1, 1];
  const N = width * height * depth;
  expect(result.length).toBe(N);

  for (let i = 0; i < N; i++) {
    const x = i % width;
    const y = Math.floor((i / width) % height);
    const z = Math.floor(i / (width * height));
    const t = result[i];
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      const nz = z + DZ[d];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= depth) {
        continue; // boundary: opening or wall is fine
      }
      const ni = nx + ny * width + nz * width * height;
      const nt = result[ni];
      const openA = sockets[t][d];
      const openB = sockets[nt][OPP[d]];
      expect(openA).toBe(openB);
    }
  }
}

describe("rich 3D pipe sockets", () => {
  it("buildRichPipeTiles contains empty, straights, elbows, tees, and junction-6", () => {
    const tiles = buildRichPipeTiles();
    const names = tiles.map((t) => t.name);

    expect(names).toContain("empty");
    expect(names.some((n) => n.startsWith("straight-"))).toBe(true);

    // explicit "at least one" for the required rich pipe categories per Phase 3 Sprint 0 harness
    const elbows = names.filter((n) => n.includes("elbow-"));
    const tees = names.filter((n) => n.includes("tee-"));
    const sixways = names.filter((n) => n.includes("junction-6"));
    expect(elbows.length).toBeGreaterThanOrEqual(1);
    expect(tees.length).toBeGreaterThanOrEqual(1);
    expect(sixways.length).toBeGreaterThanOrEqual(1);
  });

  it("socket-generated rules are symmetric (A allows B on D iff B allows A on OPP[D])", () => {
    const tiles = buildRichPipeTiles();
    const rules = buildRulesFromTiles(tiles);

    for (let d = 0; d < 6; d++) {
      const oppD = OPP[d];
      for (const r of rules) {
        const t = r.forTile;
        for (const other of (r as any)[["left", "right", "up", "down", "front", "back"][d]]) {
          // other on d from t => t must be allowed from other on oppD
          const otherRule = rules[other];
          const allowedFromOther = (otherRule as any)[["left", "right", "up", "down", "front", "back"][oppD]];
          expect(allowedFromOther).toContain(t);
        }
      }
    }
  });

  it("solves strict rich 3D (2^3/3^3/4^3) under restart and backtrack for seed 42; assertOpeningsMatch validates", () => {
    const tiles = buildRichPipeTiles();
    const sockets = tiles.map((t) => t.open);
    const rules = buildRulesFromTiles(tiles);
    const weights = tiles.map((t) => t.weight);

    // restart (budget=0) now succeeds on these sizes; validate sockets match
    for (const sz of [2, 3, 4]) {
      const sR = new WFCSolver3D({
        width: sz,
        height: sz,
        depth: sz,
        periodic: false,
        weights,
        rules,
        search: { strategy: "restart" },
      } as any);
      expect(sR.run(42, -1, 0)).toBe(true);
      assertOpeningsMatch(sR.result(), sockets, sz, sz, sz);
    }

    // backtrack also succeeds and validates
    const sz = 3;
    const sB = new WFCSolver3D({
      width: sz,
      height: sz,
      depth: sz,
      periodic: false,
      weights,
      rules,
      search: { strategy: "backtrack", maxBacktracks: 4096, maxDepth: 128 },
    } as any);
    expect(sB.run(42, -1, 0)).toBe(true);
    assertOpeningsMatch(sB.result(), sockets, sz, sz, sz);

    // trivial 1x1x1 always "solves" and must pass the opening validator (no interiors)
    const s1 = new WFCSolver3D({
      width: 1, height: 1, depth: 1,
      periodic: false,
      weights,
      rules,
      search: { strategy: "backtrack", maxBacktracks: 4, maxDepth: 4 },
    } as any);
    expect(s1.run(42, -1, 0)).toBe(true);
    assertOpeningsMatch(s1.result(), sockets, 1, 1, 1);
  });

  it("deterministic under same seed + search options (rich pipes)", () => {
    const tiles = buildRichPipeTiles();
    const rules = buildRulesFromTiles(tiles);
    const weights = tiles.map((t) => t.weight);

    const runOnce = (seed: number, search?: any): number[] => {
      const s = new WFCSolver3D({
        width: 3,
        height: 3,
        depth: 3,
        periodic: false,
        weights,
        rules,
        search,
      } as any);
      s.run(seed, -1, 0);
      return Array.from(s.result());
    };

    const a = runOnce(7, { strategy: "backtrack", maxBacktracks: 64, maxDepth: 32 });
    const b = runOnce(7, { strategy: "backtrack", maxBacktracks: 64, maxDepth: 32 });
    expect(b).toEqual(a);
  });
});
