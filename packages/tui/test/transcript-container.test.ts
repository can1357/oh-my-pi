import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import {
	TranscriptContainer,
	type TranscriptStableRow,
	trimBlankEdges,
} from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;
	allocations: number[] = [];

	constructor(rows: string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(rows: string[]): void {
		this.#rows = rows;
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.allocations.push(rows);
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

/** A live block the container recognizes as dynamic tool-activity. */
class ToolBlock extends Block {
	setToolActivityVisible(): void {}
}

/** A settled block whose render costs real wall-clock time, like a markdown-heavy message. */
class SlowBlock extends Block {
	#costMs: number;

	constructor(rows: string[], costMs: number) {
		super(rows, true);
		this.#costMs = costMs;
	}

	override render(): readonly string[] {
		const until = performance.now() + this.#costMs;
		while (performance.now() < until) {}
		return super.render();
	}
}

/** A settled block that records how often the container rendered it. */
class CountingBlock extends Block {
	renders = 0;

	constructor(rows: string[]) {
		super(rows, true);
	}

	override render(): readonly string[] {
		this.renders++;
		return super.render();
	}
}

function literalStableRow(row: string): TranscriptStableRow {
	return { key: row };
}

class AppendBlock extends Block {
	readonly transcriptBlockMode = "appendOnly" as const;
	#stable: readonly TranscriptStableRow[];
	#stableRender: readonly string[];

	constructor(rows: string[], stable: readonly string[], finalized = false) {
		super(rows, finalized);
		this.#stable = stable.map(literalStableRow);
		this.#stableRender = stable;
	}

	publish(rows: readonly string[]): void {
		this.#stable = rows.map(literalStableRow);
		this.#stableRender = rows;
	}

	publishStable(rows: readonly TranscriptStableRow[], rendered: readonly string[]): void {
		this.#stable = rows;
		this.#stableRender = rendered;
	}

	/** Change the block's full render without finalizing (e.g. hiding thinking). */
	revise(rows: string[]): void {
		this.finalize(rows);
	}

	resetTranscriptStableRows(): void {
		this.#stable = [];
		this.#stableRender = [];
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#stable;
	}

	renderTranscriptStableRows(count: number, _width: number): readonly string[] {
		return this.#stableRender.slice(0, count);
	}
}

class ReflowingAppendBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	#finalized = false;
	readonly #stable: TranscriptStableRow = { key: "abcdefgh" };

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return [this.#stable];
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (count <= 0) return [];
		const rows: string[] = [];
		for (let offset = 0; offset < 8; offset += width) rows.push("abcdefgh".slice(offset, offset + width));
		return rows;
	}

	render(width: number): readonly string[] {
		return [...this.renderTranscriptStableRows(1, width), this.#finalized ? "final" : "partial"];
	}
}
const finalAnswer: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "Reasoning first" },
		{ type: "text", text: "## Implemented" },
	],
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.6-sol",
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

const frame = { tick: 0, now: 0 };

/** Greedy word wrap, so the same content takes a different row count at each width. */
function wrapWords(words: readonly string[], width: number): string[] {
	const rows: string[] = [];
	let row = "";
	for (const word of words) {
		if (row.length > 0 && row.length + 1 + word.length > width) {
			rows.push(row);
			row = word;
		} else {
			row = row.length > 0 ? `${row} ${word}` : word;
		}
	}
	if (row.length > 0) rows.push(row);
	return rows;
}

