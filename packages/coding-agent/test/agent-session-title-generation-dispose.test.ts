import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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
// Earlier full-suite files that boot main() in ACP/RPC mode set PI_NO_TITLE=1
// process-wide (main.ts) and never restore it; maybeStartTitleGeneration gates
// on it, so these tests would silently skip titling and time out.
let previousNoTitle: string | undefined;

beforeEach(() => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
});

afterEach(async () => {
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

describe("AgentSession title generation disposal", () => {
	it("uses the active provider session and aborts an in-flight title request during disposal", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const providerSessionId = "provider-session";

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"providers.tinyModel": "online",
		});
		settings.overrideModelRoles({ smol: `${model.provider}/${model.id}` });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const getApiKey = vi.spyOn(modelRegistry, "getApiKey");
		const resolver = vi.spyOn(modelRegistry, "resolver");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			providerSessionId,
		});
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<ai.AssistantMessage>();
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
			requestSignal = options?.signal;
			requestSignal?.addEventListener("abort", () => response.resolve(createAssistantMessage("")), { once: true });
			started.resolve();
			return response.promise;
		});

		const generation = session.generateTitle("Investigate shutdown");
		await started.promise;
		expect(getApiKey.mock.calls[0]?.[1]).toBe(providerSessionId);
		expect(resolver.mock.calls[0]?.[1]).toBe(providerSessionId);
		session.beginDispose();

		expect(requestSignal?.aborted).toBe(true);
		expect(await generation).toBeNull();
	});

	it("does not start a second auto-title request while the first is still in flight", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"providers.tinyModel": "online",
		});
		settings.overrideModelRoles({ smol: `${model.provider}/${model.id}` });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<ai.AssistantMessage>();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			started.resolve();
			return response.promise;
		});

		session.maybeStartTitleGeneration("/skill:implement issues/07-manual-llm.md");
		await started.promise;
		session.maybeStartTitleGeneration("/skill:implement issues/08-app-settings.md");
		expect(completeSimple).toHaveBeenCalledTimes(1);

		response.resolve(createAssistantMessage("<title>manual llm</title>"));
		await response.promise;
	});

	it("lets a replacement session title itself and ignores the previous request", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"providers.tinyModel": "online",
		});
		settings.overrideModelRoles({ smol: `${model.provider}/${model.id}` });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const firstResponse = Promise.withResolvers<ai.AssistantMessage>();
		const secondResponse = Promise.withResolvers<ai.AssistantMessage>();
		let titleCalls = 0;
		const completeSimple = vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			titleCalls += 1;
			if (titleCalls === 1) {
				firstStarted.resolve();
				return firstResponse.promise;
			}
			secondStarted.resolve();
			return secondResponse.promise;
		});
		const generateTitle = vi.spyOn(session, "generateTitle");
		const setSessionName = vi.spyOn(session.sessionManager, "setSessionName");
		const firstSessionId = session.sessionManager.getSessionId();

		session.maybeStartTitleGeneration("/skill:implement issues/07-manual-llm.md");
		await firstStarted.promise;
		expect(await session.newSession()).toBe(true);
		expect(session.sessionManager.getSessionId()).not.toBe(firstSessionId);

		session.maybeStartTitleGeneration("name the replacement session");
		await secondStarted.promise;
		expect(completeSimple).toHaveBeenCalledTimes(2);

		firstResponse.resolve(createAssistantMessage("<title>old skill</title>"));
		expect(await generateTitle.mock.results[0]?.value).toBe("old skill");
		await Promise.resolve();
		expect(setSessionName).not.toHaveBeenCalled();
		expect(session.sessionName).toBeUndefined();

		secondResponse.resolve(createAssistantMessage("<title>replacement session</title>"));
		expect(await generateTitle.mock.results[1]?.value).toBe("replacement session");
		await setSessionName.mock.results[0]?.value;
		expect(session.sessionName).toBe("replacement session");
	});
});
