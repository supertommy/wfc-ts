import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InputSpec, RunResult } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export const inputsDir = join(root, "performance-test", "inputs");
export const tilesetsDir = join(root, "performance-test", "tilesets");

export function loadInputSpec(name: string): InputSpec {
  const raw = readFileSync(join(inputsDir, `${name}.json`), "utf8");
  return JSON.parse(raw) as InputSpec;
}

export function tilesetXml(name: string): string {
  return readFileSync(join(tilesetsDir, `${name}.xml`), "utf8");
}

/** sha256 of the bytes of an Int32Array's underlying buffer. */
export function checksum(observed: Int32Array): string {
  // Copy to a fresh ArrayBuffer-backed view so the hash is over exactly the
  // meaningful bytes (Int32Array over a larger buffer would include garbage).
  const copy = new Int32Array(observed.length);
  copy.set(observed);
  return createHash("sha256").update(Buffer.from(copy.buffer)).digest("hex");
}

/** Serialize a run result to a stable, diff-friendly text format. */
export function writeResult(result: RunResult, path: string): void {
  const { spec, ok, complete, checksum, elapsedMs } = result;
  const lines = [
    `# wfc-ts result`,
    `name: ${spec.name}`,
    `tileset: ${spec.tileset}`,
    `subset: ${spec.subset ?? ""}`,
    `size: ${spec.width}x${spec.height}`,
    `periodic: ${spec.periodic}`,
    `seed: ${spec.seed}`,
    `ok: ${ok}`,
    `complete: ${complete}`,
    `checksum: ${checksum}`,
    `elapsed_ms: ${elapsedMs.toFixed(4)}`,
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/** Read a result file's metadata (not the full observed array — compare works
 * on checksums; validate re-runs the solver to get the array). */
export interface ResultMeta {
  name: string;
  tileset: string;
  subset: string;
  size: string;
  periodic: boolean;
  seed: number;
  ok: boolean;
  complete: boolean;
  checksum: string;
  elapsedMs: number;
}

export function readResultMeta(path: string): ResultMeta {
  const text = readFileSync(path, "utf8");
  const meta = {} as Record<string, string>;
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2];
  }
  return {
    name: meta.name ?? "",
    tileset: meta.tileset ?? "",
    subset: meta.subset ?? "",
    size: meta.size ?? "",
    periodic: meta.periodic === "true",
    seed: Number(meta.seed ?? "0"),
    ok: meta.ok === "true",
    complete: meta.complete === "true",
    checksum: meta.checksum ?? "",
    elapsedMs: Number(meta.elapsed_ms ?? "0"),
  };
}