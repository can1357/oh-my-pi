/**
 * RFC #12407 v2: depth-1 subcall + optional kernel bind (offline).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	createRlmKernelBind,
	parseRlmGrants,
	promptContainsCorpus,
	resetRlmStoresForTest,
	rlmKernelPrelude,
	rlmSubcall,
	RlmStore,
} from "../src/rlm";
import { RlmTool } from "../src/tools/rlm";
import type { ToolSession } from "../src/tools";
import { Settings } from "../src/config/settings";

const FACT_A = "FACT_A_ALPHA_91";
const FACT_B = "FACT_B_BETA_42";

afterEach(() => {
	resetRlmStoresForTest();
});

describe("RFC v2 depth-1 subcall", () => {
	test("maxDepth=0 rejects subcall fail-open", async () => {
		const store = new RlmStore({ maxDepth: 0 });
		const rec = store.put(`pad ${FACT_A} pad`);
		const result = await rlmSubcall(
			store,
			[{ handle: rec.id }],
			`Extract the FACT_A token`,
			async () => ({ text: "should-not-run", tokens: 1, cost: 0 }),
			1,
		);
		expect(result.failOpen).toBe(true);
		expect(result.text).toContain("maxDepth=0");
		expect(store.budget.calls).toBe(0);
	});

	test("depth 2 rejected when maxDepth=1", async () => {
		const store = new RlmStore({ maxDepth: 1 });
		const rec = store.put(`x ${FACT_A} y`);
		const result = await rlmSubcall(
			store,
			[{ handle: rec.id }],
			"anything",
			async () => "nope",
			2,
		);
		expect(result.failOpen).toBe(true);
		expect(result.text).toContain("exceeds maxDepth");
		expect(store.budget.calls).toBe(0);
	});

	test("multi-hop grants: worker sees both facts, not ungranted third", async () => {
		const store = new RlmStore({ maxDepth: 1, maxCalls: 8 });
		const a = store.put(`${"a".repeat(1000)}${FACT_A}${"a".repeat(1000)}`, "file-a");
		const b = store.put(`${"b".repeat(1000)}${FACT_B}${"b".repeat(1000)}`, "file-b");
		const secret = "SECRET_UNGRANTED_ZZ";
		store.put(`${"c".repeat(500)}${secret}${"c".repeat(500)}`, "file-c");

		let seenPrompt = "";
		const result = await rlmSubcall(
			store,
			[{ handle: a.id }, { handle: b.id }],
			`Combine FACT_A and FACT_B into one line: <A>+<B>`,
			async prompt => {
				seenPrompt = prompt;
				const hasA = prompt.includes(FACT_A);
				const hasB = prompt.includes(FACT_B);
				return {
					text: hasA && hasB ? `${FACT_A}+${FACT_B}` : "missing",
					tokens: 20,
					cost: 0,
				};
			},
			1,
		);

		expect(result.failOpen).toBeUndefined();
		expect(result.text).toBe(`${FACT_A}+${FACT_B}`);
		expect(seenPrompt).toContain(FACT_A);
		expect(seenPrompt).toContain(FACT_B);
		expect(seenPrompt).not.toContain(secret);
		expect(promptContainsCorpus(seenPrompt, secret)).toBe(false);
		expect(result.citation).toContain("rlm://h/");
		expect(store.budget.calls).toBeGreaterThanOrEqual(1);
		expect(store.trajectory.some(e => e.op === "subcall" && !e.failOpen)).toBe(true);
	});

	test("budget exhaust fail-open", async () => {
		const store = new RlmStore({ maxDepth: 1, maxCalls: 0 });
		const rec = store.put(FACT_A);
		const result = await rlmSubcall(store, [{ handle: rec.id }], "task", async () => "x", 1);
		expect(result.failOpen).toBe(true);
		expect(result.text).toContain("maxCalls");
	});
	test("parseRlmGrants de-dupes handle + handles", () => {
		const g = parseRlmGrants("rlm://h/1", "2, rlm://h/1 ,3", 10, 20);
		expect(g).toEqual([
			{ handle: "2" },
			{ handle: "rlm://h/1", start: 10, end: 20 },
			{ handle: "3" },
		]);
		const single = parseRlmGrants("rlm://h/9", undefined, 1, 2);
		expect(single).toEqual([{ handle: "rlm://h/9", start: 1, end: 2 }]);
	});

	test("RlmTool subcall op with maxDepth=1", async () => {
		const settings = Settings.isolated({
			"rlm.enabled": true,
			"rlm.maxDepth": 1,
		});
		const session = {
			cwd: "/tmp/rlm-v2",
			settings,
			rlmComplete: async () => ({ text: "WORKER_OK", tokens: 3, cost: 0 }),
		} as ToolSession;
		const tool = RlmTool.createIf(session);
		expect(tool).not.toBeNull();
		const store = (await import("../src/rlm")).getRlmStore(session);
		const rec = store.put(`hello ${FACT_A}`);
		const out = await tool!.execute("t1", {
			op: "subcall",
			handle: `rlm://h/${rec.id}`,
			task: "echo ok",
		});
		const text = out.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");
		expect(text).toContain("WORKER_OK");
		expect(out.details.op).toBe("subcall");
	});
});

describe("RFC v2 kernel bind", () => {
	test("bind API peeks without listing full un-peeked bodies in handles()", () => {
		const store = new RlmStore();
		const body = `${"z".repeat(50_000)}NEEDLE_K${"z".repeat(10)}`;
		const rec = store.put(body, "fat");
		const api = createRlmKernelBind(store);
		const meta = api.handles();
		expect(meta).toEqual([{ id: rec.id, handle: `rlm://h/${rec.id}`, bytes: body.length, source: "fat" }]);
		expect(JSON.stringify(meta)).not.toContain("NEEDLE_K");
		const peek = api.peek(rec.id, 49_990, 50_020);
		expect(peek.text).toContain("NEEDLE_K");
		expect(api.status()).toContain("handles=1");
	});

	test("prelude off vs on", () => {
		expect(rlmKernelPrelude(false)).toContain("kernelBind=false");
		expect(rlmKernelPrelude(true)).toContain("class _RlmBind");
		expect(rlmKernelPrelude(true)).toContain("__repr__");
		expect(rlmKernelPrelude(true)).not.toContain("NEEDLE");
	});
});

describe("RFC v2 RLM eval prelude", () => {
	test("createRlmPrelude enabled only with kernelBind", async () => {
		const { createRlmPrelude } = await import("../src/rlm/prelude");
		const off = Settings.isolated({ "rlm.enabled": true, "rlm.kernelBind": false });
		const offSession = { cwd: "/tmp/rlm-pre-off", settings: off } as ToolSession;
		const offP = createRlmPrelude(offSession);
		expect(offP.enabled?.()).toBe(false);

		const on = Settings.isolated({ "rlm.enabled": true, "rlm.kernelBind": true, "rlm.maxDepth": 1 });
		const onSession = { cwd: "/tmp/rlm-pre-on", settings: on } as ToolSession;
		const onP = createRlmPrelude(onSession);
		expect(onP.enabled?.()).toBe(true);
		expect(onP.exports).toContain("rlm");
		expect(onP.javascript).toContain("__omp_prelude__");
		expect(onP.python).toContain("_omp_prelude");

		const store = (await import("../src/rlm")).getRlmStore(onSession);
		const body = `${"n".repeat(30_000)}PRELUDE_NEEDLE_99${"n".repeat(100)}`;
		const rec = store.put(body);
		const handles = await onP.invoke({ op: "handles" }, { session: onSession, toolCallId: "p1" });
		expect(JSON.stringify(handles.details)).toContain(`rlm://h/${rec.id}`);
		expect(JSON.stringify(handles.details)).not.toContain("PRELUDE_NEEDLE_99");

		const peek = await onP.invoke(
			{ op: "peek", handle: rec.id, start: 29_990, end: 30_030 },
			{ session: onSession, toolCallId: "p2" },
		);
		expect(String((peek.details as { text?: string }).text ?? "")).toContain("PRELUDE_NEEDLE_99");

		const bad = await onP.invoke({ op: "peek", handle: "missing" }, { session: onSession, toolCallId: "p3" });
		expect(bad.isError === true || (bad.details as { error?: string }).error).toBeTruthy();
	});
});

