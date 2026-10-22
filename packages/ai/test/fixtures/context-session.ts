import type { ContextJournalEntry, ContextSnapshotDetails } from "../../src/context-insights";

export const CONTEXT_FIXTURE_CWD = "/work/context-fixture";
export const CONTEXT_FIXTURE_SESSION_ID = "context-parity-session";
const timestamp = "2026-10-21T00:00:00.000Z";
const details: ContextSnapshotDetails = {
	contextWindow: 1000,
	categories: { systemPrompt: 20, systemTools: 30, systemContext: 10, skills: 20, messages: 40 },
	toolSchemas: [{ name: "read", tokens: 30 }],
	skills: [{ name: "fixture-skill", tokens: 20 }],
	systemPromptParts: [20],
	messageCount: 4,
	pendingMessageTokens: 0,
};

function step(id: string, promptTokens: number, content: unknown[] = [], legacy = false): ContextJournalEntry {
	return {
		type: "message",
		id,
		timestamp,
		message: {
			role: "assistant",
			model: id === "a1" ? "model-a" : "model-b",
			provider: "test",
			timestamp: Date.parse(timestamp),
			usage: { input: promptTokens, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
			content,
			...(legacy ? {} : { contextSnapshot: { promptTokens, nonMessageTokens: 80, toolSchemaTokens: 30, details } }),
		},
	};
}

/** One six-step journal shared by fold/live/journal consumers; stale siblings and late usage are deliberate. */
export function contextSessionFixture() {
	const branch: ContextJournalEntry[] = [
		step("a1", 120, [
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "./src/../a.ts:2-4:raw" } },
			{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "b.ts", content: "a\nb\n" } },
			{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "search-1", name: "grep", arguments: { path: "a.ts", pattern: "needle" } },
		]),
		{
			type: "message",
			id: "read-result",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				details: { totalLines: 10, fileSize: 100 },
				prunedAt: Date.parse(timestamp),
			},
		},
		{
			type: "message",
			id: "write-result",
			timestamp,
			message: { role: "toolResult", toolCallId: "write-1", toolName: "write", details: { resolvedPath: "b.ts" } },
		},
		{
			type: "message",
			id: "edit-result",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "edit-1",
				toolName: "edit",
				details: { diff: "--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new\n" },
			},
		},
		{
			type: "message",
			id: "search-result",
			timestamp,
			message: { role: "toolResult", toolCallId: "search-1", toolName: "grep" },
		},
		{ type: "compaction", id: "compact", timestamp, tokensBefore: 240, tokensAfter: 100 },
		{ type: "ttsr_injection", id: "inject", timestamp, injectedRules: ["fixture-rule"] },
		{ type: "model_change", id: "switch", timestamp, model: "model-b", role: "default" },
		step("a2", 100),
		{ type: "reset_boundary", id: "reset", timestamp },
		step("a3", 80),
		step("a4", 60, [], true),
		step("a5", 40, [{ type: "toolCall", id: "unfinished", name: "read", arguments: { path: "pending.ts" } }]),
		step("a6", 20),
		{ type: "custom_message", id: "trailing", timestamp, customType: "system-reminder", content: "not returned" },
	];
	// A persisted zero-weight capture with 21 source parts absorbed into 20 slots.
	const last = branch.find(entry => entry.id === "a6")!;
	last.message!.contextSnapshot!.details = {
		...details,
		categories: { systemPrompt: 0, systemTools: 0, systemContext: 0, skills: 0, messages: 0 },
		toolSchemas: [],
		skills: [],
		systemPromptParts: Array(20).fill(0),
		systemPromptPartsOmitted: 1,
	};
	for (let index = 0; index < branch.length; index++) branch[index]!.parentId = branch[index - 1]?.id ?? null;
	const stale = step("stale", 999);
	stale.parentId = "a1";
	return {
		branch,
		entries: [
			{
				type: "session",
				id: CONTEXT_FIXTURE_SESSION_ID,
				cwd: CONTEXT_FIXTURE_CWD,
				additionalDirectories: ["/extra"],
			},
			{ type: "session_init", agent: "fixture", resolvedModel: "model-a" },
			...branch,
			stale,
			{ type: "model_usage", id: "late-usage", parentId: "stale", activeLeafId: "trailing", timestamp },
			{ type: "title", title: "id-less title slot" },
		],
	};
}
