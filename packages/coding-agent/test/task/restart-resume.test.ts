/**
 * `/restart` loses no subagent. A root session spawns three subagents through the
 * real task tool (`Alpha`, `Beta`, and `Lane`, which spawns its own arm `Arm`); each
 * is inside a running `bash` call when the restart's teardown runs. The relaunch
 * (a new root session on the same file, fresh process-global registries) resumes
 * every one: each gets one restart note naming its stopped call, finishes, and its
 * result reaches its own parent as the job its first run's job was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import {
	RESTART_SUBAGENTS_CUSTOM_TYPE,
	recordRestartSubagents,
	resumeRestartedSubagents,
	transcriptWasInterrupted,
} from "@oh-my-pi/pi-coding-agent/task/restart-resume";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { StopReason } from "@oh-my-pi/pi-ai";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/restart-resume";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const RESTART_NOTE = "System note: the omp process was restarted";
/** Assignment names; a nested spawn's registry id carries its parent's (`Lane.Arm`). */
const NAMES = ["Alpha", "Beta", "Lane", "Arm"] as const;
const WORKERS = ["Alpha", "Beta", "Arm"] as const;
const ALL = ["Alpha", "Beta", "Lane", "Lane.Arm"] as const;
const nameOf = (id: string): string => id.split(".").at(-1)!;
/** Larger than the 500,000 characters a session entry keeps. */
const LONG_MESSAGE = `Queued for Alpha: ${"keep every word of this. ".repeat(24_000)}END-OF-QUEUED-MESSAGE`;

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

function resetProcessGlobals(): void {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	// The bus binds the registry it was built with; a relaunched process has a new one.
	IrcBus.resetGlobalForTests();
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restart-resume-"));
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
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

/** Which subagent a request is for: its assignment names it. */
function agentOf(context: Context): string | undefined {
	const first = context.messages.find(message => message.role === "user");
	const text = first ? textOf(first.content) : "";
	return NAMES.find(name => text.includes(`assignment ${name}.`));
}

const notesSeen = new Map<string, string>();
/** When set, Lane answers right after spawning its arm, so only the arm runs at the restart. */
let laneFinishesEarly = false;

/**
 * Root: spawn Alpha, Beta and Lane. Lane: spawn Arm, then run bash. Every worker:
 * run a long bash. After the restart note: record it and answer (`yield` when the
 * spawn has it, else its final text).
 */
function handler(context: Context) {
	const name = agentOf(context);
	if (!name) {
		const first = context.messages.find(message => message.role === "user");
		const isRoot = first !== undefined && textOf(first.content).includes("Fan out.");
		const spawned = context.messages.some(message => message.role === "toolResult" && message.toolName === "task");
		if (!isRoot || spawned) return { content: ["ok"] };
		return {
			content: (["Alpha", "Beta", "Lane"] as const).map(name => ({
				type: "toolCall" as const,
				id: `spawn-${name}`,
				name: "task",
				arguments: { agent: "worker", name, task: `Do assignment ${name}.` },
			})),
		};
	}
	// Once the note is in the conversation every answer reports the resume: a lane's
	// turn also answers its arm's result when that arrives in the same turn.
	const note = context.messages.find(
		message => message.role === "user" && textOf(message.content).includes(RESTART_NOTE),
	);
	if (note) {
		notesSeen.set(name, textOf(note.content));
		const armDone = context.messages.some(message => textOf(message.content).includes("Arm resumed"));
		const answer = `${name} resumed${armDone && name === "Lane" ? " after Arm resumed" : ""}`;
		if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: [answer] };
		return {
			content: [{ type: "toolCall" as const, name: "yield", arguments: { type: "result", data: answer } }],
		};
	}
	if (
		name === "Lane" &&
		!context.messages.some(message => message.role === "toolResult" && message.toolName === "task")
	) {
		return {
			content: [
				{
					type: "toolCall" as const,
					name: "task",
					arguments: { agent: "worker", name: "Arm", task: "Do assignment Arm." },
				},
			],
		};
	}
	if (name === "Lane" && laneFinishesEarly) {
		const armDone = context.messages.some(message => textOf(message.content).includes("Arm resumed"));
		return { content: [armDone ? "Lane received Arm resumed" : "Lane done"] };
	}
	if (!context.messages.some(message => message.role === "toolResult" && message.toolName === "bash")) {
		return {
			content: [
				{
					type: "toolCall" as const,
					name: "bash",
					arguments: { command: `echo partial-${name}; sleep 30`, i: `Running ${name} work` },
				},
			],
		};
	}
	return { content: ["waiting"] };
}

