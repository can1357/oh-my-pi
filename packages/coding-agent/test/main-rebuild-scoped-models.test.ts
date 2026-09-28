import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
	async refresh(): Promise<void> {
		this.refreshCalls += 1;
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
