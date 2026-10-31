import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { factoryDroidRegistry } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { assertPerCallModelApproved } from "@oh-my-pi/pi-coding-agent/task/model-approval";
import {
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };
import seanceAssignmentTemplate from "../../src/prompts/system/seance-assignment.md" with { type: "text" };
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import type { PreparedSeanceSession } from "@oh-my-pi/pi-coding-agent/task/seance";
import { seanceIsolationOptions } from "@oh-my-pi/pi-coding-agent/task/seance-policy";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, prompt, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

function preparedSourceSession(sourceFile: string, sourceSessionId: string): PreparedSeanceSession {
	return {
		fork: {
			sourceFile,
		},
		promptSuffix: model =>
			prompt.render(seanceAssignmentTemplate, {
				sourceSession: sourceSessionId,
				model: model ?? "",
			}),
	};
}

function sourceHeader(id: string, cwd: string, additionalDirectories: string[] = []) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-10-01T00:00:00.000Z",
		cwd,
		...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
	};
}

function unrestrictedSourceInit() {
	return {
		type: "session_init",
		id: "inherited-init",
		parentId: null,
		timestamp: "2026-10-01T00:00:01.000Z",
		systemPrompt: ["source-only startup contract"],
		task: "source task",
		tools: ["read", "write", "task"],
		agent: "task",
		spawns: "*",
	};
}

function sourceMessage() {
	return {
		type: "message",
		id: "source-user",
		parentId: null,
		timestamp: "2026-10-01T00:00:02.000Z",
		message: { role: "user", content: "historical source request", timestamp: 1 },
	};
}

async function writeSourceSession(file: string, cwd: string, additionalDirectories: string[] = []): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const text = [sourceHeader("source-session", cwd, additionalDirectories), unrestrictedSourceInit(), sourceMessage()]
		.map(entry => JSON.stringify(entry))
		.join("\n");
	await Bun.write(file, `${text}\n`);
	return text + "\n";
}

/** The executor's seance fork: the source transcript in place, no artifact copy. */
function forkSeance(sourceFile: string, cwd: string, sessionFile: string): Promise<SessionManager> {
	return SessionManager.forkFrom(sourceFile, cwd, undefined, undefined, {
		seance: true,
		suppressBreadcrumb: true,
		sessionFile,
		resetInheritedCost: true,
		repairInterruptedTail: true,
	});
}

function hostilePreparedExtension(onLoad: () => void): PreparedExtension {
	return {
		path: "/fixture/hostile-seance-extension.ts",
		resolvedPath: "/fixture/hostile-seance-extension.ts",
		factory: () => onLoad(),
		error: null,
	};
}

