import { afterEach, describe, expect, it, vi } from "bun:test";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	kRequestModelOrigin,
	type OriginStampedAssistantMessage,
} from "@oh-my-pi/pi-coding-agent/session/request-model-origin";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const SOURCE = "sdk-request-model-origin-test";
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	unregisterCustomApis(SOURCE);
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("SDK request model origin", () => {
	it("keeps a caller-owned Codex model on the active pool after a same-provider switch", async () => {
		registerMockApi(SOURCE);
		const root = TempDir.createSync("@pi-sdk-request-origin-");
		cleanups.push(() => root.removeSync());
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai-codex", "test-key");
		cleanups.push(() => auth.close());
		const settings = Settings.isolated({
			"retry.enabled": false,
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		const registry = new ModelRegistry(auth, root.join("models.yml"), { settings });
		const chat = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!chat) throw new Error("Expected bundled Codex chat model");
		const customId = "gpt-5.3-codex-spark-sdk-custom";
		expect(registry.hasProvider(chat.provider)).toBe(true);
		expect(registry.find(chat.provider, customId)).toBeUndefined();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const custom = createMockModel({
			provider: chat.provider,
			id: customId,
			handler: async () => {
				started.resolve();
				await release.promise;
				return { stopReason: "error", errorMessage: "429 usage_limit_reached: Try again in ~9701 min." };
			},
		});
		const { session } = await createAgentSession({
			cwd: root.path(),
			agentDir: root.path(),
			modelRegistry: registry,
			model: custom,
			getApiKey: () => "test-key",
			sessionManager: SessionManager.inMemory(root.path()),
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			cacheWarming: false,
		});
		cleanups.push(() => session.dispose());
		const messages: AssistantMessage[] = [];
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") messages.push(event.message);
		});
		const markReached = vi.spyOn(auth.limits, "markReached").mockResolvedValue({ switched: false });
		const prompting = session.prompt("hello");
		await started.promise;
		session.agent.setModel(chat);
		release.resolve();
		await prompting;
		const failed: OriginStampedAssistantMessage | undefined = messages.find(
			message => message.stopReason === "error",
		);
		expect(failed).toBeDefined();
		expect(failed?.[kRequestModelOrigin]).toEqual({
			provider: chat.provider,
			modelId: customId,
			source: "external",
		});
		expect(markReached).toHaveBeenCalledWith(
			chat.provider,
			session.sessionId,
			expect.objectContaining({ modelId: chat.id }),
		);
		expect(JSON.stringify(failed)).not.toContain("request-model-origin");
		session.agent.setModel(custom);
		await session.prompt("again");
		const failures = messages.filter(message => message.stopReason === "error") as OriginStampedAssistantMessage[];
		expect(failures).toHaveLength(2);
		expect(failures[1]?.[kRequestModelOrigin]).toEqual(failed?.[kRequestModelOrigin]);
		expect(markReached).toHaveBeenCalledTimes(2);
	});

	it("does not charge chat when a registered Spark request throws after its model is removed", async () => {
		registerMockApi(SOURCE);
		const root = TempDir.createSync("@pi-sdk-retired-origin-");
		cleanups.push(() => root.removeSync());
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai-codex", "test-key");
		cleanups.push(() => auth.close());
		const settings = Settings.isolated({
			"retry.enabled": false,
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		const registry = new ModelRegistry(auth, root.join("models.yml"), { settings });
		const chat = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!chat) throw new Error("Expected bundled Codex chat model");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const retired = createMockModel({
			provider: chat.provider,
			id: "gpt-5.3-codex-spark-retired",
			handler: async () => {
				started.resolve();
				await release.promise;
				throw new Error("429 usage_limit_reached: Try again in ~9701 min.");
			},
		});
		const originalFind = registry.find.bind(registry);
		let registered = true;
		const find = vi.spyOn(registry, "find").mockImplementation((provider, id) => {
			if (provider === retired.provider && id === retired.id) return registered ? retired : undefined;
			return originalFind(provider, id);
		});
		const { session } = await createAgentSession({
			cwd: root.path(),
			agentDir: root.path(),
			modelRegistry: registry,
			model: retired,
			getApiKey: () => "test-key",
			sessionManager: SessionManager.inMemory(root.path()),
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			cacheWarming: false,
		});
		cleanups.push(() => session.dispose());
		const messages: AssistantMessage[] = [];
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") messages.push(event.message);
		});
		const markReached = vi.spyOn(auth.limits, "markReached").mockResolvedValue({ switched: false });
		const prompting = session.prompt("hello");
		await started.promise;
		expect(find).toHaveBeenCalledWith(retired.provider, retired.id);
		registered = false;
		session.agent.setModel(chat);
		release.resolve();
		await prompting;
		const failed: OriginStampedAssistantMessage | undefined = messages.find(
			message => message.stopReason === "error",
		);
		expect(markReached).not.toHaveBeenCalled();
		expect(failed?.[kRequestModelOrigin]).toEqual({
			provider: retired.provider,
			modelId: retired.id,
			source: "registry",
		});
	});
});