describe("TranscriptContainer row split", () => {
	const words = Array.from({ length: 120 }, (_, i) => `w${i}${"x".repeat(i % 5)}`);
	const prose: Component = { render: width => wrapWords(words, width) };

	it("commits only the rows of a straddling block that left the screen", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(prose);
		transcript.addChild(new Block(["tail"], true));
		const rows = wrapWords(words, 40);
		// Room 10: the tail and its separator leave 8 rows of the prose live.
		const batch = transcript.peekFinalizedBatch(40, 10)!;
		expect(batch.rows).toEqual(rows.slice(0, rows.length - 8));
		transcript.acknowledgeFinalizedBatch(batch.id);
		expect(transcript.renderViewport(40, 10, frame)).toEqual([...rows.slice(rows.length - 8), "", "tail"]);
		expect(transcript.blockStates()).toEqual(["settled", "settled"]);
	});

	// An inline image: three reserved rows, then the row that draws it upward over them.
	const imageBlock = (): Block =>
		new Block(
			[
				"above 1",
				"above 2",
				"\x1b[0m",
				"\x1b[0m",
				"\x1b[0m",
				"\x1b7\x1b[3A\x1b]1337;File=inline=1;width=10;height=4:AAAA\x07\x1b8",
				"below 1",
				"below 2",
			],
			true,
		);

	for (const [protocol, committed] of [
		// iTerm2 cannot draw part of an image, so it goes to scrollback whole.
		[ImageProtocol.Iterm2, 6],
		// Kitty draws the visible part, so the cut stays where the screen ends.
		[ImageProtocol.Kitty, 3],
	] as const) {
		it(`moves a split that would cut an inline image below it only where the terminal cannot draw part of it (${protocol})`, () => {
			const previous = TERMINAL.imageProtocol;
			setTerminalImageProtocol(protocol);
			try {
				const transcript = new TranscriptContainer();
				transcript.addChild(imageBlock());
				transcript.addChild(new Block(["tail"], true));
				// Room 7: the tail and its separator leave 5 rows of the block live, a cut after row 3.
				const batch = transcript.peekFinalizedBatch(40, 7)!;
				expect(batch.rows.length).toBe(committed);
			} finally {
				setTerminalImageProtocol(previous);
			}
		});
	}

	it("retires a block in full, with its separator, when keeping its last-row image whole reaches the block's end", () => {
		const previous = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		try {
			const rows = imageBlock().render().slice(0, 6);
			const transcript = new TranscriptContainer();
			transcript.addChild(new Block([...rows], true));
			transcript.addChild(new Block(["tail"], true));
			// Room 5: the tail and its separator leave 3 rows live, a cut inside the image.
			const batch = transcript.peekFinalizedBatch(40, 5)!;
			// The next block in scrollback stays one blank row below the image.
			expect(batch.rows).toEqual([...rows, ""]);
			transcript.acknowledgeFinalizedBatch(batch.id);
			expect(transcript.blockStates()).toEqual(["committed", "settled"]);
		} finally {
			setTerminalImageProtocol(previous);
		}
	});

	it("keeps an archived whole image in scrollback when the width changes", () => {
		const previous = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(imageBlock());
			transcript.addChild(new Block(["tail"], true));
			const head = transcript.peekFinalizedBatch(40, 7)!;
			expect(head.rows.length).toBe(6);
			transcript.acknowledgeFinalizedBatch(head.id);
			// The image rows hold no text, so a resize must not relocate the seam above them.
			const rest = transcript.peekFlushBatch(50)!.rows;
			expect(rest.some(row => TERMINAL.isImageLine(row))).toBe(false);
			expect(rest).toContain("below 1");
		} finally {
			setTerminalImageProtocol(previous);
		}
	});

	it("keeps a replacement image live when the archived one is swapped before a width change", () => {
		const previous = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		try {
			const block = imageBlock();
			const transcript = new TranscriptContainer();
			transcript.addChild(block);
			transcript.addChild(new Block(["tail"], true));
			const head = transcript.peekFinalizedBatch(40, 7)!;
			transcript.acknowledgeFinalizedBatch(head.id);
			// A parked tool card redraws a different image over the archived one.
			block.finalize(block.render().map(row => row.replace(":AAAA", ":BBBB")));
			const rest = transcript.peekFlushBatch(50)!.rows;
			expect(rest.some(row => row.includes(":BBBB"))).toBe(true);
		} finally {
			setTerminalImageProtocol(previous);
		}
	});

	it("keeps a row inserted above the archived image live across a width change", () => {
		const previous = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		try {
			const block = imageBlock();
			const transcript = new TranscriptContainer();
			transcript.addChild(block);
			transcript.addChild(new Block(["tail"], true));
			const head = transcript.peekFinalizedBatch(40, 7)!;
			transcript.acknowledgeFinalizedBatch(head.id);
			// An expanded pane adds a divider between the archived text and the image.
			const rows = [...block.render()];
			rows.splice(2, 0, "────");
			block.finalize(rows);
			const rest = transcript.peekFlushBatch(50)!.rows;
			expect(rest).toContain("────");
		} finally {
			setTerminalImageProtocol(previous);
		}
	});

	it("keeps an archived image in scrollback after a later split advances past it", () => {
		const previous = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(imageBlock());
			transcript.addChild(new Block(["tail"], true));
			const first = transcript.peekFinalizedBatch(40, 7)!;
			transcript.acknowledgeFinalizedBatch(first.id);
			// Growing pressure moves the seam past the image into the text below it.
			const second = transcript.peekFinalizedBatch(40, 3)!;
			expect(second.rows).toEqual(["below 1"]);
			transcript.acknowledgeFinalizedBatch(second.id);
			const rest = transcript.peekFlushBatch(50)!.rows;
			expect(rest.some(row => TERMINAL.isImageLine(row))).toBe(false);
			expect(rest).not.toContain("below 1");
			expect(rest).toContain("below 2");
		} finally {
			setTerminalImageProtocol(previous);
		}
	});

	it("keeps an archived image live when the block moves it to another place in its text", () => {
		const previous = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		try {
			const block = imageBlock();
			const transcript = new TranscriptContainer();
			transcript.addChild(block);
			transcript.addChild(new Block(["tail"], true));
			const head = transcript.peekFinalizedBatch(40, 7)!;
			transcript.acknowledgeFinalizedBatch(head.id);
			// A layout update draws the same image between the two text rows above it.
			const [above1, above2, ...image] = block.render().slice(0, 6);
			block.finalize([above1!, ...image, above2!, "below 1", "below 2"]);
			const rest = transcript.peekFlushBatch(50)!.rows;
			expect(rest.some(row => TERMINAL.isImageLine(row))).toBe(true);
		} finally {
			setTerminalImageProtocol(previous);
		}
	});

	it("resumes a split block at the same content after a width change, repeating at most one row", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(prose);
		transcript.addChild(new Block(["tail"], true));
		const head = transcript.peekFinalizedBatch(40, 10)!;
		transcript.acknowledgeFinalizedBatch(head.id);
		const committed = head.rows.join(" ").split(" ");
		// A preserve-mode resize keeps the 40-column rows in scrollback; the rest
		// retires at 25 columns.
		const rest = transcript.peekFlushBatch(25)!.rows.filter(row => row !== "");
		const resumed = rest.join(" ").split(" ");
		expect(resumed.at(-1)).toBe("tail");
		const restart = words.indexOf(resumed[0]!);
		// No word is lost, and only the seam row's committed words repeat.
		expect(restart).toBeLessThanOrEqual(committed.length);
		expect(resumed.slice(0, -1)).toEqual(words.slice(restart));
		expect(committed.length - restart).toBeLessThan(wrapWords(words, 25)[0]!.split(" ").length);
		expect(committed).toEqual(words.slice(0, committed.length));
	});

	it("loses no text of a split block whose wrapped rows carry a per-row prefix", () => {
		// Every wrapped row starts with a quote bar, so a narrower width spends
		// more cells on decoration per character of content.
		const content = "abcdefghij".repeat(5);
		const quoted: Component = {
			render: width => {
				const step = width - 1;
				return Array.from(
					{ length: Math.ceil(content.length / step) },
					(_, i) => `#${content.slice(i * step, (i + 1) * step)}`,
				);
			},
		};
		const transcript = new TranscriptContainer();
		transcript.addChild(quoted);
		transcript.addChild(new Block(["tail"], true));
		const head = transcript.peekFinalizedBatch(6, 3)!;
		transcript.acknowledgeFinalizedBatch(head.id);
		const committed = head.rows.map(row => row.slice(1)).join("");
		expect(content.startsWith(committed)).toBe(true);
		const rest = transcript.peekFlushBatch(9)!.rows.filter(row => row.startsWith("#"));
		const resumed = rest.map(row => row.slice(1)).join("");
		// The rest resumes at or before the committed end and runs to the end.
		expect(content.endsWith(resumed)).toBe(true);
		expect(content.length - resumed.length).toBeLessThanOrEqual(committed.length);
	});

	it("keeps rows a split block reveals at the same width, such as an expanded tool pane", () => {
		// A settled output pane shows its tail behind a summary until expanded.
		const lines = Array.from({ length: 30 }, (_, i) => `out${i}`);
		let expanded = false;
		const pane: Component = {
			render: () => (expanded ? lines : ["… 20 earlier lines", ...lines.slice(20)]),
		};
		const transcript = new TranscriptContainer();
		transcript.addChild(pane);
		transcript.addChild(new Block(["tail"], true));
		const head = transcript.peekFinalizedBatch(80, 6)!;
		transcript.acknowledgeFinalizedBatch(head.id);
		expect(head.rows).toEqual(["… 20 earlier lines", "out20", "out21", "out22", "out23", "out24", "out25"]);
		// Ctrl+O: the pane re-renders with head rows that history never received.
		expanded = true;
		const rest = transcript.peekFlushBatch(80)!.rows;
		expect(rest.filter(row => row.startsWith("out"))).toEqual(lines);
	});
	it("stops a relocated split before punctuation-only rows a split block reveals", () => {
		// Expanding the pane reveals a rule row above the committed head rows;
		// the hash rejects the stale bytes, and the empty-content row must not
		// count as matched content on the relocation walk.
		let expanded = false;
		const pane: Component = {
			render: () => (expanded ? ["---", "AAA", "BBB"] : ["AAA", "BBB"]),
		};
		const transcript = new TranscriptContainer();
		transcript.addChild(pane);
		transcript.addChild(new Block(["tail"], true));
		const head = transcript.peekFinalizedBatch(80, 3)!;
		transcript.acknowledgeFinalizedBatch(head.id);
		expect(head.rows).toEqual(["AAA"]);
		expanded = true;
		const rest = transcript.peekFlushBatch(80)!.rows;
		expect(rest).toContain("---");
		expect(rest.filter(row => row === "AAA" || row === "BBB")).toEqual(["AAA", "BBB"]);
	});
});

