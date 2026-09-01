import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, ThinkingContent } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CustomMessage,
	convertToLlm,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const REASONING_TEXT = "I have partly reasoned through the implementation and should preserve this.";
const VISIBLE_TEXT = "visible interrupted text";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function baseAssistant(model: Model<Api>, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

function thinkingAssistant(model: Model<Api>, errorMessage: string, reasoning = REASONING_TEXT): AssistantMessage {
	const thinking: ThinkingContent = { type: "thinking", thinking: reasoning };
	return { ...baseAssistant(model, [thinking]), errorMessage };
}

function textAssistant(model: Model<Api>): AssistantMessage {
	return { ...baseAssistant(model, [{ type: "text", text: VISIBLE_TEXT }]), errorMessage: USER_INTERRUPT_LABEL };
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

function isInterruptedThinkingMessage(message: unknown): message is CustomMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		message.role === "custom" &&
		"customType" in message &&
		message.customType === INTERRUPTED_THINKING_MESSAGE_TYPE
	);
}

async function emitAssistantEnd(
	session: AgentSession,
	sessionManager: SessionManager,
	message: AssistantMessage,
	waitFor: (entry: SessionEntry) => boolean,
): Promise<void> {
	const existing = sessionManager.getBranch().find(waitFor);
	if (existing) return;
	const appended = Promise.withResolvers<void>();
	const previous = sessionManager.onEntryAppended;
	sessionManager.onEntryAppended = entry => {
		previous?.(entry);
		if (!waitFor(entry)) return;
		sessionManager.onEntryAppended = previous;
		appended.resolve();
	};
	session.agent.emitExternalEvent({ type: "message_start", message });
	session.agent.emitExternalEvent({ type: "message_end", message });
	await appended.promise;
}

