import { type ProcessDriverTest, startProcessDriver } from "@oh-my-pi/pi-tui/testing/process-driver";

export interface ActiveTerminalHarness {
	/** Chunks that took the running driver's ordered output path. */
	readonly routed: string[];
	/** Chunks written straight to `process.stdout.write`, bypassing the driver. */
	readonly direct: string[];
	/** Stop the driver, so no driver owns the terminal any more; drops its teardown escapes. */
	stop(): void;
	/** Stop the driver if still running and restore `process.stdout`. */
	dispose(): void;
}

/**
 * Start a real pi-tui process driver on in-memory streams, the way the
 * interactive UI owns the terminal (stdout reports a TTY), and record where
 * out-of-band writes land.
 * Stdout is captured with a plain property override, not a spy, so a caller's
 * `vi.restoreAllMocks()` running before `dispose()` cannot release writes to
 * the real terminal.
 */
export async function startActiveTerminal(): Promise<ActiveTerminalHarness> {
	const direct: string[] = [];
	const stdoutWrite = Object.getOwnPropertyDescriptor(process.stdout, "write");
	const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "write", {
		value: (chunk: string | Uint8Array): boolean => {
			direct.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		},
		configurable: true,
		writable: true,
	});
	const restoreStdout = (): void => {
		for (const [key, descriptor] of [
			["write", stdoutWrite],
			["isTTY", stdoutIsTty],
		] as const) {
			if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
			else Reflect.deleteProperty(process.stdout, key);
		}
	};

	let term: ProcessDriverTest;
	try {
		term = await startProcessDriver();
	} catch (err) {
		restoreStdout();
		throw err;
	}
	// Drop the start-up escapes so assertions see only what the test writes.
	term.output.length = 0;

	let running = true;
	const stop = (): void => {
		if (!running) return;
		running = false;
		// The driver releases the terminal and writes its restore bytes before its first await.
		void term.driver.stop();
		term.output.length = 0;
	};
	return {
		routed: term.output,
		direct,
		stop,
		dispose() {
			stop();
			restoreStdout();
		},
	};
}