describe("TranscriptContainer", () => {
	it("preserves retirement while externally reordered and replaced live children settle", () => {
		const transcript = new TranscriptContainer();
		const archived = new Block(["archived"], true);
		transcript.addChild(archived);
		const history = transcript.peekFlushBatch(80);
		if (!history) throw new Error("Expected history batch");
		transcript.acknowledgeFinalizedBatch(history.id);
		const first = new Block(["first"], false);
		const second = new Block(["second"], false);
		transcript.addChild(first);
		transcript.addChild(second);
		transcript.children.splice(1, 2, second, first);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["second", "", "first"]);
		const replacement = new Block(["replacement"], false);
		const external = [archived, second, replacement];
		transcript.children = external;
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["second", "", "replacement"]);
		external[1] = first;
		first.finalize(["first done"]);
		replacement.finalize(["replacement done"]);
		const final = transcript.peekFlushBatch(80);
		expect(final?.rows).toEqual(["first done", "", "replacement done", ""]);
		if (!final) throw new Error("Expected live retirement batch");
		transcript.acknowledgeFinalizedBatch(final.id);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)?.rows).toEqual(["archived", "", "first done", "", "replacement done", ""]);
	});

	it("captures mutable by default and append-only declarations permanently", () => {
		const transcript = new TranscriptContainer();
		const mutable = new Block(["mutable"], false) as Block & {
			transcriptBlockMode?: "appendOnly";
			getTranscriptStableRows?: () => readonly TranscriptStableRow[];
		};
		transcript.addChild(mutable);
		mutable.transcriptBlockMode = "appendOnly";
		mutable.getTranscriptStableRows = () => [literalStableRow("mutable")];
		transcript.addChild(new AppendBlock(["stable", "partial"], ["stable"]));

		expect(transcript.blockModes()).toEqual(["mutable", "appendOnly"]);
	});

	it("freezes a retracting publication and keeps rendering the block", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		// Retraction cannot be honored (rows may already sit in scrollback):
		// the block demotes to finalize-time retirement but never fails a render.
		block.publish(["changed"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);
		expect(transcript.blockModes()).toEqual(["appendOnly"]);
	});

	it("freezes drifted stable bytes, keeps the emitted slice, and retires the remainder once", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		expect(emitted.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);

		// Published bytes drift (e.g. a mid-stream theme change): the emitted
		// slice stays retired, the live tail keeps rendering, and no further
		// mid-stream row is offered.
		block.publishStable([literalStableRow("one"), literalStableRow("two")], ["one", "changed physical row"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["two"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		// Finalization retires exactly the un-emitted suffix.
		block.finalize(["one", "two"]);
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["two", ""]);
	});

	it("freezes same-length drift in a reused render buffer without changing emitted history", () => {
		const transcript = new TranscriptContainer();
		const stableRender = ["one"];
		const fullRender = ["one", "tail"];
		const block = new (class extends AppendBlock {
			override renderTranscriptStableRows(count: number): readonly string[] {
				return count === stableRender.length ? stableRender : stableRender.slice(0, count);
			}
		})(fullRender, stableRender);
		transcript.addChild(block);

		const emitted = transcript.peekFinalizedBatch(80, 1);
		if (!emitted) throw new Error("Expected stable history batch");
		transcript.acknowledgeFinalizedBatch(emitted.id);

		stableRender[0] = "changed";
		fullRender[0] = "changed";
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["tail"]);
		expect(emitted.rows).toEqual(["one"]);

		// Restoring the old prefix does not unfreeze publication.
		stableRender.splice(0, 1, "one", "two");
		fullRender.splice(0, 2, "one", "two", "tail");
		block.publish(stableRender);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
	});

	it("emits only the stable current head under row pressure", () => {
		const transcript = new TranscriptContainer();
		const head = new Block(["mutable head"], false);
		const later = new AppendBlock(["later stable", "later partial"], ["later stable"]);
		transcript.addChild(head);
		transcript.addChild(later);

		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();

		head.finalize(["mutable head"]);
		const retired = transcript.peekFinalizedBatch(80, 1);
		expect(retired?.rows).toEqual(["mutable head", ""]);
		transcript.acknowledgeFinalizedBatch(retired!.id);

		const emitted = transcript.peekFinalizedBatch(80, 1);
		expect(emitted?.rows).toEqual(["later stable"]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["later partial"]);
	});

	it("counts multi-row snapshot prefixes by rendered rows, not snapshot count", () => {
		// One snapshot rendering to 4 physical rows: the old min(rows, count)
		// memo returned 1 row for count=1 and the container redrew retired
		// content into the live region. The per-(width,count) memo returns
		// the real rendered length.
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);
		// Prime the container through a live-count pass at width 2: one
		// snapshot -> 4 physical rows.
		transcript.liveRowCount(2);
		transcript.liveRowCount(2);
		const viewport = transcript.renderViewport(2, 10, frame);
		expect(viewport.length).toBeGreaterThan(1);
	});

	it("retires only the un-emitted final suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two", "partial"], ["one", "two"]);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 2)!;
		expect(first.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		const second = transcript.peekFinalizedBatch(80, 1)!;
		expect(second.rows).toEqual(["two"]);
		transcript.acknowledgeFinalizedBatch(second.id);

		block.finalize(["one", "two", "final"]);
		const suffix = transcript.peekFinalizedBatch(80, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("advances a fully emitted finalized head without a physical write", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["complete"], ["complete"]);
		transcript.addChild(block);
		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(emitted.id);

		block.finalize(["complete"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.render(80)).toEqual(["complete"]);
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)?.rows).toEqual(["complete", ""]);
	});

	it("replays and retires semantic stable rows after they reflow at a new width", () => {
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);

		// Room 2: "efgh" is still on screen, so its stable prefix stays live —
		// committing it would strand that row above the live tail.
		expect(transcript.peekFinalizedBatch(4, 2)).toBeUndefined();
		// Room 1: the whole two-row stable prefix has left the screen.
		const emitted = transcript.peekFinalizedBatch(4, 1)!;
		expect(emitted.rows).toEqual(["abcd", "efgh"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);
		expect(transcript.renderViewport(8, 1, frame)).toEqual(["partial"]);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(8)!;
		expect(replay.rows).toEqual(["abcdefgh"]);
		transcript.acknowledgeFinalizedBatch(replay.id);

		block.finalize();
		const suffix = transcript.peekFinalizedBatch(8, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("drops emitted stable rows on reset so a replay honors a hidden presentation (#10177)", () => {
		const transcript = new TranscriptContainer();
		// A thinking block whose reasoning prefix streams into scrollback ahead of
		// its answer while the whole block is still the live frontier head.
		const block = new AppendBlock(["reasoning one", "reasoning two", "answer"], ["reasoning one", "reasoning two"]);
		transcript.addChild(block);

		// Under pressure the finished rows the overflow needs retire in one batch.
		const first = transcript.peekFinalizedBatch(80, 1)!;
		expect(first.rows).toEqual(["reasoning one", "reasoning two"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.emittedStableRows()).toEqual([2]);

		// Ctrl+T hides thinking: the block now renders only its answer and drops
		// its published reasoning snapshots. resetStableEmission forgets the
		// emitted prefix so the paired destructive replay does not resurrect the
		// captured reasoning that visibly streamed into scrollback.
		block.revise(["answer"]);
		transcript.resetStableEmission();
		expect(transcript.emittedStableRows()).toEqual([0]);

		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
		expect(transcript.renderViewport(80, 5, frame)).toEqual(["answer"]);
	});

	beforeAll(async () => {
		await initTheme(false);
	});

	it("keeps settled blocks live while the viewport has room", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["streaming"], false));

		// Both fit: nothing retires, the settled block still renders live.
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["settled", "", "streaming"]);
	});

	it("retires the settled prefix only under capacity pressure, in order", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first final"], true);
		const second = new Block(["second live", "row", "row"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		// 5 rows fit everything (1 + separator + 3).
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		// 3 rows force the settled prefix out.
		expect(transcript.peekFinalizedBatch(80, 3)?.rows).toEqual(["first final", ""]);
	});

	it("never retires a finalized successor past an active predecessor", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["active live"], false);
		const settled = new Block(["settled final"], true);
		transcript.addChild(active);
		transcript.addChild(settled);

		// Pressure exists but the prefix starts with an active block: no batch,
		// and both blocks still render (clipped by the viewport).
		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active live", "", "settled final"]);

		active.finalize(["active final"]);
		// Capacity 1 fits the remaining settled block, so only the first retires.
		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["active final", ""]);
	});

	it("reoffers an unacknowledged batch and retires it exactly once", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final one"], true));
		transcript.addChild(new Block(["final two"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		const second = transcript.peekFinalizedBatch(80, 50);

		expect(second).toEqual(first);
		if (first === undefined) throw new Error("expected a batch under zero capacity");
		transcript.acknowledgeFinalizedBatch(first.id);
		// Committed blocks leave the live tail and never render again.
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
	});

	it("excludes an offered batch from the live viewport in the same frame", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old settled"], true));
		transcript.addChild(new Block(["fresh live"], false));

		const batch = transcript.peekFinalizedBatch(80, 1);
		expect(batch?.rows).toEqual(["old settled", ""]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["fresh live"]);
	});

	it("never replays a frame's measurements after the block changes outside that frame", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["draft"], false);
		transcript.addChild(block);
		const first = { tick: 0, now: 0 };
		transcript.beginFrame(first);
		expect(transcript.liveRowCount(80)).toBe(1);
		expect(transcript.renderViewport(80, 5, first)).toEqual(["draft"]);

		// The viewport closed the frame: a later peek measures the change.
		block.finalize(["revised", "twice"]);
		expect(transcript.liveRowCount(80)).toBe(2);

		// A viewport for a different frame discards the open frame's measurements.
		transcript.beginFrame({ tick: 1, now: 16 });
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		block.finalize(["late"]);
		expect(transcript.renderViewport(80, 5, { tick: 2, now: 32 })).toEqual(["late"]);
	});

	it("assigns one row per live block until pressure requires aggregation", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"], false));
		transcript.addChild(new Block(["second"], false));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["first", "second"]);
		expect(transcript.canAdmit(2)).toBe(false);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["1 more transcript blocks active"]);
	});
	it("does not report settled resume backlog as active", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled one"], true));
		transcript.addChild(new Block(["settled two"], true));
		transcript.addChild(new Block(["current tool"], false));

		// The welcome header can consume the first history offer, leaving the
		// settled transcript prefix live for one frame while it drains next.
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["current tool"]);
	});
	it("retires a resumed ledger across frames instead of one blocking batch (#12933)", () => {
		const transcript = new TranscriptContainer();
		const blocks = Array.from({ length: 6 }, (_, index) => new SlowBlock([`block ${index}`], 4));
		for (const block of blocks) transcript.addChild(block);

		const drained: string[] = [];
		let batches = 0;
		for (let batch = transcript.peekFinalizedBatch(80, 0); batch !== undefined;) {
			drained.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
			if (++batches > blocks.length) throw new Error("retirement did not converge");
			batch = transcript.peekFinalizedBatch(80, 0);
		}

		// The whole backlog would block the frame that first paints it, so a
		// batch stops at the render budget and the rest follows on later frames.
		expect(batches).toBeGreaterThan(1);
		// Chunking must not reorder, drop, or duplicate a single scrollback row.
		expect(drained.filter(row => row !== "")).toEqual(blocks.map((_, index) => `block ${index}`));
		expect(transcript.blockStates()).toEqual(blocks.map(() => "committed"));
	});

	it("leaves the backlog behind the screen unrendered while painting (#12933)", () => {
		const transcript = new TranscriptContainer();
		const blocks = Array.from({ length: 40 }, (_, index) => new CountingBlock([`row ${index}`]));
		for (const block of blocks) transcript.addChild(block);

		expect(transcript.renderViewport(80, 4, frame)).toEqual(["row 36", "row 37", "row 38", "row 39"]);
		// Only the viewport tail, plus the one block that proves the overflow,
		// costs a render; a resumed session's backlog never does.
		expect(blocks.slice(0, 34).map(block => block.renders)).toEqual(blocks.slice(0, 34).map(() => 0));
		expect(blocks[39]!.renders).toBeGreaterThan(0);
	});

	it("keeps an emergency row from a block behind the bounded viewport walk", () => {
		class HintBlock extends Block {
			renderTranscriptBlockEmergencyRow(): string {
				return "hint";
			}
		}
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["running"], false));
		transcript.addChild(new HintBlock(["hint body"], true));
		for (let index = 0; index < 5; index++) transcript.addChild(new Block([`settled ${index}`], true));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["hint", "settled 4"]);
	});

	it("does not count empty active blocks behind the viewport as hidden work", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["running"], false));
		transcript.addChild(new Block([], false));
		for (let index = 0; index < 4; index++) transcript.addChild(new Block([`settled ${index}`], true));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["settled 2", "settled 3"]);
	});

	it("excludes empty blocks so pressure never emits blank rows (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		// Text blocks interleaved with empty (hidden tool-activity) blocks that
		// render nothing but stay live until retired.
		for (let i = 0; i < 6; i++) {
			transcript.addChild(new Block([`t${i}a`, `t${i}b`, `t${i}c`], true));
			for (let j = 0; j < 8; j++) transcript.addChild(new Block([], true));
		}
		// Emergency path: more non-empty blocks than rows. Every row carries real
		// text — no block's tail is dropped as blank padding.
		const out = transcript.renderViewport(80, 12, frame);
		expect(out).toHaveLength(12);
		expect(out.every(row => /\S/.test(row))).toBe(true);
	});

	it("empty blocks do not reserve capacity from real text under pressure (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["A1", "A2", "A3", "A4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["B1", "B2", "B3", "B4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["C1", "C2", "C3", "C4"], true));
		// Capacity 10 fits all real content once the two empty blocks stop
		// stealing a base row each; the older block keeps its tail rows.
		const out = transcript.renderViewport(80, 10, frame);
		expect(out).toEqual(["A3", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4"]);
	});

	it("renders user message text in emergency layout and omits OSC 133 prompt markers (issue 13835)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stuck tool"], false)); // pins retirement
		for (let i = 0; i < 6; i++) transcript.addChild(new Block([`settled ${i}`], true));
		const userMsg = new UserMessageComponent("is there a reason we haven't tested against the real device yet?");
		transcript.addChild(userMsg);
		transcript.addChild(new Block(["after 1"], true));
		transcript.addChild(new Block(["after 2"], true));

		const rendered = transcript.renderViewport(80, 5, frame);
		expect(rendered).toHaveLength(5);
		const userRow = rendered[2]!;
		expect(userRow).toContain("is there a reason we haven't tested against the real device yet?");
		expect(userRow).not.toContain("\x1b]133;A");
		expect(userRow).not.toContain("\x1b]133;B");
	});

	it("recovers user message text as emergency row when behind viewport (issue 13835)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stuck tool"], false)); // pins retirement
		const userMsg = new UserMessageComponent("first prompt behind viewport");
		transcript.addChild(userMsg);
		for (let i = 0; i < 10; i++) transcript.addChild(new Block([`settled ${i}`], true));

		const rendered = transcript.renderViewport(80, 2, frame);
		expect(rendered[0]).toContain("first prompt behind viewport");
		expect(rendered[0]).not.toContain("\x1b]133;A");
	});

	it("UserMessageComponent emergency row renders first content line and omits shell integration", () => {
		const userMsg = new UserMessageComponent("first line\nsecond line");
		const row = userMsg.renderTranscriptBlockEmergencyRow(80);
		expect(row).toBeDefined();
		expect(row).toContain("first line");
		expect(row).not.toContain("second line");
		expect(row).not.toContain("\x1b]133;A");
		expect(row).not.toContain("\x1b]133;B");
	});

	it("UserMessageComponent reuses measured lines under one-row allocation without duplicate child render", () => {
		const userMsg = new UserMessageComponent("single render test");
		userMsg.setTranscriptAllocation(1);
		let superRenderCalls = 0;
		const superProto = Object.getPrototypeOf(UserMessageComponent.prototype) as {
			render: (width: number) => readonly string[];
		};
		const origSuperRender = superProto.render;
		superProto.render = function (this: unknown, width: number) {
			superRenderCalls++;
			return origSuperRender.call(this, width);
		};
		try {
			const rows = userMsg.render(80);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toContain("single render test");
			expect(superRenderCalls).toBe(1);
		} finally {
			superProto.render = origSuperRender;
		}
	});

	it("keeps a completed assistant answer visible behind an active prefix", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stale active"], false));
		transcript.addChild(new AssistantMessageComponent(finalAnswer));
		transcript.addChild(new Block(["continued turn"], false));
		transcript.addChild(new Block(["task running"], false));

		expect(transcript.peekFinalizedBatch(80, 3)).toBeUndefined();
		const rows = transcript.renderViewport(80, 3, frame);
		expect(rows[0]).toBe("2 more transcript blocks active");
		expect(Bun.stripANSI(rows[1] ?? "").trim()).toBe("Implemented");
		expect(rows[2]).toBe("task running");
	});

	it("gives surplus rows to assistant text before a growing tool card (issue 9718)", () => {
		const transcript = new TranscriptContainer();
		const assistant = new Block(["A1", "A2", "A3", "A4"], false);
		const tool = new ToolBlock(["T1", "T2", "T3", "T4"], false);
		transcript.addChild(assistant);
		transcript.addChild(tool);
		// Capacity 5 cannot fit both blocks in full. Surplus (3 rows) goes to the
		// assistant block first; the tool card collapses to its one-row minimum
		// instead of clipping already-visible assistant text.
		const out = transcript.renderViewport(80, 5, frame);
		expect(out).toEqual(["A1", "A2", "A3", "A4", "T4"]);
		expect(assistant.allocations.at(-1)).toBe(4);
		expect(tool.allocations.at(-1)).toBe(1);
	});

	it("permits removing settled blocks until they are offered or committed", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled snapshot"], true);
		const live = new Block(["live", "live", "live"], false);
		transcript.addChild(settled);
		transcript.addChild(live);

		// Settled but still in the mutable viewport: removable without a trace,
		// so a follow-up displaceable snapshot can retract it.
		expect(transcript.canRemoveBlock(settled)).toBe(true);

		// Offered to the terminal: mid-write, no longer removable.
		const batch = transcript.peekFinalizedBatch(80, 2);
		expect(batch?.rows).toEqual(["settled snapshot", ""]);
		expect(transcript.canRemoveBlock(settled)).toBe(false);

		// Committed: immutable history; removal must be refused outright.
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.canRemoveBlock(settled)).toBe(false);
		transcript.removeChild(settled);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
	});

	it("removes live blocks behind a settled one without disturbing committed or settled bookkeeping", () => {
		const transcript = new TranscriptContainer();
		const committedA = new Block(["committed a"], true);
		const committedB = new Block(["committed b"], true);
		transcript.addChild(committedA);
		transcript.addChild(committedB);
		const commit = transcript.peekFinalizedBatch(80, 0);
		expect(commit?.rows).toEqual(["committed a", "", "committed b", ""]);
		transcript.acknowledgeFinalizedBatch(commit!.id);

		const settled = new Block(["settled"], true);
		const live = [1, 2, 3, 4, 5].map(n => new Block([`live ${n}`], false));
		transcript.addChild(settled);
		for (const block of live) transcript.addChild(block);
		// Room for every live row: the finalized block settles and nothing is offered.
		expect(transcript.peekFinalizedBatch(80, 20)).toBeUndefined();
		expect(transcript.blockStates()).toEqual([
			"committed",
			"committed",
			"settled",
			"active",
			"active",
			"active",
			"active",
			"active",
		]);

		transcript.removeChild(live[0]!);
		transcript.removeChild(live[4]!);

		expect(transcript.blockStates()).toEqual(["committed", "committed", "settled", "active", "active", "active"]);
		const expected = [committedA, committedB, settled, live[1]!, live[2]!, live[3]!];
		expect(transcript.children).toHaveLength(expected.length);
		expected.forEach((component, index) => expect(transcript.children[index]).toBe(component));

		// Pressure retires the settled block next; committed rows are never offered again.
		const retire = transcript.peekFinalizedBatch(80, 5);
		expect(retire?.rows).toEqual(["settled", ""]);
	});

	it("refuses to remove an append-only block once its stable rows are offered or emitted", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);

		// Offered: the stable row is mid-write to native scrollback.
		const append = transcript.peekFinalizedBatch(80, 0)!;
		expect(append.rows).toEqual(["one"]);
		transcript.removeChild(block);
		expect(transcript.children).toHaveLength(1);
		expect(transcript.children[0]).toBe(block);
		expect(transcript.blockStates()).toEqual(["active"]);

		// Emitted: the row is in scrollback, so the block can no longer be retracted.
		transcript.acknowledgeFinalizedBatch(append.id);
		expect(transcript.emittedStableRows()).toEqual([1]);
		transcript.removeChild(block);
		expect(transcript.children).toHaveLength(1);
		expect(transcript.children[0]).toBe(block);
		expect(transcript.blockStates()).toEqual(["active"]);
	});

	it("replays committed history without rewinding lifecycle state", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.blockStates()).toEqual(["committed"]);

		transcript.beginReplay();
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		const replay = transcript.peekFinalizedBatch(80, 10);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
	});

	it("flushes a finalized prefix without viewport pressure", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["fits"], true));

		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["fits", ""]);
	});

	it("keeps the live viewport while an independent replay is offered", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["active"], false));

		transcript.beginReplay();
		expect(transcript.peekFinalizedBatch(80, 10)?.rows).toEqual(["committed", ""]);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active"]);
	});
	it("renders exactly the trailing semantic rows without walking the full ledger", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a1", "a2"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new AppendBlock(["b1", "b2"], ["b1"], true));
		transcript.addChild(new Block(["c1"], false));

		const full = transcript.render(80);
		for (const cap of [1, 3, 4, full.length, full.length + 5]) {
			expect(transcript.renderTail(80, cap)).toEqual(full.slice(-Math.min(cap, full.length)));
		}
		expect(transcript.renderTail(80, 0)).toEqual([]);
	});

	it("cancels a pending replay so shutdown flush emits only un-retired rows", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["tail"], true));

		transcript.beginReplay();
		transcript.cancelReplay();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["tail", ""]);
	});
});

