import { afterEach, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import * as autoThinking from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
	VibeSessionRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("shares Vibe sibling cache routing by worker type while keeping conversations separate", async () => {
	using directory = TempDir.createSync("@omp-vibe-cache-");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	// Task workers classify each turn's difficulty through the judge role, whose native backends
	// retry a failed request with backoff; fail the classification outright, as offline, so each
	// worker falls back to its provisional level at once.
	vi.spyOn(autoThinking, "classifyDifficulty").mockRejectedValue(new Error("Network is disabled in this test"));
	const authStorage = await AuthStorage.create(directory.join("auth.db"));
	authStorage.keys.setRuntime("muse-code", JSON.stringify({ oauthAccessToken: "test-oauth", apiKey: "test-key" }));
	const modelId = "muse-spark-1.3-contributor";
	const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"), {
		fetch: async () => Response.json({ data: [{ id: modelId, object: "model", created: 0, owned_by: "meta" }] }),
	});
	await modelRegistry.refreshProvider("muse-code", "online");
	const settings = Settings.isolated({
		modelRoles: { default: `muse-code/${modelId}`, task: `muse-code/${modelId}`, smol: `muse-code/${modelId}` },
		"task.structured": true,
		"task.enableLsp": false,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
	});
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const parent = {
		cwd: directory.path(),
		settings,
		authStorage,
		modelRegistry,
		asyncJobManager: manager,
		getSessionId: () => "vibe-parent-session",
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getPromptCacheKey: () => "parent-cache-lineage",
		taskDepth: 0,
		enableLsp: false,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		rules: [],
		extensionPaths: [],
		customToolPaths: [],
	} as unknown as ToolSession;
	const sessions: AgentSession[] = [];
	const realCreateSession = sdk.createAgentSession;
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
		const result = await realCreateSession(options);
		sessions.push(result.session);
		return result;
	});
	const requests: Array<{ key: unknown; sessionId: string | undefined }> = [];
	const mock = createMockModel({
		handler: { content: [{ type: "toolCall", name: "yield", arguments: { data: { findings: [] } } }] },
	});
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((streamSettings, _base, slow) =>
		realStreamFactory(
			streamSettings,
			(model, context, options) => {
				const cacheOptions = {
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
				};
				const body = buildParams(model as Model<"openai-responses">, context, cacheOptions, undefined).params;
				requests.push({ key: body.prompt_cache_key, sessionId: options?.sessionId });
				return mock.stream(model, context, options);
			},
			slow,
		),
	);
	try {
		const registry = VibeSessionRegistry.global();
		for (const [name, cli] of [
			["GoodA", "good"],
			["GoodB", "good"],
			["FastA", "fast"],
		] as const) {
			const spawned = await registry.spawn(parent, { name, cli, prompt: "Review the supplied code." });
			const job = manager.getJob(spawned.jobId);
			if (!job) throw new Error(`Missing Vibe job ${spawned.jobId}`);
			await job.promise;
			expect(job.status, job.errorText ?? job.resultText).toBe("completed");
		}
		expect(requests.map(request => request.key)).toEqual([
			"parent-cache-lineage:task",
			"parent-cache-lineage:task",
			"parent-cache-lineage:sonic",
		]);
		expect(new Set(requests.map(request => request.sessionId)).size).toBe(3);
	} finally {
		await manager.dispose({ timeoutMs: 100 });
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
	}
}, 30_000);
