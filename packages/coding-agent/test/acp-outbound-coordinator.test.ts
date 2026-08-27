import { describe, expect, it } from "bun:test";
import { AcpOutboundCoordinator } from "../src/modes/acp/view/outbound-coordinator";

/** A fake writer that records the order sends actually reached the wire. */
function writer(): { log: string[]; send: (label: string) => () => Promise<void> } {
	const log: string[] = [];
	return {
		log,
		send: label => async () => {
			await Promise.resolve();
			log.push(label);
		},
	};
}

function coordinator(options: { onPoison?: (error: unknown) => void; startBarrierTimeoutMs?: number } = {}): {
	instance: AcpOutboundCoordinator;
	poisons: unknown[];
} {
	const poisons: unknown[] = [];
	const instance = new AcpOutboundCoordinator({
		onPoison: error => {
			poisons.push(error);
			options.onPoison?.(error);
		},
		startBarrierTimeoutMs: options.startBarrierTimeoutMs ?? 50,
	});
	return { instance, poisons };
}

describe("ACP outbound coordinator — FIFO batches", () => {
	it("drains whole batches in registration order", async () => {
		const { instance } = coordinator();
		const { log, send } = writer();

		const first = instance.enqueue(async () => {
			await send("a1")();
			await send("a2")();
		});
		const second = instance.enqueue(send("b1"));
		await Promise.all([first, second]);

		// A multi-frame transition stays contiguous relative to the next event.
		expect(log).toEqual(["a1", "a2", "b1"]);
	});

	it("keeps a multi-frame batch contiguous under a slow client", async () => {
		const { instance } = coordinator();
		const log: string[] = [];
		const slow = async (label: string) => {
			await Bun.sleep(5);
			log.push(label);
		};

		const transition = instance.enqueue(async () => {
			await slow("exit");
			await slow("content");
		});
		const later = instance.enqueue(() => slow("next-event"));
		await Promise.all([transition, later]);

		expect(log).toEqual(["exit", "content", "next-event"]);
	});
});

describe("ACP outbound coordinator — reserved permission slot", () => {
	it("orders started -> permission request -> unrelated update before the user answers", async () => {
		const { instance } = coordinator({ startBarrierTimeoutMs: 5_000 });
		const { log, send } = writer();
		const answer = Promise.withResolvers<string>();

		// The permission request arrives first: `processAgentEvent` fan-out is async,
		// so the start frame for this call has not been written yet.
		const box = instance.reservePermission("call-1", async () => {
			log.push("permission-request-write");
			return await answer.promise;
		});
		// An unrelated later update must not overtake the reservation.
		const unrelated = instance.enqueue(send("unrelated-update"));
		// The matching start batch may pass the reservation as its prerequisite.
		const start = instance.enqueue(send("started"), { toolCallId: "call-1", isStart: true });

		await start;
		await unrelated;

		expect(log).toEqual(["started", "permission-request-write", "unrelated-update"]);

		// Cleanup: never leak a pending request out of the suite.
		answer.resolve("allow_once");
		await expect(box.response).resolves.toBe("allow_once");
	});

	it("does not head-of-line-block later writes behind an unanswered dialog", async () => {
		const { instance } = coordinator({ startBarrierTimeoutMs: 5_000 });
		const { log, send } = writer();
		const answer = Promise.withResolvers<string>();

		instance.enqueue(send("started"), { toolCallId: "call-1", isStart: true });
		const box = instance.reservePermission("call-1", async () => {
			log.push("permission-request-write");
			return await answer.promise;
		});
		await instance.enqueue(send("after-dialog"));

		// `after-dialog` landed while the dialog is still open.
		expect(log).toEqual(["started", "permission-request-write", "after-dialog"]);

		answer.resolve("allow_once");
		await box.response;
	});

	it("serves a permission request that arrives after its start already shipped", async () => {
		const { instance } = coordinator({ startBarrierTimeoutMs: 5_000 });
		const { log, send } = writer();

		await instance.enqueue(send("started"), { toolCallId: "call-1", isStart: true });
		const box = instance.reservePermission("call-1", async () => {
			log.push("permission-request-write");
			return "allow_once";
		});
		await expect(box.response).resolves.toBe("allow_once");
		expect(log).toEqual(["started", "permission-request-write"]);
	});

	it("proceeds on the bounded barrier rather than fencing a call that never announces", async () => {
		const { instance } = coordinator({ startBarrierTimeoutMs: 10 });
		const { log } = writer();

		const box = instance.reservePermission("hidden-call", async () => {
			log.push("permission-request-write");
			return "allow_once";
		});
		await expect(box.response).resolves.toBe("allow_once");
		expect(log).toEqual(["permission-request-write"]);
	});

	it("rejects a pending reservation on abort without poisoning the queue", async () => {
		const { instance, poisons } = coordinator({ startBarrierTimeoutMs: 5_000 });
		const { log, send } = writer();
		const box = instance.reservePermission("call-1", async () => {
			log.push("must-not-run");
			return "allow_once";
		});

		instance.rejectPendingPermissions(new Error("aborted"));
		await expect(box.response).rejects.toThrow("aborted");

		await instance.enqueue(send("still-open"));
		expect(log).toEqual(["still-open"]);
		expect(poisons).toEqual([]);
		expect(instance.poisoned).toBe(false);
	});
});

