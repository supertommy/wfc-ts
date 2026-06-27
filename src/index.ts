// wfc-ts — Wave Function Collapse solver
// Clean API: pass weights and rules, get tile indices back.
// Supports 2D (WFCSolver) and 3D (WFCSolver3D) grids.

// 2D solver
export { WFCSolver } from "./solver.js";

// 3D solver
export { WFCSolver3D } from "./solver-3d.js";

// Shared types
export type {
  TileRule,
  TileRule3D,
  StepStatus,
  Heuristic,
  SearchStrategy,
  SearchOptions,
  WFCSolverOptions,
  WFCSolver3DOptions,
} from "./types.js";

// PRNG (determinism utility)
export { mulberry32, type Random } from "./prng.js";
