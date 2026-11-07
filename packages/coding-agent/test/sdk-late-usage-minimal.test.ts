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
});
