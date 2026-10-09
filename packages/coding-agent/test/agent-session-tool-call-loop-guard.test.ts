import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tool-call-loop-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	/**
	 * Drives `repeats` consecutive identical calls to `toolName`, then a text turn, under the
	 * default `exemptTools` list with a threshold equal to `repeats`.
	 */
	async function runRepeatedCalls(
		toolName: string,
		args: Record<string, unknown>,
		resultText: string,
		repeats: number,
	): Promise<{ contexts: Context[]; redirects: CustomMessage[] }> {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const tool: AgentTool = {
			name: toolName,
			label: toolName,
			description: `Mock ${toolName} tool`,
			parameters: type({ "[string]": "unknown" }),
			execute: async () => ({ content: [{ type: "text" as const, text: resultText }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < repeats;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopped repeating." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": repeats,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[tool.name, tool]]),
		});

		await session.prompt("run checks");
		await session.waitForIdle();

		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-loop-redirect",
		);
		return { contexts, redirects };
	}

	it("injects a hidden redirect before the next model call", async () => {
		const { contexts, redirects } = await runRepeatedCalls(
			"bash",
			{ command: "pytest -q" },
			"1263 passed, 4 skipped",
			2,
		);

		expect(contexts).toHaveLength(3);
		expect(JSON.stringify(contexts[2]!.messages)).toContain("tool_call_loop_detected");
		expect(JSON.stringify(contexts[2]!.messages)).toContain("1263 passed, 4 skipped");
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
	});

	it("does not redirect repeated vibe_wait calls on a still-running worker by default", async () => {
		const { contexts, redirects } = await runRepeatedCalls(
			"vibe_wait",
			{ sessions: ["worker"], timeout: 600 },
			"Still running: `worker`.\nWait window elapsed before any turn settled — re-issue vibe_wait to keep waiting.",
			5,
		);

		expect(contexts).toHaveLength(6);
		expect(JSON.stringify(contexts[5]!.messages)).not.toContain("tool_call_loop_detected");
		expect(redirects).toHaveLength(0);
	});
});
