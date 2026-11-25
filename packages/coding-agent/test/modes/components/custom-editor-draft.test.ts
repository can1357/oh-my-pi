import { afterAll, describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createRoot } from "@oh-my-pi/pi-tui";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgComposerRecallClearedDrafts } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { Composer, type ComposerOptions, chipLabel } from "../../../src/ui/composer";
import { KEYS, key, sendKey, sendPaste } from "../../ui/composer/harness";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

/** A composer (in its own reactive root) and the keys it is fed, as the terminal backend routes them. */
interface Editor {
	readonly composer: Composer;
	press(...raws: string[]): void;
	paste(text: string): void;
	/** Chips as `{ kind, n, image?, link? }`. */
	chips(): { kind: string; n: number; image?: ImageContent; link?: string }[];
}

function editor(options: ComposerOptions = {}): Editor {
	return createRoot(() => {
		const composer = new Composer(options);
		return {
			composer,
			press(...raws) {
				for (const raw of raws) sendKey(composer.node, composer.field, key(raw));
			},
			paste(text) {
				sendPaste(composer.node, composer.field, text);
			},
			chips() {
				return composer.chips().map(chip => ({
					kind: chip.kind,
					n: chip.n,
					...(chip.image ? { image: chip.image as ImageContent } : {}),
					...(composer.imageLink(chip) ? { link: composer.imageLink(chip) } : {}),
				}));
			},
		};
	});
}

/** A paste long enough to collapse into a chip. */
const LONG_PASTE = (label: string) => Array.from({ length: 12 }, (_, i) => `${label} ${i}`).join("\n");

describe("composer draft restore", () => {
	it("collapses stored image markers into chip tokens that round-trip on expansion", () => {
		const { composer } = editor();
		composer.setDraft("look at [Image #1, 800x600] please", [image]);
		expect(composer.text()).toBe(`look at ${chipLabel("image", 1)} please`);
		// The wire format is restored at submit time via the atom table.
		expect(composer.expandedText()).toBe("look at [Image #1, 800x600] please");
	});

	it("strips a legacy attachment URI from restored drafts", () => {
		const { composer } = editor();
		composer.setDraft("see [Image #1] attachment://1 end", [image]);
		expect(composer.text()).toBe(`see ${chipLabel("image", 1)} end`);
	});

	it("resolves image links asynchronously so restored chips are clickable", async () => {
		const ed = editor();
		const { promise, resolve } = Promise.withResolvers<readonly (string | undefined)[]>();
		ed.composer.setImageLinkResolver(() => promise);
		ed.composer.setDraft("[Image #1]", [image]);
		expect(ed.chips()).toEqual([{ kind: "image", n: 1, image }]);
		resolve(["/tmp/blob-1.png"]);
		await promise;
		expect(ed.chips()).toEqual([{ kind: "image", n: 1, image, link: "/tmp/blob-1.png" }]);
		expect(ed.composer.pendingImageLinks).toEqual(["/tmp/blob-1.png"]);
	});

	it("drops stale link results when the draft was replaced mid-resolution", async () => {
		const ed = editor();
		const { promise, resolve } = Promise.withResolvers<readonly (string | undefined)[]>();
		ed.composer.setImageLinkResolver(() => promise);
		ed.composer.setDraft("[Image #1]", [image]);
		ed.composer.clearDraft({ recall: false });
		resolve(["/tmp/stale.png"]);
		await promise;
		expect(ed.composer.pendingImageLinks).toEqual([]);
	});

	it("clearDraft resets text attachments and their numbering", () => {
		const ed = editor();
		ed.composer.insertTextAttachment("a\nb");
		expect(ed.chips()).toHaveLength(1);
		ed.composer.clearDraft({ recall: false });
		expect(ed.chips()).toEqual([]);
		ed.composer.insertTextAttachment("c");
		expect(ed.chips()[0]?.n).toBe(1);
	});

	it("never recycles a deleted chip's number within one draft", () => {
		const ed = editor();
		ed.composer.insertTextAttachment("first");
		ed.composer.setText("");
		ed.composer.insertTextAttachment("second");
		// Only the surviving token's chip is visible, and it kept counting.
		expect(ed.chips()).toEqual([{ kind: "paste", n: 2 }]);
	});

	it("deletes a chip atomically and brings it back with undo", () => {
		const ed = editor();
		ed.composer.setDraft("[Image #1]", [image]);
		ed.press(KEYS.backspace!);
		expect(ed.chips()).toEqual([]);
		ed.press("\x1f");
		expect(ed.chips()).toEqual([{ kind: "image", n: 1, image }]);
	});
});

