import { describe, expect, it } from "bun:test";
import { AbortError, exec, spawn } from "@oh-my-pi/pi-utils/ptree";

describe("ptree signal abort handling", () => {
	it("does not trigger unhandledRejection when spawned with a pre-aborted signal", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const signal = AbortSignal.abort(new Error("pre-aborted"));
			using child = spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { signal });
			await child.nothrow().text();
			await child.proc.exited;

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("does not trigger unhandledRejection when exec is called with an aborted signal and allowAbort", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const signal = AbortSignal.abort(new Error("pre-aborted"));
			const result = await exec(["bun", "-e", "setInterval(() => {}, 1000)"], {
				signal,
				allowAbort: true,
			});

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(result.ok).toBe(false);
			expect(result.exitError).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("does not trigger unhandledRejection when signal aborts mid-execution", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const controller = new AbortController();
			using child = spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
				signal: controller.signal,
			});
			controller.abort(new Error("aborted mid-run"));
			await child.nothrow().text();
			await child.proc.exited;

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
