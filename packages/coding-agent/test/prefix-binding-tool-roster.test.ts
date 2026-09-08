import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

interface TestSession {
	session: AgentSession;
	contexts: Message[][];
	rebuild: Mock<(toolNames: string[]) => Promise<string>>;
}

function newSession(model: Model): TestSession {
	const read = createTool("read");
	const bash = createTool("bash");
	const toolRegistry = new Map<string, AgentTool>([
		[read.name, read],
		[bash.name, bash],
	]);
	const mock = createMockModel({ responses: [{ content: ["ok"] }, { content: ["ok"] }] });
	const contexts: Message[][] = [];
	const rebuilder = {
		async rebuildSystemPrompt(toolNames: string[]): Promise<string> {
			return `tools:${toolNames.join(",")}`;
		},
	};
	const rebuild = vi.spyOn(rebuilder, "rebuildSystemPrompt");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["initial"], tools: [read], messages: [] },
		convertToLlm,
		streamFn: (requestModel, context, streamOptions) => {
			contexts.push([...context.messages]);
			return mock.stream(requestModel, context, streamOptions);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry,
		builtInToolNames: ["read", "bash"],
		rebuildSystemPrompt: async toolNames => ({
			systemPrompt: [await rebuilder.rebuildSystemPrompt(toolNames)],
		}),
	});
	return { session, contexts, rebuild };
}

function providerText(messages: Message[]): string {
	return messages
		.flatMap(message =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n");
}

describe("prefix-bound tool roster changes", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	it("freezes the prompt after a prefix-bound turn", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");
		const promptBeforeRosterChange = [...harness.session.agent.state.systemPrompt];
		const rebuildsBeforeRosterChange = harness.rebuild.mock.calls.length;

		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		expect(harness.rebuild).toHaveBeenCalledTimes(rebuildsBeforeRosterChange);
		expect(harness.session.agent.state.systemPrompt).toEqual(promptBeforeRosterChange);
	});

	it("delivers one hidden roster notice with the next user prompt", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");
		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		await harness.session.prompt("second");

		const notices = harness.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "tool-roster-notice",
		);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			details: { added: ["bash"], removed: [] },
			display: false,
			attribution: "agent",
		});
		const secondRequest = providerText(harness.contexts[1]);
		expect(secondRequest).toContain("Tool availability changed.");
		expect(secondRequest).toContain("Now available: bash.");
		expect(secondRequest.match(/Tool availability changed\./g)).toHaveLength(1);
	});

	it("rebuilds a prefix-bound prompt when the roster changes before the first turn", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		const rebuildsBeforeRosterChange = harness.rebuild.mock.calls.length;

		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		expect(harness.rebuild).toHaveBeenCalledTimes(rebuildsBeforeRosterChange + 1);
		expect(harness.session.agent.state.systemPrompt).toEqual(["tools:read,bash"]);
	});

	it("keeps rebuilding roster changes for models without prefix binding", async () => {
		const harness = newSession(createModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");
		const rebuildsBeforeRosterChange = harness.rebuild.mock.calls.length;

		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		expect(harness.rebuild).toHaveBeenCalledTimes(rebuildsBeforeRosterChange + 1);
		expect(harness.session.agent.state.systemPrompt).toEqual(["tools:read,bash"]);
	});
});
