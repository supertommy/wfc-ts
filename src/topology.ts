// Topology abstraction for WFC — separates grid layout from algorithm logic.
// Enables 2D, 3D, and future graph-based WFC with the same engine.

/**
 * Topology defines the connectivity between cells.
 * The engine uses this to navigate neighbors without knowing grid dimensions.
 */
export interface Topology {
  /** Total number of cells. */
  readonly cellCount: number;
  /** Number of directions (4 for 2D, 6 for 3D, variable for graphs). */
  readonly directionCount: number;
  /** Returns neighbor cell index for (cell, direction), or -1 if out of bounds. */
  neighbor(cell: number, dir: number): number;
  /** Returns the opposite direction index. */
  opposite(dir: number): number;
}

// 2D direction constants (matches mxgmn convention)
// DX/DY: left=0, up=1, right=2, down=3
const DX_2D = [-1, 0, 1, 0];
const DY_2D = [0, 1, 0, -1];

/**
 * 2D grid topology with optional periodic (torus) wrapping.
 * Direction mapping: left=0, up=1, right=2, down=3
 */
export class GridTopology2D implements Topology {
  readonly cellCount: number;
  readonly directionCount = 4;
  
  private readonly neighbors: Int32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly periodic: boolean
  ) {
    const count = width * height;
    this.cellCount = count;
    
    // Precompute neighbor table for fast lookup
    this.neighbors = new Int32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const x1 = i % width;
      const y1 = (i / width) | 0;
      for (let d = 0; d < 4; d++) {
        let x2 = x1 + DX_2D[d];
        let y2 = y1 + DY_2D[d];
        let nei: number;
        if (!periodic && (x2 < 0 || y2 < 0 || x2 >= width || y2 >= height)) {
          nei = -1;
        } else {
          if (x2 < 0) x2 += width;
          else if (x2 >= width) x2 -= width;
          if (y2 < 0) y2 += height;
          else if (y2 >= height) y2 -= height;
          nei = x2 + y2 * width;
        }
        this.neighbors[i * 4 + d] = nei;
      }
    }
  }

  neighbor(cell: number, dir: number): number {
    return this.neighbors[cell * 4 + dir];
  }

  opposite(dir: number): number {
    // 0↔2, 1↔3 (left↔right, up↔down)
    return (dir + 2) % 4;
  }
}

// 3D direction constants
// dir: 0=left(-X), 1=right(+X), 2=up(+Y), 3=down(-Y), 4=front(-Z), 5=back(+Z)
const DX_3D = [-1, 1, 0, 0, 0, 0];
const DY_3D = [0, 0, 1, -1, 0, 0];
const DZ_3D = [0, 0, 0, 0, -1, 1];

/**
 * 3D grid topology with optional periodic (3-torus) wrapping.
 * Direction mapping: left=0, right=1, up=2, down=3, front=4, back=5
 */
export class GridTopology3D implements Topology {
  readonly cellCount: number;
  readonly directionCount = 6;
  
  private readonly neighbors: Int32Array;
  private readonly MXY: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly depth: number,
    readonly periodic: boolean
  ) {
    const count = width * height * depth;
    this.cellCount = count;
    this.MXY = width * height;
    
    // Precompute neighbor table for fast lookup
    this.neighbors = new Int32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const x1 = i % width;
      const y1 = ((i / width) | 0) % height;
      const z1 = (i / this.MXY) | 0;
      
      for (let d = 0; d < 6; d++) {
        let x2 = x1 + DX_3D[d];
        let y2 = y1 + DY_3D[d];
        let z2 = z1 + DZ_3D[d];
        let nei: number;
        
        if (!periodic && (x2 < 0 || y2 < 0 || z2 < 0 || x2 >= width || y2 >= height || z2 >= depth)) {
          nei = -1;
        } else {
          if (x2 < 0) x2 += width;
          else if (x2 >= width) x2 -= width;
          if (y2 < 0) y2 += height;
          else if (y2 >= height) y2 -= height;
          if (z2 < 0) z2 += depth;
          else if (z2 >= depth) z2 -= depth;
          nei = x2 + y2 * width + z2 * this.MXY;
        }
        this.neighbors[i * 6 + d] = nei;
      }
    }
  }

  neighbor(cell: number, dir: number): number {
    return this.neighbors[cell * 6 + dir];
  }

  opposite(dir: number): number {
    // 0↔1, 2↔3, 4↔5 (left↔right, up↔down, front↔back)
    return dir % 2 === 0 ? dir + 1 : dir - 1;
  }
}
