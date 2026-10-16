import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { ImageBudget } from "@oh-my-pi/pi-tui";
import { AttachmentChipsBand } from "@oh-my-pi/pi-tui/prompt/attachment-chips";
import { chipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

// 2x2 red PNG (same fixture as attachment-chips.test.ts): the header probe decodes it to 2x2.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBhQAAA9+AQBHYLp7wAAAABJRU5ErkJggg==";
const FAKE_SIXEL = "\x1bPq#0;2;0;0;0#0~\x1b\\";

const ORIGINAL_PROTOCOL = TERMINAL.imageProtocol;
const ORIGINAL_KONSOLE = Bun.env.KONSOLE_VERSION;
let originalCell: CellDimensions;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	originalCell = getCellDimensions();
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	terminal.imageProtocol = ImageProtocol.Sixel;
	Bun.env.KONSOLE_VERSION = "26.04.0";
});

afterEach(() => {
	terminal.imageProtocol = ORIGINAL_PROTOCOL;
	if (ORIGINAL_KONSOLE === undefined) delete Bun.env.KONSOLE_VERSION;
	else Bun.env.KONSOLE_VERSION = ORIGINAL_KONSOLE;
	setCellDimensions(originalCell);
});

function makeBand(): { editor: CustomEditor; band: AttachmentChipsBand; repaints: { count: number } } {
	const editor = new CustomEditor(getEditorTheme());
	const repaints = { count: 0 };
	const band = new AttachmentChipsBand(editor, new ImageBudget(8), () => {
		repaints.count++;
	});
	return { editor, band, repaints };
}

function stageImage(editor: CustomEditor): void {
	editor.pendingImages.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
	editor.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]");
}

