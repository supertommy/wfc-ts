// Shared types for wfc-ts — used by WFCSolver (2D) and WFCSolver3D (3D)

/**
 * Selection heuristic for picking the next cell to observe.
 * - 'mrv': Minimum Remaining Values (fastest, most constraint-propagation)
 * - 'entropy': Shannon entropy (weighted probability)
 * - 'scanline': Simple left-to-right, top-to-bottom
 */
export type Heuristic = 'mrv' | 'entropy' | 'scanline';

export type SearchStrategy = 'restart' | 'backtrack';

export interface SearchOptions {
  /** Default: 'restart'. 'backtrack' enables bounded decision-stack search inside each restart attempt. */
  strategy?: SearchStrategy;
  /** Maximum checkpoint restores per outer restart attempt. Default: 4096 when strategy='backtrack'. */
  maxBacktracks?: number;
  /** Maximum decision checkpoints retained at once. Default: 256 when strategy='backtrack'. */
  maxDepth?: number;
}

/**
 * Adjacency rule for a single tile in 2D.
 * Lists which tiles can be adjacent in each direction.
 */
export interface TileRule {
  forTile: number;
  left: number[];   // -X
  right: number[];  // +X
  up: number[];     // +Y
  down: number[];   // -Y
}

/**
 * Adjacency rule for a single tile in 3D.
 * Lists which tiles can be adjacent in each of 6 directions.
 */
export interface TileRule3D {
  forTile: number;
  left: number[];   // -X
  right: number[];  // +X
  up: number[];     // +Y
  down: number[];   // -Y
  front: number[];  // -Z
  back: number[];   // +Z
}

/**
 * Progress / result status yielded by stepRun().
 * - done=false: intermediate step, observedCell indicates which cell was just collapsed
 * - done=true, ok=true, complete=true: solve succeeded
 * - done=true, ok=false, complete=false: solve failed (contradiction or limit reached)
 */
export interface StepStatus {
  done: boolean;
  observedCell?: number;
  attempt: number;
  cellsResolved: number;
  ok?: boolean;
  complete?: boolean;
  backtracks?: number;
}

/**
 * Options for WFCSolver (2D).
 */
export interface WFCSolverOptions {
  width: number;
  height: number;
  periodic: boolean;
  
  /** Weight per tile (length = number of tiles). Higher = more likely to be picked. */
  weights: number[] | Float64Array;
  
  /** Adjacency rules for each tile. */
  rules: TileRule[];
  
  /** Selection heuristic. Default: 'mrv' (fastest). */
  heuristic?: Heuristic;
  
  /** Search strategy. Default: restart-only. */
  search?: SearchOptions;
}

/**
 * Options for WFCSolver3D (3D).
 */
export interface WFCSolver3DOptions {
  width: number;
  height: number;
  depth: number;
  periodic: boolean;
  
  /** Weight per tile (length = number of tiles). Higher = more likely to be picked. */
  weights: number[] | Float64Array;
  
  /** Adjacency rules for each tile in 6 directions. */
  rules: TileRule3D[];
  
  /** Selection heuristic. Default: 'mrv' (fastest). */
  heuristic?: Heuristic;
  
  /** Search strategy. Default: restart-only. */
  search?: SearchOptions;
}
