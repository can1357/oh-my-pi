/**
 * RFC v3 acceptance — E1–E4 adversarial membrane fixtures (#12410).
 * No wall-clock sleeps — abort/cancel are driven synchronously.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	disposeRlmRuntime,
	getRlmRuntime,
	resetRlmStoresForTest,
	resolveRlmView,
	rlmQuery,
	rlmSessionKey,
	rlmSubcall,
	RlmRuntime,
	RlmStore,
	workerContextContains,
} from "../src/rlm";
import type { RlmSessionHost } from "../src/rlm";

afterEach(() => {
	resetRlmStoresForTest();
});

function host(runtimeId: string, cwd = "/tmp/shared-workspace"): RlmSessionHost {
	return {
		cwd,
		settings: {
			get: (path: string) => {
				if (path === "rlm.maxDepth") return 1;
				return undefined;
			},
		},
		getRlmRuntimeId: () => runtimeId,
	};
}

describe("E1: context firewall", () => {
	test("worker context sees granted fact and never parent secret", async () => {
		const SECRET = "SECRET_PARENT_X91";
		const FACT = "VISIBLE_FACT_A17";
		const runtime = new RlmRuntime({ maxDepth: 1, maxCalls: 8 });
		runtime.store.put(`prefix ${FACT} suffix`, "granted");
		const rootTranscript = `user said ${SECRET} and other chatter`;

		let capturedPrompt = "";
		const result = await rlmQuery(runtime, "1", "list all secret/fact tokens", async (prompt, opts) => {
			capturedPrompt = prompt;
			expect(prompt.includes(SECRET)).toBe(false);
			expect(prompt.includes(FACT)).toBe(true);
			expect(prompt.includes(rootTranscript)).toBe(false);
			expect(opts?.workerMessages?.some(m => m.content.includes(FACT))).toBe(true);
			expect(opts?.workerMessages?.some(m => m.content.includes(SECRET))).toBe(false);
			expect(opts?.purpose).toBe("rlm-query");
			return { text: FACT, tokens: 40, cost: 0 };
		});

		expect(result.failOpen).toBeUndefined();
		expect(result.text).toContain(FACT);
		expect(result.text.includes(SECRET)).toBe(false);
		expect(result.context).toBeDefined();
		expect(workerContextContains(result.context!, SECRET)).toBe(false);
		expect(workerContextContains(result.context!, FACT)).toBe(true);
		expect(capturedPrompt.includes(SECRET)).toBe(false);
	});

	test("depth-1 worker sees A+B but not ungranted C", async () => {
		const runtime = new RlmRuntime({ maxDepth: 1, maxCalls: 8 });
		runtime.store.put("FACT_A=11", "a");
		runtime.store.put("FACT_B=22", "b");
		runtime.store.put("FACT_C=SECRET_UNGRANTED", "c");

		const result = await rlmSubcall(
			runtime,
			[{ handle: "1" }, { handle: "2" }],
			"combine facts",
			async prompt => {
				expect(prompt.includes("FACT_A=11")).toBe(true);
				expect(prompt.includes("FACT_B=22")).toBe(true);
				expect(prompt.includes("FACT_C=SECRET_UNGRANTED")).toBe(false);
				return { text: "A11 B22", tokens: 50 };
			},
			1,
		);
		expect(result.failOpen).toBeUndefined();
		expect(result.context?.grantedBytes).toBeGreaterThan(0);
		expect(workerContextContains(result.context!, "FACT_C=SECRET_UNGRANTED")).toBe(false);
	});
});

describe("E2: same-workspace concurrency", () => {
	test("two sessions same cwd get isolated stores and handles", () => {
		const a = host("agent-A");
		const b = host("agent-B");
		expect(rlmSessionKey(a)).not.toBe(rlmSessionKey(b));

		const ra = getRlmRuntime(a);
		const rb = getRlmRuntime(b);
		expect(ra).not.toBe(rb);

		ra.store.put("TOKEN_A_ONLY", "a");
		rb.store.put("TOKEN_B_ONLY", "b");

		expect(ra.store.get("1")?.text).toBe("TOKEN_A_ONLY");
		expect(rb.store.get("1")?.text).toBe("TOKEN_B_ONLY");
		expect([...rb.store.records.values()].some(r => r.text === "TOKEN_A_ONLY")).toBe(false);

		disposeRlmRuntime(a);
		expect(ra.disposed).toBe(true);
		expect(rb.disposed).toBe(false);
		expect(rb.store.get("1")?.text).toBe("TOKEN_B_ONLY");
	});
});

describe("E3: usage reconciliation", () => {
	test("fake provider estimate low but reports 8000 → calls==1 tokens==8000", async () => {
		const runtime = new RlmRuntime({ maxCalls: 4, maxTotalTokens: 100_000 });
		runtime.store.put("corpus for query", "t");

		const result = await rlmQuery(runtime, "1", "q", async () => ({
			text: "ok",
			tokens: 8_000,
			inputTokens: 6_000,
			outputTokens: 2_000,
			cost: 0.05,
		}));

		expect(result.failOpen).toBeUndefined();
		expect(runtime.store.budget.calls).toBe(1);
		expect(runtime.store.budget.tokens).toBe(8_000);
		expect(runtime.store.budget.cost).toBeCloseTo(0.05);
		expect(result.tokens).toBe(8_000);
		expect(runtime.ledger.snapshot().calls).toBe(1);

		const traj = runtime.records.at(-1);
		expect(traj?.totalTokens).toBe(8_000);
		expect(traj?.status === "completed" || traj?.status === "overshoot").toBe(true);
	});

	test("overshoot recorded honestly when actual exceeds maxTotalTokens", async () => {
		const runtime = new RlmRuntime({ maxCalls: 4, maxTotalTokens: 500 });
		runtime.store.put("x", "t");
		const result = await rlmQuery(runtime, "1", "q", async () => ({
			text: "big",
			tokens: 9_000,
		}));
		expect(result.overBudget).toBe(true);
		expect(result.failOpen).toBe(true);
		expect(runtime.store.budget.calls).toBe(1);
		expect(runtime.store.budget.tokens).toBe(9_000);
		expect(runtime.store.budget.overBudget).toBe(true);
		expect(runtime.records.at(-1)?.status).toBe("overshoot");
	});
});

describe("E4: cancellation", () => {
	test("exhausted wallClockMs aborts lease signal before completer work", async () => {
		const runtime = new RlmRuntime({
			maxCalls: 4,
			wallClockMs: 1,
			startedAt: Date.now() - 50,
		});
		runtime.store.put("body", "t");

		let sawAbortedSignal = false;
		const result = await rlmQuery(runtime, "1", "q", async (_prompt, opts) => {
			sawAbortedSignal = opts?.signal?.aborted === true;
			if (opts?.signal?.aborted) {
				throw Object.assign(new Error("rlm wallClockMs exhausted"), { name: "AbortError" });
			}
			return "should-not-succeed";
		});

		// beginCall may fail open on wall clock before completer — either path is valid.
		expect(result.failOpen).toBe(true);
		if (sawAbortedSignal) {
			expect(result.aborted === true || /abort|wallClock|exhausted/i.test(result.text)).toBe(true);
		} else {
			expect(/wallClock|exhausted|cancelled/i.test(result.text)).toBe(true);
		}
		expect(runtime.store.get("1")?.text).toBe("body");
	});

	test("explicit runtime.cancel aborts in-flight lease signal", async () => {
		const runtime = new RlmRuntime({ maxCalls: 4 });
		runtime.store.put("body", "t");
		const result = await rlmQuery(runtime, "1", "q", async (_p, opts) => {
			expect(opts?.signal?.aborted).toBe(false);
			runtime.cancel("operator");
			expect(opts?.signal?.aborted).toBe(true);
			throw Object.assign(new Error("cancelled"), { name: "AbortError" });
		});
		expect(result.failOpen).toBe(true);
		expect(result.aborted).toBe(true);
		expect(runtime.store.budget.cancelled).toBe(true);
		expect(runtime.ledger.snapshot().cancelledCalls).toBeGreaterThan(0);
		expect(runtime.records.length).toBeGreaterThan(0);
		expect(runtime.store.get("1")?.text).toBe("body");
	});
});

describe("RFC v3 views + isolated source contracts", () => {
	test("resolveRlmView freezes grants and caps slices", () => {
		const store = new RlmStore();
		store.put("x".repeat(20_000), "big");
		const view = resolveRlmView(store, [{ handle: "1" }], { perGrantSlice: 100 });
		expect(view.grants).toHaveLength(1);
		expect(view.grants[0]!.text.length).toBe(100);
		expect(Object.isFrozen(view.grants)).toBe(true);
	});

	test("sdk + session wire runIsolatedCompletion", async () => {
		const sdk = await Bun.file(new URL("../src/sdk.ts", import.meta.url)).text();
		expect(sdk.includes("runIsolatedCompletion")).toBe(true);
		expect(sdk.includes("disposeRlmStore(toolSession)")).toBe(true);

		const session = await Bun.file(new URL("../src/session/agent-session.ts", import.meta.url)).text();
		expect(session.includes("async runIsolatedCompletion")).toBe(true);
		expect(session.includes("isolated: true")).toBe(true);
	});
});
