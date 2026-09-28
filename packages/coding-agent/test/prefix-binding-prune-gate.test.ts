import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SUPERSEDED_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const OLD_RESULT = "old file contents\n".repeat(100);
const NEW_RESULT = "new file contents\n".repeat(100);

function createPrefixBindingModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(model: Model, content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: usage(),
		timestamp,
	};
}

function toolResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function newSession(model: Model): AgentSession {
	const sessionManager = SessionManager.inMemory();
	const now = Date.now();
	sessionManager.appendMessage({ role: "user", content: "Read the file twice.", timestamp: now - 500 });
	sessionManager.appendMessage(
		assistant(
			model,
			[{ type: "toolCall", id: "read-old", name: "read", arguments: { path: "src/foo.ts" } }],
			now - 400,
		),
	);
	sessionManager.appendMessage(toolResult("read-old", OLD_RESULT, now - 350));
	sessionManager.appendMessage(
		assistant(
			model,
			[{ type: "toolCall", id: "read-new", name: "read", arguments: { path: "src/foo.ts" } }],
			now - 300,
		),
	);
	sessionManager.appendMessage(toolResult("read-new", NEW_RESULT, now - 250));
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"compaction.dropUseless": false,
			"compaction.supersedeReads": true,
		}),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
	});
	session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	return session;
}

async function runMaintenance(session: AgentSession): Promise<void> {
	const model = session.model;
	if (!model) throw new Error("Expected an active model");
	const finalAssistant = assistant(model, [{ type: "text", text: "Done." }], Date.now());
	session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
	await session.waitForIdle();
}

function oldResultText(session: AgentSession): string {
	const message = session.agent.state.messages.find(
		(candidate): candidate is ToolResultMessage =>
			candidate.role === "toolResult" && candidate.toolCallId === "read-old",
	);
	if (!message) throw new Error("Expected the old read result");
	const text = message.content.find(block => block.type === "text");
	if (text?.type !== "text") throw new Error("Expected text in the old read result");
	return text.text;
}

describe("prefix-bound stale-result pruning", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("keeps a warm superseded read for prefix binding while the control model prunes it", async () => {
		const prefixBindingSession = newSession(createPrefixBindingModel());
		const controlSession = newSession(createModel());
		sessions.push(prefixBindingSession, controlSession);

		await runMaintenance(prefixBindingSession);
		await runMaintenance(controlSession);

		expect(oldResultText(prefixBindingSession)).toBe(OLD_RESULT);
		expect(oldResultText(controlSession)).toBe(SUPERSEDED_NOTICE);
	});
});
