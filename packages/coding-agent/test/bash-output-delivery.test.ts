/**
 * The bash tool's consumer side of the output-delivery guarantee.
 *
 * The embedded shell fails a run whose output a consumer did not take
 * ("Command output was not all delivered: …") and deliberately KEEPS its
 * session: the shell itself is healthy, only this run's output was lost. Two
 * properties of the executor follow from that, and both are checked here
 * through the real `executeBash` consumer rather than through the native call
 * underneath it:
 *
 *  1. A delivery failure fails the run without discarding the persistent
 *     shell, so the variables, exported environment and functions the user set
 *     before it survive into the next call.
 *  2. Lost output outranks a cancel that arrives after it. One owner decides
 *     the outcome: a run whose output was already lost reports the delivery
 *     failure, not `cancelled`.
 *
 * The cancels below are driven from the output callback itself rather than
 * from a timer: the chunk is the event that orders "output was lost" before
 * "the user cancelled", so the race these tests pin needs no guessed delay.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeBash, releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

let cwd: string;
let sessionKey: string;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-delivery-"));
	sessionKey = `delivery-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	releaseShellSessions(sessionKey);
	removeSyncWithRetries(cwd);
});

/** A consumer that throws on its first chunk: the native run then loses output. */
function throwingConsumer(): (chunk: string) => void {
	return () => {
		throw new Error("consumer failed");
	};
}

it.skipIf(process.platform === "win32")(
	"keeps the session's variables, exports and functions after a delivery failure",
	async () => {
		const state = await executeBash(
			"PI_DELIVERY_VAR=kept; export PI_DELIVERY_EXPORT=exported; pi_delivery_fn() { printf fn; }",
			{ cwd, sessionKey, timeout: 10_000 },
		);
		expect(state.exitCode).toBe(0);

		await expect(
			executeBash("printf xyzw", { cwd, sessionKey, timeout: 10_000, onChunk: throwingConsumer() }),
		).rejects.toThrow("Command output was not all delivered");

		const after = await executeBash(
			'printf "%s|%s|%s" "$PI_DELIVERY_VAR" "$PI_DELIVERY_EXPORT" "$(type -t pi_delivery_fn)"',
			{ cwd, sessionKey, timeout: 10_000 },
		);
		expect(after.exitCode).toBe(0);
		expect(after.output.trim()).toBe("kept|exported|function");
	},
	30_000,
);

it.skipIf(process.platform === "win32")(
	"reports the lost output of a run that is cancelled after its consumer failed",
	async () => {
		const controller = new AbortController();
		// The first chunk both loses the output and triggers the cancel, so the
		// cancel is ordered strictly after the delivery failure it must not hide.
		const run = executeBash("printf loss; sleep 8", {
			cwd,
			sessionKey,
			timeout: 20_000,
			signal: controller.signal,
			onChunk: () => {
				queueMicrotask(() => controller.abort());
				throw new Error("consumer failed");
			},
		});
		await expect(run).rejects.toThrow("Command output was not all delivered");
	},
	30_000,
);

it.skipIf(process.platform === "win32")(
	"still reports a cancel that lost no output as a cancellation",
	async () => {
		const controller = new AbortController();
		const run = executeBash("printf go; sleep 8", {
			cwd,
			sessionKey,
			timeout: 20_000,
			signal: controller.signal,
			// Takes the chunk, so nothing is lost; the cancel is the only outcome.
			onChunk: () => queueMicrotask(() => controller.abort()),
		});
		const result = await run;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
	},
	30_000,
);

