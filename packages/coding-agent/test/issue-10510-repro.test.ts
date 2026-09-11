import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Issue #10510: with prewalk armed and `todo.eager=always`, the session injected
 * two contradictory hidden system messages — the forced eager-todo prelude
 * ("call todo first this turn") and the prewalk plan nudge ("write a complete
 * plan first, then todo"). Prewalk's plan flow already owns todo creation, so
 * the eager prelude must yield to it while a prewalk is armed.
 */
describe("issue #10510: prewalk + eager-todo conflict", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-issue-10510-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected bundled model ${id}`);
		return model;
	}

	function messageText(message: AgentMessage): string {
		if (!("content" in message)) return "";
		const content = message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
				if (typeof block.text === "string") parts.push(block.text);
			}
		}
		return parts.join("\n");
	}

	const mkTool = (name: string, result: string): AgentTool => ({
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: result }], details: undefined };
		},
	});

	function toolCall(id: string, name: string): MockResponse {
		return { content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse" };
	}

	/** Runs a first-turn prompt and returns every hidden/visible text sent to the model. */
	async function collectInjectedText(options: { prewalk: "handoff" | "noop" | "off" }): Promise<string> {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const handoffTarget = modelOrThrow("claude-sonnet-4-6");
		const prewalkTarget =
			options.prewalk === "handoff" ? handoffTarget : options.prewalk === "noop" ? primary : undefined;
		const recordTool = mkTool("record", "ok");
		const writeTool = mkTool("write", "wrote");
		const todoTool = mkTool("todo", "listed");
		const toolRegistry = new Map<string, AgentTool>([
			[recordTool.name, recordTool],
			[writeTool.name, writeTool],
			[todoTool.name, todoTool],
		]);
		const mock = createMockModel({
			responses: [toolCall("t1", "todo"), toolCall("t2", "record"), toolCall("t3", "write"), { content: ["done"] }],
		});

		const injected: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool, writeTool, todoTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			getToolChoice: () => session.nextToolChoiceDirective(),
			streamFn: (model, context, streamOptions) => {
				for (const message of context.messages) injected.push(messageText(message));
				return mock.stream(model, context, streamOptions);
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.eager": "always",
				"todo.reminders": false,
			}),
			modelRegistry,
			toolRegistry,
			...(prewalkTarget ? { prewalk: { target: prewalkTarget } } : {}),
		});

		await session.prompt("do the task");
		await session.dispose();
		return injected.join("\n---\n");
	}

	it("suppresses the forced eager-todo prelude while prewalk is armed", async () => {
		const text = await collectInjectedText({ prewalk: "handoff" });
		expect(text.includes("write complete plan")).toBe(true);
		expect(text.includes("You MUST call") && text.includes("first in this turn")).toBe(false);
	});

	it("still injects the forced eager-todo prelude when prewalk is not armed", async () => {
		const text = await collectInjectedText({ prewalk: "off" });
		expect(text.includes("write complete plan")).toBe(false);
		expect(text.includes("You MUST call") && text.includes("first in this turn")).toBe(true);
	});

	it("keeps the forced eager-todo prelude when the armed prewalk is a no-op", async () => {
		const text = await collectInjectedText({ prewalk: "noop" });
		expect(text.includes("write complete plan")).toBe(false);
		expect(text.includes("You MUST call") && text.includes("first in this turn")).toBe(true);
	});
});
