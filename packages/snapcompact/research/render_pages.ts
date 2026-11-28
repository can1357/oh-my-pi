/**
 * Render EVERY page of a text flow with the production snapcompact renderer.
 *
 * Usage: bun render_pages.ts <text-file> <shape-json> <out-dir>
 *        bun render_pages.ts --resolve-shape <model-id> <variant|auto>
 *
 * Writes <out-dir>/page-000.png … and prints the page count. Drives the exact
 * shipping pipeline (renderMany: wrap, pagination, stopword dimming).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as snapcompact from "../src/snapcompact";

const [mode, argument, target] = Bun.argv.slice(2);
if (!mode || !argument || !target) {
	throw new Error("usage: bun render_pages.ts <text-file> <shape-json> <out-dir> | --resolve-shape <model-id> <variant|auto>");
}

if (mode === "--resolve-shape") {
	if (target !== "auto" && !snapcompact.isShapeVariantName(target)) throw new Error(`Unknown shape: ${target}`);
	console.log(JSON.stringify(snapcompact.resolveShape({ id: argument }, target)));
} else {
	const text = await Bun.file(mode).text();
	const shape: unknown = JSON.parse(argument);
	if (!snapcompact.isShape(shape)) throw new Error(`shape json is not a complete Shape: ${argument}`);

	const frames = await snapcompact.renderMany(text, { shape });
	if (frames.length === 0) throw new Error("No snapcompact frames: empty text or no single installed font covers the input");
	await fs.mkdir(target, { recursive: true });
	for (const [i, frame] of frames.entries()) {
		await Bun.write(path.join(target, `page-${String(i).padStart(3, "0")}.png`), Buffer.from(frame.data, "base64"));
	}
	console.log(frames.length);
}
