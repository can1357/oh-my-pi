import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyModelPreset, saveModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import {
	resolveCliModel,
	resolveModelRoleValue,
	resolveModelScope,
	filterAvailableModelsByEnabledPatterns,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	cfgDisabledProviders,
	cfgEnabledModels,
	cfgExcludedModels,
} from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	buildSessionOptions,
	resolveScopedModels,
	toSessionScopedModels,
	watchScopedModelSettings,
} from "@oh-my-pi/pi-coding-agent/main";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ModelMentionRegistry } from "@oh-my-pi/pi-coding-agent/session/model-mentions";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgExtendedContext } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { buildSessionModelScope, SessionModelScopeCache } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { createModelMentionSource } from "@oh-my-pi/pi-tui/prompt/model-mention-autocomplete";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentSideConnection, type AnyMessage } from "@oh-my-pi/pi-utils/acp";

function modelDefinition(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function selectors(models: readonly Model[]): string[] {
	return models.map(model => `${model.provider}/${model.id}`);
}

describe("excludedModels catalog policy", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let settings: Settings;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;
	let acp: AcpAgent | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		directory = TempDir.createSync("@omp-model-exclusions-");
		auth = await AuthStorage.create(":memory:");
		settings = Settings.isolated();
		const modelsPath = path.join(directory.path(), "models.yml");
		// JSON is also valid YAML. Keep provider configuration and auth real and isolated.
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: Object.fromEntries(
					Object.entries({
						devin: ["fusion-test", "fusion-test-v2", "regular-test", "regular-test-v2"],
						other: ["fusion-test"],
					}).map(([provider, ids]) => [
						provider,
						{
							baseUrl: "https://example.invalid/v1",
							api: "openai-completions",
							apiKey: "fixture-key",
							models: ids.map(modelDefinition),
						},
					]),
				),
			}),
		);
		registry = new ModelRegistry(auth, modelsPath, { settings });
	});

	afterEach(async () => {
		await acp?.dispose();
		acp = undefined;
		await session?.dispose();
		session = undefined;
		auth.close();
		await directory.remove();
	});

	function startSession(model = registry.find("devin", "regular-test")): AgentSession {
		if (!model) throw new Error("Missing regular Devin fixture");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(directory.path(), path.join(directory.path(), "sessions")),
			settings,
			modelRegistry: registry,
			scopedModels: registry
				.getAvailableForProviders(new Set(["devin"]))
				.filter(model => ["regular-test", "regular-test-v2", "fusion-test"].includes(model.id))
				.map(model => ({ model })),
		});
		return session;
	}

	async function advertisedModels(live: AgentSession): Promise<string[]> {
		// Exercise the real ACP connection with an in-memory client transport.
		const input = new TransformStream<AnyMessage>();
		const writer = input.writable.getWriter();
		new AgentSideConnection(
			connection => {
				const agent = new AcpAgent(connection, async () => live);
				acp = agent;
				return agent;
			},
			{ readable: input.readable, writable: new WritableStream<AnyMessage>() },
		);
		if (!acp) throw new Error("ACP connection did not create an agent");
		const response = await acp.newSession({ cwd: directory.path(), mcpServers: [] });
		const option = response.configOptions?.find(option => option.id === "model");
		if (!option || option.type !== "select") throw new Error("ACP did not advertise model options");
		await writer.close();
		return option.options.flatMap(entry => ("value" in entry ? [entry.value] : []));
	}

	it.each(["owned", "supplied"])(
		"rejects an excluded task override with a %s registry",
		async ownership => {
			// A fresh process isolates default registry paths and credentials from the test runner.
			const program = `
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
const auth = await AuthStorage.create(":memory:");
try {
	const result = await runSubprocess({
		cwd: process.env.PI_CODING_AGENT_DIR,
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", tools: [] },
		task: "test", index: 0, id: "excluded-task-model", enableLsp: false,
		modelOverride: ["fusion-test"], maxRuntimeMs: 5000,
		authStorage: auth, settings: Settings.isolated({ excludedModels: ["*/*"] }),
		modelRegistry: ${ownership === "supplied" ? "new ModelRegistry(auth)" : "undefined"},
	});
	process.stdout.write(JSON.stringify(result));
} finally { auth.close(); }
`;
			const child = Bun.spawn([process.execPath, "--eval", program], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					PATH: process.env.PATH,
					PI_CODING_AGENT_DIR: directory.path(),
					XDG_CONFIG_HOME: directory.path(),
					XDG_DATA_HOME: directory.path(),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [output, errors, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: "" });
			const result: SingleResult = JSON.parse(output);
			expect(result.exitCode).toBe(1);
			expect(result.resolvedModelIdentity).toBeUndefined();
			expect(result.error).toMatch(/No models available|No model selected|not found|not available/i);
		},
		30_000,
	);

	it("refuses an excluded exact selector instead of recycling it as a variant alias", async () => {
		const selector = "google-antigravity/gemini-3-flash";
		auth.keys.setRuntime("google-antigravity", "fixture-key");
		expect(resolveCliModel({ cliModel: selector, modelRegistry: registry, settings }).model?.id).toBe(
			"gemini-3-flash",
		);
		cfgExcludedModels.set(settings, [selector]);
		for (const suffix of ["", ":high"]) {
			expect(
				resolveCliModel({ cliModel: selector + suffix, modelRegistry: registry, settings }).model,
			).toBeUndefined();
			expect(
				resolveCliModel({
					cliProvider: "google-antigravity",
					cliModel: `gemini-3-flash${suffix}`,
					modelRegistry: registry,
					settings,
				}).model,
			).toBeUndefined();
			settings.setModelRole("slow", selector + suffix);
			expect(resolveModelRoleValue("@slow", registry.getAvailable(), { settings }).model).toBeUndefined();
			expect(await resolveModelScope([selector + suffix], registry, undefined, settings)).toEqual([]);
			expect(filterAvailableModelsByEnabledPatterns(registry.getAvailable(), [selector + suffix], settings)).toEqual(
				[],
			);
		}
		expect(registry.find("google-antigravity", "gemini-3.5-flash")?.id).toBe("gemini-3.5-flash");
		cfgExcludedModels.set(settings, []);
		expect(resolveCliModel({ cliModel: selector, modelRegistry: registry, settings }).model?.id).toBe(
			"gemini-3-flash",
		);
	});

	it.each(["prewalk", "plan-yolo"])("does not rebind an excluded --%s-into selector to its alias", async handoff => {
		const selector = "google-antigravity/gemini-3-flash";
		auth.keys.setRuntime("google-antigravity", "fixture-key");
		const build = () =>
			buildSessionOptions(
				parseArgs([
					"--cwd",
					directory.path(),
					"--model",
					"devin/regular-test",
					`--${handoff}`,
					`--${handoff}-into`,
					selector,
				]),
				[],
				SessionManager.inMemory(),
				registry,
				settings,
			);
		const initial = await build();
		expect((handoff === "prewalk" ? initial.prewalk : initial.planYolo)?.target.id).toBe("gemini-3-flash");
		cfgExcludedModels.set(settings, [selector]);
		if (handoff === "prewalk") {
			const filtered = await build();
			expect(filtered.prewalk).toBeUndefined();
		} else {
			await expect(build()).rejects.toThrow(/not found|not available|excluded/i);
		}
		expect(registry.find("google-antigravity", "gemini-3.5-flash")?.id).toBe("gemini-3.5-flash");
	});

	it.each([false, true])("keeps real alias-source cooldowns distinct (excluded=%s)", excluded => {
		const source = "google-antigravity/gemini-3-flash";
		const target = "google-antigravity/gemini-3.5-flash";
		const until = Date.now() + 60_000;
		expect(registry.getModelMetadata({ provider: "google-antigravity", id: "gemini-3-flash" })?.id).toBe(
			"gemini-3-flash",
		);
		cfgExcludedModels.set(settings, excluded ? [source] : []);
		registry.suppressSelector(source, until);
		expect(registry.isSelectorSuppressed(source)).toBe(true);
		expect(registry.isSelectorSuppressed(target)).toBe(false);
		cfgExcludedModels.set(settings, []);
		expect(registry.isSelectorSuppressed(source)).toBe(true);
		registry.suppressSelector(target, until);
		cfgExcludedModels.set(settings, [source]);
		registry.clearSuppressedSelector(source);
		expect(registry.isSelectorSuppressed(source)).toBe(false);
		expect(registry.isSelectorSuppressed(target)).toBe(true);
	});

	it("keeps scope globs matching models outside a narrower exclusion", async () => {
		cfgExcludedModels.set(settings, ["devin/fusion-?"]);
		const expected = ["devin/fusion-test", "devin/fusion-test-v2"];
		expect(
			selectors(
				(await resolveModelScope(["devin/fusion-*"], registry, undefined, settings)).map(entry => entry.model),
			),
		).toEqual(expected);
		expect(
			selectors(filterAvailableModelsByEnabledPatterns(registry.getAvailable(), ["devin/fusion-*"], settings)),
		).toEqual(expected);
	});

	it("hides an exact provider-qualified ID from lazy lookup and the full catalog without hiding another provider's ID", () => {
		cfgExcludedModels.set(settings, ["devin/fusion-test"]);
		expect(registry.find("devin", "fusion-test")).toBeUndefined();
		expect(selectors(registry.getAvailableForProviders(new Set(["devin"])))).not.toContain("devin/fusion-test");
		expect(selectors(registry.getAll("all"))).not.toContain("devin/fusion-test");
		expect(registry.find("other", "fusion-test")?.id).toBe("fusion-test");
		expect(registry.find("devin", "fusion-test-v2")?.id).toBe("fusion-test-v2");
		expect(selectors(registry.getAvailable())).not.toContain("devin/fusion-test");
	});

	it("excludes a copied bundled selector containing glob characters", () => {
		const provider = "zhipu-coding-plan";
		const id = "glm-5.2-highspeed[1m]";
		const selector = `${provider}/${id}`;
		auth.keys.setRuntime(provider, "fixture-key");
		expect(registry.find(provider, id)).toBeDefined();
		expect(selectors(registry.getAvailableForProviders(new Set([provider])))).toContain(selector);

		cfgExcludedModels.set(settings, [selector.toUpperCase()]);
		expect(registry.find(provider, id)).toBeUndefined();
		expect(selectors(registry.getAll())).not.toContain(selector);
		expect(selectors(registry.getAvailable())).not.toContain(selector);
		expect(registry.find(provider, "glm-5.2-highspeed")).toBeDefined();

		cfgExcludedModels.set(settings, []);
		expect(registry.find(provider, id)).toBeDefined();
		expect(selectors(registry.getAvailable())).toContain(selector);
	});

	it("omits devin/fusion-* from the normal catalog and ACP options while preserving regular Devin models and auth", async () => {
		cfgExcludedModels.set(settings, ["devin/fusion-*"]);
		const live = startSession();
		const catalog = selectors(live.getAvailableModels());
		expect(catalog.filter(selector => selector.startsWith("devin/fusion-"))).toEqual([]);
		expect(catalog).toContain("devin/regular-test");
		expect(catalog).toContain("other/fusion-test");
		expect(selectors(registry.getProviderModels("devin"))).not.toContain("devin/fusion-test-v2");
		expect(registry.getProviderBaseUrl("devin")).toBe("https://example.invalid/v1");
		expect(await registry.getApiKeyForProvider("devin")).toBe("fixture-key");

		const advertised = await advertisedModels(live);
		expect(advertised).toEqual(catalog);
		expect(advertised.filter(selector => selector.startsWith("devin/fusion-"))).toEqual([]);
		expect(advertised).toContain("devin/regular-test");
	});

	it("keeps exclusions after refresh and filters newly registered or discovered models", async () => {
		cfgExcludedModels.set(settings, ["devin/fusion-*"]);
		registry.registerProvider("devin", {
			baseUrl: "https://example.invalid/v1",
			api: "openai-completions",
			apiKey: "fixture-key",
			models: [modelDefinition("fusion-extension"), modelDefinition("regular-extension")],
			fetchDynamicModels: async () => [modelDefinition("fusion-discovered"), modelDefinition("regular-discovered")],
		});
		await registry.refreshRuntimeProviders("online");
		await registry.refresh("offline");
		const available = selectors(registry.getAvailable());
		expect(available.filter(selector => selector.startsWith("devin/fusion-"))).toEqual([]);
		expect(available).toContain("devin/regular-discovered");
	});

	it("applies live exclusions to cached catalog reads and cycling, and restores models when cleared", async () => {
		const live = startSession();
		const original = selectors(registry.getAll());
		cfgExcludedModels.set(settings, ["DEVIN/FUSION-*"]);
		expect(selectors(registry.getAll())).not.toContain("devin/fusion-test");
		expect(selectors(live.scopedModels.map(entry => entry.model))).toEqual([
			"devin/regular-test",
			"devin/regular-test-v2",
		]);
		expect((await live.cycleModel())?.model.id).toBe("regular-test-v2");
		expect((await live.cycleModel())?.model.id).toBe("regular-test");
		cfgExcludedModels.set(settings, []);
		expect(selectors(registry.getAll())).toEqual(original);
		expect(selectors(live.scopedModels.map(entry => entry.model))).toContain("devin/fusion-test");
	});

	it.each(["enabledModels", "--models"])("restores a scope built with exclusions enabled (%s)", async source => {
		const explicit = source === "--models";
		const patterns = ["devin/regular-test*", "devin/fusion-*"];
		cfgEnabledModels.set(settings, patterns);
		cfgExcludedModels.set(settings, ["devin/fusion-*"]);
		const parsed = parseArgs(explicit ? ["--models", patterns.join(",")] : []);
		const initialScope = await resolveScopedModels(parsed, registry, settings);
		const live = startSession();
		live.setScopedModels(toSessionScopedModels(initialScope, settings));
		watchScopedModelSettings(live, parsed, registry, settings);
		expect(selectors(live.scopedModels.map(entry => entry.model))).toEqual([
			"devin/regular-test",
			"devin/regular-test-v2",
		]);

		cfgExcludedModels.set(settings, []);
		// Settings listeners coalesce in a microtask; let async scope resolution settle.
		await Bun.sleep(0);
		expect(selectors(live.scopedModels.map(entry => entry.model))).toEqual([
			"devin/regular-test",
			"devin/regular-test-v2",
			"devin/fusion-test",
			"devin/fusion-test-v2",
		]);
		expect((await live.cycleModel())?.model.id).toBe("regular-test-v2");
		expect((await live.cycleModel())?.model.id).toBe("fusion-test");

		cfgExcludedModels.set(settings, ["devin/fusion-*"]);
		await Bun.sleep(0);
		expect(selectors(live.scopedModels.map(entry => entry.model))).not.toContain("devin/fusion-test");
		// An enabledModels edit must still leave an explicit CLI scope pinned.
		cfgEnabledModels.set(settings, ["devin/regular-test"]);
		await Bun.sleep(0);
		cfgExcludedModels.set(settings, []);
		await Bun.sleep(0);
		expect(live.scopedModels).toHaveLength(explicit ? 4 : 1);
	});

	it.each(["enabledModels", "--models"])("does not cycle outside an all-excluded scope (%s)", async source => {
		const patterns = ["devin/regular-test*"];
		cfgEnabledModels.set(settings, patterns);
		const parsed = parseArgs(source === "--models" ? ["--models", patterns.join(",")] : []);
		const live = startSession();
		live.setScopedModels(toSessionScopedModels(await resolveScopedModels(parsed, registry, settings), settings));
		watchScopedModelSettings(live, parsed, registry, settings);

		cfgExcludedModels.set(settings, patterns);
		// Both immediate filtering and the completed rebuild must retain scoped mode.
		expect(await live.cycleModel()).toBeUndefined();
		await Bun.sleep(0);
		expect(live.scopedModels).toEqual([]);
		expect(await live.cycleModel()).toBeUndefined();
		expect(live.model?.id).toBe("regular-test");
		expect(selectors(registry.getAvailable())).toContain("devin/fusion-test");

		cfgExcludedModels.set(settings, []);
		await Bun.sleep(0);
		expect((await live.cycleModel())?.model.id).toBe("regular-test-v2");
		if (source === "enabledModels") {
			cfgEnabledModels.set(settings, []);
			await Bun.sleep(0);
			expect((await live.cycleModel())?.isScoped).toBe(false);
		}
	});

	it.each(["forward", "backward"] as const)("cycles %s to the sole eligible scoped model", async direction => {
		const live = startSession();
		live.setScopedModels(live.scopedModels.filter(entry => entry.model.id.startsWith("regular-test")));
		cfgExcludedModels.set(settings, ["devin/regular-test"]);
		expect((await live.cycleModel(direction))?.model.id).toBe("regular-test-v2");
		expect(await live.cycleModel(direction)).toBeUndefined();
	});

	it.each(["forward", "backward"] as const)(
		"enters the visible scope at its %s end when the active model is excluded",
		async direction => {
			const live = startSession();
			cfgExcludedModels.set(settings, ["devin/regular-test"]);
			const eligible = live.scopedModels;
			expect(eligible).toHaveLength(2);
			const expected = direction === "forward" ? eligible[0].model : eligible[eligible.length - 1].model;
			expect((await live.cycleModel(direction))?.model.id).toBe(expected.id);
		},
	);

	it.each([
		["forward", 1],
		["backward", 1],
		["forward", 2],
		["backward", 2],
	] as const)("enters the unscoped catalog %s with %i eligible models after exclusion", async (direction, count) => {
		const live = startSession();
		live.setScopedModels([], false);
		cfgDisabledProviders.set(
			settings,
			[...new Set(registry.getAll("all").map(model => model.provider))].filter(provider => provider !== "devin"),
		);
		cfgExcludedModels.set(settings, [
			count === 1 ? "devin/{fusion-*,swe-*,regular-test}" : "devin/{fusion-test-v2,swe-*,regular-test}",
		]);
		const eligible = registry.getAvailable();
		expect(eligible).toHaveLength(count);
		const expected = direction === "forward" ? eligible[0] : eligible[eligible.length - 1];
		expect((await live.cycleModel(direction))?.model.id).toBe(expected.id);
		if (count === 1) expect(await live.cycleModel(direction)).toBeUndefined();
	});

	it.each(["forward", "backward"] as const)(
		"enters eligible roles at the %s boundary after exclusion",
		async direction => {
			const live = startSession();
			settings.setModelRole("default", "devin/regular-test");
			settings.setModelRole("slow", "devin/regular-test-v2");
			settings.setModelRole("smol", "devin/fusion-test");
			cfgExcludedModels.set(settings, ["devin/regular-test"]);
			expect((await live.cycleRoleModels(["slow", "smol"], direction))?.role).toBe(
				direction === "forward" ? "slow" : "smol",
			);
			expect((await live.cycleRoleModels(["slow", "smol"], direction))?.role).toBe(
				direction === "forward" ? "smol" : "slow",
			);
		},
	);

	it("refuses presets outside a configured-empty scope without writing roles", async () => {
		settings.setModelRole("default", "devin/fusion-test");
		saveModelPreset(settings, "outside");
		settings.setModelRole("default", "devin/regular-test");
		const live = startSession();
		live.setScopedModels(live.scopedModels.filter(entry => entry.model.id.startsWith("regular-test")));
		cfgExcludedModels.set(settings, ["devin/regular-test*"]);
		expect(live.scopedModels).toEqual([]);
		expect((await applyModelPreset(settings, live, "outside")).kind).toBe("unavailable");
		expect(settings.getModelRole("default")).toBe("devin/regular-test");
		expect(live.model?.id).toBe("regular-test");
		live.setScopedModels([], false);
		expect((await applyModelPreset(settings, live, "outside")).kind).toBe("switched");
		expect(live.model?.id).toBe("fusion-test");
	});

	it("keeps interactive role cycling and quick-role choices inside the configured scope", async () => {
		const live = startSession();
		const scope = live.scopedModels.filter(entry => entry.model.id.startsWith("regular-test"));
		live.setScopedModels(scope);
		settings.setModelRole("default", "devin/fusion-test");
		settings.setModelRole("slow", "devin/fusion-test-v2");
		cfgExcludedModels.set(settings, ["devin/regular-test*"]);
		expect(live.getRoleModelCycle(["default", "slow"])).toBeUndefined();
		expect(await live.cycleRoleModels(["default", "slow"])).toBeUndefined();
		expect(live.model?.id).toBe("regular-test");
		live.setScopedModels([], false);
		expect(live.getRoleModelCycle(["default", "slow"])?.models).toHaveLength(2);
		expect((await live.cycleRoleModels(["default", "slow"]))?.model.id).toBe("fusion-test");
	});

	it.each(["forward", "backward"] as const)("cycles roles %s to the sole eligible scoped model", async direction => {
		const live = startSession();
		settings.setModelRole("default", "devin/regular-test");
		settings.setModelRole("slow", "devin/regular-test-v2");
		live.setScopedModels(live.scopedModels.filter(entry => entry.model.id.startsWith("regular-test")));
		cfgExcludedModels.set(settings, ["devin/regular-test"]);
		expect((await live.cycleRoleModels(["slow"], direction))?.model.id).toBe("regular-test-v2");
		expect(await live.cycleRoleModels(["slow"], direction)).toBeUndefined();
	});

	it("keeps configured-empty picker, hub, and mention scopes empty until the scope is cleared", async () => {
		const live = startSession();
		live.setScopedModels([], true);
		const mentionRegistry = new ModelMentionRegistry({
			sessionManager: live.sessionManager,
			modelRegistry: registry,
			scopedModels: () => live.scopedModels.map(entry => entry.model),
			scopedModelsConfigured: () => live.scopedModelsConfigured,
		});
		expect(mentionRegistry.findMentionable("devin/regular-test")).toBeUndefined();
		const source = createModelBrowserSource(settings);
		const cache = new SessionModelScopeCache(source, registry);
		const mentions = createModelMentionSource({
			source,
			registry,
			scopedModels: () => live.scopedModels.map(entry => entry.model),
			scopedModelsConfigured: () => live.scopedModelsConfigured,
		});
		expect(buildSessionModelScope(source, registry, [], live.scopedModelsConfigured).items).toEqual([]);
		expect(cache.get([], live.scopedModelsConfigured).items).toEqual([]);
		expect(mentions("devin")).toEqual([]);
		// A small terminal substitute lets the real overlays describe and handle selection.
		const tui = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;
		const cx: DescribeContext = {
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		let picked: Model | undefined;
		const picker = new ModelPickerComponent(
			tui,
			source,
			registry,
			[],
			{
				onPick: model => {
					picked = model;
				},
				onCancel: () => {},
			},
			{ scopedModelsConfigured: live.scopedModelsConfigured },
		);
		const pickerNode = picker.describe(cx);
		if (pickerNode.k !== "picker") throw new Error("Expected a picker node");
		expect(pickerNode.p?.total).toBe(0);
		picker.handleInput("\r");
		expect(picked).toBeUndefined();
		const hub = new ModelHubComponent(
			tui,
			source,
			registry,
			[],
			{
				onAssign: model => {
					picked = model;
				},
				onUnassign: () => {},
				onCancel: () => {},
			},
			{ scopedModelsConfigured: live.scopedModelsConfigured },
		);
		try {
			const chatSelectors = new Set(
				selectors(registry.getAvailable("all").filter(model => modelKind(model) === "chat")),
			);
			const hubNode = hub.describe(cx);
			if (hubNode.k !== "picker") throw new Error("Expected a hub picker node");
			const items = hubNode.p?.items;
			if (!items) throw new Error("Hub did not describe its model items");
			expect(items.filter(item => chatSelectors.has(item.id))).toEqual([]);
		} finally {
			hub.dispose();
		}
		live.setScopedModels([], false);
		expect(mentionRegistry.findMentionable("devin/regular-test")?.id).toBe("regular-test");
		expect(cache.get([], live.scopedModelsConfigured).items.map(item => item.selector)).toContain(
			"devin/regular-test",
		);
		expect(mentions("regular-test").map(item => item.selector)).toContain("devin/regular-test");
		expect(buildSessionModelScope(source, registry, []).items.length).toBeGreaterThan(0);
	});

	it("rebinds an excluded active model after background discovery", async () => {
		const model = registry.find("devin", "regular-test");
		if (!model) throw new Error("Missing fixture");
		cfgExcludedModels.set(settings, ["devin/regular-test"]);
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: { ...model, contextWindow: 256_000 },
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
			rebindModelAfterDiscovery: true,
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "model_changed") resolve();
		});
		registry.refreshInBackground("offline");
		try {
			await Promise.race([
				promise,
				Bun.sleep(5_000).then(() => {
					throw new Error("Discovery did not rebind active model");
				}),
			]);
			expect(session.model?.contextWindow).toBe(128_000);
			expect(session.model?.id).toBe("regular-test");
			expect(registry.find("devin", "regular-test")).toBeUndefined();
		} finally {
			unsubscribe();
		}
	});

	it("updates the active excluded model's context limit when extended context is disabled", async () => {
		auth.keys.setRuntime("openai-codex", "fixture-key");
		cfgExtendedContext.set(settings, true);
		await registry.reapplyModelPolicies();
		const live = startSession(registry.find("openai-codex", "gpt-5.6-sol"));
		expect(live.model?.contextWindow).toBeGreaterThan(272_000);
		cfgExcludedModels.set(settings, ["openai-codex/gpt-5.6-sol"]);
		expect(registry.find("openai-codex", "gpt-5.6-sol")).toBeUndefined();

		cfgExtendedContext.set(settings, false);
		await registry.reapplyModelPolicies();
		await Bun.sleep(0);
		expect(live.model?.contextWindow).toBe(272_000);
		expect(live.model?.id).toBe("gpt-5.6-sol");
		expect(selectors(live.getAvailableModels())).not.toContain("openai-codex/gpt-5.6-sol");
	});

	it("keeps an all-excluded CLI scope from cycling globally at startup", async () => {
		const parsed = parseArgs(["--models", "devin/regular-test*"]);
		cfgExcludedModels.set(settings, ["devin/regular-test*"]);
		const scope = await resolveScopedModels(parsed, registry, settings);
		const options = await buildSessionOptions(parsed, scope, undefined, registry, settings);
		const model = registry.find("devin", "fusion-test");
		if (!model) throw new Error("Missing unexcluded startup model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
			scopedModels: options.scopedModels,
			scopedModelsConfigured: options.scopedModelsConfigured,
		});
		expect(scope).toEqual([]);
		expect(await session.cycleModel()).toBeUndefined();
		expect(session.model?.id).toBe("fusion-test");
	});

	it("applies isolated SDK settings to a caller-owned registry for selection and ACP", async () => {
		registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
		cfgExcludedModels.set(settings, ["devin/fusion-*"]);
		settings.setModelRole("default", "devin/*");
		({ session } = await createAgentSession({
			cwd: directory.path(),
			agentDir: directory.path(),
			modelRegistry: registry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: [],
		}));
		expect(session.model?.id.startsWith("fusion-")).toBe(false);
		const catalog = selectors(session.getAvailableModels());
		expect(catalog.filter(selector => selector.startsWith("devin/fusion-"))).toEqual([]);
		expect(catalog).toContain("devin/regular-test");
		expect(registry.find("devin", "fusion-test")).toBeUndefined();

		expect(await advertisedModels(session)).toEqual(catalog);
	});

	it.each([false, true])("resolves deferred prewalk without alias substitution (excluded=%s)", async excluded => {
		const selector = "google-antigravity/gemini-3-flash";
		auth.keys.setRuntime("google-antigravity", "fixture-key");
		cfgExcludedModels.set(settings, excluded ? [selector] : []);
		const warnings: string[] = [];
		({ session } = await createAgentSession({
			cwd: directory.path(),
			agentDir: directory.path(),
			modelRegistry: registry,
			settings,
			model: registry.find("devin", "regular-test"),
			sessionManager: SessionManager.inMemory(),
			deferredPrewalk: { target: selector, patterns: [selector] },
			onPrewalkWarning: warning => warnings.push(warning),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: [],
		}));
		expect(session.getPrewalkState()?.target.id).toBe(excluded ? undefined : "gemini-3-flash");
		expect(warnings.length > 0).toBe(excluded);
	});

	it("retains the complete catalog and available model list when exclusions are omitted or empty", async () => {
		const catalog = selectors(registry.getAll("all"));
		const available = selectors(registry.getAvailable());
		// Unlike in-memory settings, disk loading validates every absent setting.
		const diskSettings = await Settings.loadReadOnly({ cwd: directory.path(), agentDir: directory.path() });
		const diskRegistry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"), {
			settings: diskSettings,
		});
		expect(selectors(diskRegistry.getAvailable())).toEqual(available);
		expect(available).toContain("devin/fusion-test");
		expect(available).toContain("devin/regular-test");
		cfgExcludedModels.set(settings, []);
		expect(selectors(registry.getAll("all"))).toEqual(catalog);
		expect(selectors(registry.getAvailable())).toEqual(available);
	});

	it("rejects malformed exclusion entries at the settings boundary", () => {
		expect(() => cfgExcludedModels.set(settings, ["fusion-*"])).toThrow("provider/id");
		expect(() => Settings.isolated({ excludedModels: [42] })).toThrow("provider/id");
		expect(selectors(registry.getAvailable())).toContain("devin/fusion-test");
	});
	it.each([
		"devin/fusion-[",
		"devin/fusion-[]",
		"devin/fusion-[!]",
		"devin/fusion-[z-a]",
		"devin/fusion-[Z-a]",
		"devin/fusion-{test,v2",
		"devin/fusion-test}",
		"devin/fusion-\\",
	])("rejects malformed glob %s at the settings boundary", pattern => {
		expect(() => cfgExcludedModels.set(settings, [pattern])).toThrow("Invalid excludedModels glob pattern");
		expect(() => Settings.isolated({ excludedModels: [pattern] })).toThrow("Invalid excludedModels glob pattern");
		expect(selectors(registry.getAvailable())).toContain("devin/fusion-test");
	});

	it.each([
		["devin/fusion-[tv]*", ["fusion-test", "fusion-test-v2"]],
		["devin/fusion-{test,test-v2}", ["fusion-test", "fusion-test-v2"]],
		["devin/{fusion-{test,test-v2},regular-test}", ["fusion-test", "fusion-test-v2", "regular-test"]],
		["devin/fusion-\\[test", ["fusion-[test"]],
	] as const)("excludes matching catalog entries for complete glob %s", (pattern, excluded) => {
		const ids = ["fusion-test", "fusion-test-v2", "fusion-[test", "regular-test", "regular-test-v2"];
		registry.registerProvider("devin", {
			baseUrl: "https://example.invalid/v1",
			api: "openai-completions",
			apiKey: "fixture-key",
			models: ids.map(modelDefinition),
		});
		const original = registry.getAvailableForProviders(new Set(["devin"])).map(model => model.id);
		cfgExcludedModels.set(settings, [pattern]);
		expect(
			registry
				.getAvailableForProviders(new Set(["devin"]))
				.map(model => model.id)
				.sort(),
		).toEqual(original.filter(id => !excluded.some(excludedId => excludedId === id)).sort());
		expect(selectors(registry.getAvailable())).toContain("other/fusion-test");
	});
});
