import { expect, it } from "bun:test";
import type { TspEditorDecoration } from "@oh-my-pi/pi-wire";
import { chipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { TspHarness } from "./tsp-harness";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

it("names a staged image's blob on its token and sends the terminal its bytes", async () => {
	await initTheme(false);
	const editor = new CustomEditor(getEditorTheme());
	editor.pendingImages.push({ type: "image", data: PNG, mimeType: "image/png" });
	const label = chipLabel("image", 1);
	editor.insertAtom(label, "[Image #1]");
	// No chips band: the token's decoration alone must deliver the image.
	const harness = await TspHarness.start(tui => tui.addChild(editor));
	try {
		const field = harness.findAll(node => node.k === "editor")[0];
		const decor: readonly TspEditorDecoration[] = field?.p && "decor" in field.p ? (field.p.decor ?? []) : [];
		const token = decor.find(range => range.blob !== undefined);
		expect(token).toMatchObject({ from: 0, to: label.length });
		expect(harness.terminal.blobs.get(token!.blob!)).toEqual(Buffer.from(PNG, "base64"));
		expect(harness.errors).toEqual([]);
	} finally {
		harness.stop();
	}
});
