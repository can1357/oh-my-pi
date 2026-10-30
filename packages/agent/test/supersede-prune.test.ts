import { describe, expect, test } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type {
	BranchSummaryEntry,
	CustomMessageEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	type CacheLookbackConfig,
	type ConvertToLlm,
	DEFAULT_PRUNE_CONFIG,
	defaultConvertToLlm,
	type PruneResult,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
	SUPERSEDED_NOTICE,
	type SupersedeCompleteFn,
	type SupersedePruneConfig,
	USELESS_NOTICE,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { ProtectedToolContext } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const tokenizer = new Tokenizer();

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage, timestamp: number): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function toolResultMessage(toolName: string, toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** Assistant toolCall entry + paired toolResult entry for one read. */
function readPair(path: string, text: string, timestamp: number): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `call-${idCounter++}`;
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: "read", arguments: { path } }], timestamp),
			timestamp,
		),
		messageEntry(toolResultMessage("read", callId, text, timestamp), timestamp),
	];
}

/** Read pair whose result {@link testComplete} reports as incomplete (a summary, page, or notice). */
function partialPair(path: string, timestamp: number): [SessionMessageEntry, SessionMessageEntry] {
	const [call, result] = readPair(path, FILE_CONTENT, timestamp);
	resultMessage(result).details = { complete: false };
	return [call, result];
}

/** Test completeness: incomplete only when marked by {@link partialPair}. */
const testComplete: SupersedeCompleteFn = message =>
	(message.details as { complete?: boolean } | undefined)?.complete !== false;

/** Assistant toolCall entry + paired toolResult entry flagged contextually useless. */
function uselessPair(
	toolName: string,
	text: string,
	timestamp: number,
	extra: Partial<ToolResultMessage> = {},
): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `call-${idCounter++}`;
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: toolName, arguments: { pattern: "zzz" } }], timestamp),
			timestamp,
		),
		messageEntry({ ...toolResultMessage(toolName, callId, text, timestamp), useless: true, ...extra }, timestamp),
	];
}

function textEntry(text: string, timestamp: number): SessionMessageEntry {
	return messageEntry(assistantMessage([{ type: "text", text }], timestamp), timestamp);
}

function resultText(entry: SessionEntry): string {
	const message = (entry as SessionMessageEntry).message as ToolResultMessage;
	return (message.content[0] as TextContent).text;
}

function resultMessage(entry: SessionEntry): ToolResultMessage {
	return (entry as SessionMessageEntry).message as ToolResultMessage;
}

function cfg(over: Partial<SupersedePruneConfig> = {}): SupersedePruneConfig {
	return { supersedeKey: readToolSupersedeKey, protectedTools: [], ...over };
}

/** Supersede-only run of one path with {@link testComplete}: the per-turn stale pass, or overflow pruning with age/size pruning disabled. */
function pruneWith(mode: "stale" | "overflow", entries: SessionEntry[], now: number): PruneResult {
	return mode === "stale"
		? pruneSupersededToolResults(entries, tokenizer, cfg({ supersedeComplete: testComplete, now }))
		: pruneToolOutputs(entries, tokenizer, {
				protectTokens: 1_000_000,
				minimumSavings: 0,
				protectedTools: [],
				supersedeKey: readToolSupersedeKey,
				supersedeComplete: testComplete,
			});
}

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);
const FILE_CONTENT = "export function alpha() { return 1; }\n".repeat(50);
// Comfortably above any small suffixTokenLimit used below.
const BIG_TEXT = "const value = computeSomething(12345);\n".repeat(500);
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==";
const anthropicModel = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

describe("readToolSupersedeKey", () => {
	test("bare path keys on itself; non-read and non-string paths are exempt", () => {
		expect(readToolSupersedeKey("read", { path: "src/foo.ts" })).toBe("src/foo.ts");
		expect(readToolSupersedeKey("bash", { path: "src/foo.ts" })).toBeUndefined();
		expect(readToolSupersedeKey("read", { path: 42 })).toBeUndefined();
		expect(readToolSupersedeKey("read", {})).toBeUndefined();
	});

	test("URL/internal schemes are exempt", () => {
		expect(readToolSupersedeKey("read", { path: "skill://react" })).toBeUndefined();
		expect(readToolSupersedeKey("read", { path: "https://example.com/page" })).toBeUndefined();
	});

	test("keys line-range selectors under the bare path and alternate forms apart from it", () => {
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:50-200" })).toBe("src/foo.ts\u000050-200");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:5-16,960-973" })).toBe("src/foo.ts\u00005-16,960-973");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:50+150" })).toBe("src/foo.ts\u000050+150");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:raw" })).toBe("src/foo.ts\u0001raw");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:conflicts" })).toBe("src/foo.ts\u0001conflicts");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:2-4:raw" })).toBe("src/foo.ts\u00012-4:raw");
	});

	test("does not strip non-selector colon segments", () => {
		expect(readToolSupersedeKey("read", { path: "db.sqlite:users" })).toBe("db.sqlite:users");
		expect(readToolSupersedeKey("read", { path: "db.sqlite:users:42" })).toBe("db.sqlite:users\u000042");
	});
});

