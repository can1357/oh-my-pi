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
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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

/** What `run` threw, or `undefined` when it returned. */
async function thrownBy(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	return undefined;
}

// Each replay's arm has an identity: the send that carries the replay takes it
// and releases that arm alone. These are compositions of the real budget and
// transport helpers; no stock provider runs two replays at once.
describe("arm ownership", () => {
	it("does not let an older send's settlement release a replay armed after it began", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const older = Promise.withResolvers<Response>();
		budget.arm(new Error("A"));
		const sendA = budget.gateFetch(() => older.promise)("https://example.test/A");
		const replacedB = new Error("B");
		budget.arm(replacedB);
		older.resolve(new Response("A"));
		await sendA;
		clock.advance(200);

		const refusal = await thrownBy(() => budget.checkpoint());

		expect(refusal).toBeInstanceOf(RetryRefusedError);
		expect(restoreReplaced(refusal)).toBe(replacedB);
	});

	it("keeps a replay a send already took when a newer replay is armed, sent and settled", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const replacedA = new Error("A");
		const ready = Promise.withResolvers<void>();
		let written = 0;
		budget.arm(replacedA);
		const sendA = budget.gateFetch(async () => {
			await ready.promise;
			budget.checkpoint();
			written++;
			return new Response("A");
		})("https://example.test/A");
		budget.arm(new Error("B"));
		await budget.gateFetch(async () => new Response("B"))("https://example.test/B");
		clock.advance(200);
		ready.resolve();

		const refusal = await thrownBy(() => sendA);

		expect(written).toBe(0);
		expect(restoreReplaced(refusal)).toBe(replacedA);
	});

	it("keeps the arm through token and connection checkpoints, and refuses the delayed write", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const replaced = new Error("503");
		budget.arm(replaced);
		budget.checkpoint();
		budget.checkpoint();
		clock.advance(200);
		let writes = 0;

		let refusal: unknown;
		try {
			budget.handoff();
			writes++;
		} catch (error) {
			refusal = error;
		}

		expect(writes).toBe(0);
		expect(restoreReplaced(refusal)).toBe(replaced);
	});

	it("refuses again when a wrapper inside the send catches a refusal and retries", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const model = buildModel({
			id: "m",
			name: "m",
			api: "openai-completions",
			provider: "wire",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		});
		let writes = 0;
		const transport = transportFetch(
			model,
			async () => {
				writes++;
				return new Response("ok");
			},
			budget,
		);
		const wrapper = budget.gateFetch(async (input, init) => {
			clock.advance(200);
			try {
				return await transport(input, init);
			} catch {
				return transport(input, init);
			}
		});
		budget.arm(new Error("503"));

		const refusal = await thrownBy(() => wrapper("https://example.test"));

		expect(writes).toBe(0);
		expect(refusal).toBeInstanceOf(RetryRefusedError);
	});

	it("refuses the replay's own send after a checkpoint refusal was swallowed before it", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const replaced = new Error("503");
		budget.arm(replaced);
		clock.advance(200);
		let writes = 0;
		// A token probe that reads every failure as "no token", then a retry of it.
		for (let probe = 0; probe < 2; probe++) {
			expect(await thrownBy(() => budget.checkpoint())).toBeInstanceOf(RetryRefusedError);
		}

		const refusal = await thrownBy(() =>
			budget.gateFetch(async () => {
				writes++;
				return new Response("ok");
			})("https://example.test"),
		);

		expect(writes).toBe(0);
		expect(restoreReplaced(refusal)).toBe(replaced);
	});

	it("lets requests through once the send that took a refused arm has settled", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		budget.arm(new Error("503"));
		clock.advance(200);
		await thrownBy(() => budget.gateFetch(async () => new Response("ok"))("https://example.test"));

		// A cleanup request after the refused replay (a workflow stop) is not a replay.
		expect(() => budget.checkpoint()).not.toThrow();
	});

	it("spends the arm a refused handoff took, so requests after the refused replay are not refused for it", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		budget.arm(new Error("503"));
		clock.advance(200);
		expect(() => budget.handoff()).toThrow(RetryRefusedError);

		// The refused frame went nowhere: a cleanup request after it is not a replay,
		// and the refusal still latches for every later replay.
		expect(() => budget.checkpoint()).not.toThrow();
		expect(budget.admits(0)).toBe(false);
	});

	it("renames the replay being prepared when it is armed again, so disarming the earlier arm keeps the later", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const earlier = budget.arm("A");
		const later = budget.arm("B");
		budget.disarm(earlier);
		clock.advance(200);

		expect(() => budget.handoff()).toThrow(RetryRefusedError);
		expect(later.refused).toBe(true);
	});

	it("drops a disarmed replay, so requests after it pass", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const arm = budget.arm("A");
		budget.disarm(arm);
		clock.advance(200);

		expect(() => budget.checkpoint()).not.toThrow();
		expect(() => budget.handoff()).not.toThrow();
	});

	it("releases the arm a handoff sent, so the attempt's later requests pass after the deadline", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		budget.arm(new Error("503"));
		budget.handoff();
		clock.advance(200);

		// A streaming append on the replay's own connection is not a replay.
		expect(() => budget.checkpoint()).not.toThrow();
		expect(() => budget.handoff()).not.toThrow();
	});
});

