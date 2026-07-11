import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AssistantMessage, Message, ThinkingContent } from "@pk-nerdsaver-ai/pi-ai";
import { z } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel, type MockContent, type MockModel, type MockResponse } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

const checkpointSchema = z.object({ goal: z.string() });
const rewindSchema = z.object({ report: z.string() });

const checkpointTool: AgentTool<typeof checkpointSchema, { startedAt: string }> = {
	name: "checkpoint",
	label: "Checkpoint",
	description: "Create a checkpoint",
	parameters: checkpointSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: `checkpoint:${params.goal}` }],
			details: { startedAt: "2026-01-01T00:00:00.000Z" },
		};
	},
};

const rewindTool: AgentTool<typeof rewindSchema, { report: string; rewound: boolean }> = {
	name: "rewind",
	label: "Rewind",
	description: "Rewind to the checkpoint",
	parameters: rewindSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: "rewind requested" }],
			details: { report: params.report, rewound: true },
		};
	},
};

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
};

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		await harness?.session.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
});

function signedThinking(thinking: string, thinkingSignature: string): MockContent {
	return { type: "thinking", thinking, thinkingSignature } as unknown as MockContent;
}

async function createHarness(responses: MockResponse[]): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-checkpoint-rewind-branch-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const tools = [checkpointTool as AgentTool, rewindTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session, authStorage, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function expectLastAssistant(messages: AgentMessage[]): AssistantMessage {
	const message = messages.at(-1);
	expect(message?.role).toBe("assistant");
	if (message?.role !== "assistant") throw new Error("Expected last message to be assistant");
	return message;
}

describe("AgentSession checkpoint rewind branch context", () => {
	it("rebuilds active history through branch_summary before the post-rewind assistant turn", async () => {
		const report = "findings: kept checkpoint; risks: stale signed thinking";
		const { session, mock } = await createHarness([
			{
				content: [
					signedThinking("checkpoint before exploring", "sig_checkpoint"),
					{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [
					signedThinking("ready to rewind", "sig_rewind"),
					{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } },
				],
				stopReason: "toolUse",
			},
			{
				content: [signedThinking("answer after rewind", "sig_after_rewind"), "DONE"],
				stopReason: "stop",
			},
		]);

		await session.prompt("investigate with a checkpoint");

		expect(mock.calls.length).toBe(3);
		const finalCall = mock.calls[2];
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		const summaryIndex = finalCall.context.messages.findIndex(
			message => message.role === "user" && messageText(message).includes("summary of a branch"),
		);
		const reportIndex = finalCall.context.messages.findIndex(
			message => message.role === "developer" && messageText(message).includes(report),
		);
		expect(summaryIndex).toBeGreaterThan(-1);
		expect(reportIndex).toBeGreaterThan(summaryIndex);
		expect(
			finalCall.context.messages.some(message => message.role === "toolResult" && message.toolName === "rewind"),
		).toBe(false);

		const activeRoles = session.messages.map(message => message.role);
		expect(activeRoles).toEqual(["user", "assistant", "toolResult", "branchSummary", "custom", "assistant"]);
		expect(activeRoles).toEqual(session.sessionManager.buildSessionContext().messages.map(message => message.role));

		const finalAssistant = expectLastAssistant(session.messages);
		const finalThinking = finalAssistant.content.find((block): block is ThinkingContent => block.type === "thinking");
		expect(finalThinking?.thinking).toBe("answer after rewind");
		expect(finalThinking?.thinkingSignature).toBe("sig_after_rewind");
	});
});
