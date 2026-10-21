import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { ImageBudget } from "@oh-my-pi/pi-tui";
import { AttachmentChipsBand } from "@oh-my-pi/pi-tui/prompt/attachment-chips";
import { chipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import {
	type CellDimensions,
	getCellDimensions,
	getTerminalBackgroundColor,
	ImageProtocol,
	renderImage,
	setCellDimensions,
	setTerminalBackgroundColor,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

// 2x2 red PNG (same fixture as attachment-chips.test.ts): the header probe decodes it to 2x2.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBhQAAA9+AQBHYLp7wAAAABJRU5ErkJggg==";
// Interior bounds of an image card (INNER_COLS x INNER_ROWS in attachment-chips.ts).
const CARD_INNER_COLS = 12;
const CARD_INNER_ROWS = 4;
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
	it("re-encodes with the new terminal background when it changes", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		try {
			setTerminalBackgroundColor(0x112233);
			const { editor, band } = makeBand();
			stageImage(editor);
			band.render(80);
			await encoding;
			expect(encode).toHaveBeenCalledTimes(1);
			expect(encode.mock.calls[0]?.[3]).toBe(getTerminalBackgroundColor());
			const first = encode.mock.calls[0]?.[3];

			band.render(80);
			expect(encode).toHaveBeenCalledTimes(1);

			setTerminalBackgroundColor(0xeeddcc);
			band.render(80);
			await encoding;
			expect(encode).toHaveBeenCalledTimes(2);
			expect(encode.mock.calls[1]?.[3]).toBe(getTerminalBackgroundColor());
			expect(encode.mock.calls[1]?.[3]).not.toBe(first);
		} finally {
			setTerminalBackgroundColor(undefined);
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
			band.commitSixelPlacements();
			editor.clearDraft();
			const cleared = band.render(80);
			expect(cleared).toHaveLength(6);
			expect(cleared[5]).toContain("a=d,d=c");
			band.commitSixelPlacements();
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
			band.commitSixelPlacements();
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
			band.commitSixelPlacements();
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
			band.commitSixelPlacements();
			const before = editor.render(80).length;
			editor.setText(`${editor.getText()}\nline2`);
			expect(editor.render(80).length).toBeGreaterThan(before);
			const moved = band.render(80);
			expect(moved[5]).toContain(FAKE_SIXEL);
			expect(moved[5]).toContain("a=d,d=c");
			band.commitSixelPlacements();
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
			band.commitSixelPlacements();
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
			// Wide header-only PNG: probe yields 560x100.
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
			// The fit is whatever renderImage computes for the same source and bounds, not a number
			// pinned here; it must differ from the removed local sixelThumbFit (101x18).
			let fitted: [number, number] | undefined;
			renderImage(
				wide.toString("base64"),
				{ widthPx: 560, heightPx: 100 },
				{
					maxWidthCells: CARD_INNER_COLS,
					maxHeightCells: CARD_INNER_ROWS,
					sixel: (widthPx, heightPx) => {
						fitted = [widthPx, heightPx];
						return FAKE_SIXEL;
					},
				},
			);
			expect(fitted).toBeDefined();
			expect(fitted).not.toEqual([101, 18]);
			expect(encode).toHaveBeenCalledWith(
				expect.any(Uint8Array),
				fitted![0],
				fitted![1],
				getTerminalBackgroundColor(),
			);
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
		} finally {
			encode.mockRestore();
		}
	});
	it("preserves last-painted placements across a discarded budget retry pass", async () => {
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
			band.commitSixelPlacements();
			// Discarded discovery pass: editor growth moves the band, but the frame
			// is thrown away (budget retry), so it must not become the delete baseline.
			editor.setText(`${editor.getText()}\nhello\nworld`);
			const discarded = band.render(80);
			expect(discarded[5]).toContain(FAKE_SIXEL);
			expect(discarded[5]).toContain("a=d,d=c");
			// Retry pass at the same geometry still diffs against the emitted frame,
			// so it still carries the aimed delete. A speculative commit would have
			// silenced it.
			const retry = band.render(80);
			expect(retry[5]).toContain(FAKE_SIXEL);
			expect(retry[5]).toContain("a=d,d=c");
			band.commitSixelPlacements();
			// Steady state after emission: no further delete.
			const steady = band.render(80);
			expect(steady[5]).toContain(FAKE_SIXEL);
			expect(steady[5]).not.toContain("a=d,d=c");
		} finally {
			encode.mockRestore();
		}
	});

	it("keeps the first SIXEL marker within the renderer scan window under a suppressed budget", async () => {
		const pending: Promise<string>[] = [];
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			const next = Promise.resolve(FAKE_SIXEL);
			pending.push(next);
			return next;
		});
		try {
			const editor = new CustomEditor(getEditorTheme());
			const budget = new ImageBudget(1);
			const band = new AttachmentChipsBand(editor, budget, () => {});
			// Four distinct staged images: same 2x2 header so the fit is stable,
			// distinct trailing lengths so the budget hands out distinct ids.
			const base = Buffer.from(TINY_PNG, "base64");
			for (let n = 1; n <= 4; n++) {
				const bytes = Buffer.concat([base, Buffer.alloc(n, n)]);
				editor.pendingImages.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
				editor.insertAtom(chipLabel("image", n), `[Image #${n}, 2x2]`);
			}
			// Prime the off-thread encodes, then drive the TUI discovery/retry loop
			// so the cap-1 budget converges: oldest three fall back to text, newest keeps its thumbnail.
			budget.beginPass();
			band.render(80);
			budget.endPass();
			await Promise.all(pending);
			pending.length = 0;
			let viewport: readonly string[] = [];
			for (let pass = 0; pass < 3; pass++) {
				budget.beginPass();
				viewport = band.render(80);
				if (!budget.endPass()) break;
			}
			budget.limitResidentImages();
			const bottom = viewport[5] ?? "";
			expect(bottom).toContain(FAKE_SIXEL);
			// Hoisted prefixes keep the first DCS at row start (after any deletes),
			// well inside SIXEL_MARKER_SCAN_LIMIT 128, before any suppressed border text.
			// Interleaved borders would place it after three suppressed cards.
			expect(bottom.indexOf("\x1bP")).toBeGreaterThanOrEqual(0);
			expect(bottom.indexOf("\x1bP")).toBeLessThan(128);
			expect(bottom.indexOf(FAKE_SIXEL)).toBeLessThan(bottom.indexOf("╰"));
			expect(TERMINAL.isImageLine(bottom)).toBe(true);
		} finally {
			encode.mockRestore();
		}
	});

	it("wraps the Konsole cursor-cell delete APC through tmux passthrough", async () => {
		let encoding: Promise<string> | undefined;
		const encode = spyOn(natives, "encodeSixelAsync").mockImplementation(() => {
			encoding = Promise.resolve(FAKE_SIXEL);
			return encoding;
		});
		const originalTmux = Bun.env.TMUX;
		try {
			const { editor, band } = makeBand();
			stageImage(editor);
			band.render(80);
			await encoding;
			expect(band.render(80)[5]).toContain(FAKE_SIXEL);
			band.commitSixelPlacements();
			Bun.env.TMUX = "/tmp/tmux-test,123,0";
			editor.setText(`${editor.getText()}\nhello\nworld`);
			const moved = band.render(80)[5];
			expect(moved).toContain(FAKE_SIXEL);
			expect(moved).toContain("a=d,d=c");
			// Shared encoder path: the delete APC rides tmux DCS passthrough.
			expect(moved).toContain("\x1bPtmux;");
		} finally {
			if (originalTmux === undefined) delete Bun.env.TMUX;
			else Bun.env.TMUX = originalTmux;
			encode.mockRestore();
		}
	});
});
