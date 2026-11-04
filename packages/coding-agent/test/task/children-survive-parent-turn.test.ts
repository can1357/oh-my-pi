/**
 * An agent's work ends when the agent ends, whoever started it and however it
 * was spawned; it does not end because one of the agent's runs ended. The root
 * spawns `Lane` through the real task tool; `Lane` spawns its arm `Arm` as a
 * background job, and Lane's run then ends while `Arm` is still inside a `bash`
 * call: at its request budget, or on a terminal model error (a context-limit
 * refusal). `Arm` must finish its work, and its result must reach `Lane` in a
 * later turn, the way a finished background job's result reaches the root. What
 * ends Lane still ends Arm: an explicit kill (also of an idle or parked Lane with
 * no job row), a cancel of Lane's run or follow-up turn by its caller, a release,
 * the lifecycle's teardown, a discarded speculative launch; that holds for work
 * a descendant started after Lane parked and for work Lane's advisor started;
 * and ending Lane never touches another agent's tree, nor a later agent that
 * reuses Lane's id.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runEvalWorkpool } from "@oh-my-pi/pi-coding-agent/eval/workpool-bridge";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import { type AgentDefinition, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { WorkPoolRegistry } from "@oh-my-pi/pi-coding-agent/task/workpool";
import { emptyMirrorState, RemoteAgentSession } from "@oh-my-pi/pi-coding-agent/thread/remote-agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/children-survive-parent-turn";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const ARM_RESULT = "ARM-RESULT-7f3a";
const LANE_SAW_ARM = "LANE-SAW-ARM-7f3a";
const KILL_LANE = "Kill Lane now.";
const REVIVE_ARM = "Revive and spawn Grand.";
const ADVISOR_PROBE = "ADVISOR-SPAWN-PROBE";

/** How Lane's run ends while Arm runs: busy work past its request budget or wall-clock limit, or a model error. */
type LaneEnd = "budget" | "timeout" | "error";
/**
 * The agent tree the root builds. `lane`: Root → Lane → Arm. `blocking`: Root →
 * Lane → Arm spawned as a blocking task → Grand. `siblings`: Root → Lane → Arm,
 * and Root → Beta → BetaArm, an unrelated tree. `jobless`: Root → Lane spawned as
 * a blocking task (no job row) → Arm. `twoArms`: Root → Lane → Arm and Arm2.
 * `parked`: Root → Lane → Arm, where Arm can spawn Grand once revived.
 */
type Shape = "lane" | "blocking" | "siblings" | "jobless" | "twoArms" | "parked";

const LEAD: AgentDefinition = {
	name: "lead",
	description: "Lead",
	systemPrompt: "Lead",
	tools: ["bash", "task"],
	spawns: "*",
	source: "bundled",
};

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let laneEnd: LaneEnd = "budget";
let shape: Shape = "lane";
let laneErrored = false;
/** Arm's bash waits for this file, which the test writes once Lane's run has ended. */
let gateFile = "";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

