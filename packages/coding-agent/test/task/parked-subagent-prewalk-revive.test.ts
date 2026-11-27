/**
 * A kept-alive subagent that handed off through prewalk and then parked must revive on
 * the handoff target, not on the model it was spawned with, and must not re-arm the
 * consumed handoff.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, setInteractiveHost } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const AGENT_ID = "HandedOff";
const MOCK_API_SOURCE = "test/parked-subagent-prewalk-revive";
const PLANNER = "mock-model";
const TARGET = "mock-handoff";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/** The mock carries no effort ladder; without one every configured effort clamps away. */
const thinking = { mode: "effort", efforts: [Effort.Medium, Effort.High] } as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let savedInteractiveHost: boolean;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedInteractiveHost = setInteractiveHost(false);
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prewalk-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	setInteractiveHost(savedInteractiveHost);
	await removeWithRetries(root);
});

it.each([false, true])(
	"revives a parked subagent on its prewalk handoff target, keeping its todo list and not re-arming (route-only=%s)",
	async routeOnly => {
		const cwd = path.join(root, "home", "work");
		const artifactsDir = path.join(root, "artifacts");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(artifactsDir, { recursive: true });

		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const row = getBundledModel("openrouter", "z-ai/glm-4.7");
		if (!row) throw new Error("Expected bundled OpenRouter model");
		const sourceSelector = routeOnly ? "openrouter/z-ai/glm-4.7@cerebras" : `mock/${PLANNER}`;
		const targetSelector = routeOnly ? "openrouter/z-ai/glm-4.7@sambanova" : `mock/${TARGET}`;
		const requests: Model[] = [];
		if (routeOnly) authStorage.keys.setRuntime("openrouter", "test-key");
		const planner = Object.assign(
			createMockModel({
				id: PLANNER,
				reasoning: true,
				handler: context => {
					if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
					if (
						routeOnly &&
						context.messages.some(message => message.role === "toolResult" && message.toolName === "write")
					) {
						return {
							content: [
								{ type: "toolCall", name: "yield", arguments: { type: "result", data: "not handed off" } },
							],
						};
					}
					if (!context.messages.some(message => message.role === "toolResult" && message.toolName === "todo")) {
						return {
							content: [
								{
									type: "toolCall",
									name: "todo",
									arguments: { op: "init", list: [{ phase: "Work", items: ["Write the file"] }] },
								},
							],
						};
					}
					return {
						content: [
							{
								type: "toolCall",
								name: "write",
								arguments: { path: path.join(cwd, "out.txt"), content: "done\n" },
							},
						],
					};
				},
			}),
			{ thinking },
		);
		const target = Object.assign(
			createMockModel({
				id: TARGET,
				reasoning: true,
				handler: context =>
					(context.tools ?? []).some(tool => tool.name === "yield")
						? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
						: { content: ["label"] },
			}),
			{ thinking },
		);
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [
			...(routeOnly ? [row] : [planner, target]),
			...catalogAvailable(kind).filter(
				model => !routeOnly || model.provider !== row.provider || model.id !== row.id,
			),
		]);
		if (routeOnly) {
			vi.spyOn(globalThis, "fetch").mockRejectedValue(
				new Error("Unexpected network request in routed prewalk fixture"),
			);
			const createSession = sdkModule.createAgentSession;
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				const result = await createSession(options);
				result.session.agent.streamFn = (model, context, streamOptions) => {
					if ((context.tools ?? []).some(tool => tool.name === "yield")) requests.push(model);
					const routed = model.compat as { openRouterRouting?: { only?: string[] } } | undefined;
					const mock = routed?.openRouterRouting?.only?.[0] === "sambanova" ? target : planner;
					return mock.stream(mock, context, streamOptions);
				};
				return result;
			});
		}

		try {
			const result = await runSubprocess({
				outputSchema: {},
				cwd,
				artifactsDir,
				agent: {
					name: "task",
					description: "test",
					systemPrompt: "test",
					tools: ["read", "write", "todo"],
					source: "bundled",
				},
				task: "write out.txt",
				index: 0,
				id: AGENT_ID,
				modelOverride: `${sourceSelector}:medium`,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"task.agentIdleTtlMs": 0,
					"task.agentPrewalk": { task: `${targetSelector}:${routeOnly ? "medium" : "high"}` },
					"async.enabled": false,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: { default: sourceSelector },
				}),
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			});
			expect(result.exitCode, JSON.stringify(result)).toBe(0);

			const handle = AgentRegistry.global().get(AGENT_ID)?.session;
			if (!handle) throw new Error("Expected a kept-alive subagent session");
			const live = localSession(handle);
			expect(live.model?.id).toBe(routeOnly ? row.id : TARGET);
			expect(live.configuredThinkingLevel()).toBe(routeOnly ? Effort.Medium : Effort.High);
			if (routeOnly) {
				expect(requests.map(model => model.compat)).toMatchObject([
					{ openRouterRouting: { only: ["cerebras"] } },
					{ openRouterRouting: { only: ["cerebras"] } },
					{ openRouterRouting: { only: ["sambanova"] } },
				]);
				expect(
					live.sessionManager.getSessionLocalModelChange(),
					JSON.stringify(live.sessionManager.getBranch().filter(entry => entry.type === "model_change")),
				).toMatchObject({
					model: targetSelector,
					role: "prewalk",
				});
			}

			await AgentLifecycleManager.global().park(AGENT_ID);
			const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));

			expect(revived.model?.id).toBe(routeOnly ? row.id : TARGET);
			expect(revived.configuredThinkingLevel()).toBe(routeOnly ? Effort.Medium : Effort.High);
			if (routeOnly) {
				expect(revived.model?.compat).toMatchObject({ openRouterRouting: { only: ["sambanova"] } });
				expect(revived.sessionManager.getSessionLocalModelChange()).toMatchObject({
					model: targetSelector,
					role: "prewalk",
				});
			}
			expect(revived.getPrewalkState()).toBeUndefined();
			expect(revived.getActiveToolNames()).toContain("todo");
		} finally {
			authStorage.close();
		}
	},
	30_000,
);

