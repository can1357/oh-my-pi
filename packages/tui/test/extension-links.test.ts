import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	extensionLinkLabels,
	setExtensionLinks,
	stripExtensionLinkMarkers,
} from "@oh-my-pi/pi-tui/render/extension-links";
import {
	ImageProtocol,
	setTerminalImageProtocol,
	setTerminalTextSizing,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme(false);
});

// The registry is process-wide: start and leave every test with nothing claimed.
beforeEach(() => {
	setExtensionLinks([], false);
});
afterEach(() => {
	setExtensionLinks([], false);
});

const render = (text: string, width = 80) => new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
const plain = (line: string) => Bun.stripANSI(line);

/** Every extension link label drawn on `rows`, as `row:first-last cell=url` runs. */
function linkCells(rows: readonly string[]): string[] {
	return rows.flatMap((row, index) =>
		extensionLinkLabels(row).map(label => `${index}:${label.start}-${label.end - 1}=${label.url}`),
	);
}

describe("extension-owned links", () => {
	const text = "Open [the details](demo:open/7) or [the docs](https://example.com/docs).";

	it("draws exactly as any other link while no extension claims the scheme", () => {
		expect(plain(render(text)[0]!)).toContain("the details (demo:open/7)");
	});

	it("drops the URL suffix for a claimed scheme and leaves other links alone", () => {
		setExtensionLinks(["demo"], false);
		const row = plain(render(text)[0]!);
		expect(row).toContain("Open the details or the docs (https://example.com/docs).");
		// Without click routing there is nothing to hit-test, and no hyperlink the terminal could open.
		expect(render(text)[0]).not.toContain("demo:open/7");
	});

	it("maps exactly the label's cells to the URL while clicks are routed, across a wrapped label", () => {
		setExtensionLinks(["demo"], true);
		expect(linkCells(render(text))).toEqual(["0:5-15=demo:open/7"]);

		const wrapped = render("Some words before [a much longer link label](demo:open/8) after", 30);
		const rows = wrapped.map(plain);
		const cells = linkCells(wrapped);
		// Each run covers the label text on its row, nothing else.
		for (const run of cells) {
			const [, rowIndex, start, end] = /^(\d+):(\d+)-(\d+)=/.exec(run)!;
			expect("a much longer link label").toContain(rows[Number(rowIndex)]!.slice(Number(start), Number(end) + 1));
		}
		expect(cells.length).toBe(2);
		expect(cells.every(run => run.endsWith("=demo:open/8"))).toBe(true);
	});

	it("strips only omp's link markers from what the terminal receives, even once unclaimed", () => {
		setExtensionLinks(["demo"], true);
		const rows = render(
			"Some words before [a much longer link label](demo:open/8) then [docs](https://example.com)",
			30,
		);
		const out = rows.map(stripExtensionLinkMarkers);
		expect(out.join("")).not.toContain("demo:open/8");
		expect(out.join("|")).toContain("https://example.com");
		expect(out.map(plain)).toEqual(rows.map(plain));
		// The unstripped rows still locate the click.
		expect(linkCells(rows).length).toBe(2);
		// A row drawn while the scheme was claimed must not leak its URL after the claim is gone.
		setExtensionLinks([], false);
		expect(rows.map(stripExtensionLinkMarkers)).toEqual(out);
		// A hyperlink omp did not mark is kept, whatever its scheme.
		const foreign = "See \x1b]8;;demo:open/7\x07the details\x1b]8;;\x07.";
		expect(stripExtensionLinkMarkers(foreign)).toBe(foreign);
	});

	it("stops matching rows drawn for a scheme that is no longer claimed", () => {
		setExtensionLinks(["demo"], true);
		const rows = render(text);
		setExtensionLinks(["other"], true);
		expect(linkCells(rows)).toEqual([]);
	});

	it("redraws a live streaming reply's links when click routing turns on", () => {
		const streaming = new Markdown("", 0, 0, getMarkdownTheme());
		streaming.transientRenderCache = true;
		const first = `${text}\n\nSecond paragraph`;
		setExtensionLinks(["demo"], false);
		streaming.setText(first);
		streaming.render(80);
		setExtensionLinks(["demo"], true);
		// Same text and width: the per-instance cache must not hand back the unrouted rows.
		expect(linkCells(streaming.render(80))).toEqual(["0:5-15=demo:open/7"]);
		setExtensionLinks(["demo"], false);
		streaming.render(80);
		setExtensionLinks(["demo"], true);
		// Grown text: the streamed prefix rows were drawn unrouted and must be redrawn.
		streaming.setText(`${first} grows.\n\nThird`);
		expect(linkCells(streaming.render(80))).toEqual(["0:5-15=demo:open/7"]);
	});

	it("keeps a sized H1 heading's extension link clickable", () => {
		setExtensionLinks(["demo"], true);
		setTerminalTextSizing(true);
		try {
			expect(linkCells(render("# Open [the details](demo:open/7)"))).toEqual(["0:5-15=demo:open/7"]);
			// A heading with no extension link is still drawn sized.
			expect(render("# Open the details")[0]).toContain("\x1b]66;");
		} finally {
			setTerminalTextSizing(false);
		}
	});

	it("never hands the terminal an extension URL on a row it writes as an image row", () => {
		setExtensionLinks(["demo"], true);
		const originalProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal);
		try {
			// A Kitty placeholder cell in the label makes the whole row an image row.
			tui.addChild({ render: width => render("Open [\u{10eeee}](demo:open/7) now", width) });
			tui.start();
			tui.renderNow();
			expect(terminal.written).toContain("\u{10eeee}");
			expect(terminal.written).not.toContain("demo:open/7");
		} finally {
			tui.stop();
			setTerminalImageProtocol(originalProtocol);
		}
	});
});

