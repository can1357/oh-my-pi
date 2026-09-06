import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { getThemeByName, initTheme, type Theme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	dedupeParseErrors,
	expandKeyHint,
	formatCodeFrameLine,
	formatDiagnostics,
	formatErrorMessage,
	formatExpandHint,
	formatParseErrors,
	formatScreenshot,
	shortenPath,
	truncateDiffByHunk,
} from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";

describe("parse error formatting", () => {
	it("deduplicates parse errors while preserving order", () => {
		const errors = [
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
		];

		expect(dedupeParseErrors(errors)).toEqual([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});

	it("formats deduplicated parse errors", () => {
		const formatted = formatParseErrors([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);

		expect(formatted).toEqual([
			"Parse issues:",
			"- foo.ts: parse error (syntax tree contains error nodes)",
			"- bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});
});

describe("formatScreenshot", () => {
	function fakeResized(
		overrides?: Partial<{
			width: number;
			height: number;
			originalWidth: number;
			originalHeight: number;
			wasResized: boolean;
			buffer: Uint8Array;
			mimeType: string;
			decodeFailed: boolean;
		}>,
	): {
		buffer: Uint8Array;
		mimeType: string;
		originalWidth: number;
		originalHeight: number;
		width: number;
		height: number;
		wasResized: boolean;
		decodeFailed?: boolean;
		get data(): string;
	} {
		const buf = overrides?.buffer ?? new Uint8Array(2048);
		return {
			buffer: buf,
			mimeType: overrides?.mimeType ?? "image/webp",
			originalWidth: overrides?.originalWidth ?? 800,
			originalHeight: overrides?.originalHeight ?? 600,
			width: overrides?.width ?? 800,
			height: overrides?.height ?? 600,
			wasResized: overrides?.wasResized ?? false,
			decodeFailed: overrides?.decodeFailed,
			get data() {
				return Buffer.from(buf).toString("base64");
			},
		};
	}

	it("formats full-res save with home-relative path", () => {
		const filePath = path.join(os.homedir(), "screenshots", "capture.png");
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(1024) });

		expect(
			formatScreenshot({
				saveFullRes: true,
				savedMimeType: "image/png",
				savedByteLength: 2048,
				dest: filePath,
				resized,
			}),
		).toEqual([
			"Screenshot captured",
			"Saved: image/png (2.00 KB) to ~/screenshots/capture.png",
			"Model: image/webp (1.00 KB, 800x600)",
		]);
	});

	it("uses forward slashes after a shortened Windows home", () => {
		const home = String.raw`C:\Users\me`;
		expect(shortenPath(String.raw`C:\Users\me\projects\demo`, home)).toBe("~/projects/demo");
	});

	it("shortens Windows home paths case-insensitively", () => {
		const home = String.raw`C:\Users\Alice`;
		expect(shortenPath(String.raw`c:\users\alice\projects\demo`, home)).toBe("~/projects/demo");
	});

	it("does not shorten paths outside the home boundary", () => {
		const home = String.raw`C:\Users\me`;
		const sibling = String.raw`C:\Users\me2\projects\demo`;
		expect(shortenPath(sibling, home)).toBe(sibling);
	});

	it("formats non-home path without tilde", () => {
		const filePath = path.join(path.parse(os.homedir()).root, "omp-render-utils", "capture.png");
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(1024) });

		expect(
			formatScreenshot({
				saveFullRes: true,
				savedMimeType: "image/png",
				savedByteLength: 2048,
				dest: filePath,
				resized,
			}),
		).toEqual([
			"Screenshot captured",
			`Saved: image/png (2.00 KB) to ${filePath}`,
			"Model: image/webp (1.00 KB, 800x600)",
		]);
	});

	it("formats temp-only screenshot without save line", () => {
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(3072) });

		expect(
			formatScreenshot({
				saveFullRes: false,
				savedMimeType: "image/webp",
				savedByteLength: 3072,
				dest: path.join(os.tmpdir(), "omp-sshots-123.png"),
				resized,
			}),
		).toEqual(["Screenshot captured", "Format: image/webp (3.00 KB)", "Dimensions: 800x600"]);
	});

	it("surfaces screenshots that could not be resized", () => {
		const resized = fakeResized({ decodeFailed: true, mimeType: "image/png", buffer: new Uint8Array(4096) });

		expect(
			formatScreenshot({
				saveFullRes: false,
				savedMimeType: "image/png",
				savedByteLength: 4096,
				dest: path.join(os.tmpdir(), "omp-sshots-123.png"),
				resized,
			}),
		).toContain("Resize: image decoder failed; using original image bytes");
	});

	it("appends dimension note when image was resized", () => {
		const resized = fakeResized({
			wasResized: true,
			originalWidth: 1600,
			originalHeight: 1200,
			width: 800,
			height: 600,
		});

		const lines = formatScreenshot({
			saveFullRes: false,
			savedMimeType: "image/webp",
			savedByteLength: 2048,
			dest: path.join(os.tmpdir(), "shot.png"),
			resized,
		});

		expect(lines).toContain(
			"[Image: original 1600x1200, displayed at 800x600. Multiply coordinates by 2.00 to map to original image.]",
		);
	});
});

describe("formatDiagnostics", () => {
	it("replaces tabs in rendered diagnostic text", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const formatted = formatDiagnostics(
			{
				errored: true,
				summary: "1\terror(s)",
				messages: [
					"src/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					"\tunparsed diagnostic\tmessage",
				],
			},
			true,
			theme!,
			() => "go",
		);

		expect(formatted).not.toContain("\t");
		expect(formatted.replace(/\s+/g, " ")).toContain("too many arguments in call");
		expect(formatted.replace(/\s+/g, " ")).toContain("unparsed diagnostic message");
		expect(formatted.replace(/\s+/g, " ")).toContain("1 error(s)");
	});
});