describe("TranscriptContainer progressive assistant retirement", () => {
	const WIDTH = 60;
	const ROOM = 4;
	const paragraph = (label: string, index: number): string =>
		`${label} ${index} weighs **retirement** against native scrollback, with enough words to wrap.\n\n`;
	// Thinking streams first, then an answer after it: every update freezes one
	// more paragraph, and the answer turns the thinking into a closed part.
	const steps: AssistantMessage[] = [];
	let reasoning = "";
	for (let index = 0; index < 8; index++) {
		reasoning += paragraph("Thought", index);
		steps.push({ ...finalAnswer, content: [{ type: "thinking", thinking: `${reasoning}Pending` }] });
	}
	let answer = "";
	for (let index = 0; index < 8; index++) {
		answer += paragraph("Answer", index);
		steps.push({
			...finalAnswer,
			content: [
				{ type: "thinking", thinking: reasoning.trim() },
				{ type: "text", text: `${answer}Pending` },
			],
		});
	}

	beforeAll(async () => {
		await initTheme(false);
	});

	/** With `observe`, the transcript composes every update; otherwise only the block renders. */
	function apply(
		transcript: TranscriptContainer,
		component: AssistantMessageComponent,
		updates: readonly AssistantMessage[],
		observe: boolean,
	): void {
		for (const update of updates) {
			component.updateContent(update, { transient: true });
			if (observe) transcript.renderViewport(WIDTH, 1000, frame);
			else component.render(WIDTH);
		}
	}

	function retire(transcript: TranscriptContainer, width: number): readonly string[] {
		const batch = transcript.peekFinalizedBatch(width, ROOM);
		if (!batch) throw new Error("Expected a stable-row batch");
		transcript.acknowledgeFinalizedBatch(batch.id);
		return batch.rows;
	}

	it("retires several published prefixes per batch as exactly the block's leading rows", () => {
		const runs = [true, false].map(observe => {
			const transcript = new TranscriptContainer();
			const component = new AssistantMessageComponent();
			transcript.addChild(component);
			apply(transcript, component, steps.slice(0, 8), observe);
			const first = retire(transcript, WIDTH);
			const [firstCount = 0] = transcript.emittedStableRows();
			apply(transcript, component, steps.slice(8), observe);
			const second = retire(transcript, WIDTH);
			const [secondCount = 0] = transcript.emittedStableRows();

			expect(firstCount).toBeGreaterThan(1);
			expect(secondCount - firstCount).toBeGreaterThan(1);
			const live = transcript.renderViewport(WIDTH, 1000, frame);
			expect([...first, ...second, ...live]).toEqual([...trimBlankEdges(component.render(WIDTH))]);
			return { first, second, firstCount, secondCount };
		});
		// Whether or not the transcript saw each prefix as it published, the
		// batches are the same rows.
		expect(runs[1]).toEqual(runs[0]!);
	});

	it("retires further published prefixes after a resize as the new width's leading rows", () => {
		const transcript = new TranscriptContainer();
		const component = new AssistantMessageComponent();
		transcript.addChild(component);
		apply(transcript, component, steps.slice(0, 8), true);
		retire(transcript, WIDTH);
		apply(transcript, component, steps.slice(8), true);
		const [emitted = 0] = transcript.emittedStableRows();

		const narrow = 44;
		const emittedRows = component.renderTranscriptStableRows(emitted, narrow);
		const next = retire(transcript, narrow);
		expect(transcript.emittedStableRows()[0]! - emitted).toBeGreaterThan(1);
		const live = transcript.renderViewport(narrow, 1000, frame);
		expect([...emittedRows, ...next, ...live]).toEqual([...trimBlankEdges(component.render(narrow))]);
	});

	it("retires the finished lines of a still-open fence instead of holding the block live", () => {
		// A streamed code block (SQL, logs) closes its fence only at the end. It
		// never reaches a "\n\n" boundary, so the block walk alone publishes
		// nothing for it and every row past the screen height is dropped from the
		// live viewport instead of retiring into scrollback (#9780).
		const transcript = new TranscriptContainer();
		const component = new AssistantMessageComponent();
		transcript.addChild(component);
		const statement = (index: number): string => `SELECT column_${index} FROM orders_${index};\n`;
		let body = "```sql\n";
		for (let index = 0; index < 12; index++) {
			body += statement(index);
			component.updateContent({ ...finalAnswer, content: [{ type: "text", text: body }] }, { transient: true });
			transcript.renderViewport(WIDTH, ROOM, frame);
		}
		const retired = retire(transcript, WIDTH);
		const [emitted = 0] = transcript.emittedStableRows();
		expect(emitted).toBeGreaterThan(1);
		const retiredText = Bun.stripANSI(retired.join("\n"));
		expect(retiredText).toContain("SELECT column_0 FROM orders_0;");
		// The fence has no closer yet, so the renderer's fabricated closing
		// border must not be retired as if the block had ended.
		expect(retired.at(-1)!.trim()).not.toBe("```");
		const live = transcript.renderViewport(WIDTH, 1000, frame);
		expect([...retired, ...live]).toEqual([...trimBlankEdges(component.render(WIDTH))]);
	});
});

