import { expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

it("reuses completed argument snapshots while session streaming guards observe later text", async () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const args = { nested: { value: 0 } };
	const mock = createMockModel({
		responses: [
			{
				content: [{ type: "toolCall", id: "first", name: "noop", arguments: args }, "after", "later"],
			},
			{ content: ["done"] },
		],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: [], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: "Main",
	});
	const retained = new Set<Record<string, unknown>>();
	const unsubscribe = agent.subscribe(event => {
		if (event.type !== "message_update" || event.message.role !== "assistant") return;
		if (event.assistantMessageEvent.type !== "text_delta") return;
		const block = event.message.content[0];
		if (block?.type === "toolCall" && block.id === "first") retained.add(block.arguments);
	});
	try {
		await agent.prompt("run");
		expect(retained.size).toBe(1);
		expect([...retained][0]).toEqual(args);
	} finally {
		unsubscribe();
		await session.dispose();
		authStorage.close();
	}
});
