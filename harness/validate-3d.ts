// 3D WFC validation harness.
// Independent adjacency checker for WFCSolver3D outputs. It intentionally keeps its
// own direction/indexing logic so it can catch solver/topology mistakes instead of
// sharing them.

import { WFCSolver3D } from "../src/solver-3d.js";
import type { TileRule3D } from "../src/types.js";

const DX = [-1, 1, 0, 0, 0, 0] as const;
const DY = [0, 0, 1, -1, 0, 0] as const;
const DZ = [0, 0, 0, 0, -1, 1] as const;
const DIR_NAMES = ["left", "right", "up", "down", "front", "back"] as const;

type Direction3D = typeof DIR_NAMES[number];

export interface ValidationResult3D {
  valid: boolean;
  violations: number;
  /** Directed adjacency checks performed. Interior/non-periodic pairs are counted once per direction. */
  adjacencyChecks: number;
  unresolvedCells: number;
  firstViolation?: {
    from: { x: number; y: number; z: number; tile: number };
    to: { x: number; y: number; z: number; tile: number };
    fromTile: number;
    toTile: number;
    direction: Direction3D;
  };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function buildAllowed(rules: TileRule3D[]): Set<number>[][] {
  const tileCount = rules.length;
  const seen = new Set<number>();
  const allowed: Set<number>[][] = Array.from({ length: DIR_NAMES.length }, () => []);

  for (const rule of rules) {
    if (!Number.isInteger(rule.forTile) || rule.forTile < 0 || rule.forTile >= tileCount) {
      throw new Error(`rule.forTile must be an integer in [0, ${tileCount})`);
    }
    if (seen.has(rule.forTile)) {
      throw new Error(`duplicate rule for tile ${rule.forTile}`);
    }
    seen.add(rule.forTile);

    for (let d = 0; d < DIR_NAMES.length; d++) {
      const direction = DIR_NAMES[d];
      const values = rule[direction];
      if (!Array.isArray(values)) {
        throw new Error(`rule ${rule.forTile}.${direction} must be an array`);
      }
      const set = new Set<number>();
      for (const tile of values) {
        if (!Number.isInteger(tile) || tile < 0 || tile >= tileCount) {
          throw new Error(`rule ${rule.forTile}.${direction} contains invalid tile id ${tile}`);
        }
        set.add(tile);
      }
      allowed[d][rule.forTile] = set;
    }
  }

  for (let tile = 0; tile < tileCount; tile++) {
    if (!seen.has(tile)) {
      throw new Error(`missing rule for tile ${tile}`);
    }
  }

  return allowed;
}

export function validate3D(
  result: Int32Array,
  width: number,
  height: number,
  depth: number,
  rules: TileRule3D[],
  periodic: boolean,
  complete = true,
): ValidationResult3D {
  assertPositiveInteger("width", width);
  assertPositiveInteger("height", height);
  assertPositiveInteger("depth", depth);

  const expectedLength = width * height * depth;
  if (result.length !== expectedLength) {
    throw new Error(`result length ${result.length} does not match width*height*depth ${expectedLength}`);
  }

  const allowed = buildAllowed(rules);
  const tileCount = rules.length;

  let violations = 0;
  let adjacencyChecks = 0;
  let unresolvedCells = 0;
  let firstViolation: ValidationResult3D["firstViolation"];

  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = x + y * width + z * width * height;
        const fromTile = result[i];

        if (fromTile < 0) {
          unresolvedCells++;
          continue;
        }
        if (fromTile >= tileCount) {
          throw new Error(`result contains invalid tile id ${fromTile} at index ${i}`);
        }

        for (let dir = 0; dir < DIR_NAMES.length; dir++) {
          let x2 = x + DX[dir];
          let y2 = y + DY[dir];
          let z2 = z + DZ[dir];

          if (periodic) {
            x2 = (x2 + width) % width;
            y2 = (y2 + height) % height;
            z2 = (z2 + depth) % depth;
          } else if (x2 < 0 || x2 >= width || y2 < 0 || y2 >= height || z2 < 0 || z2 >= depth) {
            continue;
          }

          const j = x2 + y2 * width + z2 * width * height;
          const toTile = result[j];
          if (toTile < 0) continue;
          if (toTile >= tileCount) {
            throw new Error(`result contains invalid tile id ${toTile} at index ${j}`);
          }

          adjacencyChecks++;
          if (!allowed[dir][fromTile].has(toTile)) {
            violations++;
            if (!firstViolation) {
              firstViolation = {
                from: { x, y, z, tile: fromTile },
                to: { x: x2, y: y2, z: z2, tile: toTile },
                fromTile,
                toTile,
                direction: DIR_NAMES[dir],
              };
            }
          }
        }
      }
    }
  }

  const report: ValidationResult3D = {
    valid: violations === 0 && (!complete || unresolvedCells === 0),
    violations,
    adjacencyChecks,
    unresolvedCells,
  };
  if (firstViolation) report.firstViolation = firstViolation;
  return report;
}

if (import.meta.main) {
  const rules: TileRule3D[] = [
    { forTile: 0, left: [0, 1], right: [0, 1], up: [0, 1], down: [0, 1], front: [0, 1], back: [0, 1] },
    { forTile: 1, left: [0, 1], right: [0, 1], up: [0, 1], down: [0, 1], front: [0, 1], back: [0, 1] },
  ];
  const solver = new WFCSolver3D({
    width: 4,
    height: 4,
    depth: 4,
    periodic: false,
    weights: [1, 1],
    rules,
  });
  solver.run(42);
  const report = validate3D(solver.result(), 4, 4, 4, rules, false, true);
  console.log(`3D VALIDATION valid=${report.valid} violations=${report.violations} adjacencyChecks=${report.adjacencyChecks} unresolvedCells=${report.unresolvedCells}`);
}
