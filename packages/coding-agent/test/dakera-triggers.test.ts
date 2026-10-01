import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	collectTouchedPaths,
	filterTriggerHits,
	parseDakeraTrigger,
	parseDakeraTriggerValue,
	tokenizeTriggerQuery,
	triggerMatches,
} from "@oh-my-pi/pi-coding-agent/dakera/triggers";
import type { DakeraRecallHit } from "@oh-my-pi/pi-coding-agent/dakera/client";

describe("parseDakeraTrigger", () => {
	it("reads metadata.trigger", () => {
		expect(parseDakeraTrigger({ trigger: { keywords: ["changelog"], paths: [] } })).toEqual({
			keywords: ["changelog"],
			paths: [],
		});
	});

	it("returns undefined when absent, non-object, or both arrays are empty", () => {
		expect(parseDakeraTrigger(undefined)).toBeUndefined();
		expect(parseDakeraTrigger({})).toBeUndefined();
		expect(parseDakeraTrigger("trigger")).toBeUndefined();
		expect(parseDakeraTrigger({ trigger: { keywords: [], paths: [] } })).toBeUndefined();
		expect(parseDakeraTrigger({ trigger: "changelog" })).toBeUndefined();
	});

	it("ignores unknown keys and drops junk array entries", () => {
		expect(parseDakeraTrigger({ trigger: { keywords: ["changelog", 42, ""], task: "fix" } })).toEqual({
			keywords: ["changelog"],
			paths: [],
		});
	});

	it("exposes the same contract at the value level for the retain tool", () => {
		expect(parseDakeraTriggerValue({ keywords: ["deploy"], paths: ["docs/**"] })).toEqual({
			keywords: ["deploy"],
			paths: ["docs/**"],
		});
		expect(parseDakeraTriggerValue({ keywords: [], paths: [] })).toBeUndefined();
		expect(parseDakeraTriggerValue(null)).toBeUndefined();
	});
});

describe("tokenizeTriggerQuery", () => {
	it("lowercases and splits on non-letter/non-number runs", () => {
		expect(tokenizeTriggerQuery("Проверь, даты в CHANGELOG!")).toEqual(["проверь", "даты", "в", "changelog"]);
	});

	it("drops empty tokens", () => {
		expect(tokenizeTriggerQuery("...")).toEqual([]);
		expect(tokenizeTriggerQuery("")).toEqual([]);
	});
});

describe("triggerMatches", () => {
	it("hits when any keyword is present in the query tokens", () => {
		const spec = { keywords: ["kubernetes", "changelog"], paths: [] };
		expect(
			triggerMatches(spec, { queryTokens: tokenizeTriggerQuery("проверь даты в changelog"), touchedPaths: [] }),
		).toBe(true);
	});

	it("misses when no keyword matches", () => {
		const spec = { keywords: ["kubernetes"], paths: [] };
		expect(
			triggerMatches(spec, { queryTokens: tokenizeTriggerQuery("проверь даты в changelog"), touchedPaths: [] }),
		).toBe(false);
	});

	it("requires every token of a multi-word keyword", () => {
		const spec = { keywords: ["merge conflict"], paths: [] };
		expect(
			triggerMatches(spec, { queryTokens: tokenizeTriggerQuery("resolve the conflict"), touchedPaths: [] }),
		).toBe(false);
		expect(
			triggerMatches(spec, {
				queryTokens: tokenizeTriggerQuery("how to resolve a merge conflict"),
				touchedPaths: [],
			}),
		).toBe(true);
	});

	it("hits when any path glob matches a touched path", () => {
		const spec = { keywords: [], paths: ["crates/**"] };
		expect(triggerMatches(spec, { queryTokens: [], touchedPaths: ["src/main.ts", "crates/x/y.rs"] })).toBe(true);
	});

	it("ignores invalid glob patterns instead of throwing", () => {
		const spec = { keywords: [], paths: ["[invalid"] };
		expect(triggerMatches(spec, { queryTokens: [], touchedPaths: ["anything.txt"] })).toBe(false);
	});

	it("ANDs the dimensions: a keyword hit with a path miss is no match", () => {
		const spec = { keywords: ["changelog"], paths: ["src/**"] };
		expect(
			triggerMatches(spec, {
				queryTokens: tokenizeTriggerQuery("update the changelog"),
				touchedPaths: ["docs/x.md"],
			}),
		).toBe(false);
		expect(
			triggerMatches(spec, {
				queryTokens: tokenizeTriggerQuery("update the changelog"),
				touchedPaths: ["src/x.ts"],
			}),
		).toBe(true);
	});
});

describe("filterTriggerHits", () => {
	const hit = (id: string, trigger: unknown): DakeraRecallHit =>
		({ memory: { id, content: `row ${id}`, metadata: trigger } }) as DakeraRecallHit;

	it("keeps only rows whose parsed trigger matches, preserving input order", () => {
		const rows = [
			hit("a", { trigger: { keywords: ["kubernetes"] } }),
			hit("b", { trigger: { keywords: ["changelog"] } }),
			hit("c", { trigger: { keywords: ["deploy"] } }),
			hit("d", { trigger: { keywords: [], paths: [] } }),
		];
		const matched = filterTriggerHits(rows, { query: "check the changelog", touchedPaths: [] });
		expect(matched.map(row => row.memory.id)).toEqual(["b"]);
	});
});

describe("collectTouchedPaths", () => {
	let seq = 0;
	const entry = (message: unknown): SessionEntry =>
		({
			type: "message",
			id: `entry-${seq++}`,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message,
		}) as SessionEntry;

	const assistantWith = (...calls: { name: string; path?: unknown }[]): SessionEntry =>
		entry({
			role: "assistant",
			content: calls.map((call, index) => ({
				type: "toolCall",
				id: `call-${seq++}-${index}`,
				name: call.name,
				arguments: { path: call.path },
			})),
		});

	it("collects path arguments of read/edit/write calls, deduped, first-appearance order", () => {
		const paths = collectTouchedPaths([
			assistantWith({ name: "read", path: "src/a.ts" }, { name: "bash" }),
			assistantWith({ name: "grep", path: "pattern" }),
			assistantWith({ name: "edit", path: "src/a.ts" }, { name: "write", path: "docs/b.md" }),
		]);
		expect(paths).toEqual(["src/a.ts", "docs/b.md"]);
	});

	it("skips non-string and missing paths", () => {
		const paths = collectTouchedPaths([
			assistantWith({ name: "read" }, { name: "write", path: 42 }, { name: "edit", path: "" }),
		]);
		expect(paths).toEqual([]);
	});

	it("ignores non-assistant and non-message entries", () => {
		const paths = collectTouchedPaths([
			entry({ role: "user", content: [{ type: "text", text: "hi" }] }),
			{ type: "compaction", id: "c1", parentId: null, timestamp: "", summary: "s" } as unknown as SessionEntry,
		]);
		expect(paths).toEqual([]);
	});
});
