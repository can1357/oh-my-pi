import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { factId, toolExecutionId } from "@oh-my-pi/pi-agent-core/presentation";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { type CompactionSummaryMessage, INTERRUPTED_THINKING_MESSAGE_TYPE } from "../../src/session/messages";
import {
	buildSessionContext,
	type InterruptedToolCallsMarker,
	type StrippedToolCallsMarker,
} from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";

const timestamp = "2026-07-09T00:00:00.000Z";

const compactedEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "before compaction" }], timestamp: 1 },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "m1",
		timestamp,
		summary: "summary",
		firstKeptEntryId: "m1",
		tokensBefore: 123,
		preserveData: {
			[snapcompact.PRESERVE_KEY]: {
				frames: [{ data: "base64-frame", mimeType: "image/png", cols: 10, rows: 10, chars: 100 }],
				totalChars: 100,
				truncatedChars: 0,
				textHead: "head",
				textTail: "tail",
			},
		},
	},
	{
		type: "message",
		id: "m2",
		parentId: "c1",
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "after compaction" }], timestamp: 2 },
	},
] satisfies SessionEntry[];

function compactionSummary(messages: AgentMessage[]): CompactionSummaryMessage {
	const summary = messages.find(
		(message): message is CompactionSummaryMessage => message.role === "compactionSummary",
	);
	if (!summary) throw new Error("Expected a compaction summary message");
	return summary;
}

describe("buildSessionContext snapcompact archives", () => {
	it("omits snapcompact archive blocks from collapsed transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		const summary = compactionSummary(context.messages);

		expect(summary.images).toBeUndefined();
		expect(summary.blocks).toBeUndefined();
	});

	it("keeps snapcompact archive blocks in full transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, { transcript: true });

		const summary = compactionSummary(context.messages);

		expect(summary.images?.map(image => image.data)).toEqual(["base64-frame"]);
		expect(summary.blocks?.map(block => block.type)).toEqual(["text", "image", "text"]);
	});

	it("keeps snapcompact archive blocks in provider context summaries", () => {
		const context = buildSessionContext(compactedEntries);

		const summary = compactionSummary(context.messages);

		expect(summary.images?.map(image => image.data)).toEqual(["base64-frame"]);
		expect(summary.blocks?.map(block => block.type)).toEqual(["text", "image", "text"]);
	});
});

// A turn whose tool is still executing at rebuild time: the assistant message
// (with its toolCall) is persisted at message_end, the toolResult is not.
const danglingToolCallEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 60" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
	},
] satisfies SessionEntry[];

function danglingCallIds(messages: AgentMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") ids.push(block.id);
		}
	}
	return ids;
}

describe("buildSessionContext dangling toolCalls", () => {
	it("strips a dangling toolCall from the transcript but keeps the turn with a stripped marker", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, { transcript: true });

		expect(danglingCallIds(context.messages)).toEqual([]);
		// The turn survives (even content-less) carrying the marker so the TUI
		// renders a placeholder row instead of silently erasing the activity.
		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.content).toEqual([]);
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBe(1);
	});

	it("keeps a dangling toolCall in transcript mode with keepDanglingToolCalls", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, {
			transcript: true,
			keepDanglingToolCalls: true,
		});

		expect(danglingCallIds(context.messages)).toEqual(["call-1"]);
	});

	it("always strips dangling toolCalls from the LLM context and drops the emptied turn", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, {
			keepDanglingToolCalls: true,
		});

		expect(danglingCallIds(context.messages)).toEqual([]);
		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
	});
});

