import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { type CompactionSummaryMessage, INTERRUPTED_THINKING_MESSAGE_TYPE } from "../../src/session/messages";
import { buildSessionContext, type StrippedToolCallsMarker } from "../../src/session/session-context";
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