async function harness() {
	const cwd = path.join(root, "home", "work");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({ handler });
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "worker",
				description: "Worker",
				systemPrompt: "Worker",
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
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const open = async (sessionManager: SessionManager): Promise<AgentSession> => {
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(root, "home", ".omp", "agent"),
			authStorage,
			modelRegistry,
			model: mock,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["task", "wait"],
		});
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({ session, authStorage, modelRegistry, settings, enableLsp: false }),
			() => 0,
		);
		return session;
	};
	return { cwd, authStorage, mock, open };
}

/**
 * Poll real state: the subagents spawn real `bash` processes in sessions created
 * after this test starts, so there is no single event to await and fake timers
 * would not advance them.
 */
async function until(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			const state = AgentRegistry.global()
				.list()
				.map(ref => {
					const tail = ref.session?.messages.slice(-2).map(message => JSON.stringify(message).slice(0, 500));
					return `${ref.id} ${ref.kind} ${ref.status} ${JSON.stringify(tail)}`;
				});
			throw new Error(`Timed out waiting for ${what}; registry:\n${state.join("\n")}`);
		}
		await Bun.sleep(25);
	}
}

function inBash(id: string): boolean {
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) return false;
	const pending = session.agent.state.pendingToolCalls;
	return session.messages.some(
		message =>
			message.role === "assistant" &&
			message.content.some(part => part.type === "toolCall" && part.name === "bash" && pending.has(part.id)),
	);
}

/** Runs the first process up to the restart and returns the root session file. */
async function runUntilRestart(
	open: (sessionManager: SessionManager) => Promise<AgentSession>,
	cwd: string,
	record: boolean,
	running: readonly string[] = ALL,
	beforeRecord?: () => Promise<void>,
	recorded: readonly string[] = running,
): Promise<string> {
	const first = await open(SessionManager.create(cwd, path.join(root, "sessions")));
	await first.prompt("Fan out.");
	await until(() => running.every(inBash), "every subagent to be inside bash");
	if (!running.includes("Lane")) {
		await until(() => AgentRegistry.global().get("Lane")?.status === "idle", "the lane to finish");
	}
	const mainFile = first.sessionManager.getSessionFile()!;
	// A long message queued for Alpha that its stopped turn never reads; the note must carry all of it.
	await AgentRegistry.global().get("Alpha")!.session!.steer(LONG_MESSAGE);
	await beforeRecord?.();
	// What `/restart` does: record (the fix), then the teardown.
	if (record)
		expect(
			recordRestartSubagents(first)
				?.subagents.map(sub => sub.id)
				.sort(),
		).toEqual([...recorded].sort());
	await first.dispose();
	resetProcessGlobals();
	return mainFile;
}

it("names every recorded subagent whose transcript is gone instead of resuming nothing silently", async () => {
	notesSeen.clear();
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true);
		// Remove the transcripts and keep the restart's record file.
		const artifacts = mainFile.slice(0, -".jsonl".length);
		for (const name of await fs.readdir(artifacts)) {
			if (!name.startsWith("restart-subagents-"))
				await fs.rm(path.join(artifacts, name), { recursive: true, force: true });
		}
		const second = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(second);
			expect(outcome.resumed).toEqual([]);
			expect(outcome.notResumed.map(entry => entry.id).sort()).toEqual([...ALL].sort());
			for (const entry of outcome.notResumed) expect(entry.reason).toContain("transcript was not found");
		} finally {
			await second.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 60_000);

