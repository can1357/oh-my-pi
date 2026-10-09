import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

function createScriptedAgent(model: Model, requestedModels: string[], responses: MockResponse[]): Agent {
	return new Agent({
		getApiKey: candidate => `${candidate.provider}-test-key`,
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (candidate, context, options) => {
			requestedModels.push(formatModelStringWithRouting(candidate));
			const response = responses.shift();
			if (!response) throw new Error("Unexpected model request");
			return createMockModel({ provider: candidate.provider, id: candidate.id, responses: [response] }).stream(
				candidate,
				context,
				options,
			);
		},
	});
}

describe("AgentSession /new fallback persistence", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions = new Set<AgentSession>();

	function trackSession(session: AgentSession): AgentSession {
		sessions.add(session);
		return session;
	}

	async function closeSession(session: AgentSession): Promise<void> {
		sessions.delete(session);
		await session.dispose();
	}

	async function coldResume(sessionFile: string, settings: Settings): Promise<AgentSession> {
		const resumedManager = await SessionManager.open(sessionFile, tempDir.join("resumed-fallback-new-session"));
		const resumed = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager: resumedManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			toolNames: [],
			restrictToolNames: true,
		});
		return trackSession(resumed.session);
	}

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-fallback-new-session-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		authStorage.keys.setRuntime("openrouter", "openrouter-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		for (const session of sessions) {
			await session.dispose();
		}
		sessions.clear();
	});

	it.each([
		{ provider: "anthropic", id: "claude-opus-4-1", thinking: Effort.Low },
		{ provider: "openai", id: "gpt-4o-mini", thinking: undefined },
	])("preserves the availability primary across /new with $provider/$id", async ({ provider, id, thinking }) => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallbackModel = getBundledModel(provider, id)!;
		const primary = formatModelStringWithRouting(primaryModel);
		const fallback = formatModelStringWithRouting(fallbackModel);
		const requestedModels: string[] = [];
		const agent = createScriptedAgent(primaryModel, requestedModels, [
			{ throw: "overloaded_error: provider returned error 503 retry-after-ms=60000" },
			{ content: ["Availability fallback completed the old turn"] },
		]);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { [primary]: [`${fallback}:low`] },
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primary}:high`);
		const manager = SessionManager.create(tempDir.path(), tempDir.join("availability-new-session"));
		manager.appendModelChange(`${primary}:high`);
		const session = trackSession(
			new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			}),
		);

		await session.prompt("Trigger an availability fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([primary, fallback]);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.configuredThinkingLevel()).toBe(thinking);

		expect(await session.newSession()).toBe(true);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.servingModel).toMatchObject({ modelIdentity: fallback, isFallback: true });

		await session.flushToDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected /new session to persist");
		await closeSession(session);

		const resumed = await coldResume(sessionFile, settings);
		expect(resumed.model?.id).toBe(primaryModel.id);
		expect(resumed.configuredThinkingLevel()).toBe(Effort.High);
		expect(resumed.thinkingLevel).toBe(Effort.High);
	});

	it.each([false, true])(
		"resumes the primary effort beneath a higher-floor fallback (request-scoped: %s)",
		async requestScoped => {
			const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const fallbackModel = getBundledModel("openrouter", "deepseek/deepseek-v4-pro")!;
			const primary = formatModelStringWithRouting(primaryModel);
			const fallback = formatModelStringWithRouting(fallbackModel);
			const requestedModels: string[] = [];
			const responses: MockResponse[] = requestScoped
				? [
						{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
						{ content: [], stopReason: "aborted", errorMessage: "Cancelled" },
					]
				: [
						{ throw: "overloaded_error: provider returned error 503 retry-after-ms=60000" },
						{ content: ["Availability fallback answered"] },
					];
			const agent = createScriptedAgent(primaryModel, requestedModels, responses);
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.maxRetries": 1,
				"retry.fallbackChains": { [primary]: [fallback] },
				"retry.fallbackRevertPolicy": "cooldown-expiry",
				"retry.refusalFallbackRevertPolicy": "after-success",
			});
			settings.setModelRole("default", `${primary}:low`);
			const manager = SessionManager.create(tempDir.path(), tempDir.join(`higher-floor-${requestScoped}`));
			manager.appendModelChange(`${primary}:low`);
			manager.appendThinkingLevelChange(Effort.Low, Effort.Low);
			const session = trackSession(
				new AgentSession({
					agent,
					sessionManager: manager,
					settings,
					modelRegistry,
					thinkingLevel: Effort.Low,
				}),
			);

			await session.prompt("Enter the higher-floor fallback");
			await session.waitForIdle();
			expect(requestedModels).toEqual([primary, fallback]);
			expect(session.configuredThinkingLevel()).toBe(Effort.High);

			await session.newSession();
			await session.flushToDisk();
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("Expected /new session to persist");
			await closeSession(session);

			const resumed = await coldResume(sessionFile, settings);
			expect(resumed.model?.id).toBe(primaryModel.id);
			expect(resumed.configuredThinkingLevel()).toBe(Effort.Low);
			expect(resumed.thinkingLevel).toBe(Effort.Low);
		},
	);

	it("persists beneath a refusal detour and keeps the in-memory availability fallback layered", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const availabilityModel = getBundledModel("anthropic", "claude-opus-4-1")!;
		const refusalModel = getBundledModel("openai", "gpt-4o")!;
		const primary = formatModelStringWithRouting(primaryModel);
		const availability = formatModelStringWithRouting(availabilityModel);
		const refusal = formatModelStringWithRouting(refusalModel);
		const requestedModels: string[] = [];
		const agent = createScriptedAgent(primaryModel, requestedModels, [
			{ throw: "overloaded_error: provider returned error 503 retry-after-ms=60000" },
			{ content: ["Availability fallback completed the old turn"] },
			{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
			{ content: [], stopReason: "aborted", errorMessage: "Cancelled" },
			{ content: ["The refusal detour completed"] },
		]);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 2,
			"retry.fallbackChains": { [primary]: [`${availability}:low`, refusal], [refusal]: [availability] },
			"retry.fallbackRevertPolicy": "cooldown-expiry",
			"retry.refusalFallbackRevertPolicy": "after-success",
		});
		settings.setModelRole("default", `${primary}:high`);
		const manager = SessionManager.create(tempDir.path(), tempDir.join("layered-new-session"));
		manager.appendModelChange(`${primary}:high`);
		const session = trackSession(
			new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			}),
		);

		await session.prompt("Trigger the availability fallback");
		await session.waitForIdle();
		await session.prompt("Trigger a request-scoped refusal fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([primary, availability, availability, refusal]);
		expect(session.model?.id).toBe(refusalModel.id);

		expect(await session.newSession()).toBe(true);
		expect(session.model?.id).toBe(refusalModel.id);
		expect(session.servingModel).toMatchObject({ modelIdentity: refusal, isFallback: true });

		await session.flushToDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected /new session to persist");
		const newSessionSnapshot = await Bun.file(sessionFile).text();

		await session.prompt("Finish the refusal detour in memory");
		await session.waitForIdle();
		expect(requestedModels).toEqual([primary, availability, availability, refusal, refusal]);
		expect(session.model?.id).toBe(availabilityModel.id);
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		expect(session.servingModel).toMatchObject({ modelIdentity: refusal, isFallback: true });

		await closeSession(session);
		// Resume the /new boundary independently of the later in-memory detour.
		const snapshotFile = tempDir.join("layered-new-boundary.jsonl");
		await Bun.write(snapshotFile, newSessionSnapshot);
		const resumed = await coldResume(snapshotFile, settings);
		expect(resumed.model?.id).toBe(primaryModel.id);
		expect(resumed.configuredThinkingLevel()).toBe(Effort.High);
		expect(resumed.thinkingLevel).toBe(Effort.High);
	});

	it.each([false, true])("preserves manual effort beneath fallback layers (nested: %s)", async nested => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-1")!;
		const refusalModel = getBundledModel("openai", "gpt-5")!;
		const primary = formatModelStringWithRouting(primaryModel);
		const fallback = formatModelStringWithRouting(fallbackModel);
		const refusal = formatModelStringWithRouting(refusalModel);
		const requestedModels: string[] = [];
		const agent = createScriptedAgent(primaryModel, requestedModels, [
			{ throw: "overloaded_error: provider returned error 503 retry-after-ms=60000" },
			{ content: ["Availability fallback completed the old turn"] },
			...(nested
				? [
						{ stopReason: "error" as const, stopDetails: { type: "refusal" as const }, errorMessage: "Declined" },
						{ content: [], stopReason: "aborted" as const, errorMessage: "Cancelled" },
					]
				: []),
		]);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 2,
			"retry.fallbackChains": {
				[primary]: [`${fallback}:${nested ? "medium" : "low"}`, ...(nested ? [`${refusal}:low`] : [])],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
			"retry.refusalFallbackRevertPolicy": "after-success",
		});
		settings.setModelRole("default", `${primary}:high`);
		const manager = SessionManager.create(tempDir.path(), tempDir.join("manual-effort-new-session"));
		manager.appendModelChange(`${primary}:high`);
		const session = trackSession(
			new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			}),
		);

		await session.prompt("Trigger an availability fallback");
		await session.waitForIdle();
		if (nested) {
			await session.prompt("Leave an unfinished request-scoped detour");
			await session.waitForIdle();
		}
		// This override equals the older availability layer's effort, but differs
		// from the detour's last-applied effort. It must remain a manual override.
		session.setThinkingLevel(Effort.Medium);

		expect(await session.newSession()).toBe(true);

		await session.flushToDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected /new session to persist");
		await closeSession(session);

		const resumed = await coldResume(sessionFile, settings);
		expect(resumed.model?.id).toBe(primaryModel.id);
		expect(resumed.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(resumed.thinkingLevel).toBe(Effort.Medium);
	});

	it("keeps a pinned refusal fallback as the legacy selected model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-1")!;
		const primary = formatModelStringWithRouting(primaryModel);
		const fallback = formatModelStringWithRouting(fallbackModel);
		const requestedModels: string[] = [];
		const agent = createScriptedAgent(primaryModel, requestedModels, [
			{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
			{ content: [], stopReason: "aborted", errorMessage: "Cancelled" },
		]);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { [primary]: [`${fallback}:low`] },
			"retry.refusalFallbackRevertPolicy": "default",
		});
		settings.setModelRole("default", `${primary}:high`);
		const manager = SessionManager.create(tempDir.path(), tempDir.join("pinned-new-session"));
		manager.appendModelChange(`${primary}:high`);
		const session = trackSession(
			new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry,
				thinkingLevel: Effort.High,
			}),
		);

		await session.prompt("Trigger a pinned refusal fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([primary, fallback]);
		expect(session.model?.id).toBe(fallbackModel.id);

		expect(await session.newSession()).toBe(true);

		await session.flushToDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected /new session to persist");
		await closeSession(session);

		const resumed = await coldResume(sessionFile, settings);
		expect(resumed.model?.id).toBe(fallbackModel.id);
		expect(resumed.configuredThinkingLevel()).toBe(Effort.Low);
		expect(resumed.thinkingLevel).toBe(Effort.Low);
	});
});