describe("pruneSupersededToolResults — tail case", () => {
	test("(a) older identical-path read pruned with exact placeholder when suffix small", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(result.tokensSaved).toBeGreaterThan(0);
		expect(resultText(result1)).toBe("[Superseded by a newer read of this file]");
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultMessage(result1).prunedAt).toBeDefined();
		// Latest read untouched.
		expect(resultText(result2)).toBe(FILE_CONTENT);
		expect(resultMessage(result2).prunedAt).toBeUndefined();
	});

	test("(b) NOT pruned when suffix exceeds limit and no idle gap", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const big = textEntry(BIG_TEXT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, big];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ suffixTokenLimit: 200, now: T0 + 2_000 }));

		expect(result.prunedCount).toBe(0);
		expect(result.tokensSaved).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("(c) idle gap prunes all candidates regardless of suffix", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/bar.ts", FILE_CONTENT, T0 + 1_000);
		const [call3, result3] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000);
		const [call4, result4] = readPair("src/bar.ts", FILE_CONTENT, T0 + 3_000);
		const big = textEntry(BIG_TEXT, T0 + 4_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3, call4, result4, big];

		// Suffix limit 0 would block every candidate; only the idle gap fires.
		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({ suffixTokenLimit: 0, idleFlushMs: 30 * 60_000, now: T0 + 4_000 + 30 * 60_000 }),
		);

		expect(result.prunedCount).toBe(2);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result3)).toBe(FILE_CONTENT);
		expect(resultText(result4)).toBe(FILE_CONTENT);
	});

	test("no idle flush when gap is below the threshold", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const big = textEntry(BIG_TEXT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, big];

		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({ suffixTokenLimit: 0, idleFlushMs: 30 * 60_000, now: T0 + 2_000 + 29 * 60_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("resolves a sent result's tool call that sits before the compaction boundary", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		// Boundary between call1 and result1: call1 is only reachable via the prefix lookup.
		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({ keepBoundaryId: result1.id, now: T0 + 1_000 }),
		);

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});
});

describe("pruneSupersededToolResults — selectors", () => {
	test("(d) different range selectors do not supersede each other; a later selector-free read supersedes them", () => {
		const [callA, resultA] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0);
		const [callB, resultB] = readPair("src/foo.ts:10-20", FILE_CONTENT, T0 + 1_000);
		let entries: SessionEntry[] = [callA, resultA, callB, resultB];

		// Different selectors: no candidates.
		let result = pruneSupersededToolResults(entries, tokenizer, cfg({ now: T0 + 1_000 }));
		expect(result.prunedCount).toBe(0);
		expect(resultText(resultA)).toBe(FILE_CONTENT);
		expect(resultText(resultB)).toBe(FILE_CONTENT);

		// Identical selector strings DO supersede.
		const [callA2, resultA2] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0 + 2_000);
		entries = [...entries, callA2, resultA2];
		result = pruneSupersededToolResults(entries, tokenizer, cfg({ now: T0 + 2_000 }));
		expect(result.prunedCount).toBe(1);
		expect(resultText(resultA)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultB)).toBe(FILE_CONTENT);
		expect(resultText(resultA2)).toBe(FILE_CONTENT);

		// A later selector-free read supersedes every selector-carrying read of the base path.
		const [callFull, resultFull] = readPair("src/foo.ts", FILE_CONTENT, T0 + 3_000);
		entries = [...entries, callFull, resultFull];
		result = pruneSupersededToolResults(entries, tokenizer, cfg({ now: T0 + 3_000 }));
		expect(result.prunedCount).toBe(2);
		expect(resultText(resultB)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultA2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultFull)).toBe(FILE_CONTENT);
	});

	test("a selector-carrying read does NOT supersede an earlier selector-free read", () => {
		const [callFull, resultFull] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [callRange, resultRange] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [callFull, resultFull, callRange, resultRange];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(resultFull)).toBe(FILE_CONTENT);
		expect(resultText(resultRange)).toBe(FILE_CONTENT);
	});
});

