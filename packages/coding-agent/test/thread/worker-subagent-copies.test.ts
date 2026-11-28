/**
 * How many copies of a worker subagent's context main and its worker hold.
 * A real child `AgentSession` homed on a pooled worker (the direct-module entry, wrapped by the heap fixture),
 * watched from main as a focused view watches it, runs bash calls that each print a text of its own, against a
 * scripted OpenAI-compatible server. Near the end of its run a heap snapshot of each thread counts the copies of
 * those texts; once it is parked and its worker has stopped, main's snapshot shows what main keeps of it. Each case
 * has its own timeout, which bounds its waits; the last cases check the test's own setup, teardown and controls.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	isRecord,
	prompt,
	removeWithRetries,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import { CostGate } from "../../src/session/cost-gate";
import { type ExecutorOptions, runSubprocess } from "../../src/task/executor";
import type { SingleResult } from "../../src/task/task-details";
import type { AgentDefinition } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import {
	type SubagentPlacement,
	type SubagentWorker,
	SubagentWorkerPool,
	setSubagentWorkerPoolForTests,
} from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import type { SubagentHeapRequest, SubagentHeapWritten } from "../fixtures/subagent-heap-hook";
import { Cleanups, runEach } from "../helpers/cleanup";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	collectGarbage,
	HeapGraph,
	parseV8HeapSnapshot,
	takeV8HeapSnapshot,
	type V8HeapSnapshot,
} from "../helpers/heap-snapshot";
import { rejectionMessage } from "../helpers/rejection";
import agentPromptTemplate from "./fixtures/worker-subagent-copies-agent.md" with { type: "text" };

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL = "fake/fake-model";
const TEST_TIMEOUT_MS = 300_000;
const SCRIPT_ID = Bun.randomUUIDv7("hex");
/** In the routed agent's system prompt only, so a request without it is never the run's own turn. */
const AGENT_MARKER = `omp-test-agent-${SCRIPT_ID}`;
const TASK = `omp-test-copies-${SCRIPT_ID}`;
const AGENT_ID = "CopiesProbe";
/** The run's bash calls; each prints a text no other call prints. */
const RESULTS = 20;
/** Lines of each printed text: 512 lines of 80 characters and a newline, 40.5 KiB. */
const LINES = 512;
const LINE_CHARS = 80;
/** Bytes of the run's printed texts together: one copy of the context this test counts. */
const CONTEXT_BYTES = RESULTS * LINES * (LINE_CHARS + 1);
/** At most this many copies of the context, across both heaps, while the subagent still runs. */
const MAX_COPIES = 5;
/**
 * At least this many copies in each heap while the subagent still runs: the worker runs on the context and main
 * mirrors it, so a heap that counts fewer is a snapshot search that missed the payload, not a heap without it.
 */
const MIN_HEAP_COPIES = 1;
/** Every line of every printed text starts with `P<seed>:`; the test builds that marker only to search a snapshot. */
const PAYLOAD_SEED = crypto.randomBytes(8).toString("hex");
/** Named in `test/fixtures/subagent-heap-hook.ts`, which listens on it in each worker. */
const HEAP_CHANNEL = "omp-test-subagent-heap";

/** The cap of each poll of a condition another thread feeds; the case's own timeout bounds every other wait. */
const POLL_MS = 60_000;
/** The timeout of each case's setup: far past what it takes (temp files, a model server, a catalog refresh). */
const SETUP_TIMEOUT_MS = 60_000;
/** The timeout of each case's teardown, its cleanup reserve: far past what it takes. */
const TEARDOWN_TIMEOUT_MS = 60_000;
/** For the case's run to settle once teardown stopped its worker. */
const RUN_SETTLE_MS = 10_000;

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

function payloadFile(index: number): string {
	return `payload-${String(index).padStart(2, "0")}.txt`;
}