describe("TranscriptContainer viewport click spans", () => {
	it("maps uncapped viewport rows to their blocks, skipping separators", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["a1", "a2"], false);
		const second = new Block(["b1"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["a1", "a2", "", "b1"]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 2 },
			{ component: second, start: 3, end: 4 },
		]);
	});

	it("maps allocation-clipped rows to their surviving tails", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["a1", "a2", "a3", "a4"], false);
		const second = new Block(["b1", "b2", "b3", "b4"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		expect(transcript.renderViewport(80, 5, frame)).toEqual(["a4", "b1", "b2", "b3", "b4"]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 1 },
			{ component: second, start: 1, end: 5 },
		]);
	});

	it("leaves the emergency summary row unmapped", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a1"], false));
		transcript.addChild(new Block(["b1"], false));
		transcript.addChild(new Block(["c1"], false));

		expect(transcript.renderViewport(80, 1, frame)).toEqual(["2 more transcript blocks active"]);
		expect(transcript.getLastViewportSpans()).toEqual([]);
	});

	it("clears spans when the tail is empty or cleared", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["a1"], false);
		transcript.addChild(block);
		transcript.renderViewport(80, 10, frame);
		expect(transcript.getLastViewportSpans()).toHaveLength(1);

		expect(transcript.renderViewport(80, 0, frame)).toEqual([]);
		expect(transcript.getLastViewportSpans()).toEqual([]);

		transcript.renderViewport(80, 10, frame);
		transcript.clear();
		expect(transcript.getLastViewportSpans()).toEqual([]);
	});
});

