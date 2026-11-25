/**
 * Annotating an image chip in Tern: where the terminal annotates images, the chip's picture asks
 * for Tern's annotator on click, and the picture Tern hands back on Done becomes the chip's image,
 * so the prompt sends the annotated picture. A value that is not a picture changes nothing.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, isUiNode, type JSXNode, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { getBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { Composer, ComposerChips, type DraftImage } from "../../../src/ui/composer";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
/** Stand-in bytes of the annotated picture Tern returns. */
const ANNOTATED_JPEG = Buffer.from("annotated jpeg bytes").toString("base64");

/** A node as the native backend describes it. */
interface NativeNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly NativeNode[];
}

function described(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(described)];
}

function imageNode(node: UiNode): UiNode | undefined {
	if (node.kind === "image") return node;
	for (const child of node.children()) {
		const found = imageNode(child);
		if (found) return found;
	}
	return undefined;
}

/** A composer holding one pasted image chip (a 640×480 picture by its marker) and its band in Tern. */
function attached(): { composer: Composer; band: UiNode; original: DraftImage } {
	const composer = new Composer();
	const original: DraftImage = { type: "image", data: PNG_1PX, mimeType: "image/png" };
	composer.insertAtom(composer.chipLabel("image", 1), "[Image #1, 640x480]", { kind: "image", image: original });
	const band: JSXNode = ComposerChips({ composer, annotate: () => true });
	if (!isUiNode(band)) throw new Error("the band is one node");
	return { composer, band, original };
}

describe("annotating an image chip", () => {
	test("the annotated picture replaces the chip's image: the card shows it and the prompt sends it", () => {
		createRoot(dispose => {
			const { composer, band } = attached();
			const env = staticEnvironment(currentTheme());
			const picture = () => described(describeTree(band, env) as NativeNode).find(node => node.k === "image")?.p;
			expect(picture()).toMatchObject({ actions: { click: "annotate" }, title: "Annotate" });

			imageNode(band)?.handlers.onChange?.({
				type: "change",
				key: "",
				value: { mime: "image/jpeg", data: ANNOTATED_JPEG, w: 640, h: 480 },
			});

			const annotated = { data: ANNOTATED_JPEG, mimeType: "image/jpeg" };
			expect(composer.pendingImages).toMatchObject([annotated]);
			// The chip keeps its token and marker, and its card shows the annotated picture.
			expect(composer.chips().map(chip => [chip.label, chip.expansion])).toEqual([
				[composer.chipLabel("image", 1), "[Image #1, 640x480]"],
			]);
			const blob = String(picture()?.blob);
			expect(Buffer.from(getBlob(blob)?.bytes ?? []).toString("base64")).toBe(ANNOTATED_JPEG);
			expect(picture()).toMatchObject({ w: 640, h: 480, actions: { click: "annotate" } });

			let sent: { text: string; images: { data: string; mimeType: string }[] } | undefined;
			// The submit handler takes the draft's images from `pendingImages`.
			composer.onSubmit = text => {
				sent = { text, images: composer.pendingImages.map(({ data, mimeType }) => ({ data, mimeType })) };
			};
			composer.submit();
			expect(sent).toEqual({ text: "[Image #1, 640x480] ", images: [annotated] });
			dispose();
		});
	});

	test("a cropped picture's size becomes the marker's: the card's caption and the prompt state it", () => {
		createRoot(dispose => {
			const { composer, band } = attached();
			const env = staticEnvironment(currentTheme());
			const card = () => (describeTree(band, env) as NativeNode).c?.[0];

			imageNode(band)?.handlers.onChange?.({
				type: "change",
				key: "",
				value: { mime: "image/png", data: ANNOTATED_JPEG, w: 380, h: 100 },
			});

			expect(composer.chips().map(chip => chip.expansion)).toEqual(["[Image #1, 380x100]"]);
			expect(card()?.c?.[0]?.p).toMatchObject({ w: 380, h: 100 });
			expect(card()?.c?.[1]?.p).toMatchObject({ spans: [{ t: "380x100" }] });

			let sent: { text: string; images: { data: string; mimeType: string }[] } | undefined;
			composer.onSubmit = text => {
				sent = { text, images: composer.pendingImages.map(({ data, mimeType }) => ({ data, mimeType })) };
			};
			composer.submit();
			expect(sent).toEqual({
				text: "[Image #1, 380x100] ",
				images: [{ data: ANNOTATED_JPEG, mimeType: "image/png" }],
			});
			dispose();
		});
	});

	test("a value that is not a picture leaves the chip's image as it was", () => {
		createRoot(dispose => {
			const { composer, band, original } = attached();
			const [chip] = composer.chips();
			const notPictures: Extract<UiEvent, { type: "change" }>[] = [
				{ type: "change", key: "", item: "", value: "annotated" },
				{ type: "change", key: "", item: "", value: null },
				{ type: "change", key: "", value: { mime: "image/png", data: "", w: 640, h: 480 } },
				{ type: "change", key: "", value: { mime: "image/png", data: ANNOTATED_JPEG, w: Number.NaN, h: 480 } },
				{ type: "change", key: "", value: { mime: "image/png", data: ANNOTATED_JPEG, w: 380.5, h: 100 } },
				{ type: "change", key: "", value: { mime: "image/png", data: ANNOTATED_JPEG, w: 380, h: 0 } },
			];
			for (const event of notPictures) imageNode(band)?.handlers.onChange?.(event);
			expect(composer.pendingImages).toEqual([original]);
			expect(composer.chips()).toEqual([chip!]);
			dispose();
		});
	});

	test("a chip whose terminal does not annotate keeps the default click", () => {
		createRoot(dispose => {
			const composer = new Composer();
			composer.insertAtom(composer.chipLabel("image", 1), "[Image #1, 640x480]", {
				kind: "image",
				image: { type: "image", data: PNG_1PX, mimeType: "image/png" },
			});
			const band = ComposerChips({ composer });
			if (!isUiNode(band)) throw new Error("the band is one node");
			const env = staticEnvironment(currentTheme());
			const picture = described(describeTree(band, env) as NativeNode).find(node => node.k === "image")?.p;
			expect(picture?.actions).toBeUndefined();
			expect(picture?.title).toBeUndefined();
			dispose();
		});
	});
});
