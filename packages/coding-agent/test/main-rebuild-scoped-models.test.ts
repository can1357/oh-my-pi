import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelScope } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildSessionOptions,
	rebuildScopedModelsAfterDiscovery,
	refreshCredentialScopedModelIfMissing,
	resolveCredentialScopedRefreshTarget,
	resolveScopedModels,
	type ScopedModelSink,
	toSessionScopedModels,
} from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function model(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "prov",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

/** Mutable stand-in for {@link ModelRegistry}: `available` grows to mimic provider discovery. */
class FakeRegistry {
	available: Model<Api>[];
	discoverableProviders = ["prov"];
	refreshCalls = 0;
	refreshProviderCalls: Array<{ providerId: string; strategy?: string }> = [];
	onRefresh: (() => void) | undefined;
	constructor(initial: Model<Api>[], onRefresh?: () => void) {
		this.available = initial;
		this.onRefresh = onRefresh;
	}
	getAvailable(): Model<Api>[] {
		return this.available;
	}
	getDiscoverableProviders(): string[] {
		return this.discoverableProviders;
	}
	hasProvider(providerId: string): boolean {
		return this.discoverableProviders.includes(providerId) || this.available.some(m => m.provider === providerId);
	}
	async refresh(): Promise<void> {
		this.refreshCalls += 1;
		this.onRefresh?.();
	}
	async refreshProvider(providerId: string, strategy?: string): Promise<void> {
		this.refreshProviderCalls.push({ providerId, strategy });
		this.onRefresh?.();
	}
	async awaitBackgroundRefresh(): Promise<void> {
		this.onRefresh?.();
	}
}

class FakeSession implements ScopedModelSink {
	isDisposed = false;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	setCalls = 0;
	constructor(initial: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>) {
		this.scopedModels = initial;
	}
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
		this.setCalls += 1;
		this.scopedModels = scopedModels;
	}
}

async function startupScope(
	patterns: string[],
	registry: FakeRegistry,
	settings: Settings,
): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
	return toSessionScopedModels(await resolveModelScope(patterns, registry, undefined, settings), settings);
}

describe("rebuildScopedModelsAfterDiscovery", () => {
	it("adds an enabledModels model that only materializes after background discovery", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		// Startup resolves the scope before discovery: `prov/b` is not yet available.
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a"]);

		// Background discovery completes and populates the registry.
		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(1);
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a", "b"]);
	});

	it("leaves the scope untouched when discovery adds nothing matching", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a"), model("b")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		const before = session.scopedModels;

		// A later discovery pass adds an unrelated, out-of-scope model.
		registry.available = [model("a"), model("b"), model("c")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(0);
		expect(session.scopedModels).toBe(before);
	});

	it("activates a scope that resolved empty once background discovery finds its model", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		// `prov/b` matches nothing at startup, so the session initially looks unscoped.
		const session = new FakeSession(await startupScope(["prov/b"], registry, settings));
		expect(session.scopedModels).toHaveLength(0);

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(1);
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["b"]);
	});

	it("re-resolves an explicit --models scope against the discovery-backed catalog", async () => {
		const settings = Settings.isolated();
		const registry = new FakeRegistry([model("a")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a"]);

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs(["--models", "prov/a,prov/b"]), registry, settings);

		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a", "b"]);
	});

	it("skips the rebuild once the session is disposed", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		session.isDisposed = true;

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(0);
		expect(session.scopedModels.map(s => s.model.id)).toEqual(["a"]);
	});
});

describe("resolveScopedModels", () => {
	it("refreshes a collapsed all-discovery --models scope before session model selection", async () => {
		const settings = Settings.isolated();
		const registry = new FakeRegistry([], () => {
			registry.available = [model("b")];
		});

		const scoped = await resolveScopedModels(parseArgs(["--models", "prov/b"]), registry, settings);

		expect(registry.refreshCalls).toBe(1);
		expect(scoped.map(entry => entry.model.id)).toEqual(["b"]);
	});

	it("refreshes built-in descriptor providers for an empty --models scope when getDiscoverableProviders is empty", async () => {
		const settings = Settings.isolated();
		const sandDefault = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		const registry = new FakeRegistry([sandDefault], () => {
			registry.available = [
				sandDefault,
				buildModel({
					id: "live-only",
					name: "live-only",
					api: "grokbot-sand",
					provider: "grokbot",
					baseUrl: "https://api2.cursor.sh",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				}),
			];
		});
		registry.discoverableProviders = [];

		const scoped = await resolveScopedModels(parseArgs(["--models", "grokbot/live-only"]), registry, settings);

		expect(registry.refreshCalls).toBe(0);
		expect(registry.refreshProviderCalls).toEqual([{ providerId: "grokbot", strategy: "online-if-uncached" }]);
		expect(scoped.map(entry => entry.model.id)).toEqual(["live-only"]);
	});
});