describe("AgentSession interrupted thinking persistence", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-interrupted-thinking-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage.close();
			tempDir.removeSync();
			vi.restoreAllMocks();
		}
	});

	// Mechanism tests default to a non-anthropic model: anthropic-dialect targets
	// skip the hidden continuity quote entirely (reasoning_extraction refusal).
	function createSession(
		extensionRunner?: ExtensionRunner,
		providerModel: [GeneratedProvider, string] = ["openai", "gpt-5.2"],
	): {
		model: Model<Api>;
		sessionManager: SessionManager;
		session: AgentSession;
	} {
		const model = getBundledModel(providerModel[0], providerModel[1]);
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
		});
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			extensionRunner,
		});
		return { model, sessionManager, session };
	}

	it("retains native thinking on a user-interrupted assistant for replay and demotes a copy into hidden context", async () => {
		const harness = createSession();
		await emitAssistantEnd(
			harness.session,
			harness.sessionManager,
			thinkingAssistant(harness.model, USER_INTERRUPT_LABEL),
			entry => entry.type === "custom_message" && entry.customType === INTERRUPTED_THINKING_MESSAGE_TYPE,
		);

		const messages = harness.session.agent.state.messages;
		const assistant = messages.find(isAssistantMessage);
		expect(assistant).toBeDefined();
		expect(assistant?.content.some(block => block.type === "thinking")).toBe(true);
		const hidden = messages.find(isInterruptedThinkingMessage);
		expect(hidden).toBeDefined();
		expect(hidden?.display).toBe(false);
		expect(hidden?.attribution).toBe("agent");
		expect(typeof hidden?.content === "string" ? hidden.content : JSON.stringify(hidden?.content)).toBe(
			`You were saying this but I interrupted you:\n\`\`\`\n${REASONING_TEXT}\n\`\`\``,
		);
		expect(hidden?.details).toMatchObject({
			provider: harness.model.provider,
			model: harness.model.id,
			blockCount: 1,
		});
		expect(typeof (hidden?.details as { interruptedAt?: unknown } | undefined)?.interruptedAt).toBe("number");

		const branch = harness.sessionManager.getBranch();
		const assistantEntryIndex = branch.findIndex(
			entry => entry.type === "message" && entry.message.role === "assistant",
		);
		const hiddenEntryIndex = branch.findIndex(
			entry => entry.type === "custom_message" && entry.customType === INTERRUPTED_THINKING_MESSAGE_TYPE,
		);
		expect(assistantEntryIndex).toBeGreaterThanOrEqual(0);
		expect(hiddenEntryIndex).toBe(assistantEntryIndex + 1);
		const assistantEntry = branch[assistantEntryIndex];
		if (assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant") {
			throw new Error("assistant entry was not persisted");
		}
		expect(assistantEntry.message.content.some(block => block.type === "thinking")).toBe(true);
		const hiddenEntry = branch[hiddenEntryIndex];
		if (hiddenEntry?.type !== "custom_message") throw new Error("interrupted-thinking entry was not persisted");
		expect(hiddenEntry.display).toBe(false);
		expect(hiddenEntry.attribution).toBe("agent");
		expect(
			typeof hiddenEntry.content === "string" ? hiddenEntry.content : JSON.stringify(hiddenEntry.content),
		).toContain(REASONING_TEXT);

		// The thinking is stripped from the provider request only: the LLM sees the
		// assistant turn without the demoted run, plus the reasoning as a hidden
		// developer continuity turn.
		const llm = convertToLlm(messages);
		const assistantLlm = llm.find(entry => entry.role === "assistant");
		expect(assistantLlm).toBeDefined();
		expect(
			Array.isArray(assistantLlm?.content) && assistantLlm.content.some(block => block.type === "thinking"),
		).toBe(false);
		const developerLlm = llm.filter(entry => entry.role === "developer");
		expect(developerLlm.some(entry => JSON.stringify(entry.content).includes(REASONING_TEXT))).toBe(true);
	});
	it("skips hidden continuity for anthropic-dialect targets — reasoning never replays as text", async () => {
		const harness = createSession(undefined, ["anthropic", "claude-sonnet-4-5"]);
		await emitAssistantEnd(
			harness.session,
			harness.sessionManager,
			thinkingAssistant(harness.model, USER_INTERRUPT_LABEL),
			entry => entry.type === "message" && entry.message.role === "assistant",
		);

		const messages = harness.session.agent.state.messages;
		// Thinking stays on the assistant for display/reload; the provider transform
		// drops the unsigned run from replay (pi-ai anthropic-prior-turn-thinking suite).
		expect(messages.find(isAssistantMessage)?.content.some(block => block.type === "thinking")).toBe(true);
		expect(messages.some(isInterruptedThinkingMessage)).toBe(false);
		expect(
			harness.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === INTERRUPTED_THINKING_MESSAGE_TYPE),
		).toBe(false);
		// Session-level LLM view carries no text-form echo of the reasoning.
		const llm = convertToLlm(messages);
		expect(
			llm.some(entry => entry.role !== "assistant" && JSON.stringify(entry.content).includes(REASONING_TEXT)),
		).toBe(false);
	});

	it("skips hidden continuity for interrupted reasoning shorter than 60 characters", async () => {
		const harness = createSession();
		const reasoning = "x".repeat(59);
		await emitAssistantEnd(
			harness.session,
			harness.sessionManager,
			thinkingAssistant(harness.model, USER_INTERRUPT_LABEL, reasoning),
			entry => entry.type === "message" && entry.message.role === "assistant",
		);

		const messages = harness.session.agent.state.messages;
		expect(messages.find(isAssistantMessage)?.content).toEqual([{ type: "thinking", thinking: reasoning }]);
		expect(messages.some(isInterruptedThinkingMessage)).toBe(false);
		const llm = convertToLlm(messages);
		expect(llm.some(entry => entry.role === "assistant")).toBe(false);
		expect(llm.some(entry => JSON.stringify(entry.content).includes(reasoning))).toBe(false);
	});

	it("keeps hidden continuity for exactly 60 characters", async () => {
		const harness = createSession();
		const reasoning = "x".repeat(60);
		await emitAssistantEnd(
			harness.session,
			harness.sessionManager,
			thinkingAssistant(harness.model, USER_INTERRUPT_LABEL, reasoning),
			entry => entry.type === "custom_message" && entry.customType === INTERRUPTED_THINKING_MESSAGE_TYPE,
		);

		const hidden = harness.session.agent.state.messages.find(isInterruptedThinkingMessage);
		expect(typeof hidden?.content === "string" ? hidden.content : JSON.stringify(hidden?.content)).toContain(
			reasoning,
		);
	});

	it("makes hidden continuity available in agent state before awaited message_end delivery finishes", async () => {
		const releaseExtension = Promise.withResolvers<void>();
		const extensionEntered = Promise.withResolvers<void>();
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async () => {
					extensionEntered.resolve();
					await releaseExtension.promise;
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionRuntime,
			"delayed-message-end",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			new ModelRegistry(authStorage, path.join(tempDir.path(), "extension-models.yml")),
		);
		const harness = createSession(extensionRunner);
		const persisted = Promise.withResolvers<void>();
		const previous = harness.sessionManager.onEntryAppended;
		harness.sessionManager.onEntryAppended = entry => {
			previous?.(entry);
			if (entry.type !== "custom_message" || entry.customType !== INTERRUPTED_THINKING_MESSAGE_TYPE) return;
			harness.sessionManager.onEntryAppended = previous;
			persisted.resolve();
		};
		const message = thinkingAssistant(harness.model, USER_INTERRUPT_LABEL);

		harness.session.agent.emitExternalEvent({ type: "message_start", message });
		harness.session.agent.emitExternalEvent({ type: "message_end", message });
		await extensionEntered.promise;

		expect(harness.session.agent.state.messages.some(isInterruptedThinkingMessage)).toBe(true);

		releaseExtension.resolve();
		await persisted.promise;
	});

	it("leaves native thinking on non-user aborts and does not append hidden context", async () => {
		const harness = createSession();
		await emitAssistantEnd(
			harness.session,
			harness.sessionManager,
			thinkingAssistant(harness.model, "Request was aborted"),
			entry => entry.type === "message" && entry.message.role === "assistant",
		);

		const messages = harness.session.agent.state.messages;
		const assistant = messages.find(isAssistantMessage);
		expect(assistant?.content.some(block => block.type === "thinking")).toBe(true);
		expect(messages.some(isInterruptedThinkingMessage)).toBe(false);
		expect(
			harness.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === INTERRUPTED_THINKING_MESSAGE_TYPE),
		).toBe(false);
	});

	it("leaves user-interrupted text-only assistant content unchanged", async () => {
		const harness = createSession();
		await emitAssistantEnd(
			harness.session,
			harness.sessionManager,
			textAssistant(harness.model),
			entry => entry.type === "message" && entry.message.role === "assistant",
		);

		const messages = harness.session.agent.state.messages;
		const assistant = messages.find(isAssistantMessage);
		expect(assistant?.content).toEqual([{ type: "text", text: VISIBLE_TEXT }]);
		expect(messages.some(isInterruptedThinkingMessage)).toBe(false);
		expect(
			harness.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === INTERRUPTED_THINKING_MESSAGE_TYPE),
		).toBe(false);
	});
});
