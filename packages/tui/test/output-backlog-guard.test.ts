import { describe, expect, it, vi } from "bun:test";
import { OutputBacklogGuard, ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// Regression test for https://github.com/can1357/oh-my-pi/issues/6854
//
// A stalled-but-alive PTY consumer never throws, so ProcessTerminal.#safeWrite
// has no error to catch: process.stdout.write() just returns false and queues
// the bytes. OutputBacklogGuard turns that never-draining backlog into a bounded
// disconnect signal. These tests pin the accounting contract #safeWrite relies
// on to decide when to declare the terminal disconnected.
describe("issue #6854: OutputBacklogGuard bounds a stalled stdout", () => {
	it("never trips while the consumer keeps up (writes accepted)", () => {
		const guard = new OutputBacklogGuard(1024);
		for (let i = 0; i < 10_000; i++) {
			expect(guard.record(true, 4096)).toBe(false);
		}
		expect(guard.tracking).toBe(false);
	});

	it("starts tracking on the first refused write and accumulates the backlog", () => {
		const guard = new OutputBacklogGuard(1024);
		// First refusal: backpressure begins.
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.tracking).toBe(true);
		// Bytes keep accumulating up to — but not past — the cap.
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.record(false, 256)).toBe(false); // total 1024 == cap, not over
		// One more byte crosses the cap and signals disconnect.
		expect(guard.record(false, 1)).toBe(true);
	});

	it("keeps counting bytes while tracking even when a later write is accepted", () => {
		const guard = new OutputBacklogGuard(1024);
		// Backpressure began: the buffer is not empty until a drain resets us,
		// so a transient write() === true still adds to the pending backlog.
		expect(guard.record(false, 512)).toBe(false);
		expect(guard.tracking).toBe(true);
		expect(guard.record(true, 512)).toBe(false); // total 1024
		expect(guard.record(true, 1)).toBe(true); // crosses cap
	});

	it("clears the backlog on reset (drain) and starts fresh afterward", () => {
		const guard = new OutputBacklogGuard(1024);
		expect(guard.record(false, 1025)).toBe(true);
		guard.reset();
		expect(guard.tracking).toBe(false);
		// After a drain, accepted writes are healthy again and never trip.
		expect(guard.record(true, 100_000)).toBe(false);
		expect(guard.tracking).toBe(false);
		// A fresh stall restarts accounting from zero.
		expect(guard.record(false, 1024)).toBe(false);
		expect(guard.record(false, 1)).toBe(true);
	});
});

it("stops writing when the real terminal path crosses the backlog cap", () => {
	const previousHeadless = setTerminalHeadless(false);
	const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	let writes = 0;
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => {
		writes++;
		return false;
	});

	try {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		// conpty: false keeps the single-write path so the 64 MiB cap trips at the
		// 65th frame; ConPTY would chunk each frame and skew the write count.
		const terminal = new ProcessTerminal({ conpty: false });
		const frame = "x".repeat(1024 * 1024);
		for (let i = 0; i < 70; i++) terminal.write(frame);

		// The 65th MiB crosses the 64 MiB cap and marks the terminal dead;
		// later frames must not reach stdout.
		expect(writes).toBe(65);
		process.stdout.emit("drain");
	} finally {
		stdout.mockRestore();
		if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(previousHeadless);
	}
});
