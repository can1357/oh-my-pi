import { afterAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession.refreshModels ordering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	afterAll(async () => {
		await session?.dispose();
		authStorage.close();
		await tempDir.remove();
	});

	it("forces the static rebuild before the online discovery pass", async () => {
		tempDir = TempDir.createSync("@pi-refresh-models-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		await Bun.write(tempDir.join("models.yml"), YAML.stringify({ models: [] }));

		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({});
		const primaryMock = createMockModel({ provider: "anthropic" });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const order: string[] = [];
		vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockImplementation(async () => {
			order.push("awaitBackgroundRefresh");
		});
		vi.spyOn(modelRegistry, "reapplyModelPolicies").mockImplementation(async () => {
			order.push("reapply");
		});
		vi.spyOn(modelRegistry, "refresh").mockImplementation(async () => {
			order.push("refresh");
		});

		await session.refreshModels("offline");

		// awaitBackgroundRefresh serializes against startup's in-flight discovery;
		// reapplyModelPolicies forces the mtime-gated static rebuild; refresh then
		// discovers against the fresh provider set. Any other order would reuse the
		// stale provider set or let an out-of-order refresh re-add a disabled provider.
		expect(order).toEqual(["awaitBackgroundRefresh", "reapply", "refresh"]);
	});
});
describe("AgentSession.refreshScopedModels active-model rebind", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	afterAll(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
	});

	async function writeModelsYml(baseUrl: string, extraModelIds: string[] = []): Promise<void> {
		await Bun.write(
			tempDir.join("models.yml"),
			YAML.stringify({
				providers: {
					testprov: {
						baseUrl,
						apiKey: "TEST_KEY",
						api: "anthropic-messages",
						models: [
							{
								id: "m1",
								name: "Test Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 100_000,
								maxTokens: 8_000,
							},
							...extraModelIds.map(id => ({
								id,
								name: id,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 100_000,
								maxTokens: 8_000,
							})),
						],
					},
				},
			}),
		);
	}

	async function createSession(
		cliModelScope?: readonly string[],
		settings: Settings = Settings.isolated({}),
		scopedModels?: Array<{ model: Model }>,
		sdkScopedModels?: boolean,
	): Promise<AgentSession> {
		tempDir = TempDir.createSync("@pi-scoped-rebind-");
		authStorage = createInMemoryAuthStorage();
		await writeModelsYml("https://old-gateway.example.com/v1");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const initialModel = modelRegistry.find("testprov", "m1");
		if (!initialModel) throw new Error("fixture model missing from registry");
		const mock = createMockModel({ provider: "testprov" });
		const agent = new Agent({
			getApiKey: () => "TEST_KEY",
			initialState: { model: initialModel, systemPrompt: [], tools: [] },
			streamFn: mock.stream,
		});
		authStorage.setRuntimeApiKey("testprov", "TEST_KEY");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			...(cliModelScope ? { cliModelScope } : {}),
			...(scopedModels ? { scopedModels } : {}),
			...(sdkScopedModels ? { sdkScopedModels: true } : {}),
		});
		return session;
	}

	it("re-adopts the rebuilt registry record when enabledModels is unset", async () => {
		const current = await createSession();
		expect(current.model?.baseUrl).toBe("https://old-gateway.example.com/v1");

		await writeModelsYml("https://new-gateway.example.com/v1");
		await current.refreshModels("offline");

		// Empty enabledModels is the normal unscoped case: the picker scope has
		// nothing to rebuild, but the active model must still follow the rebuilt
		// catalog or the next request keeps the stale construction-time record.
		expect(await current.refreshScopedModels()).toBe(true);
		expect(current.model?.baseUrl).toBe("https://new-gateway.example.com/v1");
	});

	it("re-adopts the active model for --models-scoped sessions", async () => {
		const current = await createSession(["testprov/m1"]);
		expect(current.model?.baseUrl).toBe("https://old-gateway.example.com/v1");

		await writeModelsYml("https://new-gateway.example.com/v1");
		await current.refreshModels("offline");

		// The CLI scope outranks settings, and its pattern list re-resolves
		// against the rebuilt catalog; the active model record follows too.
		expect(await current.refreshScopedModels()).toBe(true);
		expect(current.model?.baseUrl).toBe("https://new-gateway.example.com/v1");
		expect(current.scopedModels.map(entry => entry.model.id)).toEqual(["m1"]);
	});

	it("keeps an SDK-supplied scope when a reload would clear the settings scope", async () => {
		const current = await createSession(
			undefined,
			undefined,
			[{ model: createMockModel({ provider: "testprov" }) }],
			true,
		);
		expect(current.scopedModels.length).toBe(1);

		// No enabledModels configured: a settings-driven reload clears only
		// settings-derived scopes, never a programmatic (embedder-supplied) one.
		expect(await current.refreshScopedModels()).toBe(false);
		expect(current.scopedModels.length).toBe(1);
	});

	it("clears a CLI-resolved settings-derived scope once enabledModels is cleared", async () => {
		// The CLI resolves enabledModels into the same scopedModels field SDK
		// embedders use, but without sdkScopedModels provenance: clearing the
		// setting must unfreeze the cycle instead of preserving the stale
		// entries as if they were programmatic.
		const current = await createSession(undefined, Settings.isolated({ enabledModels: ["testprov/m1"] }), [
			{ model: createMockModel({ provider: "testprov" }) },
		]);
		expect(current.scopedModels.length).toBe(1);

		current.settings.override("enabledModels", []);
		expect(await current.refreshScopedModels()).toBe(true);
		expect(current.scopedModels.length).toBe(0);
	});

	it("clears the settings-derived scope when the new patterns resolve to zero models", async () => {
		const current = await createSession(undefined, Settings.isolated({ enabledModels: ["testprov/m1"] }));
		expect(await current.refreshScopedModels()).toBe(true);
		expect(current.scopedModels.map(entry => entry.model.id)).toEqual(["m1"]);

		// The config now excludes every model: the stale settings-derived scope
		// must go so /switch and Ctrl+P stop offering excluded models.
		current.settings.override("enabledModels", ["ghost-provider/ghost-model"]);
		expect(await current.refreshScopedModels()).toBe(true);
		expect(current.scopedModels.length).toBe(0);
	});

	it("re-resolves --models scope patterns against the rebuilt catalog", async () => {
		const current = await createSession(["testprov/m1", "testprov/m2"]);
		expect(current.scopedModels.length).toBe(0);

		// m2 is added to models.yml mid-session: the user-owned CLI pattern list
		// re-resolves so the added model reaches the cycle list without a
		// restart.
		await writeModelsYml("https://new-gateway.example.com/v1", ["m2"]);
		await current.refreshModels("offline");
		expect(await current.refreshScopedModels()).toBe(true);
		expect(current.scopedModels.map(entry => entry.model.id)).toEqual(["m1", "m2"]);
	});

	it("clears the --models scope when its patterns stop resolving after a reload", async () => {
		const current = await createSession(["testprov/m1"]);
		await current.refreshModels("offline");
		expect(await current.refreshScopedModels()).toBe(true);
		expect(current.scopedModels.map(entry => entry.model.id)).toEqual(["m1"]);

		// The rebuilt catalog no longer matches any --models pattern: the stale
		// scope must go so Ctrl+P and /switch stop offering removed records,
		// instead of staying frozen at the launch resolution.
		await Bun.write(
			tempDir.join("models.yml"),
			YAML.stringify({
				providers: {
					otherprov: {
						baseUrl: "https://other-gateway.example.com/v1",
						apiKey: "TEST_KEY",
						api: "anthropic-messages",
						models: [
							{
								id: "other",
								name: "Other",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 100_000,
								maxTokens: 8_000,
							},
						],
					},
				},
			}),
		);
		await current.refreshModels("offline");
		expect(await current.refreshScopedModels()).toBe(true);
		expect(current.scopedModels.length).toBe(0);
	});

	it("reconciles model-dependent state and emits model_changed on an unscoped rebind", async () => {
		const current = await createSession();
		expect(current.agent.appendOnlyContext).toBeUndefined();
		const events: string[] = [];
		const unsubscribe = current.subscribe(event => {
			if (event.type === "model_changed") events.push(event.type);
		});

		// A loopback baseUrl flips the append-only-context auto-enable
		// predicate; the rebind must reconcile that state, not just swap the
		// record, and notify subscribers afterward.
		await writeModelsYml("http://127.0.0.1:8080/v1");
		await current.refreshModels("offline");
		expect(await current.refreshScopedModels()).toBe(true);

		expect(current.model?.baseUrl).toBe("http://127.0.0.1:8080/v1");
		expect(current.agent.appendOnlyContext).toBeDefined();
		expect(events).toEqual(["model_changed"]);
		unsubscribe();
	});

	it("reconciles model-dependent state when the settings scope rebinds the active model", async () => {
		const current = await createSession(undefined, Settings.isolated({ enabledModels: ["testprov/m1"] }));
		expect(current.agent.appendOnlyContext).toBeUndefined();

		// The active model is a scope member: the settings-resolved rebind must
		// run the same reconcile sequence as the registry-backed path.
		await writeModelsYml("http://127.0.0.1:8080/v1");
		await current.refreshModels("offline");
		expect(await current.refreshScopedModels()).toBe(true);

		expect(current.model?.baseUrl).toBe("http://127.0.0.1:8080/v1");
		expect(current.agent.appendOnlyContext).toBeDefined();
	});

	it("rebinds an active model that fell out of the resolved settings scope", async () => {
		const current = await createSession();

		// Mid-session the scope no longer contains the active model, but the
		// model stays active: its registry record must still follow the rebuilt
		// catalog so the next request reads the reloaded metadata.
		current.settings.override("enabledModels", ["testprov/m2"]);
		await writeModelsYml("https://new-gateway.example.com/v1", ["m2"]);
		await current.refreshModels("offline");
		expect(await current.refreshScopedModels()).toBe(true);

		expect(current.scopedModels.map(entry => entry.model.id)).toEqual(["m2"]);
		expect(current.model?.id).toBe("m1");
		expect(current.model?.baseUrl).toBe("https://new-gateway.example.com/v1");
	});
});

describe("AgentSession.refreshModels shared-registry scoping", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	afterAll(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
	});

	it("does not rebind the shared registry to the reloading session's settings", async () => {
		tempDir = TempDir.createSync("@pi-shared-registry-");
		authStorage = createInMemoryAuthStorage();
		await Bun.write(
			tempDir.join("models.yml"),
			YAML.stringify({
				providers: {
					ollama: {
						baseUrl: "http://127.0.0.1:11434/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "ollama" },
					},
				},
			}),
		);
		// ACP shape: the startup settings bind the shared registry while each
		// workspace owns a cloned Settings with its own provider policy.
		const startupSettings = Settings.isolated({ disabledProviders: ["ollama"] });
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			settings: startupSettings,
		});
		const mock = createMockModel({ provider: "anthropic" });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: [], tools: [] },
			streamFn: mock.stream,
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry,
		});

		await session.refreshModels("offline");

		// Workspace A's reload consumed its own settings for the rebuild, but
		// the shared registry's policy binding stays startup-owned: a rebind
		// would let the last-reloading ACP workspace dictate every other
		// workspace's catalog policy.
		expect(modelRegistry.getDiscoverableProviders()).not.toContain("ollama");
	});
});
