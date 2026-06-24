// Find seeds that reliably complete for each candidate input spec, so the
// committed benchmark inputs measure real solve work (not fast-fail
// contradictions). Not part of the harness — a one-shot dev helper.
import { SimpleTiledModel, parseTileset } from "../src/index.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const tilesetsDir = join(dir, "..", "performance-test", "tilesets");

interface Cand {
  name: string;
  tileset: string;
  subset: string | null;
  width: number;
  height: number;
  periodic: boolean;
}
const cands: Cand[] = [
  { name: "knots-standard-24", tileset: "Knots", subset: "Standard", width: 24, height: 24, periodic: true },
  { name: "knots-standard-48", tileset: "Knots", subset: "Standard", width: 48, height: 48, periodic: true },
  { name: "knots-fabric-24", tileset: "Knots", subset: "Fabric", width: 24, height: 24, periodic: true },
  { name: "knots-dense-24", tileset: "Knots", subset: "Dense", width: 24, height: 24, periodic: true },
  { name: "circuit-turnless-34", tileset: "Circuit", subset: "Turnless", width: 34, height: 34, periodic: true },
  { name: "rooms-30", tileset: "Rooms", subset: null, width: 30, height: 30, periodic: false },
];

const cache = new Map<string, string>();
function xml(name: string): string {
  if (!cache.has(name)) cache.set(name, readFileSync(join(tilesetsDir, `${name}.xml`), "utf8"));
  return cache.get(name)!;
}

for (const c of cands) {
  const ts = parseTileset(xml(c.tileset), c.tileset);
  const completing: number[] = [];
  for (let s = 0; s < 60 && completing.length < 5; s++) {
    const m = new SimpleTiledModel({ tileset: ts, subsetName: c.subset, width: c.width, height: c.height, periodic: c.periodic });
    if (m.run(s, -1) && m.isComplete()) completing.push(s);
  }
  console.log(`${c.name.padEnd(22)} completing seeds (first 5): ${JSON.stringify(completing)}`);
}