/** Write the texts the run's bash calls print; none of them stays referenced here. */
async function writePayloads(dir: string): Promise<void> {
	for (let index = 0; index < RESULTS; index++) {
		const lines: string[] = [];
		for (let line = 0; line < LINES; line++) {
			const head = `P${PAYLOAD_SEED}:${index}:${line}:`;
			lines.push(
				head +
					crypto
						.randomBytes(LINE_CHARS)
						.toString("base64url")
						.slice(0, LINE_CHARS - head.length),
			);
		}
		await Bun.write(path.join(dir, payloadFile(index)), `${lines.join("\n")}\n`);
	}
}

type Reply = { text: string } | { callId: string; command: string };

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
							id: reply.callId,
							type: "function",
							function: { name: "bash", arguments: JSON.stringify({ command: reply.command }) },
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

/** What one request asks of the scripted model, read from its body so the body is not kept while a reply waits. */
type Turn = { kind: "side" } | { kind: "call"; index: number } | { kind: "final"; resultLengths: number[] };

/**
 * Scripted model. The routed agent's own turns (their system prompt carries {@link AGENT_MARKER}) call bash on
 * the next payload file until {@link RESULTS} results are in; the turn after the last one is held until
 * {@link release}, so the test reads both heaps near the end of the run. Everything else → `pong`.
 */
class CopiesModelServer {
	readonly #server: Bun.Server<undefined>;
	readonly #finalHeld = Promise.withResolvers<number[]>();
	readonly #release = Promise.withResolvers<void>();
	#stopped = false;

