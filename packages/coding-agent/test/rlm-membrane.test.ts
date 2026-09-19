/**
 * RLM Runtime Membrane gates (review merge-blockers on #12403):
 * - isolated completion must not inherit root history
 * - store cannot collide across concurrent sessions (never cwd-only)
 * - store disposed with session
 * - hard budgets: beginCall once + reconcile actual usage
 * - cancellation/deadline reaches provider call via AbortSignal
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	disposeRlmStore,
	getRlmStore,
	resetRlmStoresForTest,
	rlmQuery,
	rlmSessionKey,
	RlmStore,
} from "../src/rlm";
import type { RlmSessionHost } from "../src/rlm";

afterEach(() => {
	resetRlmStoresForTest();
});

function host(
	partial: Partial<RlmSessionHost> & { runtimeId?: string; sessionId?: string },
): RlmSessionHost {
	const { runtimeId, sessionId, ...rest } = partial;
	return {
		cwd: partial.cwd ?? "/tmp/shared-workspace",
		settings: partial.settings ?? { get: () => undefined },
		getRlmRuntimeId: runtimeId !== undefined ? () => runtimeId : partial.getRlmRuntimeId,
		getSessionId: sessionId !== undefined ? () => sessionId : partial.getSessionId,
		sessionManager: partial.sessionManager,
		...rest,
	};
}

describe("RLM membrane — store ownership", () => {
	test("two sessions same cwd get distinct stores when runtime ids differ", () => {
		const a = host({ runtimeId: "agent-session:aaa" });
		const b = host({ runtimeId: "agent-session:bbb" });
		expect(rlmSessionKey(a)).not.toBe(rlmSessionKey(b));
		expect(rlmSessionKey(a)).not.toContain("/tmp/shared-workspace");
		const sa = getRlmStore(a);
		const sb = getRlmStore(b);
		expect(sa).not.toBe(sb);
		sa.put("alpha", "a");
		expect(sb.records.size).toBe(0);
		expect(a.rlmStore).toBe(sa);
		expect(b.rlmStore).toBe(sb);
	});

	test("cwd-only hosts never share a key (ephemeral per object)", () => {
		const a = host({});
		const b = host({});
		expect(rlmSessionKey(a)).not.toBe(rlmSessionKey(b));
		expect(getRlmStore(a)).not.toBe(getRlmStore(b));
	});

	test("disposeRlmStore clears corpus and rejects further puts", () => {
		const a = host({ runtimeId: "dispose-me" });
		const store = getRlmStore(a);
		store.put("secret-corpus", "test");
		expect(store.records.size).toBe(1);
		disposeRlmStore(a);
		expect(store.disposed).toBe(true);
		expect(store.records.size).toBe(0);
		expect(store.budget.cancelled).toBe(true);
		expect(() => store.put("more")).toThrow(/disposed/);
		const next = getRlmStore(a);
		expect(next).not.toBe(store);
		expect(next.disposed).toBe(false);
	});
});

describe("RLM membrane — budget ledger", () => {
	test("beginCall increments calls once; reconcileUsage does not double-count calls", () => {
		const store = new RlmStore({ maxCalls: 4, maxTotalTokens: 10_000 });
		store.beginCall(100);
		expect(store.budget.calls).toBe(1);
		expect(store.budget.tokens).toBe(100);
		const r = store.reconcileUsage({ estimatedTokens: 100, actualTokens: 450, actualCost: 0.02 });
		expect(store.budget.calls).toBe(1);
		expect(store.budget.tokens).toBe(450);
		expect(store.budget.cost).toBeCloseTo(0.02);
		expect(r.tokens).toBe(450);
		expect(r.overBudget).toBe(false);
	});

	test("reconcileUsage marks overBudget when actual exceeds maxTotalTokens", () => {
		const store = new RlmStore({ maxCalls: 4, maxTotalTokens: 200 });
		store.beginCall(100);
		const r = store.reconcileUsage({ estimatedTokens: 100, actualTokens: 500 });
		expect(store.budget.calls).toBe(1);
		expect(store.budget.tokens).toBe(500);
		expect(r.overBudget).toBe(true);
		expect(store.budget.overBudget).toBe(true);
	});

	test("rlmQuery does not double-increment calls on actual top-up", async () => {
		const store = new RlmStore({ maxCalls: 8, maxTotalTokens: 1_000_000 });
		store.put("FACT_A is 11.", "test");
		await rlmQuery(store, "1", "what is FACT_A?", async () => ({ text: "11", tokens: 9_000, cost: 0.01 }));
		expect(store.budget.calls).toBe(1);
		expect(store.budget.tokens).toBe(9_000);
		expect(store.budget.cost).toBeCloseTo(0.01);
	});
});

describe("RLM membrane — AbortSignal", () => {
	test("completer receives a live signal aborted by store.cancel", async () => {
		const store = new RlmStore();
		store.put("corpus body for query slice", "test");
		let sawSignal: AbortSignal | undefined;
		const result = await rlmQuery(store, "1", "q", async (_prompt, options) => {
			sawSignal = options?.signal;
			expect(sawSignal).toBeDefined();
			expect(sawSignal!.aborted).toBe(false);
			store.cancel("operator");
			expect(sawSignal!.aborted).toBe(true);
			return "still returned";
		});
		expect(sawSignal).toBeDefined();
		expect(result.text).toBe("still returned");
		expect(store.budget.cancelled).toBe(true);
	});

	test("createCallSignal aborts when wallClockMs already exhausted", () => {
		const store = new RlmStore({ wallClockMs: 1, startedAt: Date.now() - 50 });
		const signal = store.createCallSignal();
		expect(signal.aborted).toBe(true);
	});
});

describe("RLM membrane — isolated snapshot contract", () => {
	function buildIsolatedSnapshot(
		promptText: string,
		rootMessages: Array<{ role: string; text: string }>,
		isolated: boolean,
	): Array<{ role: string; text: string }> {
		const out: Array<{ role: string; text: string }> = [];
		if (!isolated) {
			for (const m of rootMessages) out.push(m);
		}
		out.push({ role: "developer", text: "no-tools" });
		out.push({ role: "user", text: promptText });
		return out;
	}

	test("isolated=true drops root user/tool secrets from worker messages", () => {
		const root = [
			{ role: "user", text: "ROOT_SECRET_NEVER_IN_WORKER" },
			{ role: "assistant", text: "I saw the secret" },
			{ role: "toolResult", text: "TOOL_PAYLOAD_LEAK" },
		];
		const isolated = buildIsolatedSnapshot("Answer from excerpt only", root, true);
		const joined = isolated.map(m => m.text).join("\n");
		expect(joined.includes("ROOT_SECRET_NEVER_IN_WORKER")).toBe(false);
		expect(joined.includes("TOOL_PAYLOAD_LEAK")).toBe(false);
		expect(isolated.some(m => m.role === "user" && m.text.includes("Answer from excerpt"))).toBe(true);

		const leaked = buildIsolatedSnapshot("q", root, false);
		expect(leaked.map(m => m.text).join("\n").includes("ROOT_SECRET_NEVER_IN_WORKER")).toBe(true);
	});

	test("sdk rlmComplete wires isolated:true and unique conversationKey (source contract)", async () => {
		const sdk = await Bun.file(new URL("../src/sdk.ts", import.meta.url)).text();
		expect(sdk.includes("isolated: true")).toBe(true);
		expect(sdk.includes("history: []")).toBe(true);
		expect(sdk.includes("conversationKey: `rlm:${Snowflake.next()}`")).toBe(true);
		expect(sdk.includes("disposeRlmStore(toolSession)")).toBe(true);
		expect(sdk.includes("getRlmRuntimeId: () => evalKernelOwnerId")).toBe(true);

		const session = await Bun.file(new URL("../src/session/agent-session.ts", import.meta.url)).text();
		expect(session.includes("isolated?: boolean")).toBe(true);
		expect(session.includes("args.isolated === true")).toBe(true);
		expect(session.includes("if (!isolated)")).toBe(true);
		expect(session.includes("messages.push(...this.messages)")).toBe(true);
	});
});

describe("RLM membrane — literal search default", () => {
	test("literal mode does not interpret regex metacharacters", () => {
		const store = new RlmStore();
		store.put("price is $5.00 and (optional)", "t");
		expect(store.search("1", "$5.00", 4, "literal")).toHaveLength(1);
		expect(store.search("1", "(optional)", 4, "literal")).toHaveLength(1);
		expect(store.search("1", "\\$5\\.00", 4, "regex")).toHaveLength(1);
	});
});
