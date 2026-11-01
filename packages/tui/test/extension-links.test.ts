import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	extensionLinkLabels,
	formatExtensionLink,
	linkHintTags,
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
	setExtensionLinks([]);
});
afterEach(() => {
	setExtensionLinks([]);
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
		setExtensionLinks(["demo"]);
		const row = plain(render(text)[0]!);
		expect(row).toContain("Open the details or the docs (https://example.com/docs).");
	});

	it("maps exactly the label's cells to the URL, across a wrapped label", () => {
		setExtensionLinks(["demo"]);
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
		setExtensionLinks(["demo"]);
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
		setExtensionLinks([]);
		expect(rows.map(stripExtensionLinkMarkers)).toEqual(out);
		// A hyperlink omp did not mark is kept, whatever its scheme.
		const foreign = "See \x1b]8;;demo:open/7\x07the details\x1b]8;;\x07.";
		expect(stripExtensionLinkMarkers(foreign)).toBe(foreign);
		// Every marker form omp draws is stripped: numbered or not, BEL or ST terminated.
		for (const params of ["id=omp-extension-link", "id=omp-extension-link-12"]) {
			for (const end of ["\x07", "\x1b\\"]) {
				const stripped = stripExtensionLinkMarkers(`a\x1b]8;${params};demo:x${end}b\x1b]8;;${end}c`);
				expect(plain(stripped)).toBe("abc");
				expect(stripped).not.toContain("\x1b]8");
			}
		}
	});

	it("draws each extension link label dotted-underlined on every row, kept across resets inside it", () => {
		const [on, off] = TERMINAL.styledUnderlines ? ["\x1b[4:4m", "\x1b[4:0m"] : ["\x1b[4m", "\x1b[24m"];
		// A truecolor `0` component is no reset; a full reset inside the label is followed by the underline again.
		const drawn = formatExtensionLink("\x1b[38;2;0;136;250mb\x1b[0mc\x1b[39m", "demo:x", "k");
		expect(stripExtensionLinkMarkers(drawn)).toBe(`${on}\x1b[38;2;0;136;250mb\x1b[0m${on}c\x1b[39m${off}`);

		setExtensionLinks(["demo"]);
		const rows = render("Some words before [a much longer link label](demo:open/8) then more words after it", 30);
		const labelRows = rows.filter(row => extensionLinkLabels(row).length > 0);
		expect(labelRows.length).toBe(2);
		// The wrapper carries the styled underline onto the label's second row (possibly merged with the
		// colour in one SGR) and ends it after the label.
		const code = TERMINAL.styledUnderlines ? "4:4" : "4";
		const underlined = new RegExp(`\\x1b\\[(?:[0-9:;]*;)?${code}[;m]`);
		for (const row of labelRows) expect(row).toMatch(underlined);
		const after = rows.slice(rows.indexOf(labelRows[1]!) + 1).join("");
		expect(after).not.toMatch(underlined);
		// No colon parameter is misread as a background colour (`4:4` → 44, `4:0` → 40).
		expect(rows.join("")).not.toMatch(/\x1b\[(?:[0-9;]*;)?4[04](?:;[0-9;]*)?m/);
	});

	it("gives identical links on neighbouring rows distinct markers, also inside bold or list items", () => {
		setExtensionLinks(["demo"]);
		for (const text of ["[x](demo:open)  \n**[x](demo:open)**", "- [x](demo:open)\n- [x](demo:open)"]) {
			const ids = render(text, 40).flatMap(row => extensionLinkLabels(row).map(label => label.id));
			expect(ids.length).toBe(2);
			expect(new Set(ids).size).toBe(2);
		}
	});

	it("treats only omp's marked links as extension links, not a hyperlink of a claimed scheme", () => {
		setExtensionLinks(["demo"]);
		expect(extensionLinkLabels("See \x1b]8;;demo:open/7\x07the details\x1b]8;;\x07.")).toEqual([]);
		expect(extensionLinkLabels("See \x1b]8;id=other;demo:open/7\x07the details\x1b]8;;\x07.")).toEqual([]);
		expect(linkCells(["See \x1b]8;id=omp-extension-link-3;demo:open/7\x07the details\x1b]8;;\x07."])).toEqual([
			"0:4-14=demo:open/7",
		]);
	});

	it("stops matching rows drawn for a scheme that is no longer claimed", () => {
		setExtensionLinks(["demo"]);
		const rows = render(text);
		setExtensionLinks(["other"]);
		expect(linkCells(rows)).toEqual([]);
	});

	it("redraws a live streaming reply's links when their scheme is claimed", () => {
		const streaming = new Markdown("", 0, 0, getMarkdownTheme());
		streaming.transientRenderCache = true;
		const first = `${text}\n\nSecond paragraph`;
		streaming.setText(first);
		streaming.render(80);
		setExtensionLinks(["demo"]);
		// Same text and width: the per-instance cache must not hand back the unclaimed rows.
		expect(linkCells(streaming.render(80))).toEqual(["0:5-15=demo:open/7"]);
		setExtensionLinks([]);
		streaming.render(80);
		setExtensionLinks(["demo"]);
		// Grown text: the streamed prefix rows were drawn unclaimed and must be redrawn.
		streaming.setText(`${first} grows.\n\nThird`);
		expect(linkCells(streaming.render(80))).toEqual(["0:5-15=demo:open/7"]);
	});

	it("keeps a sized H1 heading's extension link clickable", () => {
		setExtensionLinks(["demo"]);
		const priorTextSizing = TERMINAL.textSizing;
		setTerminalTextSizing(true);
		try {
			expect(linkCells(render("# Open [the details](demo:open/7)"))).toEqual(["0:5-15=demo:open/7"]);
			// A heading with no extension link is still drawn sized.
			expect(render("# Open the details")[0]).toContain("\x1b]66;");
		} finally {
			setTerminalTextSizing(priorTextSizing);
		}
	});

	it("never hands the terminal an extension URL on a row it writes as an image row", () => {
		setExtensionLinks(["demo"]);
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

	it("lets a streaming reply with extension links retire settled rows to scrollback", () => {
		setExtensionLinks(["demo"]);
		const paragraphs = Array.from(
			{ length: 6 },
			(_, index) => `Paragraph ${index} has [a link](demo:open/${index}) and has settled.`,
		).join("\n\n");
		const reply = new AssistantMessageComponent();
		for (let end = 30; end <= paragraphs.length; end += 30) {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: paragraphs.slice(0, end) }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 1,
			};
			reply.updateContent(message, { transient: true });
			reply.render(80);
		}
		// Settled rows are published only when re-rendering them draws the same bytes, markers included.
		expect(reply.getTranscriptStableRows().length).toBeGreaterThan(0);
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
	constructor(public rows: readonly string[]) {}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return this.rows;
	}
}

describe("extension link hints", () => {
	const SIZE = { columns: 80, rows: 24 };

	it("tags with single letters while they suffice, else two letters, never one a prefix of another", () => {
		const single = linkHintTags(26);
		expect(single.every(tag => tag.length === 1)).toBe(true);
		expect(new Set(single).size).toBe(26);
		const double = linkHintTags(27);
		expect(double.every(tag => tag.length === 2)).toBe(true);
		expect(new Set(double).size).toBe(27);
		expect(double.some(tag => double.some(other => other !== tag && other.startsWith(tag)))).toBe(false);
	});

	/** A started composer showing `block` in its transcript; stop it when done. */
	function composerShowing(block: StaticBlock): Composer {
		const composer = new Composer({
			terminal: new VirtualTerminal(SIZE.columns, SIZE.rows),
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		composer.start();
		const transcript = new TranscriptContainer();
		transcript.addChild(block);
		composer.setRuntimeChildren([transcript]);
		return composer;
	}

	it("tags each label once, a wrapped one at its first row, and the typed tag picks that label", () => {
		setExtensionLinks(["demo"]);
		const block = new StaticBlock(
			render("Some words [the much longer link label](demo:open/8) and [again](demo:open/8) end", 30),
		);
		const composer = composerShowing(block);
		try {
			const before = composer.renderFrame(SIZE).viewport.map(plain);
			expect(composer.viewportLinkCount()).toBe(2);
			let ended = 0;
			composer.startLinkHints(() => ended++);
			const painted = composer.renderFrame(SIZE).viewport.map(plain);
			const first = before.findIndex(line => line.includes("the much"));
			const second = before.findIndex(line => line.includes("again"));
			expect(second).toBe(first + 1);
			// Tag `a` covers the wrapped label's first cell on its first row; its continuation stays plain.
			expect(painted[first]!.slice(before[first]!.indexOf("the much"))).toStartWith("ahe much");
			expect(painted[second]!.slice(0, before[second]!.indexOf(" and"))).toBe(
				before[second]!.slice(0, before[second]!.indexOf(" and")),
			);
			expect(painted[second]!.slice(before[second]!.indexOf("again"))).toStartWith("sgain");

			// `again` shares its URL with the wrapped label: the pick is told apart by where it is drawn.
			expect(composer.typeLinkHint("s")).toEqual({
				url: "demo:open/8",
				row: second,
				start: before[second]!.indexOf("again"),
			});
			expect(ended).toBe(1);
			expect(composer.linkHintsActive).toBe(false);
			expect(composer.renderFrame(SIZE).viewport.map(plain)).toEqual(before);
		} finally {
			composer.stop();
		}
	});

	it("tags each of two same-URL labels split by a row break", () => {
		setExtensionLinks(["demo"]);
		const composer = composerShowing(new StaticBlock(render("[aaaa](demo:open/1) [bbbb](demo:open/1)", 4)));
		try {
			composer.renderFrame(SIZE);
			expect(composer.viewportLinkCount()).toBe(2);
		} finally {
			composer.stop();
		}
	});

	it("ends instead of keeping tags over labels a repaint moved", () => {
		setExtensionLinks(["demo"]);
		const block = new StaticBlock(render("Pick [first](demo:open/1) or [second](demo:open/2) now"));
		const composer = composerShowing(block);
		try {
			composer.renderFrame(SIZE);
			let ended = 0;
			composer.startLinkHints(() => ended++);
			composer.renderFrame(SIZE);
			block.rows = render("Now [second](demo:open/2) comes first");
			const repainted = composer.renderFrame(SIZE).viewport.map(plain);
			expect(ended).toBe(1);
			expect(repainted.some(line => line.includes("Now second comes first"))).toBe(true);
			// Tag `s` was on `second` where it used to be; it must not pick anything now.
			expect(composer.typeLinkHint("s")).toBe(false);
		} finally {
			composer.stop();
		}
	});

	it("keeps every two-letter tag readable over adjacent one-cell labels, in its own highlight", () => {
		setExtensionLinks(["demo"]);
		const labels = Array.from({ length: 27 }, (_, index) => `[x](demo:open/${index})`).join("");
		const composer = composerShowing(new StaticBlock(render(`Go ${labels} end`)));
		try {
			const before = composer.renderFrame(SIZE).viewport.map(plain);
			const row = before.findIndex(line => line.includes("Go x"));
			composer.startLinkHints(() => {});
			const raw = composer.renderFrame(SIZE).viewport[row]!;
			// Each tag is drawn whole, side by side, starting at the first label.
			const start = before[row]!.indexOf("x");
			expect(plain(raw).slice(start, start + 54)).toBe(linkHintTags(27).join(""));
			expect(raw).toContain("\x1b[1;7m");
		} finally {
			composer.stop();
		}
	});

	it("shows no tags, and says why, when a row's links leave no room for every tag, also after a resize", () => {
		setExtensionLinks(["demo"]);
		const labels = Array.from({ length: 27 }, (_, index) => `[x](demo:open/${index})`).join("");
		const wide = { columns: 80, rows: 24 };
		const narrow = { columns: 40, rows: 24 };
		const composer = new Composer({
			terminal: new VirtualTerminal(wide.columns, wide.rows),
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		composer.start();
		const transcript = new TranscriptContainer();
		// 27 one-cell labels need 54 cells of two-letter tags: room on 80 columns, not on 40.
		transcript.addChild(new StaticBlock(render(labels, 40)));
		composer.setRuntimeChildren([transcript]);
		try {
			const before = composer.renderFrame(wide).viewport.map(plain);
			const reasons: (string | undefined)[] = [];
			composer.startLinkHints(reason => reasons.push(reason));
			expect(composer.renderFrame(wide).viewport.map(plain)).not.toEqual(before);
			expect(composer.linkHintsActive).toBe(true);
			// Narrowed while tagged: the labels stay where they were, but their tags no longer fit.
			const narrowBefore = composer.renderFrame(narrow).viewport.map(plain);
			expect(reasons).toEqual(["crowded"]);
			expect(composer.linkHintsActive).toBe(false);
			expect(composer.renderFrame(narrow).viewport.map(plain)).toEqual(narrowBefore);

			composer.startLinkHints(reason => reasons.push(reason));
			expect(composer.renderFrame(narrow).viewport.map(plain)).toEqual(narrowBefore);
			expect(reasons).toEqual(["crowded", "crowded"]);
			expect(composer.typeLinkHint("a")).toBe(false);
		} finally {
			composer.stop();
		}
	});
});
