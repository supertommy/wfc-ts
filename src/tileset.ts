// Minimal parser for the mxgmn tileset XML format.
//
// mxgmn uses System.Xml.Linq (C# stdlib). Node/Bun have no built-in XML parser,
// and adding a dependency just to read this regular, flat format would betray
// the reference's "stdlib only" spirit. This is a constrained parser for the
// tileset schema (`<set>` with `<tiles>`, `<neighbors>`, `<subsets>`), not a
// general XML parser — and it's tested against the real committed tilesets.
//
// Bitmap PNGs are NOT loaded here: they're rendering-only. The WFC algorithm
// needs only tile names, symmetry metadata, weights, and adjacency.

export interface TileDef {
  name: string;
  symmetry: string; // one of L T I \ F X  (default X)
  weight: number; // default 1
}

export interface NeighborDef {
  left: string; // "name" or "name index"
  right: string;
}

export interface SubsetDef {
  name: string;
  tiles: string[];
}

export interface Tileset {
  name: string;
  unique: boolean;
  tiles: TileDef[];
  neighbors: NeighborDef[];
  subsets: SubsetDef[];
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] ?? undefined : undefined;
}

/** Parse a mxgmn tileset XML string into structured data. */
export function parseTileset(xml: string, name: string): Tileset {
  const setTag = xml.match(/<set\b[^>]*>/);
  const unique = setTag ? attr(setTag[0], "unique") === "true" : false;

  // Scope each section: `<tile>` appears both as a tile definition (in <tiles>)
  // and as a subset member reference (in <subsets>). Only the <tiles> block
  // defines tiles; subset refs are parsed within their <subset> below.
  const tilesBlock = xml.match(/<tiles\b[^>]*>([\s\S]*?)<\/tiles>/)?.[1] ?? "";
  const neighborsBlock = xml.match(/<neighbors\b[^>]*>([\s\S]*?)<\/neighbors>/)?.[1] ?? "";

  const tiles: TileDef[] = [];
  for (const m of tilesBlock.matchAll(/<tile\b[^>]*\/?>/g)) {
    const tag = m[0];
    const tname = attr(tag, "name");
    if (tname === undefined) continue;
    tiles.push({
      name: tname,
      symmetry: attr(tag, "symmetry") ?? "X",
      weight: attr(tag, "weight") !== undefined ? Number(attr(tag, "weight")) : 1,
    });
  }

  const neighbors: NeighborDef[] = [];
  for (const m of neighborsBlock.matchAll(/<neighbor\b[^>]*\/?>/g)) {
    const tag = m[0];
    const left = attr(tag, "left");
    const right = attr(tag, "right");
    if (left !== undefined && right !== undefined) {
      neighbors.push({ left, right });
    }
  }

  const subsets: SubsetDef[] = [];
  for (const m of xml.matchAll(/<subset\b[^>]*>([\s\S]*?)<\/subset>/g)) {
    const subTag = m[0];
    const sname = attr(subTag, "name");
    if (sname === undefined) continue;
    const inner = m[1] ?? "";
    const subTiles: string[] = [];
    for (const tm of inner.matchAll(/<tile\b[^>]*\/?>/g)) {
      const tn = attr(tm[0], "name");
      if (tn !== undefined) subTiles.push(tn);
    }
    subsets.push({ name: sname, tiles: subTiles });
  }

  return { name, unique, tiles, neighbors, subsets };
}

export function loadTileset(xml: string, name: string): Tileset {
  return parseTileset(xml, name);
}