/**
 * A subagent is reachable as soon as its session attaches to the registry, before the executor
 * finishes startup and dispatches the assignment (#17587), and between a follow-up turn taking
 * the idle session and sending its message. A message delivered in either window, on any path,
 * must neither fail the turn nor take the turn its task owns: it waits and reaches the model
 * after the task text, exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "EarlyMessage";
const BODY = "which files do you own?";
const ASSIGNMENT = "Target: src/gate.ts. Change: add the ownership gate.";
const FOLLOW_UP = "Also gate src/mask.ts the same way.";
const MOCK_API_SOURCE = "test/subagent-message-before-assignment";
const BACKGROUND_KIND = "test-background-delivery";
const AGENT: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

/** The text the model is sent for `message`. */
function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-message-before-assignment-"));
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
	await removeWithRetries(root);
});

interface Delivery {
	label: string;
	/**
	 * `"task"`: the message rides the task's own first request, after the task text. `"later"`:
	 * a later turn takes it — a peer's IRC message keeps a turn of its own after the run, and a
	 * background delivery reaches the run at a step boundary or right after it, as it does when
	 * it lands mid-run.
	 */
	reaches: "task" | "later";
	/** Only the spawn window: the RPC host reaches only a subagent whose run is in progress. */
	spawnOnly?: boolean;
	deliver(session: AgentSession): Promise<unknown>;
}

