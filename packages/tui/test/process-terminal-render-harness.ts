import { vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type Component, TUI, type TUIStartOptions } from "@oh-my-pi/pi-tui";
import type { ProcessTerminal, ProcessTerminalOptions } from "@oh-my-pi/pi-tui/terminal";
import { fakeProcessTty } from "./helpers/process-tty";

// Pristine descriptors, captured once at module load. Every dispose() restores
// to these so the harness is full-suite safe across repeated create/dispose
// cycles (no leaked mutation of process.stdout globals).
const PRISTINE: Array<[NodeJS.Process["stdout"], string, PropertyDescriptor | undefined]> = [
	[process.stdout, "columns", Object.getOwnPropertyDescriptor(process.stdout, "columns")],
	[process.stdout, "rows", Object.getOwnPropertyDescriptor(process.stdout, "rows")],
];

// One frame interval is ~33ms (TUI.#MIN_RENDER_INTERVAL_MS); two frames of
// virtual time flush any throttled paint and the stdin flush windows behind it.
const SETTLE_MS = 67;

/**
 * A root component that records the width it is asked to render at. The renderer
 * calls `render(terminal.columns)` every frame, so `last` is exactly the
 * geometry the transcript reflowed to — observable without parsing the
 * escape-laden paint stream.
 */
export class WidthProbe implements Component {
	readonly widths: number[] = [];
	invalidate(): void {}
	render(width: number): string[] {
		this.widths.push(width);
		return ["x".repeat(Math.max(0, width))];
	}
	get last(): number | undefined {
		return this.widths.at(-1);
	}
}

export interface ProcessTerminalRenderHarness {
	readonly terminal: ProcessTerminal;
	readonly tui: TUI;
	readonly probe: WidthProbe;
	/** Decoded output the TUI wrote to the terminal, in order. */
	readonly writes: string[];
	/** Signals the process sent itself, in order. */
	readonly signals: Array<string | number | undefined>;
	/** Let {@link SETTLE_MS} of virtual time pass, flushing any pending paint. */
	settle(): Promise<void>;
	/** Simulate an OS resize (SIGWINCH / ConPTY): refresh stdout dims, fire `resize`. */
	osResize(columns: number, rows: number): Promise<void>;
	/** Feed a complete DEC 2048 in-band resize report (`CSI 48 ; rows ; cols ; yPx ; xPx t`). */
	inBand(rows: number, columns: number, yPixels?: number, xPixels?: number): Promise<void>;
	/** Deliver `data` as one stdin read, synchronously (no settle). */
	type(data: string): void;
	/** Feed raw byte chunks as stdin reads, through the engine's input parser. */
	feed(...chunks: string[]): Promise<void>;
	/** End stdin as a terminal host does when its pane disappears. */
	endInput(): Promise<void>;
	/** Fail stdout as a revoked terminal descriptor does on write. */
	failOutput(): Promise<void>;
	dispose(): void;
}

/**
 * Drive a real {@link ProcessTerminal} through a real {@link TUI}.
 *
 * `VirtualTerminal` models geometry as a single field that `resize()` sets
 * atomically, so its `columns`/`rows` getters can never disagree with what the
 * renderer reads — resize/reflow always "works" there by construction. The real
 * {@link ProcessTerminal} reconciles two independent channels: the OS
 * (`process.stdout.columns`, refreshed on SIGWINCH) and DEC 2048 in-band reports
 * parsed from stdin. Reflow bugs live in the seam between those channels, which
 * the mock cannot express. This harness exposes both channels and a render-width
 * probe so reflow can be asserted end-to-end across every combination of OS and
 * in-band events.
 */
export function createProcessTerminalRenderHarness(
	initialColumns = 100,
	initialRows = 30,
	terminalOptions: ProcessTerminalOptions = { conpty: false },
	startOptions?: TUIStartOptions,
	observeInput?: (data: string) => void,
): ProcessTerminalRenderHarness {
	// This harness exercises the real ProcessTerminal glue on a fake TTY, so it
	// opts out of the test-default headless suppression; dispose restores it.
	const tty = fakeProcessTty();
	// Every clock the terminal and renderer read (`setTimeout`, `Date.now`,
	// `performance.now`) runs on fake time, so settles cost no wall time and a
	// loaded machine cannot stretch a wait past a probe or flush deadline. A test
	// that installed fake timers itself keeps its clock (re-installing would drop
	// its pending timers) and restores real timers itself.
	const ownsClock = !vi.isFakeTimers();
	if (ownsClock) vi.useFakeTimers();
	Object.defineProperty(process.stdout, "columns", { value: initialColumns, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: initialRows, configurable: true });
	const restore = (): void => {
		tty.dispose();
		if (ownsClock) vi.useRealTimers();
		for (const [target, key, descriptor] of PRISTINE) {
			// A piped test run has no own `columns`/`rows` descriptor, so the
			// captured pristine value is `undefined`. Deleting the forced property
			// restores that absent state.
			if (descriptor) Object.defineProperty(target, key, descriptor);
			else Reflect.deleteProperty(target, key);
		}
	};

	// Default to non-ConPTY behavior so kitty-flag assertions are hermetic: the
	// ambient WSL env (WSL_DISTRO_NAME / WSL_INTEROP) must not change what the
	// suite observes. See ProcessTerminalOptions.
	const terminal = tty.terminal(terminalOptions);
	// The TUI binds itself as the terminal's host at construction; wrapping
	// `bind` lets the test observe every input event the engine delivers.
	const bind = terminal.bind.bind(terminal);
	const bindSpy =
		observeInput &&
		vi.spyOn(terminal, "bind").mockImplementation((host, scheduler) =>
			bind(
				{
					...host,
					input: data => {
						observeInput(data);
						host.input(data);
					},
				},
				scheduler,
			),
		);
	const tui = new TUI(terminal);
	const probe = new WidthProbe();
	tui.addChild(probe);
	try {
		tui.start(startOptions);
	} catch (err) {
		// A start() regression must not poison the worker with headless=false.
		bindSpy?.mockRestore();
		restore();
		throw err;
	}

	// Step one millisecond at a time, yielding between steps so timers armed by
	// promise continuations (the render throttle behind `setImmediate`) come due
	// in the order they would in real time.
	const elapse = async (ms: number) => {
		for (let step = 0; step < ms; step++) {
			await scheduler.yield();
			vi.advanceTimersByTime(1);
		}
		await scheduler.yield();
	};
	const settle = () => elapse(SETTLE_MS);

	return {
		terminal,
		tui,
		probe,
		writes: tty.writes,
		signals: tty.signals,
		settle,
		async osResize(columns, rows) {
			Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
			process.stdout.emit("resize");
			await settle();
		},
		async inBand(rows, columns, yPixels = 0, xPixels = 0) {
			tty.type(`\x1b[48;${rows};${columns};${yPixels};${xPixels}t`);
			await settle();
		},
		type: tty.type,
		async feed(...chunks) {
			for (const chunk of chunks) tty.type(chunk);
			await settle();
		},
		async endInput() {
			tty.endInput();
			await settle();
		},
		async failOutput() {
			tty.failOutput(new Error("terminal revoked"));
			await settle();
		},
		dispose() {
			try {
				tui.stop();
			} finally {
				bindSpy?.mockRestore();
				restore();
			}
		},
	};
}