describe("buildSessionContext dangling toolCalls with a v4 tool journal", () => {
	it("resolves a journal-covered dangling toolCall to an interrupted card instead of the elision count", () => {
		const entries: SessionEntry[] = [
			...danglingToolCallEntries,
			{
				type: "tool_execution_started",
				id: "j1",
				parentId: "m2",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0001"),
				call: {
					toolCallId: "call-1",
					toolName: "bash",
					title: "Run FIXTURE_MARKER_SCTX0001",
					kind: "execute",
				},
				presentation: { version: 1, facts: [{ id: factId("fact-SCTX0001"), kind: "wall_time", ms: 5 }] },
			},
		];

		const context = buildSessionContext(entries, undefined, undefined, { transcript: true });

		// The dangling block is still stripped from `content` — it never becomes a
		// synthetic toolResult candidate for the next provider request — but the
		// turn now carries the folded journal record instead of a bare count.
		expect(danglingCallIds(context.messages)).toEqual([]);
		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBeUndefined();
		const interrupted = (assistant as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls;
		expect(interrupted).toEqual([
			{
				state: "interrupted",
				call: {
					toolCallId: "call-1",
					toolName: "bash",
					title: "Run FIXTURE_MARKER_SCTX0001",
					kind: "execute",
				},
				reason: expect.stringContaining("Interrupted"),
				presentation: { version: 1, facts: [{ id: factId("fact-SCTX0001"), kind: "wall_time", ms: 5 }] },
			},
		]);
	});

	it("keeps the plain elision count when no journal record exists (pre-v4/legacy_snapshot)", () => {
		// Identical to the pre-existing dangling-call fixture with no journal
		// entries at all — the universal legacy/legacy_snapshot case.
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, { transcript: true });

		const assistant = context.messages.find(message => message.role === "assistant");
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBe(1);
		expect((assistant as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls).toBeUndefined();
	});

	it("shows the settled first occurrence as normal and the journaled second occurrence as interrupted with zero elision (recycled id, settled-then-dangling)", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "run it twice" }], timestamp: 1 },
			},
			toolCallAssistantEntry("m2", "m1", "toolUse", "call-1", 2),
			{
				type: "tool_execution_started",
				id: "j1",
				parentId: "m2",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0006"),
				call: { toolCallId: "call-1", toolName: "write", title: "first occurrence", kind: "execute" },
				presentation: { version: 1, facts: [] },
			},
			{
				type: "tool_execution_settled",
				id: "j1s",
				parentId: "j1",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0006"),
				outcome: { kind: "succeeded" },
				presentation: { version: 1, facts: [], attachments: [] },
				modelProjection: { version: 1, content: [] },
			},
			syntheticToolResultEntry("m3", "j1s", "call-1", 3),
			// Same toolCallId recycled by the provider for a second call, still
			// dangling — the global "this id has a result somewhere" set the
			// pre-fix code used would wrongly treat this occurrence as paired too.
			toolCallAssistantEntry("m4", "m3", "toolUse", "call-1", 4),
			{
				type: "tool_execution_started",
				id: "j2",
				parentId: "m4",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0007"),
				call: { toolCallId: "call-1", toolName: "write", title: "second occurrence", kind: "execute" },
				presentation: { version: 1, facts: [] },
			},
		];

		const context = buildSessionContext(entries, undefined, undefined, { transcript: true });
		const assistants = context.messages.filter(message => message.role === "assistant");
		expect(assistants).toHaveLength(2);

		// First occurrence: paired with a real toolResult, so it is left
		// untouched — no stripping, no interrupted marker.
		expect(
			(assistants[0] as AssistantMessage).content.some(block => block.type === "toolCall" && block.id === "call-1"),
		).toBe(true);
		expect((assistants[0] as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBeUndefined();
		expect((assistants[0] as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls).toBeUndefined();

		// Second occurrence: no result anywhere, and its own journal record
		// proves no settlement landed — stripped, but the interrupted card
		// fully accounts for it (elision count zero).
		expect((assistants[1] as AssistantMessage).content.some(block => block.type === "toolCall")).toBe(false);
		expect((assistants[1] as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBeUndefined();
		expect((assistants[1] as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls).toEqual([
			{
				state: "interrupted",
				call: { toolCallId: "call-1", toolName: "write", title: "second occurrence", kind: "execute" },
				reason: expect.stringContaining("Interrupted"),
				presentation: { version: 1, facts: [] },
			},
		]);
	});

	it("pairs a toolResult with the latest unpaired occurrence, not FIFO, when a dangling first occurrence precedes a settled second occurrence of a recycled id", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "run it twice" }], timestamp: 1 },
			},
			// Occurrence 1: dangling — no journaled settlement ever lands for it.
			toolCallAssistantEntry("m2", "m1", "toolUse", "call-1", 2),
			{
				type: "tool_execution_started",
				id: "j1",
				parentId: "m2",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0008"),
				call: { toolCallId: "call-1", toolName: "write", title: "first occurrence", kind: "execute" },
				presentation: { version: 1, facts: [] },
			},
			// Occurrence 2: the provider recycles the id again BEFORE any result
			// for occurrence 1 arrives — the FIFO-breaking shape. A naive
			// first-unpaired-wins (FIFO) scheme would attribute the toolResult
			// below to occurrence 1 instead.
			toolCallAssistantEntry("m3", "j1", "toolUse", "call-1", 3),
			{
				type: "tool_execution_started",
				id: "j2",
				parentId: "m3",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0009"),
				call: { toolCallId: "call-1", toolName: "write", title: "second occurrence", kind: "execute" },
				presentation: { version: 1, facts: [] },
			},
			{
				type: "tool_execution_settled",
				id: "j2s",
				parentId: "j2",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0009"),
				outcome: { kind: "succeeded" },
				presentation: { version: 1, facts: [], attachments: [] },
				modelProjection: { version: 1, content: [] },
			},
			syntheticToolResultEntry("m4", "j2s", "call-1", 4),
		];

		const context = buildSessionContext(entries, undefined, undefined, { transcript: true });
		const assistants = context.messages.filter(message => message.role === "assistant");
		expect(assistants).toHaveLength(2);

		// First occurrence (never paired): its own journal record proves no
		// settlement landed, so it renders its own interrupted card — never
		// swapped with the second occurrence's settlement.
		expect((assistants[0] as AssistantMessage).content.some(block => block.type === "toolCall")).toBe(false);
		expect((assistants[0] as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBeUndefined();
		expect((assistants[0] as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls).toEqual([
			{
				state: "interrupted",
				call: { toolCallId: "call-1", toolName: "write", title: "first occurrence", kind: "execute" },
				reason: expect.stringContaining("Interrupted"),
				presentation: { version: 1, facts: [] },
			},
		]);

		// Second occurrence: the LIFO pairing hands the toolResult to the
		// latest still-unpaired occurrence — this one — so it is left
		// untouched despite sharing the recycled id with the dangling first.
		expect(
			(assistants[1] as AssistantMessage).content.some(block => block.type === "toolCall" && block.id === "call-1"),
		).toBe(true);
		expect((assistants[1] as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBeUndefined();
		expect((assistants[1] as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls).toBeUndefined();
	});

	it("disqualifies a recycled toolCallId with partial journal coverage and falls back to elision for both occurrences", () => {
		const entries: SessionEntry[] = [
			...danglingToolCallEntries,
			{
				type: "message",
				id: "m4",
				parentId: "m2",
				timestamp,
				message: {
					role: "assistant",
					// Same toolCallId recycled by the provider for a second, still-dangling call.
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 30" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 3,
				},
			},
			// Only the SECOND occurrence's started record is journaled — a short
			// pairing (1 branch start, 2 transcript occurrences) that the cursor's
			// totality gate must disqualify for every occurrence of the id.
			{
				type: "tool_execution_started",
				id: "j1",
				parentId: "m4",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0002"),
				call: { toolCallId: "call-1", toolName: "bash", title: "second occurrence", kind: "execute" },
				presentation: { version: 1, facts: [] },
			},
		];

		const context = buildSessionContext(entries, undefined, undefined, { transcript: true });

		expect(danglingCallIds(context.messages)).toEqual([]);
		const assistants = context.messages.filter(message => message.role === "assistant");
		expect(assistants).toHaveLength(2);
		for (const assistant of assistants) {
			expect((assistant as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls).toBeUndefined();
		}
		expect((assistants[1] as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBe(1);
	});

	it("uses the collapsed transcript's own window when a recycled toolCallId's earlier start sits before the compaction cut (disqualification-loss)", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo AAA111" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			// Pre-compaction started record for call-1 — dropped from the collapsed
			// transcript's `messages`, but still on the full `path` lineage.
			{
				type: "tool_execution_started",
				id: "j1",
				parentId: "m2",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0003"),
				call: { toolCallId: "call-1", toolName: "bash", title: "Run FIXTURE_MARKER_SCTX0003_PRE", kind: "execute" },
				presentation: { version: 1, facts: [] },
			},
			{
				type: "message",
				id: "m3",
				parentId: "j1",
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "keep-start" }], timestamp: 3 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m3",
				timestamp,
				summary: "summary",
				firstKeptEntryId: "m3",
				tokensBefore: 123,
			},
			{
				type: "message",
				id: "m4",
				parentId: "c1",
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "after compaction" }], timestamp: 4 },
			},
			{
				type: "message",
				id: "m5",
				parentId: "m4",
				timestamp,
				message: {
					role: "assistant",
					// Same toolCallId recycled by the provider post-compaction, still dangling.
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo BBB222" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 5,
				},
			},
			// Post-compaction started record for the recycled call — inside the
			// collapsed window, and the only one an aligned totality gate should see.
			{
				type: "tool_execution_started",
				id: "j2",
				parentId: "m5",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0004"),
				call: {
					toolCallId: "call-1",
					toolName: "bash",
					title: "Run FIXTURE_MARKER_SCTX0004_POST",
					kind: "execute",
				},
				presentation: { version: 1, facts: [] },
			},
		];

		const context = buildSessionContext(entries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		expect(danglingCallIds(context.messages)).toEqual([]);
		const assistant = context.messages.find(message => message.role === "assistant" && message.content.length === 0);
		expect(assistant).toBeDefined();
		// Fixed behaviour: the post-compaction start is the only one inside the
		// collapsed window, so the totality gate is total and resolves this call
		// to an interrupted card carrying its OWN (post-compaction) record —
		// never disqualified by the pre-compaction start the transcript no
		// longer contains.
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBeUndefined();
		const interrupted = (assistant as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls;
		expect(interrupted).toEqual([
			{
				state: "interrupted",
				call: {
					toolCallId: "call-1",
					toolName: "bash",
					title: "Run FIXTURE_MARKER_SCTX0004_POST",
					kind: "execute",
				},
				reason: expect.stringContaining("Interrupted"),
				presentation: { version: 1, facts: [] },
			},
		]);
	});

	it("never misattributes a recycled toolCallId's pre-compaction record to the collapsed transcript's post-compaction call", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo AAA111" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			// The ONLY started record for call-1 on the whole branch, and it
			// belongs to the pre-compaction call above — dropped from the
			// collapsed transcript's `messages`, but still on the full `path`.
			{
				type: "tool_execution_started",
				id: "j1",
				parentId: "m2",
				timestamp,
				recordVersion: 1,
				executionId: toolExecutionId("exec-SCTX0005"),
				call: { toolCallId: "call-1", toolName: "bash", title: "Run FIXTURE_MARKER_SCTX0005_PRE", kind: "execute" },
				presentation: { version: 1, facts: [] },
			},
			{
				type: "message",
				id: "m3",
				parentId: "j1",
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "keep-start" }], timestamp: 3 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m3",
				timestamp,
				summary: "summary",
				firstKeptEntryId: "m3",
				tokensBefore: 123,
			},
			{
				type: "message",
				id: "m4",
				parentId: "c1",
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "after compaction" }], timestamp: 4 },
			},
			{
				type: "message",
				id: "m5",
				parentId: "m4",
				timestamp,
				message: {
					role: "assistant",
					// Recycled toolCallId, post-compaction, and journals NO started
					// record of its own — the only start in the full branch is the
					// pre-compaction one above, which an unaligned totality gate
					// (full `path` starts vs trimmed `messages` occurrences: 1 == 1)
					// would wrongly accept and hand to this call.
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo BBB222" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 5,
				},
			},
		];

		const context = buildSessionContext(entries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		expect(danglingCallIds(context.messages)).toEqual([]);
		const assistant = context.messages.find(message => message.role === "assistant" && message.content.length === 0);
		expect(assistant).toBeDefined();
		// Fixed behaviour: the collapsed window holds no `tool_execution_started`
		// record for call-1 at all (the only one is pre-compaction, outside the
		// window), so this call must fall back to the plain elision count —
		// never render the earlier execution's title under its own name.
		expect((assistant as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls).toBeUndefined();
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBe(1);
	});
});

const assistantUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userEntry(id: string, parentId: string | null, content: string, messageTimestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content, timestamp: messageTimestamp } as AgentMessage,
	};
}

function assistantEntry(
	id: string,
	parentId: string | null,
	stopReason: AssistantMessage["stopReason"],
	text: string,
	messageTimestamp: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: assistantUsage,
			stopReason,
			timestamp: messageTimestamp,
		} satisfies AssistantMessage,
	};
}

function toolCallAssistantEntry(
	id: string,
	parentId: string | null,
	stopReason: AssistantMessage["stopReason"],
	toolCallId: string,
	messageTimestamp: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "write", arguments: { path: "plan.md", content: "x" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: assistantUsage,
			stopReason,
			timestamp: messageTimestamp,
		} satisfies AssistantMessage,
	};
}

function syntheticToolResultEntry(
	id: string,
	parentId: string | null,
	toolCallId: string,
	messageTimestamp: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "write",
			content: [
				{ type: "text", text: "Tool call was not executed because the provider stream ended with an error." },
			],
			details: { __synthetic: true, source: "assistant_stop_error", executed: false },
			isError: true,
			timestamp: messageTimestamp,
		} as AgentMessage,
	};
}

function hiddenContinuityEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp,
		customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
		content: "preserved interrupted thinking",
		display: false,
		attribution: "agent",
	};
}

