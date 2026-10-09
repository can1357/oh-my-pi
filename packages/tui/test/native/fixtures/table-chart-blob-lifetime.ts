import assert from "node:assert/strict";
import {
	describeTableChart,
	lookupTableChart,
	setTableCharts,
	splitTableCharts,
	type TableChart,
} from "../../../src/chat/table-chart";
import { prepareSvg } from "../../../src/chat/svg-source";
import { svgFigurePalette } from "../../../src/chat/svg-figure";
import { getNativeBlob } from "../../../src/native/blobs";
import type { NativeNode } from "../../../src/native/node";
import { initTheme, setTheme } from "../../../src/theme/theme";

function chart(label: string): TableChart {
	const source = `| Section | Time |\n|---|---|\n| ${label} | 10879 ms |\n| other | 20.5 ms |\n| context | 1.2 s |\n| rest | 9 ms |`;
	const segment = splitTableCharts(source, false).find(segment => segment.kind === "chart");
	assert.ok(segment?.kind === "chart");
	const found = lookupTableChart(segment.table);
	assert.ok(found && !(found instanceof Promise));
	return found;
}

function payload(image: NativeNode): { id: string; reference: WeakRef<Uint8Array>; svg: string } {
	assert.equal(image.k, "image");
	assert.ok(image.p && "blob" in image.p && typeof image.p.blob === "string");
	const id = image.p.blob;
	const blob = getNativeBlob(id);
	assert.ok(blob);
	assert.equal(blob.mime, "image/svg+xml");
	return { id, reference: new WeakRef(blob.bytes), svg: new TextDecoder().decode(blob.bytes) };
}

function describe(found: TableChart, key: string): NativeNode {
	const image = describeTableChart(found, key);
	assert.equal(image.key, key);
	assert.deepEqual(JSON.parse(JSON.stringify(image.p)), {
		blob: payload(image).id,
		alt: found.alt,
		w: found.width,
		h: found.height,
		max: { w: `${Math.round(found.width / 8)}ch` },
	});
	assert.equal(payload(image).svg, prepareSvg(found.svg, svgFigurePalette()));
	return image;
}

function snapshot(found: TableChart, key: string): { id: string; reference: WeakRef<Uint8Array>; svg: string } {
	return payload(describe(found, key));
}

async function collect(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
}

async function released(reference: WeakRef<Uint8Array>, message: string): Promise<void> {
	const deadline = performance.now() + 3_000;
	do {
		await collect();
		if (reference.deref() === undefined) return;
	} while (performance.now() < deadline);
	assert.equal(reference.deref() === undefined, true, message);
}

function fillCache(): void {
	for (let index = 0; index < 256; index++) chart(`replacement-${index}`);
}

async function retainImageAfterEviction(): Promise<WeakRef<Uint8Array>> {
	const image = describe(chart("visible-owner"), "visible-owner");
	const expected = payload(image);
	fillCache();
	await collect();
	assert.notEqual(expected.reference.deref(), undefined, "a live native node must retain an evicted chart's bytes");
	assert.equal(payload(image).svg, expected.svg);
	return expected.reference;
}

async function verifyEviction(): Promise<void> {
	const cached = snapshot(chart("evicted-chart"), "initial");
	await collect();
	assert.notEqual(
		cached.reference.deref(),
		undefined,
		"the chart cache must retain its native bytes between descriptions",
	);
	assert.equal(snapshot(chart("evicted-chart"), "remounted").id, cached.id);
	fillCache();
	await released(cached.reference, "chart SVG bytes remain retained after their last cache entry was evicted");
	const live = await retainImageAfterEviction();
	await released(live, "chart SVG bytes remain retained after the evicted chart's native node was dropped");
}

async function replaceTheme(): Promise<void> {
	const found = chart("theme-change");
	const dark = snapshot(found, "dark");
	await setTheme("light");
	const light = snapshot(found, "light");
	assert.notEqual(light.id, dark.id);
	await released(dark.reference, "the replaced theme's chart SVG bytes remain retained");
	await collect();
	assert.equal(snapshot(found, "remounted-light").svg, light.svg);
	setTableCharts("off");
}

function clearCache(): WeakRef<Uint8Array> {
	setTableCharts("always");
	const cleared = snapshot(chart("cleared-chart"), "cleared");
	setTableCharts("off");
	return cleared.reference;
}

await initTheme(false);
await setTheme("dark");
setTableCharts("always");
if (process.argv[2] === "theme") {
	await replaceTheme();
	const cleared = clearCache();
	await released(cleared, "chart SVG bytes remain retained after chart caching was cleared");
} else {
	assert.equal(process.argv[2], "eviction");
	await verifyEviction();
	setTableCharts("off");
}
process.stdout.write("verified\n");
