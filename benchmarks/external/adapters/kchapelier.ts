// Adapter for kchapelier/wavefunctioncollapse (npm: wavefunctioncollapse)
// Reads reference source for API: SimpleTiledModel(data, subsetName, w, h, periodic)
// data mirrors mxgmn XML: raw tiles with symmetry+weight+bitmap(dummy), neighbors as strings, subsets obj.

import type { Tileset } from "../../../helpers/tileset.js";
import * as WFCmod from "wavefunctioncollapse";

const SimpleTiledModelCtor: any = (WFCmod as any).SimpleTiledModel;

export interface SolverInstance {
  generate(rng: () => number): boolean;
}

export function buildKchapelierData(tileset: Tileset, subsetName: string | null): any {
  const sub = subsetName ? tileset.subsets.find((s) => s.name === subsetName) : null;
  const subsetSet = sub ? new Set(sub.tiles) : null;

  const tiles = tileset.tiles
    .filter((t) => !subsetSet || subsetSet.has(t.name))
    .map((t) => ({
      name: t.name,
      symmetry: t.symmetry,
      weight: t.weight,
      // dummy 1x1 RGBA; ctor always processes bitmaps even if we never call graphics()
      bitmap: new Uint8Array([200, 200, 200, 255]),
    }));

  const subsets: Record<string, string[]> = {};
  for (const s of tileset.subsets) {
    subsets[s.name] = s.tiles.slice();
  }

  return {
    tilesize: 1,
    unique: !!tileset.unique,
    tiles,
    neighbors: tileset.neighbors.map((n) => ({ left: n.left, right: n.right })),
    subsets,
  };
}

export function createKchapelierModel(
  tileset: Tileset,
  subsetName: string | null,
  width: number,
  height: number,
  periodic: boolean,
): { model: any; generate: (rng: () => number) => boolean } {
  const data = buildKchapelierData(tileset, subsetName);
  const model = new SimpleTiledModelCtor(data, subsetName || null, width, height, periodic);
  return {
    model,
    generate: (rng: () => number) => model.generate(rng),
  };
}