function resetProcessGlobals(): void {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-children-survive-"));
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	gateFile = path.join(root, "arm-may-finish");
	laneErrored = false;
	shape = "lane";
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	resetProcessGlobals();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	resetProcessGlobals();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

function textOf(content: unknown): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

function hasToolResult(context: Context, tool: string): boolean {
	return context.messages.some(message => message.role === "toolResult" && message.toolName === tool);
}

function toolCall(name: string, args: Record<string, unknown>): MockResponse {
	return { content: [{ type: "toolCall", name, arguments: args }] };
}

/**
 * Root: spawn Lane (and Beta, in `siblings`); on {@link KILL_LANE}, write
 * `proc://Lane/kill`. Lane and Beta: spawn their arm (two in `twoArms`), then end
 * their run (busy work until the request budget or wall-clock limit stops it, or
 * one terminal model error); once Arm's result is in Lane's conversation,
 * acknowledge it. A blocking Arm spawns Grand, then works until its own budget
 * stops it; so does a revived Arm on {@link REVIVE_ARM}. An advisor sent
 * {@link ADVISOR_PROBE} spawns AdvisorLane, which acts as Lane does. Arm, Arm2,
 * Grand and BetaArm: run a bash that waits for the test's gate, then report.
 */
function handler(context: Context): MockResponse {
	const first = context.messages.find(message => message.role === "user");
	const task = first ? textOf(first.content) : "";
	const lastUser = context.messages.findLastIndex(message => message.role === "user");
	const last = lastUser >= 0 ? context.messages[lastUser] : undefined;
	const taskSinceLastUser = context.messages
		.slice(lastUser + 1)
		.some(message => message.role === "toolResult" && message.toolName === "task");
	if (task.includes(ADVISOR_PROBE)) {
		if (hasToolResult(context, "task")) return { content: ["advisor done"] };
		return toolCall("task", { agent: "lead", name: "AdvisorLane", task: "Do assignment Lane." });
	}
	if (task.includes("assignment Arm.") && last && textOf(last.content).includes(REVIVE_ARM)) {
		if (!taskSinceLastUser) {
			return toolCall("task", { agent: "worker", name: "Grand", task: "Do assignment Grand." });
		}
		return toolCall("bash", { command: "true", i: "Arm busy work" });
	}
	if (task.includes("assignment Arm.") && shape === "blocking") {
		if (!hasToolResult(context, "task")) {
			return toolCall("task", { agent: "worker", name: "Grand", task: "Do assignment Grand." });
		}
		return toolCall("bash", { command: "true", i: "Arm busy work" });
	}
	if (
		task.includes("assignment Arm.") ||
		task.includes("assignment Arm2.") ||
		task.includes("assignment Grand.") ||
		task.includes("assignment BetaArm.")
	) {
		if (hasToolResult(context, "bash")) return { content: [ARM_RESULT] };
		return toolCall("bash", {
			// Prints `arm-work-2`, a text only the command's output holds.
			command: `while [ ! -e ${JSON.stringify(gateFile)} ]; do sleep 0.05; done; echo arm-work-$((1 + 1))`,
			i: "Running gated work",
		});
	}
	if (task.includes("assignment Lane.") || task.includes("assignment Beta.")) {
		if (
			context.messages.some(message => message.role !== "assistant" && textOf(message.content).includes(ARM_RESULT))
		) {
			return { content: [LANE_SAW_ARM] };
		}
		const spawnedArms = context.messages.filter(m => m.role === "toolResult" && m.toolName === "task").length;
		if (spawnedArms === 0) {
			if (task.includes("assignment Beta.")) {
				return toolCall("task", { agent: "worker", name: "BetaArm", task: "Do assignment BetaArm." });
			}
			const armAgent = shape === "blocking" ? "blocker" : shape === "parked" ? "spawner" : "worker";
			return toolCall("task", { agent: armAgent, name: "Arm", task: "Do assignment Arm." });
		}
		if (shape === "twoArms" && spawnedArms === 1) {
			return toolCall("task", { agent: "worker", name: "Arm2", task: "Do assignment Arm2." });
		}
		if (laneEnd === "error" && !laneErrored) {
			laneErrored = true;
			return { stopReason: "error", errorMessage: "prompt is too long: 210000 tokens > 200000 maximum" };
		}
		return toolCall("bash", { command: "true", i: "Lane busy work" });
	}
	if (last && textOf(last.content).includes(KILL_LANE)) {
		const killed = context.messages.indexOf(last) < context.messages.findLastIndex(m => m.role === "toolResult");
		return killed ? { content: ["killed"] } : toolCall("write", { path: "proc://Lane/kill", i: "Killing Lane" });
	}
	const spawned = context.messages.filter(message => message.role === "toolResult" && message.toolName === "task");
	if (spawned.length === 0) {
		const laneAgent = shape === "jobless" ? "blockinglead" : "lead";
		return toolCall("task", { agent: laneAgent, name: "Lane", task: "Do assignment Lane." });
	}
	if (shape === "siblings" && spawned.length === 1) {
		return toolCall("task", { agent: "lead", name: "Beta", task: "Do assignment Beta." });
	}
	return { content: ["root ok"] };
}

async function harness(options: { idleTtlMs: number }) {
	const cwd = path.join(root, "home", "work");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({ handler });
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [
			LEAD,
			{ name: "worker", description: "Worker", systemPrompt: "Worker", tools: ["bash"], source: "bundled" },
			{
				name: "blocker",
				description: "Blocking worker",
				systemPrompt: "Blocker",
				tools: ["bash", "task"],
				spawns: "*",
				blocking: true,
				source: "bundled",
			},
			{ ...LEAD, name: "blockinglead", description: "Blocking lead", blocking: true },
			{
				name: "spawner",
				description: "Worker that can spawn",
				systemPrompt: "Spawner",
				tools: ["bash", "task"],
				spawns: "*",
				source: "bundled",
			},
		],
		projectAgentsDir: null,
	});
	const settings = Settings.isolated({
		"async.enabled": true,
		"task.batch": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		// Lane's (and Beta's, a blocking Lane's, and a blocking or revived Arm's)
		// run is force-stopped at 3 requests in the "budget" case; no budget otherwise.
		"task.agentSoftRequestBudget":
			laneEnd === "budget" ? { lead: 2, blocker: 2, blockinglead: 2, spawner: 2 } : { lead: 0 },
		"task.agentIdleTtlMs": options.idleTtlMs,
		// Root → Lane → Arm → Grand, and Root → Lane → advisor → AdvisorLane → Arm.
		"task.maxRecursionDepth": 4,
		modelRoles: { default: "mock/mock-model" },
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root, "home", ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: mock,
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
		settings,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["task", "wait", "write"],
	});
	return { authStorage, session };
}

