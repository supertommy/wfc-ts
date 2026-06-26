import { readFileSync } from "node:fs";
import { SimpleTiledModel, parseTileset } from "../helpers/index.js";
const xml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
const ts = parseTileset(xml, "Knots");
let complete = 0, fail = 0;
for (let s = 0; s < 30; s++) {
  const m = new SimpleTiledModel({ tileset: ts, subsetName: "Dense", width: 24, height: 24, periodic: true });
  const ok = m.run(s, -1);
  if (ok && m.isComplete()) complete++; else fail++;
}
console.log(`Dense 24x24 over 30 seeds: ${complete} complete, ${fail} contradiction`);
