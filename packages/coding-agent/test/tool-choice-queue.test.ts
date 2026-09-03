import { describe, expect, it } from "bun:test";
import type { RejectInfo, ResolveInfo } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";

const forced = { type: "tool", name: "write" } as const;
const forcedRead = { type: "tool", name: "read" } as const;

describe("ToolChoiceQueue", () => {
	describe("resolve callback", () => {
		it("fires onResolved with the served choice", () => {
			const q = new ToolChoiceQueue();
			const resolved: ResolveInfo[] = [];
			q.pushOnce(forced, {
				label: "a",
				onResolved: info => resolved.push(info),
			});
			q.nextToolChoice();
			q.resolve();
			expect(resolved).toEqual([{ choice: forced }]);
		});
	});

	describe("reject callback", () => {
		it("onRejected returning 'requeue' replays the lost yield", () => {
			const q = new ToolChoiceQueue();
			const rejected: RejectInfo[] = [];
			q.pushSequence([forced, "none"], {
				label: "user-force",
				onRejected: info => {
					rejected.push(info);
					return "requeue";
				},
			});
			expect(q.nextToolChoice()).toEqual(forced);
			q.reject("aborted");
			// Callback received the right info
			expect(rejected).toEqual([{ choice: forced, reason: "aborted" }]);
			// Next turn: replayed yield, then original sequence continues
			expect(q.nextToolChoice()).toEqual(forced);
			q.resolve();
			expect(q.nextToolChoice()).toBe("none");
			q.resolve();
			expect(q.nextToolChoice()).toBeUndefined();
		});

		it("onRejected returning 'drop' discards the yield", () => {
			const q = new ToolChoiceQueue();
			q.pushOnce(forced, {
				label: "eager-todo",
				onRejected: () => "drop",
			});
			expect(q.nextToolChoice()).toEqual(forced);
			q.reject("aborted");
			expect(q.nextToolChoice()).toBeUndefined();
		});

		it("onRejected returning 'drop_sequence' discards its later yields", () => {
			const q = new ToolChoiceQueue();
			q.pushSequence([forced, "none"], {
				label: "user-force",
				onRejected: () => "drop_sequence",
			});
			q.pushOnce(forcedRead, { label: "later" });

			expect(q.nextToolChoice()).toEqual(forced);
			q.reject("unavailable");
			expect(q.nextToolChoice()).toEqual(forcedRead);
		});

		it("drop_sequence removes the origin after an unavailable replay", () => {
			const q = new ToolChoiceQueue();
			q.pushSequence([forced, "none"], {
				label: "user-force",
				onRejected: info => (info.reason === "unavailable" ? "drop_sequence" : "requeue"),
			});
			q.pushOnce(forcedRead, { label: "later" });

			expect(q.nextToolChoice()).toEqual(forced);
			q.reject("aborted");
			expect(q.nextToolChoice()).toEqual(forced);
			q.reject("unavailable");
			expect(q.nextToolChoice()).toEqual(forcedRead);
		});

		it("requeued directive preserves onRejected so it can re-requeue across aborts", () => {
			const q = new ToolChoiceQueue();
			let rejectCount = 0;
			q.pushOnce(forced, {
				label: "user-force",
				onRejected: () => {
					rejectCount++;
					return rejectCount < 3 ? "requeue" : "drop";
				},
			});
			// First abort → requeue (count 1)
			q.nextToolChoice();
			q.reject("aborted");
			expect(rejectCount).toBe(1);
			// Second abort → requeue again via preserved callback (count 2)
			q.nextToolChoice();
			q.reject("aborted");
			expect(rejectCount).toBe(2);
			// Third abort → callback returns "drop" (count 3), queue drained
			q.nextToolChoice();
			q.reject("aborted");
			expect(rejectCount).toBe(3);
			expect(q.nextToolChoice()).toBeUndefined();
		});
	});

	describe("removeByLabel", () => {
		it("removes targeted directives without affecting others", () => {
			const q = new ToolChoiceQueue();
			q.pushOnce(forced, { label: "eager-todo" });
			q.pushOnce(forcedRead, { label: "user-force" });
			q.removeByLabel("eager-todo");
			expect(q.inspect()).toEqual(["user-force"]);
			expect(q.nextToolChoice()).toEqual(forcedRead);
		});

		it("rejects in-flight if its label matches", () => {
			const q = new ToolChoiceQueue();
			const rejected: RejectInfo[] = [];
			q.pushOnce(forced, {
				label: "eager-todo",
				onRejected: info => {
					rejected.push(info);
					return "drop";
				},
			});
			q.nextToolChoice();
			q.removeByLabel("eager-todo");
			expect(rejected).toEqual([{ choice: forced, reason: "removed" }]);
			expect(q.hasInFlight).toBe(false);
		});
	});

	describe("clear", () => {
		it("empties queue and rejects in-flight", () => {
			const q = new ToolChoiceQueue();
			const rejected: RejectInfo[] = [];
			q.pushSequence([forced, "none"], {
				label: "seq",
				onRejected: info => {
					rejected.push(info);
					return "requeue"; // should still be dropped by clear
				},
			});
			q.nextToolChoice();
			q.clear();
			// onRejected fired with "cleared" reason
			expect(rejected).toEqual([{ choice: forced, reason: "cleared" }]);
			// Even though onRejected returned "requeue", clear empties everything
			expect(q.nextToolChoice()).toBeUndefined();
			expect(q.inspect()).toEqual([]);
		});
	});

	describe("consumeLastServedLabel", () => {
		it("returns label once then clears", () => {
			const q = new ToolChoiceQueue();
			q.pushOnce(forced, { label: "user-force" });
			q.nextToolChoice();
			q.resolve();
			expect(q.consumeLastServedLabel()).toBe("user-force");
			expect(q.consumeLastServedLabel()).toBeUndefined();
		});
	});

	describe("hasInFlight", () => {
		it("is false when queue is empty", () => {
			const q = new ToolChoiceQueue();
			expect(q.hasInFlight).toBe(false);
		});

		it("is true after nextToolChoice, false after resolve", () => {
			const q = new ToolChoiceQueue();
			q.pushOnce(forced, { label: "a" });
			q.nextToolChoice();
			expect(q.hasInFlight).toBe(true);
			q.resolve();
			expect(q.hasInFlight).toBe(false);
		});
	});
});

