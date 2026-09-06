import { expect, test } from "bun:test";
import type { AssistantMessage, Context, ProviderSessionState, UserMessage } from "@oh-my-pi/pi-ai";
import {
	getOpenAICodexContextWindow,
	resetOpenAICodexHistoryAfterCompaction,
	restoreOpenAICodexContextWindow,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { CodexContextWindows } from "@oh-my-pi/pi-catalog/types";
import { CodexContextWindowProtocol, appendCodexHistoryItemId } from "../src/session/codex-context-window";
import { sessionEntryIdOf } from "../src/session/session-entries";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

const policy: CodexContextWindows = {
	enabled: false,
	useHistoryNotes: false,
	reminderThresholdTokens: 100,
	reminderMessageTemplate: "reminder {n_remaining}",
	guidanceMessage: "catalog guidance",
	autoCompactFallbackPrompt: "catalog fallback",
	autoCompactFallbackBufferTokens: 200,
};
function response(input: number, tool?: string): AssistantMessage {
	return {
		role: "assistant",
		content: tool
			? [{ type: "toolCall", id: "call", name: tool, arguments: {} }]
			: [{ type: "text", text: "working" }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "fixture",
		usage: {
			input,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: tool ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

test("history item references use journal ids without changing persisted content", () => {
	const manager = SessionManager.inMemory();
	const message: UserMessage = {
		role: "user",
		content: [
			{ type: "text", text: "request" },
			{ type: "image", data: "image", mimeType: "image/png" },
		],
		timestamp: 1,
	};
	const id = manager.appendMessage(message);
	const projected = appendCodexHistoryItemId(message, sessionEntryIdOf(message));
	expect(projected.content).toEqual([
		{ type: "text", text: `request\n[id: ${id}]` },
		{ type: "image", data: "image", mimeType: "image/png" },
	]);
	expect(message.content).toEqual([
		{ type: "text", text: "request" },
		{ type: "image", data: "image", mimeType: "image/png" },
	]);
	expect(appendCodexHistoryItemId(projected, id)).toEqual(projected);
	const reconstructed = manager.buildSessionContext().messages[0];
	expect(reconstructed?.role === "user" && reconstructed.sessionEntryId).toBe(id);
});

test("late journal persistence and resumed custom entries retain provider history references", () => {
	const manager = SessionManager.inMemory();
	const messages: UserMessage[] = [{ role: "user", content: "request", timestamp: 1 }];
	convertToLlm(messages);
	const userId = manager.appendMessage(messages[0]);
	const converted = convertToLlm(messages)[0];
	if (converted.role === "assistant") throw new Error("Expected a non-assistant provider input");
	expect(appendCodexHistoryItemId(converted, sessionEntryIdOf(converted)).content).toBe(`request\n[id: ${userId}]`);
	const customId = manager.appendCustomMessageEntry("reminder", "continue the investigation", false);
	const resumed = convertToLlm(manager.buildSessionContext().messages);
	const reminder = resumed[1];
	if (reminder.role === "assistant") throw new Error("Expected a non-assistant provider reminder");
	expect(appendCodexHistoryItemId(reminder, sessionEntryIdOf(reminder)).content).toEqual([
		{ type: "text", text: `continue the investigation\n[id: ${customId}]` },
	]);
	manager.close();
});

test("window rotation and restoration retain the first window and thread identity", () => {
	const providerSessionState = new Map<string, ProviderSessionState>();
	const first = getOpenAICodexContextWindow("session", providerSessionState);
	resetOpenAICodexHistoryAfterCompaction({ sessionId: "session", providerSessionState });
	const second = getOpenAICodexContextWindow("session", providerSessionState);
	expect(second).toMatchObject({
		threadId: first.threadId,
		firstWindowId: first.windowId,
		previousWindowId: first.windowId,
		windowNumber: 2,
	});
	expect(second.windowId).not.toBe(first.windowId);
	const resumed = new Map<string, ProviderSessionState>();
	restoreOpenAICodexContextWindow("session", resumed, second);
	expect(getOpenAICodexContextWindow("session", resumed)).toEqual(second);
});

test("full context developer items remain a stable append-compatible prefix", () => {
	const protocol = new CodexContextWindowProtocol("root/worker");
	const identity = getOpenAICodexContextWindow("session", new Map());
	const options = { identity, policy, threadHint: "thread hint", getMessageId: () => "entry" };
	const context: Context = { messages: [{ role: "user", content: "request", timestamp: 1 }] };
	const first = protocol.transform(context, options);
	const next = protocol.transform({ ...context, messages: [...context.messages, response(10)] }, options);
	expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
	expect(first.messages.map(message => message.role)).toEqual(["developer", "developer", "user"]);
	expect(first.messages[0].content).toContain(identity.windowId);
	expect(first.messages[0].content).toContain("root/worker");
	expect(first.messages[2].content).toBe("request\n[id: entry]");
});

test("effective threshold drives one reminder and fallback per window", () => {
	const protocol = new CodexContextWindowProtocol("root");
	const identity = getOpenAICodexContextWindow("session", new Map());
	protocol.reset(identity);
	const reminder = protocol.observe(response(750), 1000, policy);
	expect(protocol.remaining).toBe(50);
	expect(reminder.map(message => message.content)).toContain("reminder 50");
	expect(protocol.observe(response(775), 1000, policy).map(message => message.content)).not.toContain("reminder 25");
	expect(protocol.observe(response(801), 1000, policy).map(message => message.content)).toContain("catalog fallback");
	expect(protocol.observe(response(900), 1000, policy).map(message => message.content)).not.toContain(
		"catalog fallback",
	);
	protocol.reset({ ...identity, windowId: "next", windowNumber: 2 });
	expect(protocol.observe(response(801), 1000, policy).map(message => message.content)).toContain("catalog fallback");
});

test("fallback permits one checkpoint response before requiring a reset or recovery", () => {
	const protocol = new CodexContextWindowProtocol("root");
	const identity = getOpenAICodexContextWindow("session", new Map());
	protocol.reset(identity);
	const fallback = protocol.observe(response(801), 1000, policy);
	protocol.transform({ messages: fallback }, { identity, policy, getMessageId: () => undefined });
	protocol.observe(response(820, "notes.write_file"), 1000, policy, () => true);
	expect(protocol.fallbackFailed).toBe(false);
	protocol.observe(response(850), 1000, policy);
	expect(protocol.fallbackFailed).toBe(true);
});

test("a failed checkpoint tool result fails the fallback sequence", () => {
	const protocol = new CodexContextWindowProtocol("root");
	const identity = getOpenAICodexContextWindow("session", new Map());
	protocol.reset(identity);
	const fallback = protocol.observe(response(801), 1000, policy);
	protocol.transform({ messages: fallback }, { identity, policy, getMessageId: () => undefined });
	protocol.observe(response(820, "notes.write_file"), 1000, policy, () => false);
	expect(protocol.fallbackFailed).toBe(true);
});