/** Records every byte the TUI writes. */
class RecordingTerminal extends VirtualTerminal {
	written = "";
	override write(data: string): void {
		this.written += data;
		super.write(data);
	}
}

/** Rendered rows shown in the composer's live viewport as they are. */
class StaticBlock implements Component {
	constructor(readonly rows: readonly string[]) {}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return this.rows;
	}
}

describe("extension link hover", () => {
	const SIZE = { columns: 80, rows: 24 };

	/** Paint `rows` in a composer, hover the first cell showing `label`, and return the highlighted text. */
	function hover(rows: readonly string[], label: string): { highlighted: string[]; cleared: boolean } {
		const composer = new Composer({
			terminal: new VirtualTerminal(SIZE.columns, SIZE.rows),
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new StaticBlock(rows));
			composer.setRuntimeChildren([transcript]);
			const before = composer.renderFrame(SIZE).viewport;
			const row = before.findIndex(line => plain(line).includes(label));
			composer.setHoveredLink(composer.viewportLinkAt(row, plain(before[row]!).indexOf(label)));
			const painted = composer.renderFrame(SIZE).viewport;
			const highlighted = painted.flatMap(line =>
				[...line.matchAll(/\x1b\[7m(.*?)\x1b\[27m/g)].map(match => plain(match[1]!)),
			);
			composer.setHoveredLink(undefined);
			const cleared = composer.renderFrame(SIZE).viewport.every((line, index) => line === before[index]);
			return { highlighted, cleared };
		} finally {
			composer.stop();
		}
	}

	it("highlights only the hovered label, on every row a wrapped label reaches", () => {
		setExtensionLinks(["demo"], true);
		const rows = render("Some words [a much longer link label](demo:open/8) and [again](demo:open/8) end", 30);
		// Hovering either row's part lights up the whole wrapped label, not the other label of its URL.
		for (const part of ["a much", "label"]) {
			const { highlighted, cleared } = hover(rows, part);
			expect(highlighted.map(text => text.trim())).toEqual(["a much longer link", "label"]);
			expect(cleared).toBe(true);
		}
		expect(hover(rows, "again").highlighted).toEqual(["again"]);
	});

	it("highlights only the hovered one of two labels sharing a URL", () => {
		setExtensionLinks(["demo"], true);
		const rows = render("Pick [first](demo:open/1) or [second](demo:open/1) now");
		expect(hover(rows, "second").highlighted).toEqual(["second"]);
		expect(hover(rows, "first").highlighted).toEqual(["first"]);
	});

	it("never highlights a link whose scheme is not claimed", () => {
		setExtensionLinks(["demo"], true);
		const { highlighted } = hover(render("[docs](https://example.com)"), "docs");
		expect(highlighted).toEqual([]);
	});
});