describe("formatCodeFrameLine", () => {
	it("pads markers as part of the gutter", () => {
		expect(formatCodeFrameLine(" ", 447, "context", 3)).toBe(" 447│context");
		expect(formatCodeFrameLine("*", 448, "match", 3)).toBe("*448│match");
		expect(formatCodeFrameLine("+", 11, "added", 3)).toBe(" +11│added");
		expect(formatCodeFrameLine("+", 235, "added", 3)).toBe("+235│added");
	});
});

describe("truncateDiffByHunk", () => {
	function makeHunk(prefix: "-" | "+", line: number, count: number): string[] {
		return Array.from({ length: count }, (_, i) => `${prefix} ${prefix === "-" ? "old" : "new"} ${line + i}`);
	}

	function buildDiff(hunkCount: number, linesPerHunk: number): string {
		const lines: string[] = [];
		for (let h = 0; h < hunkCount; h++) {
			lines.push(`@@ hunk ${h} @@`);
			lines.push(...makeHunk("-", h * 100, linesPerHunk));
			lines.push(...makeHunk("+", h * 100, linesPerHunk));
			lines.push(" ctx");
		}
		return lines.join("\n");
	}

	it("keeps trailing hunks when fromTail is set", () => {
		// 6 hunks total, 2 +/- lines per hunk → 4 change lines per hunk plus
		// header/context. Cap budget tight enough to force truncation.
		const diff = buildDiff(6, 2);
		const head = truncateDiffByHunk(diff, 2, 8);
		const tail = truncateDiffByHunk(diff, 2, 8, { fromTail: true });

		// Both modes drop the same number of hunks/lines.
		expect(tail.hiddenHunks).toBe(head.hiddenHunks);
		expect(tail.hiddenLines).toBe(head.hiddenLines);

		// Head shows the first hunk markers; tail shows the last hunk markers.
		expect(head.text).toContain("- old 0");
		expect(head.text).not.toContain("- old 500");
		expect(tail.text).toContain("- old 500");
		expect(tail.text).not.toContain("- old 0");
	});

	it("returns the full diff unchanged when within budget regardless of fromTail", () => {
		const diff = buildDiff(1, 1);
		const head = truncateDiffByHunk(diff, 4, 32);
		const tail = truncateDiffByHunk(diff, 4, 32, { fromTail: true });
		expect(head.text).toBe(diff);
		expect(tail.text).toBe(diff);
		expect(tail.hiddenHunks).toBe(0);
		expect(tail.hiddenLines).toBe(0);
	});

	it("preserves change/context line order within a kept hunk under fromTail", () => {
		// Single hunk with intra-segment context: leading context, change, trailing context.
		const diff = [
			"@@ only @@",
			" leading-ctx-a",
			" leading-ctx-b",
			"- old line",
			"+ new line",
			" trailing-ctx-a",
			" trailing-ctx-b",
		].join("\n");
		const { text } = truncateDiffByHunk(diff, 4, 32, { fromTail: true });
		const idxOld = text.indexOf("- old line");
		const idxNew = text.indexOf("+ new line");
		const idxLeading = text.indexOf("leading-ctx-a");
		const idxTrailing = text.indexOf("trailing-ctx-b");
		// In-order: leading context appears before change which appears before trailing context.
		expect(idxLeading).toBeLessThan(idxOld);
		expect(idxOld).toBeLessThan(idxNew);
		expect(idxNew).toBeLessThan(idxTrailing);
	});
	it("caps one oversized change hunk at the line budget", () => {
		const diff = makeHunk("+", 0, 1_000).join("\n");
		const head = truncateDiffByHunk(diff, 4, 32);
		const tail = truncateDiffByHunk(diff, 4, 32, { fromTail: true });

		expect(head.text.split("\n")).toHaveLength(32);
		expect(head.text).toStartWith("+ new 0\n");
		expect(head.text).toEndWith("+ new 31");
		expect(head.hiddenLines).toBe(968);
		expect(head.hiddenHunks).toBe(0);

		expect(tail.text.split("\n")).toHaveLength(32);
		expect(tail.text).toStartWith("+ new 968\n");
		expect(tail.text).toEndWith("+ new 999");
		expect(tail.hiddenLines).toBe(968);
		expect(tail.hiddenHunks).toBe(0);
	});

	it("keeps an exact-size change hunk unchanged", () => {
		const diff = makeHunk("-", 0, 32).join("\n");
		expect(truncateDiffByHunk(diff, 4, 32)).toEqual({
			text: diff,
			hiddenHunks: 0,
			hiddenLines: 0,
		});
	});
	it("drops surrounding context when changes exactly fill the line budget", () => {
		const diff = [" leading context", ...makeHunk("+", 0, 32), " trailing context"].join("\n");

		for (const result of [truncateDiffByHunk(diff, 4, 32), truncateDiffByHunk(diff, 4, 32, { fromTail: true })]) {
			expect(result.text.split("\n")).toHaveLength(32);
			expect(result.text).not.toContain("context");
			expect(result.hiddenLines).toBe(2);
			expect(result.hiddenHunks).toBe(0);
		}
	});

	it("does not exceed the line budget when context rounding spans multiple hunks", () => {
		const diff = [
			" leading context",
			...makeHunk("+", 0, 15),
			" middle context a",
			" middle context b",
			...makeHunk("-", 100, 15),
			" trailing context",
		].join("\n");

		for (const result of [truncateDiffByHunk(diff, 4, 32), truncateDiffByHunk(diff, 4, 32, { fromTail: true })]) {
			expect(result.text.split("\n")).toHaveLength(32);
			expect(result.hiddenLines).toBe(2);
			expect(result.hiddenHunks).toBe(0);
		}
	});
	it("does not count a removed separator as a hidden hunk", () => {
		const diff = [...makeHunk("+", 0, 16), " hunk separator", ...makeHunk("-", 100, 16)].join("\n");

		for (const result of [truncateDiffByHunk(diff, 4, 32), truncateDiffByHunk(diff, 4, 32, { fromTail: true })]) {
			expect(result.text.split("\n")).toHaveLength(32);
			expect(result.hiddenLines).toBe(1);
			expect(result.hiddenHunks).toBe(0);
		}
	});
	it("reports every hunk excluded by the hunk limit", () => {
		const diff = buildDiff(6, 1);

		for (const result of [truncateDiffByHunk(diff, 2, 100), truncateDiffByHunk(diff, 2, 100, { fromTail: true })]) {
			expect(result.hiddenHunks).toBe(4);
		}
	});
});

