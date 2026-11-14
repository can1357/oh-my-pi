import { describe, expect, it } from "bun:test";
import { OutputPane, type OutputPaneOptions } from "@oh-my-pi/pi-tui/render/output-pane";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { ensureThemeSync, getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { resetHangulCompatibilityJamoWidthForTests, setHangulCompatibilityJamoWidth } from "@oh-my-pi/pi-tui/utils";

ensureThemeSync();

/**
 * A pane that styles every row through the active theme — the shape both
 * in-tree consumers use.
 */
const DEFAULT_OPTIONS: OutputPaneOptions = {
	expanded: false,
	collapsedMaxLines: 20,
	edge: "tail",
	visual: true,
	paddingX: 1,
	leadingBlank: true,
	showHiddenMarker: false,
	showExpandHint: false,
	styleLine: line => theme.fg("muted", line),
};

function makePane(lines: string[], options: OutputPaneOptions = DEFAULT_OPTIONS): OutputPane {
	const pane = new OutputPane(theme, options);
	pane.setLines(lines);
	return pane;
}

describe("OutputPane render memo", () => {
	it("re-renders when rows are appended in place", () => {
		// `append` mutates the row array in place, so a memo keyed on row
		// identity alone would keep serving the pre-append content.
		const pane = makePane(["first"]);
		const before = pane.render(40);

		pane.append("\nsecond");

		expect(pane.render(40)).not.toEqual(before);
		expect(pane.render(40).join("\n")).toContain("second");
	});

	it("re-renders when the rows are replaced", () => {
		const pane = makePane(["first"]);
		const before = pane.render(40);

		pane.setLines(["different"]);

		expect(pane.render(40)).not.toEqual(before);
		expect(pane.render(40).join("\n")).toContain("different");
	});

	it("re-renders when the presentation options change", () => {
		// More rows than the collapsed cap, so expanding shows rows the
		// collapsed view hides.
		const rows = Array.from({ length: 25 }, (_, i) => `row ${i}`);
		const pane = makePane(rows);
		const collapsed = pane.render(40);

		pane.setExpanded(true);

		expect(pane.render(40)).not.toEqual(collapsed);
	});

	it("re-renders when the caller invalidates it after its own state changed", () => {
		// A caller-supplied `styleLine` may close over state the pane cannot
		// see. Invalidation is how the caller reports that it changed; without
		// it the pane would keep serving the previously styled rows.
		let pty = false;
		const options: OutputPaneOptions = {
			...DEFAULT_OPTIONS,
			styleLine: line => (pty ? line : theme.fg("muted", line)),
		};
		const pane = makePane(["first"], options);
		const styled = pane.render(40);

		pty = true;
		pane.invalidate();

		expect(pane.render(40)).not.toEqual(styled);
	});

	it("renders what a fresh pane renders when the width changes", () => {
		// The visual cap counts *wrapped* lines, so which rows survive the cap
		// depends on the width.
		const rows = Array.from({ length: 6 }, (_, i) => `row ${i} ${"x".repeat(60)}`);
		const options: OutputPaneOptions = { ...DEFAULT_OPTIONS, collapsedMaxLines: 4, paddingX: 0, leadingBlank: false };
		const pane = makePane(rows, options);
		pane.render(20);

		const fresh = makePane(rows, options);

		expect(pane.render(80)).toEqual(fresh.render(80));
	});

	it("re-renders when only the padding changes at the same width", () => {
		// The memo key must carry the content width, not the raw width: two
		// panes at the same width with different paddings wrap differently,
		// and a key on `width` alone would serve one's render to the other.
		const rows = Array.from({ length: 6 }, (_, i) => `row ${i} ${"x".repeat(60)}`);
		const narrow = makePane(rows, { ...DEFAULT_OPTIONS, collapsedMaxLines: 4, paddingX: 0, leadingBlank: false });
		const wide = makePane(rows, { ...DEFAULT_OPTIONS, collapsedMaxLines: 4, paddingX: 6, leadingBlank: false });
		narrow.render(40);

		expect(wide.render(40)).toEqual(
			makePane(rows, { ...DEFAULT_OPTIONS, collapsedMaxLines: 4, paddingX: 6, leadingBlank: false }).render(40),
		);
		expect(wide.render(40)).not.toEqual(narrow.render(40));
	});

	it("renders what a fresh pane renders when the width configuration changes", () => {
		// The visual cap counts visual lines, and the width of a Hangul
		// Compatibility Jamo depends on the width-affecting runtime
		// configuration — so a change to it can change which rows survive
		// the cap.
		const rows = Array.from({ length: 10 }, (_, i) => `row ${i} ${"ㄱ".repeat((i + 1) * 10)}`);
		const options: OutputPaneOptions = { ...DEFAULT_OPTIONS, collapsedMaxLines: 4, paddingX: 0, leadingBlank: false };
		const pane = makePane(rows, options);
		pane.render(20);

		setHangulCompatibilityJamoWidth(1);
		try {
			const fresh = makePane(rows, options);

			expect(pane.render(20)).toEqual(fresh.render(20));
		} finally {
			resetHangulCompatibilityJamoWidthForTests();
		}
	});

	it("renders what a fresh pane renders when the image protocol changes", () => {
		// A sixel payload row is styled under other protocols and passed
		// through untouched under sixel, so the rendered bytes differ.
		const rows = ["\x1bPqpayload\x1b\\"];
		const pane = makePane(rows);
		const previous = TERMINAL.imageProtocol;
		try {
			setTerminalImageProtocol(ImageProtocol.Kitty);
			pane.render(40);

			setTerminalImageProtocol(ImageProtocol.Sixel);
			const fresh = makePane(rows);

			expect(pane.render(40)).toEqual(fresh.render(40));
		} finally {
			setTerminalImageProtocol(previous);
		}
	});

	it("renders what a fresh pane renders when the theme changes", async () => {
		// The styled rows bake in the active theme's colors, so a theme switch
		// must re-shape them even though the rows themselves did not change.
		const [dark, light] = await Promise.all([getThemeByName("dark"), getThemeByName("light")]);
		// Builtin themes: if either is missing the theme-epoch case would pass
		// silently without asserting anything, so fail loudly instead.
		expect(dark).toBeDefined();
		expect(light).toBeDefined();
		if (dark === undefined || light === undefined) throw new Error("builtin dark/light themes must exist");
		const previous = theme;
		try {
			setThemeInstance(dark);
			const pane = makePane(["first"]);
			pane.render(40);

			setThemeInstance(light);
			const fresh = makePane(["first"]);

			expect(pane.render(40)).toEqual(fresh.render(40));
		} finally {
			setThemeInstance(previous);
		}
	});
});