describe("cleared draft recall", () => {
	it("recalls an image-only draft as a live, atomically deletable chip", () => {
		const ed = editor();
		ed.composer.addToHistory("earlier prompt");
		ed.composer.setDraft("[Image #1]", [image]);
		ed.composer.clearDraft();
		expect(ed.composer.pendingImages).toEqual([]);

		ed.press(KEYS.up!);
		expect(ed.composer.expandedText()).toBe("[Image #1]");
		expect(ed.chips()).toEqual([{ kind: "image", n: 1, image }]);
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe("earlier prompt");
		expect(ed.composer.pendingImages).toEqual([]);
		ed.press(KEYS.down!);
		expect(ed.composer.expandedText()).toBe("[Image #1]");
		expect(ed.composer.pendingImages).toEqual([image]);
		ed.press(KEYS.backspace!); // Down recalls at the end, after the chip.
		expect(ed.composer.expandedText()).toBe("");
		expect(ed.chips()).toEqual([]);
	});

	it("keeps the saved attachment snapshot intact across repeated recall and mutation", () => {
		const ed = editor();
		ed.composer.insertTextAttachment("original payload");
		ed.composer.clearDraft();

		for (const addition of ["first edit", "second edit"]) {
			ed.press(KEYS.up!);
			expect(ed.composer.expandedText()).toBe("original payload ");
			ed.press(KEYS.ctrlE!);
			ed.composer.insertTextAttachment(addition);
			expect(ed.composer.expandedText()).toBe(`original payload ${addition} `);
			expect(ed.chips().map(chip => chip.n)).toEqual([1, 2]);
			ed.composer.clearDraft({ recall: false });
		}
		ed.press(KEYS.up!);
		expect(ed.composer.expandedText()).toBe("original payload ");
		expect(ed.chips()).toEqual([{ kind: "paste", n: 1 }]);
	});

	it("recalls an unsent multiline draft without trimming it or submitting it", () => {
		const submitted: string[] = [];
		const ed = editor({ onSubmit: text => submitted.push(text) });
		ed.composer.setText("  first line\nsecond line  ");
		ed.composer.clearDraft();
		expect(ed.composer.text()).toBe("");
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe("  first line\nsecond line  ");
		expect(submitted).toEqual([]);
	});

	it("restores image and paste payloads without leaking them into other history entries", () => {
		const ed = editor();
		ed.composer.setDraft("inspect [Image #1] ", [image]);
		ed.composer.insertTextAttachment("first\nsecond");
		const expanded = ed.composer.expandedText();
		ed.composer.clearDraft();
		ed.composer.setText("unrelated prompt");
		ed.composer.clearDraft();
		ed.press(KEYS.up!);
		expect(ed.composer.expandedText()).toBe("unrelated prompt");
		expect(ed.composer.pendingImages).toEqual([]);
		ed.press(KEYS.up!);
		expect(ed.composer.expandedText()).toBe(expanded);
		expect(ed.composer.pendingImages).toEqual([image]);
		expect(ed.chips().map(chip => chip.kind)).toEqual(["image", "paste"]);
		ed.press(KEYS.down!);
		expect(ed.composer.text()).toBe("unrelated prompt");
		expect(ed.composer.pendingImages).toEqual([]);
		expect(ed.chips()).toEqual([]);
	});

	it("does not submit a canceled image with another history entry after editing the recalled draft", () => {
		const submitted: { text: string; images: ImageContent[] }[] = [];
		const ed: Editor = editor({
			onSubmit: text => submitted.push({ text, images: [...(ed?.composer.pendingImages ?? [])] }),
		});
		ed.composer.setDraft("canceled [Image #1]", [image]);
		ed.composer.clearDraft();
		ed.composer.addToHistory("different [Image #1]");
		ed.press(KEYS.up!, KEYS.up!);
		expect(ed.composer.pendingImages).toEqual([image]);
		ed.press(KEYS.ctrlE!, KEYS.ctrlU!); // Delete the recalled text without clearing its attachment state.
		expect(ed.composer.text()).toBe("");
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe("different [Image #1]");
		ed.press(KEYS.enter!);
		expect(submitted).toEqual([{ text: "different [Image #1]", images: [] }]);
	});

	it("does not expand another history entry with paste payloads from an edited recalled draft", () => {
		const submitted: string[] = [];
		const ed = editor({ onSubmit: text => submitted.push(text) });
		ed.composer.insertTextAttachment("canceled text attachment");
		ed.paste(LONG_PASTE("canceled pasted text"));
		const otherPrompt = `different ${ed.composer.text()}`.trim();
		ed.composer.clearDraft();
		ed.composer.addToHistory(otherPrompt);
		ed.press(KEYS.up!, KEYS.up!, KEYS.ctrlE!, KEYS.ctrlU!);
		expect(ed.composer.text()).toBe("");
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe(otherPrompt);
		ed.press(KEYS.enter!);
		expect(submitted).toEqual([otherPrompt]);
		expect(ed.chips()).toEqual([]);
	});

	for (const transition of ["discard", "submit", "replace"] as const) {
		it(`preserves a fresh image during normal history recall after ${transition} of a recalled draft`, () => {
			const submitted: { text: string; images: ImageContent[] }[] = [];
			const ed: Editor = editor({
				onSubmit: text => submitted.push({ text, images: [...(ed?.composer.pendingImages ?? [])] }),
			});
			ed.composer.setDraft("canceled [Image #1]", [image]);
			ed.composer.clearDraft();
			ed.press(KEYS.up!);
			if (transition === "discard") ed.composer.clearDraft({ recall: false });
			if (transition === "submit") ed.press(KEYS.enter!);
			submitted.length = 0;
			const freshImage: ImageContent = { ...image, data: "ZnJlc2g=" };
			if (transition === "replace") {
				ed.composer.setDraft("fresh [Image #1]", [freshImage]);
			} else {
				ed.composer.pendingImages.splice(0, ed.composer.pendingImages.length, freshImage);
				ed.composer.setCollapsedText("fresh [Image #1]");
			}
			ed.composer.addToHistory("submitted [Image #1]");
			ed.press(KEYS.ctrlE!, KEYS.ctrlU!, KEYS.up!, KEYS.enter!);
			expect(submitted).toEqual([{ text: "submitted [Image #1]", images: [freshImage] }]);
		});
	}

	it("does not persist canceled drafts or hide prior history behind empty clears", () => {
		const written: string[] = [];
		const ed = editor();
		ed.composer.setHistory(["submitted earlier"], text => written.push(text));
		ed.composer.setText("unsent private draft");
		ed.composer.clearDraft();
		ed.composer.clearDraft();
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe("unsent private draft");
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe("submitted earlier");
		expect(written).toEqual([]);
	});

	it("does not retain evicted pastes in newer drafts", () => {
		const ed = editor();
		ed.paste(LONG_PASTE("old payload"));
		const marker = ed.composer.text();
		ed.composer.clearDraft();
		for (let index = 0; index < 100; index++) {
			ed.composer.setText(`draft ${index}`);
			ed.composer.clearDraft();
		}
		ed.press(KEYS.up!);
		ed.composer.setText(marker);
		expect(ed.composer.expandedText()).toBe(marker);
	});

	it("resolves missing attachment links again after a canceled restore", async () => {
		const ed = editor();
		const first = Promise.withResolvers<readonly (string | undefined)[]>();
		const second = Promise.withResolvers<readonly (string | undefined)[]>();
		let calls = 0;
		ed.composer.setImageLinkResolver(() => (++calls === 1 ? first.promise : second.promise));
		ed.composer.setDraft("[Image #1]", [image]);
		ed.composer.clearDraft();
		first.resolve(["file:///tmp/image.png"]);
		await first.promise;
		ed.press(KEYS.up!);
		second.resolve(["file:///tmp/image.png"]);
		await second.promise;
		expect(ed.chips()).toEqual([{ kind: "image", n: 1, image, link: "file:///tmp/image.png" }]);
	});
});

describe("cleared draft recovery preference", () => {
	it("respects disabling and re-enabling recovery without replacing the composer", () => {
		const ed = editor();
		const settings = Settings.isolated();
		const helpers = new UiHelpers({ composer: ed.composer, settings } as unknown as InteractiveModeContext);
		ed.composer.addToHistory("submitted earlier");
		ed.composer.setText("recovered by default");
		helpers.clearEditor();
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe("recovered by default");
		cfgComposerRecallClearedDrafts.set(settings, false);
		ed.composer.setDraft("discard [Image #1]", [image]);
		helpers.clearEditor();
		expect(ed.composer.text()).toBe("");
		expect(ed.composer.pendingImages).toEqual([]);
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe("recovered by default");
		expect(ed.composer.pendingImages).toEqual([]);
		cfgComposerRecallClearedDrafts.set(settings, true);
		ed.composer.setText("recovered again");
		helpers.clearEditor();
		ed.press(KEYS.up!);
		expect(ed.composer.text()).toBe("recovered again");
	});
});