it("delivers a resumed arm's result to its lane that finished before the restart", async () => {
	notesSeen.clear();
	laneFinishesEarly = true;
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true, ["Alpha", "Beta", "Lane.Arm"]);
		const second = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(second);
			expect([...outcome.resumed].sort()).toEqual(["Alpha", "Beta", "Lane.Arm"]);
			const manager = second.asyncJobManager!;
			await manager.getJob("Lane.Arm")!.promise;
			expect(manager.getJob("Lane.Arm")!.ownerId).toBe("Lane");
			// The parked lane is revived to receive its arm's result, and answers it.
			const laneFile = AgentRegistry.global().get("Lane")!.sessionFile!;
			await until(
				() => readFileSync(laneFile, "utf8").includes("Lane received Arm resumed"),
				"the finished lane to receive its arm's result",
			);
		} finally {
			await second.dispose();
		}
	} finally {
		laneFinishesEarly = false;
		authStorage.close();
	}
}, 60_000);

it("resumes every running subagent, nested ones under their lane, after the restart teardown", async () => {
	notesSeen.clear();
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true);

		const second = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(second);
			expect(outcome.notResumed).toEqual([]);
			// Parents before children: Lane is resumed before its arm.
			expect(outcome.resumed.indexOf("Lane")).toBeLessThan(outcome.resumed.indexOf("Lane.Arm"));
			expect([...outcome.resumed].sort()).toEqual([...ALL].sort());

			const manager = second.asyncJobManager!;
			await Promise.all(ALL.map(id => manager.getJob(id)!.promise));
			for (const id of ALL) {
				const job = manager.getJob(id)!;
				expect({ id, status: job.status, error: job.errorText }).toEqual({
					id,
					status: "completed",
					error: undefined,
				});
				expect(job.resultText).toContain(`${nameOf(id)} resumed`);
			}
			expect(manager.getJob("Lane.Arm")!.ownerId).toBe("Lane");
			for (const id of ["Alpha", "Beta", "Lane"]) expect(manager.getJob(id)!.ownerId).toBe(MAIN_AGENT_ID);

			// One note each, naming the bash call the restart stopped.
			for (const name of WORKERS) expect(notesSeen.get(name)).toContain(`echo partial-${name}; sleep 30`);
			expect(notesSeen.get("Lane")).toContain("Your subagents Lane.Arm were stopped too");
			// The message queued for Alpha reaches it whole, though a session entry would cut it.
			expect(LONG_MESSAGE.length).toBeGreaterThan(500_000);
			expect(notesSeen.get("Alpha")).toContain(LONG_MESSAGE);

			// The record is consumed: a second startup resumes nothing.
			expect(await resumeRestartedSubagents(second)).toEqual({ resumed: [], notResumed: [], unreadRecords: [] });

			// Each transcript is one contiguous file: the first run's partial bash output, the note, the yield.
			for (const id of ["Alpha", "Beta", "Lane.Arm"]) {
				const ref = AgentRegistry.global().get(id)!;
				const text = await Bun.file(ref.sessionFile!).text();
				expect(text.indexOf(`partial-${nameOf(id)}`)).toBeGreaterThan(-1);
				expect(text.indexOf(RESTART_NOTE)).toBeGreaterThan(text.indexOf(`partial-${nameOf(id)}`));
			}
			// The arm's result reaches its lane, which answers it.
			const laneFile = AgentRegistry.global().get("Lane")!.sessionFile!;
			await until(
				() => readFileSync(laneFile, "utf8").includes("Lane resumed after Arm resumed"),
				"the lane to answer its arm's result",
			);
		} finally {
			await second.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 60_000);

