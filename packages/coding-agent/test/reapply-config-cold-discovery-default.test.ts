/**
 * `--reapply-config` must give the configured `modelRoles.default` a
 * cold-discovery retry BEFORE any lower-priority fallback claims the model.
 *
 * A discovery-backed provider (models.yml `discovery:`, LM Studio/Ollama/
 * llama.cpp, an openai-compat proxy) ships no static models, so on a cache-cold
 * boot the configured default resolves to nothing. Two lower-priority pickers
 * sit downstream of that failure — the session's own baked model and the
 * arbitrary availability pick — and both are reached only while `model` is
 * still unset. So whichever one runs first permanently shadows the discovery
 * refresh, and the resume lands on it even though `omp models` (which awaits
 * discovery) lists the configured default.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const DISCOVERED_MODEL = "phi3";

describe("--reapply-config cold-discovery configured default", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let observed: { fallbackSawJoin: boolean | undefined } | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-reapply-cold-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		// No ambient-ollama guard is needed: the env endpoint only feeds the
		// IMPLICIT ollama provider, and `models.yml` here configures ollama
		// explicitly, so `#addImplicitDiscoverableProviders` never adds one.
		tempDir = TempDir.createSync("@omp-reapply-cold-");
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

	const mockOllamaDiscovery: FetchImpl = async input => {
		const url = String(input);
		if (url === `${OLLAMA_ENDPOINT}/api/tags`) {
			return Response.json({ models: [{ name: DISCOVERED_MODEL }] });
		}
		if (url === `${OLLAMA_ENDPOINT}/api/show`) {
			return Response.json({ capabilities: ["completion"] });
		}
		throw new Error(`Unexpected URL: ${url}`);
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
		await Bun.write(overlayPath, `modelRoles:\n  default: "${defaultRole}"\n`);
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	/**
	 * Resume against a registry whose ollama catalog is reachable ONLY through a
	 * discovery fetch: models.yml declares the provider with no static models and
	 * the cache starts cold, so nothing resolves until a refresh runs.
	 */
	async function resume(sessionFile: string, settings: Settings): Promise<AgentSession> {
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl: `${OLLAMA_ENDPOINT}/v1`,
						api: "openai-completions",
						auth: "none",
						discovery: { type: "ollama" },
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, { fetch: mockOllamaDiscovery });
		observed = observeRefreshOrder(modelRegistry);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			reapplyConfig: true,
		});
		session = result.session;
		return result.session;
	}

	/**
	 * Records whether the startup background refresh had been JOINED by the time
	 * the cold-cache fallback started its own `refresh`. Both fetch the same
	 * built-in dynamic catalogs, so a fallback that runs while the background
	 * pass is still in flight duplicates the remote call and races its cache
	 * write. Instance spies only — never the prototype — so the suite stays
	 * parallel-safe.
	 */
	function observeRefreshOrder(registry: ModelRegistry): { fallbackSawJoin: boolean | undefined } {
		const state: { fallbackSawJoin: boolean | undefined } = { fallbackSawJoin: undefined };
		let joined = false;
		const realAwait = registry.awaitBackgroundRefresh.bind(registry);
		const realRefresh = registry.refresh.bind(registry);
		spyOn(registry, "awaitBackgroundRefresh").mockImplementation(async () => {
			await realAwait();
			joined = true;
		});
		spyOn(registry, "refresh").mockImplementation(async strategy => {
			state.fallbackSawJoin ??= joined;
			return await realRefresh(strategy);
		});
		return state;
	}

	it("discovers the configured default instead of falling back to the session's baked model", async () => {
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// The only configured candidate needs discovery; the session's own model
		// is bundled and immediately restorable, so it wins any race it is
		// allowed to enter.
		const settings = await loadOverlay(`ollama/${DISCOVERED_MODEL}`);

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.provider).toBe("ollama");
		expect(resumed.model?.id).toBe(DISCOVERED_MODEL);
		// The cold-cache fallback must join the startup background refresh before
		// launching its own, or both fetch the same catalog at once.
		expect(observed?.fallbackSawJoin).toBe(true);
	});

	it("discovers the first configured candidate instead of keeping the later one it matched early", async () => {
		const bakedModel = anthropicModel("claude-opus-4-1");
		const laterCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// Ordered list whose first candidate needs discovery and whose second is
		// already available: the early pass adopts index 1, which leaves `model`
		// non-null and would otherwise skip the retry entirely.
		const settings = await loadOverlay(`ollama/${DISCOVERED_MODEL},${modelValue(laterCandidate)}`);

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.provider).toBe("ollama");
		expect(resumed.model?.id).toBe(DISCOVERED_MODEL);
	});
});
