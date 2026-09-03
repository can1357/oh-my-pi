import { afterEach, describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import {
	resetHangulCompatibilityJamoWidthForTests,
	setHangulCompatibilityJamoWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui/utils";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils";

function renderedWidth(input: Input, width: number): number {
	const [line] = input.render(width);
	// TUI strips this marker before its width verification; tests should mimic that.
	return visibleWidth(line.replaceAll(CURSOR_MARKER, ""));
}

describe("Input component", () => {
	const wordLeft = "\x1bb"; // ESC-b (alt+b)
	const wordRight = "\x1bf"; // ESC-f (alt+f)

	function setupAtEnd(text: string): Input {
		const input = new Input();
		input.focused = true;
		input.setValue(text);
		input.handleInput("\x05"); // Ctrl+E (end)
		return input;
	}

	afterEach(() => {
		resetHangulCompatibilityJamoWidthForTests();
	});

	it("moves by CJK and punctuation blocks (backward)", () => {
		const text = "天气不错，去散步吧！";

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错，去散步吧|！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错，|去散步吧！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错|，去散步吧！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("|天气不错，去散步吧！");
		}
	});

	it("moves by CJK and punctuation blocks (forward)", () => {
		const text = "天气不错，去散步吧！";
		const input = new Input();
		input.focused = true;
		input.setValue(text);
		input.handleInput("\x01"); // Ctrl+A (start)

		input.handleInput(wordRight);
		input.handleInput("|");
		expect(input.getValue()).toBe("天气不错|，去散步吧！");
	});

	it("treats NBSP as whitespace for word navigation", () => {
		const nbsp = "\u00A0";
		const text = `Hola${nbsp}mundo`;
		const input = setupAtEnd(text);
		input.handleInput(wordLeft);
		input.handleInput("|");
		expect(input.getValue()).toBe(`Hola${nbsp}|mundo`);
	});

	it("keeps common joiners inside words", () => {
		{
			const text = "co-operate l’été";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("co-operate |l’été");
		}

		{
			const text = "co-operate l’été";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("|co-operate l’été");
		}
	});

	it("recognizes Unicode punctuation as delimiter blocks", () => {
		{
			const text = "¿Cómo estás? ¡Muy bien!";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("¿Cómo estás? ¡Muy bien|!");
		}

		{
			const text = "¿Cómo estás? ¡Muy bien!";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("¿Cómo estás? ¡Muy |bien!");
		}
	});

	it("does not delete twice when Kitty sends backspace press and release", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("ab");

		input.handleInput("\x1b[127u");
		expect(input.getValue()).toBe("a");

		input.handleInput("\x1b[127;1:3u");
		expect(input.getValue()).toBe("a");

		setKittyProtocolActive(false);
	});

	it("inserts keypad digits from Kitty CSI-u input with or without NumLock modifier", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("a");

		input.handleInput("\x1b[57407u");
		input.handleInput("\x1b[57407;129u");
		input.handleInput("\x1b[57404u");
		expect(input.getValue()).toBe("a885");

		setKittyProtocolActive(false);
	});

	it("inserts keypad operators from Kitty CSI-u input", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("a");

		input.handleInput("\x1b[57410u");
		expect(input.getValue()).toBe("a/");

		setKittyProtocolActive(false);
	});

	it("normalizes tabs in buffered bracketed paste using the fixed display width", () => {
		const input = setupAtEnd("");

		input.handleInput("\x1b[200~a\t");
		expect(input.getValue()).toBe("");

		input.handleInput("b\r\n");
		expect(input.getValue()).toBe("");

		input.handleInput("c\x1b[201~");
		expect(input.getValue()).toBe(`a${" ".repeat(DEFAULT_TAB_WIDTH)}bc`);
	});

	it("decodes tmux re-encoded control bytes in bracketed paste without leaking tails or storing raw C0", () => {
		// Regression: kitty+tmux (extended-keys-format=xterm) re-encodes the newline
		// (Ctrl+J) inside a paste as ESC[27;5;106~. For a single-line input the newline
		// is stripped, but the escape tail "[27;5;106~" must never leak in as text.
		const input = setupAtEnd("");
		input.handleInput("\x1b[200~ab\x1b[27;5;106~cd\x1b[201~");
		expect(input.getValue()).toBe("abcd");

		// A non-newline re-encoded control (Ctrl+A → 0x01) must be stripped, not stored
		// as a raw control byte in the single-line value.
		const input2 = setupAtEnd("");
		input2.handleInput("\x1b[200~x\x1b[27;5;97~y\x1b[201~");
		expect(input2.getValue()).toBe("xy");
	});

	it("never renders a line wider than the terminal width (wide chars)", () => {
		const input = new Input();
		input.focused = true;
		// Long wide-script text: string length != terminal cell width.
		input.setValue("天气不错，去散步吧！".repeat(50));
		input.handleInput("\x05"); // Ctrl+E (end)
		const width = 40;
		expect(renderedWidth(input, width)).toBeLessThanOrEqual(width);
	});

	it("masks one bullet per grapheme without changing the submitted value", () => {
		const input = new Input();
		input.focused = true;
		input.mask = true;
		input.setValue("a😀e\u0301z");
		input.handleInput("\x01"); // Ctrl+A (start)
		input.handleInput("\x1b[C"); // after a
		input.handleInput("\x1b[C"); // after emoji

		const [line] = input.render(20);
		const markerIndex = line.indexOf(CURSOR_MARKER);
		expect(visibleWidth(line.slice(0, markerIndex))).toBe(4); // prompt + two graphemes
		expect(Bun.stripANSI(line.replaceAll(CURSOR_MARKER, "")).trimEnd()).toBe("> ••••");
		expect(line).not.toContain(input.getValue());

		let submitted = "";
		input.onSubmit = value => {
			submitted = value;
		};
		input.handleInput("\n");
		expect(submitted).toBe("a😀e\u0301z");
	});

	it("keeps masked Unicode input within narrow viewports", () => {
		const input = setupAtEnd("😀e\u0301".repeat(20));
		input.mask = true;
		expect(renderedWidth(input, 12)).toBeLessThanOrEqual(12);
	});

	it("renders non-secret input unchanged when masking is disabled", () => {
		const input = setupAtEnd("visible-value");
		const [line] = input.render(30);
		expect(Bun.stripANSI(line.replaceAll(CURSOR_MARKER, ""))).toContain("visible-value");
	});

	it("normalizes NFD Korean pastes (macOS Finder drag-drop) to NFC", () => {
		// macOS Finder drag-drops file paths in NFD (decomposed Unicode).
		// Korean syllable `화` is U+D654 (1 char, 2 cells) in NFC, but
		// ᄒ(U+1112) + ᅪ(U+116A) (2 chars, 3 cells per Bun.stringWidth) in NFD.
		// Without normalization, the cursor lands `(NFD cells - NFC cells)`
		// past the visible filename — the documented "cursor displacement"
		// bug after drag-dropping a Korean filename.
		const input = new Input();
		input.focused = true;
		const nfcPath = "/Users/leo/Downloads/화면.mov";
		const nfdPath = nfcPath.normalize("NFD");
		// Sanity: ensure our test fixture really differs between NFC and NFD.
		expect(nfdPath).not.toBe(nfcPath);
		expect(nfdPath.length).toBeGreaterThan(nfcPath.length);

		// Simulate macOS bracketed-paste drop of an NFD path.
		input.handleInput(`\x1b[200~${nfdPath}\x1b[201~`);

		// Stored value must be NFC — no more NFD characters in the buffer.
		expect(input.getValue()).toBe(nfcPath);
	});

	it("NFC paste: cursor column matches visible cells (no displacement)", () => {
		// Regression guard for the "cursor floats past the filename" bug.
		// After paste, the cursor must be at a column == visibleWidth(value)
		// (plus 2 for the "> " prompt prefix).
		const input = new Input();
		input.focused = true;
		const nfdPath = "/Users/leo/화면\\ 기록.mov".normalize("NFD");
		input.handleInput(`\x1b[200~${nfdPath}\x1b[201~`);

		const [line] = input.render(120);
		const markerIdx = line.indexOf(CURSOR_MARKER);
		expect(markerIdx).toBeGreaterThanOrEqual(0);
		const col = visibleWidth(line.slice(0, markerIdx));
		// Prompt "> " (2 cells) + value width in NFC (matches terminal rendering).
		const expectedCol = 2 + visibleWidth(input.getValue());
		expect(col).toBe(expectedCol);
	});

	it("terminal cursor mode emits marker without inverse-video software cursor", () => {
		const input = new Input();
		input.focused = true;
		input.setUseTerminalCursor(true);
		input.setValue("abc");
		input.handleInput("\x01"); // Ctrl+A (start)

		const [line] = input.render(20);
		expect(line).toContain(CURSOR_MARKER);
		expect(line).not.toContain("\x1b[7m");
		expect(line.replaceAll(CURSOR_MARKER, "")).toContain("abc");
		expect(input.getUseTerminalCursor()).toBe(true);
	});

	it("runtime jamo profile controls the cursor marker column", () => {
		// The hardware cursor column is `prompt + visibleWidth(value before
		// cursor)`. Once the terminal probe sets the jamo width, that column must
		// track it: 8 narrow jamo land at +8, 8 wide jamo at +16.
		const promptWidth = 2; // "> "
		const jamo = "ㅁ".repeat(8);

		const narrow = new Input();
		narrow.focused = true;
		setHangulCompatibilityJamoWidth(1);
		narrow.setValue(jamo);
		narrow.handleInput("\x05"); // Ctrl+E (end)
		const narrowLine = narrow.render(80)[0];
		expect(visibleWidth(narrowLine.slice(0, narrowLine.indexOf(CURSOR_MARKER)))).toBe(promptWidth + 8);

		const wide = new Input();
		wide.focused = true;
		setHangulCompatibilityJamoWidth(2);
		wide.setValue(jamo);
		wide.handleInput("\x05"); // Ctrl+E (end)
		const wideLine = wide.render(80)[0];
		expect(visibleWidth(wideLine.slice(0, wideLine.indexOf(CURSOR_MARKER)))).toBe(promptWidth + 16);
	});

	it("pasteText absorbs a payload from a non-bracketed transport (kitty OSC 5522)", () => {
		// Regression for #2127: when kitty's enhanced clipboard read delivers the
		// API key directly via `pasteText`, the modal Input must capture it just
		// like a bracketed paste — newlines stripped, value inserted, cursor at end.
		const input = setupAtEnd("");
		input.pasteText("sk-line1\nsk-line2\r\nsk-line3");
		expect(input.getValue()).toBe("sk-line1sk-line2sk-line3");
	});
});
