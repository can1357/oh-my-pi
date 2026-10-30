import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	cfgCompactionModelThresholds,
	cfgCompactionModelThresholdsEnabled,
	cfgExtendedContext,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTaskStandardContextOnly } from "@oh-my-pi/pi-coding-agent/task/settings";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const provider = "sdk-context-policy-provider";
const modelId = "tiered-model";
const selector = `${provider}/${modelId}`;
const api = "sdk-context-policy-api";
const standardWindow = 272_000;
const extendedWindow = 1_050_000;

describe("SDK session context-window policy at provider dispatch", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let requests: Array<number | null>;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-context-policy-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(provider, "test-key");
		requests = [];
		// Runtime providers author their standard window; models.yml supplies the
		// supported extended tier without depending on a bundled model's identity.
		await Bun.write(
			path.join(tempDir, "models.yml"),
			`providers:\n  ${provider}:\n    modelOverrides:\n      ${modelId}:\n        maxContextWindow: ${extendedWindow}\n`,
		);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider(provider, {
			baseUrl: "https://sdk-context-policy.invalid/v1",
			apiKey: "test-key",
			api,
			streamSimple: model => {
				requests.push(model.contextWindow);
				const stream = createAssistantMessageEventStream();
				const message = { ...createAssistantMessage("ok"), api, provider, model: modelId };
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
			models: [
				{
					id: modelId,
					name: "Tiered SDK model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: standardWindow,
					maxTokens: 8192,
				},
			],
		});
	};

	async function openSession(
		settings: Settings,
		modelRegistry: ModelRegistry,
		overrides: Partial<CreateAgentSessionOptions> = {},
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(tempDir),
			modelPattern: selector,
			disableExtensionDiscovery: true,
			// Each session reconciles the shared registry's active extension sources;
			// rebind this provider instead of withdrawing its models and streaming API.
			extensions: [providerExtension],
			bindProcessState: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...overrides,
		});
		sessions.push(session);
		return session;
	}

	async function expectStreamWindow(session: AgentSession, expectedWindow: number): Promise<void> {
		const start = requests.length;
		await session.sendUserMessage("Report the next result.");
		expect(requests.slice(start)).toEqual([expectedWindow]);
	}

	for (const extensionSource of ["global", "compaction"] as const) {
		test(`keeps worker requests standard while the shared main uses ${extensionSource} extension`, async () => {
			const settings = Settings.isolated({ "compaction.enabled": false });
			// Seed live settings through the same writable layer used below;
			// isolated runtime overrides would mask subsequent typed writes.
			cfgExtendedContext.set(settings, extensionSource === "global");
			cfgCompactionModelThresholds.set(settings, extensionSource === "compaction" ? { [selector]: 400_000 } : {});
			cfgCompactionModelThresholdsEnabled.set(settings, true);
			cfgTaskStandardContextOnly.set(settings, true);
			const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
				settings,
				cacheDbPath: path.join(tempDir, "models.db"),
			});
			// The first modelPattern resolves only after this inline provider loads.
			// Merely enabling the task preference must not cap the main session.
			const main = await openSession(settings, registry, { extensions: [providerExtension] });
			const worker = await openSession(settings, registry, {
				contextWindowPolicy: "standard-only",
				taskDepth: 1,
			});
			const inherited = await openSession(settings, registry, { contextWindowPolicy: "inherit", taskDepth: 1 });

			await expectStreamWindow(main, extendedWindow);
			await expectStreamWindow(worker, standardWindow);
			await expectStreamWindow(inherited, extendedWindow);

			// Existing session policies are snapshots, not live reads of the spawn
			// preference. Re-adoption and registry policy refresh must not uncap one.
			cfgTaskStandardContextOnly.set(settings, false);
			await registry.reapplyModelPolicies();
			const row = registry.find(provider, modelId);
			if (!row) throw new Error("Expected registered tiered model");
			await worker.setModel(row, "default", { persist: false });
			await expectStreamWindow(worker, standardWindow);
			await expectStreamWindow(main, extendedWindow);

			cfgExtendedContext.set(settings, false);
			cfgCompactionModelThresholdsEnabled.set(settings, false);
			await Promise.resolve();
			await expectStreamWindow(main, standardWindow);
			await expectStreamWindow(worker, standardWindow);

			cfgTaskStandardContextOnly.set(settings, true);
			cfgCompactionModelThresholds.set(settings, { [selector]: 400_000 });
			cfgCompactionModelThresholdsEnabled.set(settings, true);
			await Promise.resolve();
			await expectStreamWindow(main, extendedWindow);
			await expectStreamWindow(worker, standardWindow);
			await expectStreamWindow(inherited, extendedWindow);
		});
	}

	test("fits deferred, explicit, and restored models before dispatch, including direct Agent adoption", async () => {
		const settings = Settings.isolated({ extendedContext: true, "compaction.enabled": false });
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
			settings,
			cacheDbPath: path.join(tempDir, "models.db"),
		});
		const deferred = await openSession(settings, registry, {
			extensions: [providerExtension],
			contextWindowPolicy: "standard-only",
		});
		const main = await openSession(settings, registry);
		const row = registry.find(provider, modelId);
		if (!row) throw new Error("Expected registered tiered model");
		const explicit = await openSession(settings, registry, {
			model: row,
			modelPattern: undefined,
			contextWindowPolicy: "standard-only",
		});
		const restoredManager = SessionManager.inMemory(tempDir);
		restoredManager.appendModelChange(selector);
		const restored = await openSession(settings, registry, {
			sessionManager: restoredManager,
			modelPattern: undefined,
			contextWindowPolicy: "standard-only",
		});

		await expectStreamWindow(deferred, standardWindow);
		await expectStreamWindow(explicit, standardWindow);
		await expectStreamWindow(restored, standardWindow);
		restored.agent.setModel(row);
		await expectStreamWindow(restored, standardWindow);
		await expectStreamWindow(main, extendedWindow);
	});
});