	constructor() {
		// No idle timeout: the held final response may wait on slow heap snapshots and walks for well over Bun's
		// default of 10 seconds, and a reset connection would end the run before the test releases it.
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch: request => this.#fetch(request),
		});
	}

	/** Resolves, with the text length of each tool result the model received, once the final turn is held. */
	finalHeld(): Promise<number[]> {
		return this.#finalHeld.promise;
	}

	release(): void {
		this.#release.resolve();
	}

	/** The OpenAI-compatible base URL of the scripted provider. */
	get baseUrl(): string {
		return `http://127.0.0.1:${this.#server.port}/v1`;
	}

	async writeModelsYml(agentDir: string): Promise<string> {
		const file = path.join(agentDir, "models.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  fake:",
				`    baseUrl: ${this.baseUrl}`,
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

	/** Let a held final response go and close the server; a second call does nothing. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#release.resolve();
		this.#server.stop(true);
	}

	async #fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
		}
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const turn = await this.#turn(request);
		let reply: Reply = { text: "pong" };
		if (turn.kind === "call") {
			reply = { callId: `call_${turn.index}`, command: `cat ${payloadFile(turn.index)}` };
		} else if (turn.kind === "final") {
			this.#finalHeld.resolve(turn.resultLengths);
			await this.#release.promise;
			reply = { text: "copied" };
		}
		return new Response(chunks(reply), { headers: { "content-type": "text/event-stream" } });
	}

	async #turn(request: Request): Promise<Turn> {
		const body: unknown = await request.json();
		const rawMessages: unknown =
			typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
		const messages = Array.isArray(rawMessages) ? rawMessages.filter(isChatMessage) : [];
		const systemText = messages
			.filter(message => message.role === "system" || message.role === "developer")
			.map(message => messageText(message.content))
			.join("\n");
		const userText = messages
			.filter(message => message.role === "user")
			.map(message => messageText(message.content))
			.join("\n");
		if (!systemText.includes(AGENT_MARKER) || !userText.includes(TASK)) return { kind: "side" };
		const results = messages.filter(message => message.role === "tool");
		if (results.length < RESULTS) return { kind: "call", index: results.length };
		return { kind: "final", resultLengths: results.map(message => messageText(message.content).length) };
	}
}

/**
 * The first value `find` returns, polled every 10 ms: fails, naming `label`, after `timeoutMs`, and stops once
 * `signal` aborts. `find` reads what another thread feeds, so this waits on the value itself, never a guessed
 * duration.
 */
async function poll<T>(
	label: string,
	find: () => T | undefined,
	signal?: AbortSignal,
	timeoutMs = POLL_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = find();
		if (found !== undefined) return found;
		signal?.throwIfAborted();
		if (Date.now() > deadline) throw new Error(`${label}: not met within ${timeoutMs} ms`);
		await Bun.sleep(10);
	}
}

/** Poll a condition fed by another thread until it holds; fails, naming `label`, after {@link POLL_MS}. */
async function waitFor(label: string, check: () => boolean): Promise<void> {
	await poll(label, () => (check() ? true : undefined));
}

/**
 * Ask the worker `threadId` (through the heap fixture) for a heap snapshot of its thread, replied within `replyMs`
 * when given. The file is in {@link acquired} from the request on, and closing the channel in {@link cleanups} from
 * its opening, so teardown removes the one and closes the other whatever fails here.
 */
async function workerSnapshot(threadId: string, file: string, replyMs?: number): Promise<V8HeapSnapshot> {
	const files = (acquired.snapshotFiles ??= new Set());
	files.add(file);
	const channel = new BroadcastChannel(HEAP_CHANNEL);
	let open = true;
	/** Close the channel; a second call does nothing. */
	const close = (): void => {
		if (!open) return;
		open = false;
		channel.close();
	};
	cleanups.add(close);
	try {
		const written = Promise.withResolvers<void>();
		channel.onmessage = event => {
			const data: Partial<SubagentHeapWritten> | null = typeof event.data === "object" ? event.data : null;
			if (data?.written === file) written.resolve();
		};
		const request: SubagentHeapRequest = { path: file, threadId };
		channel.postMessage(request);
		await (replyMs === undefined
			? written.promise
			: withTimeout(
					written.promise,
					replyMs,
					`snapshot reply from worker ${threadId}: missed its ${replyMs} ms deadline`,
				));
	} finally {
		close();
	}
	try {
		return parseV8HeapSnapshot(JSON.parse(await Bun.file(file).text()));
	} finally {
		await fs.rm(file, { force: true });
		files.delete(file);
	}
}

/**
 * Holds, on main, a worker's reply to main's `runSubprocess` call that carries a run result with `output`: the
 * worker ended the run, its final response consumed whole, and sent the result, but main's caller does not get it
 * until {@link release}, which teardown calls. It watches the workers `pool` places runs on.
 */
class RunReplyHold {
	readonly #output: string;
	readonly #held = Promise.withResolvers<void>();
	readonly #released = Promise.withResolvers<void>();

	constructor(output: string, pool: SubagentWorkerPool) {
		this.#output = output;
		const place = pool.place;
		Object.defineProperty(pool, "place", {
			configurable: true,
			value: (): SubagentPlacement => {
				const placement: SubagentPlacement = Reflect.apply(place, pool, []);
				if (placement.worker) this.#watch(placement.worker);
				return placement;
			},
		});
	}

	/** Resolves once main got the reply and held it. */
	held(): Promise<void> {
		return this.#held.promise;
	}

	/** Let the held reply through to main's caller. */
	release(): void {
		this.#released.resolve();
	}

	/** Hold, on `worker`'s link, the reply that carries the result. */
	#watch(worker: SubagentWorker): void {
		const link = worker.link;
		const call = link.call;
		Object.defineProperty(link, "call", {
			configurable: true,
			value: async (method: string, ...args: unknown[]): Promise<unknown> => {
				const result: unknown = await Reflect.apply(call, link, [method, ...args]);
				if (method !== "runSubprocess" || !isRecord(result) || result.output !== this.#output) return result;
				this.#held.resolve();
				await this.#released.promise;
				return result;
			},
		});
	}
}

/** Object kinds a retainer path names its holder by; anything else is a plain container on the way. */
function isNamedHolder(graph: HeapGraph, node: number): boolean {
	const type = graph.type(node);
	if (type === "closure") return true;
	if (type !== "object") return false;
	const name = graph.name(node);
	return name !== "" && name !== "Object" && name !== "Array" && !name.startsWith("system /");
}

interface ThreadCopies {
	readonly thread: string;
	readonly copies: number;
	/** Copies by retainer path, most first. */
	readonly holders: ReadonlyArray<{ readonly holder: string; readonly copies: number }>;
}

/**
 * The copies of the run's printed texts in `graph`: the characters of every distinct string node whose text
 * (its first 1024 characters, all the snapshot keeps) holds the payload marker, over {@link CONTEXT_BYTES}. A
 * string two holders share is one node, counted once; a piece of a text counts for its share. A snapshot with no
 * string text to search is an error, never zero copies.
 */
function payloadCopies(thread: string, graph: HeapGraph): ThreadCopies {
	const marker = `P${PAYLOAD_SEED}:`;
	let searched = 0;
	const nodes = graph.stringNodes(text => {
		if (text !== "") searched++;
		return text.includes(marker);
	});
	if (searched === 0) throw new Error(`${thread}: the heap snapshot has no string text to search for the payload`);
	const paths = graph.retainerPaths(nodes, node => isNamedHolder(graph, node));
	const byHolder = new Map<string, number>();
	let bytes = 0;
	for (const node of nodes) {
		const size = graph.selfSize(node);
		bytes += size;
		const holder = paths.get(node) ?? "?";
		byHolder.set(holder, (byHolder.get(holder) ?? 0) + size);
	}
	return {
		thread,
		copies: bytes / CONTEXT_BYTES,
		holders: [...byHolder]
			.map(([holder, held]) => ({ holder, copies: held / CONTEXT_BYTES }))
			.sort((a, b) => b.copies - a.copies),
	};
}

/** `title`, the copies of all `threads` together, then each thread's copies by holder. */
function copiesReport(title: string, threads: readonly ThreadCopies[]): string {
	const total = threads.reduce((sum, thread) => sum + thread.copies, 0);
	const lines = [`${title}: ${total.toFixed(2)} copies of the worker subagent's context`];
	for (const thread of threads) {
		lines.push(`  ${thread.thread}: ${thread.copies.toFixed(2)}`);
		for (const { holder, copies } of thread.holders) lines.push(`    ${copies.toFixed(2)}  ${holder}`);
	}
	return lines.join("\n");
}

/** Object kinds whose edges hold a run's behaviour or state rather than a record's data. */
function isRunObject(graph: HeapGraph, node: number): boolean {
	const type = graph.type(node);
	if (type === "closure") return true;
	if (type !== "object") return false;
	const name = graph.name(node);
	return name === "Map" || name === "Set" || name === "WeakMap" || name === "WeakSet";
}

/**
 * What main's registry record of the agent reaches as data: its own properties and elements, followed into plain
 * objects and arrays. Accessor pairs (how a minted ref derives `sessionFile` from its data) and object shapes are
 * the record's form, not data it holds, so the walk does not enter them.
 */
function recordRunObjects(graph: HeapGraph, record: number): string[] {
	const reached = graph.reachable(record, node => {
		const type = graph.type(node);
		return type !== "code" && type !== "object shape" && !isRunObject(graph, node);
	});
	return reached
		.filter(node => node !== record && isRunObject(graph, node))
		.map(node => `${graph.type(node)} ${graph.name(node)}`);
}

const AGENT: AgentDefinition = {
	name: "task",
	description: "copies test agent",
	systemPrompt: prompt.render(agentPromptTemplate, { marker: AGENT_MARKER }),
	source: "bundled",
	tools: ["bash"],
};

/** What a test's setup acquired; each is set once acquired, and {@link tearDown} releases exactly those. */
interface Acquired {
	/** Each of {@link ENV_KEYS} as it was before setup changed it. */
	env: Record<string, string | undefined>;
	root: string;
	server: CopiesModelServer;
	authStorage: AuthStorage;
	jobs: AsyncJobManager;
	pool: SubagentWorkerPool;
	/** The case's run; teardown waits for it to settle once it stopped its worker. */
	run: Promise<RunEnd>;
	/** Heap snapshot files a worker was asked to write and the test has not removed yet. */
	snapshotFiles: Set<string>;
	/** A held reply of the run's worker; teardown lets it through first. */
	replyHold: RunReplyHold;
}

let acquired: Partial<Acquired> = {};
let cwd: string;
let modelRegistry: ModelRegistry;
let settings: Settings;

/** `acquired[key]`, which a run needs setup to have acquired. */
function need<K extends keyof Acquired>(key: K): Acquired[K] {
	const value = acquired[key];
	if (value === undefined) throw new Error(`setup has not acquired ${key}`);
	return value;
}

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

/**
 * A temp home and work dir holding the payloads, the environment pointed at them, the scripted model server, the
 * job manager and the worker pool, each recorded in {@link acquired} as soon as it is acquired.
 */
async function setUp(): Promise<void> {
	acquired.env = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-subagent-copies-"));
	acquired.root = root;
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	cwd = path.join(root, "work");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await writePayloads(cwd);
	// Workers read these at start-up, so set them before the pool spawns any.
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();

	const server = new CopiesModelServer();
	acquired.server = server;
	const modelsPath = await server.writeModelsYml(agentDir);
	const authStorage = createInMemoryAuthStorage();
	acquired.authStorage = authStorage;
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	settings = Settings.isolated({
		// Parks the child soon after its run, so the test reaches the parked state without a long wait.
		"task.agentIdleTtlMs": 300,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"async.enabled": true,
		modelRoles: { default: MODEL },
	});
	acquired.jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	// Every run goes to the one worker, which stops soon after its last session is gone.
	const pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 300,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000, entry: new URL("../fixtures/subagent-heap-worker.ts", import.meta.url) },
	});
	acquired.pool = pool;
	setSubagentWorkerPoolForTests(pool);
}

