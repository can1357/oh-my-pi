import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { AsyncJobManager } from "../../src/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import {
	type JudgmentBatchItem,
	type JudgmentBatchStatus,
	releaseJudgmentBatches,
	runEvalJudgmentBatch,
} from "../../src/eval/judgment-batch-bridge";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import type { PythonResult } from "../../src/eval/py/executor";
import type { ToolSession } from "../../src/tools";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const SMOL: Model<Api> = {
	id: "smol",
	name: "smol",
	api: "openai-responses",
	provider: "p",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
	contextWindow: 128000,
	maxTokens: 4096,
} as Model<Api>;

const QUESTIONS = { tests: { type: "bool", instructions: "Does the request mention tests?" } };

const managers = new Set<AsyncJobManager>();

interface BatchSession {
	session: ToolSession;
	manager?: AsyncJobManager;
}

function makeSession(opts: { agentId?: string; jobs?: boolean } = {}): BatchSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": false,
		modelRoles: { judge: "p/smol" },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("p", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/judgment-batch-models.yml");
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([SMOL]);
	const session: Record<string, unknown> = {
		settings,
		modelRegistry,
		getSessionId: () => "sess-1",
		getAgentId: () => opts.agentId ?? "Main",
	};
	if (opts.jobs === false) return { session: session as unknown as ToolSession };
	const manager = new AsyncJobManager({ retentionMs: 60_000, onJobComplete: () => {} });
	managers.add(manager);
	session.asyncJobManager = manager;
	return { session: session as unknown as ToolSession, manager };
}

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "p",
		model: "smol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Route each completion by the state text embedded in the prompt; gated states block until released. */
function mockJudge(answers: Record<string, string | Promise<string>>): void {
	vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
		const user = context.messages.find(message => message.role === "user");
		const prompt = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
		for (const state in answers) {
			if (prompt.includes(state)) return reply(await answers[state]);
		}
		return reply("tests: no");
	});
}

async function create(session: ToolSession, states: unknown[], extra: Record<string, unknown> = {}) {
	const items = states.map((state, key) => ({ key, state }));
	return (await runEvalJudgmentBatch(
		{ op: "create", items, questions: QUESTIONS, ...extra },
		{ session },
	)) as JudgmentBatchStatus;
}

async function drain(session: ToolSession, id: string, timeoutMs?: number): Promise<JudgmentBatchItem[]> {
	const result = (await runEvalJudgmentBatch({ op: "drain", id, timeoutMs }, { session })) as {
		items: JudgmentBatchItem[];
	};
	return result.items;
}

async function status(session: ToolSession, id: string): Promise<JudgmentBatchStatus> {
	return (await runEvalJudgmentBatch({ op: "status", id }, { session })) as JudgmentBatchStatus;
}

afterEach(async () => {
	releaseJudgmentBatches("Main");
	releaseJudgmentBatches("Other");
	for (const manager of managers) await manager.dispose();
	managers.clear();
	vi.restoreAllMocks();
});