describe("refreshCredentialScopedModelIfMissing", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = await TempDir.create("@main-refresh-cold-catalog-");
		authStorage = createInMemoryAuthStorage();
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolveCredentialScopedRefreshTarget falls back to provider-qualified modelRoles.default", () => {
		// No CLI model flags: still warm a live-only Grok Bot default before session build.
		expect(resolveCredentialScopedRefreshTarget({}, "grokbot/live-only")).toEqual({
			providerId: "grokbot",
			selectors: { model: "grokbot/live-only" },
		});
		expect(resolveCredentialScopedRefreshTarget({}, "GrokBot/sand-default")).toEqual({
			providerId: "grokbot",
			selectors: { model: "GrokBot/sand-default" },
		});
		// Bare defaults and missing roles stay unbound (ownership indeterminate).
		expect(resolveCredentialScopedRefreshTarget({}, "sand-default")).toBeUndefined();
		expect(resolveCredentialScopedRefreshTarget({})).toBeUndefined();
		// CLI selection still wins over the configured default.
		expect(resolveCredentialScopedRefreshTarget({ model: "openai/gpt-4o" }, "grokbot/live-only")).toEqual({
			providerId: "openai",
			selectors: { model: "openai/gpt-4o", models: undefined },
		});
	});

	it("refreshes a cold credential-scoped provider when --model is absent from startup catalog", async () => {
		const registry = new FakeRegistry([], () => {
			registry.available = [
				buildModel({
					id: "live-only",
					name: "live-only",
					api: "grokbot-sand",
					provider: "grokbot",
					baseUrl: "https://api2.cursor.sh",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				}),
			];
		});
		registry.discoverableProviders = ["grokbot"];

		const refreshed = await refreshCredentialScopedModelIfMissing({ model: "live-only" }, registry, "grokbot");

		expect(refreshed).toBe(true);
		expect(registry.refreshProviderCalls).toEqual([{ providerId: "grokbot", strategy: "online-if-uncached" }]);
		expect(registry.available.map(m => m.id)).toEqual(["live-only"]);
	});

	it("refreshes without --api-key when env/secrets/models.yml credentials back the provider", async () => {
		// Documented grokbot auth paths leave cliApiKeyProvider undefined; cold
		// `--provider grokbot --model <live-only-id>` still needs a pre-resolve refresh.
		const registry = new FakeRegistry([], () => {
			registry.available = [
				buildModel({
					id: "live-only",
					name: "live-only",
					api: "grokbot-sand",
					provider: "grokbot",
					baseUrl: "https://api2.cursor.sh",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				}),
			];
		});
		registry.discoverableProviders = ["grokbot"];

		const refreshed = await refreshCredentialScopedModelIfMissing(
			{ model: "grokbot/live-only" },
			registry,
			"grokbot",
		);

		expect(refreshed).toBe(true);
		expect(registry.refreshProviderCalls).toEqual([{ providerId: "grokbot", strategy: "online-if-uncached" }]);
	});

	it("refreshes a single-provider --models scope when parsed.model is absent", async () => {
		const registry = new FakeRegistry([], () => {
			registry.available = [
				buildModel({
					id: "live-only",
					name: "live-only",
					api: "grokbot-sand",
					provider: "grokbot",
					baseUrl: "https://api2.cursor.sh",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				}),
			];
		});
		registry.discoverableProviders = ["grokbot"];

		const refreshed = await refreshCredentialScopedModelIfMissing(
			{ models: ["grokbot/live-only"] },
			registry,
			"grokbot",
		);

		expect(refreshed).toBe(true);
		expect(registry.refreshProviderCalls).toEqual([{ providerId: "grokbot", strategy: "online-if-uncached" }]);
	});

	it("skips multi-provider --models scopes (ownership indeterminate)", async () => {
		const registry = new FakeRegistry([]);
		registry.discoverableProviders = ["grokbot"];

		const refreshed = await refreshCredentialScopedModelIfMissing(
			{ models: ["grokbot/live-only", "openai/gpt-5"] },
			registry,
			"grokbot",
		);

		expect(refreshed).toBe(false);
		expect(registry.refreshProviderCalls).toEqual([]);
	});

	it("skips refresh when the provider is neither models.yml-discoverable nor a built-in manager", async () => {
		const registry = new FakeRegistry([model("custom-only")]);
		registry.discoverableProviders = [];
		registry.available = [
			buildModel({
				id: "custom-only",
				name: "custom-only",
				api: "openai-completions",
				provider: "custom-local",
				baseUrl: "https://example.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			}),
		];

		const refreshed = await refreshCredentialScopedModelIfMissing(
			{ model: "missing-live" },
			registry,
			"custom-local",
		);

		expect(refreshed).toBe(false);
		expect(registry.refreshProviderCalls).toEqual([]);
	});

	it("refreshes built-in descriptor providers via a real ModelRegistry even when getDiscoverableProviders omits them", async () => {
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		expect(registry.hasProvider("grokbot")).toBe(true);
		expect(registry.getDiscoverableProviders()).not.toContain("grokbot");
		const liveOnly = "live-only-fresh-xyz";
		expect(registry.getAvailable().some(m => m.provider === "grokbot" && m.id === liveOnly)).toBe(false);

		const spy = vi.spyOn(registry, "refreshProvider").mockResolvedValue();
		const refreshed = await refreshCredentialScopedModelIfMissing({ model: liveOnly }, registry, "grokbot");

		expect(refreshed).toBe(true);
		expect(spy).toHaveBeenCalledWith("grokbot", "online-if-uncached");
	});

	it("skips refresh when the explicit model is already in the startup catalog", async () => {
		const registry = new FakeRegistry([
			buildModel({
				id: "sand-default",
				name: "sand-default",
				api: "grokbot-sand",
				provider: "grokbot",
				baseUrl: "https://api2.cursor.sh",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			}),
		]);
		registry.discoverableProviders = ["grokbot"];

		const refreshed = await refreshCredentialScopedModelIfMissing({ model: "sand-default" }, registry, "grokbot");

		expect(refreshed).toBe(false);
		expect(registry.refreshProviderCalls).toEqual([]);
	});
});

