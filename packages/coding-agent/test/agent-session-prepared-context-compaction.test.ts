import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("compacts with the staged extension system prompt before sending the first request", async () => {
	const dir = TempDir.createSync("@prepared-context-");
	cleanups.push(() => dir.remove());
	const auth = await AuthStorage.create(":memory:");
	cleanups.push(async () => auth.close());
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, contextWindow: 8192, maxTokens: 2048 };
	const policy = "Additional execution policy. ".repeat(400);
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("before_agent_start", () => ({ systemPrompt: ["Test", policy] }));
			pi.on("session_before_compact", event => ({
				compaction: {
					summary: "Earlier work completed.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			}));
		},
		dir.path(),
		new EventBus(),
		runtime,
		"prepared-context-compaction",
	);
	const runner = new ExtensionRunner([extension], runtime, dir.path(), manager, registry);
	const requestSizes: number[] = [];
	const compactedAtRequest: boolean[] = [];
	let compactionCompleted = false;
	const mock = createMockModel({
		responses: [
			context => {
				requestSizes.push(
					agent.tokenizer.countTokens(context.systemPrompt ?? []) +
						agent.tokenizer.countMessages(context.messages),
				);
				compactedAtRequest.push(compactionCompleted);
				return { content: ["done"] };
			},
		],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 100,
			"compaction.reserveTokens": 2048,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		}),
		modelRegistry: registry,
		extensionRunner: runner,
		toolRegistry: new Map(),
	});
	cleanups.push(() => session.dispose());
	for (let turn = 0; turn < 6; turn++) {
		manager.appendMessage({
			role: "user",
			content: `Turn ${turn}: ${"Earlier task detail. ".repeat(50)}`,
			timestamp: Date.now(),
		});
		const reply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Historical response detail. ".repeat(50) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		manager.appendMessage(reply);
	}
	agent.replaceMessages(manager.buildSessionContext().messages);
	const historyTokens = agent.tokenizer.countMessages(agent.state.messages);
	expect(historyTokens + 2048).toBeLessThan(model.contextWindow);
	expect(historyTokens + agent.tokenizer.countTokens(policy) + 2048).toBeGreaterThan(model.contextWindow);
	session.subscribe(event => {
		if (event.type === "auto_compaction_end" && event.result) compactionCompleted = true;
	});
	await session.prompt("Continue the work");
	expect(compactedAtRequest).toEqual([true]);
	expect(requestSizes).toHaveLength(1);
	expect(requestSizes[0]! + 2048).toBeLessThanOrEqual(model.contextWindow);
	expect(JSON.stringify(mock.calls[0]!.context.systemPrompt)).toContain("Additional execution policy.");
});