describe("judge_batch bridge", () => {
	it("validates items and options before starting", async () => {
		const { session } = makeSession();
		const spy = vi.spyOn(ai, "completeSimple");
		await expect(
			runEvalJudgmentBatch({ op: "create", items: [], questions: QUESTIONS }, { session }),
		).rejects.toThrow("items must not be empty");
		await expect(
			runEvalJudgmentBatch(
				{
					op: "create",
					items: [
						{ key: "a", state: "x" },
						{ key: "a", state: "y" },
					],
					questions: QUESTIONS,
				},
				{ session },
			),
		).rejects.toThrow('duplicate item key "a"');
		await expect(
			runEvalJudgmentBatch({ op: "create", items: [{ key: "a", state: "" }], questions: QUESTIONS }, { session }),
		).rejects.toThrow("state must not be empty");
		await expect(
			runEvalJudgmentBatch(
				{ op: "create", items: [{ key: "a", state: "x" }], questions: QUESTIONS, concurrency: -1 },
				{ session },
			),
		).rejects.toThrow("concurrency must be a non-negative integer");
		await expect(runEvalJudgmentBatch({ op: "drain", id: "jdgb-missing" }, { session })).rejects.toThrow(
			'unknown judge_batch "jdgb-missing"',
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("drains settled items through a cursor, records failures per item, and settles the job", async () => {
		const gate = Promise.withResolvers<string>();
		mockJudge({ "state-a": "tests: yes", "state-b": "I cannot decide.", "state-c": gate.promise });
		const { session, manager } = makeSession();
		const created = await create(session, ["state-a", "state-b", "state-c"], { retries: 0 });
		expect(created.total).toBe(3);
		expect(created.running).toBe(true);

		const first = await drain(session, created.id, 5_000);
		const second = await drain(session, created.id, 5_000);
		const firstKeys = [...first, ...second].map(item => item.key).sort();
		expect(firstKeys).toEqual([0, 1]);
		expect(first.concat(second).find(item => item.key === 0)).toEqual({
			key: 0,
			answers: { tests: { type: "bool", bool: 1 } },
			model: "p/smol",
		});
		expect(first.concat(second).find(item => item.key === 1)?.error).toContain('judgment "tests"');
		// Nothing new and the run is still going: a zero timeout returns immediately with nothing.
		expect(await drain(session, created.id, 0)).toEqual([]);

		const pending = drain(session, created.id, 5_000);
		gate.resolve("tests: no");
		expect(await pending).toEqual([{ key: 2, answers: { tests: { type: "bool", bool: 0 } }, model: "p/smol" }]);
		expect(await drain(session, created.id, 0)).toEqual([]);

		const final = await status(session, created.id);
		expect(final).toMatchObject({ done: 3, failed: 1, running: false, model: "p/smol" });
		expect(final.error).toBeUndefined();
		expect(await runEvalJudgmentBatch({ op: "results", id: created.id }, { session })).toEqual({
			results: { "0": { tests: { type: "bool", bool: 1 } }, "2": { tests: { type: "bool", bool: 0 } } },
		});
		const failed = (await runEvalJudgmentBatch({ op: "failed", id: created.id }, { session })) as {
			failed: Record<string, string>;
		};
		expect(Object.keys(failed.failed)).toEqual(["1"]);

		const job = manager?.getJob(created.id);
		expect(job?.status).toBe("completed");
		expect(job?.resultText).toMatch(/^judged 3\/3 · 1 failed · p\/smol · [\d.]+s$/);
	});

	it("retries an item once before recording its failure", async () => {
		let attempts = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			attempts++;
			return reply(attempts <= 3 ? "I cannot decide." : "tests: yes");
		});
		const { session } = makeSession();
		const created = await create(session, ["state-a"]);
		const [item] = await drain(session, created.id, 5_000);
		expect(item?.answers).toEqual({ tests: { type: "bool", bool: 1 } });
		// Three off-format turns exhaust the first judgment; the retry answers on its first turn.
		expect(attempts).toBe(4);
	});

	it("raises from drain only after the cursor is exhausted when min_ok is unmet", async () => {
		mockJudge({ "state-a": "I cannot decide." });
		const { session, manager } = makeSession();
		const created = await create(session, ["state-a"], { retries: 0, minOk: 1 });
		const items = await drain(session, created.id, 5_000);
		expect(items).toHaveLength(1);
		expect(items[0]?.error).toContain('judgment "tests"');
		await expect(drain(session, created.id, 0)).rejects.toThrow("only 0/1 item(s) judged (min_ok=1)");
		expect(manager?.getJob(created.id)?.status).toBe("failed");
	});

	it("cancels in-flight and unstarted items and cancels the job", async () => {
		const gate = Promise.withResolvers<string>();
		mockJudge({ "state-a": gate.promise, "state-b": gate.promise });
		const { session, manager } = makeSession();
		const created = await create(session, ["state-a", "state-b"], { concurrency: 1 });
		expect(await drain(session, created.id, 0)).toEqual([]);

		expect(await runEvalJudgmentBatch({ op: "cancel", id: created.id }, { session })).toEqual({ cancelled: true });
		gate.resolve("tests: yes");
		const items = await drain(session, created.id, 5_000);
		expect(items.map(item => item.error)).toEqual(["cancelled", "cancelled"]);
		expect((await status(session, created.id)).running).toBe(false);
		expect(await runEvalJudgmentBatch({ op: "cancel", id: created.id }, { session })).toEqual({ cancelled: false });
		expect(manager?.getJob(created.id)?.status).toBe("cancelled");
	});

	it("scopes attach and release to the owning agent", async () => {
		mockJudge({ "state-a": "tests: yes" });
		const { session } = makeSession();
		const created = await create(session, ["state-a"]);
		const attached = (await runEvalJudgmentBatch(
			{ op: "attach", id: created.id },
			{ session },
		)) as JudgmentBatchStatus;
		expect(attached.id).toBe(created.id);
		expect(attached.total).toBe(1);
		await expect(
			runEvalJudgmentBatch({ op: "attach", id: created.id }, { session: makeSession({ agentId: "Other" }).session }),
		).rejects.toThrow(`unknown judge_batch "${created.id}"`);

		releaseJudgmentBatches("Main");
		await expect(runEvalJudgmentBatch({ op: "attach", id: created.id }, { session })).rejects.toThrow(
			`unknown judge_batch "${created.id}"`,
		);
	});

	it("runs without a job manager", async () => {
		mockJudge({ "state-a": "tests: yes" });
		const { session } = makeSession({ jobs: false });
		const created = await create(session, ["state-a"]);
		expect(await drain(session, created.id, 5_000)).toEqual([
			{ key: 0, answers: { tests: { type: "bool", bool: 1 } }, model: "p/smol" },
		]);
		expect((await status(session, created.id)).running).toBe(false);
	});
});

describe("judgeBatch() JS prelude", () => {
	it("maps states to keyed items and drainIter stops on an empty drain", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const drains = [
			{ items: [{ key: "a", answers: { ok: { type: "bool", bool: 1 } }, model: "p/smol" }] },
			{ items: [{ key: "b", error: "boom" }] },
			{ items: [] },
		];
		const sandbox: Record<string, unknown> = {
			__omp_call_tool__: async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				if (name !== "__judge_batch__") throw new Error(`unexpected bridge call ${name}`);
				if (args.op === "create") return { id: "jdgb-1", total: 2 };
				if (args.op === "drain") return drains.shift();
				if (args.op === "status") return { id: "jdgb-1", done: 2, total: 2, failed: 1, running: false };
				throw new Error(`unexpected op ${String(args.op)}`);
			},
		};
		vm.createContext(sandbox);
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);

		const seen = await vm.runInContext(
			`(async () => {
				const b = await judgeBatch({ a: "first", b: "second" }, { ok: { type: "bool", instructions: "?" } }, { concurrency: 4 });
				const out = [];
				for await (const [key, item] of b.drainIter({ timeout: 30 })) out.push([key, item.ok, item.answers ?? item.error]);
				return { id: b.id, total: b.total, out, status: await b.status() };
			})()`,
			sandbox,
		);

		expect(seen).toEqual({
			id: "jdgb-1",
			total: 2,
			out: [
				["a", true, { ok: { type: "bool", bool: 1 } }],
				["b", false, "boom"],
			],
			status: { id: "jdgb-1", done: 2, total: 2, failed: 1, running: false },
		});
		expect(calls[0]?.args).toEqual({
			op: "create",
			items: [
				{ key: "a", state: "first" },
				{ key: "b", state: "second" },
			],
			questions: { ok: { type: "bool", instructions: "?" } },
			concurrency: 4,
		});
		const drainCalls = calls.filter(call => call.args.op === "drain");
		expect(drainCalls).toHaveLength(3);
		expect(drainCalls[0]?.args.id).toBe("jdgb-1");
		expect(drainCalls[0]?.args.timeoutMs).toBeLessThanOrEqual(30_000);
	});
});

