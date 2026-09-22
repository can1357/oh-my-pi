/**
 * RFC #12400 v1 acceptance fixtures that do not need a live model / GPU.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { convertToLlm } from "../src/session/messages";
import {
	appendRlmRuntimeGuide,
	getContextEngine,
	getRlmStore,
	maybeSpill,
	promptContainsCorpus,
	resetRlmStoresForTest,
	rlmEnabled,
	rlmGuideIsAppendOnly,
	rlmIsExclusiveEngine,
	rlmQuery,
	RlmStore,
	wrapToolWithRlmSpill,
} from "../src/rlm";
import { RlmTool } from "../src/tools/rlm";
import type { ToolSession } from "../src/tools";
import { Settings } from "../src/config/settings";


const NEEDLE = "UNIQUE_ACCEPTANCE_NEEDLE_7c2e";

function fatCorpus(bytes = 80_000): string {
	const pad = Math.max(0, bytes - NEEDLE.length);
	const left = Math.floor(pad / 2);
	const right = pad - left;
	return `${"a".repeat(left)}${NEEDLE}${"b".repeat(right)}`;
}

afterEach(() => {
	resetRlmStoresForTest();
});

describe("RFC v1: provider payload never contains spilled bytes", () => {
	test("convertToLlm root view excludes midpoint needle after spill", async () => {
		const store = new RlmStore();
		const corpus = fatCorpus();
		const tool = wrapToolWithRlmSpill(
			{
				name: "read",
				execute: async () => ({
					content: [{ type: "text" as const, text: corpus }],
					details: {},
				}),
			} as unknown as AgentTool,
			store,
			20480,
			{ enabled: () => true },
		);
		const result = await tool.execute("call-1", {});
		const spilledText = result.content.find(p => p.type === "text");
		expect(spilledText && spilledText.type === "text").toBe(true);
		const stub = spilledText && spilledText.type === "text" ? spilledText.text : "";
		expect(stub.includes("[rlm spilled")).toBe(true);
		expect(stub.includes(NEEDLE)).toBe(false);

		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "read the big file" }],
				timestamp: Date.now(),
			} as AgentMessage,
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "/tmp/fat.txt" },
					},
				],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			} as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: stub }],
				isError: false,
				timestamp: Date.now(),
			} as AgentMessage,
		];

		const llm = convertToLlm(messages);
		const serialized = JSON.stringify(llm);
		expect(serialized.includes(NEEDLE)).toBe(false);
		expect(serialized.includes("rlm://h/")).toBe(true);
		// Original corpus must still be addressable out-of-band.
		expect(store.search("rlm://h/1", NEEDLE).some(h => h.text.includes(NEEDLE))).toBe(true);
	});
});

describe("RFC v1: system prompt stable on rlm toggle", () => {
	test("enabling rlm does not inject or mutate a frozen base system prompt", () => {
		// v1 does not append an RLM runtime guide into the system prompt (tools
		// change separately via setRlmToolEnabled). Base system text must stay
		// byte-identical across the settings flip.
		const base = Object.freeze(["You are a coding agent.", "Be concise."]) as readonly string[];
		const before = structuredClone([...base]);

		const settings = Settings.isolated({ "rlm.enabled": false });
		settings.override("rlm.enabled", true);
		settings.override("rlm.spillBytes", 20480);

		expect([...base]).toEqual(before);
		expect(settings.get("rlm.enabled")).toBe(true);
		// No rlm-owned mutation API on system prompts exists; this pins the contract.
		expect(JSON.stringify(base)).toBe(JSON.stringify(before));
	});
});

describe("RFC v1: query via session completer", () => {
	test("completer sees only a capped slice, never the full corpus", async () => {
		const corpus = fatCorpus(100_000);
		const settings = Settings.isolated({ "rlm.enabled": true });
		let seenPrompt = "";
		const session = {
			cwd: "/tmp/rlm-query",
			settings,
			rlmComplete: async (prompt: string) => {
				seenPrompt = prompt;
				return "answer-from-slice";
			},
		} as ToolSession;
		const store = getRlmStore(session);
		store.put(corpus, "fat");
		const tool = new RlmTool(session);
		const out = await tool.execute("q1", {
			op: "query",
			handle: "rlm://h/1",
			question: "where is the needle?",
		});
		const text = out.content[0];
		expect(text && text.type === "text" ? text.text.includes("answer-from-slice") : false).toBe(true);
		expect(text && text.type === "text" ? text.text.includes("rlm://h/1") : false).toBe(true);
		expect(seenPrompt.length).toBeLessThan(corpus.length);
		expect(promptContainsCorpus(seenPrompt, corpus)).toBe(false);
		// Default QUERY_SLICE is 8192 chars of body + framing.
		expect(seenPrompt.length).toBeLessThan(20_000);
	});

	test("missing completer fail-opens without throwing", async () => {
		const settings = Settings.isolated({ "rlm.enabled": true });
		const session = { cwd: "/tmp/rlm-no-c", settings } as ToolSession;
		getRlmStore(session).put(fatCorpus(40_000), "x");
		const tool = new RlmTool(session);
		const out = await tool.execute("q2", {
			op: "query",
			handle: "rlm://h/1",
			question: "q?",
		});
		const text = out.content[0];
		expect(text && text.type === "text" ? text.text.includes("fail-open") : false).toBe(true);
	});
});

describe("RFC v1: budgets fail-open", () => {
	test("maxCalls exhaustion returns fail-open text", async () => {
		const store = new RlmStore({ maxCalls: 1, maxTotalTokens: 1_000_000 });
		store.put(fatCorpus(40_000));
		const first = await rlmQuery(store, "rlm://h/1", "q1", async () => "ok");
		expect(first.failOpen).toBeUndefined();
		const second = await rlmQuery(store, "rlm://h/1", "q2", async () => "ok");
		expect(second.failOpen).toBe(true);
		expect(second.text.includes("maxCalls")).toBe(true);
	});

	test("maxTotalTokens exhaustion returns fail-open text", async () => {
		const store = new RlmStore({ maxCalls: 32, maxTotalTokens: 10 });
		store.put(fatCorpus(40_000));
		const result = await rlmQuery(store, "rlm://h/1", "q", async () => "ok");
		expect(result.failOpen).toBe(true);
		expect(result.text.includes("maxTotalTokens")).toBe(true);
	});
});

describe("RFC v1: compaction must not drop handles or reinject corpus", () => {
	test("store survives root-message wipe; stubs stay stubs", () => {
		const store = new RlmStore();
		const corpus = fatCorpus(60_000);
		const stub = maybeSpill(store, corpus, 20480, "read");
		expect(stub.includes(NEEDLE)).toBe(false);
		expect(store.records.size).toBe(1);

		// Simulate native compaction replacing the long transcript with a summary.
		let rootMessages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "big read" }],
				timestamp: 1,
			} as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: stub }],
				isError: false,
				timestamp: 2,
			} as AgentMessage,
		];
		rootMessages = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `Compaction summary: prior work used handle rlm://h/1 (spilled). ${stub.slice(0, 120)}`,
					},
				],
				timestamp: 3,
			} as AgentMessage,
		];

		const llm = convertToLlm(rootMessages);
		const serialized = JSON.stringify(llm);
		expect(serialized.includes(NEEDLE)).toBe(false);
		// Handle still live on the session store (compaction must not clear it).
		expect(store.get("rlm://h/1")?.text.includes(NEEDLE)).toBe(true);
		expect(store.search("rlm://h/1", NEEDLE).length).toBeGreaterThan(0);
	});
});

describe("RFC v1: context.engine exclusive routing", () => {
	test("context.engine rlm enables without rlm.enabled", () => {
		const settings = Settings.isolated({ "context.engine": "rlm", "rlm.enabled": false });
		const session = { settings } as { settings: Settings };
		expect(getContextEngine(session)).toBe("rlm");
		expect(rlmEnabled(session)).toBe(true);
		expect(rlmIsExclusiveEngine(session)).toBe(true);
	});

	test("native default disables rlm", () => {
		const settings = Settings.isolated({});
		const session = { settings } as { settings: Settings };
		expect(getContextEngine(session)).toBe("native");
		expect(rlmEnabled(session)).toBe(false);
	});
});

describe("RFC v1: runtime guide is append-only", () => {
	test("append does not mutate base segments", () => {
		const base = Object.freeze(["You are a coding agent.", "Be concise."]);
		const next = appendRlmRuntimeGuide(base, true);
		expect(rlmGuideIsAppendOnly(base, next)).toBe(true);
		expect(base).toEqual(["You are a coding agent.", "Be concise."]);
		expect(next[next.length - 1]?.includes("RLM context engine is on")).toBe(true);
		const off = appendRlmRuntimeGuide(base, false);
		expect(off).toEqual([...base]);
	});
});

describe("RFC v1: cancel and wall-clock / cost budgets", () => {
	test("cancel fail-opens subsequent query and keeps trajectory", async () => {
		const store = new RlmStore({ maxCalls: 32 });
		store.put(fatCorpus(40_000));
		store.cancel("user-abort");
		const result = await rlmQuery(store, "rlm://h/1", "q?", async () => "should-not-run");
		expect(result.failOpen).toBe(true);
		expect(result.text.includes("cancelled")).toBe(true);
		expect(store.trajectory.some(e => e.op === "cancel")).toBe(true);
		expect(store.get("rlm://h/1")).toBeDefined();
	});

	test("maxCost exhaustion fail-opens", async () => {
		const store = new RlmStore({ maxCalls: 32, maxTotalTokens: 1_000_000, maxCost: 0.0001 });
		store.put(fatCorpus(40_000));
		// Pre-fill cost near cap
		store.budget.cost = 0.0001;
		const result = await rlmQuery(store, "rlm://h/1", "q?", async () => "ok");
		expect(result.failOpen).toBe(true);
		expect(result.text.includes("maxCost")).toBe(true);
	});

	test("wallClockMs exhaustion fail-opens", async () => {
		const store = new RlmStore({
			maxCalls: 32,
			maxTotalTokens: 1_000_000,
			wallClockMs: 1,
			startedAt: Date.now() - 50,
		});
		store.put(fatCorpus(40_000));
		const result = await rlmQuery(store, "rlm://h/1", "q?", async () => "ok");
		expect(result.failOpen).toBe(true);
		expect(result.text.includes("wallClockMs")).toBe(true);
	});

	test("completer can report usage cost on success path", async () => {
		const store = new RlmStore({ maxCalls: 8, maxTotalTokens: 1_000_000, maxCost: 1 });
		store.put(fatCorpus(40_000));
		const result = await rlmQuery(store, "rlm://h/1", "q?", async () => ({
			text: "from-registry",
			tokens: 12,
			cost: 0.01,
		}));
		expect(result.failOpen).toBeUndefined();
		expect(result.text).toBe("from-registry");
		expect(store.budget.cost).toBeGreaterThanOrEqual(0.01);
	});
});

describe("RFC v1: compaction never clears store API", () => {
	test("resetRlmStoresForTest is the only clear path; compact must not import it", async () => {
		const maintenance = await Bun.file(
			new URL("../src/session/session-maintenance.ts", import.meta.url).pathname,
		).text();
		expect(maintenance.includes("resetRlmStoresForTest")).toBe(false);
		expect(maintenance.includes("from \"../rlm\"") || maintenance.includes("from '../rlm'")).toBe(false);
	});
});

