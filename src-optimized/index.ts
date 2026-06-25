// wfc-ts — Wave Function Collapse (simple tiled model) in TypeScript.
//
// Public API surface. The reference implementation lives in src/; the
// optimized solver (src-optimized/) is a separate entrypoint added in Phase 3.

export { Model, Heuristic, weightedPick, type StepStatus } from "./model.js";
export { SimpleTiledModel, type SimpleTiledModelOptions } from "./simple-tiled-model.js";
export { parseTileset, loadTileset, type Tileset, type TileDef, type NeighborDef, type SubsetDef } from "./tileset.js";
export { mulberry32, type Random } from "./prng.js";