import { vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// Pristine descriptors, captured once at module load. Every dispose() restores
// to these so the harness is full-suite safe across repeated create/dispose
// cycles (no leaked mutation of process.stdin/stdout globals).
const PRISTINE: Array<[NodeJS.Process["stdin"] | NodeJS.Process["stdout"], string, PropertyDescriptor | undefined]> = [
	[process.stdin, "isTTY", Object.getOwnPropertyDescriptor(process.stdin, "isTTY")],
	[process.stdout, "isTTY", Object.getOwnPropertyDescriptor(process.stdout, "isTTY")],
	[process.stdin, "setRawMode", Object.getOwnPropertyDescriptor(process.stdin, "setRawMode")],
	[process.stdout, "columns", Object.getOwnPropertyDescriptor(process.stdout, "columns")],
	[process.stdout, "rows", Object.getOwnPropertyDescriptor(process.stdout, "rows")],
];

// One frame interval is ~33ms (TUI.#MIN_RENDER_INTERVAL_MS); two frames of
// headroom keeps the scheduler-driven paint deterministic without slowing the
// suite materially.
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
	/** Raw bytes the TUI wrote to stdout, in order. */
	readonly writes: string[];
	/** Signals the terminal requested from the host process, in order. */
	readonly signals: Array<{ pid: number; signal: string | number | undefined }>;
	/** Wait for the render scheduler to flush any pending paint. */
	settle(): Promise<void>;
	/** Simulate an OS resize (SIGWINCH / ConPTY): refresh stdout dims, fire `resize`. */
	osResize(columns: number, rows: number): Promise<void>;
	/** Feed a complete DEC 2048 in-band resize report (`CSI 48 ; rows ; cols ; yPx ; xPx t`). */
	inBand(rows: number, columns: number, yPixels?: number, xPixels?: number): Promise<void>;
	/** Feed raw byte chunks through the real stdin pipeline (StdinBuffer reassembly included). */
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
): ProcessTerminalRenderHarness {
	// This harness exercises the real ProcessTerminal I/O pipeline, so it opts
	// out of the test-default headless suppression and restores the prior value
	// on dispose.
	const previousHeadless = setTerminalHeadless(false);
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: initialColumns, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: initialRows, configurable: true });

	const writes: string[] = [];
	const signals: Array<{ pid: number; signal: string | number | undefined }> = [];
	const spies = [
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			signals.push({ pid, signal });
			return true;
		}),
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}),
	];

	// Force non-ConPTY behavior so kitty-flag and write-chunking assertions are
	// hermetic: the ambient WSL env (WSL_DISTRO_NAME / WSL_INTEROP) must not
	// change what the suite observes. See ProcessTerminalOptions.
	const terminal = new ProcessTerminal({ conpty: false });
	const tui = new TUI(terminal);
	const probe = new WidthProbe();
	tui.addChild(probe);
	try {
		tui.start();
	} catch (err) {
		// A start() regression must not poison the worker with headless=false.
		setTerminalHeadless(previousHeadless);
		throw err;
	}

	const settle = () => Bun.sleep(SETTLE_MS);

	return {
		terminal,
		tui,
		probe,
		writes,
		signals,
		settle,
		async osResize(columns, rows) {
			Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
			process.stdout.emit("resize");
			await settle();
		},
		async inBand(rows, columns, yPixels = 0, xPixels = 0) {
			process.stdin.emit("data", `\x1b[48;${rows};${columns};${yPixels};${xPixels}t`);
			await settle();
		},
		async feed(...chunks) {
			for (const chunk of chunks) process.stdin.emit("data", chunk);
			await settle();
		},
		async endInput() {
			process.stdin.emit("end");
			await settle();
		},
		async failOutput() {
			process.stdout.emit("error", new Error("terminal revoked"));
			await settle();
		},
		dispose() {
			tui.stop();
			setTerminalHeadless(previousHeadless);
			for (const spy of spies) spy.mockRestore();
			for (const [target, key, descriptor] of PRISTINE) {
				// A piped test run has no own `isTTY`/`columns`/`rows` descriptor, so
				// the captured pristine value is `undefined`. Deleting the forced
				// property restores that absent state — skipping it would leak
				// `isTTY = true` and poison TTY-gated code (e.g. mermaid color auto-detect).
				if (descriptor) Object.defineProperty(target, key, descriptor);
				else Reflect.deleteProperty(target, key);
			}
		},
	};
}
