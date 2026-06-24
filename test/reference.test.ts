import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SimpleTiledModel, parseTileset } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const tilesetsDir = join(here, "..", "performance-test", "tilesets");

function loadTileset(name: string) {
  const xml = readFileSync(join(tilesetsDir, `${name}.xml`), "utf8");
  return parseTileset(xml, name);
}

describe("reference SimpleTiledModel — Knots tileset", () => {
  it("parses the Knots tileset", () => {
    const ts = loadTileset("Knots");
    expect(ts.tiles.length).toBe(5); // corner, cross, empty, line, t
    expect(ts.tiles.map((t) => t.name).sort()).toEqual(["corner", "cross", "empty", "line", "t"]);
    expect(ts.neighbors.length).toBeGreaterThan(0);
    expect(ts.subsets.find((s) => s.name === "Standard")).toBeDefined();
  });

  it("builds the propagator with the expected variant count", () => {
    const ts = loadTileset("Knots");
    // Standard subset = corner(L,4) + cross(I,2) + empty(X,1) + line(I,2) = 9 variants
    const model = new SimpleTiledModel({
      tileset: ts,
      subsetName: "Standard",
      width: 10,
      height: 10,
      periodic: true,
    });
    expect(model.tilenames.length).toBe(9);
    expect(model.tilenames).toContain("corner 0");
    expect(model.tilenames).toContain("cross 1");
  });

  it("runs to completion and produces a valid-looking tiling", () => {
    const ts = loadTileset("Knots");
    const model = new SimpleTiledModel({
      tileset: ts,
      subsetName: "Standard",
      width: 24,
      height: 24,
      periodic: true,
    });
    const ok = model.run(1, -1);
    expect(ok).toBe(true);
    expect(model.isComplete()).toBe(true);

    // Every cell should have collapsed to a valid variant index.
    const result = model.result();
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThan(model.tilenames.length);
    }
  });

  it("is deterministic — same seed yields identical output", () => {
    const ts = loadTileset("Knots");
    const runOnce = () => {
      const m = new SimpleTiledModel({
        tileset: ts,
        subsetName: "Standard",
        width: 24,
        height: 24,
        periodic: true,
      });
      m.run(42, -1);
      return Array.from(m.result());
    };
    const a = runOnce();
    const b = runOnce();
    expect(b).toEqual(a);
  });
});