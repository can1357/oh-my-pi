import { afterEach, describe, expect, it } from "bun:test";
import { type Component, ImageProtocol, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * The 8-bit C1 DCS introducer is a legal SIXEL introducer, but it is not an
 * ESC: the renderer's common line classifier only offered the ESC and the
 * Kitty placeholder as image-marker candidates, so an 8-bit frame was treated
 * as text. The row was then cut to the viewport width, and the cut took the ST
 * with it — the host terminal stayed inside the DCS string and swallowed the
 * rest of the output.
 */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/** One raw row, exactly as the terminal wrote it. */
class RawRow implements Component {
	constructor(private readonly row: string) {}

	invalidate(): void {}

	render(): string[] {
		return [this.row];
	}
}

async function paintRow(row: string): Promise<string> {
	const terminal = new RecordingTerminal(20, 5);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.start();
	tui.addChild(new RawRow(row));
	await scheduler.settle(terminal);
	return terminal.writes.join("");
}

describe("SIXEL image rows in the common line classifier", () => {
	const originalProtocol = TERMINAL.imageProtocol;

	afterEach(() => {
		TERMINAL.imageProtocol = originalProtocol;
	});

	it("keeps an 8-bit SIXEL row whole", async () => {
		TERMINAL.imageProtocol = ImageProtocol.Sixel;
		// The text in front of the frame makes the row wider than the viewport,
		// so a text row would be cut to the viewport width — and with it the ST.
		const row = `${"T".repeat(30)}\x90q#0;2;100;0;0#0${"A".repeat(40)}\x9c`;

		const paint = await paintRow(row);

		expect(paint).toContain("\x90q");
		expect(paint).toContain("\x9c");
		expect(paint).toContain("A".repeat(40));
	});

	it("keeps a 7-bit SIXEL row whole", async () => {
		TERMINAL.imageProtocol = ImageProtocol.Sixel;
		const row = `${"T".repeat(30)}\x1bPq#0;2;100;0;0#0${"A".repeat(40)}\x1b\\`;

		const paint = await paintRow(row);

		expect(paint).toContain("\x1bPq");
		expect(paint).toContain("\x1b\\");
		expect(paint).toContain("A".repeat(40));
	});
});
