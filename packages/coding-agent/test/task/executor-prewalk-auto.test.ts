/**
 * `task.agentPrewalkAuto`: at spawn the native judge decides once whether the subagent
 * hands off at its first edit. The judge is the real TypeSafe client against a stubbed
 * `fetch`; the child is a real session on mock models.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, setInteractiveHost } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";

const MOCK_API_SOURCE = "test/executor-prewalk-auto";
const PLANNER = "mock-model";
const TARGET = "mock-handoff";
const ASSIGNMENT = "trace the sync engine, then fix the stale cursor";
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

type Route = "prewalk" | "primary" | "direct";

/** One tool-call response; the mock generates the call id. */
const call = (name: string, args: Record<string, unknown>): MockResponse => ({
	content: [{ type: "toolCall", name, arguments: args }],
});

/** Answer System One with `choice` at its calibrated probabilities, recording each judged state. */
function stubJudge(choice: Route, probabilities: Record<Route, number>): Array<Record<string, string>> {
	const states: Array<Record<string, string>> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (input, init) => {
			if (!String(input).endsWith("/v1/systemone") && !String(input).endsWith("/decisions"))
				throw new Error(`unexpected request: ${String(input)}`);
			const { state } = JSON.parse(String(init?.body)) as { state: Record<string, string> };
			states.push(state);
			const answer = { type: "choice", choice, probabilities, confidence: probabilities[choice] };
			const usage = { input_tokens: 8, output_tokens: 2 };
			return Response.json({ model: "jev", answers: { route: answer }, usage });
		}),
	);
	return states;
}

/** Ledger rows the auto-prewalk judgment billed, whichever outcome it chose. */
function autoPrewalkBills(ledger: Mock<SessionManager["appendModelUsage"]>): number {
	return ledger.mock.calls.filter(([usage]) => usage.purpose === "auto-prewalk").length;
}

/** Spawn the `task` agent on the planner and record which model served each child turn. */
async function spawn(routeOnly = false): Promise<{ exitCode: number; requests: string[] }> {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	authStorage.keys.setRuntime("typesafe", "ts-key");
	if (routeOnly) authStorage.keys.setRuntime("openrouter", "test-key");
	// Ambient provider keys must neither conjure another judge nor give the chain a candidate that reaches the network.
	const source = authStorage.keys.source.bind(authStorage.keys);
	vi.spyOn(authStorage.keys, "source").mockImplementation((provider, sourceOptions) =>
		provider === "mock" || provider === "typesafe" || (routeOnly && provider === "openrouter")
			? source(provider, sourceOptions)
			: undefined,
	);
	const modelRegistry = new ModelRegistry(authStorage);
	const requests: string[] = [];
	const row = getBundledModel("openrouter", "z-ai/glm-4.7");
	if (!row) throw new Error("Expected bundled OpenRouter model");
	const sourceSelector = routeOnly ? "openrouter/z-ai/glm-4.7@cerebras" : `mock/${PLANNER}`;
	const targetSelector = routeOnly ? "openrouter/z-ai/glm-4.7@sambanova" : `mock/${TARGET}`;
	const planner = Object.assign(
		createMockModel({
			id: PLANNER,
			reasoning: true,
			handler: context => {
				if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
				if (!routeOnly) requests.push(PLANNER);
				const hasTodo = (context.tools ?? []).some(tool => tool.name === "todo");
				const used = (name: string) =>
					context.messages.some(message => message.role === "toolResult" && message.toolName === name);
				// `todo` is stripped unless prewalk armed, so plan only when the tool exists.
				if (hasTodo && !used("todo")) {
					return call("todo", { op: "init", list: [{ phase: "Work", items: ["Write the file"] }] });
				}
				if (used("write")) return call("yield", { type: "result", data: "done" });
				return call("write", { path: path.join(cwd, "out.txt"), content: "done\n" });
			},
		}),
		{ thinking },
	);
	const target = Object.assign(
		createMockModel({
			id: TARGET,
			reasoning: true,
			handler: context => {
				if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
				if (!routeOnly) requests.push(TARGET);
				return call("yield", { type: "result", data: "done" });
			},
		}),
		{ thinking },
	);
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [
		...(routeOnly ? [row] : [planner, target]),
		...catalogAvailable(kind).filter(model => !routeOnly || model.provider !== row.provider || model.id !== row.id),
	]);
	if (routeOnly) {
		const createSession = sdkModule.createAgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const result = await createSession(options);
			result.session.agent.streamFn = (model, context, streamOptions) => {
				const routed = model.compat as { openRouterRouting?: { only?: string[] } } | undefined;
				const route = routed?.openRouterRouting?.only?.[0];
				if ((context.tools ?? []).some(tool => tool.name === "yield"))
					requests.push(`${model.provider}/${model.id}@${route}`);
				const mock = route === "sambanova" ? target : planner;
				return mock.stream(mock, context, streamOptions);
			};
			return result;
		});
	}

	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: {
				name: "task",
				description: "test",
				systemPrompt: "test",
				tools: ["read", "write", "todo"],
				source: "bundled",
			},
			task: ASSIGNMENT,
			assignment: ASSIGNMENT,
			index: 0,
			id: "Judged",
			outputSchema: {},
			modelOverride: `${sourceSelector}:medium`,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"task.agentPrewalkAuto": { task: `${targetSelector}:${routeOnly ? "medium" : "high"}` },
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: sourceSelector, judge: "typesafe/jev-1.14.0" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode, JSON.stringify(result)).toBe(0);
		return { exitCode: result.exitCode, requests };
	} finally {
		authStorage.close();
	}
}