for (const mode of ["stale", "overflow"] as const) {
	describe(`${mode} pruning — completeness`, () => {
		test.each([
			{
				name: "an incomplete bare read keeps an earlier range",
				older: "src/foo.ts:50-200",
				newer: "src/foo.ts",
				partial: true,
				pruned: 0,
			},
			{
				name: "a complete bare read replaces an earlier range",
				older: "src/foo.ts:50-200",
				newer: "src/foo.ts",
				partial: false,
				pruned: 1,
			},
			{
				name: "a complete bare read keeps an earlier raw read",
				older: "src/foo.ts:raw",
				newer: "src/foo.ts",
				partial: false,
				pruned: 0,
			},
			{
				name: "an incomplete same-selector re-read replaces the older copy",
				older: "src/foo.ts:50-200",
				newer: "src/foo.ts:50-200",
				partial: true,
				pruned: 1,
			},
		])("$name", ({ older, newer, partial, pruned }) => {
			const [call1, result1] = readPair(older, FILE_CONTENT, T0);
			const [call2, result2] = partial ? partialPair(newer, T0 + 1_000) : readPair(newer, FILE_CONTENT, T0 + 1_000);
			const entries: SessionEntry[] = [call1, result1, call2, result2];

			const result = pruneWith(mode, entries, T0 + 1_000);

			expect(result.prunedCount).toBe(pruned);
			expect(resultText(result1)).toBe(pruned ? SUPERSEDED_NOTICE : FILE_CONTENT);
			expect(resultText(result2)).toBe(FILE_CONTENT);
		});

		test("a complete bare read replaced by a newer summary cannot erase an earlier range", () => {
			const [call1, result1] = readPair("src/foo.ts:1-20", FILE_CONTENT, T0);
			const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
			const [call3, result3] = partialPair("src/foo.ts", T0 + 2_000);
			const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3];

			const result = pruneWith(mode, entries, T0 + 2_000);

			expect(result.prunedCount).toBe(1);
			expect(resultText(result1)).toBe(FILE_CONTENT);
			expect(resultText(result2)).toBe(SUPERSEDED_NOTICE);
			expect(resultText(result3)).toBe(FILE_CONTENT);
		});

		test("a newer error keeps an earlier success but replaces an earlier error", () => {
			const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
			const [call2, result2] = readPair("src/foo.ts", "Error: EACCES", T0 + 1_000);
			resultMessage(result2).isError = true;
			const [call3, result3] = readPair("src/foo.ts", "Error: EACCES", T0 + 2_000);
			resultMessage(result3).isError = true;
			const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3];

			const result = pruneWith(mode, entries, T0 + 2_000);

			expect(result.prunedCount).toBe(1);
			expect(resultText(result1)).toBe(FILE_CONTENT);
			expect(resultText(result2)).toBe(SUPERSEDED_NOTICE);
		});

		test("an earlier failed range read is replaced by a later incomplete bare read", () => {
			const [call1, result1] = readPair("src/foo.ts:50-200", "Error: ENOENT", T0);
			resultMessage(result1).isError = true;
			const [call2, result2] = partialPair("src/foo.ts", T0 + 1_000);
			const entries: SessionEntry[] = [call1, result1, call2, result2];

			const result = pruneWith(mode, entries, T0 + 1_000);

			expect(result.prunedCount).toBe(1);
			expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		});
	});
}

describe("pruneSupersededToolResults — protection & latest", () => {
	test("(e) latest read never pruned, even with idle flush", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const [call3, result3] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ now: T0 + 2_000 + 60 * 60_000 }));

		expect(result.prunedCount).toBe(2);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result3)).toBe(FILE_CONTENT);
		expect(resultMessage(result3).prunedAt).toBeUndefined();
	});

	test("(f) protected tool results never pruned", () => {
		const protectPlan = ({ toolCall }: ProtectedToolContext): boolean =>
			(toolCall?.arguments as Record<string, unknown> | undefined)?.path === "plan.md";
		const [planCall1, planResult1] = readPair("plan.md", FILE_CONTENT, T0);
		const [fooCall1, fooResult1] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const [planCall2, planResult2] = readPair("plan.md", FILE_CONTENT, T0 + 2_000);
		const [fooCall2, fooResult2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 3_000);
		const entries: SessionEntry[] = [
			planCall1,
			planResult1,
			fooCall1,
			fooResult1,
			planCall2,
			planResult2,
			fooCall2,
			fooResult2,
		];

		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({ protectedTools: [protectPlan], now: T0 + 3_000 }),
		);

		expect(result.prunedCount).toBe(1);
		expect(resultText(planResult1)).toBe(FILE_CONTENT);
		expect(resultText(planResult2)).toBe(FILE_CONTENT);
		expect(resultText(fooResult1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(fooResult2)).toBe(FILE_CONTENT);
	});

	test("already-pruned results are ignored as candidates and as superseders", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		resultMessage(result2).prunedAt = T0 + 1_500;
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		// The only newer same-key read is itself pruned -> result1 has no live superseder.
		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ now: T0 + 2_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
	});
});

