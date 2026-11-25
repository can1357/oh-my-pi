/**
 * The real process terminal driver over in-memory streams: raw mode, probes,
 * the frame writer and the process-wide terminal claim all run for real, with
 * the terminal's answers scripted by the test.
 *
 * @example
 * ```ignore
 * const term = await startProcessDriver({ env: { KITTY_WINDOW_ID: "1" } });
 * term.output.length = 0;
 * writeTerminalSequence("\x1b]52;c;cHJvYmU=\x07");
 * expect(term.output).toEqual(["\x1b]52;c;cHJvYmU=\x07"]);
 * await term.driver.stop();
 * ```
 */
import { createTerminalDriver, type ProcessTerminalDriver, type TerminalDriverOptions } from "../driver";
import { Emitter, MemoryStdin } from "./memory-terminal";

class MemoryStdout extends Emitter {
	columns = 80;
	rows = 24;
}

/** Configuration of {@link startProcessDriver}: driver options minus the streams it fakes. */
export type ProcessDriverTestOptions = Omit<TerminalDriverOptions, "sink" | "stdin" | "stdout" | "events">;

export interface ProcessDriverTest {
	readonly driver: ProcessTerminalDriver;
	/** Every chunk the driver wrote, in order (clear it to drop the startup bytes). */
	readonly output: string[];
	/** Whether stdin is in raw mode. */
	readonly raw: () => boolean;
	/** Deliver terminal bytes to stdin. */
	feed(data: string): void;
}

/**
 * Start a {@link ProcessTerminalDriver} on in-memory streams, answering its
 * startup probes with a bare DA1 each (preceded by `replies`, which may be
 * computed from the probes written so far) and its cursor query with the home
 * position. Defaults: empty env, darwin, no ConPTY, no tmux.
 */
export async function startProcessDriver(
	options: ProcessDriverTestOptions = {},
	replies: string | ((probes: string) => string) = "",
): Promise<ProcessDriverTest> {
	const stdin = new MemoryStdin();
	const output: string[] = [];
	const driver = createTerminalDriver({
		env: {},
		platform: "darwin",
		conpty: false,
		tmux: () => null,
		...options,
		sink: { write: data => void output.push(data), flush: () => Promise.resolve() },
		stdin,
		stdout: new MemoryStdout(),
		events: new Emitter(),
	});
	const feed = (data: string): void => stdin.emit("data", Buffer.from(data));
	const started = driver.start();
	const answers = typeof replies === "string" ? replies : replies(output.join(""));
	feed(`${answers}\x1b[?62c\x1b[?62c\x1b[?62c`);
	for (let turn = 0; !output.some(chunk => chunk.includes("\x1b[6n")); turn++) {
		if (turn > 1000) throw new Error("the driver never queried the cursor position");
		await Promise.resolve();
	}
	feed("\x1b[1;1R");
	await started;
	return { driver, output, raw: () => stdin.isRaw, feed };
}
