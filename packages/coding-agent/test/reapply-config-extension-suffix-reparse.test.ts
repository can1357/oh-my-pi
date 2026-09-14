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

	test("does not await discovery for a static-only provider that cannot discover anything", async () => {
		// `custom/base:low` legitimately means model `base` at low effort. `custom`
		// is declared in models.yml with static rows and NO `discovery:` entry, so
		// a scoped refresh cannot produce an id the registry lacks — but
		// `hasProvider` said yes purely because `base` is registered, and the
		// saved-suffix path then awaited every in-flight discovery pass before a
		// refresh that was a guaranteed no-op.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `static-models-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "base", name: "Base" }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		// The premise, measured: the provider IS known — its static row is right
		// there — yet nothing about it is discoverable.
		expect(modelRegistry.hasProvider("custom")).toBe(true);
		expect(modelRegistry.canRefreshProvider("custom")).toBe(false);
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
	test("discovers a cold provider whose casing differs from the saved selector's", async () => {
		// `modelRegistry.find` resolves a reference case-insensitively, but
		// `canRefreshProvider` and `refreshDiscoverableProviders` are exact
		// map/set lookups. A saved selector spelled with different provider casing
		// therefore skipped the discovery that proves `router:low` is a literal id,
		// and `:low` was transferred to the config-selected model as a thinking
		// level.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		let dynamicFetches = 0;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
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
		const sessionFile = path.join(tempDir, `cased-provider-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "cased-provider-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					// The provider is registered lowercase; the saved string is not.
					model: "Runtime-Provider/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-cased-provider"));

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
			// The premise, measured: the cold catalog really was fetched.
			expect(dynamicFetches).toBeGreaterThan(0);
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	// The counterpart the lowercase test above cannot catch: a provider whose
	// REGISTERED identity is itself mixed-case (`MyGateway`). Forcing the parsed
	// provider to lowercase — the fix the lowercase case needed — makes the exact
	// `canRefreshProvider`/`refreshDiscoverableProviders` lookups MISS a manager
	// keyed `MyGateway`, so the cold catalog is never fetched, the config default
	// never resolves, and the saved `:low` stays misparsed and rides onto the
	// adopted model. Resolving the parsed provider to the registry's own stored
	// key instead is right for both.
	test("discovers a cold provider registered with mixed-case identity", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		let dynamicFetches = 0;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			// Registered with a mixed-case key the registry preserves verbatim.
			pi.registerProvider("MyGateway", {
				baseUrl: "https://gateway.example.com/v1",
				apiKey: "GATEWAY_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					dynamicFetches++;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: true,
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
		settings.setModelRole("default", "MyGateway/config-pick");
		const sessionFile = path.join(tempDir, `mixed-case-provider-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "mixed-case-provider-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					// The saved string carries the provider's true mixed-case spelling;
					// lowercasing it would miss the manager keyed `MyGateway`.
					model: "MyGateway/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-mixed-case-provider"));

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
			// The premise, measured: lowercasing the provider would have skipped the
			// scoped refresh entirely, so a fetched catalog proves the resolved key hit.
			expect(dynamicFetches).toBeGreaterThan(0);
			expect(session.model?.provider).toBe("MyGateway");
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	test("matches a pinned model whose saved selector differs only in provider casing", async () => {
		// The caller's own `options.model` counts as literal, so an id the registry
		// has never seen is still recognized whole. But that comparison was
		// case-SENSITIVE while every other model reference resolves case-
		// insensitively (`resolveProviderModelReference` lowercases both halves),
		// so a saved `Runtime-Provider/router:low` missed its own pinned model and
		// the parser split the literal id's `:low` tail off as persisted thinking.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const settings = Settings.isolated();
		const sessionFile = path.join(tempDir, `cased-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "cased-suffix-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					// Same model, spelled with a different provider casing.
					model: "Runtime-Provider/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-cased"));

		// Pinned by the caller and absent from the registry, so only the identity
		// comparison can prove `router:low` is a literal id.
		const pinnedModel = buildModel({
			provider: "runtime-provider",
			id: "router:low",
			name: "Router Low",
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
			extensions: [],
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
			model: pinnedModel,
		});

		try {
			expect(session.model?.id).toBe("router:low");
			// `low` is the tail of the id, never a thinking selection.
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

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

	test("reparses a cold saved suffix when the final retry makes it readable again", async () => {
		// The early guard marks the saved suffix unreadable whenever the default
		// role that won AT THAT MOMENT names the thinking knob (`…:xhigh`), and so
		// skips the cold-catalog reparse. But the winner can still change: the
		// discovery retry below can hand the role to an earlier candidate that
		// names no thinking knob, and `pickInitialThinkingLevel` then starts
		// consulting `restoredSessionThinkingLevel` again. Without redoing the
		// reparse the stale early split applies `low` -- the tail of a literal
		// model id -- to the new default.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `late-models-${Bun.nanoseconds()}.yml`);
		const vllmProvider = (models: { id: string; name: string; reasoning?: boolean }[]) => ({
			vllm: { baseUrl: "https://vllm.example.invalid/v1", api: "openai-completions", auth: "none", models },
		});
		// `late-pick` is NOT here yet, so the suffixed fallback wins the first pass.
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					...vllmProvider([]),
					fallbackvend: {
						baseUrl: "https://fallback.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "fallback", name: "Fallback" }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		// The premise, measured: the first candidate's provider is refreshable, so
		// the discovery retry runs on its behalf at all.
		expect(modelRegistry.canRefreshProvider("vllm")).toBe(true);

		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				// Cold: the saved `router:low` is invisible, so the early parse splits
				// it at `:low`. Discovery also publishes the first candidate, which is
				// what changes the winner.
				fetchDynamicModels: async () => {
					await Bun.sleep(15);
					await Bun.write(
						modelsPath,
						JSON.stringify({
							providers: {
								...vllmProvider([{ id: "late-pick", name: "Late Pick", reasoning: true }]),
								fallbackvend: {
									baseUrl: "https://fallback.example.invalid/v1",
									api: "openai-completions",
									auth: "none",
									models: [{ id: "fallback", name: "Fallback" }],
								},
							},
						}),
					);
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

		const settings = Settings.isolated();
		settings.setModelRole("default", "vllm/late-pick,fallbackvend/fallback:xhigh");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-retry"));

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
			// The premise, measured: the retry really did change the winner to the
			// candidate that names no thinking knob.
			expect(session.model?.id).toBe("late-pick");
			// So the saved suffix is readable again -- and the level must not be the
			// stale `low` split off a literal model id.
			expect(session.thinkingLevel).not.toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	});

	test("drops a provisional default the post-discovery catalog no longer lists", async () => {
		// `tryResolveDefaultRole()` runs twice with a discovery pass between them,
		// and that pass calls `modelRegistry.refresh()`, which RELOADS models.yml.
		// So the model the first call adopted can be gone by the second. Returning
		// early on the empty re-resolution left it selected, and every restore and
		// availability fallback below is gated on `!model` -- so the resume kept a
		// model the refreshed catalog had explicitly removed, silently.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `withdrawn-models-${Bun.nanoseconds()}.yml`);
		const providerEntry = (models: { id: string; name: string }[]) => ({
			providers: {
				vend: { baseUrl: "https://vend.example.invalid/v1", api: "openai-completions", auth: "none", models },
			},
		});
		await Bun.write(modelsPath, JSON.stringify(providerEntry([{ id: "going-away", name: "Going Away" }])));
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		// The premise, measured: the first resolution really can see it.
		expect(modelRegistry.find("vend", "going-away")).toBeDefined();

		// An earlier candidate that never resolves but IS discoverable, so the role
		// matches at index 1 and the post-discovery retry runs at all. Rewriting
		// models.yml from inside the fetch puts the withdrawal exactly between the
		// two `tryResolveDefaultRole()` calls, which is the race being fixed.
		const withdrawingExtension: ExtensionFactory = pi => {
			pi.registerProvider("ahead-provider", {
				baseUrl: "https://ahead.example.com/v1",
				apiKey: "AHEAD_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					await Bun.sleep(15);
					await Bun.write(modelsPath, JSON.stringify(providerEntry([{ id: "still-here", name: "Still Here" }])));
					return [];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "ahead-provider/never-there,vend/going-away");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-withdrawn"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [withdrawingExtension],
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
			// The premise, measured: the refresh really did withdraw it.
			expect(modelRegistry.find("vend", "going-away")).toBeUndefined();
			// RED (pre-fix): the withdrawn model is still the session's model.
			expect(session.model?.id).not.toBe("going-away");
		} finally {
			await session.dispose();
		}
	});

	test("reparses a saved suffix when a late default flips adoption false->true", async () => {
		// The adoption classification is itself PROVISIONAL. `adoptConfigModel()`
		// is read before extensions register, so an all-self-alias default
		// (`default,@default`) that only resolves once an extension supplies its
		// model classifies as "no config default" -- adoption starts false. The
		// early bare-resume restore then reads the saved `custom/router:low` as the
		// already-known static `custom/router` at low effort, seeding an INVENTED
		// `low` into `restoredSessionThinkingLevel`. When the extension registers a
		// model with id `default`, `default,@default` resolves and
		// `tryResolveDefaultRole()` adopts it -- and `pickInitialThinkingLevel`
		// transfers the stale `low` onto the late config model, because the only
		// saved-suffix reparse was gated on the early `adoptConfigModel()` and so
		// never ran. Widening that gate to `reResolveConfigDefault()` re-settles
		// the suffix through the same machinery once the winner is real.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// `custom/router` is a STATIC provider, so it is known at the early restore
		// -- that is what seeds the `:low` misread before any extension loads.
		const modelsPath = path.join(tempDir, `flip-models-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "router", name: "Router" }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		// The premise, measured: the bare id is visible early, the suffix-shaped
		// literal and the `default` model are NOT -- they arrive with the extension.
		expect(modelRegistry.find("custom", "router")).toBeDefined();
		expect(modelRegistry.find("custom", "router:low")).toBeUndefined();
		expect(modelRegistry.find("custom", "default")).toBeUndefined();

		// The extension augments the SAME provider: the literal `router:low` id (so
		// the reparse recognizes it whole and drops the invented suffix) and a
		// reasoning `default` model (so `default,@default` resolves late and a
		// level is observable at all on the model it selects).
		const augmentCustom: ExtensionFactory = pi => {
			pi.registerProvider("custom", {
				baseUrl: "https://custom.example.invalid/v1",
				apiKey: "CUSTOM_KEY",
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
						id: "default",
						name: "Late Default",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "default,@default");

		const sessionFile = path.join(tempDir, `flip-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "flip-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "custom/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-flip"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [augmentCustom],
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
			// The premise, measured: the extension really did register the literal
			// suffix-shaped id and the `default` model the config resolves to.
			expect(modelRegistry.find("custom", "router:low")).toBeDefined();
			expect(modelRegistry.find("custom", "default")).toBeDefined();
			// The adoption really did flip: the late `default` model won the config
			// default, not the baked `custom/router`.
			expect(session.model?.provider).toBe("custom");
			expect(session.model?.id).toBe("default");
			// RED (pre-fix): the invented `low` -- the tail of a literal model id --
			// rode onto the late config-selected model because the reparse was
			// skipped while adoption read false.
			expect(session.thinkingLevel).not.toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	}, 20000);

	test("does not claim the config default failed when a late default won the adoption", async () => {
		// Sibling of the flip test above, on the user-visible NOTICE. The early
		// bare-resume restore (adoption reads false against `default,@default`
		// before the extension loads) restores the baked `custom/router` and sets
		// `restoredSessionModelIndex = 0`. When the extension registers a literal
		// `default`, the config default resolves and REPLACES the model -- the
		// session DID switch. But the stale index-0 marker made the notice take
		// the "restored a saved model" branch and report
		// `config default "default,@default" did not resolve; kept the session's
		// custom/router`, contradicting the model the session actually runs. The
		// marker must be re-settled when the config model wins.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `notice-models-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "router", name: "Router" }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		// The premise, measured: the bare `custom/router` is visible early (so the
		// early restore adopts it and seeds index 0), while the `default` model the
		// config resolves to is NOT -- it arrives with the extension.
		expect(modelRegistry.find("custom", "router")).toBeDefined();
		expect(modelRegistry.find("custom", "default")).toBeUndefined();

		const augmentCustom: ExtensionFactory = pi => {
			pi.registerProvider("custom", {
				baseUrl: "https://custom.example.invalid/v1",
				apiKey: "CUSTOM_KEY",
				api: "openai-completions",
				models: [
					{
						id: "default",
						name: "Late Default",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "default,@default");

		const sessionFile = path.join(tempDir, `notice-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "notice-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "custom/router",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-notice"));

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [augmentCustom],
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
			// The premise, measured: the adoption really did flip to the late config
			// `default`, not the baked `custom/router`.
			expect(session.model?.provider).toBe("custom");
			expect(session.model?.id).toBe("default");
			// RED (pre-fix): the stale index-0 marker made the notice claim the
			// config default failed and the session kept its baked model.
			expect(modelFallbackMessage ?? "").not.toContain("did not resolve");
			expect(modelFallbackMessage ?? "").not.toContain("kept the session");
			// GREEN: the notice reports the config model the session actually adopted.
			expect(modelFallbackMessage).toContain("resumed on custom/default from config");
		} finally {
			await session.dispose();
		}
	}, 20000);
});
