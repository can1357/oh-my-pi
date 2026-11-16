import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { Terminal, type TerminalIo, type TerminalIoSink } from "@oh-my-pi/pi-tui/terminal";

const TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

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

class MinimalTerminal extends Terminal {
	readonly #io: CaptureIo;

	constructor() {
		const io = new CaptureIo(80, 24);
		super(io);
		this.#io = io;
	}

	override async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	/** Everything the engine wrote so far. */
	get output(): string {
		return this.#io.writes.join("");
	}

	/** Deliver stdin bytes through the engine's input parser. */
	sendInput(data: string): void {
		this.#io.sink?.input(utf8Encoder.encode(data));
	}

	/** Report the (unchanged) OS size again, as a SIGWINCH does. */
	emitResize(): void {
		this.#io.sink?.resize(this.#io.columns, this.#io.rows);
	}
}

class StaticOverlay implements Component {
	render(_width: number): readonly string[] {
		return ["overlay"];
	}
}

function makeInlineTui(enabled: { current: boolean }): { terminal: MinimalTerminal; tui: TUI } {
	const terminal = new MinimalTerminal();
	const tui = new TUI(terminal);
	tui.setInlineMouseTrackingProvider(() => enabled.current);
	return { terminal, tui };
}

describe("inline mouse tracking", () => {
	it("enables capture on the normal buffer and releases it on stop", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			tui.stop();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(-1);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));
		} finally {
			tui.stop();
		}
	});

	it("yields to any visible overlay and restores after it closes", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			const overlay = tui.showOverlay(new StaticOverlay(), {});
			tui.renderNow();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(-1);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));

			overlay.hide();
			tui.renderNow();
			expect(terminal.output.lastIndexOf(TRACKING_ON)).toBeGreaterThan(offAt);
		} finally {
			tui.stop();
		}
	});

	it("restores inline capture after a mouse-disabled fullscreen overlay closes", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true, mouseTracking: false });
			tui.renderNow();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(-1);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));

			overlay.hide();
			tui.renderNow();
			expect(terminal.output.lastIndexOf(TRACKING_ON)).toBeGreaterThan(offAt);
		} finally {
			tui.stop();
		}
	});

	it("releases capture on stop even with a pending alt exit", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true });
			tui.renderNow();

			// Destructive repaint + overlay close fuses the alt exit without an
			// OFF write so capture would continue; quitting first must still
			// release the terminal.
			tui.requestRender(true, { clearScrollback: true });
			overlay.hide();
			tui.renderNow();
			tui.stop();

			expect(terminal.output.includes(TRACKING_OFF)).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("leaves tracking off when stopping after a fused restore exit", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true, mouseTracking: false });
			tui.renderNow();

			// Destructive repaint + overlay close fuses the alt exit including
			// the inline restore; quitting first must still leave the final
			// OFF after any re-enable or the shell keeps reporting.
			tui.requestRender(true, { clearScrollback: true });
			overlay.hide();
			tui.renderNow();
			tui.stop();

			expect(terminal.output.includes(TRACKING_OFF)).toBe(true);
			expect(terminal.output.lastIndexOf(TRACKING_OFF)).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));
		} finally {
			tui.stop();
		}
	});

	it("stays off by default", () => {
		const enabled = { current: false };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(false);
		} finally {
			tui.stop();
		}
	});
});

describe("mutable viewport geometry", () => {
	it("exposes the painted window and hides it behind the alt screen", () => {
		const enabled = { current: true };
		const { tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.addChild({ render: () => ["line"] });
			tui.renderNow();
			expect(tui.getMutableViewport().length).toBe(1);

			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true });
			tui.renderNow();
			expect(tui.getMutableViewport()).toEqual({ top: 0, length: 0 });
			overlay.hide();
		} finally {
			tui.stop();
		}
	});
});