describe("runSubprocess auto-prewalk through a real child session", () => {
	beforeEach(async () => {
		savedInteractiveHost = setInteractiveHost(false);
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prewalk-auto-spawn-"));
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

	it("hands off to the target after the first write when the judge picks prewalk", async () => {
		const judged = stubJudge("prewalk", { prewalk: 0.9, primary: 0.07, direct: 0.03 });
		const ledger = vi.spyOn(SessionManager.prototype, "appendModelUsage");
		const { exitCode, requests } = await spawn();
		expect(exitCode).toBe(0);
		expect(requests).toEqual([PLANNER, PLANNER, TARGET]);
		expect(judged).toHaveLength(1);
		expect(judged[0]!.request).toContain(ASSIGNMENT);
		expect(autoPrewalkBills(ledger)).toBe(1);
	}, 30_000);

	it("hands off a route-only subagent when the automatic judge picks prewalk", async () => {
		const judged = stubJudge("prewalk", { prewalk: 0.9, primary: 0.07, direct: 0.03 });
		const journal = vi.spyOn(SessionManager.prototype, "appendModelChange");

		const { exitCode, requests } = await spawn(true);

		expect(exitCode).toBe(0);
		expect(judged).toHaveLength(1);
		expect(requests).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			"openrouter/z-ai/glm-4.7@cerebras",
			"openrouter/z-ai/glm-4.7@sambanova",
		]);
		expect(
			journal.mock.calls.some(
				([model, role]) => model === "openrouter/z-ai/glm-4.7@sambanova" && role === "prewalk",
			),
		).toBe(true);
	}, 30_000);

	it("stays on the planning model when the judge picks primary", async () => {
		const judged = stubJudge("primary", { prewalk: 0.1, primary: 0.8, direct: 0.1 });
		const ledger = vi.spyOn(SessionManager.prototype, "appendModelUsage");
		const effortWrites = vi.spyOn(SessionManager.prototype, "appendThinkingLevelChange");
		const { exitCode, requests } = await spawn();
		expect(exitCode).toBe(0);
		expect(judged).toHaveLength(1);
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every(model => model === PLANNER)).toBe(true);
		// An unarmed judgment is still a billed judgment.
		expect(autoPrewalkBills(ledger)).toBe(1);
		// The billed judgment must not make the fresh child look resumed: the SDK still persists its starting effort.
		expect(effortWrites).toHaveBeenCalled();
	}, 30_000);
});