async function runPythonJudgeBatchInSubprocess(tempDir: TempDir): Promise<PythonResult> {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const scriptPath = path.join(tempDir.path(), "run-python-judge-batch.ts");
	const resultPath = path.join(tempDir.path(), "python-judge-batch-result.json");
	const aiPath = path.resolve(import.meta.dir, "../../../ai/src/index.ts");
	const executorPath = path.resolve(import.meta.dir, "../../src/eval/py/executor.ts");
	const settingsPath = path.resolve(import.meta.dir, "../../src/config/settings.ts");
	const registryPath = path.resolve(import.meta.dir, "../../src/config/model-registry.ts");
	const setupPath = path.resolve(import.meta.dir, "../helpers/agent-session-setup.ts");
	const cellOne = [
		"import json",
		'Q = {"tests": {"type": "bool", "instructions": "Does the request mention tests?"}}',
		'b = judge_batch({"a": "add tests please", "b": "rename a local"}, Q)',
		"first = await b.drain(timeout=30)",
		"second = await b.drain(timeout=30)",
		"items = sorted(first + second, key=lambda kv: kv[0])",
		"single = await judge('write tests', Q)",
		'print(json.dumps({"id": b.id, "total": b.total, "items": [[k, i.ok, i.answers or i.error] for k, i in items], "single": single}))',
	].join("\n");
	const cellTwo = [
		"import json",
		"again = judge_batch.attach(b.id)",
		"rest = await again.drain(timeout=0)",
		'print(json.dumps({"rest": rest, "status": again.status()["done"], "results": sorted(again.results())}))',
		"again.close()",
	].join("\n");
	await Bun.write(
		scriptPath,
		`
import { vi } from "bun:test";
import * as ai from ${JSON.stringify(aiPath)};
import { executePython } from ${JSON.stringify(executorPath)};
import { Settings } from ${JSON.stringify(settingsPath)};
import { ModelRegistry } from ${JSON.stringify(registryPath)};
import { createInMemoryAuthStorage } from ${JSON.stringify(setupPath)};

const SMOL = ${JSON.stringify(SMOL)};
const settings = Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false, modelRoles: { judge: "p/smol" } });
const authStorage = createInMemoryAuthStorage();
authStorage.setRuntimeApiKey("p", "test-key");
const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/judgment-batch-py-models.yml");
vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([SMOL]);
const session = { settings, modelRegistry, getSessionId: () => "sess-py", getAgentId: () => "Main" };
vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
	const user = context.messages.find(message => message.role === "user");
	const prompt = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "p",
		model: "smol",
		stopReason: "stop",
		content: [{ type: "text", text: prompt.includes("tests") ? "tests: yes" : "tests: no" }],
	};
});
const options = {
	cwd: ${JSON.stringify(tempDir.path())},
	sessionId: "py-judge-batch",
	sessionFile: ${JSON.stringify(path.join(tempDir.path(), "session.jsonl"))},
	toolSession: session,
};
const one = await executePython(${JSON.stringify(cellOne)}, options);
const two = await executePython(${JSON.stringify(cellTwo)}, options);
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ exitCode: one.exitCode || two.exitCode, output: one.output + "\\n" + two.output }));
process.exit(0);
`,
	);
	const child = await $`bun ${scriptPath}`.cwd(repoRoot).quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0)
		throw new Error(stderr || stdout || `Python judge_batch subprocess exited with ${child.exitCode}`);
	return (await Bun.file(resultPath).json()) as PythonResult;
}

describe("judge_batch() Python prelude", () => {
	it("drains across cells and re-attaches by id", async () => {
		const tempDir = TempDir.createSync("@omp-eval-judge-batch-py-");
		try {
			const result = await runPythonJudgeBatchInSubprocess(tempDir);
			expect(result.exitCode).toBe(0);
			const [one, two] = result.output
				.trim()
				.split("\n")
				.filter(line => line.startsWith("{"))
				.map(line => JSON.parse(line));
			expect(one).toMatchObject({
				total: 2,
				items: [
					["a", true, { tests: { type: "bool", bool: 1 } }],
					["b", true, { tests: { type: "bool", bool: 0 } }],
				],
				single: { tests: { type: "bool", bool: 1 } },
			});
			expect(String(one.id)).toMatch(/^jdgb-/);
			expect(two).toEqual({ rest: [], status: 2, results: ["a", "b"] });
		} finally {
			tempDir.removeSync();
		}
	});
});
