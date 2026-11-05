import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

async function createSession(): Promise<AgentSession> {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	const fallback = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!model || !fallback) throw new Error("Expected bundled anthropic title models");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: createMockModel({ handler: { content: ["Done"] } }).stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			modelRoles: { tiny: `${model.provider}/${model.id}`, smol: `${fallback.provider}/${fallback.id}` },
			"retry.modelFallback": true,
			"retry.fallbackChains": { [`${model.provider}/${model.id}`]: [`${fallback.provider}/${fallback.id}`] },
		}),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return session;
}

/** A billed title response costing `cost`. */
function titleResponse(text: string, cost: number, stopReason: ai.StopReason = "stop"): ai.AssistantMessage {
	const message = createAssistantMessage(text);
	message.stopReason = stopReason;
	message.usage.cost.total = cost;
	return message;
}

describe("AgentSession title generation usage", () => {
	it("journals every billed title request in the session totals, failed fallbacks included", async () => {
		const current = await createSession();
		const manager = current.sessionManager;
		manager.appendMessage({ role: "user", content: "Investigate the resolver", timestamp: 1 });
		const leafBefore = manager.getLeafId();
		// The first candidate answers without a title, so the generator falls through to the next.
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(titleResponse("", 0.01))
			.mockResolvedValueOnce(titleResponse("<title>Resolver Investigation</title>", 0.02));
		const statsBefore = manager.getUsageStatistics().cost;

		const title = await current.generateTitle("Investigate the resolver");

		expect(title).toBe("Resolver Investigation");
		const usage = manager.getEntries().filter(entry => entry.type === "model_usage");
		expect(usage).toMatchObject([
			{ purpose: "title", parentId: leafBefore, usage: { cost: { total: 0.01 } } },
			{ purpose: "title", usage: { cost: { total: 0.02 } } },
		]);
		expect(manager.getUsageStatistics().cost - statsBefore).toBeCloseTo(0.03);
	});

	it("drops a title request's usage when the session switched while it was in flight", async () => {
		const current = await createSession();
		const original = current.sessionManager.getSessionId();
		const response = Promise.withResolvers<ai.AssistantMessage>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			started.resolve();
			return response.promise;
		});

		const generation = current.generateTitle("Investigate the resolver");
		await started.promise;
		await current.newSession();
		response.resolve(titleResponse("<title>Resolver Investigation</title>", 0.02));

		expect(await generation).toBeNull();
		expect(current.sessionManager.getSessionId()).not.toBe(original);
		expect(current.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
	});
});