/**
 * Poll real state: the subagents run real `bash` processes in sessions created
 * after the test starts, so there is no single event to await and fake timers
 * would not advance them.
 */
async function until(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			const state = AgentRegistry.global()
				.list()
				.map(ref => `${ref.id} ${ref.status} ${JSON.stringify(ref.session?.messages.slice(-2)).slice(0, 600)}`);
			throw new Error(`Timed out waiting for ${what}; registry:\n${state.join("\n")}`);
		}
		await Bun.sleep(25);
	}
}

function transcriptHas(id: string, needle: string): boolean {
	const messages = AgentRegistry.global().get(id)?.session?.messages ?? [];
	return messages.some(message => "content" in message && textOf(message.content).includes(needle));
}

/** Runs until Lane's run has ended with Arm still in its bash call; returns Arm's job. */
async function laneRunEndsWhileArmWorks(session: AgentSession) {
	await session.prompt("Fan out.");
	const manager = session.asyncJobManager!;
	await until(() => {
		const status = manager.getJob("Lane")?.status;
		return status !== undefined && status !== "running";
	}, "Lane's run to end");
	const armJob = manager.getJob("Lane.Arm")!;
	return armJob;
}

async function expectArmFinishesAndLaneHearsIt(session: AgentSession): Promise<void> {
	const armJob = await laneRunEndsWhileArmWorks(session);
	expect({ status: armJob.status, owner: armJob.ownerId }).toEqual({ status: "running", owner: "Lane" });
	await Bun.write(gateFile, "go");
	await armJob.promise;
	expect({ status: armJob.status, error: armJob.errorText }).toEqual({ status: "completed", error: undefined });
	expect(transcriptHas("Lane.Arm", "arm-work-2")).toBe(true);
	// Arm's result reaches Lane as a later turn, which answers it.
	await until(() => transcriptHas("Lane", LANE_SAW_ARM), "Lane to answer Arm's result");
}