it("revives a parked per-call worker on its exact model, not on a session-local switch", async () => {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const [exact, switched] = [PLANNER, TARGET].map(id =>
		Object.assign(
			createMockModel({
				id,
				reasoning: true,
				handler: context =>
					(context.tools ?? []).some(tool => tool.name === "yield")
						? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
						: { content: ["label"] },
			}),
			{ thinking },
		),
	);
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [exact, switched, ...catalogAvailable(kind)]);
	vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockResolvedValue(undefined);
	// Both models are operator-approved, so only the revive's model choice can move the worker.
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.perCallModel": "on",
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: `mock/${PLANNER}`, review: `mock/${PLANNER}`, smol: `mock/${TARGET}` },
	});

	try {
		const result = await runSubprocess({
			outputSchema: {},
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "answer",
			index: 0,
			id: AGENT_ID,
			modelOverride: `mock/${PLANNER}:medium`,
			perCallModelGrants: { settings, agentName: "task", agentSource: "bundled" },
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);

		const handle = AgentRegistry.global().get(AGENT_ID)?.session;
		if (!handle) throw new Error("Expected a kept-alive subagent session");
		const live = localSession(handle);
		expect(live.model?.id).toBe(PLANNER);
		// A focused worker can still be switched by hand; that persists a session-local model change.
		await live.setModelTemporary(switched);
		expect(live.sessionManager.getSessionLocalModelChange()?.model).toBe(`mock/${TARGET}`);

		await AgentLifecycleManager.global().park(AGENT_ID);
		const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));

		expect(revived.model?.id).toBe(PLANNER);
		expect(revived.configuredThinkingLevel()).toBe(Effort.Medium);
	} finally {
		authStorage.close();
	}
}, 30_000);