describe("onInvoked / peekInFlightInvoker", () => {
	it("exposes the in-flight directive's onInvoked handler via peekInFlightInvoker", async () => {
		const q = new ToolChoiceQueue();
		q.pushOnce(forced, {
			label: "pending",
			onInvoked: async input => ({ echoed: input }),
		});
		q.nextToolChoice();
		const invoker = q.peekInFlightInvoker();
		expect(invoker).toBeDefined();
		const result = await invoker!({ action: "apply", reason: "ok" });
		expect(result).toEqual({ echoed: { action: "apply", reason: "ok" } });
	});
	it("does not resolve an onInvoked directive until the requested tool runs", () => {
		const q = new ToolChoiceQueue();
		const rejected: RejectInfo[] = [];
		const resolved: ResolveInfo[] = [];
		q.pushOnce(forced, {
			label: "pending",
			onRejected: info => {
				rejected.push(info);
				return "requeue";
			},
			onResolved: info => resolved.push(info),
			onInvoked: async input => ({ echoed: input }),
		});
		q.nextToolChoice();
		q.resolve();
		expect(rejected).toEqual([{ choice: forced, reason: "not_invoked" }]);
		expect(resolved).toEqual([]);
		expect(q.nextToolChoice()).toEqual(forced);
	});

	it("resolves an onInvoked directive after the requested tool runs", async () => {
		const q = new ToolChoiceQueue();
		const resolved: ResolveInfo[] = [];
		q.pushOnce(forced, {
			label: "pending",
			onResolved: info => resolved.push(info),
			onInvoked: async input => ({ echoed: input }),
		});
		q.nextToolChoice();
		const invoker = q.peekInFlightInvoker();
		expect(invoker).toBeDefined();
		await invoker!({ action: "apply", reason: "ok" });
		q.resolve();
		expect(resolved).toEqual([{ choice: forced }]);
		expect(q.hasInFlight).toBe(false);
	});

	it("returns undefined when no directive is in-flight", () => {
		const q = new ToolChoiceQueue();
		expect(q.peekInFlightInvoker()).toBeUndefined();
	});

	it("carries onInvoked across requeue so replayed directive still handles invocations", async () => {
		const q = new ToolChoiceQueue();
		let invocationCount = 0;
		q.pushOnce(forced, {
			label: "pending",
			onRejected: () => "requeue",
			onInvoked: async () => {
				invocationCount++;
				return "handled";
			},
		});
		// First turn: aborted, requeued
		q.nextToolChoice();
		q.reject("aborted");
		// Next turn: invoker is still reachable via peekInFlightInvoker
		q.nextToolChoice();
		const invoker = q.peekInFlightInvoker();
		expect(invoker).toBeDefined();
		const result = await invoker!({});
		expect(result).toBe("handled");
		expect(invocationCount).toBe(1);
	});
});