describe("pruneToolOutputs — supersede priority fold", () => {
	test("with supersedeKey, superseded results bypass the protect window and get the supersede placeholder", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneToolOutputs(entries, tokenizer, {
			protectTokens: 1_000_000, // everything inside the protect window
			minimumSavings: 0,
			protectedTools: [],
			supersedeKey: readToolSupersedeKey,
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("(g) without supersedeKey, behavior is unchanged (regression guard)", () => {
		const buildEntries = (): {
			entries: SessionEntry[];
			oldResult: SessionMessageEntry;
			newResult: SessionMessageEntry;
		} => {
			const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
			const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
			return { entries: [call1, result1, call2, result2], oldResult: result1, newResult: result2 };
		};

		// Protect window covers everything: nothing pruned, superseded reads included.
		const protectedFixture = buildEntries();
		const protectedRun = pruneToolOutputs(protectedFixture.entries, tokenizer, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
		});
		expect(protectedRun).toMatchObject({ prunedCount: 0, tokensSaved: 0 });
		expect(resultText(protectedFixture.oldResult)).toBe(FILE_CONTENT);
		expect(resultText(protectedFixture.newResult)).toBe(FILE_CONTENT);

		// Protect window empty: every result past it pruned with the legacy
		// truncation placeholder — never the supersede placeholder.
		const unprotectedFixture = buildEntries();
		const unprotectedRun = pruneToolOutputs(unprotectedFixture.entries, tokenizer, {
			protectTokens: 0,
			minimumSavings: 0,
			protectedTools: [],
		});
		expect(unprotectedRun.prunedCount).toBe(2);
		expect(resultText(unprotectedFixture.oldResult)).toMatch(/^\[Output truncated - \d+ tokens\]$/);
		expect(resultText(unprotectedFixture.newResult)).toMatch(/^\[Output truncated - \d+ tokens\]$/);

		// Default config shape is untouched.
		expect(DEFAULT_PRUNE_CONFIG.supersedeKey).toBeUndefined();
		expect(DEFAULT_PRUNE_CONFIG.protectTokens).toBe(40_000);
		expect(DEFAULT_PRUNE_CONFIG.minimumSavings).toBe(20_000);
	});
});

// Large enough to clear the size guard (blanking must save tokens over the notice).
const NO_MATCH_TEXT = "No matches found in any of the scanned files.\n".repeat(10);

describe("pruneSupersededToolResults — useless results", () => {
	test("(a) useless result blanked to exact notice on idle flush", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const big = textEntry(BIG_TEXT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, big];

		// Suffix limit 0 blocks the tail rule; only the idle gap fires.
		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({ pruneUseless: true, suffixTokenLimit: 0, now: T0 + 1_000 + 31 * 60_000 }),
		);

		expect(result.prunedCount).toBe(1);
		expect(result.tokensSaved).toBeGreaterThan(0);
		expect(resultText(result1)).toBe(USELESS_NOTICE);
		expect(resultMessage(result1).prunedAt).toBeDefined();
	});

	test("(b) blanked under the suffix rule near the tail", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ pruneUseless: true, now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(USELESS_NOTICE);
	});

	test("(c) NOT blanked when suffix large and not idle", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const big = textEntry(BIG_TEXT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, big];

		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({ pruneUseless: true, suffixTokenLimit: 200, now: T0 + 2_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
		expect(resultMessage(result1).prunedAt).toBeUndefined();
	});

	test("(d) tiny useless result never blanked (notice would cost more than it saves)", () => {
		const [call1, result1] = uselessPair("search", "No matches found", T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ pruneUseless: true, now: T0 + 31 * 60_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe("No matches found");
	});

	test("(e) protected matcher exempts a useless result", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({ pruneUseless: true, protectedTools: ["search"], now: T0 + 31 * 60_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
	});

	test("(f) prunes useless results without a supersedeKey", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(entries, tokenizer, {
			protectedTools: [],
			pruneUseless: true,
			now: T0 + 1_000,
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(USELESS_NOTICE);
	});

	test("(g) a result both superseded and useless gets the supersede notice", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		(resultMessage(result1) as ToolResultMessage).useless = true;
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ pruneUseless: true, now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("never blanks an error result even when flagged", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0, { isError: true });
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ pruneUseless: true, now: T0 + 31 * 60_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
	});
});

describe("pruneToolOutputs — useless results", () => {
	test("(h) useless result inside the protect window blanked; non-flagged neighbor kept", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneToolOutputs(entries, tokenizer, {
			protectTokens: 1_000_000, // everything inside the protect window
			minimumSavings: 0,
			protectedTools: [],
			pruneUseless: true,
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(USELESS_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("pruneUseless: false leaves flagged results to the normal window rules", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneToolOutputs(entries, tokenizer, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
			pruneUseless: false,
		});

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
	});
});

describe("pruneToolOutputs — small-result floor", () => {
	test("sub-floor results are left intact while a large neighbor is pruned", () => {
		// "ok" is ~1 token: blanking it to `[Output truncated - 1 tokens]` would
		// grow the context, so the floor must keep it. The large neighbor still prunes.
		const [tinyCall, tinyResult] = readPair("src/tiny.ts", "ok", T0);
		const [bigCall, bigResult] = readPair("src/big.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [tinyCall, tinyResult, bigCall, bigResult];

		// Protect window empty and zero savings threshold: only size keeps the tiny one.
		const result = pruneToolOutputs(entries, tokenizer, { protectTokens: 0, minimumSavings: 0, protectedTools: [] });

		expect(result.prunedCount).toBe(1);
		expect(resultText(tinyResult)).toBe("ok");
		expect(resultMessage(tinyResult).prunedAt).toBeUndefined();
		expect(resultText(bigResult)).toMatch(/^\[Output truncated - \d+ tokens\]$/);
		expect(resultMessage(bigResult).prunedAt).toBeDefined();
	});
});

describe("cache-stable boundary — warm prefix protection", () => {
	// (a) The primary bug: in pruneToolOutputs a superseded result bypasses the
	// protect window and is rewritten at any depth. With the cache guard armed it
	// must be left alone when it sits in the warm, already-sent cached prefix.
	test("(a) deep superseded result is rewritten WITHOUT the guard but kept WITH it", () => {
		const build = (): { entries: SessionEntry[]; result1: SessionMessageEntry; result2: SessionMessageEntry } => {
			const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
			const big = textEntry(BIG_TEXT, T0 + 500); // pushes result1 deep into the suffix
			const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000); // tail, supersedes result1
			return { entries: [call1, result1, big, call2, result2], result1, result2 };
		};
		const base = {
			protectTokens: 1_000_000, // everything inside the (age) protect window
			minimumSavings: 0,
			protectedTools: [],
			supersedeKey: readToolSupersedeKey,
		};

		// Legacy (no cacheWarmSuffixTokens): superseded result1 bypasses the window -> pruned.
		const legacy = build();
		const legacyRun = pruneToolOutputs(legacy.entries, tokenizer, base);
		expect(legacyRun.prunedCount).toBe(1);
		expect(resultText(legacy.result1)).toBe(SUPERSEDED_NOTICE);

		// Guard armed: result1's all-message suffix (BIG_TEXT + call2 + result2) far
		// exceeds the window, so it is part of the warm cached prefix and is kept.
		const guarded = build();
		const guardedRun = pruneToolOutputs(guarded.entries, tokenizer, { ...base, cacheWarmSuffixTokens: 200 });
		expect(guardedRun.prunedCount).toBe(0);
		expect(resultText(guarded.result1)).toBe(FILE_CONTENT);
		expect(resultMessage(guarded.result1).prunedAt).toBeUndefined();
	});

	test("(a) deep useless result is kept when the cache guard is armed", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const big = textEntry(BIG_TEXT, T0 + 500);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, big, call2, result2];

		const result = pruneToolOutputs(entries, tokenizer, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
			pruneUseless: true,
			cacheWarmSuffixTokens: 200,
		});

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	// (b) The legit case must still fire: a superseded copy in the cheap-to-recache
	// tail (suffix below the window) is still reclaimed.
	test("(b) tail-case superseded result still prunes with the guard armed", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneToolOutputs(entries, tokenizer, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
			supersedeKey: readToolSupersedeKey,
			cacheWarmSuffixTokens: 100_000, // result1's suffix is far below this -> tail -> prunable
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("(b) supersede pass still prunes the tail case with keepBoundaryId set", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneSupersededToolResults(entries, tokenizer, cfg({ keepBoundaryId: call1.id, now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	// (c) Entries before firstKeptEntryId are summarized away — never sent — so no
	// pass may mutate them, not even the idle full-flush.
	test("(c) idle flush never mutates entries before keepBoundaryId", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0); // idx 0,1 — before boundary
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000); // idx 2,3 — boundary at call2
		const [call3, result3] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000); // idx 4,5 — latest
		const big = textEntry(BIG_TEXT, T0 + 3_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3, big];

		// Cold cache (idle > threshold) with suffixTokenLimit 0: only the idle path can fire.
		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({
				keepBoundaryId: call2.id,
				suffixTokenLimit: 0,
				idleFlushMs: 30 * 60_000,
				now: T0 + 3_000 + 31 * 60_000,
			}),
		);

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(FILE_CONTENT); // before boundary -> untouched
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultText(result2)).toBe(SUPERSEDED_NOTICE); // at/after boundary -> flushed
		expect(resultText(result3)).toBe(FILE_CONTENT); // latest -> kept
	});

	test("(c) pruneToolOutputs never mutates entries before keepBoundaryId", () => {
		const [call1, result1] = readPair("src/old.ts", FILE_CONTENT, T0); // idx 0,1 — before boundary
		const [call2, result2] = readPair("src/new.ts", FILE_CONTENT, T0 + 1_000); // idx 2,3 — boundary at call2
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		// protectTokens 0 -> the age path would prune both; the window is wide so the
		// guard does not protect either; only keepBoundaryId shields result1.
		pruneToolOutputs(entries, tokenizer, {
			protectTokens: 0,
			minimumSavings: 0,
			protectedTools: [],
			keepBoundaryId: call2.id,
			cacheWarmSuffixTokens: 1_000_000,
		});

		expect(resultText(result1)).toBe(FILE_CONTENT); // before boundary -> untouched
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultMessage(result2).prunedAt).toBeDefined(); // at/after boundary, in tail -> pruned
	});
});

/** `count` small, unkeyed bash call/result pairs: many content blocks, few tokens. */
function smallTurns(count: number, timestamp: number): SessionMessageEntry[] {
	const turns: SessionMessageEntry[] = [];
	for (let turn = 0; turn < count; turn++) {
		const callId = `call-${idCounter++}`;
		turns.push(
			messageEntry(
				assistantMessage(
					[{ type: "toolCall", id: callId, name: "bash", arguments: { command: "true" } }],
					timestamp,
				),
				timestamp,
			),
			messageEntry(toolResultMessage("bash", callId, "ok", timestamp), timestamp),
		);
	}
	return turns;
}

describe("warm-cache guard — prompt-cache lookback window", () => {
	/** Anthropic's lookback, as `prompt-cache-lookback` resolves it for Claude. */
	const ANTHROPIC_LOOKBACK: CacheLookbackConfig = { cacheLookbackPositions: 20 };

	/** Per-turn supersede pass and cache-guarded prune pass, each run on fresh entries. */
	function passes(lookback: CacheLookbackConfig): Array<(entries: SessionEntry[]) => PruneResult> {
		return [
			entries => pruneSupersededToolResults(entries, tokenizer, cfg({ now: T0 + 3_000, ...lookback })),
			entries =>
				pruneToolOutputs(entries, tokenizer, {
					protectTokens: 1_000_000,
					minimumSavings: 0,
					protectedTools: [],
					supersedeKey: readToolSupersedeKey,
					cacheWarmSuffixTokens: 8_000,
					...lookback,
				}),
		];
	}
	const guardedPasses = passes(ANTHROPIC_LOOKBACK);

	test("idle flush still prunes beyond the lookback window once the cache is cold", () => {
		// 12 small turns put 28 stored positions behind the stale read's issuing turn.
		const [call1, stale] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, latest] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000);
		const entries = [call1, stale, ...smallTurns(12, T0 + 1_000), call2, latest];

		const result = pruneSupersededToolResults(
			entries,
			tokenizer,
			cfg({ now: T0 + 2_000 + 31 * 60_000, ...ANTHROPIC_LOOKBACK }),
		);

		expect(result.prunedCount).toBe(1);
		expect(resultText(stale)).toBe(SUPERSEDED_NOTICE);
	});

	test("a model without a known lookback bound prunes past the Anthropic window", () => {
		for (const pass of passes({})) {
			const { stale, entries } = staleReadAround([], smallTurns(12, T0 + 1_000));

			expect(pass(entries).prunedCount).toBe(1);
			expect(resultText(stale)).toBe(SUPERSEDED_NOTICE);
		}
	});

	test("branch summaries count toward the lookback window in both passes", () => {
		// Each branch summary replays as one user block: 18 of them plus the newer
		// read put the stale result 20 blocks back with almost no tokens after it.
		for (const pass of guardedPasses) {
			const summaries = Array.from({ length: 18 }, (_, index): BranchSummaryEntry => ({
				type: "branch_summary",
				id: nextId(),
				parentId: null,
				timestamp: new Date(T0 + 1_000 + index).toISOString(),
				fromId: `branch-${index}`,
				summary: "Tried another approach; abandoned.",
			}));
			const { stale, entries } = staleReadAround([], summaries);

			expect(pass(entries).prunedCount).toBe(0);
			expect(resultText(stale)).toBe(FILE_CONTENT);
		}
	});

	test("counts app messages as convertToLlm projects them", () => {
		// The stale read sits 12 positions back before the attachment. The core
		// projection sends the attachment as one developer block (13: prunes); an
		// app projection that splits off its images, as the coding agent does for
		// file mentions, sends developer [text] + user [text, image, image] (16).
		const attachment = (): CustomMessageEntry => ({
			type: "custom_message",
			id: nextId(),
			parentId: null,
			timestamp: new Date(T0 + 1_500).toISOString(),
			customType: "attachment",
			content: [{ type: "text", text: "shot.png" }],
			display: true,
		});
		const image: ImageContent = { type: "image", data: PNG_1X1, mimeType: "image/png" };
		const splitImages: ConvertToLlm = messages =>
			messages.flatMap((message): Message[] =>
				message.role === "custom"
					? [
							{ role: "developer", content: [{ type: "text", text: "shot.png" }], timestamp: message.timestamp },
							{
								role: "user",
								content: [{ type: "text", text: "Images attached." }, image, image],
								timestamp: message.timestamp,
							},
						]
					: defaultConvertToLlm([message]),
			);
		for (const pass of guardedPasses) {
			const inReach = staleReadAround([], [...smallTurns(4, T0 + 1_000), attachment()]);
			expect(pass(inReach.entries).prunedCount).toBe(1);
		}
		for (const pass of passes({ ...ANTHROPIC_LOOKBACK, convertToLlm: splitImages })) {
			const outOfReach = staleReadAround([], [...smallTurns(4, T0 + 1_000), attachment()]);
			expect(pass(outOfReach.entries).prunedCount).toBe(0);
			expect(resultText(outOfReach.stale)).toBe(FILE_CONTENT);
		}
	});

	/** Stale read issued by an assistant turn of `before` blocks, followed by `after` entries and a newer read. */
	function staleReadAround(
		before: AssistantMessage["content"],
		after: SessionEntry[],
	): { stale: SessionMessageEntry; entries: SessionEntry[] } {
		const callId = `call-${idCounter++}`;
		const call1 = messageEntry(
			assistantMessage(
				[...before, { type: "toolCall", id: callId, name: "read", arguments: { path: "src/foo.ts" } }],
				T0,
			),
			T0,
		);
		const stale = messageEntry(toolResultMessage("read", callId, FILE_CONTENT, T0), T0);
		const [call2, latest] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000);
		return { stale, entries: [call1, stale, ...after, call2, latest] };
	}

	function userEntry(): SessionMessageEntry {
		return messageEntry({ role: "user", content: "Keep going.", timestamp: T0 + 1_000 }, T0 + 1_000);
	}

	/** Lookback positions the Anthropic request converter emits for `entries`. */
	function wirePositions(entries: SessionEntry[], nextInput?: Message): number {
		const messages = entries.map(entry => (entry as SessionMessageEntry).message as Message);
		if (nextInput) messages.push(nextInput);
		let positions = 0;
		let later: string | undefined;
		for (const param of convertAnthropicMessages(messages, anthropicModel, false)) {
			for (const block of typeof param.content === "string" ? [{ type: "text" }] : param.content) {
				if ((block.type !== "tool_use" && block.type !== "tool_result") || block.type !== later) positions++;
				later = block.type;
			}
		}
		return positions;
	}

	test("counts the issuing assistant turn: [text, tool_use] + result + 16 positions + prompt is out of reach", () => {
		// The newest cache entry surviving the rewrite ends the message before the
		// issuing turn, so its two blocks count too: 2 + 1 + 16 + 1 = 20 positions.
		const text = { type: "text" as const, text: "Reading it." };
		for (const pass of guardedPasses) {
			const outOfReach = staleReadAround([text], smallTurns(7, T0 + 1_000));
			expect(wirePositions(outOfReach.entries)).toBe(19);
			expect(pass(outOfReach.entries).prunedCount).toBe(0);
			expect(resultText(outOfReach.stale)).toBe(FILE_CONTENT);
		}
	});

	test("reserves room for a multi-block next input", () => {
		// 18 stored positions plus a next prompt carrying a prepended date/cwd
		// reminder put the surviving entry 21 positions back from the tail.
		const nextInput: Message = {
			role: "user",
			content: [
				{ type: "text", text: "Current date: 2026-10-08" },
				{ type: "text", text: "Next step." },
			],
			timestamp: T0 + 3_000,
		};
		const text = { type: "text" as const, text: "Reading it." };
		for (const pass of guardedPasses) {
			const { stale, entries } = staleReadAround([text], [...smallTurns(6, T0 + 1_000), userEntry()]);
			expect(wirePositions(entries, nextInput)).toBe(20);

			expect(pass(entries).prunedCount).toBe(0);
			expect(resultText(stale)).toBe(FILE_CONTENT);
		}
	});

	test("13 stored positions prune and 14 do not, leaving room for input and unmodelled projections", () => {
		const text = { type: "text" as const, text: "Reading it." };
		for (const pass of guardedPasses) {
			const inReach = staleReadAround([text], smallTurns(4, T0 + 1_000));
			expect(wirePositions(inReach.entries)).toBe(13);
			expect(pass(inReach.entries).prunedCount).toBe(1);
			expect(resultText(inReach.stale)).toBe(SUPERSEDED_NOTICE);

			const outOfReach = staleReadAround([text], [...smallTurns(4, T0 + 1_000), userEntry()]);
			expect(wirePositions(outOfReach.entries)).toBe(14);
			expect(pass(outOfReach.entries).prunedCount).toBe(0);
			expect(resultText(outOfReach.stale)).toBe(FILE_CONTENT);
		}
	});

	test("counts images an error result hoists out of its tool_result block", () => {
		// Anthropic takes images out of error results and appends a text block plus
		// each image after the result run: one stored result, three positions.
		for (const pass of guardedPasses) {
			const [failedCall, failed] = readPair("src/shot.png", "render failed", T0 + 1_000);
			resultMessage(failed).isError = true;
			resultMessage(failed).content.push({ type: "image", data: PNG_1X1, mimeType: "image/png" });
			const { stale, entries } = staleReadAround([], [...smallTurns(3, T0 + 1_000), failedCall, failed]);
			expect(wirePositions(entries)).toBe(14);

			expect(pass(entries).prunedCount).toBe(0);
			expect(resultText(stale)).toBe(FILE_CONTENT);
		}
	});

	test("counts the user turn the converter inserts between consecutive assistant turns", () => {
		for (const pass of guardedPasses) {
			const { stale, entries } = staleReadAround([], [...smallTurns(4, T0 + 1_000), textEntry("Done.", T0 + 1_000)]);
			expect(wirePositions(entries)).toBe(14);

			expect(pass(entries).prunedCount).toBe(0);
			expect(resultText(stale)).toBe(FILE_CONTENT);
		}
	});

	test("assistant images and blank text, which the converter drops, do not count", () => {
		const dropped: AssistantMessage["content"] = [
			{ type: "image", data: PNG_1X1, mimeType: "image/png" },
			{ type: "text", text: "  " },
		];
		for (const pass of guardedPasses) {
			const { stale, entries } = staleReadAround(dropped, smallTurns(4, T0 + 1_000));
			expect(wirePositions(entries)).toBe(12);

			expect(pass(entries).prunedCount).toBe(1);
			expect(resultText(stale)).toBe(SUPERSEDED_NOTICE);
		}
	});

	test("a parallel batch counts as runs, not one position per tool block", () => {
		// [text, 8 tool_use] + 8 tool_result is 3 positions, so the stale read's
		// rewrite needs 1 + 1 + 3 + 1 + 1 = 7 positions, not 21.
		for (const pass of guardedPasses) {
			const callIds = Array.from({ length: 8 }, () => `call-${idCounter++}`);
			const batch = [
				messageEntry(
					assistantMessage(
						[
							{ type: "text", text: "Checking everything at once." },
							...callIds.map(id => ({
								type: "toolCall" as const,
								id,
								name: "bash",
								arguments: { command: "true" },
							})),
						],
						T0 + 1_000,
					),
					T0 + 1_000,
				),
				...callIds.map(id => messageEntry(toolResultMessage("bash", id, "ok", T0 + 1_000), T0 + 1_000)),
			];
			const { stale, entries } = staleReadAround([], batch);
			expect(wirePositions(entries)).toBe(7);

			expect(pass(entries).prunedCount).toBe(1);
			expect(resultText(stale)).toBe(SUPERSEDED_NOTICE);
		}
	});
});
