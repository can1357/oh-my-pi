/**
 * Subagent runs routed into pooled worker threads, end to end: a real worker on the
 * direct-module entry with every thread service, a real child `AgentSession` homed there,
 * and a scripted OpenAI-compatible server the worker's model registry finds through
 * `models.yml` (the worker mirror re-reads it, so no spies reach into the worker).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, logger, removeWithRetries } from "@oh-my-pi/pi-utils";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import { CostGate } from "../../src/session/cost-gate";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "../../src/task/executor";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import { type AgentDefinition, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL = "fake/fake-model";
const TEST_TIMEOUT_MS = 120_000;

interface ChatMessage {
	role: string;
	content?: unknown;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

function isChatMessage(value: unknown): value is ChatMessage {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "role") === "string";
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function chunks(reply: Reply): string {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const delta =
		"text" in reply
			? { role: "assistant", content: reply.text }
			: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call_${reply.tool}`,
							type: "function",
							function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
						},
					],
				};
	const frames = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

/**
 * Scripted model, by the conversation's last user message: `bg_job` → an async `bash`
 * call; `hang` → no answer until the request is aborted; anything else (including the
 * job's completion notice) → `pong`. A tool result is answered with `tool said: …`.
 */
class FakeModelServer {
	readonly #server: Bun.Server<undefined>;
	readonly #hangs: Array<() => void> = [];
	#hungRequest = Promise.withResolvers<void>();

	constructor() {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => this.#fetch(request),
		});
	}

	get port(): number {
		return this.#server.port ?? 0;
	}

	/** Resolves once a `hang` request is being held. */
	hung(): Promise<void> {
		return this.#hungRequest.promise;
	}

	async writeModelsYml(agentDir: string): Promise<string> {
		const file = path.join(agentDir, "models.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  fake:",
				`    baseUrl: http://127.0.0.1:${this.port}/v1`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"        cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }",
				"",
			].join("\n"),
		);
		return file;
	}

	stop(): void {
		for (const release of this.#hangs.splice(0)) release();
		this.#server.stop(true);
	}

	async #fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
		}
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body: unknown = await request.json();
		const rawMessages: unknown =
			typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
		const messages = Array.isArray(rawMessages) ? rawMessages.filter(isChatMessage) : [];
		const last = messages.at(-1);
		const lastUser = messages.findLast(message => message.role === "user");
		const userText = lastUser ? messageText(lastUser.content) : "";
		let reply: Reply = { text: "pong" };
		if (last?.role === "tool") {
			reply = { text: `tool said: ${messageText(last.content)}` };
		} else if (userText.includes("bg_job")) {
			reply = { tool: "bash", args: { command: "echo bg-done", async: true } };
		} else if (userText.includes("hang")) {
			const held = Promise.withResolvers<void>();
			this.#hangs.push(held.resolve);
			request.signal.addEventListener("abort", () => held.resolve(), { once: true });
			this.#hungRequest.resolve();
			await held.promise;
			this.#hungRequest = Promise.withResolvers<void>();
		}
		return new Response(chunks(reply), { headers: { "content-type": "text/event-stream" } });
	}
}

/** Poll a condition fed by another thread; waits on the condition itself, never a guessed duration. */
async function waitFor(check: () => boolean, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function mirrorOf(session: AgentSessionHandle | null | undefined): RemoteAgentSession {
	if (!(session instanceof RemoteAgentSession)) throw new Error("expected a worker-homed session mirror on main");
	return session;
}

const AGENT: AgentDefinition = {
	name: "task",
	description: "routing test agent",
	systemPrompt: "You are a test agent.",
	source: "bundled",
	tools: ["read", "bash"],
};

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined> = {};
let server: FakeModelServer;
let pool: SubagentWorkerPool;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;
let jobs: AsyncJobManager;
let costGate: CostGate;
let eventBus: EventBus;
let lifecycleStatuses: Array<{ id: string; status: string }>;
const cleanups: Array<() => unknown> = [];

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-routing-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	cwd = path.join(root, "work");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	// Workers read these at start-up, so set them before the pool spawns any.
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();

	server = new FakeModelServer();
	const modelsPath = await server.writeModelsYml(agentDir);
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"async.enabled": true,
		modelRoles: { default: MODEL },
	});
	jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	costGate = new CostGate(settings, 0, () => {});
	eventBus = new EventBus();
	lifecycleStatuses = [];
	eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
		if (typeof payload !== "object" || payload === null) return;
		lifecycleStatuses.push({
			id: String(Reflect.get(payload, "id")),
			status: String(Reflect.get(payload, "status")),
		});
	});
	// Every run goes to a worker here (no concurrency needed); placement itself is covered in subagent-worker.test.ts.
	pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 600_000,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000 },
	});
	setSubagentWorkerPoolForTests(pool);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await AgentLifecycleManager.global().dispose();
	setSubagentWorkerPoolForTests(undefined);
	pool.dispose();
	server.stop();
	await jobs.dispose({ timeoutMs: 1_000 });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	authStorage.close();
	AgentStorage.close();
	closeModelCache();
	for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

