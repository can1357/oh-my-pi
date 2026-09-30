import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type Component,
	CURSOR_MARKER,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	Text,
} from "@oh-my-pi/pi-tui";
import { emergencyTerminalRestore, type OutputPump } from "@oh-my-pi/pi-tui/terminal";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";
import { VirtualTerminal } from "./virtual-terminal";

// What a discard is followed by: ST ends a cut OSC/DCS/APC string, then
// synchronized output ends, SGR resets, an open OSC 8 hyperlink closes and the
// cursor shows. The terminal parses these bytes, so they are the contract.
const SETTLE_RESET = "\x1b\\\x1b[?2026l\x1b[0m\x1b]8;;\x07\x1b[?25h";
const SHOW_CURSOR = "\x1b[?25h";
const FIRST_RESTORE_WRITE = "\x1b[?2026l\x1b[?7h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const KITTY_POP = "\x1b[<u";
const TITLE_POP = "\x1b[23;2t";
// The tall session's content passes the 24-row viewport's bottom, so the
// prompt goes on its last row and scrolls once.
const TALL_PLACEMENT = "\x1b[24;1H\n";
// The exit-time blind restore: bracketed paste off, then Mode 2031 off.
const BLIND_RESTORE = "\x1b[?2004l\x1b[?2031l";

interface FakePumpOptions {
	/** One `flushSync` outcome per call: true means the terminal read everything within the wait. */
	flushes?: boolean[];
	/** The outcome once `flushes` runs out. */
	thenFlushes?: boolean;
	/** False models a stale prebuilt addon without `discard`. */
	canDiscard?: boolean;
	/** How much of the queued text reached the terminal before a discard cut it. */
	cutAt?: (queued: string) => number;
}

/**
 * The native pump's queue without its thread. Writes queue up and reach
 * `delivered` only when a wait drains them or the terminal catches up. A
 * discard drops the queue; what the pump was already writing stays pending
 * (never delivered) until the pump makes progress.
 */
class FakePump implements OutputPump {
	readonly dead = false;
	readonly delivered: string[] = [];
	flushCalls = 0;
	discards = 0;
	discard?: () => void;
	#queue: string[] = [];
	#inFlightBytes = 0;
	#reading = true;
	readonly #flushes: boolean[];
	readonly #thenFlushes: boolean;
	readonly #cutAt: (queued: string) => number;

	constructor({ flushes = [], thenFlushes = true, canDiscard = true, cutAt = () => 0 }: FakePumpOptions = {}) {
		this.#flushes = [...flushes];
		this.#thenFlushes = thenFlushes;
		this.#cutAt = cutAt;
		if (canDiscard) this.discard = () => this.#discard();
	}

	get queued(): string {
		return this.#queue.join("");
	}

	get stream(): string {
		return this.delivered.join("");
	}

	write(data: string): number {
		this.#queue.push(data);
		return this.pending();
	}

	pending(): number {
		return this.#inFlightBytes + Buffer.byteLength(this.queued);
	}

	flushSync(): boolean {
		this.flushCalls++;
		this.#reading = this.#flushes.shift() ?? this.#thenFlushes;
		if (this.#reading) this.catchUp();
		return this.#reading;
	}

	stop(): void {
		if (this.#reading) this.catchUp();
	}

	/** The terminal reads again: the pump abandons what a discard cut and delivers the rest. */
	catchUp(): void {
		this.#reading = true;
		this.#inFlightBytes = 0;
		this.delivered.push(...this.#queue);
		this.#queue = [];
	}

	#discard(): void {
		this.discards++;
		const queued = this.queued;
		const cut = this.#cutAt(queued);
		if (cut > 0) this.delivered.push(queued.slice(0, cut));
		this.#inFlightBytes += Buffer.byteLength(queued.slice(cut));
		this.#queue = [];
	}
}

/** More rows than the terminal has, so the frame scrolls and stop() places the shell prompt. */
class TallBlock implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `row ${i}`.padEnd(Math.min(width, 10)));
	}
}

/** Rows that can change between frames, the last carrying the editor's cursor. */
class EditableRows implements Component {
	constructor(readonly lines: string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

/** A transcript whose shutdown flush retires `rows` history rows in one batch. */
class FlushProvider implements TerminalFrameProvider {
	readonly acknowledged: number[] = [];
	#flushing = false;
	constructor(readonly rows: number) {}
	renderFrame(): TerminalFramePlan {
		if (!this.#flushing || this.acknowledged.length > 0) return { viewport: ["editor"] };
		return {
			history: { id: 1, rows: Array.from({ length: this.rows }, (_, i) => `hist ${i}`) },
			viewport: ["editor"],
		};
	}
	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
	}
	beginHistoryFlush(): void {
		this.#flushing = true;
	}
}

/** Where each needle starts in `stream`, each searched after the previous one ends; -1 once one is missing. */
function positionsInOrder(stream: string, needles: readonly string[]): number[] {
	const positions: number[] = [];
	let from = 0;
	for (const needle of needles) {
		const at = from < 0 ? -1 : stream.indexOf(needle, from);
		positions.push(at);
		from = at < 0 ? -1 : at + needle.length;
	}
	return positions;
}

describe("settling the output pump before the terminal is handed back", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		vi.restoreAllMocks();
	});

