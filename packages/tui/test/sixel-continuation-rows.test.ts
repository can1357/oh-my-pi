import { afterEach, describe, expect, it } from "bun:test";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { formatOutputPaneLines, OutputPane } from "@oh-my-pi/pi-tui/render/output-pane";
import { classifySixelRow } from "@oh-my-pi/pi-tui/render/sixel";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";

const originalProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	TERMINAL.imageProtocol = originalProtocol;
});

/** A three-row frame: introducer, continuation, terminator. */
const HEAD = `\x1bPq${"A".repeat(60)}`;
const MID = `${"B".repeat(60)}`;
const LAST = `${"C".repeat(60)}\x1b\\`;

describe("SIXEL continuation rows through the visual cap", () => {
	it("keeps a multi-row frame whole when the eval card caps by visual lines", async () => {
		// Failure mode: the eval tool card caps with `visual: true` and no
		// `uncapSixel`, so every row went through the text wrapper. A DCS payload
		// is printable text to that wrapper: the frame is split across rows,
		// padded with spaces, and its terminator is cut, leaving the host terminal
		// inside an open string that swallows the rest of the output.
		TERMINAL.imageProtocol = ImageProtocol.Sixel;
		const theme: Theme = (await getThemeByName("dark"))!;

		const formatted = formatOutputPaneLines(
			{
				lines: [HEAD, MID, LAST, "tail1", "tail2"],
				expanded: false,
				collapsedMaxLines: 3,
				edge: "tail",
				visual: true,
				width: 20,
				styleLine: line => line,
				showHiddenMarker: false,
			},
			theme,
		);

		expect(formatted.lines).toContain(HEAD);
		expect(formatted.lines).toContain(MID);
		expect(formatted.lines).toContain(LAST);
		expect(formatted.lines.join("\n")).toContain("tail2");
	});

	it("keeps the 8-bit introducer and its continuation rows whole", async () => {
		// Same failure through the other legal introducer spelling, which the
		// marker scan recognised only as `ESC P` before.
		TERMINAL.imageProtocol = ImageProtocol.Sixel;
		const theme: Theme = (await getThemeByName("dark"))!;
		const head8 = `\x90q${"A".repeat(60)}`;
		const last8 = `${"C".repeat(60)}\x9c`;

		const formatted = formatOutputPaneLines(
			{
				lines: [head8, last8, "tail1", "tail2"],
				expanded: false,
				collapsedMaxLines: 3,
				edge: "tail",
				visual: true,
				width: 20,
				styleLine: line => line,
				showHiddenMarker: false,
			},
			theme,
		);

		expect(formatted.lines).toContain(head8);
		expect(formatted.lines).toContain(last8);
	});

	it("still caps and wraps a stream that carries no frame", async () => {
		// Negative contract: the payload exemption is scoped to payload rows, so
		// ordinary output keeps its cap and its wrapping.
		TERMINAL.imageProtocol = ImageProtocol.Sixel;
		const theme: Theme = (await getThemeByName("dark"))!;
		const pane = new OutputPane(theme, {
			expanded: false,
			collapsedMaxLines: 2,
			edge: "tail",
			uncapSixel: true,
			visual: true,
			paddingX: 0,
		});
		pane.setLines([`${"a".repeat(60)}`, "keep1", "keep2"]);

		const rows = pane.render(20);

		expect(rows.join("\n")).not.toContain("a".repeat(60));
		expect(rows.join("\n")).toContain("keep2");
	});
});

describe("SIXEL row classification across frames", () => {
	it("closes a row that holds two complete frames", () => {
		// Failure mode: `matchSixelIntroducer` reports an absolute offset but the
		// walk added it to the current index, so the second frame's introducer was
		// stepped over. The row reported itself still inside a DCS, and every row
		// after it was treated as payload and never clamped.
		const seven = "\x1bPq#0;2;100;0;0#0~~\x1b\\";
		const eight = "\x90q#0;2;100;0;0#0~~\x9c";

		expect(classifySixelRow(`${seven}between${eight}`, false)).toEqual({
			isSixel: true,
			inSequenceAtExit: false,
		});
	});
});