describe("the failure a refused call answers with", () => {
	it("is the failure the replay replaced, even after a layer turned the refusal into another error", () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		const replaced = new Error("503 original overload");
		budget.arm(replaced);
		clock.advance(200);
		expect(() => budget.checkpoint()).toThrow(RetryRefusedError);
		const converted = new Error("Connection error.");

		expect(restoreReplaced(converted, budget)).toBe(replaced);
		expect(restoreReplaced(converted)).toBe(converted);
	});

	it("is the error itself when the budget refused nothing", () => {
		const budget = budgetOf(100);
		const error = new Error("400 bad request");

		expect(restoreReplaced(error, budget)).toBe(error);
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
			4_000,
		);
		const elapsedMs = performance.now() - started;

		expect(outcome).toEqual({ value: false });
		expect(elapsedMs).toBeGreaterThanOrEqual(100);
		expect(budget.admits(0)).toBe(false);
	});

	it("rejects at once when the caller aborts a hook that never settles", async () => {
		const budget = budgetOf(60_000);
		const controller = new AbortController();
		const waiting = budget.wait(10, controller.signal, () => new Promise<void>(() => {}));
		setTimeout(() => controller.abort(), 20);

		expect(await settlesWithin(waiting, 4_000)).toBe("rejected");
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

	it("refuses a wait exactly as long as what remains, without starting it", async () => {
		fakeClock();
		const budget = budgetOf(100);
		const waits: number[] = [];
		expect(await budget.wait(100, undefined, async ms => void waits.push(ms))).toBe(false);
		expect(waits).toEqual([]);
		expect(budget.allowsWait(0)).toBe(false);
	});

	it("allowsWait refuses a wait exactly as long as what remains, and latches", () => {
		fakeClock();
		const budget = budgetOf(100);
		expect(budget.allowsWait(99)).toBe(true);
		expect(budget.allowsWait(100)).toBe(false);
		expect(budget.allowsWait(0)).toBe(false);
	});

	it("rejects at once, without starting the wait, when the caller already aborted", async () => {
		const budget = budgetOf(60_000);
		const controller = new AbortController();
		controller.abort();
		const waits: number[] = [];

		expect(await thrownBy(() => budget.wait(10, controller.signal, async ms => void waits.push(ms)))).toBeDefined();
		expect(waits).toEqual([]);
	});

	it("bounds the wait's race by what remains of the budget, not longer", async () => {
		fakeClock();
		const budget = budgetOf(150);
		const timer = vi.spyOn(globalThis, "setTimeout");

		expect(await budget.wait(50, undefined, () => new Promise<void>(() => {}))).toBe(false);
		const delays = timer.mock.calls.map(call => call[1]);
		expect(delays).toContain(150);
		expect(Math.max(...delays.map(Number))).toBeLessThanOrEqual(150);
	});
});

describe("racing work the replay waits on", () => {
	it("answers with the work's value when it settles inside the budget", async () => {
		const budget = budgetOf(60_000);
		expect(await budget.race(Promise.resolve("key"))).toEqual({ value: "key" });
		expect(budget.admits(0)).toBe(true);
	});

	it("answers undefined at the deadline while the work still runs, bounded by what remains, and latches", async () => {
		fakeClock();
		const budget = budgetOf(120);
		const timer = vi.spyOn(globalThis, "setTimeout");

		expect(await budget.race(new Promise<string>(() => {}))).toBeUndefined();
		const delays = timer.mock.calls.map(call => Number(call[1]));
		expect(delays).toContain(120);
		expect(Math.max(...delays)).toBeLessThanOrEqual(120);
		expect(budget.admits(0)).toBe(false);
	});

	it("answers undefined at once when the budget is already spent", async () => {
		const clock = fakeClock();
		const budget = budgetOf(100);
		clock.advance(100);
		const timer = vi.spyOn(globalThis, "setTimeout");

		expect(await budget.race(new Promise<string>(() => {}))).toBeUndefined();
		expect(timer).not.toHaveBeenCalled();
	});

	it("does not leave a rejection the race stopped watching unhandled", async () => {
		fakeClock();
		const budget = budgetOf(10);
		const late = Promise.withResolvers<string>();
		expect(await budget.race(late.promise)).toBeUndefined();
		late.reject(new Error("resolver failed after the deadline"));
		await Bun.sleep(0);
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
