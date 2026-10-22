import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { OutputPane } from "@oh-my-pi/pi-tui/render/output-pane";
import { getThemeByName, type Theme, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

describe("OutputPane SIXEL rows", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let theme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("Expected dark theme");
		theme = loaded;
	});

	afterEach(() => {
		TERMINAL.imageProtocol = originalProtocol;
		setThemeInstance(theme);
	});

	it("renders a classified sixel row raw instead of wrapping it at the pane width", () => {
		// Failure mode: `OutputPane.render` handed every formatted row to `Text`,
		// which wraps at the pane width. The DCS introducer is an escape, but the
		// payload bytes are treated as printable text, so a frame wider than the
		// pane is split across rows and padded with spaces. The sixel data the
		// terminal finally receives contains newlines and blanks, so the image is
		// garbled or dropped instead of rasterized.
		TERMINAL.imageProtocol = ImageProtocol.Sixel;

		const head = `\x1bPq${"A".repeat(40)}`;
		const tail = `${"B".repeat(40)}\x1b\\`;
		const pane = new OutputPane(theme, {
			expanded: false,
			collapsedMaxLines: 4,
			edge: "tail",
			uncapSixel: true,
			visual: true,
			paddingX: 1,
		});
		pane.setLines([head, tail, "plain row"]);

		const rows = pane.render(20);

		// Both payload rows survive byte-for-byte, in stream order, with no
		// wrapping artifact injected between them. The pane's left margin sits
		// outside the DCS, so the frame still starts where the plain rows do.
		expect(rows).toContain(` ${head}`);
		expect(rows).toContain(` ${tail}`);
		expect(rows.join("\n")).toContain("plain row");
		expect(rows.length).toBe(3);
	});

	it("keeps the pane's left margin on a sixel row", () => {
		// A payload row bypasses `Text`, which is what applies the pane's
		// padding: without the margin the image started at column 0 while
		// every other row started one cell in.
		TERMINAL.imageProtocol = ImageProtocol.Sixel;

		const frame = `\x1bPq${"A".repeat(40)}\x1b\\`;
		const pane = new OutputPane(theme, {
			expanded: false,
			collapsedMaxLines: 4,
			edge: "tail",
			uncapSixel: true,
			visual: true,
			paddingX: 1,
		});
		pane.setLines([frame, "plain row"]);

		const rows = pane.render(20);
		const payloadRow = rows.find(row => row.includes("\x1bPq"));
		const plainRow = rows.find(row => row.includes("plain row"));

		expect(payloadRow?.startsWith(" ")).toBe(true);
		expect(plainRow?.startsWith(" ")).toBe(true);
		// The margin is outside the DCS: the payload itself is untouched.
		expect(payloadRow).toBe(` ${frame}`);
	});

	it("keeps wrapping plain rows at the pane width", () => {
		// Negative contract: the raw pass-through is scoped to payload rows, so a
		// stream without a frame still wraps and caps exactly as before.
		TERMINAL.imageProtocol = ImageProtocol.Sixel;

		const pane = new OutputPane(theme, {
			expanded: false,
			collapsedMaxLines: 4,
			edge: "tail",
			uncapSixel: true,
			visual: true,
			paddingX: 1,
		});
		pane.setLines([`${"a".repeat(40)}`, "plain row"]);

		const rows = pane.render(20);

		expect(rows.join("\n")).not.toContain("a".repeat(40));
		expect(rows.join("\n")).toContain("plain row");
	});
});