describe("ACP outbound coordinator — poisoning", () => {
	it("poisons on the first failed send and attempts no later write", async () => {
		const { instance, poisons } = coordinator();
		const { log, send } = writer();
		const failure = new Error("connection closed");

		// Both handlers are attached before the queue drains: the poison rejects the
		// second batch immediately, and an unobserved rejection would fail the suite
		// for the wrong reason.
		const first = instance
			.enqueue(async () => {
				log.push("attempted");
				throw failure;
			})
			.then(
				() => "resolved",
				(error: unknown) => error,
			);
		const second = instance.enqueue(send("must-not-attempt")).then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(await first).toBe(failure);
		expect(await second).toBe(failure);
		expect(log).toEqual(["attempted"]);
		expect(poisons).toEqual([failure]);
	});

	it("fails a later enqueue without a wire attempt and notifies the abort path once", async () => {
		const { instance, poisons } = coordinator();
		const { log, send } = writer();
		await expect(
			instance.enqueue(() => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		await expect(instance.enqueue(send("never"))).rejects.toThrow("boom");
		instance.poison(new Error("second"));
		expect(log).toEqual([]);
		expect(poisons).toHaveLength(1);
		expect(instance.poisoned).toBe(true);
	});

	it("rejects a reserved permission slot when the queue poisons", async () => {
		const { instance } = coordinator({ startBarrierTimeoutMs: 5_000 });
		const box = instance.reservePermission("call-1", async () => "allow_once");
		instance.poison(new Error("connection closed"));
		await expect(box.response).rejects.toThrow("connection closed");
	});
});

describe("ACP outbound coordinator — idle() as a completion primitive", () => {
	it("resolves after a writer that awaits a real timer", async () => {
		// The regression: `idle()` used to spin on `while (#draining) await
		// Promise.resolve()`. An unbroken microtask chain starves the macrotask queue,
		// so `Bun.sleep(20)` inside the writer never resumed and this test hung the
		// whole process instead of failing.
		const { instance } = coordinator();
		const log: string[] = [];
		const write = instance.enqueue(async () => {
			await Bun.sleep(20);
			log.push("slow-write");
		});

		await instance.idle();

		expect(log).toEqual(["slow-write"]);
		await write;
	});

	it("resolves after a writer that awaits an externally resolved promise", async () => {
		const { instance } = coordinator();
		const gate = Promise.withResolvers<void>();
		const log: string[] = [];
		const write = instance.enqueue(async () => {
			await gate.promise;
			log.push("released-write");
		});

		const idle = instance.idle().then(() => "idle");
		// Nothing may resolve while the writer is parked.
		expect(log).toEqual([]);
		gate.resolve();
		expect(await idle).toBe("idle");
		expect(log).toEqual(["released-write"]);
		await write;
	});

	it("leaves a racing cancellation timeout able to fire", async () => {
		// `#runCancelCleanup` races `idle()` against a bounded timer. A microtask spin
		// starved that timer too, so a stuck writer produced a hang rather than the
		// bounded cleanup failure the ACP agent depends on.
		const { instance } = coordinator();
		const stuck = Promise.withResolvers<void>();
		const write = instance.enqueue(() => stuck.promise).catch(() => undefined);
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<string>(resolve => {
			timer = setTimeout(() => resolve("timeout-fired"), 25);
		});

		expect(await Promise.race([instance.idle().then(() => "idle"), timeout])).toBe("timeout-fired");

		if (timer) clearTimeout(timer);
		stuck.resolve();
		await write;
	});

	it("covers work enqueued while a drain is already active", async () => {
		const { instance } = coordinator();
		const log: string[] = [];
		const first = instance.enqueue(async () => {
			await Bun.sleep(10);
			log.push("first");
			// Registered mid-drain: the waiter must still wait for it.
			void instance.enqueue(async () => {
				await Bun.sleep(10);
				log.push("second");
			});
		});

		await instance.idle();

		expect(log).toEqual(["first", "second"]);
		await first;
	});

	it("resolves immediately when only a barrier-blocked permission slot remains", async () => {
		// Cancellation cleanup awaits `idle()`; a slot parked on its start barrier is
		// blocked on an event outside the queue, so counting it as runnable work would
		// make cleanup wait out the whole barrier.
		const { instance } = coordinator({ startBarrierTimeoutMs: 5_000 });
		const box = instance.reservePermission("never-announced", async () => "allow_once");
		await instance.idle();
		instance.rejectPendingPermissions(new Error("cancelled"));
		await expect(box.response).rejects.toThrow("cancelled");
	});
});

describe("ACP outbound coordinator — call release ordering", () => {
	it("does not leak a start marker when settlement is reduced before the slow start write lands", async () => {
		const { instance } = coordinator({ startBarrierTimeoutMs: 5_000 });
		const log: string[] = [];
		const startGate = Promise.withResolvers<void>();

		// The ACP agent reduces `started` and `settled` synchronously, so both batches
		// can be registered before the first one's send resolves.
		const start = instance.enqueue(
			async () => {
				await startGate.promise;
				log.push("start-write");
			},
			{ toolCallId: "call-1", isStart: true },
		);
		const settlement = instance.enqueue(
			async () => {
				log.push("settlement-write");
			},
			{ toolCallId: "call-1", isFinal: true },
		);

		startGate.resolve();
		await Promise.all([start, settlement]);
		await instance.idle();
		expect(log).toEqual(["start-write", "settlement-write"]);

		// The proof that release happened *after* the delivered settlement rather than
		// before the delivered start: a later permission request for the same id waits
		// on its barrier again instead of finding a stale delivered marker.
		const box = instance.reservePermission("call-1", async () => {
			log.push("permission-request-write");
			return "allow_once";
		});
		await instance.idle();
		expect(log).toEqual(["start-write", "settlement-write"]);

		instance.rejectPendingPermissions(new Error("no longer running"));
		await expect(box.response).rejects.toThrow("no longer running");
	});

	it("releases a frameless settlement in FIFO position", async () => {
		const { instance } = coordinator({ startBarrierTimeoutMs: 5_000 });
		const log: string[] = [];
		const startGate = Promise.withResolvers<void>();
		const start = instance.enqueue(
			async () => {
				await startGate.promise;
				log.push("start-write");
			},
			{ toolCallId: "call-2", isStart: true },
		);
		// A settlement whose reducer step produced no frames still has to release.
		instance.releaseCall("call-2");
		startGate.resolve();
		await start;
		await instance.idle();

		const box = instance.reservePermission("call-2", async () => {
			log.push("permission-request-write");
			return "allow_once";
		});
		await instance.idle();
		expect(log).toEqual(["start-write"]);
		instance.rejectPendingPermissions(new Error("no longer running"));
		await expect(box.response).rejects.toThrow("no longer running");
	});
});
