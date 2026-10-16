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
let originalCell: CellDimensions;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	originalCell = getCellDimensions();
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	terminal.imageProtocol = ImageProtocol.Sixel;
});

afterEach(() => {
	terminal.imageProtocol = ORIGINAL_PROTOCOL;
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
});
