/**
 * A saved session model whose LITERAL id ends in an effort name
 * (`runtime-provider/router:low`) must not have that segment read as the
 * session's thinking choice.
 *
 * The saved selector's suffix is parsed early — before extensions load —
 * whenever config or `--model` supplies the identity. `isLiteralModelId` is
 * answered by the registry, which has no extension providers yet, so the whole
 * id is unrecognizable there and `:low` looks like a thinking suffix. That
 * misread level was then carried onto the config-selected model. The parse has
 * to run again once the providers are registered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("--reapply-config saved suffix against extension providers", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-reapply-ext-suffix-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/** An extension provider holding a model whose id itself ends in `:low`. */
	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [
				{
					id: "router:low",
					name: "Router Low",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "config-pick",
					name: "Config Pick",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	/** A resumable session whose only model entry is the suffix-shaped literal id. */
	async function writeBakedSession(): Promise<string> {
		const sessionFile = path.join(tempDir, `baked-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-suffix-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "runtime-provider/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	test("does not transfer a literal id's trailing segment as a thinking level", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Config names the identity, so the early suffix parse runs and the
		// identity walk (which would have reparsed post-extension) is skipped.
		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The config default is adopted, and `low` — which was never a thinking
			// selection, only the tail of a model id — must not ride along onto it.
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	test("reparses a saved suffix whose id only exists in a cold dynamic catalog", async () => {
		// The harder half of the same bug. A provider registered with a static
		// `models` array is visible the moment the extension loads, so the reparse
		// alone fixes it. A provider whose catalog comes from
		// `fetchDynamicModels` is NOT: registration adds no models, and a cold
		// start has no cache row for the offline hydration to load — so at reparse
		// time `router:low` is still unknown and still splits at `:low`. Only a
		// provider-scoped discovery pass makes the id visible.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		let dynamicFetches = 0;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				// No `models`: nothing is visible until the catalog is fetched.
				fetchDynamicModels: async () => {
					dynamicFetches++;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
						{
							id: "config-pick",
							name: "Config Pick",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-dynamic"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The catalog really was cold: something had to fetch it.
			expect(dynamicFetches).toBeGreaterThan(0);
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	test("discovers a cold built-in provider before reparsing its saved suffix", async () => {
		// The third shape of the same bug. A BUILT-IN manager provider — a
		// configured vLLM endpoint — has no live models, no `discovery:` entry, and
		// no runtime manager, so `hasProvider` reports false while
		// `#collectBuiltInModelManagerOptions` would happily build it a manager.
		// Gating the scoped refresh on `hasProvider` therefore skipped the fetch
		// that proves `router:low` is a literal id, and its `:low` was transferred
		// to the config-selected model as a thinking level.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `builtin-models-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					vllm: { baseUrl: "https://vllm.example.invalid/v1", api: "openai-completions", auth: "none" },
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		// The premise, measured rather than assumed: the provider is invisible to
		// the old predicate and refreshable under the new one.
		expect(modelRegistry.hasProvider("vllm")).toBe(false);
		expect(modelRegistry.canRefreshProvider("vllm")).toBe(true);
	});

	test("does not block startup on a cold catalog a persisted thinking entry outranks", async () => {
		// The reparse exists to correct `restoredSessionThinkingLevel`, and
		// `pickInitialThinkingLevel` reads that at ONE precedence step, behind
		// `!hasThinkingEntry`. A branch that already recorded its own level
		// discards the corrected value — so AWAITING a cold dynamic provider's
		// catalog for it charges startup the full discovery timeout and buys
		// nothing. The background pass still runs; startup must not wait on it.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Held open for the whole of session creation, so "startup waited" and
		// "startup did not" are distinguishable without timing.
		const catalogGate = Promise.withResolvers<void>();
		let catalogReleased = false;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				// The config model is STATIC, so resolving it needs no catalog: the
				// held-open fetch below is reached only by the saved-suffix reparse.
				models: [
					{
						id: "config-pick",
						name: "Config Pick",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
				fetchDynamicModels: async () => {
					await catalogGate.promise;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		// Same baked session, plus the `thinking_level_change` that outranks the
		// saved selector's suffix.
		const sessionFile = path.join(tempDir, `baked-entry-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-entry-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "runtime-provider/router:low",
					role: "default",
				},
				{
					type: "thinking_level_change",
					id: "thinking-entry",
					parentId: "default-model",
					timestamp,
					thinkingLevel: ThinkingLevel.High,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-skip"));

		const created = createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			const { session } = await created;
			// The catalog never came back, and startup finished anyway.
			expect(catalogReleased).toBe(false);
			expect(session.model?.id).toBe("config-pick");
			await session.dispose();
		} finally {
			catalogReleased = true;
			catalogGate.resolve();
		}
	}, 30000);

	test("does not block startup on a cold catalog configured thinking outranks", async () => {
		// The third exclusion on the same read. Under `--reapply-config` with a
		// configured thinking value, `adoptConfigThinking` skips the saved-suffix
		// branch entirely — so the corrected value is discarded here too, and the
		// await buys nothing but the discovery timeout.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Held open for the whole of session creation, so "startup waited" and
		// "startup did not" are distinguishable without timing.
		const catalogGate = Promise.withResolvers<void>();
		let catalogReleased = false;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				// The config model is STATIC, so resolving it needs no catalog: the
				// held-open fetch below is reached only by the saved-suffix reparse.
				models: [
					{
						id: "config-pick",
						name: "Config Pick",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
				fetchDynamicModels: async () => {
					await catalogGate.promise;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		// Same baked session, plus the `thinking_level_change` that outranks the
		// saved selector's suffix.
		const sessionFile = path.join(tempDir, `baked-cfg-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-cfg-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "runtime-provider/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		// No persisted entry and no `--thinking`: config's OWN thinking value is what
		// outranks the saved suffix here, through `adoptConfigThinking`.
		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		settings.set("defaultThinkingLevel", ThinkingLevel.High);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-cfg"));

		const created = createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			const { session } = await created;
			// The catalog never came back, and startup finished anyway.
			expect(catalogReleased).toBe(false);
			expect(session.model?.id).toBe("config-pick");
			await session.dispose();
		} finally {
			catalogReleased = true;
			catalogGate.resolve();
		}
	}, 30000);

	// The third cell, and the one both fixes above miss: the config/CLI model is
	// STATICALLY visible, so `model` is resolved before the reparse — while the
	// saved id lives only in the cold dynamic catalog, so only the reparse can
	// learn it is a literal. Correcting `restoredSessionThinkingLevel` alone left
	// the misread `low` in `thinkingLevel`/`effectiveThinkingLevel`, because the
	// later recomputation is gated on `!model` and never ran.
	test("recomputes the thinking level when the reparse corrects an already-resolved model", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// `config-pick` is STATIC so the config default resolves immediately and
		// `model` is set before the reparse; `router:low` lives only in the cold
		// dynamic catalog, so only the reparse can learn it is a literal id.
		const mixedExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [
					{
						id: "config-pick",
						name: "Config Pick",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
				fetchDynamicModels: async () => [
					{
						id: "router:low",
						name: "Router Low",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-mixed"));
		// An explicit `--model` pin: it fixes the identity, so the restored
		// suffix is what supplies the level — exactly where a misread bites.
		const mixedModelPin = buildModel({
			provider: "runtime-provider",
			id: "config-pick",
			name: "Config Pick",
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		} as ModelSpec);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [mixedExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
			model: mixedModelPin,
		});

		try {
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	}, 20000);

	// A non-UI session starts the deferred runtime pass at creation
	// (`hasUI: false`), so the suffix reparse below can run while a discovery
	// over the same provider is still in flight. Coalescing does NOT save it:
	// `#discoverProviderModelsCoalesced` shares only configured `discovery:`
	// providers, and an extension's `fetchDynamicModels` is a runtime manager
	// with no in-flight map — so both passes hit the remote and race each
	// other's catalog and cache writes.
	test("does not fetch the saved provider's catalog twice in a non-UI session", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		let concurrentFetches = 0;
		let peakConcurrentFetches = 0;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					concurrentFetches++;
					peakConcurrentFetches = Math.max(peakConcurrentFetches, concurrentFetches);
					// Hold the fetch open so a second, overlapping pass is visible
					// as concurrency rather than two sequential cache-warm reads.
					await Bun.sleep(25);
					concurrentFetches--;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
						{
							id: "config-pick",
							name: "Config Pick",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-nonui"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
			hasUI: false,
		});

		try {
			expect(peakConcurrentFetches).toBe(1);
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	}, 20000);
});