for (const [label, failure] of [
	["undefined", undefined],
	["null", null],
	["string", "consumer failed"],
	["Error", new Error("consumer failed")],
	["object without a string conversion", Object.create(null)],
] as const) {
	for (const delivery of ["throw", "reject"] as const) {
		it.skipIf(process.platform === "win32")(
			`reports lost output rather than a later cancel when the consumer ${delivery}s ${label}`,
			async () => {
				const controller = new AbortController();
				let callbacks = 0;
				const run = executeBash("printf first; sleep 0.2; printf UNDELIVERED; sleep 50", {
					cwd,
					sessionKey,
					timeout: 60_000,
					chunkThrottleMs: 0,
					signal: controller.signal,
					onChunk: () => {
						callbacks++;
						queueMicrotask(() => controller.abort());
						if (delivery === "throw") throw failure;
						const rejected = Promise.reject(failure);
						// The red control must expose cancellation, not an unrelated
						// unhandled rejection from the old consumer ignoring this promise.
						void rejected.catch(() => undefined);
						return rejected;
					},
				});
				await expect(run).rejects.toThrow("Command output was not all delivered");
				expect(callbacks).toBe(1);
			},
			10_000,
		);
	}
}

it.skipIf(process.platform === "win32")(
	"reports native-observed callback loss rather than a later cancel after a 30-second stall",
	async () => {
		const controller = new AbortController();
		const hold = new Int32Array(new SharedArrayBuffer(4));
		let callbacks = 0;
		let abortedAt = 0;
		const run = executeBash("printf first; sleep 0.2; printf UNDELIVERED; sleep 50", {
			cwd,
			sessionKey,
			timeout: 60_000,
			chunkThrottleMs: 0,
			signal: controller.signal,
			onChunk: () => {
				if (++callbacks !== 1) return;
				// Real elapsed time: native observes its own 30-second deadline
				// while JS is blocked. A JS timer or fake clock cannot prove that.
				Atomics.wait(hold, 0, 0, 32_000);
				queueMicrotask(() => {
					abortedAt = performance.now();
					controller.abort();
				});
			},
		});
		await expect(run).rejects.toThrow("Command output was not all delivered");
		await expect(run).rejects.toThrow("the output callback did not return for 30 s");
		expect(callbacks).toBe(1);
		expect(performance.now() - abortedAt).toBeLessThan(3_000);
	},
	40_000,
);

it.skipIf(process.platform === "win32")(
	"reports an unsettled delivery as lost output when cancelled after the observation window",
	async () => {
		const controller = new AbortController();
		let timer: Timer | undefined;
		let callbacks = 0;
		try {
			const run = executeBash("printf first; sleep 50", {
				cwd,
				sessionKey,
				timeout: 60_000,
				chunkThrottleMs: 0,
				signal: controller.signal,
				onChunk: () => {
					callbacks++;
					// The integration contract uses the native pump's real observation
					// window; advancing only JS timers would not exercise that clock.
					timer = setTimeout(() => controller.abort(), 32_000);
					return Promise.withResolvers<void>().promise;
				},
			});
			await expect(run).rejects.toThrow("Command output was not all delivered");
			expect(callbacks).toBe(1);
		} finally {
			clearTimeout(timer);
		}
	},
	40_000,
);

it.skipIf(process.platform === "win32")(
	"does not wait on an unfailed pending delivery when cancelled before its observation window",
	async () => {
		const controller = new AbortController();
		let abortedAt = 0;
		const result = await executeBash("printf first; sleep 50", {
			cwd,
			sessionKey,
			timeout: 60_000,
			chunkThrottleMs: 0,
			signal: controller.signal,
			onChunk: () => {
				queueMicrotask(() => {
					abortedAt = performance.now();
					controller.abort();
				});
				return Promise.withResolvers<void>().promise;
			},
		});
		expect(result.cancelled).toBe(true);
		expect(performance.now() - abortedAt).toBeLessThan(750);
	},
	10_000,
);

it.skipIf(process.platform === "win32")(
	"finishes successful asynchronous delivery before reporting command completion",
	async () => {
		let delivered = "";
		const result = await executeBash("printf complete", {
			cwd,
			sessionKey,
			timeout: 10_000,
			chunkThrottleMs: 0,
			onChunk: async chunk => {
				// Keep a real asynchronous delivery outstanding across native
				// completion; advancing JS timers does not complete the native run.
				await Bun.sleep(50);
				delivered += chunk;
			},
		});
		expect(result.cancelled).toBe(false);
		expect(delivered).toBe("complete");
	},
	10_000,
);
