/**
 * Render EVERY page of a text flow with the production snapcompact renderer.
 *
 * Usage: bun render_pages.ts <text-file> <shape-json> <out-dir>
 *
 * Writes <out-dir>/page-000.png … and prints the page count. Drives the exact
 * shipping pipeline (renderMany: wrap, pagination, stopword dimming).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as snapcompact from "../src/snapcompact";

const [textFile, shapeJson, outDir] = Bun.argv.slice(2);
if (!textFile || !shapeJson || !outDir) {
	throw new Error("usage: bun render_pages.ts <text-file> <shape-json> <out-dir>");
}

const text = await Bun.file(textFile).text();
const shape = JSON.parse(shapeJson) as snapcompact.Shape;
if (!snapcompact.isShape(shape)) {
	throw new Error(`shape json is not a complete Shape: ${shapeJson}`);
}

await fs.mkdir(outDir, { recursive: true });
const frames = await snapcompact.renderMany(text, { shape });
for (let i = 0; i < frames.length; i++) {
	await Bun.write(path.join(outDir, `page-${String(i).padStart(3, "0")}.png`), Buffer.from(frames[i].data, "base64"));
}
console.log(frames.length);
