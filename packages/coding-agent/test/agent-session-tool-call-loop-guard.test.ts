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

	it("injects a hidden redirect before the next model call", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "1263 passed, 4 skipped" }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < 2;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q" } }],
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
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": ["wait"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("run checks");
		await session.waitForIdle();

		expect(contexts).toHaveLength(3);
		expect(JSON.stringify(contexts[2]!.messages)).toContain("tool_call_loop_detected");
		expect(JSON.stringify(contexts[2]!.messages)).toContain("1263 passed, 4 skipped");
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-loop-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
	});

	it.each([
		{
			scenario: "exempt tool command",
			command: "mcp__peers_wait --json {}",
			exempt: "mcp__peers_wait",
			redirects: 0,
		},
		{
			scenario: "other tool command",
			command: "mcp__other_tool --json {}",
			exempt: "mcp__peers_wait",
			redirects: 1,
		},
		{
			scenario: "plain shell command",
			command: "git status",
			exempt: "mcp__peers_wait",
			redirects: 1,
		},
		{
			scenario: "reserved shell command",
			command: "grep -r toolCommands",
			exempt: "grep",
			redirects: 1,
		},
		{
			scenario: "transport exemption",
			command: "git status",
			exempt: "bash",
			redirects: 0,
		},
	])("applies loop exemptions to $scenario", async ({ command, exempt, redirects }) => {
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock command transport",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text", text: "No new results" }] }),
		};
		const mock = createMockModel({
			provider: "openai",
			responses: [
				{ content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
				{ content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
				{ content: ["Finished waiting."] },
			],
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": [exempt],
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools: [tool], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([["bash", tool]]),
		});

		await session.prompt("wait for results");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(session.agent.state.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "tool-call-loop-redirect",
			),
		).toHaveLength(redirects);
	});

	it("redirects a streak of varied calls to tools that do not exist (issue #10876)", async () => {
		const tool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Mock write tool",
			parameters: type({ "path?": "string" }),
			execute: async () => ({ content: [{ type: "text", text: "written" }] }),
		};
		const mock = createMockModel({
			provider: "openai",
			responses: [
				{ content: [{ type: "toolCall", name: "wri", arguments: { path: "a.txt" } }] },
				{ content: [{ type: "toolCall", name: "ed", arguments: { path: "b.txt" } }] },
				{ content: ["Stopped guessing tool names."] },
			],
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": [],
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools: [tool], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([["write", tool]]),
		});

		await session.prompt("write the files");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-loop-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.details).toMatchObject({ kind: "unresolved_tool_call", toolName: "ed", count: 2 });
		expect(JSON.stringify(redirects[0]!.content)).toContain("tools that do not exist");
	});
});
