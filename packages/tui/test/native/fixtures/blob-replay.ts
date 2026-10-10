import assert from "node:assert/strict";
import { base64ImageNode, getNativeBlob, registerNativeBlob } from "../../../src/native/blobs";
import { keyed, node, withHidden } from "../../../src/native/describe";
import type { NativeNode } from "../../../src/native/node";
import { settleNative } from "../../../src/native/settle";
import { initTheme } from "../../../src/theme/theme";
import type { Component } from "../../../src/tui";
import { TspHarness } from "../tsp-harness";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

class ImageSlot implements Component {
	current: NativeNode = node("text", { text: "pending" });
	render(): readonly string[] {
		return [];
	}
	describe(): NativeNode {
		return this.current;
	}
}

function wrappedImage(): NativeNode {
	return keyed(withHidden(base64ImageNode(PNG, "image/png", { alt: "kept" }), true), "preview");
}

function blobId(image: NativeNode): string {
	assert.equal(image.k, "image");
	const id = image.p && "blob" in image.p ? image.p.blob : undefined;
	assert.equal(typeof id, "string");
	return id!;
}

async function collect(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
}

await initTheme(false);
const slot = new ImageSlot();
const h = await TspHarness.start(tui => tui.addChild(slot), { credits: 1, autoAck: false });
try {
	slot.current = wrappedImage();
	const id = blobId(slot.current);
	await h.render();
	assert.equal(h.terminal.blobs.has(id), false, "the image must wait for frame credit");
	await collect();
	h.terminal.ackAll();
	h.flush();
	assert.ok(h.find(image => image.k === "image" && image.p?.blob === id));
	assert.deepEqual(h.terminal.blobs.get(id), Buffer.from(PNG, "base64"));
	assert.equal(h.terminal.log.filter(message => message.verb === "b").length, 1);
	assert.deepEqual(
		h.terminal.log.filter(message => message.verb === "q").map(message => message.body),
		[{ q: "blobs", ids: [id] }],
	);

	const alias = new ImageSlot();
	alias.current = base64ImageNode(PNG, "image/png");
	assert.equal(blobId(alias.current), id);
	assert.equal(getNativeBlob(id)?.mime, "image/png");
	settleNative(alias);
	const overlay = h.tui.showOverlay(alias, { fullscreen: true });
	h.flush();
	await collect();
	assert.equal(
		h.terminal.log.filter(message => message.verb === "b").length,
		1,
		"the alternate surface shares the connection's uploaded blobs",
	);
	assert.ok(h.find(image => image.k === "image" && image.p?.blob === id));
	assert.deepEqual(h.terminal.blobs.get(id), Buffer.from(PNG, "base64"));
	overlay.hide();
	h.terminal.ackAll();
	h.flush();

	slot.current = node("text", { text: "removed" });
	await h.render();
	h.terminal.ackAll();
	h.flush();
	await collect();
	assert.deepEqual(Buffer.from(getNativeBlob(id)!.bytes), Buffer.from(PNG, "base64"));
	slot.current = alias.current;
	await h.render();
	h.terminal.ackAll();
	h.flush();
	assert.equal(
		h.terminal.log.filter(message => message.verb === "b").length,
		1,
		"remounting an image on the same connection must reuse the uploaded blob",
	);
	assert.ok(h.find(image => image.k === "image" && image.p?.blob === id));
	assert.deepEqual(h.terminal.blobs.get(id), Buffer.from(PNG, "base64"));

	h.tui.stop();
	h.flush();
	await collect();
	h.tui.start();
	h.flush();
	h.terminal.ackAll();
	h.flush();
	const resumed = new ImageSlot();
	resumed.current = base64ImageNode(PNG, "image/png");
	h.tui.addChild(resumed);
	await h.render();
	h.terminal.ackAll();
	h.flush();
	assert.equal(h.terminal.log.filter(message => message.verb === "b").length, 1);
	assert.deepEqual(
		h.terminal.log.filter(message => message.verb === "q").map(message => message.body),
		[
			{ q: "blobs", ids: [id] },
			{ q: "blobs", ids: [id] },
		],
	);
	assert.ok(h.find(image => image.k === "image" && image.p?.blob === id));
	assert.deepEqual(h.terminal.blobs.get(id), Buffer.from(PNG, "base64"));
	const lostSurface = h.terminal.surface!;
	h.terminal.docs.delete(lostSurface);
	h.terminal.blobs.clear();
	h.event({ ev: "gone", ids: [lostSurface] });
	assert.equal(
		h.terminal.log.filter(message => message.verb === "b").length,
		2,
		"a lost surface whose terminal no longer holds the blob needs its image uploaded again",
	);
	assert.deepEqual(
		h.terminal.log.filter(message => message.verb === "q").map(message => message.body),
		[
			{ q: "blobs", ids: [id] },
			{ q: "blobs", ids: [id] },
			{ q: "blobs", ids: [id] },
		],
	);
	assert.ok(h.find(image => image.k === "image" && image.p?.blob === id));
	assert.deepEqual(h.terminal.blobs.get(id), Buffer.from(PNG, "base64"));
	assert.deepEqual(h.errors, []);
} finally {
	h.stop();
}

function registerLegacy(): string {
	return registerNativeBlob(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml");
}
const legacy = registerLegacy();
await collect();
assert.equal(
	getNativeBlob(legacy)?.mime,
	"image/svg+xml",
	"string-only registrations must remain usable without an owner",
);
process.stdout.write("verified\n");
