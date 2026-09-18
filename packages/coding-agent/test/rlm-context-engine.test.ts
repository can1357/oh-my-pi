import { afterEach, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	maybeSpill,
	promptContainsCorpus,
	resetRlmStoresForTest,
	rlmQuery,
	RlmStore,
	stubContainsFullPayload,
	wrapToolWithRlmSpill,
} from "../src/rlm";
import { RlmTool } from "../src/tools/rlm";
import type { ToolSession } from "../src/tools";
import { Settings } from "../src/config/settings";

const NEEDLE = "UNIQUE_CORPUS_MIDPOINT_TOKEN_9f3a";

function bigCorpus(): string {
	return `${"alpha ".repeat(8_000)}${NEEDLE}${" omega".repeat(8_000)}`;
}

afterEach(() => {
	resetRlmStoresForTest();
});

describe("RLM store", () => {
	test("spill stub does not contain the corpus midpoint", () => {
		const store = new RlmStore();
		const corpus = bigCorpus();
		const stub = maybeSpill(store, corpus, 20480, "read");
		expect(stub.startsWith("[rlm spilled")).toBe(true);
		expect(stubContainsFullPayload(stub, corpus)).toBe(false);
		expect(stub.includes(NEEDLE)).toBe(false);
	});

	test("small text is not spilled", () => {
		const store = new RlmStore();
		expect(maybeSpill(store, "hello", 20480)).toBe("hello");
		expect(store.records.size).toBe(0);
	});

	test("peek cites byte offsets and returns the slice", () => {
		const store = new RlmStore();
		const corpus = bigCorpus();
		maybeSpill(store, corpus, 100);
		const idx = corpus.indexOf(NEEDLE);
		const peek = store.peek("1", idx, idx + NEEDLE.length);
		expect(peek.text).toBe(NEEDLE);
		expect(peek.citation).toBe(`rlm://h/1[${idx}:${idx + NEEDLE.length}]`);
	});

	test("search cites matches", () => {
		const store = new RlmStore();
		maybeSpill(store, bigCorpus(), 100);
		const hits = store.search("rlm://h/1", NEEDLE, 2);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.citation.startsWith("rlm://h/1[")).toBe(true);
		expect(hits[0]!.text.startsWith(NEEDLE)).toBe(true);
	});
});

describe("RLM query", () => {
	test("completer prompt does not include the full corpus", async () => {
		const store = new RlmStore();
		const corpus = bigCorpus();
		maybeSpill(store, corpus, 100);
		let seen = "";
		const result = await rlmQuery(store, "1", "where is the needle?", async prompt => {
			seen = prompt;
			return "in the excerpt";
		});
		expect(result.failOpen).toBeUndefined();
		expect(promptContainsCorpus(seen, corpus)).toBe(false);
		expect(result.citation.startsWith("rlm://h/1")).toBe(true);
	});

	test("missing completer fail-opens", async () => {
		const store = new RlmStore();
		maybeSpill(store, bigCorpus(), 100);
		const result = await rlmQuery(store, "1", "q");
		expect(result.failOpen).toBe(true);
		expect(result.text.includes("fail-open")).toBe(true);
	});

	test("exhausted maxCalls fail-opens", async () => {
		const store = new RlmStore({ maxCalls: 0 });
		maybeSpill(store, bigCorpus(), 100);
		const result = await rlmQuery(store, "1", "q", async () => "no");
		expect(result.failOpen).toBe(true);
		expect(result.text.includes("maxCalls")).toBe(true);
	});
});

describe("RLM tool wrap", () => {
	test("execute spill replaces oversized text content", async () => {
		const store = new RlmStore();
		const corpus = bigCorpus();
		const tool = wrapToolWithRlmSpill(
			{
				name: "read",
				execute: async () => ({
					content: [{ type: "text" as const, text: corpus }],
					details: {},
				}),
			} as unknown as AgentTool,
			store,
			100,
		);

		const result = await tool.execute("id", {});
		const text = result.content.find(part => part.type === "text");
		expect(text && text.type === "text" ? text.text.includes("[rlm spilled") : false).toBe(true);
		expect(text && text.type === "text" ? text.text.includes(NEEDLE) : true).toBe(false);
	});
});

describe("RlmTool", () => {
	test("createIf is null when disabled", () => {
		const settings = Settings.isolated({ "rlm.enabled": false });
		expect(RlmTool.createIf({ cwd: "/tmp", settings } as ToolSession)).toBeNull();
	});

	test("status and peek round-trip", async () => {
		const settings = Settings.isolated({ "rlm.enabled": true, "rlm.spillBytes": 100 });
		const session = { cwd: "/tmp/rlm-test", settings } as ToolSession;
		const tool = RlmTool.createIf(session);
		expect(tool).not.toBeNull();
		const store = new RlmStore();
		// bind via peek after putting through the session store used by the tool
		const { getRlmStore } = await import("../src/rlm/session");
		const live = getRlmStore(session);
		live.put(bigCorpus(), "test");
		const peek = await tool!.execute("t1", { op: "peek", handle: "rlm://h/1", start: 0, end: 12 });
		const text = peek.content[0];
		expect(text && text.type === "text" ? text.text.includes("rlm://h/1[0:12]") : false).toBe(true);
		expect(store).toBeDefined();
	});
});