it("records again the subagents a resume is still reviving when the next restart comes", async () => {
	notesSeen.clear();
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true);
		// Second process: the resume registers its jobs, and the next restart comes before any revival finished.
		const second = await open(await SessionManager.open(mainFile));
		expect((await resumeRestartedSubagents(second)).resumed.length).toBe(ALL.length);
		expect(notesSeen.size).toBe(0);
		expect(
			recordRestartSubagents(second)
				?.subagents.map(sub => sub.id)
				.sort(),
		).toEqual([...ALL].sort());
		await second.dispose();
		resetProcessGlobals();
		// Third process: every one goes on, with what the first restart stopped.
		const third = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(third);
			expect([...outcome.resumed].sort()).toEqual([...ALL].sort());
			await Promise.all(ALL.map(id => third.asyncJobManager!.getJob(id)!.promise));
			for (const name of WORKERS) expect(notesSeen.get(name)).toContain(`echo partial-${name}; sleep 30`);
		} finally {
			await third.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 90_000);

it("delivers a resumed arm's result to the root when its lane cannot be revived", async () => {
	notesSeen.clear();
	laneFinishesEarly = true;
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true, ["Alpha", "Beta", "Lane.Arm"]);
		// Keep only the lane transcript's header: the reviver refuses a transcript with no messages.
		const laneFile = path.join(mainFile.slice(0, -".jsonl".length), "Lane.jsonl");
		await Bun.write(laneFile, `${(await Bun.file(laneFile).text()).split("\n")[0]}\n`);
		const second = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(second);
			expect(outcome.resumed).toContain("Lane.Arm");
			const manager = second.asyncJobManager!;
			await manager.getJob("Lane.Arm")!.promise;
			const forwarded = manager
				.getAllJobs({ ownerId: MAIN_AGENT_ID })
				.find(job => job.agentId === "Lane.Arm" && job.id !== "Lane.Arm");
			expect(forwarded?.resultText).toContain("could not be revived");
			expect(forwarded?.resultText).toContain("Arm resumed");
			// The root got it, so the original result is not owed to the lane any more: a later restart must not deliver it again.
			await until(() => manager.isJobResultConsumed("Lane.Arm"), "the arm's original result to be marked read");
			const next = recordRestartSubagents(second);
			expect(next?.subagents.some(sub => sub.unreadResults.some(result => result.id === "Lane.Arm")) ?? false).toBe(
				false,
			);
		} finally {
			await second.dispose();
		}
	} finally {
		laneFinishesEarly = false;
		authStorage.close();
	}
}, 60_000);

it("resumes the healthy subagents when one transcript cannot be read, and names that one with the reason", async () => {
	notesSeen.clear();
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true);
		const alphaFile = path.join(mainFile.slice(0, -".jsonl".length), "Alpha.jsonl");
		await fs.chmod(alphaFile, 0o000);
		const second = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(second);
			expect([...outcome.resumed].sort()).toEqual(["Beta", "Lane", "Lane.Arm"]);
			expect(outcome.notResumed.map(entry => entry.id)).toEqual(["Alpha"]);
			expect(outcome.notResumed[0]!.reason).toContain("could not be read");
			await Promise.all(["Beta", "Lane", "Lane.Arm"].map(id => second.asyncJobManager!.getJob(id)!.promise));
			for (const name of ["Beta", "Arm"]) expect(notesSeen.get(name)).toContain(`echo partial-${name}`);
		} finally {
			await fs.chmod(alphaFile, 0o600);
			await second.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 60_000);

it("records an idle lane whose arm's result has not reached it when the next restart comes", async () => {
	notesSeen.clear();
	laneFinishesEarly = true;
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true, ["Alpha", "Beta", "Lane.Arm"]);
		// Second process: the arm finishes its resumed turn; the restart comes before Lane reads its result.
		const second = await open(await SessionManager.open(mainFile));
		expect((await resumeRestartedSubagents(second)).resumed).toContain("Lane.Arm");
		const manager = second.asyncJobManager!;
		await manager.getJob("Lane.Arm")!.promise;
		expect(manager.isJobResultConsumed("Lane.Arm")).toBe(false);
		const record = recordRestartSubagents(second);
		const lane = record?.subagents.find(sub => sub.id === "Lane");
		expect(lane?.idle).toBe(true);
		expect(lane?.unreadResults.map(result => result.id)).toEqual(["Lane.Arm"]);
		await second.dispose();
		resetProcessGlobals();
		// Third process: Lane reads the arm's result.
		const third = await open(await SessionManager.open(mainFile));
		try {
			expect((await resumeRestartedSubagents(third)).resumed).toContain("Lane");
			await third.asyncJobManager!.getJob("Lane")!.promise;
			expect(notesSeen.get("Lane")).toContain("while you were idle");
			expect(notesSeen.get("Lane")).toContain("Arm resumed");
		} finally {
			await third.dispose();
		}
	} finally {
		laneFinishesEarly = false;
		authStorage.close();
	}
}, 90_000);