/** What a case acquired outside {@link acquired}, each released on its own by {@link tearDown}, newest first. */
const cleanups = new Cleanups();

/**
 * Release what setup acquired, each on its own, so a cleanup that throws skips none of the others; then, whatever
 * threw, restore the environment and the directory caches read from it.
 */
async function tearDown(): Promise<void> {
	const { env, root, server, authStorage, jobs, pool, run, snapshotFiles, replyHold } = acquired;
	acquired = {};
	try {
		await runEach([
			() => cleanups.run(),
			() => replyHold?.release(),
			() => AgentLifecycleManager.global().dispose(),
			() => setSubagentWorkerPoolForTests(undefined),
			() => pool?.dispose(),
			() => server?.stop(),
			() =>
				run === undefined
					? undefined
					: withTimeout(
							run.then(
								() => {},
								() => {},
							),
							RUN_SETTLE_MS,
							`teardown: the run did not settle within ${RUN_SETTLE_MS} ms of its worker's stop`,
						),
			() => jobs?.dispose({ timeoutMs: 1_000 }),
			() => AgentLifecycleManager.resetGlobalForTests(),
			() => AgentRegistry.resetGlobalForTests(),
			() => IrcBus.resetGlobalForTests(),
			() => authStorage?.close(),
			() => AgentStorage.close(),
			() => closeModelCache(),
			...[...(snapshotFiles ?? [])].map(file => () => fs.rm(file, { force: true })),
			() => (root === undefined ? undefined : removeWithRetries(root)),
		]);
	} finally {
		if (env) for (const key of ENV_KEYS) setEnv(key, env[key]);
		__resetDirsFromEnvForTests();
	}
}