it("keeps a running child alive when its parent's run ends at the request budget", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		await expectArmFinishesAndLaneHearsIt(session);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("keeps a running child alive when its parent's run ends on a terminal model error", async () => {
	laneEnd = "error";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		await expectArmFinishesAndLaneHearsIt(session);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("does not park an idle parent while its child still runs", async () => {
	laneEnd = "budget";
	// Lane would be parked (and its session disposed) 50 ms after going idle.
	const { authStorage, session } = await harness({ idleTtlMs: 50 });
	try {
		const armJob = await laneRunEndsWhileArmWorks(session);
		await until(() => AgentRegistry.global().get("Lane")?.status === "idle", "Lane to go idle");
		// Several idle TTLs pass while Arm works (the lifecycle's TTL is a real timer
		// armed inside the run, so fake timers cannot drive it).
		await Bun.sleep(300);
		expect({ arm: armJob.status, lane: AgentRegistry.global().get("Lane")?.status }).toEqual({
			arm: "running",
			lane: "idle",
		});
		await Bun.write(gateFile, "go");
		await armJob.promise;
		expect(armJob.status).toBe("completed");
		await until(() => transcriptHas("Lane", LANE_SAW_ARM), "Lane to answer Arm's result");
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("stops the child when its parent is killed explicitly", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		const armJob = await laneRunEndsWhileArmWorks(session);
		expect(armJob.status).toBe("running");
		await session.prompt(KILL_LANE);
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
		expect(transcriptHas("Lane.Arm", "arm-work-2")).toBe(false);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("stops the child when its parent's caller cancels after a wall-clock timeout ended the run", async () => {
	laneEnd = "timeout";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	// Hold the session abort Lane's timeout starts, so the caller's cancel lands
	// while the run is ending with `timeout` as its abort reason.
	const timeoutAbortStarted = Promise.withResolvers<void>();
	const timeoutAbortHeld = Promise.withResolvers<void>();
	const abort = AgentSession.prototype.abort;
	vi.spyOn(AgentSession.prototype, "abort").mockImplementation(async function (
		this: AgentSession,
		...args: Parameters<AgentSession["abort"]>
	) {
		await abort.apply(this, args);
		if (this.getAgentId() !== "Lane") return;
		timeoutAbortStarted.resolve();
		await timeoutAbortHeld.promise;
	});
	const caller = new AbortController();
	try {
		const run = runSubprocess({
			cwd: path.join(root, "home", "work"),
			agent: LEAD,
			task: "Do assignment Lane.",
			index: 0,
			id: "Lane",
			structured: false,
			modelOverride: "mock/mock-model",
			settings: session.settings,
			authStorage,
			modelRegistry: session.modelRegistry,
			asyncJobManager: session.asyncJobManager,
			maxRuntimeMs: 3000,
			enableMCP: false,
			enableLsp: false,
			signal: caller.signal,
			artifactsDir: path.join(root, "artifacts"),
		});
		await timeoutAbortStarted.promise;
		const armJob = session.asyncJobManager!.getJob("Lane.Arm")!;
		expect(armJob.status).toBe("running");
		caller.abort(new Error("the caller cancelled Lane"));
		timeoutAbortHeld.resolve();
		await run;
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
		expect(transcriptHas("Lane.Arm", "arm-work-2")).toBe(false);
	} finally {
		timeoutAbortHeld.resolve();
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("stops the child when its parent's follow-up turn is cancelled", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		const armJob = await laneRunEndsWhileArmWorks(session);
		const lane = AgentRegistry.global().get("Lane")!.session!;
		const caller = new AbortController();
		const followUp = runSubagentFollowUpTurn({
			id: "Lane",
			agent: LEAD,
			message: "Keep working.",
			structured: false,
			signal: caller.signal,
		});
		await until(() => lane.isStreaming, "Lane's follow-up turn to start");
		expect(armJob.status).toBe("running");
		caller.abort(new Error("the caller cancelled Lane's follow-up turn"));
		await followUp;
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("releases a running child with its parent when the lifecycle tears down", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		const armJob = await laneRunEndsWhileArmWorks(session);
		await AgentLifecycleManager.global().dispose();
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
		const liveSubagents = AgentRegistry.global()
			.list()
			.filter(ref => ref.id !== MAIN_AGENT_ID && ref.session)
			.map(ref => `${ref.id} ${ref.status}`);
		expect(liveSubagents).toEqual([]);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("parks an idle worker-homed parent once its child's job is cancelled, whatever its mirror last said", async () => {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	const armJob = manager.register(
		"task",
		"W.Arm",
		async ({ signal }) => {
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			return "stopped";
		},
		{ id: "W.Arm", ownerId: "W", agentId: "W.Arm" },
	);
	// The worker last published "background work pending"; no session event follows the cancel.
	const mirror = new RemoteAgentSession({
		key: "w1:W",
		home: "w1",
		agentId: "W",
		host: undefined,
		state: { ...emptyMirrorState(), backgroundWorkPending: true },
		messages: [],
		asyncJobManager: manager,
	});
	AgentRegistry.global().register({
		id: "W",
		displayName: "task",
		kind: "sub",
		session: mirror,
		sessionFile: null,
		status: "idle",
	});
	AgentLifecycleManager.global().adopt("W", { idleTtlMs: 20 });
	// Several idle TTLs pass while the child runs (real lifecycle timer).
	await Bun.sleep(150);
	expect(AgentRegistry.global().get("W")?.status).toBe("idle");
	manager.cancel(armJob);
	await manager.waitForAll();
	await until(() => AgentRegistry.global().get("W")?.status === "parked", "the idle parent to park");
	await manager.dispose({ timeoutMs: 1000 });
}, 60_000);

it("stops the child when its parent's caller cancels while the run's result is being published", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	const caller = new AbortController();
	// The run's settled lifecycle frame goes out from its result publication, after
	// the run decided to keep Arm; the caller cancels right there.
	const events = new EventBus();
	events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame => {
		const settled =
			typeof frame === "object" && frame !== null && "id" in frame && "status" in frame && frame.id === "Lane";
		if (settled && frame.status !== "started") caller.abort(new Error("the caller cancelled Lane"));
	});
	try {
		await runSubprocess({
			cwd: path.join(root, "home", "work"),
			agent: LEAD,
			task: "Do assignment Lane.",
			index: 0,
			id: "Lane",
			structured: false,
			modelOverride: "mock/mock-model",
			settings: session.settings,
			authStorage,
			modelRegistry: session.modelRegistry,
			asyncJobManager: session.asyncJobManager,
			enableMCP: false,
			enableLsp: false,
			signal: caller.signal,
			eventBus: events,
			artifactsDir: path.join(root, "artifacts"),
		});
		expect(caller.signal.aborted).toBe(true);
		const armJob = session.asyncJobManager!.getJob("Lane.Arm")!;
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
		expect(transcriptHas("Lane.Arm", "arm-work-2")).toBe(false);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("releases a child whose cancelled run unwinds past its parent's teardown", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	// Hold Arm's abort past the 3 s its parent's disposal waits for it, so Arm's
	// run ends after the lifecycle's dispose() has returned.
	const armAbortHeld = Promise.withResolvers<void>();
	const abort = AgentSession.prototype.abort;
	vi.spyOn(AgentSession.prototype, "abort").mockImplementation(async function (
		this: AgentSession,
		...args: Parameters<AgentSession["abort"]>
	) {
		await abort.apply(this, args);
		if (this.getAgentId() === "Lane.Arm") await armAbortHeld.promise;
	});
	try {
		const armJob = await laneRunEndsWhileArmWorks(session);
		await AgentLifecycleManager.global().dispose();
		armAbortHeld.resolve();
		await armJob.promise;
		const liveSubagents = AgentRegistry.global()
			.list()
			.filter(ref => ref.id !== MAIN_AGENT_ID && ref.session)
			.map(ref => `${ref.id} ${ref.status}`);
		expect({ arm: armJob.status, liveSubagents }).toEqual({ arm: "cancelled", liveSubagents: [] });
	} finally {
		armAbortHeld.resolve();
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

/** Runs until Lane's run has ended and Lane is idle, with Arm still in its bash call; returns Arm's job. */
async function laneIdleWhileArmWorks(session: AgentSession) {
	const armJob = await laneRunEndsWhileArmWorks(session);
	await until(() => AgentRegistry.global().get("Lane")?.status === "idle", "Lane to go idle");
	expect(armJob.status).toBe("running");
	return armJob;
}

it("stops the child when a follow-up turn's caller had already cancelled it", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		const armJob = await laneIdleWhileArmWorks(session);
		const caller = new AbortController();
		caller.abort(new Error("the caller cancelled before the turn began"));
		await runSubagentFollowUpTurn({
			id: "Lane",
			agent: LEAD,
			message: "Keep working.",
			structured: false,
			signal: caller.signal,
		});
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("stops the child when the caller cancels from the follow-up turn's started frame", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		const armJob = await laneIdleWhileArmWorks(session);
		const caller = new AbortController();
		const events = new EventBus();
		events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame => {
			const started =
				typeof frame === "object" && frame !== null && "id" in frame && "status" in frame && frame.id === "Lane";
			if (started && frame.status === "started") caller.abort(new Error("the caller cancelled as the turn started"));
		});
		await runSubagentFollowUpTurn({
			id: "Lane",
			agent: LEAD,
			message: "Keep working.",
			structured: false,
			signal: caller.signal,
			eventBus: events,
		});
		expect(caller.signal.aborted).toBe(true);
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("stops a grandchild behind a blocking child when its grandparent is killed", async () => {
	laneEnd = "budget";
	shape = "blocking";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		await session.prompt("Fan out.");
		const manager = session.asyncJobManager!;
		await until(() => {
			const lane = manager.getJob("Lane")?.status;
			return lane !== undefined && lane !== "running";
		}, "Lane's run to end");
		// Arm ran as a blocking task inside Lane's run: no job row records it.
		expect(manager.getJob("Lane.Arm")).toBeUndefined();
		const grandJob = manager.getJob("Lane.Arm.Grand")!;
		expect({ status: grandJob.status, owner: grandJob.ownerId }).toEqual({ status: "running", owner: "Lane.Arm" });
		await session.prompt(KILL_LANE);
		await grandJob.promise;
		expect(grandJob.status).toBe("cancelled");
		expect(transcriptHas("Lane.Arm.Grand", "arm-work-2")).toBe(false);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("does not park an idle grandparent while its grandchild still runs", async () => {
	laneEnd = "budget";
	shape = "blocking";
	// Lane and Arm would each be parked (and their sessions disposed) 50 ms after going idle.
	const { authStorage, session } = await harness({ idleTtlMs: 50 });
	try {
		await session.prompt("Fan out.");
		const manager = session.asyncJobManager!;
		await until(() => AgentRegistry.global().get("Lane")?.status === "idle", "Lane to go idle");
		const grandJob = manager.getJob("Lane.Arm.Grand")!;
		// Several idle TTLs pass while Grand works; Lane owns no running job of its own.
		await Bun.sleep(300);
		expect({ grand: grandJob.status, lane: AgentRegistry.global().get("Lane")?.status }).toEqual({
			grand: "running",
			lane: "idle",
		});
		await Bun.write(gateFile, "go");
		await grandJob.promise;
		expect(grandJob.status).toBe("completed");
		expect(transcriptHas("Lane.Arm.Grand", "arm-work-2")).toBe(true);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("does not touch another agent's tree when an agent is killed", async () => {
	laneEnd = "budget";
	shape = "siblings";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		const armJob = await laneRunEndsWhileArmWorks(session);
		const manager = session.asyncJobManager!;
		await until(() => {
			const beta = manager.getJob("Beta")?.status;
			return beta !== undefined && beta !== "running";
		}, "Beta's run to end");
		const betaArmJob = manager.getJob("Beta.BetaArm")!;
		expect([armJob.status, betaArmJob.status]).toEqual(["running", "running"]);
		await session.prompt(KILL_LANE);
		await armJob.promise;
		expect({ arm: armJob.status, betaArm: betaArmJob.status }).toEqual({ arm: "cancelled", betaArm: "running" });
		// Beta's child goes on to finish its work, and Beta hears its result.
		await Bun.write(gateFile, "go");
		await betaArmJob.promise;
		expect(betaArmJob.status).toBe("completed");
		expect(transcriptHas("Beta.BetaArm", "arm-work-2")).toBe(true);
		await until(() => transcriptHas("Beta", LANE_SAW_ARM), "Beta to answer its child's result");
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

/** A tool session of the root, for driving the task tool and eval bridges directly. */
function rootToolSession(
	session: AgentSession,
	authStorage: ToolSession["authStorage"],
	settings: Settings = session.settings,
): ToolSession {
	return {
		cwd: session.sessionManager.getCwd(),
		hasUI: false,
		settings,
		authStorage,
		modelRegistry: session.modelRegistry,
		asyncJobManager: session.asyncJobManager,
		getAgentId: () => MAIN_AGENT_ID,
		getSessionSpawns: () => "*",
		getSessionFile: () => session.sessionFile ?? null,
		getArtifactsDir: () => path.join(root, "artifacts"),
		enableMCP: false,
		enableLsp: false,
		taskDepth: 0,
	} as unknown as ToolSession;
}

it("stops the child of a speculative launch discarded after its run returned", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	// Speculative launches stream the items of a batch `task` call.
	const batchSettings = Settings.isolated({
		"async.enabled": true,
		"task.batch": true,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"task.agentSoftRequestBudget": { lead: 2 },
		"task.agentIdleTtlMs": 0,
		modelRoles: { default: "mock/mock-model" },
	});
	const tool = await TaskTool.create(rootToolSession(session, authStorage, batchSettings));
	const call: AgentToolCall = { type: "toolCall", id: "streamed-task", name: "task", arguments: {} };
	const coordinator: SpeculativeOperationSink = {
		maxInFlight: 2,
		admit: async () => undefined,
		authorizeLaunch: async () => ({ allowed: true }),
		close: () => {},
	};
	const stream = (await tool.speculation.stream?.open({ coordinator, parentToolCallId: call.id })) as
		| TaskLaunchSession
		| undefined;
	if (!stream) throw new Error("expected a speculative task launch session");
	try {
		// Lane's item has closed; the next one is still streaming, so Lane launches early.
		stream.update(
			call,
			'{"context":"shared context","tasks":[{"name":"Lane","agent":"lead","task":"Do assignment Lane."},{"name":"Still',
		);
		const manager = session.asyncJobManager!;
		await until(() => AgentRegistry.global().get("Lane")?.status === "idle", "Lane's run to return");
		const armJob = manager.getJob("Lane.Arm")!;
		expect({ arm: armJob.status, laneJob: manager.getJob("Lane") }).toEqual({ arm: "running", laneJob: undefined });
		// The finished call turns out invalid: the launch is discarded, never adopted.
		stream.discard("finished task call is invalid");
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
		await until(() => AgentRegistry.global().get("Lane") === undefined, "Lane to be released");
	} finally {
		stream.discard("test cleanup");
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("stops a workpool member's child when its settled batch is killed", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	const toolSession = rootToolSession(session, authStorage);
	try {
		const created = await runEvalWorkpool(
			{ op: "create", agent: "lead", name: "Pool", limit: 1 },
			{ session: toolSession },
		);
		const name = "name" in created ? created.name : "Pool";
		// The member runs as Lane does: it spawns Arm, then its run stops at its budget.
		await runEvalWorkpool({ op: "push", name, items: ["Do assignment Lane."] }, { session: toolSession });
		const manager = session.asyncJobManager!;
		await until(
			() =>
				manager
					.getAllJobs()
					.some(job => job.agentId !== undefined && job.agentId !== job.id && job.status !== "running"),
			"the member's batch to settle",
		);
		const batch = manager.getAllJobs().find(job => job.agentId !== undefined && job.agentId !== job.id)!;
		await until(() => manager.getJob(`${batch.agentId}.Arm`)?.status === "running", "the member's child to run");
		const armJob = manager.getJob(`${batch.agentId}.Arm`)!;
		await session
			.getToolByName("write")!
			.execute("kill-batch", { path: `proc://${batch.id}/kill`, i: "Killing batch" });
		await armJob.promise;
		expect(armJob.status).toBe("cancelled");
	} finally {
		WorkPoolRegistry.global().releaseOwner(MAIN_AGENT_ID);
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

/** Waits (bounded) until `job` settled, so work nothing cancels fails the test instead of hanging it. */
async function settled(job: AsyncJob, what: string): Promise<void> {
	await until(() => job.status !== "running", what, 5_000);
	await job.promise;
}

const SPAWNER: AgentDefinition = {
	name: "spawner",
	description: "Worker that can spawn",
	systemPrompt: "Spawner",
	tools: ["bash", "task"],
	spawns: "*",
	source: "bundled",
};

it("kills an idle agent that has no job row through proc://, and its child with it", async () => {
	laneEnd = "budget";
	shape = "jobless";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		// Lane runs as a blocking task inside the root's turn: no job row ever records it.
		await session.prompt("Fan out.");
		const manager = session.asyncJobManager!;
		await until(() => AgentRegistry.global().get("Lane")?.status === "idle", "the blocking Lane to go idle");
		const armJob = manager.getJob("Lane.Arm")!;
		expect({ laneJob: manager.getJob("Lane"), arm: armJob.status }).toEqual({ laneJob: undefined, arm: "running" });
		await session.prompt(KILL_LANE);
		await settled(armJob, "Arm's job to end with Lane");
		expect({ arm: armJob.status, lane: AgentRegistry.global().get("Lane") }).toEqual({
			arm: "cancelled",
			lane: undefined,
		});
		expect(transcriptHas("Lane.Arm", "arm-work-2")).toBe(false);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

for (const end of ["release", "kill"] as const) {
	it(`ending a parked Lane by ${end} stops the work a child revived by another agent started`, async () => {
		laneEnd = "budget";
		shape = "parked";
		// Lane and Arm park 100 ms after their trees go quiet.
		const { authStorage, session } = await harness({ idleTtlMs: 100 });
		try {
			await expectArmFinishesAndLaneHearsIt(session);
			await until(
				() => ["Lane", "Lane.Arm"].every(id => AgentRegistry.global().get(id)?.status === "parked"),
				"Lane and Arm to park",
			);
			await fs.rm(gateFile);
			// The root, not Lane, revives Arm; Arm spawns Grand and its turn stops at its budget.
			await runSubagentFollowUpTurn({
				id: "Lane.Arm",
				agent: SPAWNER,
				message: REVIVE_ARM,
				structured: false,
				softRequestBudget: 2,
			});
			const grandJob = session.asyncJobManager!.getJob("Lane.Arm.Grand")!;
			expect({ grand: grandJob.status, lane: AgentRegistry.global().get("Lane")?.status }).toEqual({
				grand: "running",
				lane: "parked",
			});
			if (end === "release") {
				await AgentLifecycleManager.global().release("Lane", AgentRegistry.global().get("Lane")!);
			} else {
				await session.prompt(KILL_LANE);
			}
			await settled(grandJob, "Grand's job to end with Lane");
			expect(grandJob.status).toBe("cancelled");
			expect(transcriptHas("Lane.Arm.Grand", "arm-work-2")).toBe(false);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}, 120_000);
}

it("ending an agent stops the work of the agents its advisor spawned", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	try {
		const armJob = await laneIdleWhileArmWorks(session);
		const manager = session.asyncJobManager!;
		// Lane's own child is another test's subject; only the advisor's tree runs here.
		manager.cancel(armJob.id);
		await armJob.promise;
		const lane = AgentRegistry.global().get("Lane")!.session as AgentSession;
		lane.settings.setModelRole("advisor", "mock/mock-model");
		lane.applyAdvisorConfigs(
			[{ name: "Ownership review", tools: ["task"], instructions: "Review ownership." }],
			undefined,
		);
		expect(lane.setAdvisorEnabled(true)).toBe(true);
		// The advisor spawns AdvisorLane through the real task tool; AdvisorLane spawns its own Arm.
		await lane.getAdvisorAgent()!.prompt(ADVISOR_PROBE);
		await until(
			() => manager.getJob("Lane.AdvisorLane.Arm")?.status === "running",
			"the advisor's agent's child to run",
		);
		const advisorArmJob = manager.getJob("Lane.AdvisorLane.Arm")!;
		await AgentLifecycleManager.global().release("Lane", AgentRegistry.global().get("Lane")!);
		await settled(advisorArmJob, "the advisor's agent's child to end with Lane");
		expect(advisorArmJob.status).toBe("cancelled");
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("a discarded speculative launch never ends a later agent that reuses its id under another parent", async () => {
	laneEnd = "budget";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	const batchSettings = Settings.isolated({
		"async.enabled": true,
		"task.batch": true,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"task.agentSoftRequestBudget": { lead: 2 },
		"task.agentIdleTtlMs": 0,
		modelRoles: { default: "mock/mock-model" },
	});
	const manager = session.asyncJobManager!;
	const childSession = async (id: string, parentId: string) =>
		(
			await createAgentSession({
				cwd: session.sessionManager.getCwd(),
				agentDir: path.join(root, "home", ".omp", "agent"),
				authStorage,
				modelRegistry: session.modelRegistry,
				model: session.model!,
				sessionManager: SessionManager.create(session.sessionManager.getCwd(), path.join(root, "reuse", id)),
				settings: batchSettings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: ["bash"],
				agentId: id,
				parentAgentId: parentId,
				parentTaskPrefix: id,
				asyncJobManager: manager,
			})
		).session;
	const tool = await TaskTool.create(rootToolSession(session, authStorage, batchSettings));
	const call: AgentToolCall = { type: "toolCall", id: "streamed-task", name: "task", arguments: {} };
	const coordinator: SpeculativeOperationSink = {
		maxInFlight: 2,
		admit: async () => undefined,
		authorizeLaunch: async () => ({ allowed: true }),
		close: () => {},
	};
	const stream = (await tool.speculation.stream?.open({ coordinator, parentToolCallId: call.id })) as
		| TaskLaunchSession
		| undefined;
	if (!stream) throw new Error("expected a speculative task launch session");
	let beta: AgentSession | undefined;
	let replacement: AgentSession | undefined;
	try {
		stream.update(
			call,
			'{"context":"shared context","tasks":[{"name":"Lane","agent":"lead","task":"Do assignment Lane."},{"name":"Still',
		);
		await until(() => AgentRegistry.global().get("Lane")?.status === "idle", "the speculative Lane's run to return");
		const oldArm = manager.getJob("Lane.Arm")!;
		// The Agent Hub kills that Lane; its tree ends with it.
		await AgentLifecycleManager.global().release("Lane", AgentRegistry.global().get("Lane")!, { tombstone: true });
		await settled(oldArm, "the killed Lane's child to end");
		// Beta, another agent, spawns a new Lane, which starts its own background work.
		beta = await childSession("Beta", MAIN_AGENT_ID);
		replacement = await childSession("Lane", "Beta");
		await replacement.getToolByName("bash")!.execute("replacement-work", {
			command: `while [ ! -e ${JSON.stringify(gateFile)} ]; do sleep 0.05; done; echo replacement-done`,
			async: true,
			i: "Replacement work",
		});
		const work = manager.getRunningJobs({ ownerId: "Lane" }).find(job => job.type === "bash")!;
		expect({ parent: AgentRegistry.global().get("Lane")?.parentId, work: work.status }).toEqual({
			parent: "Beta",
			work: "running",
		});
		// The finished call turns out invalid: the old launch is discarded, after its run returned.
		stream.discard("finished task call is invalid");
		// An absence of effect has no event to await: the discard's release runs on
		// a settled promise, so it lands well within this real wait (red at the
		// previous head within it), and the processes it would stop are real.
		await Bun.sleep(500);
		expect({
			parent: AgentRegistry.global().get("Lane")?.parentId,
			work: work.status,
			disposed: replacement.isDisposed,
		}).toEqual({ parent: "Beta", work: "running", disposed: false });
		await Bun.write(gateFile, "go");
		await work.promise;
		expect(work.status).toBe("completed");
	} finally {
		stream.discard("test cleanup");
		await Bun.write(gateFile, "go");
		await replacement?.dispose();
		await beta?.dispose();
		await session.dispose();
		authStorage.close();
	}
}, 120_000);

it("reports a failing end hook to the caller that ended the agent, and still ends the rest of its tree", async () => {
	laneEnd = "budget";
	shape = "twoArms";
	const { authStorage, session } = await harness({ idleTtlMs: 0 });
	const errors = vi.spyOn(logger, "error");
	try {
		await session.prompt("Fan out.");
		const manager = session.asyncJobManager!;
		await until(
			() =>
				AgentRegistry.global().get("Lane")?.status === "idle" && manager.getJob("Lane.Arm2")?.status === "running",
			"Lane to go idle with both arms running",
		);
		const arm = manager.getJob("Lane.Arm")!;
		const arm2 = manager.getJob("Lane.Arm2")!;
		// Cancelling Arm's job throws: the end hook fails part-way through Lane's tree.
		vi.spyOn(arm.abortController, "abort").mockImplementation(() => {
			throw new Error("abort refused");
		});
		const killed = await session
			.getToolByName("write")!
			.execute("kill-lane", { path: "proc://Lane/kill", i: "Killing Lane" });
		const text = killed.content.map(part => ("text" in part ? part.text : "")).join("\n");
		expect(text).toContain("Cancelled agent Lane, but not all of its tree's work");
		expect(text).toContain("Lane.Arm");
		expect(text).toContain("abort refused");
		expect(errors.mock.calls.some(([message]) => message === "Agent end hook failed")).toBe(true);
		// The rest of the tree ended, and so did Lane.
		await settled(arm2, "Arm2's job to end with Lane");
		expect({ arm2: arm2.status, lane: AgentRegistry.global().get("Lane") }).toEqual({
			arm2: "cancelled",
			lane: undefined,
		});
	} finally {
		vi.restoreAllMocks();
		await Bun.write(gateFile, "go");
		await session.dispose();
		authStorage.close();
	}
}, 120_000);
