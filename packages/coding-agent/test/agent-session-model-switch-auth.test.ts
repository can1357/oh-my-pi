import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Switching the active model (Ctrl+P role cycling, /models selection) must be a
// cheap, synchronous operation. It used to call the async `getApiKey`, which can
// block the event loop on a command-backed key program (`execSync`) or stall on
// a network OAuth refresh. The real key is resolved lazily per request via the
// resolver, so the switch only needs a synchronous "is a credential configured"
// pre-flight (`hasConfiguredAuth`) — never the resolver.
describe("AgentSession model switch auth pre-flight", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;
	const spies: Array<{ mockRestore: () => void }> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-switch-auth-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		registry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function makeSession(
		initialModel: Model<Api>,
		roles?: Record<string, string>,
		configuredSettings?: Settings,
	): AgentSession {
		const settings = configuredSettings ?? Settings.isolated();
		if (roles) {
			for (const role in roles) settings.setModelRole(role, roles[role]);
		}
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		return session;
	}

	it("switches the active model via the synchronous auth check, not the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		const hasAuthSpy = spyOn(registry, "hasConfiguredAuth");
		spies.push(getApiKeySpy, hasAuthSpy);

		await s.setModel(to);

		expect(s.model?.id).toBe(to.id);
		expect(hasAuthSpy).toHaveBeenCalled();
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("applies saved Defaults with built-in presets disabled without resolving credentials or stripping thinking", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const smolSelector = `${from.provider}/${from.id}:low`;
		const settings = Settings.isolated({
			modelRolePresets: {
				applyOnSelect: false,
				[`${to.provider}/${to.id}`]: {
					default: { roles: { smol: smolSelector } },
				},
			},
		});
		const s = makeSession(from, undefined, settings);
		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		await s.setModel(to, "default", {
			persist: true,
			modelRolePreset: { kind: "on-select" },
		});

		expect(settings.getModelRole("smol")).toBe(smolSelector);
		expect(settings.getGlobalModelRole("smol")).toBe(smolSelector);

		expect(settings.getProjectModelRole("smol")).toBeUndefined();
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});
	it("preserves omitted roles when explicitly applying a partial saved preset", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const existingSlow = `${from.provider}/${from.id}`;
		const settings = Settings.isolated({
			modelRolePresets: {
				keepRolesWhenUnset: true,
				[`${to.provider}/${to.id}`]: { default: { roles: { smol: `${to.provider}/${to.id}:low` } } },
			},
		});
		settings.setModelRole("slow", existingSlow);
		const s = makeSession(from, undefined, settings);

		await s.setModel(to, "default", { modelRolePreset: { kind: "configured-default" } });

		expect(settings.getModelRole("smol")).toBe(`${to.provider}/${to.id}:low`);
		expect(settings.getModelRole("slow")).toBe(existingSlow);
	});

	it.each(["anthropic/missing-old-slow", "anthropic/claude-sonnet-4-6"])(
		"resolves saved forward aliases against the incoming slow role instead of %s",
		async oldSlow => {
			const from = modelOrThrow("claude-sonnet-4-5");
			const to = modelOrThrow("claude-sonnet-4-6");
			const target = `${from.provider}/${from.id}:low`;
			const settings = Settings.isolated({
				modelRolePresets: {
					[`${to.provider}/${to.id}`]: { default: { roles: { smol: "@slow", slow: target } } },
				},
			});
			settings.setModelRole("slow", oldSlow);
			const s = makeSession(from, undefined, settings);

			await s.setModel(to, "default", { modelRolePreset: { kind: "configured-default" } });

			expect(settings.getModelRole("smol")).toBe("@slow");
			expect(settings.getModelRole("slow")).toBe(target);
			const resolved = s.resolveRoleModelWithThinking("smol");
			expect(resolved.model?.id).toBe(from.id);
			expect(resolved.thinkingLevel).toBe(Effort.Low);
		},
	);

	it("retains a forward alias chain and its thinking selectors", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const target = `${from.provider}/${from.id}:low`;
		const settings = Settings.isolated({
			modelRolePresets: {
				[`${to.provider}/${to.id}`]: {
					default: { roles: { smol: "@slow:high", slow: "@plan", plan: target } },
				},
			},
		});
		settings.setModelRole("slow", "anthropic/missing-old-slow");
		settings.setModelRole("plan", "anthropic/missing-old-plan");
		const s = makeSession(from, undefined, settings);

		await s.setModel(to, "default", { modelRolePreset: { kind: "configured-default" } });

		expect(settings.getModelRole("smol")).toBe("@slow:high");
		expect(settings.getModelRole("slow")).toBe("@plan");
		expect(settings.getModelRole("plan")).toBe(target);
		expect(s.resolveRoleModelWithThinking("smol").model?.id).toBe(from.id);
		expect(s.resolveRoleModelWithThinking("smol").thinkingLevel).toBe(Effort.High);
		expect(s.resolveRoleModelWithThinking("slow").thinkingLevel).toBe(Effort.Low);
	});

	it("resolves default aliases against the selected model before its role is persisted", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const selected = `${to.provider}/${to.id}`;
		const settings = Settings.isolated({
			modelRolePresets: { [selected]: { default: { roles: { smol: "@default:low" } } } },
		});
		settings.setModelRole("default", "anthropic/missing-old-default");
		const s = makeSession(from, undefined, settings);

		await s.setModel(to, "default", { modelRolePreset: { kind: "configured-default" } });

		expect(settings.getModelRole("smol")).toBe("@default:low");
		// Project selection persists Default after the model-switch callback.
		settings.setModelRole("default", selected);
		expect(s.resolveRoleModelWithThinking("smol").model?.id).toBe(to.id);
		expect(s.resolveRoleModelWithThinking("smol").thinkingLevel).toBe(Effort.Low);
	});

	it("falls back through built-in priorities for cyclic preset aliases", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const selected = `${to.provider}/${to.id}`;
		const settings = Settings.isolated({
			modelRolePresets: {
				[selected]: {
					default: { roles: { smol: "@slow", slow: "@smol", vision: "@plan", plan: "anthropic/missing-model" } },
				},
			},
		});
		for (const role of ["smol", "slow", "vision", "plan"]) {
			settings.setModelRole(role, `${from.provider}/${from.id}`);
		}
		const s = makeSession(from, undefined, settings);

		await s.setModel(to, "default", { modelRolePreset: { kind: "configured-default" } });

		expect(settings.getModelRole("smol")).toBe("@slow");
		expect(settings.getModelRole("slow")).toBe("@smol");
		expect(settings.getModelRole("vision")).toBe(selected);
		expect(settings.getModelRole("plan")).toBe(selected);
		expect(s.resolveRoleModelWithThinking("smol").model).toBeDefined();
		expect(s.resolveRoleModelWithThinking("slow").model).toBeDefined();
		expect(s.resolveRoleModelWithThinking("vision").model?.id).toBe(to.id);
		expect(s.resolveRoleModelWithThinking("plan").model?.id).toBe(to.id);
	});

	it.each([true, false])("looks up omitted alias targets with keepRolesWhenUnset=%s", async keepRolesWhenUnset => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const original = `${from.provider}/${from.id}`;
		const selected = `${to.provider}/${to.id}`;
		const settings = Settings.isolated({
			modelRolePresets: { keepRolesWhenUnset, [selected]: { default: { roles: { smol: "@vision" } } } },
		});
		settings.setModelRole("vision", original);
		const s = makeSession(from, undefined, settings);

		await s.setModel(to, "default", { modelRolePreset: { kind: "configured-default" } });

		expect(settings.getModelRole("vision")).toBe(keepRolesWhenUnset ? original : undefined);
		expect(settings.getModelRole("smol")).toBe(keepRolesWhenUnset ? "@vision" : selected);
		expect(s.resolveRoleModelWithThinking("smol").model?.id).toBe(keepRolesWhenUnset ? from.id : to.id);
	});
	it.each([true, false])(
		"honors keepRolesWhenUnset=%s for a custom role omitted by the preset",
		async keepRolesWhenUnset => {
			const from = modelOrThrow("claude-sonnet-4-5");
			const to = modelOrThrow("claude-sonnet-4-6");
			const original = `${from.provider}/${from.id}`;
			const selected = `${to.provider}/${to.id}`;
			const settings = Settings.isolated({
				modelRolePresets: { keepRolesWhenUnset, [selected]: { default: { roles: { smol: selected } } } },
			});
			// A custom role created in the Roles view, absent from the applied preset.
			settings.setModelRole("reviewer", original);
			const s = makeSession(from, undefined, settings);

			await s.setModel(to, "default", { modelRolePreset: { kind: "configured-default" } });

			// Replacement clears the omitted custom role; keeping it preserves the edit.
			expect(settings.getModelRole("reviewer")).toBe(keepRolesWhenUnset ? original : undefined);
			expect(settings.getModelRole("smol")).toBe(selected);
		},
	);

	it.each(["project", "global"] as const)("resolves cleared alias targets in the %s scope", async scope => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const original = `${from.provider}/${from.id}`;
		const selected = `${to.provider}/${to.id}`;
		const settings = Settings.isolated({
			modelRoleStorage: "project",
			modelRolePresets: { keepRolesWhenUnset: false, [selected]: { default: { roles: { smol: "@vision" } } } },
		});
		settings.setModelRole("vision", original);
		settings.setProjectModelRole("vision", "anthropic/missing-project-vision");
		const s = makeSession(from, undefined, settings);

		await s.setModel(to, "default", { scope, modelRolePreset: { kind: "configured-default" } });

		if (scope === "project") {
			expect(settings.getProjectModelRole("vision")).toBeUndefined();
			expect(settings.getGlobalModelRole("vision")).toBe(original);
			expect(settings.getProjectModelRole("smol")).toBe("@vision");
			expect(settings.getGlobalModelRole("smol")).toBeUndefined();
			expect(s.resolveRoleModelWithThinking("smol").model?.id).toBe(from.id);
		} else {
			expect(settings.getProjectModelRole("vision")).toBe("anthropic/missing-project-vision");
			expect(settings.getGlobalModelRole("vision")).toBeUndefined();
			expect(settings.getProjectModelRole("smol")).toBeUndefined();
			expect(settings.getGlobalModelRole("smol")).toBe(selected);
			expect(s.resolveRoleModelWithThinking("smol").model?.id).toBe(to.id);
		}
	});

	it("applies auto-loaded presets to a shadowed global selection", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const selected = `${to.provider}/${to.id}`;
		const settings = Settings.isolated({
			modelRoleStorage: "project",
			modelRolePresets: { autoLoad: true, applyOnSelect: true },
		});
		settings.setProjectModelRole("default", `${from.provider}/${from.id}`);
		const s = makeSession(from, undefined, settings);

		const { switched } = await s.setModel(to, "default", {
			persist: true,
			scope: "global",
			modelRolePreset: { kind: "on-select" },
		});

		expect(switched).toBe(false);
		expect(settings.getGlobalModelRole("default")).toBe(selected);
		expect(settings.getGlobalModelRole("smol")).toBeDefined();
		expect(settings.getProjectModelRole("smol")).toBeUndefined();
	});

	it("uses the session model scope when applying a built-in preset", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const selected = `${to.provider}/${to.id}`;
		const settings = Settings.isolated({ modelRolePresets: { applyOnSelect: true } });
		const s = makeSession(from, undefined, settings);
		s.setScopedModels([{ model: to }]);

		await s.setModel(to, "default", {
			persist: true,
			modelRolePreset: { kind: "built-in-default" },
		});

		expect(settings.getGlobalModelRole("smol")).toBe(selected);
	});

	it("preserves supporting roles when built-in presets are disabled and no saved Default exists", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const smolSelector = `${from.provider}/${from.id}`;
		const settings = Settings.isolated({
			modelRolePresets: {
				applyOnSelect: false,
				keepRolesWhenUnset: false,
			},
		});
		settings.setModelRole("smol", smolSelector);
		const s = makeSession(from, undefined, settings);

		await s.setModel(to, "default", {
			persist: true,
			modelRolePreset: { kind: "on-select" },
		});

		expect(settings.getModelRole("smol")).toBe(smolSelector);
	});

	it("does not apply built-in roles when resetting an empty Default with built-in presets disabled", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const retained = `${from.provider}/${from.id}`;
		const settings = Settings.isolated({
			modelRolePresets: { applyOnSelect: false, keepRolesWhenUnset: false },
		});
		settings.setModelRole("smol", retained);
		const s = makeSession(from, undefined, settings);

		await s.setModel(to, "default", {
			modelRolePreset: { kind: "configured-default", replaceUnsetRoles: true },
		});

		expect(settings.getModelRole("smol")).toBe(retained);
	});

	it("disables automatic preset loading while allowing explicit application", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const original = `${from.provider}/${from.id}`;
		const saved = `${to.provider}/${to.id}:low`;
		const settings = Settings.isolated({
			modelRolePresets: {
				autoLoad: false,
				applyOnSelect: true,
				keepRolesWhenUnset: false,
				[`${to.provider}/${to.id}`]: { default: { roles: { smol: saved } } },
			},
		});
		settings.setModelRole("smol", original);
		const s = makeSession(from, undefined, settings);
		await s.setModel(to, "default", { modelRolePreset: { kind: "on-select" } });
		expect(settings.getModelRole("smol")).toBe(original);
		await s.setModel(from, "default", { modelRolePreset: { kind: "on-select" } });
		expect(settings.getModelRole("smol")).toBe(original);
		await s.setModel(to, "default", { modelRolePreset: { kind: "configured-default" } });
		expect(settings.getModelRole("smol")).toBe(saved);
	});

	it("loads and clears automatic presets only in the project layer, preserving global fallbacks across projects", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const original = `${from.provider}/${from.id}`;
		const selected = `${to.provider}/${to.id}`;
		const saved = `${selected}:low`;
		const root = path.join(sharedDir.path(), "project-presets");
		const cwd = path.join(root, "project");
		const otherCwd = path.join(root, "other");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(otherCwd, { recursive: true });
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir: path.join(root, "agent"),
			overrides: {
				modelRoleStorage: "project",
				modelRolePresets: {
					keepRolesWhenUnset: false,
					[selected]: { default: { roles: { smol: saved } } },
				},
			},
		});
		settings.setModelRole("default", original);
		settings.setModelRole("smol", original);
		settings.setModelRole("slow", original);
		settings.setProjectModelRole("slow", `${selected}:high`);
		const s = makeSession(from, undefined, settings);

		try {
			await s.setModel(to, "default", { persist: true, modelRolePreset: { kind: "on-select" } });
			expect(s.model?.id).toBe(to.id);
			expect(settings.getProjectModelRole("default")).toBe(selected);
			expect(settings.getProjectModelRole("smol")).toBe(saved);
			expect(settings.getProjectModelRole("slow")).toBeUndefined();
			expect(settings.getModelRole("slow")).toBe(original);
			for (const role of ["default", "smol", "slow"]) {
				expect(settings.getGlobalModelRole(role)).toBe(original);
			}

			await settings.reloadForCwd(otherCwd);
			expect(settings.getModelRole("default")).toBe(original);
			expect(settings.getModelRole("smol")).toBe(original);
			expect(settings.getModelRole("slow")).toBe(original);
			await settings.reloadForCwd(cwd);
			expect(settings.getModelRole("default")).toBe(selected);
			expect(settings.getModelRole("smol")).toBe(saved);
			expect(settings.getModelRole("slow")).toBe(original);
		} finally {
			await settings.flush();
		}
	});

	it("applies explicit project presets over runtime choices and restores those choices when leaving the project", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const original = `${from.provider}/${from.id}`;
		const selected = `${to.provider}/${to.id}`;
		const root = path.join(sharedDir.path(), "runtime-presets");
		const cwd = path.join(root, "project");
		const otherCwd = path.join(root, "other");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(otherCwd, { recursive: true });
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir: path.join(root, "agent"),
			overrides: {
				modelRoleStorage: "project",
				modelRoles: { default: original, smol: `${original}:high`, slow: `${original}:low` },
				modelRolePresets: {
					autoLoad: false,
					[selected]: { presets: { Work: { roles: { smol: `${selected}:low` } } } },
				},
			},
		});
		settings.setModelRole("slow", original);
		// Restore the process override after seeding the global fallback.
		settings.overrideModelRoles({ default: original, smol: `${original}:high`, slow: `${original}:low` });
		const s = makeSession(from, undefined, settings);

		try {
			await s.setModel(to, "default", {
				persist: true,
				modelRolePreset: { kind: "named", name: "Work", replaceUnsetRoles: true },
			});
			expect(s.model?.id).toBe(to.id);
			expect(settings.getModelRole("default")).toBe(selected);
			expect(settings.getModelRole("smol")).toBe(`${selected}:low`);
			expect(settings.getModelRole("slow")).toBe(original);
			expect(settings.getGlobalModelRole("default")).toBeUndefined();
			expect(settings.getGlobalModelRole("smol")).toBeUndefined();
			expect(settings.getGlobalModelRole("slow")).toBe(original);

			await settings.reloadForCwd(otherCwd);
			expect(settings.getModelRole("default")).toBe(original);
			expect(settings.getModelRole("smol")).toBe(`${original}:high`);
			expect(settings.getModelRole("slow")).toBe(`${original}:low`);
			expect(settings.getProjectModelRole("default")).toBeUndefined();
			expect(settings.getProjectModelRole("smol")).toBeUndefined();
		} finally {
			await settings.flush();
		}
	});

	it("persists explicit project presets without switching or overwriting effective overlay roles", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const original = `${from.provider}/${from.id}`;
		const selected = `${to.provider}/${to.id}`;
		const root = path.join(sharedDir.path(), "overlay-presets");
		const cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const overlayPath = path.join(root, "overlay.yml");
		await Bun.write(overlayPath, `modelRoles:\n  default: ${original}\n  smol: ${original}:high\n`);
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir: path.join(root, "agent"),
			configFiles: [overlayPath],
			overrides: {
				modelRoleStorage: "project",
				modelRolePresets: { [selected]: { default: { roles: { smol: `${selected}:low` } } } },
			},
		});
		const s = makeSession(from, undefined, settings);
		let modelChanged = false;
		s.subscribe(event => {
			if (event.type === "model_changed") modelChanged = true;
		});
		try {
			const result = await s.setModel(to, "default", {
				persist: true,
				modelRolePreset: { kind: "configured-default" },
			});
			expect(result.switched).toBe(false);
			expect(s.model?.id).toBe(from.id);
			expect(modelChanged).toBe(false);
			expect(settings.getProjectModelRole("default")).toBe(selected);
			expect(settings.getProjectModelRole("smol")).toBe(`${selected}:low`);
			expect(settings.getGlobalModelRole("default")).toBeUndefined();
			expect(settings.getGlobalModelRole("smol")).toBeUndefined();
			expect(settings.getModelRole("default")).toBe(original);
			expect(settings.getModelRole("smol")).toBe(`${original}:high`);
			expect(settings.getModelRoleProvenance("default")).toBe("overlay");
			await settings.flush();
			await settings.reloadFromDisk();
			expect(settings.getProjectModelRole("default")).toBe(selected);
			expect(settings.getProjectModelRole("smol")).toBe(`${selected}:low`);
			expect(settings.getModelRole("default")).toBe(original);
		} finally {
			await settings.flush();
		}
	});

	it("keeps captured project runtime roles authoritative when explicitly editing a global preset", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const original = `${from.provider}/${from.id}`;
		const selected = `${to.provider}/${to.id}`;
		const settings = Settings.isolated({
			modelRoleStorage: "project",
			modelRoles: { default: selected, smol: selected, slow: selected },
			modelRolePresets: { [selected]: { default: { roles: { smol: `${selected}:low` } } } },
		});
		for (const role of ["default", "smol", "slow"]) settings.setProjectModelRole(role, original);
		const s = makeSession(from, undefined, settings);

		const result = await s.setModel(to, "default", {
			persist: true,
			scope: "global",
			modelRolePreset: { kind: "configured-default", replaceUnsetRoles: true },
		});
		expect(result.switched).toBe(false);
		expect(s.model?.id).toBe(from.id);
		expect(settings.getGlobalModelRole("default")).toBe(selected);
		expect(settings.getGlobalModelRole("smol")).toBe(`${selected}:low`);
		expect(settings.getGlobalModelRole("slow")).toBeUndefined();
		for (const role of ["default", "smol", "slow"]) {
			expect(settings.getProjectModelRole(role)).toBe(original);
			expect(settings.getModelRole(role)).toBe(original);
			expect(settings.isProjectModelRoleRuntimeOverrideActive(role)).toBe(true);
		}
	});

	it("cycles role models without invoking the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const slow = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from, {
			default: `${from.provider}/${from.id}`,
			slow: `${slow.provider}/${slow.id}`,
		});

		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		const result = await s.cycleRoleModels(["default", "slow"]);

		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slow.id);
		expect(s.model?.id).toBe(slow.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("temporary switch also avoids the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		await s.setModelTemporary(to);

		expect(s.model?.id).toBe(to.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("rejects the switch synchronously when no credential is configured, without calling the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		const hasAuthSpy = spyOn(registry, "hasConfiguredAuth").mockReturnValue(false);
		spies.push(getApiKeySpy, hasAuthSpy);

		await expect(s.setModel(to)).rejects.toThrow(/No API key/);
		expect(s.model?.id).toBe(from.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});
});
