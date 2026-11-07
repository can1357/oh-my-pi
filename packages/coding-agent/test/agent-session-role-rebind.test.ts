import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

type SessionOptions = Pick<
	AgentSessionConfig,
	"modelFromDefaultRole" | "thinkingLevel" | "initialRetryFallback" | "scopedModels"
> & { streamFn?: StreamFn; sessionManager?: SessionManager };

function selectorOf(model: Model): string {
	return `${model.provider}/${model.id}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Role change did not reach the session");
		await scheduler.wait(0);
	}
}

describe("AgentSession default-role setting changes", () => {
	let sharedDir: TempDir;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let settings: Settings;
	let session: AgentSession | undefined;
	let roleModel: Model;
	let otherModel: Model;
	let manualModel: Model;

	function createSession(initial: Model = roleModel, options: SessionOptions = {}): AgentSession {
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: initial, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: options.streamFn ?? mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			modelFromDefaultRole: true,
			...options,
		});
		return session;
	}

	async function loadConfig(defaultRole: string, projectDefault?: string): Promise<string> {
		const agentDir = path.join(tempDir.path(), "agent");
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: defaultRole } }));
		if (projectDefault) {
			await Bun.write(
				path.join(tempDir.path(), ".omp", "config.yml"),
				YAML.stringify({ modelRoles: { default: projectDefault } }),
			);
		}
		settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir,
			overrides: { "compaction.enabled": false },
		});
		return configPath;
	}

	function retryStream(failingModel: Model): StreamFn {
		const mock = createMockModel();
		return (model, context, options) => {
			mock.push(
				selectorOf(model) === selectorOf(failingModel)
					? { throw: "overloaded_error: provider returned error 503" }
					: { content: ["recovered"] },
			);
			return mock.stream(model, context, options);
		};
	}

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-role-rebind-shared-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		for (const provider of ["anthropic", "openai"]) {
			authStorage.keys.setRuntime(provider, `${provider}-test-key`);
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
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
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-rebind-");
		modelRegistry.clearSuppressedSelectors();
		settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selectorOf(roleModel));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		settings.cancelPendingSaves();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("rebinds an idle role-owned session from reloadFromDisk signals", async () => {
		const configPath = await loadConfig(selectorOf(roleModel));
		const requestedModels: string[] = [];
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const live = createSession(roleModel, {
			streamFn: (model, context, options) => {
				requestedModels.push(selectorOf(model));
				return mock.stream(model, context, options);
			},
		});
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: selectorOf(otherModel) } }));
		await settings.reloadFromDisk();
		await waitFor(() => selectorOf(live.model!) === selectorOf(otherModel));

		await live.prompt("use the edited default");
		expect(requestedModels).toEqual([selectorOf(otherModel)]);
	});

	it("does not reapply the default's effort when another role changes", async () => {
		settings.setModelRole("default", `${selectorOf(roleModel)}:high`);
		const live = createSession(roleModel, { thinkingLevel: Effort.Low });
		settings.setModelRole("smol", selectorOf(otherModel));
		await scheduler.wait(0);

		expect(live.configuredThinkingLevel()).toBe(Effort.Low);
		expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
	});

	it("keeps a project-pinned default when the global default changes", async () => {
		const configPath = await loadConfig(selectorOf(otherModel), `${selectorOf(roleModel)}:high`);
		const live = createSession(roleModel, { thinkingLevel: Effort.Low });
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: selectorOf(manualModel) } }));
		await settings.reloadFromDisk();
		await scheduler.wait(0);

		expect(live.configuredThinkingLevel()).toBe(Effort.Low);
		expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
	});

	it("keeps an explicit startup model even when it equals the default", async () => {
		const live = createSession(roleModel, { modelFromDefaultRole: false });
		settings.setModelRole("default", selectorOf(otherModel));
		await live.prompt("keep the explicit model");

		expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
	});

	it("drops ownership when a manual selection keeps the current model", async () => {
		const live = createSession();
		await live.setModel(roleModel);
		settings.setModelRole("default", selectorOf(otherModel));
		await live.prompt("keep the manual selection");

		expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
	});

	it("never reacquires ownership when the default later equals a manual selection", async () => {
		const live = createSession();
		await live.setModel(manualModel);
		settings.setModelRole("default", selectorOf(manualModel));
		await live.prompt("default happens to match");
		settings.setModelRole("default", selectorOf(otherModel));
		await live.prompt("default moves again");

		expect(selectorOf(live.model!)).toBe(selectorOf(manualModel));
	});

	it("keeps a temporary explicit selection after the default changes", async () => {
		const live = createSession();
		await live.setModelTemporary(roleModel);
		settings.setModelRole("default", selectorOf(otherModel));
		await live.prompt("keep the temporary choice");

		expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
	});

	it("keeps a cycled role selection after the default moves", async () => {
		settings.setModelRole("smol", selectorOf(otherModel));
		const live = createSession();
		await live.cycleRoleModels(["default", "smol"]);
		settings.setModelRole("default", selectorOf(manualModel));
		await live.prompt("keep the cycled selection");

		expect(selectorOf(live.model!)).toBe(selectorOf(otherModel));
	});

	it("keeps a scoped model selection when the default later matches and moves away", async () => {
		const live = createSession(roleModel, { scopedModels: [{ model: roleModel }, { model: otherModel }] });
		await live.cycleModel();
		settings.setModelRole("default", selectorOf(otherModel));
		await live.prompt("default matches the cycled model");
		settings.setModelRole("default", selectorOf(manualModel));
		await live.prompt("keep the scoped selection");

		expect(selectorOf(live.model!)).toBe(selectorOf(otherModel));
	});

	it("drops ownership when switching to a restored session with the same model", async () => {
		const live = createSession(roleModel, {
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active")),
		});
		const sessionPath = path.join(tempDir.path(), "restored.jsonl");
		const timestamp = new Date().toISOString();
		await Bun.write(
			sessionPath,
			[
				{ type: "session", version: 3, id: "restored", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					model: selectorOf(roleModel),
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		expect(await live.switchSession(sessionPath)).toBe(true);
		settings.setModelRole("default", selectorOf(otherModel));
		await live.prompt("keep the restored model");

		expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
	});

	it("applies effort-only signals and preserves effort when a suffix with no model default is removed", async () => {
		settings.setModelRole("default", `${selectorOf(roleModel)}:low`);
		const live = createSession(roleModel, { thinkingLevel: Effort.Low });
		settings.setModelRole("default", `${selectorOf(roleModel)}:high`);
		await waitFor(() => live.configuredThinkingLevel() === Effort.High);
		settings.setModelRole("default", selectorOf(roleModel));
		await live.prompt("keep the effort without a model default");

		expect(live.configuredThinkingLevel()).toBe(Effort.High);
		expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
	});

	it("carries a role's explicit effort across a model switch", async () => {
		const target = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!target) throw new Error("Expected bundled reasoning model to exist");
		const live = createSession(roleModel, { thinkingLevel: Effort.Low });
		settings.setModelRole("default", `${selectorOf(target)}:high`);
		await waitFor(() => live.configuredThinkingLevel() === Effort.High);

		expect(selectorOf(live.model!)).toBe(selectorOf(target));
	});

	it("defers streaming model and effort changes until the next awaited turn boundary", async () => {
		const target = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!target) throw new Error("Expected bundled reasoning model to exist");
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let requests = 0;
		const mock = createMockModel({
			handler: async () => {
				if (++requests === 1) {
					entered.resolve();
					await gate.promise;
				}
				return { content: ["ok"] };
			},
		});
		const requestedModels: string[] = [];
		const live = createSession(roleModel, {
			thinkingLevel: Effort.Low,
			streamFn: (model, context, options) => {
				requestedModels.push(selectorOf(model));
				return mock.stream(model, context, options);
			},
		});
		const run = live.prompt("hold the first request");
		try {
			await entered.promise;
			settings.setModelRole("default", `${selectorOf(roleModel)}:high`);
			await scheduler.wait(0);
			expect(live.configuredThinkingLevel()).toBe(Effort.Low);
			settings.setModelRole("default", `${selectorOf(target)}:high`);
			await scheduler.wait(0);
			expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
			await live.prompt("run after the safe boundary", { streamingBehavior: "followUp" });
		} finally {
			gate.resolve();
			await run;
		}

		expect(requestedModels).toEqual([selectorOf(roleModel), selectorOf(target)]);
		expect(live.configuredThinkingLevel()).toBe(Effort.High);
	});

	it("lets a manual selection win over an in-flight idle rebind", async () => {
		let rebindStarted = false;
		const gate = Promise.withResolvers<void>();
		const refresh = modelRegistry.refreshSelectedModelMetadata.bind(modelRegistry);
		vi.spyOn(modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => {
			if (selectorOf(model) === selectorOf(otherModel)) {
				rebindStarted = true;
				await gate.promise;
			}
			return refresh(model);
		});
		const live = createSession();
		settings.setModelRole("default", selectorOf(otherModel));
		try {
			await waitFor(() => rebindStarted);
			const manual = live.setModel(manualModel);
			gate.resolve();
			await manual;
		} finally {
			gate.resolve();
		}
		settings.setModelRole("default", selectorOf(roleModel));
		await live.prompt("keep the manual choice after the race");

		expect(selectorOf(live.model!)).toBe(selectorOf(manualModel));
	});

	it("retargets a role-owned retry fallback without replacing its active candidate", async () => {
		settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.modelFallback": true,
			"retry.fallbackChains": { [selectorOf(roleModel)]: [selectorOf(otherModel)] },
		});
		settings.setModelRole("default", selectorOf(roleModel));
		const live = createSession(roleModel, { streamFn: retryStream(roleModel) });
		await live.prompt("enter a fallback");
		await live.waitForIdle();
		expect(live.servingModel?.isFallback).toBe(true);
		settings.setModelRole("default", selectorOf(manualModel));
		await waitFor(() => live.retryFallbackRestoreSelector === selectorOf(manualModel));

		expect(selectorOf(live.model!)).toBe(selectorOf(otherModel));
		expect(live.servingModel?.isFallback).toBe(true);
	});

	it("keeps a manual fallback's restore target even when the default matches its primary", async () => {
		settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.modelFallback": true,
			"retry.fallbackChains": { [selectorOf(manualModel)]: [selectorOf(otherModel)] },
		});
		settings.setModelRole("default", selectorOf(roleModel));
		const live = createSession(roleModel, { streamFn: retryStream(manualModel) });
		await live.setModel(manualModel);
		await live.prompt("enter a manual fallback");
		await live.waitForIdle();
		settings.setModelRole("default", selectorOf(manualModel));
		await scheduler.wait(0);
		settings.setModelRole("default", selectorOf(roleModel));
		await scheduler.wait(0);

		expect(live.retryFallbackRestoreSelector).toContain(selectorOf(manualModel));
		expect(selectorOf(live.model!)).toBe(selectorOf(otherModel));
	});

	it("retargets a startup fallback using its primary's role ownership", async () => {
		const live = createSession(otherModel, {
			initialRetryFallback: {
				role: "default",
				originalSelector: selectorOf(roleModel),
				originalThinkingLevel: undefined,
			},
		});
		settings.setModelRole("default", selectorOf(manualModel));
		await waitFor(() => live.retryFallbackRestoreSelector === selectorOf(manualModel));

		expect(selectorOf(live.model!)).toBe(selectorOf(otherModel));
	});

	it("preserves role ownership across plan entry and restores the edited default on exit", async () => {
		const live = createSession();
		live.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		await live.setModelTemporary(manualModel, undefined, { preserveDefaultRole: true });
		settings.setModelRole("default", selectorOf(otherModel));
		await scheduler.wait(0);
		expect(selectorOf(live.model!)).toBe(selectorOf(manualModel));

		live.setPlanModeState(undefined);
		await live.setModelTemporary(roleModel, undefined, { preserveDefaultRole: true });
		await live.reapplyDefaultRoleModel();
		expect(selectorOf(live.model!)).toBe(selectorOf(otherModel));
	});

	it("does not replace an explicitly selected plan execution model on exit", async () => {
		const live = createSession();
		live.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		await live.setModelTemporary(manualModel, undefined, { preserveDefaultRole: true });
		settings.setModelRole("default", selectorOf(otherModel));
		await scheduler.wait(0);
		await live.setModel(roleModel);
		live.setPlanModeState(undefined);
		await live.reapplyDefaultRoleModel();
		settings.setModelRole("default", selectorOf(manualModel));
		await live.prompt("keep the chosen execution model");

		expect(selectorOf(live.model!)).toBe(selectorOf(roleModel));
	});
});
