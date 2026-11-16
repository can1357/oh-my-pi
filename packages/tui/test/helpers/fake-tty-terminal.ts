import { vi } from "bun:test";
import type { ProcessTerminal, ProcessTerminalOptions } from "@oh-my-pi/pi-tui/terminal";
import type { RenderScheduler, RenderTimer } from "@oh-my-pi/pi-tui/tui";
import { fakeProcessTty } from "./process-tty";

/**
 * Deterministic clock and timer source for a {@link ProcessTerminal}: the
 * engine's probe timeouts (keyboard fallback, tmux hello, XTSMGRAPHICS) fire
 * only when a test advances it.
 */
export class ManualClock implements RenderScheduler {
	#now = 0;
	#nextId = 0;
	readonly #timers = new Map<number, { at: number; run: () => void }>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		this.scheduleRender(callback, 0);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const id = this.#nextId++;
		this.#timers.set(id, { at: this.#now + Math.max(0, delayMs), run: callback });
		return {
			cancel: () => {
				this.#timers.delete(id);
			},
		};
	}

	/** Move the clock forward by `ms`, firing every timer that comes due on the way, in order. */
	advance(ms: number): void {
		const end = this.#now + ms;
		for (;;) {
			let nextId: number | undefined;
			let nextAt = Number.POSITIVE_INFINITY;
			for (const [id, timer] of this.#timers) {
				if (timer.at <= end && timer.at < nextAt) {
					nextId = id;
					nextAt = timer.at;
				}
			}
			if (nextId === undefined) break;
			const timer = this.#timers.get(nextId)!;
			this.#timers.delete(nextId);
			this.#now = Math.max(this.#now, timer.at);
			timer.run();
		}
		this.#now = end;
	}
}

export interface FakeTtyTerminal {
	/** Bound to a recording host; not started. */
	readonly terminal: ProcessTerminal;
	readonly clock: ManualClock;
	/** Input events the terminal delivered to its host, in order. */
	readonly received: string[];
	/** Strings written straight to `process.stdout`, bypassing the terminal engine. */
	readonly directWrites: string[];
	/** Everything the terminal engine wrote so far, decoded. */
	output(): string;
	/** Deliver `data` as one stdin read. */
	feed(data: string): void;
	/** Stop the terminal and restore the fakes and the headless default. */
	dispose(): void;
}

/**
 * A {@link ProcessTerminal} on a faked interactive TTY (see `fakeProcessTty`):
 * stdin reads are injected and the engine's output is recorded. Writes that
 * bypass the engine straight to `process.stdout` are recorded apart.
 * Subscribe to the terminal, then call `terminal.start()`.
 */
export function fakeTtyTerminal(options: ProcessTerminalOptions = { conpty: false }): FakeTtyTerminal {
	const tty = fakeProcessTty();
	const directWrites: string[] = [];
	const received: string[] = [];
	const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		directWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return true;
	});

	const clock = new ManualClock();
	const terminal = tty.terminal(options);
	terminal.bind(
		{
			input: data => {
				received.push(data);
			},
			paste: () => {},
			render: () => {},
			resize: () => {},
		},
		clock,
	);

	return {
		terminal,
		clock,
		received,
		directWrites,
		output: tty.output,
		feed: tty.type,
		dispose() {
			try {
				terminal.stop();
			} finally {
				stdoutWrite.mockRestore();
				tty.dispose();
			}
		},
	};
}
