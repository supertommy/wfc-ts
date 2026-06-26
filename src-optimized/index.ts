// wfc-ts — Wave Function Collapse solver

// === New clean API ===
export { WFCSolver, type WFCSolverOptions, type TileRule, type Heuristic as HeuristicType } from "./solver.js";
export { type StepStatus } from "./solver.js";

// === Legacy API (backwards compatibility) ===
export { Model, Heuristic, weightedPick } from "./model.js";
export { SimpleTiledModel, type SimpleTiledModelOptions } from "./simple-tiled-model.js";
export { parseTileset, loadTileset, type Tileset, type TileDef, type NeighborDef, type SubsetDef } from "./tileset.js";
export { mulberry32, type Random } from "./prng.js";