describe("buildSessionOptions --models scope selection", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = await TempDir.create("@main-rebuild-scoped-models-");
		authStorage = createInMemoryAuthStorage();
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function registry(): ModelRegistry {
		return new ModelRegistry(authStorage, tempDir.join("models.yml"));
	}

	it("defers a --models scope that resolved empty to the SDK modelPattern path", async () => {
		const parsed = parseArgs(["--models", "extprov/model-x,extprov/model-y"]);

		// Empty `scopedModels` mimics an all-extension scope: the provider is not
		// registered until createAgentSession, so nothing matched at startup.
		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), registry(), Settings.isolated());

		expect(options.model).toBeUndefined();
		expect(options.modelPattern).toEqual(["extprov/model-x", "extprov/model-y"]);
		expect(options.scopedModels).toBeUndefined();
	});

	it("pins the first scoped model and sets no deferred pattern when the scope resolved", async () => {
		const parsed = parseArgs(["--models", "prov/a"]);
		const scoped = await resolveModelScope(["prov/a"], { getAvailable: () => [model("a")] }, undefined);

		const options = await buildSessionOptions(
			parsed,
			scoped,
			SessionManager.inMemory(),
			registry(),
			Settings.isolated(),
		);

		expect(options.modelPattern).toBeUndefined();
		expect(options.model?.id).toBe("a");
		expect(options.rebindModelAfterDiscovery).toBe(true);
		expect(options.scopedModels?.map(entry => entry.model.id)).toEqual(["a"]);
	});
});