function runOptions(): ExecutorOptions {
	return {
		cwd,
		agent: AGENT,
		task: TASK,
		index: 0,
		id: AGENT_ID,
		description: "copies probe",
		modelOverride: MODEL,
		settings,
		authStorage: need("authStorage"),
		modelRegistry,
		costGate: new CostGate(settings, 0, () => {}),
		asyncJobManager: need("jobs"),
		eventBus: new EventBus(),
		artifactsDir: path.join(need("root"), "artifacts"),
		enableLsp: false,
		enableMCP: false,
		taskDepth: 0,
	};
}

interface WatchedRun {
	readonly worker: SubagentWorker;
	readonly output: string;
	/** The text length of each tool result the model received on its final turn. */
	readonly resultLengths: readonly number[];
	readonly copies: readonly ThreadCopies[];
}

/** How a run ended, as far as a wait it ended reports it. */
type RunEnd = Pick<SingleResult, "exitCode" | "error" | "output">;

/** Rejects once `running` settles: the run was to reach `step` before it ended. */
async function endsBefore(running: Promise<RunEnd>, step: string): Promise<never> {
	const result = await running;
	throw new Error(`The run ended (exit ${result.exitCode}) before ${step}: ${result.error ?? result.output}`);
}

/** The run's session mirror on main, once the run puts it there; a run that ends first fails the wait at once. */
async function mirrorStartup(running: Promise<RunEnd>): Promise<RemoteAgentSession> {
	const stop = new AbortController();
	try {
		return await Promise.race([
			poll(
				"mirror startup",
				() => {
					const session = AgentRegistry.global().get(AGENT_ID)?.session;
					return session instanceof RemoteAgentSession ? session : undefined;
				},
				stop.signal,
			),
			endsBefore(running, "its session mirror appeared on main"),
		]);
	} finally {
		stop.abort();
	}
}

