import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/**
 * `AgentSession.reapplyDefaultRoleModel` is what makes a reloaded
 * `modelRoles.default` reach the model the next turn runs on. These cases pin the
 * policy: rebind when the session is still on its role's model, and decline in
 * the two situations where switching would destroy user or recovery intent.
 */
describe("AgentSession default-role rebind", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let roleModel: Model;
	let otherModel: Model;
	let manualModel: Model;

	function selectorOf(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	/** A session whose every turn succeeds, so no fallback state is created. */
	function createSession(settings: Settings, initial: Model): AgentSession {
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: initial, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				mock.push({ content: [`ok:${selectorOf(model)}`] });
				return mock.stream(model, context, options);
			},
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			modelFromDefaultRole: true,
		});
	}

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-role-rebind-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		for (const provider of ["anthropic", "openai"]) {
			authStorage.setRuntimeApiKey(provider, `${provider}-test-key`);
		}
		modelRegistry = new ModelRegistry(authStorage);

		const a = getBundledModel("anthropic", "claude-sonnet-4-5");
		const b = getBundledModel("openai", "gpt-4o-mini");
		const c = getBundledModel("openai", "gpt-4o");
		if (!a || !b || !c) throw new Error("Expected bundled test models to exist");
		roleModel = a;
		otherModel = b;
		manualModel = c;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	it("switches the active model when the default role is reassigned", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selectorOf(roleModel));
		session = createSession(settings, roleModel);
		expect(selectorOf(session.model!)).toBe(selectorOf(roleModel));

		settings.setModelRole("default", selectorOf(otherModel));
		const result = await session.reapplyDefaultRoleModel();

		expect(result).toBe("switched");
		expect(selectorOf(session.model!)).toBe(selectorOf(otherModel));
	});

	it("reports no change when the role still resolves to the active model", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selectorOf(roleModel));
		session = createSession(settings, roleModel);

		const result = await session.reapplyDefaultRoleModel();

		expect(result).toBe("unchanged");
		expect(selectorOf(session.model!)).toBe(selectorOf(roleModel));
	});

	it("declines to override a manual model choice", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selectorOf(roleModel));
		session = createSession(settings, roleModel);

		// An explicit `/model` pick must outrank a later config edit.
		await session.setModel(manualModel);
		expect(selectorOf(session.model!)).toBe(selectorOf(manualModel));

		settings.setModelRole("default", selectorOf(otherModel));
		const result = await session.reapplyDefaultRoleModel();

		expect(result).toBe("declined");
		expect(selectorOf(session.model!)).toBe(selectorOf(manualModel));
	});

	it("declines while a retry fallback is active so the cascade is not undone", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.modelFallback": true,
			"retry.fallbackChains": { [selectorOf(roleModel)]: [selectorOf(otherModel)] },
		});
		settings.setModelRole("default", selectorOf(roleModel));

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: roleModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				if (selectorOf(model) === selectorOf(roleModel)) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else {
					mock.push({ content: [`ok:${selectorOf(model)}`] });
				}
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			modelFromDefaultRole: true,
		});

		await session.prompt("force a fallback");
		await session.waitForIdle();
		// The cascade moved the session deliberately off its role model.
		expect(session.servingModel?.isFallback).toBe(true);
		expect(selectorOf(session.model!)).toBe(selectorOf(otherModel));

		settings.setModelRole("default", selectorOf(manualModel));
		const result = await session.reapplyDefaultRoleModel();

		// Switching here would clear the fallback state (`model-controls.ts:197`) and
		// undo the recovery, so the session must stay put...
		expect(result).toBe("fallback-retargeted");
		expect(selectorOf(session.model!)).toBe(selectorOf(otherModel));
		expect(session.servingModel?.isFallback).toBe(true);
		// ...but the role change must not be lost either: the cascade's restore target
		// is retargeted, so releasing the fallback lands on the new default rather than
		// the model the operator just stopped using.
		expect(result).toBe("fallback-retargeted");
		expect(session.retryFallbackRestoreSelector).toContain(selectorOf(manualModel));
	});

	it("leaves a fallback rooted at a manual pick restoring to that pick", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.modelFallback": true,
			// Chain keyed on the manually chosen model, which is what a cascade rooted at
			// a `/model` pick looks like: its chain key is an exact selector, not a role.
			"retry.fallbackChains": { [selectorOf(manualModel)]: [selectorOf(otherModel)] },
		});
		settings.setModelRole("default", selectorOf(roleModel));

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: roleModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				if (selectorOf(model) === selectorOf(manualModel)) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else {
					mock.push({ content: [`ok:${selectorOf(model)}`] });
				}
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			modelFromDefaultRole: true,
		});

		// Manual pick, then a cascade off it.
		await session.setModel(manualModel);
		await session.prompt("force a fallback off the manual pick");
		await session.waitForIdle();
		expect(session.servingModel?.isFallback).toBe(true);
		expect(session.retryFallbackRestoreSelector).toContain(selectorOf(manualModel));

		settings.setModelRole("default", selectorOf(otherModel));
		const result = await session.reapplyDefaultRoleModel();

		// The cascade did not start from the role's model, so its restore target is
		// none of the role's business.
		expect(result).toBe("declined");
		expect(session.retryFallbackRestoreSelector).toContain(selectorOf(manualModel));
	});

	it("retargets a fallback the session started inside", async () => {
		// A session can boot already in a fallback when startup finds the configured
		// primary unusable. Its active model is the fallback, while the role-bound
		// primary lives in `initialRetryFallback.originalSelector` — so ownership must
		// be seeded from that, not from the active model.
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selectorOf(roleModel));

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: otherModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				mock.push({ content: [`ok:${selectorOf(model)}`] });
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			// Startup selected a fallback entry of the default role's chain, so the session
			// is role-owned even though its active model is not the role's model.
			modelFromDefaultRole: true,
			initialRetryFallback: {
				role: "default",
				originalSelector: selectorOf(roleModel),
				originalThinkingLevel: undefined,
			},
		});
		expect(selectorOf(session.model!)).toBe(selectorOf(otherModel));
		expect(session.retryFallbackRestoreSelector).toContain(selectorOf(roleModel));

		settings.setModelRole("default", selectorOf(manualModel));
		const result = await session.reapplyDefaultRoleModel();

		// Seeded from the active model instead, this would have failed the ownership
		// check and silently restored the stale primary once the fallback released.
		expect(result).toBe("fallback-retargeted");
		expect(session.retryFallbackRestoreSelector).toContain(selectorOf(manualModel));
		expect(selectorOf(session.model!)).toBe(selectorOf(otherModel));
	});

	it("leaves an explicit --model session alone even when it matches the current default", async () => {
		// The coincidence case: `--model` equal to today's default. Ownership cannot be
		// inferred by comparing models, because this session must stay on its explicit
		// choice once the default moves elsewhere.
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selectorOf(roleModel));
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: roleModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				mock.push({ content: [`ok:${selectorOf(model)}`] });
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			// An explicit `--model`, so not role-owned despite matching the role today.
			modelFromDefaultRole: false,
		});
		expect(selectorOf(session.model!)).toBe(selectorOf(roleModel));

		settings.setModelRole("default", selectorOf(otherModel));
		const result = await session.reapplyDefaultRoleModel();

		expect(result).toBe("declined");
		expect(selectorOf(session.model!)).toBe(selectorOf(roleModel));
	});

	it("applies an effort-only role change on the same model", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${selectorOf(roleModel)}:low`);
		session = createSession(settings, roleModel);
		await session.reapplyDefaultRoleModel();
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);

		// The model does not move, so nothing but this carries the new effort.
		settings.setModelRole("default", `${selectorOf(roleModel)}:high`);
		const result = await session.reapplyDefaultRoleModel();

		expect(result).toBe("thinking-applied");
		expect(session.configuredThinkingLevel()).toBe(Effort.High);
		expect(selectorOf(session.model!)).toBe(selectorOf(roleModel));
	});

	it("preserves the current effort when an explicit one is removed and the model has no default", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${selectorOf(roleModel)}:low`);
		session = createSession(settings, roleModel);
		await session.reapplyDefaultRoleModel();
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);

		// Dropping the suffix leaves nothing to apply: the role no longer pins an effort
		// and this model declares no default. `setModel` preserves the current level in
		// exactly that case (`#reapplyThinkingLevel(undefined)`), so a reload matches it
		// rather than inventing a reset.
		settings.setModelRole("default", selectorOf(roleModel));
		const result = await session.reapplyDefaultRoleModel();

		expect(result).toBe("unchanged");
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("carries the role's effort across a model switch", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${selectorOf(roleModel)}:low`);
		session = createSession(settings, roleModel);
		await session.reapplyDefaultRoleModel();

		// A reasoning-capable target, since an effort on a non-reasoning model is dropped
		// during role resolution and would prove nothing here.
		const reasoningTarget = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!reasoningTarget) throw new Error("Expected bundled reasoning model to exist");
		// `setModel` reapplies the target model's own default effort, so without an
		// explicit re-application the role's level would be silently discarded.
		settings.setModelRole("default", `${selectorOf(reasoningTarget)}:high`);
		const result = await session.reapplyDefaultRoleModel();

		expect(result).toBe("switched");
		expect(selectorOf(session.model!)).toBe(selectorOf(reasoningTarget));
		expect(session.configuredThinkingLevel()).toBe(Effort.High);
	});

	it("serializes overlapping reload-and-rebind callers", async () => {
		// Needs a persisted Settings: the in-memory variant short-circuits reloadGlobal(),
		// so the unified operation would have nothing to serialize.
		const configDir = TempDir.createSync("@pi-role-rebind-cfg-");
		const agentDir = path.join(configDir.path(), "agent");
		const configPath = path.join(agentDir, "config.yml");
		try {
			await Bun.write(configPath, YAML.stringify({ modelRoles: { default: selectorOf(roleModel) } }));
			const settings = await Settings.loadIsolated({
				cwd: configDir.path(),
				agentDir,
				overrides: { "compaction.enabled": false },
			});
			session = createSession(settings, roleModel);
			const live = session;

			// Hold the rebind open so the ordering is forced rather than raced. Settings
			// serializes the two reload halves, so the second caller's reload resolves as
			// soon as the first commits its layer — before the first's rebind finishes.
			// Without a session-level lock the second therefore settles mid-switch, and a
			// caller awaiting it would act on the old model.
			const order: string[] = [];
			const gate = Promise.withResolvers<void>();
			const realSetModel = live.setModel.bind(live);
			(live as unknown as { setModel: AgentSession["setModel"] }).setModel = async (...args) => {
				order.push("rebind:start");
				await gate.promise;
				const result = await realSetModel(...args);
				order.push("rebind:end");
				return result;
			};

			await Bun.write(configPath, YAML.stringify({ modelRoles: { default: selectorOf(otherModel) } }));
			const firstCall = live.reloadConfigAndReapplyRole().then(value => {
				order.push("first:done");
				return value;
			});
			const secondCall = live.reloadConfigAndReapplyRole().then(value => {
				order.push("second:done");
				return value;
			});

			// Let both progress as far as they can; the first parks inside the gated rebind.
			for (let attempt = 0; attempt < 50 && !order.includes("rebind:start"); attempt++) {
				await scheduler.wait(0);
			}
			expect(order).toContain("rebind:start");
			gate.resolve();
			const [first, second] = await Promise.all([firstCall, secondCall]);

			// The load-bearing assertion: the second caller cannot settle until the first
			// caller's rebind has committed.
			expect(order.indexOf("rebind:end")).toBeLessThan(order.indexOf("second:done"));
			expect([first.rebind, second.rebind].filter(outcome => outcome === "switched")).toHaveLength(1);
			expect(selectorOf(live.model!)).toBe(selectorOf(otherModel));
			await settings.flush().catch(() => {});
		} finally {
			configDir.removeSync();
		}
	});

	it("defers a role change while plan mode owns the model", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selectorOf(roleModel));
		session = createSession(settings, roleModel);

		// Plan mode holds the active model, and its exit path restores the snapshot taken
		// on entry, so switching here would fight it.
		session.setPlanModeState({ enabled: true, planFilePath: path.join(tempDir.path(), "PLAN.md") });
		settings.setModelRole("default", selectorOf(otherModel));
		const deferred = await session.reapplyDefaultRoleModel();

		expect(deferred).toBe("deferred-plan-mode");
		expect(selectorOf(session.model!)).toBe(selectorOf(roleModel));

		// Leaving plan mode clears the state and then reapplies, which is what actually
		// lands the change: a second reload could not, since the role edit is already
		// committed and would report `unchanged`.
		session.setPlanModeState(undefined);
		const applied = await session.reapplyDefaultRoleModel();

		expect(applied).toBe("switched");
		expect(selectorOf(session.model!)).toBe(selectorOf(otherModel));
	});
});
