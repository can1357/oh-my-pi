/**
 * A prompt routed to a registered extension command is admitted (fires
 * PromptOptions.onPromptAdmitted) once the command is resolved, before its
 * handler runs — not only after the handler finishes. Without this, an RPC
 * `prompt` whose message names a registered extension command would block
 * its acknowledgement on the handler's full duration instead of just routing,
 * reintroducing the "can outlast any client's prompt timeout" problem the
 * admission-gated ack is meant to avoid.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { withTimeout } from "@oh-my-pi/pi-utils";

describe("AgentSession prompt admission via extension command routing", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
	});

	it("fires onPromptAdmitted once the command is routed, before its handler runs", async () => {
		const order: string[] = [];
		const handlerEntered = Promise.withResolvers<void>();
		const releaseHandler = Promise.withResolvers<void>();

		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerCommand("slow", {
					handler: async () => {
						order.push("handler-entered");
						handlerEntered.resolve();
						await releaseHandler.promise;
						order.push("handler-done");
					},
				});
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"slow-command",
		);

		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});

		const promptPromise = session.prompt("/slow", {
			onPromptAdmitted: () => order.push("admitted"),
		});

		// Bounded wait on the handler actually starting — not a fixed-duration
		// guess — then assert admission already fired first.
		await withTimeout(handlerEntered.promise, 2_000, "Extension command handler never started");
		expect(order).toEqual(["admitted", "handler-entered"]);

		releaseHandler.resolve();
		expect(await promptPromise).toBe(false);
		expect(order).toEqual(["admitted", "handler-entered", "handler-done"]);
	});
});
