/**
 * `/pause` teardown on a row-rendered terminal: a unix TTY takes the frame
 * into the off-thread writer and reports the backlog through
 * `pendingOutputBytes`, so the paint returning says nothing about what the
 * operator sees. The gate must stay closed until that backlog is delivered,
 * or agents run while the screen still says PAUSED.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { PauseScreenComponent, type PauseScreenHost, runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui/tui";
import { ManualScheduler } from "./native/tsp-harness";

/** A TTY whose writer only delivers what the test tells it to deliver. */
class QueuedTerminal implements Terminal {
	readonly written: string[] = [];
	#pending = 0;

	get columns(): number {
		return 80;
	}
	get rows(): number {
		return 24;
	}
	/** Bytes the writer has accepted but not yet handed to the terminal. */
	get pendingOutputBytes(): number {
		return this.#pending;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	get appearance(): TerminalAppearance | undefined {
		return "dark";
	}

	/** The writer thread caught up with everything queued so far. */
	deliver(): void {
		this.#pending = 0;
	}

	write(data: string): void {
		this.written.push(data);
		this.#pending += Buffer.byteLength(data, "utf8");
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}

class Rows implements Component {
	render(): readonly string[] {
		return ["session"];
	}
}

interface Harness {
	tui: TUI;
	terminal: QueuedTerminal;
	scheduler: ManualScheduler;
	host: PauseScreenHost;
	/** Run queued renders and let the teardown's awaits resume. */
	settle(): Promise<void>;
}

function start(): Harness {
	const terminal = new QueuedTerminal();
	const scheduler = new ManualScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.addChild(new Rows());
	tui.start();
	const settle = async (): Promise<void> => {
		for (let round = 0; round < 8; round++) {
			scheduler.flush(10); // the drain poll's cadence
			// Real hop: the wait resumes as a microtask after the timer runs.
			await Bun.sleep(1);
		}
	};
	return { tui, terminal, scheduler, host: { ui: tui, showStatus: () => {} }, settle };
}

let stop: (() => void) | undefined;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterEach(() => {
	stop?.();
	stop = undefined;
	agentPauseGate.resume();
});

describe("pause dismissal on a row-rendered terminal", () => {
	it("keeps the gate closed until the writer has delivered the dismissal", async () => {
		const h = start();
		stop = () => h.tui.stop();
		await h.settle();
		h.terminal.deliver(); // the writer is caught up when the screen goes up

		const run = runPauseScreen(h.host);
		await h.settle();
		const shown = h.tui.overlayStack.at(-1)?.component;
		if (!(shown instanceof PauseScreenComponent)) throw new Error("expected the pause screen");
		h.terminal.deliver();

		shown.handleInput("\x1b");
		await h.settle();
		expect(h.terminal.pendingOutputBytes).toBeGreaterThan(0); // the dismissal is still queued
		expect(agentPauseGate.paused).toBe(true); // ... so no agent may run yet

		h.terminal.deliver();
		await h.settle();
		await run;
		expect(agentPauseGate.paused).toBe(false);
	});

	it("opens the gate on the accept span when the writer never delivers", async () => {
		const h = start();
		stop = () => h.tui.stop();
		await h.settle();

		const run = runPauseScreen(h.host);
		await h.settle();
		const shown = h.tui.overlayStack.at(-1)?.component;
		if (!(shown instanceof PauseScreenComponent)) throw new Error("expected the pause screen");
		h.terminal.deliver();

		shown.handleInput("\x1b");
		await h.settle();
		expect(agentPauseGate.paused).toBe(true);

		// A terminal that reads nothing may delay the resume by the accept
		// span, never strand it.
		h.scheduler.advance(5_000);
		await h.settle();
		await run;
		expect(h.terminal.pendingOutputBytes).toBeGreaterThan(0);
		expect(agentPauseGate.paused).toBe(false);
	});
});
