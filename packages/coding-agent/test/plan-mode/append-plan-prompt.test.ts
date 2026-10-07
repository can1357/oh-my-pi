import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

function model(): Model {
	return buildModel({
		id: "plan-append-test",
		name: "plan-append-test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

function createSession(planModeAppendPrompt?: string): AgentSession {
	const tools = [tool("read")];
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: model(), systemPrompt: [], tools } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: {
			getApiKey: async () => "test-key",
			hasConfiguredAuth: () => true,
			refreshSelectedModelMetadata: async (value: Model) => value,
			clearSuppressedSelector: () => undefined,
		} as never,
		toolRegistry: new Map(tools.map(value => [value.name, value])),
		builtInToolNames: tools.map(value => value.name),
		planModeAppendPrompt,
	});
	sessions.push(session);
	return session;
}

async function planModeContext(session: AgentSession): Promise<string | undefined> {
	await session.sendPlanModeContext();
	const message = session.state.messages.find(
		entry => "customType" in entry && entry.customType === "plan-mode-context",
	);
	return message && "content" in message && typeof message.content === "string" ? message.content : undefined;
}

describe("planModeAppendPrompt", () => {
	it("appends user planning guidance to the plan-mode context message", async () => {
		const session = createSession("Use context7 MCP to look up library docs before writing the plan.");
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		const content = await planModeContext(session);

		expect(content).toContain("Plan mode active.");
		expect(content).toContain("Use context7 MCP to look up library docs before writing the plan.");
	});

	it("keeps the bundled plan-mode guidance unchanged when no append is configured", async () => {
		const session = createSession();
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		const content = await planModeContext(session);

		expect(content).toContain("Plan mode active.");
		expect(content).not.toContain("context7");
	});

	it("emits no plan-mode context while plan mode is disabled", async () => {
		const session = createSession("Never seen");

		const content = await planModeContext(session);

		expect(content).toBeUndefined();
	});
});