	async function startTallSession(pump: FakePump): Promise<ProcessTerminalRenderHarness> {
		harness = createProcessTerminalRenderHarness(80, 24, { outputPump: () => pump });
		harness.tui.addChild(new TallBlock(60));
		harness.tui.requestRender();
		await harness.settle();
		return harness;
	}

	async function startFlushingSession(pump: FakePump, provider: FlushProvider): Promise<ProcessTerminalRenderHarness> {
		harness = createProcessTerminalRenderHarness(80, 24, { outputPump: () => pump });
		harness.tui.setFrameProvider(provider);
		harness.tui.requestRender();
		await harness.settle();
		return harness;
	}

	it("cuts the history flush's own output and resets before the shell-prompt handoff", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump({ flushes: [true, false], thenFlushes: false });
		const provider = new FlushProvider(200);
		const session = await startFlushingSession(pump, provider);

		session.tui.stop();
		pump.catchUp();

		expect(provider.acknowledged).toEqual([1]);
		expect(pump.stream).not.toContain("hist ");
		expect(positionsInOrder(pump.stream, [SETTLE_RESET, SHOW_CURSOR, FIRST_RESTORE_WRITE])).not.toContain(-1);
	});

	it("leaves a backlog that drains alone", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump();
		const session = await startTallSession(pump);

		session.tui.stop();

		expect(pump.discards).toBe(0);
		expect(pump.stream).not.toContain(SETTLE_RESET);
		expect(positionsInOrder(pump.stream, [TALL_PLACEMENT, SHOW_CURSOR, FIRST_RESTORE_WRITE])).not.toContain(-1);
	});

	it("completes the stop after one wait when the addon cannot discard", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump({ thenFlushes: false, canDiscard: false });
		const session = await startTallSession(pump);

		session.tui.stop();
		pump.catchUp();

		// Every later settle found the pump still stalled and did not wait again.
		expect(pump.flushCalls).toBe(1);
		expect(pump.stream).not.toContain(SETTLE_RESET);
		expect(positionsInOrder(pump.stream, [TALL_PLACEMENT, SHOW_CURSOR, FIRST_RESTORE_WRITE])).not.toContain(-1);
	});

	it("settles a pre-stop backlog before an overlay's alternate-screen exit, which nothing drops", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump({ flushes: [false], thenFlushes: false });
		const session = await startTallSession(pump);
		session.tui.showOverlay(new Text("MODAL", 0, 0), { fullscreen: true });
		await session.settle();

		session.tui.stop();
		pump.catchUp();

		expect(pump.discards).toBe(1);
		const resetAt = pump.delivered.indexOf(SETTLE_RESET);
		expect(resetAt).toBeGreaterThan(-1);
		expect(pump.delivered[resetAt + 1]).toContain(ALT_SCREEN_EXIT);
	});

	it("keeps the keyboard-protocol pop that drainInput queues after its own discard", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump({ flushes: [false], thenFlushes: false });
		const session = await startTallSession(pump);
		await session.feed("\x1b[?0u");
		expect(session.terminal.kittyProtocolActive).toBe(true);

		await session.terminal.drainInput(20, 5);
		session.tui.stop();
		pump.catchUp();

		expect(pump.discards).toBe(1);
		expect(pump.stream.split(KITTY_POP)).toHaveLength(2);
		expect(positionsInOrder(pump.stream, [SETTLE_RESET, KITTY_POP])).not.toContain(-1);
	});

	it("leaves the teardown's handoff bytes queued behind a pump that stays blocked", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump({ flushes: [false], thenFlushes: false });
		const session = await startTallSession(pump);
		await session.feed("\x1b[?0u");
		session.tui.showOverlay(new Text("MODAL", 0, 0), { fullscreen: true });
		await session.settle();

		// InteractiveMode's teardown order: settle, pop the title, drain input, stop.
		session.terminal.settleOutput();
		session.terminal.write(TITLE_POP);
		await session.terminal.drainInput(20, 5);
		session.tui.stop();
		pump.catchUp();

		// One bounded wait and one discard; every later settle found the pump
		// still blocked and left the handoff bytes queued, in order.
		expect(pump.flushCalls).toBe(1);
		expect(pump.discards).toBe(1);
		expect(
			positionsInOrder(pump.stream, [
				SETTLE_RESET,
				TITLE_POP,
				KITTY_POP,
				ALT_SCREEN_EXIT,
				TALL_PLACEMENT,
				SHOW_CURSOR,
				FIRST_RESTORE_WRITE,
			]),
		).not.toContain(-1);
	});

	it("skips the history flush when the backlog before the stop cannot drain", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump({ flushes: [false], thenFlushes: false });
		const provider = new FlushProvider(200);
		const session = await startFlushingSession(pump, provider);

		session.tui.stop();
		pump.catchUp();

		expect(provider.acknowledged).toEqual([]);
		expect(pump.stream).not.toContain("hist ");
	});

	it("settles again once the pump has written since the last discard", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump({ flushes: [false, false], thenFlushes: false });
		const session = await startTallSession(pump);

		expect(session.terminal.settleOutput()).toBe(false);
		pump.catchUp();
		session.terminal.write("x".repeat(1000));
		expect(session.terminal.settleOutput()).toBe(false);

		expect(pump.flushCalls).toBe(2);
		expect(pump.discards).toBe(2);
	});

	it("drops a disconnected terminal's backlog once, without waiting or writing a reset", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump();
		const session = await startTallSession(pump);

		// Ending stdin disconnects the terminal, which stops the TUI.
		const signalsBefore = session.signals.length;
		await session.endInput();

		expect(session.signals.slice(signalsBefore).map(({ signal }) => signal)).toEqual(["SIGHUP"]);
		expect(pump.flushCalls).toBe(0);
		expect(pump.discards).toBe(1);
		expect(pump.stream).not.toContain(SETTLE_RESET);
	});

	it("places the shell prompt below the content even when a discard cut the last frame", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});

		async function hintAfterStop(cutLastFrame: boolean): Promise<{ hintRow: number; editorRow: number }> {
			let lastFrameStart = 0;
			const pump = new FakePump({
				flushes: cutLastFrame ? [false] : [],
				thenFlushes: !cutLastFrame,
				cutAt: queued => lastFrameStart + Math.floor((queued.length - lastFrameStart) / 2),
			});
			const session = createProcessTerminalRenderHarness(40, 12, { outputPump: () => pump });
			harness = session;
			const rows = new EditableRows([
				...Array.from({ length: 7 }, (_, i) => `line ${i}`),
				`> input${CURSOR_MARKER}`,
			]);
			session.tui.addChild(rows);
			session.tui.requestRender();
			await session.settle();
			lastFrameStart = pump.queued.length;
			rows.lines[0] = "CHANGED top";
			session.tui.requestRender();
			await session.settle();

			session.tui.stop();
			pump.catchUp();
			session.dispose();
			harness = undefined;

			const screen = new VirtualTerminal(40, 12);
			screen.write(`${pump.stream}HINT\r\n$ `);
			const viewport = await screen.flushAndGetViewport();
			return {
				hintRow: viewport.findIndex(row => row.startsWith("HINT")),
				editorRow: viewport.findIndex(row => row.startsWith("> input")),
			};
		}

		const control = await hintAfterStop(false);
		const cut = await hintAfterStop(true);

		expect(control.hintRow).toBe(control.editorRow + 1);
		expect(cut).toEqual(control);
	});
});