function runOptions(id: string, task: string, extra: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd,
		agent: AGENT,
		task,
		index: 0,
		id,
		description: `routing ${id}`,
		modelOverride: MODEL,
		structured: false,
		settings,
		authStorage,
		modelRegistry,
		costGate,
		asyncJobManager: jobs,
		eventBus,
		artifactsDir: path.join(root, "artifacts"),
		enableLsp: false,
		enableMCP: false,
		taskDepth: 0,
		...extra,
	};
}

/** A real main-thread root session, as main.ts hands the persisted reviver factory. */
function rootSession(): AgentSession {
	const model = modelRegistry.find("fake", "fake-model");
	if (!model) throw new Error("fake model missing from the main registry");
	const agent = new Agent({ initialState: { model, systemPrompt: ["root"], tools: [] }, convertToLlm });
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		modelRegistry,
		agentId: MAIN_AGENT_ID,
	});
	cleanups.push(() => session.dispose());
	return session;
}

describe("subagent runs routed into pooled workers", () => {
	it(
		"warms a worker with a throwaway session sealed off from main, then runs subagents there",
		async () => {
			const failures: string[] = [];
			const unregister = logger.registerLogSink(event => {
				if (event.message.startsWith("Subagent worker warm-up")) failures.push(event.message);
			});
			cleanups.push(unregister);
			const lease = await pool.acquire();
			const worker = lease.worker;
			if (!worker) throw new Error("the pool kept the run on the main thread");
			try {
				await worker.link.call("warmUp", { cwd, settings, modelRegistry });
			} finally {
				lease.release();
			}
			expect(failures).toEqual([]);
			// The warm-up session registered only in its private registry.
			expect(AgentRegistry.global().list()).toEqual([]);
			const result = await runSubprocess(runOptions("AfterWarmUp", "ping"));
			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			expect(mirrorOf(AgentRegistry.global().get("AfterWarmUp")?.session).home).toBe(worker.threadId);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps a lone spawn on the main thread under the default policy, counted while it runs",
		async () => {
			const mainPool = new SubagentWorkerPool({ maxWorkers: () => 4, idleMs: 600_000 });
			setSubagentWorkerPoolForTests(mainPool);
			cleanups.push(() => mainPool.dispose());
			let countedWhileRunning = 0;
			const result = await runSubprocess(
				runOptions("OnMain", "ping", {
					onProgress: () => {
						countedWhileRunning = Math.max(countedWhileRunning, mainPool.mainRuns);
					},
				}),
			);
			expect(result.output).toBe("pong");
			expect(AgentRegistry.global().get("OnMain")?.session).toBeInstanceOf(AgentSession);
			expect(mainPool.workers()).toEqual([]);
			expect(countedWhileRunning).toBe(1);
			expect(mainPool.runsInFlight).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs the child in a worker: main mirror, result, progress, lifecycle frames, cost, async jobs",
		async () => {
			const progress: AgentProgress[] = [];
			const result = await runSubprocess(runOptions("Bg", "bg_job", { onProgress: p => progress.push(p) }));

			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			// bash call → its "backgrounded" result → the job's completion notice → final answer.
			expect(result.output).toBe("pong");
			expect(result.requests).toBe(3);
			// The child stays adopted and live in its worker; main holds its mirror.
			const ref = AgentRegistry.global().get("Bg");
			const mirror = mirrorOf(ref?.session);
			expect(pool.forThread(mirror.home)?.alive).toBe(true);
			expect(mirror.instanceKey.startsWith(`${mirror.home}:`)).toBe(true);
			expect(progress.length).toBeGreaterThan(0);
			expect(progress.at(-1)?.status).toBe("completed");
			expect(lifecycleStatuses.filter(frame => frame.id === "Bg").map(frame => frame.status)).toEqual([
				"started",
				"completed",
			]);
			// The requests' cost landed on main's gate.
			expect(costGate.spent).toBeGreaterThan(0);
			// The async bash job the child started ran as a row of main's manager.
			const bash = jobs.getAllJobs().filter(job => job.type === "bash");
			expect(bash.map(job => job.status)).toEqual(["completed"]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"clears a finished worker-homed child's ircWakesPending on main, so its idle TTL can park it",
		async () => {
			const result = await runSubprocess(runOptions("Parkable", "ping"));
			expect(result.output).toBe("pong");
			const mirror = mirrorOf(AgentRegistry.global().get("Parkable")?.session);
			// The run's IRC wake hold is released after the result without a session event.
			await waitFor(() => !mirror.ircWakesPending);
			await AgentLifecycleManager.global().park("Parkable");
			expect(AgentRegistry.global().get("Parkable")?.status).toBe("parked");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"aborts the worker run when main's signal aborts",
		async () => {
			const controller = new AbortController();
			const running = runSubprocess(runOptions("Hang", "hang", { signal: controller.signal }));
			await server.hung();
			controller.abort(new Error("stop from main"));
			const result = await running;
			expect(result.aborted).toBe(true);
			expect(result.exitCode).not.toBe(0);
			expect(lifecycleStatuses.filter(frame => frame.id === "Hang").at(-1)?.status).toBe("aborted");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"revives a parked worker-homed child in a worker for a follow-up turn and for an IRC message",
		async () => {
			const first = await runSubprocess(runOptions("Parked", "ping"));
			expect(first.output).toBe("pong");
			const lifecycle = AgentLifecycleManager.global();
			await lifecycle.park("Parked");
			const parked = AgentRegistry.global().get("Parked");
			expect(parked?.status).toBe("parked");
			expect(parked?.session).toBeNull();

			// Warm revive: the worker's reviver crossed to main's lifecycle as a function.
			const followUp = await runSubagentFollowUpTurn({
				id: "Parked",
				agent: AGENT,
				message: "again",
				structured: false,
			});
			expect(followUp.error).toBeUndefined();
			expect(followUp.output).toBe("pong");
			const revived = mirrorOf(AgentRegistry.global().get("Parked")?.session);
			expect(pool.forThread(revived.home)?.alive).toBe(true);

			await lifecycle.park("Parked");
			expect(AgentRegistry.global().get("Parked")?.status).toBe("parked");
			const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: "Parked", body: "hello from main" });
			expect(receipt.outcome).toBe("revived");
			const woken = mirrorOf(AgentRegistry.global().get("Parked")?.session);
			expect(woken).not.toBe(revived);
			expect(pool.forThread(woken.home)?.alive).toBe(true);
			// Let the wake turn settle before teardown.
			await waitFor(() => !woken.isStreaming && !woken.ircWakesPending);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"fails a first run whose worker dies mid-run instead of hanging, naming the worker",
		async () => {
			const running = runSubprocess(runOptions("Lost", "hang"));
			await server.hung();
			const [worker] = pool.workers();
			if (!worker) throw new Error("no pooled worker");
			worker.terminate("worker crashed: boom");
			const result = await running;
			expect(result.exitCode).toBe(1);
			expect(result.error).toBe(`Subagent worker ${worker.threadId} exited mid-run: worker crashed: boom`);
			const ref = AgentRegistry.global().get("Lost");
			expect(ref?.session).toBeNull();
			// Its transcript survives: the ref stays revivable through the persisted factory.
			expect(ref?.status).toBe("parked");
			expect(lifecycleStatuses.filter(frame => frame.id === "Lost").map(frame => frame.status)).toEqual([
				"started",
				"failed",
			]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"fails a turn whose worker dies with an error naming it, and cold-revives the agent in a new worker",
		async () => {
			const first = await runSubprocess(runOptions("Crash", "ping"));
			expect(first.output).toBe("pong");
			const home = mirrorOf(AgentRegistry.global().get("Crash")?.session).home;
			const worker = pool.forThread(home);
			if (!worker) throw new Error("home worker missing");

			const turn = runSubagentFollowUpTurn({ id: "Crash", agent: AGENT, message: "hang", structured: false });
			await server.hung();
			worker.terminate("worker crashed: boom");
			const failed = await turn;
			expect(failed.exitCode).toBe(1);
			expect(failed.error).toContain(`Subagent worker ${home}`);
			expect(failed.error).toContain("boom");
			const ref = AgentRegistry.global().get("Crash");
			expect(ref?.status).toBe("parked");
			expect(ref?.session).toBeNull();

			// The warm reviver died with its worker; the persisted factory revives into the pool.
			const lifecycle = AgentLifecycleManager.global();
			lifecycle.setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session: rootSession(),
					authStorage,
					modelRegistry,
					settings,
					enableLsp: false,
					eventBus,
				}),
				() => 0,
			);
			const revived = mirrorOf(await lifecycle.ensureLive("Crash"));
			expect(revived.home).not.toBe(home);
			expect(pool.forThread(revived.home)?.alive).toBe(true);
			expect(AgentRegistry.global().get("Crash")?.session).toBe(revived);
			const again = await runSubagentFollowUpTurn({
				id: "Crash",
				agent: AGENT,
				message: "again",
				structured: false,
			});
			expect(again.output).toBe("pong");
		},
		TEST_TIMEOUT_MS,
	);
});
