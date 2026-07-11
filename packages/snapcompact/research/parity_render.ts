/**
 * Production-side renderer for the parity check (`parity_check.py` drives it).
 *
 * Usage: bun parity_render.ts <text-file> <shape-json> <out-png>
 *
 * Renders the FIRST frame of `text` with the production snapcompact pipeline
 * (`renderMany`, so doc pagination and stopword dimming take the exact code
 * path the agent ships) and writes the PNG bytes to `out-png`.
 */
import * as snapcompact from "../src/snapcompact";

const [textFile, shapeJson, outPng] = Bun.argv.slice(2);
if (!textFile || !shapeJson || !outPng) {
	throw new Error("usage: bun parity_render.ts <text-file> <shape-json> <out-png>");
}

const text = await Bun.file(textFile).text();
const shape = JSON.parse(shapeJson) as snapcompact.Shape;
if (!snapcompact.isShape(shape)) {
	throw new Error(`shape json is not a complete Shape: ${shapeJson}`);
}

const frames = await snapcompact.renderMany(text, { shape, maxFrames: 1 });
if (frames.length === 0) {
	throw new Error("renderMany produced no frames");
}
await Bun.write(outPng, Buffer.from(frames[0].data, "base64"));
