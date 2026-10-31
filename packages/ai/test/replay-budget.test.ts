/**
 * `ReplayBudget`: the three steps that can refuse a replay (the decision, the
 * wait, the transport handoff) and how one budget reaches every nested call.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	inheritReplayBudget,
	longestServerWaitMs,
	ReplayBudget,
	restoreReplaced,
	withReplayBudget,
} from "@oh-my-pi/pi-ai/utils/replay-budget";
import { RetryRefusedError } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

/** A monotonic clock the test moves by hand. */
function fakeClock(): { advance(ms: number): void } {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	return {
		advance(ms) {
			now += ms;
		},
	};
}

function budgetOf(ms: number): ReplayBudget {
	const budget = ReplayBudget.from(ms);
	if (!budget) throw new Error("expected a finite budget");
	return budget;
}

describe("ReplayBudget.from", () => {
	it("builds nothing for an unset or infinite budget, so no clock is read", () => {
		const now = vi.spyOn(performance, "now");
		expect(ReplayBudget.from(undefined)).toBeUndefined();
		expect(ReplayBudget.from(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(now).not.toHaveBeenCalled();
	});

	it.each([0, -5, Number.NaN])("refuses every replay for %p", value => {
		expect(budgetOf(value).admits(0)).toBe(false);
	});
});

describe("the transport handoff", () => {
	// A request no admission armed belongs to an attempt already on the wire:
	// the call's first request, a token fetch, a Cursor append.
	it("lets an unarmed request through after the deadline", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		clock.advance(500);
		expect(() => budget.handoff()).not.toThrow();
	});

	it("refuses an admitted replay whose deadline passed while it was prepared, carrying what it replaces", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const replaced = new Error("503 overloaded");
		expect(budget.admits(10)).toBe(true);
		const arm = budget.arm(replaced);
		clock.advance(150);

		let refusal: unknown;
		try {
			budget.handoff();
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(RetryRefusedError);
		expect(restoreReplaced(refusal)).toBe(replaced);
		expect(arm.refused).toBe(true);
		// Latched: nothing later in the call is admitted.
		expect(budget.admits(0)).toBe(false);
	});

	it("consumes the arm, so the replay's later requests are not checked", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		budget.admits(0);
		budget.handoff();
		clock.advance(500);
		expect(() => budget.handoff()).not.toThrow();
	});

	it("checks the deadline at a checkpoint without consuming the replay", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		budget.admits(0);
		budget.checkpoint();
		clock.advance(150);
		expect(() => budget.handoff()).toThrow(RetryRefusedError);
	});

	it("refuses at a checkpoint once an armed replay's deadline has passed, carrying what it replaces", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const replaced = new Error("503 overloaded");
		budget.admits(0);
		budget.arm(replaced);
		clock.advance(150);

		let refusal: unknown;
		try {
			budget.checkpoint();
		} catch (error) {
			refusal = error;
		}

		expect(restoreReplaced(refusal)).toBe(replaced);
	});

	it("lets an unarmed request through a checkpoint after the deadline", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		clock.advance(500);
		expect(() => budget.checkpoint()).not.toThrow();
	});

	it("gates a fetch once, however many layers ask", async () => {
		const budget = budgetOf(1_000);
		let calls = 0;
		const base: FetchImpl = async () => {
			calls++;
			return new Response("ok");
		};
		const gated = budget.gateFetch(base);
		expect(budget.gateFetch(gated)).toBe(gated);
		await gated("https://example.test");
		expect(calls).toBe(1);
	});

	// The replay's own request is the one the provider sends through its gate.
	// Whatever passes a checkpoint on the way (a token fetch, an inner library
	// wrapper) must leave the replay armed for it.
	it("keeps the replay armed through a request that passes a checkpoint, and refuses the request behind it", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const replaced = new Error("503 overloaded");
		const sent: string[] = [];
		// The provider's fetch: a token fetch, then the inference request.
		const inner: FetchImpl = async input => {
			budget.checkpoint();
			sent.push(`token ${String(input)}`);
			clock.advance(150);
			budget.checkpoint();
			sent.push(`inference ${String(input)}`);
			return new Response("ok");
		};
		budget.admits(0);
		budget.arm(replaced);

		let refusal: unknown;
		try {
			await budget.gateFetch(inner)("https://example.test");
		} catch (error) {
			refusal = error;
		}

		expect(sent).toEqual(["token https://example.test"]);
		expect(restoreReplaced(refusal)).toBe(replaced);
	});

	it("releases the replay once the call it gates settles, so the attempt's later requests pass", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		budget.admits(0);
		await budget.gateFetch(async () => new Response("ok"))("https://example.test");
		clock.advance(500);
		expect(() => budget.checkpoint()).not.toThrow();
		expect(() => budget.handoff()).not.toThrow();
	});

	it("releases the replay when the call it gates fails", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		budget.admits(0);
		await expect(
			budget.gateFetch(async () => {
				throw new Error("socket hang up");
			})("https://example.test"),
		).rejects.toThrow("socket hang up");
		clock.advance(500);
		expect(() => budget.checkpoint()).not.toThrow();
	});
});