/**
 * The text length of each tool result the model received, once the server holds the run's final request; a run
 * that ends first fails the wait at once.
 */
function finalRequest(server: CopiesModelServer, running: Promise<RunEnd>): Promise<number[]> {
	return Promise.race([server.finalHeld(), endsBefore(running, "its final model call")]);
}

/** How {@link runWatched} bounds the run's end, and whether main holds the run's result. */
interface WatchOptions {
	/** The cap of the wait for the run's end once its final response is let go; the case's timeout without it. */
	readonly completionMs?: number;
	/** Holds the worker's reply that carries the run's result: the run ends there, and main's caller never hears. */
	readonly replyHold?: RunReplyHold;
}

/**
 * The run, watched from main as a focused view watches it, with both heaps read near its end (every result in,
 * the final model call in flight), and the run's own end after its final response within `completionMs` when
 * given. Whatever fails, the final response is let go, and a run that fails is aborted. The run is in
 * {@link acquired} from its start, and the release of the watch and the final response is in {@link cleanups}
 * from before the watch starts, for teardown. Its own frame holds the mirror, so nothing here keeps it once it
 * returns.
 */
async function runWatched({ completionMs, replyHold }: WatchOptions = {}): Promise<WatchedRun> {
	const server = need("server");
	const abort = new AbortController();
	const running = runSubprocess({ ...runOptions(), signal: abort.signal });
	acquired.run = running;
	let unwatch: (() => void) | undefined;
	/** Stop watching, then let the final response go, even when the unwatch throws; a second call does nothing. */
	const letGo = (): void => {
		const stop = unwatch;
		unwatch = undefined;
		try {
			stop?.();
		} finally {
			server.release();
		}
	};
	cleanups.add(letGo);
	try {
		const mirror = await mirrorStartup(running);
		const worker = need("pool").forThread(mirror.home);
		if (!worker) throw new Error("the child's worker is not in the pool");
		unwatch = mirror.subscribe(() => {});
		// The final turn is held only if the run reaches it: a run that ends or fails first fails the test now.
		const resultLengths = await finalRequest(server, running);
		// Wait until the mirror holds every result, in its messages and (watched) in its entries.
		await waitFor(
			"every result in the mirror",
			() =>
				mirror.messages.filter(message => message.role === "toolResult").length === RESULTS &&
				mirror.sessionManager
					.getEntries()
					.filter(entry => entry.type === "message" && entry.message.role === "toolResult").length === RESULTS,
		);
		await collectGarbage();
		const main = payloadCopies("main", new HeapGraph(takeV8HeapSnapshot()));
		const file = path.join(need("root"), "worker.heapsnapshot");
		const inWorker = payloadCopies("worker", new HeapGraph(await workerSnapshot(worker.threadId, file)));
		letGo();
		// Once main holds the run's result, the worker consumed the whole final response and ended the run.
		await replyHold?.held();
		const result = await (completionMs === undefined
			? running
			: withTimeout(running, completionMs, `run completion: missed its ${completionMs} ms deadline`));
		return { worker, output: result.output, resultLengths, copies: [main, inWorker] };
	} catch (error) {
		// A run left going keeps its worker and its model call busy into teardown.
		abort.abort();
		throw error;
	} finally {
		letGo();
	}
}