describe("AttachmentChipsBand SIXEL thumbnail", () => {
	it("draws the SIXEL inside the image card once the off-thread encode settles", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			const { editor, band, repaints } = makeBand();
			stageImage(editor);

			// Pending encode: the chip shows its icon, with no SIXEL yet.
			const pending = band.render(80);
			expect(pending.join("\n")).not.toContain(FAKE_SIXEL);
			expect(encode).toHaveBeenCalledTimes(1);

			// The band attaches its settle handler before returning; awaiting the same promise runs it first.
			await encoding;
			expect(repaints.count).toBe(1);

			// Settled: the sixel rides on the bottom border row of the image card.
			const rows = band.render(80);
			expect(rows).toHaveLength(6);
			expect(rows[5]).toContain(FAKE_SIXEL);
			expect(Bun.stripANSI(rows[5])).toContain("2x2");
		} finally {
			encode.mockRestore();
		}
	});

	it("reuses the cached thumbnail across typing repaints without re-encoding", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			const { editor, band } = makeBand();
			stageImage(editor);
			band.render(80);
			await encoding;

			const first = band.render(80)[5];
			const second = band.render(80)[5];
			expect(second).toBe(first);
			for (let i = 0; i < 10; i++) {
				editor.setText(`${editor.getText()}x`);
				const frame = band.render(80);
				expect(frame[5]).toContain(FAKE_SIXEL);
				expect(encode).toHaveBeenCalledTimes(1);
			}
			expect(encode).toHaveBeenCalledTimes(1);
		} finally {
			encode.mockRestore();
		}
	});
	it("repaints the former chip rows once when the last attachment is cleared", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			const { editor, band } = makeBand();
			stageImage(editor);
			band.render(80);
			await encoding;
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
			editor.clearDraft();
			const cleared = band.render(80);
			expect(cleared).toHaveLength(6);
			expect(cleared[5]).toContain("a=d,d=c");
			expect(band.render(80)).toEqual([]);
		} finally {
			encode.mockRestore();
		}
	});

	it("keeps the icon and never emits SIXEL when the encode fails", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.reject(new Error("boom"));
			return encoding;
		});
		try {
			const { editor, band } = makeBand();
			stageImage(editor);
			band.render(80);
			await encoding?.catch(() => undefined);

			const rows = band.render(80);
			expect(rows.join("\n")).not.toContain("\x1bPq");
			expect(rows).toHaveLength(6);
		} finally {
			encode.mockRestore();
		}
	});

	it("leaves non-SIXEL protocols on the icon path with no encode", () => {
		terminal.imageProtocol = null;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => Promise.resolve(FAKE_SIXEL));
		try {
			const { editor, band } = makeBand();
			stageImage(editor);
			const rows = band.render(80);
			expect(rows.join("\n")).not.toContain("\x1bPq");
			expect(encode).not.toHaveBeenCalled();
		} finally {
			encode.mockRestore();
		}
	});

	it("emits the stale delete before the replacement thumbnail", async () => {
		const pending: Promise<string>[] = [];
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			const next = Promise.resolve(FAKE_SIXEL);
			pending.push(next);
			return next;
		});
		try {
			// Wide header-only PNG: the probe yields 560x100, fitting 11x1 cells —
			// a different geometry than the narrow 2x2 (8x4) thumbnail.
			const wide = Buffer.alloc(33);
			wide.write("\x89PNG\r\n\x1a\n", 0, "binary");
			wide.writeUInt32BE(13, 8);
			wide.write("IHDR", 12);
			wide.writeUInt32BE(560, 16);
			wide.writeUInt32BE(100, 20);
			const { editor, band } = makeBand();
			editor.pendingImages.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
			editor.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]");
			editor.pendingImages.push({
				type: "image",
				data: wide.toString("base64"),
				mimeType: "image/png",
			});
			editor.insertAtom(chipLabel("image", 2), "[Image #2, 560x100]");
			band.render(80);
			await pending[0];
			await pending[1];
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
			// Drop the narrow chip: the wide thumbnail slides into its origin
			// while the narrow placement is still live.
			editor.setText(`${chipLabel("image", 2)} `);
			const bottom = band.render(80)[5];
			expect(bottom).toContain(FAKE_SIXEL);
			expect(bottom).toContain("a=d,d=c");
			expect(bottom.indexOf("a=d,d=c")).toBeLessThan(bottom.indexOf(FAKE_SIXEL));
		} finally {
			encode.mockRestore();
		}
	});

	it("clears the old cell when editor growth moves the band", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			const { editor, band } = makeBand();
			stageImage(editor);
			band.render(80);
			await encoding;
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
			// Multiline input pushes the band up; x/cols/rows are unchanged,
			// so only the tracked band row distinguishes the stale placement.
			editor.setText(`${editor.getText()}\nhello\nworld`);
			const moved = band.render(80);
			expect(moved[5]).toContain(FAKE_SIXEL);
			expect(moved[5]).toContain("a=d,d=c");
		} finally {
			encode.mockRestore();
		}
	});

	it("withholds the SIXEL thumbnail where no Konsole identity confirms the SIXEL delete", () => {
		delete Bun.env.KONSOLE_VERSION;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => Promise.resolve(FAKE_SIXEL));
		try {
			const { editor, band } = makeBand();
			stageImage(editor);
			const rows = band.render(80);
			expect(rows.join("\n")).not.toContain("\x1bPq");
			expect(encode).not.toHaveBeenCalled();
		} finally {
			encode.mockRestore();
		}
	});

	it("keeps the thumbnail when the rendered editor height is unchanged", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			const { editor, band } = makeBand();
			stageImage(editor);
			band.render(80);
			await encoding;
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
			editor.setText(editor.getText().padEnd(76, " "));
			const frame = band.render(80)[5];
			expect(frame).toContain(FAKE_SIXEL);
			expect(frame).not.toContain("a=d,d=c");
		} finally {
			encode.mockRestore();
		}
	});

	it("retires the thumbnail when max-height clamp changes the rendered editor height", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			const { editor, band } = makeBand();
			// Default editor chrome is 2 rows (top border + content). maxHeight 4 leaves room for
			// a second content row before the clamp; past that, Editor.render stays flat.
			editor.setMaxHeight(4);
			stageImage(editor);
			band.render(80);
			await encoding;
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
			const before = editor.render(80).length;
			editor.setText(`${editor.getText()}\nline2`);
			expect(editor.render(80).length).toBeGreaterThan(before);
			const moved = band.render(80);
			expect(moved[5]).toContain(FAKE_SIXEL);
			expect(moved[5]).toContain("a=d,d=c");
			// Past the clamp, rendered height is stable: no further aimed delete.
			const clamped = editor.render(80).length;
			editor.setText(`${editor.getText()}\nline3\nline4\nline5`);
			expect(editor.render(80).length).toBe(clamped);
			const steady = band.render(80)[5];
			expect(steady).toContain(FAKE_SIXEL);
			expect(steady).not.toContain("a=d,d=c");
		} finally {
			encode.mockRestore();
		}
	});

	it("retires the thumbnail when autocomplete rows grow the rendered editor", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			const { editor, band } = makeBand();
			const { promise: autocompleteUpdated, resolve: resolveAutocompleteUpdated } = Promise.withResolvers<void>();
			editor.setAutocompleteProvider({
				async getSuggestions() {
					return {
						items: [
							{ label: "/help", value: "/help" },
							{ label: "/model", value: "/model" },
							{ label: "/theme", value: "/theme" },
						],
						prefix: "/",
					};
				},
				applyCompletion(lines, cursorLine, cursorCol) {
					return { lines, cursorLine, cursorCol };
				},
			});
			editor.onAutocompleteUpdate = resolveAutocompleteUpdated;
			stageImage(editor);
			band.render(80);
			await encoding;
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
			const before = editor.render(80).length;
			editor.handleInput("/");
			await autocompleteUpdated;
			expect(editor.isShowingAutocomplete()).toBe(true);
			expect(editor.render(80).length).toBeGreaterThan(before);
			const moved = band.render(80);
			expect(moved[5]).toContain(FAKE_SIXEL);
			expect(moved[5]).toContain("a=d,d=c");
		} finally {
			encode.mockRestore();
		}
	});

	it("encodes through renderImage's shared SIXEL fit dimensions", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			// Wide header-only PNG: probe yields 560x100. Shared fit is 108x36;
			// the removed local sixelThumbFit produced 101x18 for the same source.
			const wide = Buffer.alloc(33);
			wide.write("\x89PNG\r\n\x1a\n", 0, "binary");
			wide.writeUInt32BE(13, 8);
			wide.write("IHDR", 12);
			wide.writeUInt32BE(560, 16);
			wide.writeUInt32BE(100, 20);
			const { editor, band } = makeBand();
			editor.pendingImages.push({
				type: "image",
				data: wide.toString("base64"),
				mimeType: "image/png",
			});
			editor.insertAtom(chipLabel("image", 1), "[Image #1, 560x100]");
			band.render(80);
			await encoding;
			expect(encode).toHaveBeenCalledWith(expect.any(Uint8Array), 108, 36);
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
		} finally {
			encode.mockRestore();
		}
	});
});
