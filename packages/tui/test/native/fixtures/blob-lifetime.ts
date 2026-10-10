import assert from "node:assert/strict";
import { Image, ImageBudget } from "../../../src/components/image";
import { base64ImageNode, getNativeBlob } from "../../../src/native/blobs";
import { SnapcompactShapePreview } from "../../../src/overlays/snapcompact-shape-preview";
import { AttachmentChipsBand } from "../../../src/prompt/attachment-chips";
import { chipLabel } from "../../../src/prompt/composer-attachments";
import { CustomEditor } from "../../../src/prompt/custom-editor";
import { getEditorTheme, initTheme } from "../../../src/theme/theme";
import type { Component } from "../../../src/tui";
import { TspHarness } from "../tsp-harness";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function component(): Component {
	if (process.argv[2] === "snapcompact") return new SnapcompactShapePreview("auto");
	if (process.argv[2] === "image") return new Image(PNG, "image/png", { fallbackColor: text => text });
	if (process.argv[2] === "attachment") {
		const editor = new CustomEditor(getEditorTheme());
		editor.pendingImages.push({ type: "image", data: PNG, mimeType: "image/png" });
		editor.insertAtom(chipLabel("image", 1), "[Image #1, 1x1]");
		return new AttachmentChipsBand(editor, new ImageBudget(8), () => {});
	}
	const image = base64ImageNode(PNG, "image/png");
	return { describe: () => image, render: () => [] };
}

async function discard(): Promise<{ reference: WeakRef<Uint8Array>; harness: TspHarness }> {
	const image = component();
	const harness = await TspHarness.start(tui => tui.addChild(image));
	try {
		let wire = harness.find(node => node.k === "image");
		if (process.argv[2] === "snapcompact") {
			const deadline = performance.now() + 3_000;
			while (!wire && performance.now() < deadline) {
				await Bun.sleep(10);
				await harness.render();
				wire = harness.find(node => node.k === "image");
			}
		}
		assert.equal(wire?.k, "image");
		const id = wire?.p && "blob" in wire.p ? wire.p.blob : undefined;
		assert.equal(typeof id, "string");
		const blob = getNativeBlob(id!);
		assert.ok(blob);
		const uploaded = harness.terminal.blobs.get(id!);
		assert.deepEqual(uploaded, Buffer.from(blob.bytes));
		const metadata = await new Bun.Image(uploaded!).metadata();
		assert.equal(metadata.width, process.argv[2] === "snapcompact" ? 512 : 1);
		assert.equal(metadata.height, process.argv[2] === "snapcompact" ? 512 : 1);
		const reference = new WeakRef(blob.bytes);
		harness.tui.removeChild(image);
		await harness.render();
		assert.equal(
			harness.find(node => node.k === "image"),
			undefined,
		);
		assert.deepEqual(harness.errors, []);
		return { reference, harness };
	} catch (error) {
		harness.stop();
		throw error;
	}
}

await initTheme(false);
const { reference, harness } = await discard();
const deadline = performance.now() + 3_000;
let collected = false;
do {
	// A dereferenced WeakRef target remains live until the next event-loop turn.
	await Bun.sleep(0);
	Bun.gc(true);
	collected = reference.deref() === undefined;
} while (!collected && performance.now() < deadline);
harness.stop();
assert.equal(collected, true, "discarded native image bytes are still retained after their component was removed");
process.stdout.write("verified\n");