describe("the exit-time restore on a terminal that stopped reading", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("still waits for the terminal to take the held output when restoring stdin's mode throws", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		// The terminal reads nothing through the stop and the next two waits, then everything.
		const pump = new FakePump({ flushes: [false, false, false], thenFlushes: true });
		harness = createProcessTerminalRenderHarness(80, 24, { outputPump: () => pump });
		harness.tui.addChild(new TallBlock(60));
		harness.tui.requestRender();
		await harness.settle();
		harness.tui.stop();
		// A terminal whose mode cannot be restored, as a revoked but still-open tty reports it.
		const setRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
		Object.defineProperty(process.stdin, "setRawMode", {
			value: () => {
				throw new Error("setRawMode failed with errno: 5");
			},
			configurable: true,
		});
		try {
			emergencyTerminalRestore();
		} finally {
			if (setRawMode) Object.defineProperty(process.stdin, "setRawMode", setRawMode);
		}

		expect(pump.pending()).toBe(0);
		expect(positionsInOrder(pump.stream, [SETTLE_RESET, FIRST_RESTORE_WRITE, BLIND_RESTORE])).not.toContain(-1);
	});

	it("leaves the alternate screen when the TUI never stopped and its backlog cannot drain", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const pump = new FakePump({ flushes: [false], thenFlushes: true });
		harness = createProcessTerminalRenderHarness(80, 24, { outputPump: () => pump });
		harness.tui.addChild(new TallBlock(60));
		harness.tui.requestRender();
		await harness.settle();
		harness.tui.showOverlay(new Text("MODAL", 0, 0), { fullscreen: true });
		await harness.settle();

		// TUI.stop() never ran (it threw, or an embedder's crash handler came first):
		// the exit-time restore is what hands the terminal back.
		emergencyTerminalRestore();

		expect(positionsInOrder(pump.stream, [SETTLE_RESET, ALT_SCREEN_EXIT, FIRST_RESTORE_WRITE])).not.toContain(-1);
	});
});

describe("ProcessTerminal output encoding", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("sends a lone surrogate as U+FFFD without swallowing the next character", async () => {
		const pump = new FakePump();
		harness = createProcessTerminalRenderHarness(80, 24, { outputPump: () => pump });
		harness.terminal.write("[a\uD800b]");
		pump.catchUp();
		expect(pump.stream).toContain("[a\uFFFDb]");
		harness.dispose();

		// The stream fallback, used without a pump, sends the same text.
		harness = createProcessTerminalRenderHarness(80, 24);
		harness.terminal.write("[a\uD800b]");
		expect(harness.writes).toContain("[a\uFFFDb]");
	});
});
