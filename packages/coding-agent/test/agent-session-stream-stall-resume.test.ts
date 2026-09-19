import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, filterProviderReplayMessages, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;

const STALL_ERROR_MESSAGE = "OpenAI responses stream stalled while waiting for the next event";
const STALL_ERROR_ID = AIError.create(AIError.Flag.Transient, AIError.Flag.Timeout);
const RESUME_NOTE_TYPE = "stream-stall-resume";

function isStalledAssistant(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && message.errorMessage === STALL_ERROR_MESSAGE;
}

function isResumeNote(message: AgentMessage): boolean {
	return message.role === "custom" && "customType" in message && message.customType === RESUME_NOTE_TYPE;
}

/**
 * Contract: a mid-generation idle stall that cut off a text-only turn after
 * the partial text was already committed must NOT pin the error. The failed
 * turn stays in context and the continuation resumes after the partial output
 * (mirroring the resolved-tool-turn stream-stall path), instead of surfacing
 * "OpenAI responses stream stalled while waiting for the next event" with no
 * recovery — the gap behind oh-my-pi issue #6414 for non-Cursor providers.
 */
describe("AgentSession text-only stream stall resume", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-stall-resume-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(() => {
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("preserves the partial turn and resumes instead of pinning the stall error", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					content: ["First part of the answer. "],
					stopReason: "error",
					errorMessage: STALL_ERROR_MESSAGE,
					errorId: STALL_ERROR_ID,
				},
				{ content: ["Second part completes it."], stopReason: "stop" },
			],
		});
		// Mirror the production session converter chain (sdk.ts convertToLlmFinal)
		// so custom continuity messages reach the provider context, as they do live.
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
			convertToLlm: messages => filterProviderReplayMessages(convertToLlm(messages)),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Write the answer in two parts");
		await session.waitForIdle();

		// The stall retried: one retry start carrying the stall error, and the
		// continuation consumed the second scripted response.
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].errorMessage).toContain("stream stalled");
		expect(retryEndEvents.some(event => event.success === true)).toBe(true);

		// Active context keeps the failed turn and the resume note after it.
		const stateMessages = session.agent.state.messages;
		const preserved = stateMessages.find(isStalledAssistant);
		expect(preserved).toBeDefined();
		if (preserved) {
			expect(preserved.content.some(block => block.type === "text" && block.text.includes("First part"))).toBe(true);
		}
		expect(stateMessages.some(isResumeNote)).toBe(true);

		// The continuation's provider request carried the preserved partial text
		// and the hidden resume note (custom messages convert to developer role).
		const continuedContext: Message[] = mock.calls[1].context.messages;
		expect(
			continuedContext.some(
				message =>
					message.role === "assistant" &&
					typeof message.content !== "string" &&
					message.content.some(block => block.type === "text" && block.text.includes("First part")),
			),
		).toBe(true);
		expect(
			continuedContext.some(
				message =>
					message.role === "developer" &&
					typeof message.content !== "string" &&
					message.content.some(block => block.type === "text" && block.text.includes("cut off")),
			),
		).toBe(true);

		// The session settled on the completed continuation, not the pinned error.
		const last = stateMessages.at(-1);
		if (last?.role !== "assistant") {
			throw new Error("Expected trailing assistant message");
		}
		expect(last.stopReason).toBe("stop");
		expect(
			last.content.some(block => block.type === "text" && block.text.includes("Second part completes it.")),
		).toBe(true);
	});
});