it("records an idle lane's IRC message that no turn has taken, and the relaunched lane reads it", async () => {
	notesSeen.clear();
	laneFinishesEarly = true;
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(
			open,
			cwd,
			true,
			["Alpha", "Beta", "Lane.Arm"],
			async () => {
				// A hold (as a running delivery takes) parks a peer's message instead of waking a turn; a parent's is never held.
				const lane = AgentRegistry.global().get("Lane")!.session as AgentSession;
				lane.holdIrcWakes();
				const receipt = await IrcBus.global().send({ from: "Alpha", to: "Lane", body: "PEER-NOTE for Lane" });
				expect(JSON.stringify(receipt)).toContain("woken");
				expect(lane.peekPendingIrcMessages().length).toBe(1);
			},
			["Alpha", "Beta", "Lane", "Lane.Arm"],
		);
		const second = await open(await SessionManager.open(mainFile));
		try {
			expect((await resumeRestartedSubagents(second)).resumed).toContain("Lane");
			await second.asyncJobManager!.getJob("Lane")!.promise;
			expect(notesSeen.get("Lane")).toContain("PEER-NOTE for Lane");
		} finally {
			await second.dispose();
		}
	} finally {
		laneFinishesEarly = false;
		authStorage.close();
	}
}, 60_000);

it("keeps a record whose file cannot be read for the next start instead of consuming it", async () => {
	notesSeen.clear();
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true);
		const artifacts = mainFile.slice(0, -".jsonl".length);
		const recordFile = path.join(
			artifacts,
			(await fs.readdir(artifacts)).find(name => name.startsWith("restart-subagents-"))!,
		);
		await fs.chmod(recordFile, 0o000);
		const second = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(second);
			expect(outcome.resumed).toEqual([]);
			expect(outcome.unreadRecords.map(entry => entry.file)).toEqual([path.basename(recordFile)]);
			expect(outcome.notResumed.map(entry => entry.id).sort()).toEqual([...ALL].sort());
		} finally {
			await fs.chmod(recordFile, 0o600);
			await second.dispose();
			resetProcessGlobals();
		}
		const third = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(third);
			expect([...outcome.resumed].sort()).toEqual([...ALL].sort());
			expect(outcome.unreadRecords).toEqual([]);
		} finally {
			await third.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 90_000);

it("delivers to the root the result an idle lane carried when the lane cannot be resumed", async () => {
	notesSeen.clear();
	laneFinishesEarly = true;
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true, ["Alpha", "Beta", "Lane.Arm"]);
		// Second process: the arm's resumed turn finishes; the next restart comes before Lane reads its result.
		const second = await open(await SessionManager.open(mainFile));
		expect((await resumeRestartedSubagents(second)).resumed).toContain("Lane.Arm");
		await second.asyncJobManager!.getJob("Lane.Arm")!.promise;
		expect(recordRestartSubagents(second)?.subagents.find(sub => sub.id === "Lane")?.idle).toBe(true);
		await second.dispose();
		resetProcessGlobals();
		// Lane's transcript is gone before the third start, so Lane cannot go on.
		await fs.rm(path.join(mainFile.slice(0, -".jsonl".length), "Lane.jsonl"), { force: true });
		const third = await open(await SessionManager.open(mainFile));
		try {
			const outcome = await resumeRestartedSubagents(third);
			expect(outcome.notResumed.map(entry => entry.id)).toContain("Lane");
			const forwarded = third
				.asyncJobManager!.getAllJobs({ ownerId: MAIN_AGENT_ID })
				.find(job => job.agentId === "Lane");
			expect(forwarded?.resultText).toContain("transcript was not found");
			expect(forwarded?.resultText).toContain("Arm resumed");
		} finally {
			await third.dispose();
		}
	} finally {
		laneFinishesEarly = false;
		authStorage.close();
	}
}, 90_000);

