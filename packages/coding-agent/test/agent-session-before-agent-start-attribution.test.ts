import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { inferCopilotInitiator } from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("AgentSession before_agent_start attribution fallback", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	const injectedText = "before-agent-start injected message";

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
	});

	function createSession() {
		const emitBeforeAgentStart = vi.fn().mockResolvedValue({
			messages: [
				{
					customType: "before-start",
					content: injectedText,
					display: false,
				},
			],
		});
		const extensionRunner = {
			emitBeforeAgentStart,
			emit: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});

		return { emitBeforeAgentStart };
	}

	function findBeforeStartInjection(messages: AgentMessage[]): AgentMessage | undefined {
		return messages.find(message => message.role === "custom" && message.customType === "before-start");
	}

	function findBeforeStartInjectionLlm(messages: Message[]): Message | undefined {
		return messages.find(message => {
			if (message.role === "assistant") return false;
			if (typeof message.content === "string") return message.content === injectedText;
			return message.content.some(block => block.type === "text" && block.text === injectedText);
		});
	}

	function findPromptMessage(messages: AgentMessage[], text: string): AgentMessage | undefined {
		return messages.find(message => {
			if ((message.role !== "user" && message.role !== "developer") || typeof message.content === "string") {
				return false;
			}
			return message.content.some(block => block.type === "text" && block.text === text);
		});
	}
	it("defaults before_agent_start message attribution to user for user prompts", async () => {
		const { emitBeforeAgentStart } = createSession();

		await session.prompt("hello from user");

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		const injectedMessage = findBeforeStartInjection(session.messages);
		expect(injectedMessage).toBeDefined();
		if (injectedMessage?.role !== "custom") {
			throw new Error("Expected injected custom message in session state");
		}

		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		const llmInjected = findBeforeStartInjectionLlm(llmMessages);
		expect(llmInjected).toBeDefined();
		if (!llmInjected || llmInjected.role === "assistant") {
			throw new Error("Expected injected message in converted LLM context");
		}
		expect(llmInjected.attribution).toBe("user");
		expect(inferCopilotInitiator(llmMessages)).toBe("user");
	});

	it("defaults before_agent_start message attribution to agent for synthetic prompts", async () => {
		const { emitBeforeAgentStart } = createSession();

		await session.prompt("internal reminder", { synthetic: true });

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		const injectedMessage = findBeforeStartInjection(session.messages);
		expect(injectedMessage).toBeDefined();
		if (injectedMessage?.role !== "custom") {
			throw new Error("Expected injected custom message in session state");
		}

		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		const llmInjected = findBeforeStartInjectionLlm(llmMessages);
		expect(llmInjected).toBeDefined();
		if (!llmInjected || llmInjected.role === "assistant") {
			throw new Error("Expected injected message in converted LLM context");
		}
		expect(llmInjected.attribution).toBe("agent");
		expect(inferCopilotInitiator(llmMessages)).toBe("agent");
	});

	it("allows user-role prompts to opt into agent attribution", async () => {
		const { emitBeforeAgentStart } = createSession();
		const promptText = "delegated task";

		await session.prompt(promptText, { attribution: "agent" });

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		const promptMessage = findPromptMessage(session.messages, promptText);
		expect(promptMessage).toBeDefined();
		expect(promptMessage?.role).toBe("user");
		if (promptMessage?.role !== "user") {
			throw new Error("Expected delegated prompt to remain a user-role message");
		}
		expect(promptMessage.attribution).toBe("agent");

		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		const llmInjected = findBeforeStartInjectionLlm(llmMessages);
		expect(llmInjected).toBeDefined();
		if (!llmInjected || llmInjected.role === "assistant") {
			throw new Error("Expected injected message in converted LLM context");
		}
		expect(llmInjected.attribution).toBe("agent");
		expect(inferCopilotInitiator(llmMessages)).toBe("agent");
	});
});