describe("the wait before a replay", () => {
	/** How `pending` settles within `ms`: a regression that never settles fails here, not at the runner's timeout. */
	function settlesWithin<T>(pending: Promise<T>, ms: number): Promise<{ value: T } | "rejected" | "pending"> {
		return Promise.race([
			pending.then(
				value => ({ value }),
				() => "rejected" as const,
			),
			Bun.sleep(ms).then(() => "pending" as const),
		]);
	}

	// A wait hook that never settles must not hold failover past the deadline.
	it("refuses the replay at the deadline while the hook is still running", async () => {
		const budget = budgetOf(150);
		const started = performance.now();
		const outcome = await settlesWithin(
			budget.wait(50, undefined, () => new Promise<void>(() => {})),
			1_000,
		);
		const elapsedMs = performance.now() - started;

		expect(outcome).toEqual({ value: false });
		expect(elapsedMs).toBeGreaterThanOrEqual(140);
		expect(budget.admits(0)).toBe(false);
	});

	it("rejects at once when the caller aborts a hook that never settles", async () => {
		const budget = budgetOf(60_000);
		const controller = new AbortController();
		const waiting = budget.wait(10, controller.signal, () => new Promise<void>(() => {}));
		setTimeout(() => controller.abort(), 20);

		expect(await settlesWithin(waiting, 1_000)).toBe("rejected");
	});

	it("admits the replay when the wait finishes inside the budget", async () => {
		const budget = budgetOf(1_000);
		const waits: number[] = [];
		expect(await budget.wait(25, undefined, async ms => void waits.push(ms))).toBe(true);
		expect(waits).toEqual([25]);
	});

	it("refuses a wait that cannot finish inside the budget without starting it", async () => {
		const budget = budgetOf(100);
		const waits: number[] = [];
		expect(await budget.wait(500, undefined, async ms => void waits.push(ms))).toBe(false);
		expect(waits).toEqual([]);
	});

	it("replayAfterDelay arms a replay whose named wait fits, and carries what it replaces", async () => {
		const clock = fakeClock();
		const budget = budgetOf(1_000);
		const replaced = new Error("503");
		expect(await budget.replayAfterDelay(100, replaced, undefined, async ms => void clock.advance(ms))).toBe(true);
		clock.advance(2_000);
		expect(() => budget.checkpoint()).toThrow(RetryRefusedError);
	});

	it("replayAfterDelay refuses a named wait that would end past the budget, without waiting", async () => {
		const budget = budgetOf(1_000);
		const waits: number[] = [];
		expect(await budget.replayAfterDelay(30_000, undefined, undefined, async ms => void waits.push(ms))).toBe(false);
		expect(waits).toEqual([]);
		expect(budget.admits(0)).toBe(false);
	});
});

describe("one budget for a call and every call nested in it", () => {
	it("is carried by an object spread and dropped by serialization", () => {
		const options = withReplayBudget({ replayBudgetMs: 1_000, apiKey: "k" });
		const budget = ReplayBudget.forCall(options);
		expect(budget).toBeInstanceOf(ReplayBudget);
		expect(ReplayBudget.forCall({ ...options, apiKey: "other" })).toBe(budget);
		expect(JSON.parse(JSON.stringify(options))).toEqual({ replayBudgetMs: 1_000, apiKey: "k" });
	});

	it("is not created twice when the options already carry it", () => {
		const options = withReplayBudget({ replayBudgetMs: 1_000 });
		expect(withReplayBudget(options)).toBe(options);
	});

	it("reaches a delegate whose options are built field by field", () => {
		const options = withReplayBudget({ replayBudgetMs: 1_000 });
		const delegate = inheritReplayBudget(options, { apiKey: "k" });
		expect(ReplayBudget.forCall(delegate)).toBe(ReplayBudget.forCall(options));
	});

	it("leaves options without a budget untouched", () => {
		const options = { apiKey: "k" };
		expect(withReplayBudget(options)).toBe(options);
		expect(inheritReplayBudget(options, { apiKey: "d" })).toEqual({ apiKey: "d" });
	});
});

describe("longestServerWaitMs", () => {
	it("takes the longest wait across a failure's headers and its message", () => {
		const failure = Object.assign(new Error("503 overloaded. Please retry in 1ms. Please retry in 30s."), {
			headers: new Headers({ "retry-after-ms": "1", "retry-after": "2" }),
		});
		expect(longestServerWaitMs(failure)).toBe(30_000);
	});

	it("reads an error message given as text", () => {
		expect(longestServerWaitMs("overloaded retry-after-ms=90000")).toBe(90_000);
	});

	it("names no wait for a failure that names none", () => {
		expect(longestServerWaitMs(new Error("socket hang up"))).toBeUndefined();
	});
});
