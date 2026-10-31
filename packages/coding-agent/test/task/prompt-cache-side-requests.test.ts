import { afterEach, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Request {
	stage: string;
	provider: string;
	sessionId: string | undefined;
	key: unknown;
	system: unknown;
	tools: unknown;
	input: unknown;
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it.each([
	["Muse automatic key", false, false],
	["model switched to Luna", true, false],
	["explicit Muse key", false, true],
	["explicit Luna key", true, true],
] as const)(
	"keeps primary, ephemeral, and handoff routing consistent for %s",
	async (_name, switchToLuna, explicit) => {
		using dir = TempDir.createSync("@omp-task-side-cache-");
		const auth = await AuthStorage.create(dir.join("auth.db"));
		auth.keys.setRuntime("muse-code", "test-key");
		auth.keys.setRuntime("openai-codex", "test-key");
		const mock = createMockModel({ handler: { content: [{ type: "text", text: "## Goal\nContinue the review." }] } });
		const requests: Request[] = [];
		let stage = "seed";
		const realFactory = settingsStream.createSettingsAwareStreamFn;
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
			realFactory(
				settings,
				async (model, context, options) => {
					const cacheOptions = {
						sessionId: options?.sessionId,
						promptCacheKey: options?.promptCacheKey,
						providerSessionState: options?.providerSessionState,
					};
					const body =
						model.api === "openai-codex-responses"
							? await buildTransformedCodexRequestBody(
									model as Model<"openai-codex-responses">,
									context,
									cacheOptions,
								)
							: buildParams(model as Model<"openai-responses">, context, cacheOptions, undefined).params;
					requests.push({
						stage,
						provider: model.provider,
						sessionId: options?.sessionId,
						key: body.prompt_cache_key,
						system: context.systemPrompt,
						tools: body.tools,
						input: body.input,
					});
					return mock.stream(model, context, options);
				},
				slow,
			),
		);
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: auth,
			model: getBundledModel("muse-code", "muse-spark-1.3-contributor"),
			providerSessionId: "child-provider-session",
			providerPromptCacheKey: explicit ? "configured-cache" : undefined,
			taskPromptCacheKey: "parent:task",
			sessionManager: SessionManager.inMemory(dir.path()),
			settings: Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
				"compaction.enabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			systemPrompt: ["Review the supplied code."],
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			await session.prompt("Review the cache-key change.");
			expect(requests[0]?.key).toBe(explicit ? "configured-cache" : "parent:task");
			if (switchToLuna) session.agent.setModel(getBundledModel("openai-codex", "gpt-6-luna"));
			if (explicit) session.agent.promptCacheKey = "live-explicit-cache";
			stage = "primary";
			await session.prompt("Check the next part.");
			stage = "ephemeral";
			await session.runEphemeralTurn({ promptText: "Summarize the current result." });
			stage = "handoff";
			await session.handoff();
			const current = requests.slice(1);
			expect(current.map(r => r.stage)).toEqual(["primary", "ephemeral", "handoff"]);
			expect(current.map(r => r.provider)).toEqual(Array(3).fill(switchToLuna ? "openai-codex" : "muse-code"));
			const expected = explicit ? "live-explicit-cache" : switchToLuna ? "child-provider-session" : "parent:task";
			expect(current.map(r => r.key)).toEqual(Array(3).fill(expected));
			const primary = current[0];
			for (const side of current.slice(1)) {
				expect(side.system).toEqual(primary.system);
				expect(side.tools).toEqual(primary.tools);
				if (!Array.isArray(side.input) || !Array.isArray(primary.input)) {
					throw new Error("Expected Responses input arrays");
				}
				expect(side.input.slice(0, primary.input.length)).toEqual(primary.input);
				expect(side.sessionId).not.toBe(primary.sessionId);
			}
			expect(current[1]?.sessionId).not.toBe(current[2]?.sessionId);
		} finally {
			await session.dispose();
			auth.close();
		}
	},
);
