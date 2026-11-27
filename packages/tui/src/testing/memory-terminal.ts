/**
 * Driver options for a terminal that lives in memory and answers the
 * driver's startup queries itself: every DA1 sentinel gets a bare DA1 reply
 * and every cursor query the home position. Hosts started on it render for
 * real (headless renders, app-level tests); the bytes they write are kept.
 *
 * @example
 * ```ignore
 * const term = memoryTerminal({ columns: 80, rows: 24 });
 * const host = await startHost({ surface, theme, native: false, driver: term.options });
 * term.feed("hi");
 * ```
 */
import type { TerminalDriverOptions } from "../driver";

type Listener = (...args: never[]) => void;

/** Minimal event emitter the stream doubles share. */
export class Emitter {
	readonly #listeners = new Map<string, Set<Listener>>();
	on(event: string, listener: Listener): this {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}
	off(event: string, listener: Listener): this {
		this.#listeners.get(event)?.delete(listener);
		return this;
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.#listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
	}
}

/** A TTY stdin double: raw-mode flag only, never reads. */
export class MemoryStdin extends Emitter {
	readonly isTTY = true;
	isRaw = false;
	setRawMode(mode: boolean): this {
		this.isRaw = mode;
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
}

class MemoryStdout extends Emitter {
	readonly isTTY = true;
	constructor(
		public columns: number,
		public rows: number,
	) {
		super();
	}
}

const DA1_QUERY = "\x1b[c";
const CURSOR_QUERY = "\x1b[6n";

/** How {@link memoryTerminal} starts. */
export interface MemoryTerminalInit {
	readonly columns: number;
	readonly rows: number;
	/** The environment the driver detects the terminal from (default: empty). */
	readonly env?: Record<string, string | undefined>;
	/** Extra driver options (resize policy, …). */
	readonly driver?: Omit<TerminalDriverOptions, "sink" | "stdin" | "stdout" | "events" | "env">;
	/** Also receives every write (a terminal emulator under test). */
	readonly onWrite?: (data: string) => void;
}

export interface MemoryTerminal {
	/** Pass to `createTerminalDriver` / `startHost({ driver })`. */
	readonly options: TerminalDriverOptions;
	/** Every chunk written, in order. */
	readonly output: string[];
	/** Bytes written so far. */
	readonly bytes: () => number;
	/** Deliver terminal input (keys, pastes, replies). */
	feed(data: string): void;
	/** Change the size and report it like a SIGWINCH. */
	resize(columns: number, rows: number): void;
}

export function memoryTerminal(init: MemoryTerminalInit): MemoryTerminal {
	const stdin = new MemoryStdin();
	const stdout = new MemoryStdout(init.columns, init.rows);
	const output: string[] = [];
	let bytes = 0;
	const feed = (data: string): void => stdin.emit("data", Buffer.from(data));
	const options: TerminalDriverOptions = {
		platform: "darwin",
		conpty: false,
		tmux: () => null,
		...init.driver,
		env: init.env ?? {},
		sink: {
			write: data => {
				output.push(data);
				bytes += Buffer.byteLength(data);
				init.onWrite?.(data);
				// Answer after the write returns, as a terminal would.
				let replies = "";
				for (let at = data.indexOf(DA1_QUERY); at !== -1; at = data.indexOf(DA1_QUERY, at + 1))
					replies += "\x1b[?62c";
				if (data.includes(CURSOR_QUERY)) replies += "\x1b[1;1R";
				if (replies) queueMicrotask(() => feed(replies));
			},
			flush: () => Promise.resolve(),
		},
		stdin,
		stdout,
		events: new Emitter(),
	};
	return {
		options,
		output,
		bytes: () => bytes,
		feed,
		resize(columns, rows) {
			stdout.columns = columns;
			stdout.rows = rows;
			stdout.emit("resize");
		},
	};
}
