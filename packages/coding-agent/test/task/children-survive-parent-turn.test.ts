/**
 * A running `task` child outlives the end of its parent's run. The root spawns
 * `Lane` through the real task tool; `Lane` spawns its arm `Arm` as a background
 * job, and Lane's run then ends while `Arm` is still inside a `bash` call: at its
 * request budget, or on a terminal model error (a context-limit refusal). `Arm`
 * must finish its work, and its result must reach `Lane` in a later turn, the way
 * a finished background job's result reaches the root. What ends Lane still ends
 * Arm: an explicit kill, a cancel of Lane's run or follow-up turn by its caller
 * (also after a timeout already ended the run), and the lifecycle's teardown.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { type AgentDefinition, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { emptyMirrorState, RemoteAgentSession } from "@oh-my-pi/pi-coding-agent/thread/remote-agent-session";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/children-survive-parent-turn";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const ARM_RESULT = "ARM-RESULT-7f3a";
const LANE_SAW_ARM = "LANE-SAW-ARM-7f3a";
const KILL_LANE = "Kill Lane now.";

/** How Lane's run ends while Arm runs: busy work past its request budget or wall-clock limit, or a model error. */
type LaneEnd = "budget" | "timeout" | "error";

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
 * Root: spawn Lane; on {@link KILL_LANE}, write `proc://Lane/kill`. Lane: spawn
 * Arm, then end its run (busy work until its request budget or wall-clock limit
 * stops it, or one terminal model error); once Arm's result is in its
 * conversation, acknowledge it. Arm: run a bash that waits for the test's gate,
 * then report.
 */
function handler(context: Context): MockResponse {
	const first = context.messages.find(message => message.role === "user");
	const task = first ? textOf(first.content) : "";
	if (task.includes("assignment Arm.")) {
		if (hasToolResult(context, "bash")) return { content: [ARM_RESULT] };
		return toolCall("bash", {
			// Prints `arm-work-2`, a text only the command's output holds.
			command: `while [ ! -e ${JSON.stringify(gateFile)} ]; do sleep 0.05; done; echo arm-work-$((1 + 1))`,
			i: "Running Arm work",
		});
	}
	if (task.includes("assignment Lane.")) {
		if (
			context.messages.some(message => message.role !== "assistant" && textOf(message.content).includes(ARM_RESULT))
		) {
			return { content: [LANE_SAW_ARM] };
		}
		if (!hasToolResult(context, "task")) {
			return toolCall("task", { agent: "worker", name: "Arm", task: "Do assignment Arm." });
		}
		if (laneEnd === "error" && !laneErrored) {
			laneErrored = true;
			return { stopReason: "error", errorMessage: "prompt is too long: 210000 tokens > 200000 maximum" };
		}
		return toolCall("bash", { command: "true", i: "Lane busy work" });
	}
	const last = context.messages.findLast(message => message.role === "user");
	if (last && textOf(last.content).includes(KILL_LANE)) {
		const killed = context.messages.indexOf(last) < context.messages.findLastIndex(m => m.role === "toolResult");
		return killed ? { content: ["killed"] } : toolCall("write", { path: "proc://Lane/kill", i: "Killing Lane" });
	}
	if (hasToolResult(context, "task")) return { content: ["root ok"] };
	return toolCall("task", { agent: "lead", name: "Lane", task: "Do assignment Lane." });
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
		// Lane's run is force-stopped at 3 requests in the "budget" case; no budget otherwise.
		"task.agentSoftRequestBudget": { lead: laneEnd === "budget" ? 2 : 0 },
		"task.agentIdleTtlMs": options.idleTtlMs,
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
		state: { ...emptyMirrorState(), asyncWakePending: true },
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
