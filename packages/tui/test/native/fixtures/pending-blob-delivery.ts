import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { base64ImageNode, getNativeBlob } from "../../../src/native/blobs";
import type { NativeNode } from "../../../src/native/node";
import { settleNative } from "../../../src/native/settle";
import { initTheme } from "../../../src/theme/theme";
import type { Component } from "../../../src/tui";
import { TspHarness } from "../tsp-harness";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const mode = process.argv[2];
assert.ok(mode);

class EphemeralImage implements Component {
	describe(): NativeNode {
		return base64ImageNode(PNG, "image/png");
	}
	render(): readonly string[] {
		return [];
	}
}

function observeBytes(id: string): WeakRef<Uint8Array> {
	const blob = getNativeBlob(id);
	assert.ok(blob);
	return new WeakRef(blob.bytes);
}

async function collect(): Promise<void> {
	for (let index = 0; index < 6; index++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
}

async function expectReleased(reference: WeakRef<Uint8Array>): Promise<void> {
	const deadline = performance.now() + 3_000;
	do {
		await Bun.sleep(0);
		Bun.gc(true);
		if (reference.deref() === undefined) return;
	} while (performance.now() < deadline);
	assert.fail("the backend retained image bytes after their pending delivery ended");
}

await initTheme(false);
await using root = await TempDir.create("@omp-pending-blobs-");
const cache = mode.startsWith("cache-") ? root.join("blobs") : undefined;
if (cache) await fs.mkdir(cache);
const record = mode === "cache-held" ? root.join("record.jsonl") : undefined;
if (record) Bun.env.PI_TUI_TSP_RECORD = record;
const component = new EphemeralImage();
settleNative(component);
const harness = await TspHarness.start(tui => tui.addChild(component), { answerBlobs: false, blobDir: cache });
try {
	await harness.until(() => harness.terminal.log.some(message => message.verb === "q"));
	const image = harness.find(value => value.k === "image");
	assert.ok(image?.k === "image");
	const id = image.p?.blob;
	assert.equal(typeof id, "string");
	const reference = observeBytes(id!);
	await collect();
	assert.ok(getNativeBlob(id!), "a settled image's pending delivery lost its bytes");
	assert.equal(harness.terminal.blobs.has(id!), false);
	assert.deepEqual(
		harness.terminal.log.filter(message => message.verb === "q").map(message => message.body),
		[{ q: "blobs", ids: [id] }],
	);

	if (mode === "stop" || mode === "reset") {
		if (mode === "stop") harness.tui.stop();
		else {
			harness.tui.removeChild(component);
			await harness.render();
			const lostSurface = harness.terminal.surface!;
			harness.terminal.docs.delete(lostSurface);
			harness.event({ ev: "gone", ids: [lostSurface] });
		}
		harness.flush();
		await expectReleased(reference);
		harness.stall(3_000);
		assert.deepEqual(
			harness.terminal.log.filter(message => message.verb === "b"),
			[],
		);
	} else {
		if (mode === "cache-held") {
			const bytes = await Bun.file(`${cache}/${id}`).bytes();
			assert.deepEqual(bytes, Uint8Array.from(Buffer.from(PNG, "base64")));
			harness.terminal.blobs.set(id!, bytes);
			harness.terminal.send(`\x1b_tsp;r;${JSON.stringify({ r: "blobs", have: [id] })}\x1b\\`);
			harness.flush();
			const messages = (await Bun.file(record!).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { dir: string; verb: string; body: unknown });
			assert.deepEqual(
				messages.filter(message => message.dir === "out" && message.verb === "b").map(message => message.body),
				[PNG],
			);
			assert.deepEqual(
				harness.terminal.log.filter(message => message.verb === "b"),
				[],
			);
		} else {
			if (mode === "reply") {
				harness.terminal.send(`\x1b_tsp;r;${JSON.stringify({ r: "blobs", have: [] })}\x1b\\`);
				harness.flush();
			} else {
				harness.stall(2_999);
				assert.deepEqual(
					harness.terminal.log.filter(message => message.verb === "b"),
					[],
				);
				harness.stall(1);
			}
			assert.deepEqual(
				harness.terminal.log.filter(message => message.verb === "b").map(message => message.body),
				[PNG],
			);
		}
		assert.ok(harness.find(value => value.k === "image" && value.p?.blob === id));
		assert.deepEqual(Buffer.from(harness.terminal.blobs.get(id!)!), Buffer.from(PNG, "base64"));
		await expectReleased(reference);
	}
	assert.deepEqual(harness.errors, []);
} finally {
	harness.stop();
}
process.stdout.write("verified\n");
