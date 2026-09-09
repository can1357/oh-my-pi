import { describe, expect, it } from "bun:test";
import { safeSend } from "@oh-my-pi/pi-coding-agent/utils/ipc";

/**
 * Contract for issue #2997: `safeSend` wraps `Subprocess.send()` so neither a
 * synchronous throw ("cannot be used after the process has exited") nor an
 * asynchronous EPIPE rejection (pipe broke between exit being observed and the
 * next send) can escape and crash the session via the global `unhandledRejection`
 * handler. The dead worker is detected separately via `onExit`; the send itself
 * must be fire-and-forget-safe.
 */
describe("safeSend", () => {
	it("calls send with the message on the happy path", () => {
		const sent: unknown[] = [];
		const proc = { send: (m: unknown) => sent.push(m) };
		safeSend(proc, { type: "ping" }, "test");
		expect(sent).toEqual([{ type: "ping" }]);
	});

	it("swallows a synchronous throw without rethrowing", () => {
		const proc = {
			send: () => {
				throw new Error("Subprocess.send() cannot be used after the process has exited.");
			},
		};
		expect(() => safeSend(proc, {}, "test")).not.toThrow();
	});

	it("neutralizes a rejected thenable returned by send so it cannot become an unhandled rejection", async () => {
		const epipe = Object.assign(new Error("EPIPE: broken pipe, send"), { code: "EPIPE", syscall: "send" });
		const proc = { send: () => Promise.reject(epipe) };
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			safeSend(proc, {}, "test");
			// Drain the microtask queue deterministically (two microtask ticks:
			// one for the promise rejection, one for the .then(noop) handler).
			await Promise.resolve();
			await Promise.resolve();
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("neutralizes a resolved thenable without affecting the happy path", async () => {
		const proc = { send: () => Promise.resolve(undefined) };
		expect(() => safeSend(proc, {}, "test")).not.toThrow();
		// Drain the microtask queue so a stray rejection would surface.
		await Promise.resolve();
		await Promise.resolve();
	});
});
