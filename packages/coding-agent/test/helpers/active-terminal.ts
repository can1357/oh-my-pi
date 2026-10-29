import { vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// Pristine descriptors, captured once at module load, so repeated harnesses
// always restore the real process state.
const PRISTINE: Array<[NodeJS.Process["stdin"] | NodeJS.Process["stdout"], string, PropertyDescriptor | undefined]> = [
	[process.stdin, "isTTY", Object.getOwnPropertyDescriptor(process.stdin, "isTTY")],
	[process.stdout, "isTTY", Object.getOwnPropertyDescriptor(process.stdout, "isTTY")],
	[process.stdin, "setRawMode", Object.getOwnPropertyDescriptor(process.stdin, "setRawMode")],
];

export interface ActiveTerminalHarness {
	/** Chunks handed to the started terminal's `write`, i.e. its ordered output path. */
	readonly routed: string[];
	/** Chunks written straight to `process.stdout.write`, bypassing the terminal. */
	readonly direct: string[];
	/** Stop the terminal, so no terminal owns stdout any more; drops its teardown escapes. */
	stop(): void;
	/** Stop the terminal if still running and restore every spy and faked process property. */
	dispose(): void;
}

/**
 * Start a real `ProcessTerminal` on a faked TTY, the way the interactive TUI
 * owns stdout, and record where out-of-band writes land. The output pump stays
 * off under `bun test`, so this proves routing, not the pump's chunking.
 * Stdout is captured with a plain property override, not a spy, so a caller's
 * `vi.restoreAllMocks()` running before `dispose()` cannot release the
 * terminal's teardown escapes to the real terminal.
 */
export function startActiveTerminal(): ActiveTerminalHarness {
	// The real start() path only runs, and registers the terminal, when not headless.
	const previousHeadless = setTerminalHeadless(false);
	const routed: string[] = [];
	const direct: string[] = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	const spies: Array<{ mockRestore(): void }> = [
		vi.spyOn(process, "kill").mockReturnValue(true),
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
	];
	const stdoutWrite = Object.getOwnPropertyDescriptor(process.stdout, "write");
	Object.defineProperty(process.stdout, "write", {
		value: (chunk: string | Uint8Array): boolean => {
			direct.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		},
		configurable: true,
		writable: true,
	});
	const restoreProcess = (): void => {
		setTerminalHeadless(previousHeadless);
		for (const spy of spies) spy.mockRestore();
		const restored: Array<[object, string, PropertyDescriptor | undefined]> = [
			...PRISTINE,
			[process.stdout, "write", stdoutWrite],
		];
		for (const [target, key, descriptor] of restored) {
			if (descriptor) Object.defineProperty(target, key, descriptor);
			else Reflect.deleteProperty(target, key);
		}
	};

	// conpty: false keeps kitty flags at >5u regardless of ambient WSL env.
	const terminal = new ProcessTerminal({ conpty: false });
	try {
		terminal.start(
			() => {},
			() => {},
		);
	} catch (err) {
		// A start() regression must not leave later tests with headless off and a faked TTY.
		restoreProcess();
		throw err;
	}
	spies.push(
		vi.spyOn(terminal, "write").mockImplementation(data => {
			routed.push(data);
		}),
	);
	// Drop the start-up escapes so assertions see only what the test writes.
	direct.length = 0;

	let running = true;
	const stop = (): void => {
		if (!running) return;
		running = false;
		terminal.stop();
		direct.length = 0;
	};
	return {
		routed,
		direct,
		stop,
		dispose() {
			// Stop while stdout is still captured, so teardown escapes never reach the real terminal.
			stop();
			restoreProcess();
		},
	};
}
