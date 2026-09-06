/**
 * `--reapply-config` must give a configured `modelRoles.default` supplied by an
 * EXTENSION its cold-cache discovery retry, not just one supplied by a
 * config-declared discovery provider.
 *
 * An extension that registers a provider with `fetchDynamicModels` installs a
 * RUNTIME model manager. `modelRegistry.refresh()` discovers those, but
 * `getDiscoverableProviders()` reports only the config-declared half of the
 * discovery surface. So with every implicit/config discovery provider disabled
 * or absent, a guard written against that list sees an empty array and returns
 * before the refresh can run — even though a runtime manager is registered and
 * holds the configured default. The resume then falls through to the baked
 * session model, which is exactly what the flag was asked to override.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const RUNTIME_PROVIDER = "reapply-runtime-gw";
const RUNTIME_MODEL = "reapply-runtime-model";

/** The implicit discovery providers the registry always adds; disabled so the
 * config-declared discoverable list is genuinely empty. */
const IMPLICIT_DISCOVERY_PROVIDERS = ["ollama", "llama.cpp", "lm-studio"];

describe("--reapply-config runtime-provider cold discovery", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-reapply-runtime-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-reapply-runtime-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function anthropicModel(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	/**
	 * Config-declared discoverable providers for these settings, read from a
	 * throwaway registry so the assertion never perturbs the one under test.
	 */
	function countConfigDiscoverableProviders(settings: Settings): number {
		const probe = new ModelRegistry(authStorage, path.join(tempDir.path(), "probe-models.yml"), { settings });
		return probe.getDiscoverableProviders().length;
	}

	let dynamicFetches = 0;

	/**
	 * A dynamic-ONLY provider: it declares no static `models`, so nothing exists
	 * until a discovery pass calls `fetchDynamicModels`. Registered through the
	 * runtime's pending-registration queue, the same path a real extension uses.
	 */
	const registerRuntimeProvider: ExtensionFactory = pi => {
		pi.registerProvider(RUNTIME_PROVIDER, {
			baseUrl: "https://reapply-runtime.example.invalid/v1",
			apiKey: "literal-test-key",
			api: "openai-completions",
			fetchDynamicModels: async () => {
				dynamicFetches += 1;
				return [
					{
						id: RUNTIME_MODEL,
						name: "Reapply Runtime Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8192,
					},
				];
			},
		});
	};

	async function writeBakedSession(bakedModelValue: string): Promise<string> {
		const sessionFile = path.join(tempDir.path(), `baked-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: bakedModelValue,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	async function loadOverlay(defaultRole: string): Promise<Settings> {
		const overlayPath = path.join(tempDir.path(), `overlay-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			overlayPath,
			`modelRoles:\n  default: "${defaultRole}"\ndisabledProviders:\n${IMPLICIT_DISCOVERY_PROVIDERS.map(
				provider => `  - "${provider}"\n`,
			).join("")}`,
		);
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	async function resume(sessionFile: string, settings: Settings): Promise<AgentSession> {
		// A registry private to this resume, with a cache DB under the per-test
		// temp dir so the runtime catalog genuinely starts cold. `settings` is
		// passed so the disabled implicit providers actually take effect.
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			extensions: [registerRuntimeProvider],
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			// `hasUI` keeps online runtime discovery deferred to the post-paint
			// starter, so nothing populates the runtime catalog before the guard
			// under test runs. Without this the background pass would mask the bug.
			hasUI: true,
			reapplyConfig: true,
		});
		session = result.session;
		return result.session;
	}

	it("discovers an extension-supplied configured default with no config discovery providers", async () => {
		dynamicFetches = 0;
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${RUNTIME_PROVIDER}/${RUNTIME_MODEL}`);
		// The premise of the finding: nothing config-declared is left to discover,
		// so a guard keyed off this list short-circuits.
		expect(countConfigDiscoverableProviders(settings)).toBe(0);

		const resumed = await resume(sessionFile, settings);

		expect(dynamicFetches).toBeGreaterThan(0);
		expect(resumed.model?.provider).toBe(RUNTIME_PROVIDER);
		expect(resumed.model?.id).toBe(RUNTIME_MODEL);
	});

	it("keeps the baked session model when the configured default is unresolvable", async () => {
		// Guards the widened refresh against over-adopting: a refresh that
		// discovers nothing matching must still leave the resume on its own model
		// rather than an arbitrary pick.
		dynamicFetches = 0;
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${RUNTIME_PROVIDER}/no-such-runtime-model`);

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.id).toBe(bakedModel.id);
	});
});