describe("TranscriptContainer insertChildAt", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders a tail insertion without scanning committed history", () => {
		const transcript = new TranscriptContainer();
		const history = Array.from({ length: 64 }, (_, index) => new Block([`history ${index}`], true));
		for (const block of history) transcript.addChild(block);
		const committed = transcript.peekFlushBatch(80);
		if (!committed) throw new Error("Expected history batch");
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["anchor"], false));
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["anchor"]);

		let historyReads = 0;
		for (const [index, block] of history.entries()) {
			Object.defineProperty(transcript.children, index, {
				get: () => {
					historyReads++;
					return block;
				},
				configurable: true,
			});
		}

		transcript.insertChildAt(new Block(["inserted"], false), transcript.children.length);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["anchor", "", "inserted"]);
		expect(historyReads).toBe(0);
	});

	it("renders a middle insertion without scanning committed history", () => {
		const transcript = new TranscriptContainer();
		const history = Array.from({ length: 64 }, (_, index) => new Block([`history ${index}`], true));
		for (const block of history) transcript.addChild(block);
		const committed = transcript.peekFlushBatch(80);
		if (!committed) throw new Error("Expected history batch");
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["anchor"], false));
		transcript.addChild(new Block(["tail"], false));
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["anchor", "", "tail"]);

		let historyReads = 0;
		for (const [index, block] of history.entries()) {
			Object.defineProperty(transcript.children, index, {
				get: () => {
					historyReads++;
					return block;
				},
				configurable: true,
			});
		}

		transcript.insertChildAt(new Block(["inserted"], false), transcript.children.length - 1);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["anchor", "", "inserted", "", "tail"]);
		expect(historyReads).toBe(0);
	});

	it("keeps inserted blocks ordered and removable across repeated inserts", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first"], false);
		const last = new Block(["last"], false);
		transcript.addChild(first);
		transcript.addChild(last);

		const insertedA = new Block(["inserted-a"], false);
		const insertedB = new Block(["inserted-b"], false);
		transcript.insertChildAt(insertedA, 1);
		transcript.insertChildAt(insertedB, 1);

		expect(transcript.children).toEqual([first, insertedB, insertedA, last]);
		expect(transcript.canRemoveBlock(insertedA)).toBe(true);
		expect(transcript.canRemoveBlock(insertedB)).toBe(true);
	});
});