function revivalParent(cwd: string, preparedExtensions: PreparedExtension[]): AgentSession {
	return {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		effectiveExtensionRoots: {
			explicit: ["/fixture/hostile-seance-extension.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		},
		preparedExtensions,
	} as unknown as AgentSession;
}

const MODEL_GATE_API_SOURCE = "seance-runtime-model-gate-test";

async function modelGateFixture(root: string, settingsOverrides: Record<string, unknown> = {}) {
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd, { recursive: true });
	const approved = createMockModel({
		id: "approved-seance-model",
		handler: () => ({ content: ["Approved historical answer."] }),
	});
	const unapproved = createMockModel({
		id: "unapproved-seance-model",
		handler: () => ({ content: ["Unapproved historical answer."] }),
	});
	const models: MockModel[] = [approved, unapproved];
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "credentialed-but-not-approved");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(models);
	vi.spyOn(modelRegistry, "getAvailableForProviders").mockReturnValue(models);
	vi.spyOn(modelRegistry, "getAll").mockReturnValue(models);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		models.find(model => model.provider === provider && model.id === id),
	);
	const sourceFile = path.join(root, "source.jsonl");
	const sourceText = `${[
		sourceHeader("source-session", cwd),
		{
			type: "model_change",
			id: "default-model",
			parentId: null,
			timestamp: "2026-10-01T00:00:01.000Z",
			model: `mock/${approved.id}`,
			role: "default",
		},
		{
			type: "model_change",
			id: "active-model",
			parentId: "default-model",
			timestamp: "2026-10-01T00:00:02.000Z",
			model: `mock/${unapproved.id}`,
			role: "fast",
		},
		{ ...sourceMessage(), parentId: "active-model" },
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
	await Bun.write(sourceFile, sourceText);
	const seance = getBundledAgent("seance");
	if (!seance) throw new Error("Expected the bundled seance agent");
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [seance], projectAgentsDir: null });
	const settings = Settings.isolated({
		"task.perCallModel": "on",
		"task.maxRecursionDepth": 2,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		modelRoles: { review: `mock/${approved.id}` },
		...settingsOverrides,
	});
	const session = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		getApiKey: async () => "credentialed-but-not-approved",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
	} as unknown as ToolSession;
	return { session, authStorage, modelRegistry, sourceFile, sourceText, approved, unapproved };
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("model-facing seance model approval", () => {
	it("rejects an unapproved credentialed explicit model before dispatching a seance", async () => {
		using tempDir = TempDir.createSync("@omp-seance-unapproved-model-");
		const fixture = await modelGateFixture(tempDir.path());
		try {
			expect(fixture.modelRegistry.hasConfiguredAuth(fixture.unapproved)).toBe(true);
			await expect(
				runStructuredSubagent({
					session: fixture.session,
					invocationKind: "task",
					agent: "seance",
					assignment: "Read the historical request.",
					sourceSession: fixture.sourceFile,
					seanceModel: `mock/${fixture.unapproved.id}`,
					structured: false,
					keepAlive: false,
				}),
			).rejects.toThrow(/not approved.*Catalog or credentials alone/i);
			expect(fixture.unapproved.calls).toHaveLength(0);
			expect(await Bun.file(fixture.sourceFile).text()).toBe(fixture.sourceText);
		} finally {
			fixture.authStorage.close();
		}
	});

	it.each([
		{ allow: "mock/approved-seance-model", approved: true },
		{ allow: "@review", approved: true },
		{ allow: "mock/approved-*", approved: true },
		{ allow: "mock/APPROVED-SEANCE-MODEL", approved: false },
		{ allow: "approved-seance-model", approved: false },
		{ allow: "mock/approved-seance-model:high", approved: false },
	])("narrows saved and explicit seance models with the same allowlist entry $allow", async ({ allow, approved }) => {
		using tempDir = TempDir.createSync("@omp-seance-allowlist-");
		const fixture = await modelGateFixture(tempDir.path(), {
			modelRoles: { review: "approved-seance-model" },
			"task.perCallModelAllow": [allow],
		});
		try {
			for (const seanceModel of [undefined, `mock/${fixture.approved.id}`, "@review", ["@review"]]) {
				const policy = resolveEffectiveSubagentPolicy({
					session: fixture.session,
					invocationKind: "task",
					agent: "seance",
					assignment: "Read the historical request.",
					sourceSession: fixture.sourceFile,
					seanceModel,
				});
				if (approved) {
					const resolved = await policy;
					expect(resolved.modelOverride).toEqual([`mock/${fixture.approved.id}`]);
					expect(resolved.perCallModelGrants).toBeDefined();
				} else {
					await expect(policy).rejects.toThrow(/approved/);
				}
			}
			expect(fixture.approved.calls).toHaveLength(0);
			expect(fixture.unapproved.calls).toHaveLength(0);
			expect(await Bun.file(fixture.sourceFile).text()).toBe(fixture.sourceText);
		} finally {
			fixture.authStorage.close();
		}
	});

	it("skips an unapproved saved active model and dispatches the approved saved default with per-call models off", async () => {
		using tempDir = TempDir.createSync("@omp-seance-approved-default-");
		const fixture = await modelGateFixture(tempDir.path(), { "task.perCallModel": "off" });
		registerMockApi(MODEL_GATE_API_SOURCE);
		try {
			const execution = await runStructuredSubagent({
				session: fixture.session,
				invocationKind: "task",
				agent: "seance",
				assignment: "Read the historical request.",
				sourceSession: fixture.sourceFile,
				structured: false,
				identity: { id: "ApprovedSavedSeance" },
				keepAlive: false,
			});
			expect(execution.result.exitCode).toBe(0);
			expect(execution.result.output).toContain("Approved historical answer.");
			expect(execution.result.resolvedModel).toBe(`mock/${fixture.approved.id}`);
			expect(fixture.approved.calls).toHaveLength(1);
			expect(fixture.unapproved.calls).toHaveLength(0);
			expect(await Bun.file(fixture.sourceFile).text()).toBe(fixture.sourceText);
		} finally {
			unregisterCustomApis(MODEL_GATE_API_SOURCE);
			fixture.authStorage.close();
		}
	});

	it("uses the host's grant authority and snapshots saved-model match preferences, not derived roles", async () => {
		using tempDir = TempDir.createSync("@omp-seance-grant-authority-");
		const fixture = await modelGateFixture(tempDir.path(), { "task.perCallModel": "off" });
		const usageOrder = [`mock/${fixture.approved.id}`, `mock/${fixture.unapproved.id}`];
		const host = fixture.session.settings.overlay({ modelRoles: { review: "seance-model" } });
		vi.spyOn(host.grantAuthority(), "getStorage").mockReturnValue({
			getModelUsageOrder: () => usageOrder,
		} as AgentStorage);
		fixture.session.settings = host.overlay(
			{ modelRoles: { review: `mock/${fixture.unapproved.id}` } },
			{ derived: true },
		);
		try {
			const policy = await resolveEffectiveSubagentPolicy({
				session: fixture.session,
				invocationKind: "task",
				agent: "seance",
				assignment: "Read the historical request.",
				sourceSession: fixture.sourceFile,
			});
			expect(policy.modelOverride).toEqual([`mock/${fixture.approved.id}`]);
			const grants = policy.perCallModelGrants;
			if (!grants) throw new Error("Expected saved-model grants");
			expect(grants.matchPreferences?.usageOrder).toEqual(usageOrder);
			usageOrder.reverse();
			expect(grants.matchPreferences?.usageOrder).not.toEqual(usageOrder);
			expect(assertPerCallModelApproved(fixture.approved, grants, fixture.modelRegistry)).toBeUndefined();
			expect(() => assertPerCallModelApproved(fixture.unapproved, grants, fixture.modelRegistry)).toThrow(
				/not approved/,
			);
			host.setModelRole("review", "mock/operator-only-model");
			expect(() => assertPerCallModelApproved(fixture.approved, grants, fixture.modelRegistry)).toThrow(
				/not approved/,
			);
		} finally {
			fixture.authStorage.close();
		}
	});

	it.each([{ only: ["anthropic", "google-vertex"] }, { order: ["anthropic", "google-vertex"] }])(
		"does not approve saved or explicit seance models from a parent routed by %j",
		async routing => {
			using tempDir = TempDir.createSync("@omp-seance-routed-parent-");
			const fixture = await modelGateFixture(tempDir.path(), { modelRoles: {} });
			const parentModel = buildModel({
				...fixture.approved,
				api: "openai-completions",
				compat: {
					openRouterRouting: routing.only ? { only: [...routing.only] } : { order: [...routing.order] },
				},
			});
			fixture.session.getActiveModel = () => parentModel;
			fixture.session.getActiveModelString = () => `mock/${fixture.approved.id}`;
			const policy = (seanceModel?: string) =>
				resolveEffectiveSubagentPolicy({
					session: fixture.session,
					invocationKind: "task",
					agent: "seance",
					assignment: "Read the historical request.",
					sourceSession: fixture.sourceFile,
					seanceModel,
				});
			try {
				await expect(policy()).rejects.toThrow(/No approved saved model/);
				await expect(policy(`mock/${fixture.approved.id}`)).rejects.toThrow(/not approved/);
			} finally {
				fixture.authStorage.close();
			}
		},
	);

	it("approves saved and explicit Factory models with server-side fallback now that the per-call request omits the chain", async () => {
		using tempDir = TempDir.createSync("@omp-seance-factory-fallback-");
		const fixture = await modelGateFixture(tempDir.path(), {
			modelRoles: { review: "factory-droid/claude-fable-5", smol: "factory-droid/claude-opus-5" },
		});
		const models = ["claude-fable-5", "claude-opus-5"].map(id =>
			buildModel(
				buildFactoryDroidModel(
					factoryDroidRegistry().find(entry => entry.spec.id === id)!,
					{
						apiProviders: ["anthropic"],
					},
				),
			),
		);
		vi.spyOn(fixture.modelRegistry, "getAvailable").mockReturnValue(models);
		vi.spyOn(fixture.modelRegistry, "getAll").mockReturnValue(models);
		vi.spyOn(fixture.modelRegistry, "find").mockImplementation((provider, id) =>
			models.find(model => model.provider === provider && model.id === id),
		);
		fixture.authStorage.keys.setRuntime("factory-droid", "credentialed");
		await Bun.write(
			fixture.sourceFile,
			`${[
				sourceHeader("source-session", fixture.session.cwd),
				{
					type: "model_change",
					id: "factory-model",
					parentId: null,
					timestamp: "2026-10-01T00:00:01.000Z",
					model: "factory-droid/claude-fable-5",
					role: "default",
				},
				{ ...sourceMessage(), parentId: "factory-model" },
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const policy = (seanceModel?: string, model?: string[]) =>
			resolveEffectiveSubagentPolicy({
				session: fixture.session,
				invocationKind: "task",
				agent: "seance",
				assignment: "Read the historical request.",
				sourceSession: fixture.sourceFile,
				seanceModel,
				model,
			});
		try {
			const savedPolicy = await policy();
			expect(savedPolicy.modelOverride).toEqual(["factory-droid/claude-fable-5"]);
			const explicitPolicy = await policy("factory-droid/claude-fable-5");
			expect(explicitPolicy.modelOverride).toEqual(["factory-droid/claude-fable-5"]);
			expect(explicitPolicy.perCallModelGrants).toBeDefined();
			const hostPolicy = await policy(undefined, []);
			expect(hostPolicy.perCallModelGrants).toBeUndefined();
			expect(hostPolicy.modelOverride).toEqual(["factory-droid/claude-fable-5"]);
		} finally {
			fixture.authStorage.close();
		}
	});

	it("stops and reports when no saved seance model is approved even with a configured override", async () => {
		using tempDir = TempDir.createSync("@omp-seance-no-approved-saved-");
		const fixture = await modelGateFixture(tempDir.path(), {
			"task.agentModelOverrides": { seance: "mock/unapproved-seance-model" },
		});
		fixture.session.settings.setModelRole("review", "mock/operator-only-model");
		try {
			await expect(
				runStructuredSubagent({
					session: fixture.session,
					invocationKind: "task",
					agent: "seance",
					assignment: "Read the historical request.",
					sourceSession: fixture.sourceFile,
					structured: false,
					keepAlive: false,
				}),
			).rejects.toMatchObject({
				kind: "preflight",
				message: expect.stringMatching(/approved saved.*Stop and report/i),
			});
			expect(fixture.approved.calls).toHaveLength(0);
			expect(fixture.unapproved.calls).toHaveLength(0);
			expect(await Bun.file(fixture.sourceFile).text()).toBe(fixture.sourceText);
		} finally {
			fixture.authStorage.close();
		}
	});

	it.each(["exact", "role", "candidate list"] as const)(
		"dispatches an approved explicit seance model via %s",
		async kind => {
			using tempDir = TempDir.createSync("@omp-seance-approved-explicit-");
			const fixture = await modelGateFixture(tempDir.path());
			registerMockApi(MODEL_GATE_API_SOURCE);
			const seanceModel =
				kind === "exact"
					? `mock/${fixture.approved.id}`
					: kind === "role"
						? "@review"
						: ["missing-provider/missing-model", "@review"];
			try {
				const execution = await runStructuredSubagent({
					session: fixture.session,
					invocationKind: "task",
					agent: "seance",
					assignment: "Read the historical request.",
					sourceSession: fixture.sourceFile,
					seanceModel,
					structured: false,
					identity: { id: "ApprovedExplicitSeance" },
					keepAlive: false,
				});
				expect(execution.result.exitCode).toBe(0);
				expect(execution.result.output).toContain("Approved historical answer.");
				expect(execution.result.resolvedModel).toBe(`mock/${fixture.approved.id}`);
				expect(fixture.approved.calls).toHaveLength(1);
				expect(fixture.unapproved.calls).toHaveLength(0);
			} finally {
				unregisterCustomApis(MODEL_GATE_API_SOURCE);
				fixture.authStorage.close();
			}
		},
	);

	it("expands explicit seance roles and lists before approving authenticated candidates", async () => {
		using tempDir = TempDir.createSync("@omp-seance-role-candidates-");
		const fixture = await modelGateFixture(tempDir.path(), {
			modelRoles: {
				review: "missing-provider/missing-model,mock/unapproved-seance-model,mock/approved-seance-model",
			},
			"task.agentModelOverrides": { seance: "mock/unapproved-seance-model" },
		});
		vi.spyOn(fixture.modelRegistry, "hasConfiguredAuth").mockImplementation(
			model => model.id === fixture.approved.id,
		);
		const policy = (seanceModel: string | string[]) =>
			resolveEffectiveSubagentPolicy({
				session: fixture.session,
				invocationKind: "task",
				agent: "seance",
				assignment: "Read the historical request.",
				sourceSession: fixture.sourceFile,
				seanceModel,
			});
		try {
			const role = await policy("@review:high");
			expect(role.modelOverride).toEqual([`mock/${fixture.approved.id}:high`]);
			expect(role.modelRole).toBe("review");
			expect(role.perCallModelGrants).toBeDefined();
			const inherited = await policy("@review:inherit");
			expect(inherited.modelOverride).toEqual([`mock/${fixture.approved.id}:inherit`]);
			const list = await policy([
				"missing-provider/missing-model",
				"@review:low",
				`mock/${fixture.approved.id}:high`,
			]);
			expect(list.modelOverride).toEqual([`mock/${fixture.approved.id}:low`, `mock/${fixture.approved.id}:high`]);
			expect(list.modelRole).toBeUndefined();
			expect(list.perCallModelGrants).toBeDefined();
			expect(await Bun.file(fixture.sourceFile).text()).toBe(fixture.sourceText);
		} finally {
			fixture.authStorage.close();
		}
	});

	it("approves explicit and saved seance models by routed identity and keeps their upstream pin through preflight", async () => {
		using tempDir = TempDir.createSync("@omp-seance-routed-model-");
		const pinnedGrant = "openrouter/anthropic/claude-sonnet-4.5@anthropic";
		const fixture = await modelGateFixture(tempDir.path(), { modelRoles: { review: pinnedGrant } });
		const routed = buildModel({
			id: "anthropic/claude-sonnet-4.5",
			name: "anthropic/claude-sonnet-4.5",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});
		const models = [fixture.approved, fixture.unapproved, routed];
		vi.spyOn(fixture.modelRegistry, "getAvailable").mockReturnValue(models);
		vi.spyOn(fixture.modelRegistry, "getAll").mockReturnValue(models);
		vi.spyOn(fixture.modelRegistry, "find").mockImplementation((provider, id) =>
			models.find(model => model.provider === provider && model.id === id),
		);
		fixture.authStorage.keys.setRuntime("openrouter", "credentialed");
		const policy = (seanceModel?: string) =>
			resolveEffectiveSubagentPolicy({
				session: fixture.session,
				invocationKind: "task",
				agent: "seance",
				assignment: "Read the historical request.",
				sourceSession: fixture.sourceFile,
				seanceModel,
			});
		try {
			// A pinned grant approves only its route, never the unpinned model.
			await expect(policy("openrouter/anthropic/claude-sonnet-4.5")).rejects.toThrow(/not approved/);
			const pinned = await policy(pinnedGrant);
			expect(pinned.modelOverride).toEqual([pinnedGrant]);
			expect(pinned.perCallModelGrants).toBeDefined();
			await Bun.write(
				fixture.sourceFile,
				`${[
					sourceHeader("source-session", fixture.session.cwd),
					{
						type: "model_change",
						id: "pinned-model",
						parentId: null,
						timestamp: "2026-10-01T00:00:01.000Z",
						model: pinnedGrant,
						role: "default",
					},
					{ ...sourceMessage(), parentId: "pinned-model" },
				]
					.map(entry => JSON.stringify(entry))
					.join("\n")}\n`,
			);
			const saved = await policy();
			expect(saved.modelOverride).toEqual([pinnedGrant]);
			expect(saved.perCallModelGrants).toBeDefined();
		} finally {
			fixture.authStorage.close();
		}
	});

	it("refuses the first seance provider request after the operator revokes approval during startup", async () => {
		using tempDir = TempDir.createSync("@omp-seance-revoked-model-");
		const fixture = await modelGateFixture(tempDir.path());
		const eventBus = new EventBus();
		fixture.session.eventBus = eventBus;
		let reachedStartedBoundary = false;
		const unsubscribe = eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			if (
				!payload ||
				typeof payload !== "object" ||
				!("id" in payload) ||
				payload.id !== "RevokedSeance" ||
				!("status" in payload) ||
				payload.status !== "started"
			) {
				return;
			}
			reachedStartedBoundary = true;
			fixture.session.settings.setModelRole("review", "mock/operator-only-model");
		});
		registerMockApi(MODEL_GATE_API_SOURCE);
		try {
			const execution = await runStructuredSubagent({
				session: fixture.session,
				invocationKind: "task",
				agent: "seance",
				assignment: "Read the historical request.",
				sourceSession: fixture.sourceFile,
				seanceModel: `mock/${fixture.approved.id}`,
				structured: false,
				identity: { id: "RevokedSeance" },
				keepAlive: false,
			});
			expect(reachedStartedBoundary).toBe(true);
			expect(execution.result.exitCode).not.toBe(0);
			expect(`${execution.result.error ?? ""}${execution.result.stderr}${execution.result.output}`).toMatch(
				/not approved/,
			);
			expect(fixture.approved.calls).toHaveLength(0);
			expect(fixture.unapproved.calls).toHaveLength(0);
		} finally {
			unsubscribe();
			unregisterCustomApis(MODEL_GATE_API_SOURCE);
			fixture.authStorage.close();
		}
	});
});

