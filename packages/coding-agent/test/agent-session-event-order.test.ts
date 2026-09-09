/**
 * Subscriber event-order contract for `AgentSession`.
 *
 * Extension emits inside the session's event pipeline only await when the
 * event type has registered handlers. For a turn whose provider events all
 * land in one tick (e.g. an instant Anthropic classifier refusal: empty
 * `message_start` + terminal `message_delta` + `message_stop` in a single SSE
 * flush), an event type WITHOUT extension handlers used to overtake an earlier
 * event WITH handlers — the TUI received the assistant `message_end` before
 * its own `message_start`, so no streaming component existed yet and the
 * turn-ending error (pinned banner + inline `Error:` line) was never rendered.
 * The session must deliver events to subscribers in emission order regardless
 * of which event types extensions subscribe to.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession subscriber event order", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-event-order-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	it("delivers message_start before message_end when extension handlers are asymmetric", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");

		// Instant terminal error turn: start and end reach the session pipeline
		// in the same tick, exactly like a real classifier refusal.
		const mock = createMockModel({
			responses: [
				{
					stopReason: "error",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
					errorMessage: "Refusal (cyber): Declined.",
				},
			],
		});
		const agent = new Agent({
			getApiKey: agentModel => `${agentModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
		});

		// Handlers exist for message_start only, and each emit burns a burst of
		// microtasks — so the handler-less message_end path would skip its
		// extension await and overtake the start without subscriber-order
		// serialization.
		const extensionRunner = {
			emit: vi.fn(async () => {
				for (let hop = 0; hop < 25; hop++) await Promise.resolve();
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "message_start"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		const order: string[] = [];
		session.subscribe(event => {
			if (event.type === "message_start" || event.type === "message_end") {
				order.push(`${event.type}:${event.message.role}`);
			}
		});

		await session.prompt("Trigger instant refusal");
		await session.waitForIdle();

		for (const role of ["user", "assistant"]) {
			const startIndex = order.indexOf(`message_start:${role}`);
			const endIndex = order.indexOf(`message_end:${role}`);
			expect(startIndex).toBeGreaterThanOrEqual(0);
			expect(endIndex).toBeGreaterThan(startIndex);
		}
	});

	it("preserves every completion from a batch of exclusive todo calls", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");

		const tasks = ["one", "two", "three", "four", "five", "six"];
		const calls: ToolCall[] = tasks.map((task, index) => ({
			type: "toolCall",
			id: `todo-${index}`,
			name: "todo",
			arguments: { op: "done", task },
		}));
		const mock = createMockModel({
			responses: [{ content: calls }, { content: ["Done"] }],
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"tools.xdev": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const todo = new TodoTool({
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
			getTodoPhases: () => session?.getTodoPhases() ?? [],
			setTodoPhases: phases => {
				session?.setTodoPhases(phases);
			},
		});
		const agent = new Agent({
			getApiKey: agentModel => `${agentModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [todo],
				messages: [],
			},
			streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setTodoPhases([
			{
				name: "Execution",
				tasks: tasks.map((content, index) => ({
					content,
					status: index === 0 ? "in_progress" : "pending",
				})),
			},
		]);

		await session.prompt("Complete every task");
		await session.waitForIdle();
		const toolResults = agent.state.messages.filter(message => message.role === "toolResult");
		expect(toolResults.map(result => result.toolName)).toEqual(tasks.map(() => "todo"));

		expect(session.getTodoPhases()[0]?.tasks.map(task => task.status)).toEqual(tasks.map(() => "completed"));
	});
});
