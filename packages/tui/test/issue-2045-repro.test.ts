import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { Terminal, type TerminalIo, type TerminalIoSink } from "@oh-my-pi/pi-tui/terminal";

const utf8Decoder = new TextDecoder();

/** Byte-capturing IO port: engine output is recorded, nothing answers on stdin. */
class CaptureIo implements TerminalIo {
	readonly interactive = false;
	readonly backlog = 0;
	readonly writes: string[] = [];
	sink: TerminalIoSink | undefined;

	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}

	open(sink: TerminalIoSink): void {
		this.sink = sink;
	}

	write(chunks: readonly Uint8Array[]): void {
		for (const chunk of chunks) this.writes.push(utf8Decoder.decode(chunk, { stream: true }));
	}

	close(): void {
		this.sink = undefined;
	}
}

class CaptureTerminal extends Terminal {
	readonly #io: CaptureIo;

	constructor(columns = 80, rows = 4) {
		const io = new CaptureIo(columns, rows);
		super(io);
		this.#io = io;
	}

	override async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	/** Every chunk the engine wrote so far. */
	get writes(): readonly string[] {
		return this.#io.writes;
	}
}

class RawLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(): string[] {
		return this.#lines;
	}
}

async function settle(): Promise<void> {
	await Bun.sleep(0);
}

describe("issue #2045: renderer bounds oversized rows", () => {
	it("preserves visible text after pathological zero-width ANSI prefixes", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const line = `${"\x1b[31m".repeat(20_000)}payload`;

		tui.addChild(new RawLinesComponent([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("payload");
		expect(rendered.length).toBeLessThan(12_000);
	});

	it("preserves visible suffix text after long zero-width combining prefixes", async () => {
		const term = new CaptureTerminal(3, 4);
		const tui = new TUI(term);
		const line = `a${"\u0301".repeat(4096)}bc`;

		tui.addChild(new RawLinesComponent([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("bc");
	});

	it("preserves visible text after oversized OSC hyperlink prefixes", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const line = `\x1b]8;;https://example.com/${"a".repeat(70_000)}\x07link-label\x1b]8;;\x07`;

		tui.addChild(new RawLinesComponent([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("link-label");
		expect(rendered.length).toBeLessThan(12_000);
	});

	it("preserves OSC 66 text-sizing payloads at the start of long rows", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const visibleText = "H".repeat(70);
		const line = `\x1b]66;s=1;${visibleText}\x1b\\${"\x1b[31m".repeat(20_000)}`;

		tui.addChild(new RawLinesComponent([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain(visibleText);
	});
});