describe("transcriptWasInterrupted", () => {
	const assistant = (stopReason: StopReason, toolCall = false): SessionEntry =>
		({
			type: "message",
			id: "a",
			parentId: null,
			timestamp: "",
			message: {
				role: "assistant",
				content: toolCall
					? [{ type: "toolCall", id: "c", name: "bash", arguments: {} }]
					: [{ type: "text", text: "x" }],
				stopReason,
			},
		}) as unknown as SessionEntry;
	const toolResult = (toolName: string, isError: boolean): SessionEntry =>
		({
			type: "message",
			id: "t",
			parentId: null,
			timestamp: "",
			message: { role: "toolResult", toolCallId: "c", toolName, content: [], isError },
		}) as unknown as SessionEntry;

	it("counts only a final answer or an accepted yield as finished", () => {
		// A failed turn is what a provider retry was waiting to repeat: it did not finish.
		expect(transcriptWasInterrupted([assistant("error")])).toBe(true);
		expect(transcriptWasInterrupted([assistant("length")])).toBe(true);
		expect(transcriptWasInterrupted([assistant("aborted")])).toBe(true);
		expect(transcriptWasInterrupted([assistant("toolUse", true)])).toBe(true);
		expect(transcriptWasInterrupted([toolResult("bash", false)])).toBe(true);
		expect(transcriptWasInterrupted([toolResult("yield", true)])).toBe(true);
		expect(transcriptWasInterrupted([assistant("stop")])).toBe(false);
		expect(transcriptWasInterrupted([toolResult("yield", false)])).toBe(false);
	});
});

it("delivers to the root what a subagent carried when its revival fails after the record is consumed", async () => {
	notesSeen.clear();
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, true);
		const second = await open(await SessionManager.open(mainFile));
		try {
			const lifecycle = AgentLifecycleManager.global();
			const ensureLive = lifecycle.ensureLive.bind(lifecycle);
			vi.spyOn(lifecycle, "ensureLive").mockImplementation(async id => {
				if (id === "Alpha") throw new Error("revival failed for the test");
				return ensureLive(id);
			});
			expect((await resumeRestartedSubagents(second)).resumed).toContain("Alpha");
			const manager = second.asyncJobManager!;
			await manager.getJob("Alpha")!.promise.catch(() => undefined);
			expect(manager.getJob("Alpha")!.status).toBe("failed");
			// Alpha never read the message queued for it; the root has it whole, with the reason.
			const forwarded = manager
				.getAllJobs({ ownerId: MAIN_AGENT_ID })
				.find(job => job.agentId === "Alpha" && job.id !== "Alpha");
			expect(forwarded?.resultText).toContain("before the restart note reached it");
			expect(forwarded?.resultText).toContain(LONG_MESSAGE);
			expect(notesSeen.has("Alpha")).toBe(false);
		} finally {
			await second.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 90_000);

it("without the restart record, no subagent continues after the relaunch (what `/restart` did before)", async () => {
	notesSeen.clear();
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, false);
		const entries = (await Bun.file(mainFile).text()).includes(RESTART_SUBAGENTS_CUSTOM_TYPE);
		expect(entries).toBe(false);
		const second = await open(await SessionManager.open(mainFile));
		try {
			expect(await resumeRestartedSubagents(second)).toEqual({ resumed: [], notResumed: [], unreadRecords: [] });
			for (const id of ALL) expect(second.asyncJobManager!.getJob(id)).toBeUndefined();
			expect(notesSeen.size).toBe(0);
		} finally {
			await second.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 60_000);
