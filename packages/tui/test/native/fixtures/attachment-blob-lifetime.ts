import assert from "node:assert/strict";
import { ImageBudget } from "../../../src/components/image";
import { getNativeBlob } from "../../../src/native/blobs";
import { AttachmentChipsBand } from "../../../src/prompt/attachment-chips";
import { chipLabel } from "../../../src/prompt/composer-attachments";
import { CustomEditor } from "../../../src/prompt/custom-editor";
import { getEditorTheme, initTheme } from "../../../src/theme/theme";
import { TspHarness } from "../tsp-harness";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function stageImage(editor: CustomEditor, data: string): void {
	editor.pendingImages.push({ type: "image", data, mimeType: "image/png" });
	const n = editor.pendingImages.length;
	editor.insertAtom(chipLabel("image", n), `[Image #${n}]`);
}

async function mount(editor: CustomEditor): Promise<TspHarness> {
	const band = new AttachmentChipsBand(editor, new ImageBudget(8), () => {});
	return TspHarness.start(tui => {
		tui.addChild(band);
		tui.addChild(editor);
	});
}

function uploaded(harness: TspHarness, index: number, data: string): { id: string; reference: WeakRef<Uint8Array> } {
	const wire = harness.findAll(node => node.k === "image")[index];
	const id = wire?.p && "blob" in wire.p ? wire.p.blob : undefined;
	assert.equal(typeof id, "string");
	const blob = getNativeBlob(id!);
	assert.ok(blob);
	assert.deepEqual(harness.terminal.blobs.get(id!), Buffer.from(data, "base64"));
	return { id: id!, reference: new WeakRef(blob.bytes) };
}

function deleteLastChip(editor: CustomEditor): void {
	editor.moveToMessageEnd();
	if (editor.getText().endsWith(" ")) editor.handleInput("\x7f");
	editor.handleInput("\x7f");
}

async function collect(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
}

async function waitForCollection(reference: WeakRef<Uint8Array>): Promise<void> {
	const deadline = performance.now() + 3_000;
	do {
		await collect();
		if (reference.deref() === undefined) return;
	} while (performance.now() < deadline);
}

function replay(harness: TspHarness, id: string, data: string): void {
	const uploads = harness.terminal.log.filter(message => message.verb === "b").length;
	const surface = harness.terminal.surface!;
	harness.terminal.docs.delete(surface);
	harness.terminal.blobs.clear();
	harness.event({ ev: "gone", ids: [surface] });
	assert.equal(harness.terminal.log.filter(message => message.verb === "b").length, uploads + 1);
	assert.deepEqual(harness.terminal.blobs.get(id), Buffer.from(data, "base64"));
}

await initTheme(false);
const editor = new CustomEditor(getEditorTheme());
stageImage(editor, PNG);
const harness = await mount(editor);
let sharedHarness: TspHarness | undefined;
try {
	const initial = uploaded(harness, 0, PNG);
	deleteLastChip(editor);
	await harness.render();
	assert.equal(harness.findAll(node => node.k === "image").length, 0);
	await waitForCollection(initial.reference);
	assert.deepEqual(
		{
			chipCount: editor.composerChips().length,
			pendingImages: editor.pendingImages.length,
			blobAlive: initial.reference.deref() !== undefined,
		},
		{ chipCount: 0, pendingImages: 1, blobAlive: false },
		"deleting the final chip must release its decoded bytes while the draft stays open",
	);
	assert.equal(editor.pendingImages[0]!.data, PNG);

	editor.handleInput("\x1f");
	assert.equal(editor.composerChips().length, 1, "undo must restore the deleted attachment token");
	await harness.render();
	const restored = uploaded(harness, 0, PNG);
	assert.equal(restored.id, initial.id);
	await collect();
	replay(harness, restored.id, PNG);

	const otherPng = await new Bun.Image(Buffer.from(PNG, "base64")).resize(2, 1).png().toBase64();
	stageImage(editor, otherPng);
	stageImage(editor, PNG);
	await harness.render();
	const other = uploaded(harness, 1, otherPng);
	assert.notEqual(other.id, restored.id);
	assert.equal(uploaded(harness, 2, PNG).id, restored.id, "identical attachments share the uploaded blob");

	const sharedEditor = new CustomEditor(getEditorTheme());
	sharedEditor.pendingImages.push(editor.pendingImages[2]!);
	sharedEditor.insertAtom(chipLabel("image", 1), "[Image #1]");
	sharedHarness = await mount(sharedEditor);
	assert.equal(uploaded(sharedHarness, 0, PNG).id, restored.id);
	deleteLastChip(editor);
	await harness.render();
	deleteLastChip(editor);
	await harness.render();
	await waitForCollection(other.reference);
	assert.equal(other.reference.deref(), undefined, "a removed image must be released while another chip remains");
	assert.equal(editor.composerChips().length, 1);
	assert.equal(harness.findAll(node => node.k === "image").length, 1);
	assert.notEqual(restored.reference.deref(), undefined);
	await harness.render();
	replay(harness, restored.id, PNG);

	deleteLastChip(editor);
	await harness.render();
	await collect();
	assert.equal(editor.composerChips().length, 0);
	assert.notEqual(restored.reference.deref(), undefined, "another surface still owns the same image");
	replay(sharedHarness, restored.id, PNG);
	deleteLastChip(sharedEditor);
	await sharedHarness.render();
	await waitForCollection(restored.reference);
	assert.equal(restored.reference.deref(), undefined, "the last visible chip must release the shared image");
	assert.equal(editor.pendingImages.length, 3);
	assert.equal(sharedEditor.pendingImages.length, 1);
	assert.deepEqual(harness.errors, []);
	assert.deepEqual(sharedHarness.errors, []);
} finally {
	sharedHarness?.stop();
	harness.stop();
}
process.stdout.write("verified\n");
