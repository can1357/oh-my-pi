import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(model: Model, fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

describe("AgentSession.restoreInterruptedTurn (omp --restore)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-restore-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** A session reopened from `persisted` as `--resume` builds it, its model answering from `responses`. */
	function reopen(model: Model, persisted: Message[], tools: AgentTool[], responses: MockResponse[]) {
		const sessionManager = SessionManager.inMemory();
		for (const message of persisted) sessionManager.appendMessage(message);
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: sessionManager.buildSessionContext().messages,
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});
		return { session, mock };
	}

	it("goes on with a turn a crash cut off mid tool call, running the cut-off call again", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const probeTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
			},
		};
		// The process died while `probe` ran: no tool result, no session_exit record.
		const { session, mock } = reopen(
			model,
			[
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			],
			[probeTool as AgentTool],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "done after restore" });
	});

	it("leaves a turn the user interrupted, and one that finished, as they are", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const interrupted: Message[] = [
			{ role: "user", content: "run the probe", timestamp: Date.now() },
			assistant(model, {
				content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "x" } }],
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "probe",
				content: [{ type: "text", text: "Execution interrupted" }],
				isError: true,
				timestamp: Date.now(),
			},
			assistant(model, { stopReason: "aborted", errorMessage: "Interrupted by user" }),
		];
		const finished: Message[] = [
			{ role: "user", content: "say hi", timestamp: Date.now() },
			assistant(model, { content: [{ type: "text", text: "hi" }] }),
		];
		for (const persisted of [interrupted, finished]) {
			const { session, mock } = reopen(model, persisted, [], []);
			await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
			expect(mock.calls.length).toBe(0);
			await session.dispose();
		}
		session = undefined;
	});
});
