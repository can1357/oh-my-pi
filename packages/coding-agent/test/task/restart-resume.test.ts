/**
 * `/restart` loses no subagent. A root session spawns three subagents through the
 * real task tool (`Alpha`, `Beta`, and `Lane`, which spawns its own arm `Arm`); each
 * is inside a running `bash` call when the restart's teardown runs. The relaunch
 * (a new root session on the same file, fresh process-global registries) resumes
 * every one: each gets one restart note naming its stopped call, finishes, and its
 * result reaches its own parent as the job its first run's job was.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
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
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { collectPendingToolCalls } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import {
	RESTART_SUBAGENTS_CUSTOM_TYPE,
	recordRestartSubagents,
	resumeRestartedSubagents,
} from "@oh-my-pi/pi-coding-agent/task/restart-resume";
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
					const tail = ref.session?.sessionManager
						.getBranch()
						.filter(entry => entry.type === "message")
						.slice(-2)
						.map(entry => (entry.type === "message" ? JSON.stringify(entry.message).slice(0, 500) : ""));
					return `${ref.id} ${ref.kind} ${ref.status} ${JSON.stringify(tail)}`;
				});
			throw new Error(`Timed out waiting for ${what}; registry:\n${state.join("\n")}`);
		}
		await Bun.sleep(25);
	}
}

function inBash(id: string): boolean {
	const session = AgentRegistry.global().get(id)?.session;
	return Boolean(
		session && collectPendingToolCalls(session.sessionManager.getBranch()).some(call => call.toolName === "bash"),
	);
}

/** Runs the first process up to the restart and returns the root session file. */
async function runUntilRestart(
	open: (sessionManager: SessionManager) => Promise<AgentSession>,
	cwd: string,
	record: boolean,
): Promise<string> {
	const first = await open(SessionManager.create(cwd, path.join(root, "sessions")));
	await first.prompt("Fan out.");
	await until(() => ALL.every(inBash), "every subagent to be inside bash");
	const mainFile = first.sessionManager.getSessionFile()!;
	// What `/restart` does: record (the fix), then the teardown.
	if (record)
		expect(
			recordRestartSubagents(first)
				?.subagents.map(sub => sub.id)
				.sort(),
		).toEqual([...ALL].sort());
	await first.dispose();
	resetProcessGlobals();
	return mainFile;
}

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

			// The record is consumed: a second startup resumes nothing.
			expect(await resumeRestartedSubagents(second)).toEqual({ resumed: [], notResumed: [] });

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

it("without the restart record, no subagent continues after the relaunch (what `/restart` did before)", async () => {
	notesSeen.clear();
	const { cwd, authStorage, open } = await harness();
	try {
		const mainFile = await runUntilRestart(open, cwd, false);
		const entries = (await Bun.file(mainFile).text()).includes(RESTART_SUBAGENTS_CUSTOM_TYPE);
		expect(entries).toBe(false);
		const second = await open(await SessionManager.open(mainFile));
		try {
			expect(await resumeRestartedSubagents(second)).toEqual({ resumed: [], notResumed: [] });
			for (const id of ALL) expect(second.asyncJobManager!.getJob(id)).toBeUndefined();
			expect(notesSeen.size).toBe(0);
		} finally {
			await second.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 60_000);