describe("seance startup contracts", () => {
	it("builds a fresh SDK session with only historical tools and no extensions or outbound IRC", async () => {
		using tempDir = TempDir.createSync("@omp-seance-sdk-fresh-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceRoot = path.join(tempDir.path(), "source-additional");
		const settingsRoot = path.join(tempDir.path(), "settings-additional");
		await Promise.all([sourceRoot, settingsRoot].map(directory => fs.mkdir(directory, { recursive: true })));
		const markerNames = ["cwd-tree-leak.txt", "source-root-tree-leak.txt", "settings-root-tree-leak.txt"];
		await Promise.all(
			[
				path.join(cwd, markerNames[0]),
				path.join(sourceRoot, markerNames[1]),
				path.join(settingsRoot, markerNames[2]),
			].map(file => Bun.write(file, "must not be discovered")),
		);
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		const sourceText = await writeSourceSession(sourceFile, cwd, [sourceRoot]);
		const forked = await forkSeance(sourceFile, cwd, path.join(tempDir.path(), "forks", "seance.jsonl"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const extensionPath = path.join(tempDir.path(), "hostile-extension.ts");
		const extensionMarker = path.join(tempDir.path(), "extension-loaded.txt");
		const extensionSource = [
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(extensionMarker)}, "loaded");`,
			"export default api => {",
			"  api.registerTool({",
			'    name: "hostile_extension",',
			'    label: "Hostile",',
			'    description: "Should not load",',
			"    parameters: api.arktype({}),",
			'    execute: async () => ({ content: [{ type: "text", text: "loaded" }] }),',
			"  });",
			"};",
		].join("\n");
		await Bun.write(extensionPath, extensionSource);
		let session: AgentSession | undefined;
		try {
			const parentCapabilities = { enableIrc: true, enableMCP: true };
			const created = await createAgentSession({
				cwd,
				agentDir: path.join(tempDir.path(), "agent"),
				authStorage,
				modelRegistry,
				model,
				settings: Settings.isolated({
					"workspace.additionalDirectories": [settingsRoot],
					includeWorkspaceTree: true,
				}),
				sessionManager: forked,
				agentName: "seance",
				toolNames: ["read", "grep", "glob"],
				requireYieldTool: true,
				...parentCapabilities,
				...seanceIsolationOptions(cwd),
				preloadedExtensionPaths: [extensionPath],
			});
			session = created.session;
			expect(created.session.sessionManager.getAdditionalDirectories()).toEqual([]);
			const startupPrompt = created.session.systemPrompt.join("\n");
			for (const markerName of markerNames) expect(startupPrompt).not.toContain(markerName);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);

			expect(created.session.getActiveToolNames().toSorted()).toEqual(["glob", "grep", "read", "yield"]);
			expect(await Bun.file(extensionMarker).exists()).toBe(false);
		} finally {
			try {
				if (session) await session.dispose();
				else await forked.close();
			} finally {
				authStorage.close();
			}
		}
	});

	it("drops a failed pre-ready source fork without loading parent extensions or changing the source", async () => {
		using tempDir = TempDir.createSync("@omp-seance-fresh-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		const sourceText = await writeSourceSession(sourceFile, cwd);
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const controller = new AbortController();
		const eventBus = new EventBus();
		const id = "SeanceStartup";
		let reachedStartedBoundary = false;
		let extensionLoaded = false;
		let extensionRootsRead = false;

		try {
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
				if (
					!payload ||
					typeof payload !== "object" ||
					!("id" in payload) ||
					payload.id !== id ||
					!("status" in payload) ||
					payload.status !== "started"
				) {
					return;
				}
				reachedStartedBoundary = true;
				controller.abort();
			});
			const extension = hostilePreparedExtension(() => {
				extensionLoaded = true;
			});
			await runSubprocess({
				cwd,
				agent,
				task: "Read the source transcript.",
				assignment: "Consult only the saved source history.",
				index: 0,
				id,
				settings: Settings.isolated(),
				modelRegistry,
				modelOverride: ["anthropic/claude-sonnet-4-5"],
				preparedSession: preparedSourceSession(sourceFile, "source-session"),
				artifactsDir,
				preloadedPreparedExtensions: [extension],
				extensionRoots: () => {
					extensionRootsRead = true;
					return {
						explicit: [],
						mode: "merge",
						configured: [],
						configuredLevel: "user",
					};
				},
				enableIrc: true,
				signal: controller.signal,
				eventBus,
			});

			const forkFile = path.join(artifactsDir, `${id}.jsonl`);
			expect(reachedStartedBoundary).toBe(true);
			expect(await Bun.file(forkFile).exists()).toBe(false);
			expect(extensionLoaded).toBe(false);
			expect(extensionRootsRead).toBe(false);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
		} finally {
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});

	it("cold-revives the full persisted runtime prompt and retains restricted tools", async () => {
		using tempDir = TempDir.createSync("@omp-seance-cold-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceRoot = path.join(tempDir.path(), "source-additional");
		const settingsRoot = path.join(tempDir.path(), "settings-additional");
		await Promise.all([sourceRoot, settingsRoot].map(directory => fs.mkdir(directory, { recursive: true })));
		const markerNames = ["cold-cwd-tree-leak.txt", "cold-source-tree-leak.txt", "cold-settings-tree-leak.txt"];
		await Promise.all(
			[
				path.join(cwd, markerNames[0]),
				path.join(sourceRoot, markerNames[1]),
				path.join(settingsRoot, markerNames[2]),
			].map(file => Bun.write(file, "must not be discovered")),
		);
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		const sourceText = await writeSourceSession(sourceFile, cwd, [sourceRoot]);
		const forked = await forkSeance(sourceFile, cwd, path.join(tempDir.path(), "forks", "seance.jsonl"));
		const sessionFile = forked.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted fork");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const seanceSettings = Settings.isolated({
			"workspace.additionalDirectories": [settingsRoot],
			includeWorkspaceTree: true,
		});
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		let liveSession: AgentSession | undefined;
		let revived: AgentSession | undefined;
		let forkManagerClosed = false;
		try {
			const seanceAgent = getBundledAgent("seance");
			if (!seanceAgent) throw new Error("Expected the bundled seance agent");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5");
			const resolvedModel = `${model.provider}/${model.id}`;
			const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
				agent: seanceAgent.systemPrompt,
				context: "",
				planReference: "",
				planReferencePath: "",
				worktree: "",
				outputSchema: undefined,
				outputSchemaOverridesAgent: false,
				workPoolYieldItems: [],
				ircPeers: [],
				ircParkedCount: 0,
				ircOmittedCount: 0,
				ircSelfId: "",
			});
			const assignmentPrompt = prompt.render(seanceAssignmentTemplate, {
				sourceSession: "source-session",
				model: resolvedModel,
			});
			let defaultPromptBlocks: string[] = [];
			const live = await createAgentSession({
				cwd,
				agentDir: path.join(tempDir.path(), "agent"),
				authStorage,
				modelRegistry,
				model,
				settings: seanceSettings,
				sessionManager: forked,
				agentId: "SeanceCold",
				agentDisplayName: "seance",
				agentName: "seance",
				taskDepth: 1,
				toolNames: ["read", "grep", "glob"],
				requireYieldTool: true,
				...seanceIsolationOptions(cwd),
				systemPrompt: defaultPrompt => {
					defaultPromptBlocks = [...defaultPrompt];
					return [...defaultPrompt, subagentPrompt, assignmentPrompt];
				},
			});
			liveSession = live.session;
			expect(liveSession.sessionManager.getAdditionalDirectories()).toEqual([]);
			const persistedTools = liveSession.getEnabledToolNames().filter(name => name !== "write");
			liveSession.sessionManager.appendSessionInit({
				systemPrompt: liveSession.agent.state.systemPrompt,
				task: "Read the source transcript.",
				tools: persistedTools,
				agent: "seance",
				resolvedModel,
				restrictToolNames: true,
				spawns: "",
			});
			await liveSession.sessionManager.ensureOnDisk();
			const warmPrompt = [...liveSession.systemPrompt];
			for (const markerName of markerNames) expect(warmPrompt.join("\n")).not.toContain(markerName);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
			const warmToolNames = liveSession.getActiveToolNames().toSorted();
			const persisted = await SessionManager.peekSessionInit(sessionFile);
			if (!persisted?.init) throw new Error("Expected the fresh seance runtime contract to be persisted");
			expect(warmPrompt).toEqual([...defaultPromptBlocks, subagentPrompt, assignmentPrompt]);
			expect(persisted.init.systemPrompt).toEqual(warmPrompt);
			expect(persisted.init.tools.toSorted()).toEqual(warmToolNames);
			expect(persisted.init.systemPrompt.join("\n")).not.toContain("source-only startup contract");
			await liveSession.dispose();
			liveSession = undefined;
			forkManagerClosed = true;

			let extensionLoaded = false;
			const extension = hostilePreparedExtension(() => {
				extensionLoaded = true;
			});
			const ref = AgentRegistry.global().register({
				id: "SeanceCold",
				displayName: "seance",
				kind: "sub",
				parentId: "Main",
				status: "parked",
				session: null,
				sessionFile,
			});
			const createReviver = createPersistedSubagentReviverFactory({
				session: revivalParent(cwd, [extension]),
				authStorage,
				modelRegistry,
				settings: seanceSettings,
				enableLsp: true,
			});
			const revive = await createReviver(ref);
			if (!revive) throw new Error("Expected a cold seance reviver");
			revived = await revive(ref);
			expect(revived.sessionManager.getAdditionalDirectories()).toEqual([]);

			expect(revived.systemPrompt).toEqual(warmPrompt);
			for (const markerName of markerNames) expect(revived.systemPrompt.join("\n")).not.toContain(markerName);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
			expect(warmToolNames).toEqual(["glob", "grep", "read", "yield"]);
			expect(revived.getActiveToolNames().toSorted()).toEqual(warmToolNames);
			expect(extensionLoaded).toBe(false);
		} finally {
			try {
				await revived?.dispose();
			} finally {
				try {
					if (liveSession) await liveSession.dispose();
					else if (!forkManagerClosed) await forked.close();
				} finally {
					authStorage.close();
					setAgentDir(previousAgentDir);
				}
			}
		}
	});

	it("does not offer a cold reviver when startup failed after forking but before its restricted init", async () => {
		using tempDir = TempDir.createSync("@omp-seance-failed-start-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		await writeSourceSession(sourceFile, cwd);
		const forked = await forkSeance(sourceFile, cwd, path.join(tempDir.path(), "forks", "seance.jsonl"));
		const sessionFile = forked.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted fork");
		await forked.close();
		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek).toMatchObject({ seanceSource: path.resolve(sourceFile), init: null });

		const createReviver = createPersistedSubagentReviverFactory({
			session: revivalParent(cwd, []),
			authStorage: {} as AuthStorage,
			modelRegistry: {} as ModelRegistry,
			settings: Settings.isolated(),
			enableLsp: false,
		});
		const reviver = await createReviver({
			id: "FailedSeance",
			displayName: "seance",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
			createdAt: 0,
			lastActivity: 0,
		});
		expect(reviver).toBeUndefined();
	});
});