const deliveries: Delivery[] = [
	{
		// `write agent://<id>` from the parent reaches the session through the IRC bus.
		label: "the parent's IRC message",
		reaches: "task",
		deliver: session =>
			session.deliverIrcMessage({ id: "early", from: MAIN_AGENT_ID, to: AGENT_ID, body: BODY, ts: 1 }),
	},
	{
		label: "a peer's IRC message",
		reaches: "later",
		deliver: session =>
			session.deliverIrcMessage({ id: "early", from: "SiblingScout", to: AGENT_ID, body: BODY, ts: 1 }),
	},
	{
		label: "an RPC steer_subagent",
		reaches: "task",
		spawnOnly: true,
		deliver: async () => {
			const sessionFile = AgentRegistry.global().get(AGENT_ID)?.sessionFile ?? undefined;
			const roster = {
				getSubagents: () => [
					{
						id: AGENT_ID,
						index: 0,
						agent: "task",
						agentSource: "bundled" as const,
						status: "running" as const,
						sessionFile,
						lastUpdate: Date.now(),
					},
				],
			};
			const refused = await handleRpcSteerSubagent(roster, AGENT_ID, BODY);
			if (refused) throw new Error(refused);
		},
	},
	{
		// The focused-subagent chat sends the message this way.
		label: "a chat message to the focused subagent",
		reaches: "task",
		deliver: session => session.prompt(BODY, { streamingBehavior: "steer" }),
	},
	{
		// A skill command typed into the focused subagent.
		label: "a custom-message prompt",
		reaches: "task",
		deliver: session =>
			session.promptCustomMessage(
				{ customType: "test-skill", content: BODY, display: true, attribution: "user" },
				{ streamingBehavior: "steer" },
			),
	},
	{
		// An extension's `pi.sendMessage(..., { triggerTurn: true })`, as a messaging plugin delivers.
		label: "an extension message that triggers a turn",
		reaches: "task",
		deliver: session =>
			session.sendCustomMessage({ customType: "test-plugin", content: BODY, display: true }, { triggerTurn: true }),
	},
	{
		// An extension's `pi.sendUserMessage(...)`.
		label: "an extension user message",
		reaches: "task",
		deliver: session => session.sendUserMessage(BODY),
	},
	{
		// Background deliveries (async results, MCP notifications, late diagnostics) share the yield queue.
		label: "a background delivery",
		reaches: "later",
		deliver: async session => {
			session.yieldQueue.register<string>(BACKGROUND_KIND, {
				build: entries => ({
					role: "custom",
					customType: BACKGROUND_KIND,
					content: entries.join("\n"),
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			});
			session.yieldQueue.enqueue(BACKGROUND_KIND, BODY);
			// The idle flush runs as a post-prompt task; let it settle before the window closes.
			await session.waitForIdle();
		},
	},
];

/** Per request of the phase under test: where the phase's task text and the message sit. */
interface Request {
	taskAt: number;
	bodyAt: number;
}

interface Harness {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	cwd: string;
	artifactsDir: string;
	/** Requests since the current phase began. */
	requests: Request[];
	/** Starts a phase: requests are measured against `task` from here on. */
	beginPhase(task: string): void;
	/** Resolves once a request of the current phase carries the message. */
	bodySeen(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	let task = ASSIGNMENT;
	let requests: Request[] = [];
	let bodySeen = Promise.withResolvers<void>();
	const mock = createMockModel({
		handler: context => {
			// Everything the model was sent besides its own turns, in order.
			const sent = context.messages
				.filter(message => message.role !== "assistant")
				.map(message => JSON.stringify(message.content))
				.join("\n");
			const request = { taskAt: sent.indexOf(task), bodyAt: sent.indexOf(BODY) };
			requests.push(request);
			if (request.bodyAt >= 0) bodySeen.resolve();
			if (request.taskAt < 0) return { content: ["Context arrived without a task."] };
			if (requests.length > 1) return { content: ["src/gate.ts"] };
			return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	return {
		authStorage,
		modelRegistry,
		settings,
		cwd,
		artifactsDir,
		get requests() {
			return requests;
		},
		beginPhase(next) {
			task = next;
			requests = [];
			bodySeen = Promise.withResolvers<void>();
		},
		bodySeen: () => bodySeen.promise,
	};
}

/** Spawns the subagent; `startup` (when given) holds it after it is reachable and before its assignment. */
function spawn(harness: Harness, startup?: { entered: PromiseWithResolvers<void>; release: Promise<void> }) {
	// `session_start` runs after the session is reachable and before the assignment dispatches;
	// a slow extension start widens that window the way a slow MCP/plugin start does.
	const slowStart: ExtensionFactory = pi => {
		pi.on("session_start", async () => {
			if (!startup) return;
			startup.entered.resolve();
			await startup.release;
		});
	};
	return runSubprocess({
		cwd: harness.cwd,
		artifactsDir: harness.artifactsDir,
		agent: AGENT,
		task: ASSIGNMENT,
		index: 0,
		id: AGENT_ID,
		modelOverride: "mock/mock-model",
		parentAgentId: MAIN_AGENT_ID,
		authStorage: harness.authStorage,
		modelRegistry: harness.modelRegistry,
		preloadedPreparedExtensions: [
			{ path: "<inline-0>", resolvedPath: "<inline-0>", factory: slowStart, error: null },
		],
		settings: harness.settings,
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
	});
}

/** The phase's task ran with the message after its text, and the message reached the model once. */
async function expectDelivered(harness: Harness, session: AgentSession, reaches: Delivery["reaches"]): Promise<void> {
	await harness.bodySeen();
	await session.waitForIdle();
	const { requests } = harness;
	expect(requests.every(request => request.taskAt >= 0)).toBe(true);
	const firstWithBody = requests.findIndex(request => request.bodyAt >= 0);
	if (reaches === "task") expect(firstWithBody).toBe(0);
	else expect(firstWithBody).toBeGreaterThan(0);
	expect(requests[firstWithBody]!.bodyAt).toBeGreaterThan(requests[firstWithBody]!.taskAt);
	expect(session.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
}

describe("a message delivered before the task's turn starts", () => {
	it.each(deliveries)(
		"runs the assignment, then $label, when it lands during startup",
		async ({ reaches, deliver }) => {
			const harness = await createHarness();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			try {
				const running = spawn(harness, { entered, release: release.promise });
				await entered.promise;
				const session = AgentRegistry.global().get(AGENT_ID)?.session;
				if (!session) throw new Error(`${AGENT_ID} is not reachable during startup`);
				await deliver(session);
				release.resolve();

				const result = await running;
				expect(result.error).toBeUndefined();
				expect(result.exitCode).toBe(0);
				await expectDelivered(harness, session, reaches);
			} finally {
				release.resolve();
				harness.authStorage.close();
			}
		},
		30_000,
	);

	it.each(deliveries.filter(delivery => !delivery.spawnOnly))(
		"runs a follow-up, then $label, when it lands while the follow-up takes the idle subagent",
		async ({ reaches, deliver }) => {
			const harness = await createHarness();
			try {
				const first = await spawn(harness);
				expect(first.exitCode).toBe(0);
				const session = AgentRegistry.global().get(AGENT_ID)?.session;
				if (!session) throw new Error(`${AGENT_ID} was not kept alive`);
				await session.waitForIdle();

				// The follow-up owns the idle session, then installs its yield contract before it
				// prompts: hold it there.
				const installEntered = Promise.withResolvers<void>();
				const installRelease = Promise.withResolvers<void>();
				const install = session.setWorkPoolYieldItems.bind(session);
				vi.spyOn(session, "setWorkPoolYieldItems").mockImplementationOnce(async items => {
					installEntered.resolve();
					await installRelease.promise;
					return install(items);
				});
				harness.beginPhase(FOLLOW_UP);
				const running = runSubagentFollowUpTurn({
					id: AGENT_ID,
					agent: AGENT,
					message: FOLLOW_UP,
					artifactsDir: harness.artifactsDir,
				});
				await installEntered.promise;
				await deliver(session);
				installRelease.resolve();

				const result = await running;
				expect(result.error).toBeUndefined();
				expect(result.exitCode).toBe(0);
				await expectDelivered(harness, session, reaches);
			} finally {
				harness.authStorage.close();
			}
		},
		30_000,
	);
});
