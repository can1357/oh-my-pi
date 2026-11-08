import { afterEach, describe, expect, it, vi } from "bun:test";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { kUsageLimitRequestProvider } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const SOURCE = "sdk-late-usage-minimal-test";
type TaggedMessage = AssistantMessage & { [kUsageLimitRequestProvider]?: string };
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	unregisterCustomApis(SOURCE);
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("SDK delayed quota error after a provider switch", () => {
	for (const mode of ["returned", "thrown"] as const) {
		it(`does not block the healthy fallback when the old request error is ${mode}`, async () => {
			registerMockApi(SOURCE);
			const root = TempDir.createSync("@pi-sdk-late-usage-");
			cleanups.push(() => root.removeSync());
			const auth = createInMemoryAuthStorage();
			cleanups.push(() => auth.close());
			auth.keys.setRuntime("openai-codex", "test-key");
			auth.keys.setRuntime("anthropic", "test-key");
			const settings = Settings.isolated({
				"retry.enabled": false,
				"compaction.enabled": false,
				"todo.enabled": false,
			});
			const registry = new ModelRegistry(auth, root.join("models.yml"), { settings });
			const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
			const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!codex || !anthropic) throw new Error("Expected bundled Codex and Anthropic models");
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const lateError = "429 usage_limit_reached: You've reached your ChatGPT plan limit. Try again in ~9701 min.";
			const oldModel = createMockModel({
				provider: codex.provider,
				id: `gpt-6.1-sol-sdk-late-${mode}`,
				handler: async () => {
					started.resolve();
					await release.promise;
					if (mode === "thrown") throw new Error(lateError);
					return { stopReason: "error", errorMessage: lateError };
				},
			});
			const { session } = await createAgentSession({
				cwd: root.path(),
				agentDir: root.path(),
				modelRegistry: registry,
				model: oldModel,
				getApiKey: async () => "test-key",
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
			const mark = vi.spyOn(auth.limits, "markReached").mockResolvedValue({ switched: false });
			const prompting = session.prompt("hello");
			await started.promise;
			session.agent.setModel(anthropic);
			release.resolve();
			await prompting;
			const failed = messages.find(message => message.stopReason === "error") as TaggedMessage | undefined;
			expect(failed?.provider).toBe("openai-codex");
			expect(failed?.model).toBe(oldModel.id);
			expect(failed?.[kUsageLimitRequestProvider]).toBe("openai-codex");
			expect(mark).not.toHaveBeenCalled();
		});
	}

	it("tries the selected provider after the old request exhausts its retry budget", async () => {
		registerMockApi(SOURCE);
		const root = TempDir.createSync("@pi-sdk-late-budget-");
		cleanups.push(() => root.removeSync());
		const auth = createInMemoryAuthStorage();
		cleanups.push(() => auth.close());
		auth.keys.setRuntime("openai-codex", "test-key");
		auth.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated({
			"retry.enabled": true,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 6,
			"retry.modelFallback": false,
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		const registry = new ModelRegistry(auth, root.join("models.yml"), { settings });
		const secondStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const calls: string[] = [];
		const retryEvents: string[] = [];
		const retryDelays: number[] = [];
		const oldModel = createMockModel({
			provider: "openai-codex",
			id: "gpt-6.1-sol-sdk-late-budget",
			handler: async () => {
				calls.push("old");
				if (calls.length === 1) return { stopReason: "error", errorMessage: "500 Internal Server Error" };
				secondStarted.resolve();
				await release.promise;
				return {
					stopReason: "error",
					errorMessage: "429 usage_limit_reached: You've reached your ChatGPT plan limit. Try again in ~9701 min.",
				};
			},
		});
		const selectedModel = createMockModel({
			provider: "anthropic",
			id: "claude-sdk-late-budget",
			handler: () => {
				calls.push("selected");
				return { content: ["recovered"], stopReason: "stop" };
			},
		});
		const { session } = await createAgentSession({
			cwd: root.path(),
			agentDir: root.path(),
			modelRegistry: registry,
			model: oldModel,
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
		const mark = vi.spyOn(auth.limits, "markReached").mockResolvedValue({ switched: false });
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryDelays.push(event.delayMs);
			if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retryEvents.push(event.type);
		});
		const prompting = session.prompt("hello");
		try {
			await secondStarted.promise;
			session.agent.setModel(selectedModel);
		} finally {
			release.resolve();
		}
		await prompting;
		await session.waitForIdle();
		expect(calls).toEqual(["old", "old", "selected"]);
		expect(retryEvents).toEqual(["auto_retry_start", "auto_retry_start", "auto_retry_end"]);
		expect(retryDelays[0]).toBeGreaterThan(0);
		expect(retryDelays[1]).toBe(0);
		expect(mark).not.toHaveBeenCalled();
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") expect(last.stopReason).toBe("stop");
	});
});