describe("copies of a worker subagent's context", () => {
	beforeEach(setUp, SETUP_TIMEOUT_MS);
	afterEach(tearDown, TEARDOWN_TIMEOUT_MS);

	it(
		"holds at most five copies of a worker subagent's context across both heaps, and only its registry record once parked and its worker stopped",
		async () => {
			// If this regresses, every worker subagent a session runs holds its tool output many times over across
			// main and its worker while it runs, or main keeps its run after it parked and its worker stopped.
			const run = await runWatched();
			expect(run.output).toBe("copied");
			// Every result reached the model whole, so a copy counted below is a copy of all of them.
			expect(run.resultLengths.filter(length => length >= LINES * (LINE_CHARS + 1) - 1)).toHaveLength(RESULTS);

			// Parked, and its worker stopped.
			await waitFor("the agent parked", () => AgentRegistry.global().get(AGENT_ID)?.status === "parked");
			await waitFor("its worker stopped", () => !run.worker.alive);
			await collectGarbage();
			const parked = new HeapGraph(takeV8HeapSnapshot());
			const left = payloadCopies("main, parked and its worker stopped", parked);
			const records = parked
				.objectsWithStringProperty("id", AGENT_ID)
				.filter(node => parked.edges(node).some(edge => edge.type === "property" && edge.name === "displayName"));

			const running = run.copies.reduce((sum, thread) => sum + thread.copies, 0);
			const report = [
				copiesReport(
					`near the end of its run, in both heaps (at most ${MAX_COPIES}, at least ${MIN_HEAP_COPIES} in each)`,
					run.copies,
				),
				copiesReport("parked and its worker stopped, in main (none)", [left]),
			].join("\n");
			// Printed on every run, pass or fail, so a run's record carries the copies it counted.
			console.error(`two-heap copies report:\n${report}`);
			expect(
				{
					runningHeapsUnderOneCopy: run.copies
						.filter(thread => thread.copies < MIN_HEAP_COPIES)
						.map(thread => `${thread.thread}: ${thread.copies.toFixed(2)}`),
					runningCopiesAtMostFive: running <= MAX_COPIES,
					parkedCopies: left.copies,
					records: records.length,
					recordRunObjects: records.flatMap(record => recordRunObjects(parked, record)),
				},
				report,
			).toEqual({
				runningHeapsUnderOneCopy: [],
				runningCopiesAtMostFive: true,
				parkedCopies: 0,
				records: 1,
				recordRunObjects: [],
			});
		},
		TEST_TIMEOUT_MS,
	);
});

/** Whether something still accepts connections at `url`: it answers, or it refuses the connection. */
async function listening(url: string): Promise<boolean> {
	try {
		const response = await withTimeout(fetch(url), 5_000, `request to ${url}: no answer within 5000 ms`);
		await response.body?.cancel();
		return true;
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ECONNREFUSED") return false;
		throw error;
	}
}

/** Each of {@link ENV_KEYS} as `process.env` and `Bun.env` hold it now. */
function envNow(): Record<string, Array<string | undefined>> {
	return Object.fromEntries(ENV_KEYS.map(key => [key, [process.env[key], Bun.env[key]]]));
}

