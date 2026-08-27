import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	ASK_ROW_PREFIX_COLUMNS,
	type AskQuestionRow,
	type AskRowRenderContext,
	askOptionMarker,
	askRowPrefixColumns,
	renderAskRow,
} from "@oh-my-pi/pi-coding-agent/modes/components/ask-row";
import { loadThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import { getMarkdownTheme, getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme-class";
import { CURSOR_MARKER, visibleWidth } from "@oh-my-pi/pi-tui";

let darkTheme: Theme | undefined;
// setThemeInstance replaces process-wide theme state and disables
// auto-detection, so capture the prior instance and restore it after the
// file; otherwise later test files inherit this file's dark theme.
let priorTheme: Theme | undefined;

function strip(line: string): string {
	return stripVTControlCharacters(line);
}

function question(multi: boolean | undefined, description?: string): ExtensionAskDialogQuestion {
	return {
		id: "q1",
		question: "Pick?",
		multi,
		options: [{ label: "Option A", description }, { label: "Option B" }],
	};
}

function row(index = 0): AskQuestionRow {
	return { kind: "option", key: `opt:${index}`, label: "Option A", optionIndex: index };
}

function makeCtx(overrides: Partial<AskRowRenderContext> = {}): AskRowRenderContext {
	return {
		question: question(false),
		focused: false,
		checked: false,
		jumpDigit: undefined,
		expanded: false,
		note: undefined,
		customInput: undefined,
		width: 40,
		mdTheme: getMarkdownTheme(),
		declareCursor: false,
		...overrides,
	};
}

/** Extract the ANSI-styled marker span (the `theme.fg(...)` run wrapping the marker glyph). */
function styledMarker(line: string, glyph: string): string {
	const glyphIndex = line.indexOf(glyph);
	expect(glyphIndex).toBeGreaterThan(-1);
	const start = line.lastIndexOf("\x1b[", glyphIndex);
	const end = line.indexOf("\x1b[39m", glyphIndex) + "\x1b[39m".length;
	return line.slice(start, end);
}

describe("askRow", () => {
	beforeAll(async () => {
		priorTheme = theme;
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
	});

	it("prefix is exactly ASK_ROW_PREFIX_COLUMNS wide for focused × multi × jumpDigit", () => {
		const variants: Array<{ multi: boolean | undefined; focused: boolean; jumpDigit: string | undefined }> = [];
		// `false` and `undefined` share the same falsy single-select branch in
		// askOptionMarker/renderAskRow, so only one of the two is exercised.
		for (const multi of [true, undefined] as const) {
			for (const focused of [false, true]) {
				for (const jumpDigit of [undefined, "4"]) {
					variants.push({ multi, focused, jumpDigit });
				}
			}
		}
		for (const v of variants) {
			const { lines } = renderAskRow(
				row(),
				makeCtx({ question: question(v.multi), focused: v.focused, jumpDigit: v.jumpDigit }),
			);
			const first = strip(lines[0]);
			const prefix = first.slice(0, ASK_ROW_PREFIX_COLUMNS);
			expect(visibleWidth(prefix)).toBe(ASK_ROW_PREFIX_COLUMNS);
			expect(prefix).toHaveLength(ASK_ROW_PREFIX_COLUMNS);
		}
	});

	it("marker colour follows checked only and is unchanged by toggling focused", () => {
		const q = question(true);
		const glyph = askOptionMarker(theme, true, true);

		const unfocused = renderAskRow(row(), makeCtx({ question: q, focused: false, checked: true })).lines[0];
		const focused = renderAskRow(row(), makeCtx({ question: q, focused: true, checked: true })).lines[0];

		// Both renders must style the checked marker identically — focus never
		// changes the marker's hue. Compare the raw styled spans byte-for-byte.
		expect(styledMarker(focused, glyph)).toBe(styledMarker(unfocused, glyph));

		// And the marker is the success color for a checked row.
		expect(styledMarker(focused, glyph)).toBe(theme.fg("success", glyph));
	});

	it("collapsed description shows PREVIEW_LIMITS.COLLAPSED_LINES lines plus a counted cue; expanded shows every line", () => {
		// A 120-char description wraps to 5 lines at contentWidth = width - 6 = 24.
		// PREVIEW_LIMITS.COLLAPSED_LINES = 3, so collapsed shows 3 + cue.
		const description = "abc ".repeat(30).trim();
		const q = question(undefined, description);

		const collapsed = renderAskRow(row(), makeCtx({ question: q, focused: true, expanded: false, width: 30 }));
		const expanded = renderAskRow(row(), makeCtx({ question: q, focused: true, expanded: true, width: 30 }));

		// Collapsed: label (1) + first three description lines + cue (1).
		expect(collapsed.lines).toHaveLength(5);
		const cue = collapsed.lines.find(line => strip(line).includes("more lines"));
		expect(cue).toBeDefined();
		expect(strip(cue ?? "")).toContain("2 more lines");
		expect(collapsed.hiddenDescriptionLines).toBe(2);

		// Expanded: label (1) + all five description lines, no cue.
		expect(expanded.lines).toHaveLength(6);
		expect(expanded.lines.find(line => strip(line).includes("more lines"))).toBeUndefined();
		expect(expanded.hiddenDescriptionLines).toBe(0);
	});

	it("description is emitted only for the focused row — unfocused carries no description lines, no cue, no hidden count", () => {
		const description = "abc ".repeat(30).trim();
		const q = question(undefined, description);

		const unfocused = renderAskRow(row(), makeCtx({ question: q, focused: false, expanded: false, width: 30 }));
		// Prefix + label only: the description and its cue must not appear.
		expect(unfocused.lines).toHaveLength(1);
		expect(unfocused.lines.some(line => strip(line).includes("more lines"))).toBe(false);
		expect(unfocused.lines.some(line => strip(line).includes("abc"))).toBe(false);
		expect(unfocused.hiddenDescriptionLines).toBe(0);

		// Same option, focused: collapsed still hides a surplus behind a cue.
		const focused = renderAskRow(row(), makeCtx({ question: q, focused: true, expanded: false, width: 30 }));
		expect(focused.hiddenDescriptionLines).toBeGreaterThan(0);
		expect(focused.lines.some(line => strip(line).includes("abc"))).toBe(true);
		expect(focused.lines.some(line => strip(line).includes("more lines"))).toBe(true);
	});

	it("a wrapped long label's continuation lines indent by exactly ASK_ROW_PREFIX_COLUMNS", () => {
		// contentWidth = width - 6 = 24; a 60-char label wraps to 3 lines.
		const r: AskQuestionRow = { kind: "option", key: "opt:0", label: "Z".repeat(60), optionIndex: 0 };
		const { lines } = renderAskRow(r, makeCtx({ focused: false, width: 30 }));

		// The first line carries the 6-column prefix; every later line is a
		// wrapped-label continuation indented by the same amount.
		expect(strip(lines[0]).slice(0, ASK_ROW_PREFIX_COLUMNS)).toHaveLength(ASK_ROW_PREFIX_COLUMNS);
		const continuationLines = lines.slice(1);
		expect(continuationLines.length).toBeGreaterThan(0);
		for (const line of continuationLines) {
			const stripped = strip(line);
			expect(stripped.slice(0, ASK_ROW_PREFIX_COLUMNS)).toBe(" ".repeat(ASK_ROW_PREFIX_COLUMNS));
			expect(visibleWidth(stripped)).toBeGreaterThan(ASK_ROW_PREFIX_COLUMNS);
		}
	});

	it("emits CURSOR_MARKER exactly once, only when focused && declareCursor", () => {
		// Unfocused never declares a cursor, regardless of declareCursor.
		const never = renderAskRow(row(), makeCtx({ focused: false, declareCursor: false })).lines.join("");
		expect(never).not.toContain(CURSOR_MARKER);
		const unfocusedDeclared = renderAskRow(row(), makeCtx({ focused: false, declareCursor: true })).lines.join("");
		expect(unfocusedDeclared).not.toContain(CURSOR_MARKER);

		// Focused but not declaring carries no marker either.
		const focusedNoDeclare = renderAskRow(row(), makeCtx({ focused: true, declareCursor: false })).lines.join("");
		expect(focusedNoDeclare).not.toContain(CURSOR_MARKER);

		// Focused + declared: exactly one marker, on the first line, after the
		// cursor cell — and an expanded description adds no extra markers.
		const focusedDeclared = renderAskRow(
			row(),
			makeCtx({ focused: true, declareCursor: true, expanded: true, width: 30 }),
		).lines;
		const joined = focusedDeclared.join("");
		expect(joined.split(CURSOR_MARKER).length - 1).toBe(1);
		expect(focusedDeclared[0].indexOf(CURSOR_MARKER)).toBeGreaterThan(0);
	});
	it("keeps the note marker visible without exceeding row width when the label fills the row", () => {
		const r: AskQuestionRow = { kind: "option", key: "opt:0", label: "X".repeat(80), optionIndex: 0 };
		const { lines } = renderAskRow(r, makeCtx({ note: "saved", width: 30 }));
		// The note marker appears once across all lines, and no line exceeds
		// the row width.
		const noteLines = lines.filter(line => strip(line).includes("✎ note"));
		expect(noteLines).toHaveLength(1);
		for (const line of lines) {
			expect(visibleWidth(strip(line))).toBeLessThanOrEqual(30);
		}
	});

	it("a noted long label uses full content width for continuations and no line exceeds row width", () => {
		// contentWidth = width - 6 = 24. A 72-char label wraps to 3 full
		// lines (24+24+24). The note marker must not narrow the wrap budget:
		// continuation lines fill the full 24-column content width, the note
		// marker lands on the final row (which has room), and no rendered
		// line exceeds the row width.
		const r: AskQuestionRow = { kind: "option", key: "opt:0", label: "Z".repeat(72), optionIndex: 0 };
		const { lines } = renderAskRow(r, makeCtx({ note: "saved", width: 30 }));

		expect(lines.length).toBeGreaterThanOrEqual(3);

		// Every line stays within the row width.
		for (const line of lines) {
			expect(visibleWidth(strip(line))).toBeLessThanOrEqual(30);
		}

		// Continuation lines (lines[1] and lines[2]) must use the full
		// content width — 6 prefix + 24 content = 30 — proving the note
		// marker did not steal columns from the wrap budget.
		const continuation1 = strip(lines[1] ?? "");
		const continuation2 = strip(lines[2] ?? "");
		expect(visibleWidth(continuation1)).toBe(30);
		expect(visibleWidth(continuation2)).toBe(30);

		// The note marker appears exactly once, on the last label line.
		const noteLines = lines.filter(line => strip(line).includes("✎ note"));
		expect(noteLines).toHaveLength(1);
		const lastLabelLine = lines[lines.length - 1] ?? "";
		expect(strip(lastLabelLine)).toContain("✎ note");
	});

	it("replaces tabs in the label and description before rendering", () => {
		// A raw tab would expand to the terminal's tab stop instead of the
		// width the layout helpers measured, shifting the row past its
		// boundary. replaceTabs normalizes it to spaces first.
		const q = question(undefined, "line one\tcontinued");
		const r: AskQuestionRow = { kind: "option", key: "opt:0", label: "Tab\there", optionIndex: 0 };
		const { lines } = renderAskRow(r, makeCtx({ question: q, focused: true, width: 40 }));
		const joined = lines.map(strip).join("\n");
		expect(joined).not.toContain("\t");
		expect(joined).toContain("Tab");
		expect(joined).toContain("continued");
	});

	it("prefix width tracks the ASCII preset's three-column marker", () => {
		const asciiTheme = loadThemeSync("dark", { symbolPresetOverride: "ascii" });
		setThemeInstance(asciiTheme);
		try {
			// multi → checkbox marker "[ ]" = 3 columns; 4 fixed cells + 3 + 1
			// spacer = 8 prefix columns, vs the default preset's 6.
			const q = question(true);
			const r: AskQuestionRow = { kind: "option", key: "opt:0", label: "Z".repeat(60), optionIndex: 0 };
			const { lines } = renderAskRow(r, makeCtx({ question: q, focused: false, width: 30 }));
			expect(askRowPrefixColumns(true)).toBe(8);
			const continuationLines = lines.slice(1);
			expect(continuationLines.length).toBeGreaterThan(0);
			for (const line of continuationLines) {
				const stripped = strip(line);
				// Continuation indent must match the actual first-line prefix
				// (8), not the default constant (6) — a constant would leave
				// continuations two columns short of the marker.
				expect(stripped.slice(0, 8)).toBe(" ".repeat(8));
			}
		} finally {
			if (darkTheme) setThemeInstance(darkTheme);
		}
	});
});