describe("formatErrorMessage (F4 sanitization)", () => {
	beforeAll(async () => {
		await initTheme();
	});
	it("replaces tabs in error content with spaces", () => {
		const out = formatErrorMessage("apply_patch failed:\n@@\n-old\tindented\n+new", theme);
		expect(out).not.toContain("\t");
	});

	it("truncates very long error messages to keep TUI from overflowing", () => {
		const longTail = "x".repeat(500);
		const out = formatErrorMessage(`crash: ${longTail}`, theme);
		// Strip ANSI escape sequences so we can measure the user-visible length.
		const ESC = String.fromCharCode(0x1b);
		const visible = out
			.split(ESC)
			.map((s, i) => (i === 0 ? s : s.replace(/^\[[0-9;]*m/, "")))
			.join("");
		// LINE truncation cap is 110 chars; account for the "Error: " prefix and
		// the leading symbol+space.
		expect(visible.length).toBeLessThan(180);
	});

	it("falls back to 'Unknown error' for empty/missing input", () => {
		const out = formatErrorMessage(undefined, theme);
		expect(out).toContain("Unknown error");
	});
});

describe("formatExpandHint / expandKeyHint", () => {
	// Plain stub: `fg` is a passthrough and brackets are literal `[`/`]`, so the
	// rendered hint is deterministic regardless of the active theme's bracket glyphs.
	const plainTheme = {
		fg: (_color: unknown, text: string) => text,
		format: { bracketLeft: "[", bracketRight: "]" },
	} as unknown as Theme;

	let previous: TuiKeybindingsManager;
	beforeEach(() => {
		previous = getKeybindings();
		setKeyHintPlatform("linux");
	});
	afterEach(() => {
		setKeybindings(previous);
		setKeyHintPlatform(undefined);
	});

	it("reports the default tool-output expand key", () => {
		setKeybindings(KeybindingsManager.inMemory());
		expect(expandKeyHint()).toBe("Ctrl+O");
		// Single bracket pair from the theme, no double-wrapping around the key.
		expect(formatExpandHint(plainTheme, false, true)).toBe("[Ctrl+O: Expand]");
	});

	it("tracks a user remap of the expand binding", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+e" }));
		expect(expandKeyHint()).toBe("Alt+E");
		expect(formatExpandHint(plainTheme, false, true)).toBe("[Alt+E: Expand]");
	});

	it("renders nothing when expanded or there is no more content", () => {
		setKeybindings(KeybindingsManager.inMemory());
		expect(formatExpandHint(plainTheme, true, true)).toBe("");
		expect(formatExpandHint(plainTheme, false, false)).toBe("");
	});
});
