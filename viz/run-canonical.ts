/**
 * Run the canonical mxgmn WFC and return the output PNG.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const canonicalDir = join(here, "../../references/WaveFunctionCollapse");

export interface CanonicalRequest {
  tileset: string;
  subset?: string;
  width: number;
  height: number;
  seed: number;
  periodic: boolean;
}

export function runCanonical(req: CanonicalRequest): Buffer | null {
  const { tileset, subset, width, height, seed, periodic } = req;
  
  // Create a temporary samples.xml with just this one case
  const subsetAttr = subset ? `subset="${subset}"` : "";
  const samplesXml = `<samples>
  <simpletiled name="${tileset}" ${subsetAttr} width="${width}" height="${height}" periodic="${periodic ? "True" : "False"}" seed="${seed}" screenshots="1"/>
</samples>`;
  
  const samplesPath = join(canonicalDir, "samples.xml");
  const backupPath = join(canonicalDir, "samples.xml.backup");
  const outputDir = join(canonicalDir, "output");
  
  // Backup original samples.xml
  const originalSamples = readFileSync(samplesPath, "utf-8");
  
  try {
    // Write temporary samples.xml
    writeFileSync(samplesPath, samplesXml);
    
    // Clean output dir
    if (existsSync(outputDir)) {
      for (const file of require("fs").readdirSync(outputDir)) {
        require("fs").unlinkSync(join(outputDir, file));
      }
    } else {
      mkdirSync(outputDir);
    }
    
    // Run the canonical implementation
    execSync("dotnet run -c Release", {
      cwd: canonicalDir,
      timeout: 30000,
      stdio: "pipe",
    });
    
    // Find the output PNG
    const files = require("fs").readdirSync(outputDir);
    const pngFile = files.find((f: string) => f.endsWith(".png"));
    
    if (pngFile) {
      return readFileSync(join(outputDir, pngFile));
    }
    
    return null;
  } catch (e) {
    console.error("Error running canonical:", e);
    return null;
  } finally {
    // Restore original samples.xml
    writeFileSync(samplesPath, originalSamples);
  }
}

// CLI test
if (import.meta.main) {
  const result = runCanonical({
    tileset: "Knots",
    subset: "Standard",
    width: 24,
    height: 24,
    seed: 1234,
    periodic: true,
  });
  
  if (result) {
    writeFileSync("/tmp/canonical-test.png", result);
    console.log("Wrote /tmp/canonical-test.png");
  } else {
    console.log("Failed");
  }
}
