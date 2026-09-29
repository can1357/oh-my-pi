import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ThinkingContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function frozenMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	const message = { ...createAssistantMessage(""), content, timestamp };
	for (const block of content) Object.freeze(block);
	Object.freeze(content);
	return Object.freeze(message);
}

describe("AgentSession thinking timing", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let now: number;
	let updates: Extract<AgentEvent, { type: "message_update" }>[];
	let ended: AssistantMessage[];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-thinking-timing-");
		authStorage = createInMemoryAuthStorage();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "Reason, then act", timestamp: 1 });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		updates = [];
		ended = [];
		session.subscribe(event => {
			if (event.type === "message_update") updates.push(event);
			if (event.type === "message_end" && event.message.role === "assistant") ended.push(event.message);
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage.close();
			tempDir.removeSync();
			vi.restoreAllMocks();
		}
	});

	function update(event: AssistantMessageEvent, at: number): void {
		if (!("partial" in event)) throw new Error("Expected a partial assistant event");
		now = at;
		session.agent.emitExternalEvent({ type: "message_update", message: event.partial, assistantMessageEvent: event });
	}

	it("publishes a completed duration before a tool preview and retains it in persisted transcript reads", async () => {
		const thinking: ThinkingContent = { type: "thinking", thinking: "Consider **both** options." };
		const toolCall: ToolCall = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "file.ts" } };
		const initial = frozenMessage([], 10);
		const reasoning = frozenMessage([thinking], 10);
		const preview = frozenMessage([thinking, toolCall], 10);
		now = 100;
		session.agent.emitExternalEvent({ type: "message_start", message: initial });
		update({ type: "thinking_start", contentIndex: 0, partial: reasoning }, 500);
		// Providers can omit thinking_end; the next block must still finalize the footer.
		update({ type: "toolcall_start", contentIndex: 1, partial: preview }, 1_300);

		const started = updates[0];
		const toolPreview = updates[1];
		if (started?.message.role !== "assistant" || toolPreview?.message.role !== "assistant") {
			throw new Error("Expected the reasoning and tool preview updates");
		}
		expect(started.message.thinkingMs).toBeUndefined();
		expect(toolPreview.message.thinkingMs).toEqual({ 0: 1_200 });
		expect(toolPreview.message).not.toBe(preview);
		expect(toolPreview.message.content).toBe(preview.content);
		expect(toolPreview.message.content[0]).toBe(started.message.content[0]);
		expect("partial" in toolPreview.assistantMessageEvent && toolPreview.assistantMessageEvent.partial).toBe(
			toolPreview.message,
		);
		expect(preview.thinkingMs).toBeUndefined();
		expect(session.agent.state.streamMessage).toBe(toolPreview.message);

		// A late close must not count the tool argument stream as reasoning.
		update({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: preview }, 3_000);
		update({ type: "toolcall_end", contentIndex: 1, toolCall, partial: preview }, 4_000);
		now = 5_000;
		const final = { ...preview, stopReason: "toolUse" as const };
		session.agent.emitExternalEvent({ type: "message_end", message: final });
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 11,
			},
		});
		await session.waitForIdle();
		await sessionManager.flush();

		expect(updates[2]?.message).toBe(preview);
		expect(updates[3]?.message).toBe(preview);
		expect(ended[0].thinkingMs).toEqual({ 0: 1_200 });
		expect(ended[0]).toBe(final);
		expect(final.thinkingMs).toEqual({ 0: 1_200 });
		expect(final.completedAt).toEqual(expect.any(Number));
		expect(session.messages.find(message => message.role === "assistant")).toBe(ended[0]);
		expect(session.buildDisplaySessionContext().messages.find(message => message.role === "assistant")).toMatchObject(
			{
				thinkingMs: { 0: 1_200 },
			},
		);
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected the persisted transcript path");
		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		try {
			expect(reloaded.buildSessionContext().messages.find(message => message.role === "assistant")).toMatchObject({
				thinkingMs: { 0: 1_200 },
			});
		} finally {
			await reloaded.close();
		}
	});

	it("retains elapsed time on interruption without leaking a duration into the next unmeasured message", async () => {
		const thinking: ThinkingContent = { type: "thinking", thinking: "Incomplete reasoning" };
		const partial = frozenMessage([thinking], 20);
		now = 100;
		session.agent.emitExternalEvent({ type: "message_start", message: frozenMessage([], 20) });
		update({ type: "thinking_start", contentIndex: 0, partial }, 200);
		now = 600;
		session.agent.emitExternalEvent({
			type: "message_end",
			message: Object.freeze({ ...partial, stopReason: "aborted", errorMessage: "Request was aborted" }),
		});
		now = 2_000;
		const unmeasured = frozenMessage(
			[{ type: "thinking", thinking: "Imported reasoning without streamed events" }],
			30,
		);
		session.agent.emitExternalEvent({ type: "message_start", message: unmeasured });
		now = 4_000;
		session.agent.emitExternalEvent({ type: "message_end", message: unmeasured });
		await session.waitForIdle();

		expect(ended[0].thinkingMs).toEqual({ 0: 500 });
		expect(ended[1].thinkingMs).toBeUndefined();
		const persisted = sessionManager
			.getBranch()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(persisted.map(message => message.thinkingMs)).toEqual([{ 0: 500 }, undefined]);
		expect(partial.thinkingMs).toBeUndefined();
		expect(unmeasured.thinkingMs).toBeUndefined();
	});
});
