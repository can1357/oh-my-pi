import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it("does not count a sibling advisor's read toward its own repeat warning, even on the same model", async () => {
	const temp = TempDir.createSync("@pi-advisor-repeat-read-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	const settings = Settings.isolated({
		"advisor.syncBacklog": "1",
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
	});
	const evalTool: Tool = {
		name: "eval",
		label: "Eval",
		description: "Test documentation",
		parameters: type({}),
		execute: async () => ({ content: [] }),
		docTopics: () => ({ browser: "sample\ntext" }),
	};
	const toolSession: ToolSession = {
		cwd: temp.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		getToolByName: name => (name === "eval" ? evalTool : undefined),
	};
	const placeholderRead: AgentTool = {
		name: "read",
		label: "Read",
		description: "Unused shared read",
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text", text: "shared reader was used" }] }),
	};
	const results: string[] = [];
	let calls = 0;
	const model = createMockModel({ provider: "anthropic" });
	const stream: StreamFn = (_model, context) => {
		const isFirstRead = context.messages.at(-1)?.role === "user";
		if (!isFirstRead) {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				results.push(
					last.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n"),
				);
			}
		}
		const message: AssistantMessage = {
			role: "assistant",
			content: isFirstRead
				? [
						{
							type: "toolCall",
							id: `advisor-read-${++calls}`,
							name: "read",
							arguments: { path: "xd://eval/browser" },
						},
					]
				: [{ type: "text", text: "Reviewed." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: isFirstRead ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		const events = new AssistantMessageEventStream();
		queueMicrotask(() => {
			events.push({ type: "start", partial: message });
			events.push({ type: "done", reason: isFirstRead ? "toolUse" : "stop", message });
		});
		return events;
	};
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: [], tools: [] },
			streamFn: createMockModel({ provider: "anthropic", responses: [{ content: ["primary complete"] }] }).stream,
		}),
		sessionManager: SessionManager.inMemory(temp.path()),
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorTools: [placeholderRead],
		advisorCreateReadTool: () => new ReadTool(toolSession),
		advisorStreamFn: stream,
		advisorConfigs: [{ name: "First" }, { name: "Second" }, { name: "Third" }],
	});
	try {
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("Review this update");
		expect(await session.waitForAdvisorCatchup(5_000)).toBe(true);
		expect(results).toHaveLength(3);
		expect(results).toEqual(["sample\ntext", "sample\ntext", "sample\ntext"]);
	} finally {
		await session.dispose();
		auth.close();
		await temp.remove();
	}
});