function expectUserTail(messages: AgentMessage[], content: string): void {
	const tail = messages.at(-1);
	expect(tail?.role).toBe("user");
	if (tail?.role !== "user") {
		throw new Error(`Expected user tail, received ${tail?.role ?? "none"}`);
	}
	expect(tail.content).toBe(content);
}

describe("buildSessionContext failed replay tails", () => {
	it("terminates on cyclic parent links and includes each reachable message once", () => {
		const entries = [userEntry("A", "B", "from A", 1), userEntry("B", "A", "from B", 2)];

		const context = buildSessionContext(entries, "A");

		expect(context.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual([
			"from B",
			"from A",
		]);
	});

	it("omits a terminal aborted assistant from normal context", () => {
		const context = buildSessionContext([
			userEntry("user", null, "continue", 1),
			assistantEntry("assistant", "user", "aborted", "partial unsafe replay", 2),
		]);

		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
		expectUserTail(context.messages, "continue");
	});

	it("omits an earlier aborted assistant before a later user from normal context", () => {
		const context = buildSessionContext([
			userEntry("user-1", null, "first prompt", 1),
			assistantEntry("assistant", "user-1", "aborted", "partial unsafe replay", 2),
			userEntry("user-2", "assistant", "retry", 3),
		]);

		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
		expectUserTail(context.messages, "retry");
	});

	it("preserves a terminal aborted assistant in transcript mode", () => {
		const context = buildSessionContext(
			[
				userEntry("user", null, "continue", 1),
				assistantEntry("assistant", "user", "aborted", "visible transcript error", 2),
			],
			undefined,
			undefined,
			{ transcript: true },
		);

		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") {
			throw new Error(`Expected transcript assistant, received ${assistant?.role ?? "none"}`);
		}
		expect(assistant.stopReason).toBe("aborted");
		expect(assistant.content).toEqual([{ type: "text", text: "visible transcript error" }]);
	});

	it("omits a terminal error assistant from normal context", () => {
		const context = buildSessionContext([
			userEntry("user", null, "retry with smaller input", 1),
			assistantEntry("assistant", "user", "error", "provider rejected the request", 2),
		]);

		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
		expectUserTail(context.messages, "retry with smaller input");
	});

	it("keeps an aborted assistant when hidden interrupted-thinking continuity follows it", () => {
		const context = buildSessionContext([
			userEntry("user", null, "keep reasoning continuity", 1),
			assistantEntry("assistant", "user", "aborted", "partial answer before interrupt", 2),
			hiddenContinuityEntry("continuity", "assistant"),
		]);

		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") {
			throw new Error(`Expected assistant before continuity, received ${assistant?.role ?? "none"}`);
		}
		expect(assistant.stopReason).toBe("aborted");
		expect(context.messages.at(-1)?.role).toBe("custom");
	});

	it("drops synthetic tool results paired with a dropped failed tool-call turn", () => {
		const context = buildSessionContext([
			userEntry("user", null, "write the plan", 1),
			toolCallAssistantEntry("assistant", "user", "error", "call-1", 2),
			syntheticToolResultEntry("result", "assistant", "call-1", 3),
		]);

		expect(context.messages.map(message => message.role)).toEqual(["user"]);
		expectUserTail(context.messages, "write the plan");
	});

	it("keeps the failed tool-call turn and its result in transcript mode", () => {
		const context = buildSessionContext(
			[
				userEntry("user", null, "write the plan", 1),
				toolCallAssistantEntry("assistant", "user", "error", "call-1", 2),
				syntheticToolResultEntry("result", "assistant", "call-1", 3),
			],
			undefined,
			undefined,
			{ transcript: true, keepDanglingToolCalls: true },
		);

		expect(context.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});
});