describe("the copies test's setup, teardown and controls", () => {
	afterEach(tearDown, TEARDOWN_TIMEOUT_MS);

	it("stops its model server, removes its temp dir and restores the environment when setup fails part way and a teardown step throws", async () => {
		// If this regresses, a setup that fails after it changed the environment, or a teardown step that throws,
		// leaves this file's model server listening, its temp dir on disk, and HOME and the agent dir pointing into
		// that dir for every later test file in the process.
		const envBefore = envNow();
		const agentDirBefore = getAgentDir();
		const refresh = spyOn(ModelRegistry.prototype, "refresh").mockRejectedValue(
			new Error("refresh failed in the control"),
		);
		try {
			await expect(setUp()).rejects.toThrow("refresh failed in the control");
		} finally {
			refresh.mockRestore();
		}
		const { root, server } = acquired;
		if (root === undefined || server === undefined) {
			throw new Error("setup failed before it acquired its temp dir and model server");
		}
		const modelsUrl = `${server.baseUrl}/models`;
		const during = {
			pool: acquired.pool !== undefined,
			listening: await listening(modelsUrl),
			rootExists: await fs.exists(root),
			home: process.env.HOME,
			agentDirInRoot: getAgentDir().startsWith(root),
		};
		// Teardown's first step throws; every later step still runs.
		const dispose = spyOn(AgentLifecycleManager.prototype, "dispose").mockRejectedValue(
			new Error("dispose failed in the control"),
		);
		try {
			await expect(tearDown()).rejects.toThrow("dispose failed in the control");
		} finally {
			dispose.mockRestore();
		}
		expect({
			during,
			after: {
				listening: await listening(modelsUrl),
				rootExists: await fs.exists(root),
				env: envNow(),
				agentDir: getAgentDir(),
			},
		}).toEqual({
			during: {
				pool: false,
				listening: true,
				rootExists: true,
				home: path.join(root, "home"),
				agentDirInRoot: true,
			},
			after: { listening: false, rootExists: false, env: envBefore, agentDir: agentDirBefore },
		});
	}, 30_000);

	it(
		"fails the run at once, naming the step, when its worker consumed the whole final response and ended the run but its result never reaches main, and its teardown still stops the worker, settles the run and restores the environment",
		async () => {
			// If this regresses, a heap test whose run ended on its worker after the final response, but whose result
			// never reaches main, waits out the test's timeout without naming the step, or its teardown leaves the
			// worker, the run, the model server, the temp dir or the environment behind.
			const envBefore = envNow();
			await setUp();
			const root = need("root");
			const server = need("server");
			const pool = need("pool");
			const replyHold = new RunReplyHold("copied", pool);
			acquired.replyHold = replyHold;
			const failed = await rejectionMessage(runWatched({ completionMs: 200, replyHold }));
			const workers = pool.workers();
			const run = need("run");
			await tearDown();
			expect({
				failed,
				workers: workers.length,
				workersAlive: workers.filter(worker => worker.alive).length,
				run: Bun.peek.status(run),
				listening: await listening(`${server.baseUrl}/models`),
				rootExists: await fs.exists(root),
				env: envNow(),
			}).toEqual({
				failed: "run completion: missed its 200 ms deadline",
				workers: 1,
				workersAlive: 0,
				run: "fulfilled",
				listening: false,
				rootExists: false,
				env: envBefore,
			});
		},
		TEST_TIMEOUT_MS,
	);

	it("fails the wait for the run's mirror or its final request at once, naming the step, when the run ends first", async () => {
		// If this regresses, a heap test whose run fails before its mirror or its final request waits out the test's
		// timeout, and then fails without the run's own error.
		const server = new CopiesModelServer();
		cleanups.add(() => server.stop());
		const ended = Promise.resolve({ exitCode: 1, error: "the model is not found", output: "" });
		expect({
			mirror: await rejectionMessage(mirrorStartup(ended)),
			finalRequest: await rejectionMessage(finalRequest(server, ended)),
		}).toEqual({
			mirror: "The run ended (exit 1) before its session mirror appeared on main: the model is not found",
			finalRequest: "The run ended (exit 1) before its final model call: the model is not found",
		});
	}, 30_000);

	it("rejects, naming the step, once a worker's snapshot reply misses its deadline, and teardown removes the snapshot file the worker writes late", async () => {
		// If this regresses, a snapshot a worker writes after its reply missed the deadline stays on disk.
		const file = path.join(os.tmpdir(), `omp-worker-subagent-copies-${SCRIPT_ID}.heapsnapshot`);
		// A real 50 ms deadline: what it waits on, a reply on a broadcast channel, runs on the real clock.
		const snapshotReply = await rejectionMessage(workerSnapshot("no-such-thread", file, 50));
		// The worker writes its snapshot late, after its reply missed the deadline; teardown removes it.
		await Bun.write(file, "late snapshot");
		const tracked = acquired.snapshotFiles?.has(file) === true;
		await tearDown();
		expect({ snapshotReply, tracked, exists: await fs.exists(file) }).toEqual({
			snapshotReply: "snapshot reply from worker no-such-thread: missed its 50 ms deadline",
			tracked: true,
			exists: false,
		});
	}, 30_000);
});
