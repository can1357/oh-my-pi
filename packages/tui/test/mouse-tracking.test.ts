import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

const TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;
	#onResize: (() => void) | undefined;
	output = "";

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}

	stop(): void {
		this.#onInput = undefined;
		this.#onResize = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	sendInput(data: string): void {
		this.#onInput?.(data);
	}

	emitResize(): void {
		this.#onResize?.();
	}
	write(data: string): void {
		this.output += data;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
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
