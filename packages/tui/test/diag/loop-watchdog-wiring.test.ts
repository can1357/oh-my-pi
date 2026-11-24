import { afterEach, describe, expect, it, vi } from "bun:test";
import { createSurface, startHost } from "@oh-my-pi/pi-tui";
import type { InputEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { LoopWatchdog } from "@oh-my-pi/pi-tui/diag/loop-watchdog";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

/**
 * Contract: the user-visible loop-blocked diagnostic depends on `startHost`
 * arming the watchdog and `host.stop()` disarming it, and the input decoder
 * depends on the host handing it the watchdog's stall probe. The unit tests
 * exercise `LoopWatchdog` in isolation, so these guard the wiring itself.
 *
 * Spies the prototype (never `mock.module`, which leaks across files) so the
 * real watchdog still runs; its timer handle is `unref`'d and disarmed on stop.
 */

type Listener = (...args: never[]) => void;

class Emitter {
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

class Stdin extends Emitter {
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

class Stdout extends Emitter {
	columns = 40;
	rows = 10;
}

/** A terminal-rendered host on in-memory streams; the startup probes go unanswered and time out. */
async function startTestHost() {
	const stdin = new Stdin();
	const surface = createSurface(() => ({}));
	const host = await startHost({
		surface,
		theme: () => loadThemeSync("dark"),
		native: false,
		driver: {
			env: {},
			platform: "darwin",
			conpty: false,
			tmux: () => null,
			probeTimeoutMs: 1,
			sink: { write: () => {}, flush: () => Promise.resolve() },
			stdin,
			stdout: new Stdout(),
			events: new Emitter(),
		},
	});
	return {
		host,
		feed: (data: string) => stdin.emit("data", Buffer.from(data)),
		async stop() {
			await host.stop();
			surface.dispose();
		},
	};
}

describe("startHost loop-watchdog wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("arms the watchdog on start and disarms it on stop", async () => {
		const startSpy = vi.spyOn(LoopWatchdog.prototype, "start");
		const stopSpy = vi.spyOn(LoopWatchdog.prototype, "stop");
		const h = await startTestHost();
		try {
			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(stopSpy).not.toHaveBeenCalled();
		} finally {
			await h.stop();
		}
		expect(stopSpy).toHaveBeenCalledTimes(1);
	});

	it("hands the input decoder a stall probe backed by the watchdog", async () => {
		// An unmarked multi-line burst is one paste on a responsive loop, but
		// batched typing during a stall: without the probe every Enter typed into
		// a stall would be swallowed into a paste.
		const stalled = vi.spyOn(LoopWatchdog.prototype, "isStalled").mockReturnValue(true);
		const h = await startTestHost();
		const received: InputEvent[] = [];
		h.host.driver.onInput(event => received.push(event));
		try {
			h.feed("a\rb");
			// Keys behind an Enter arrive on the turn after it.
			await new Promise(resolve => setTimeout(resolve, 1));
			expect(received.map(event => (event.type === "key" ? event.key.id : event.type))).toEqual(["a", "enter", "b"]);

			stalled.mockReturnValue(false);
			received.length = 0;
			h.feed("1. a\r2. b\r3. c");
			expect(received.map(event => event.type)).toEqual(["paste"]);
		} finally {
			await h.stop();
		}
	});
});
