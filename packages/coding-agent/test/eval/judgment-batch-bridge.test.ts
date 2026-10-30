import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, ImageContent, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { AsyncJobManager } from "../../src/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { EVAL_HANDLE_CONCURRENCY, evalRequestSlots } from "../../src/eval/completion-bridge";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import {
	type JudgmentBatchItem,
	type JudgmentBatchStatus,
	releaseJudgmentBatches,
	runEvalJudgmentBatch,
} from "../../src/eval/judgment-batch-bridge";
import {
	isJudgmentBatchProgress,
	JUDGMENT_BATCH_PROGRESS_EVENT_CHANNEL,
	type JudgmentBatchProgress,
} from "../../src/eval/judgment-batch-events";
import { EventBus } from "../../src/utils/event-bus";
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
const VISION: Model<Api> = {
	...SMOL,
	input: ["text", "image"],
} as Model<Api>;

const IMAGE_ONE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};
const IMAGE_TWO: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

const QUESTIONS = {
	tests: { type: "bool", instructions: "Does the request mention tests?" },
};

const managers = new Set<AsyncJobManager>();

interface BatchSession {
	session: ToolSession;
	manager?: AsyncJobManager;
}

function makeSession(opts: { agentId?: string; jobs?: boolean; vision?: boolean; cwd?: string } = {}): BatchSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": false,
		modelRoles: { judge: "p/smol" },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("p", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/judgment-batch-models.yml");
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([opts.vision ? VISION : SMOL]);
	const session: Record<string, unknown> = {
		cwd: opts.cwd ?? process.cwd(),
		settings,
		modelRegistry,
		getSessionId: () => "sess-1",
		getAgentId: () => opts.agentId ?? "Main",
	};
	if (opts.jobs === false) return { session: session as unknown as ToolSession };
	const manager = new AsyncJobManager({
		retentionMs: 60_000,
		onJobComplete: () => {},
	});
	managers.add(manager);
	session.asyncJobManager = manager;
	return { session: session as unknown as ToolSession, manager };
}

/** Billed amount per mocked judgment attempt; batches sum it into `status().cost`. */
const REPLY_COST = 0.001;

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
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: REPLY_COST,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function expectUpscaledImage(images: unknown[] | undefined, original: ImageContent): Promise<void> {
	expect(images).toHaveLength(1);
	const image = images![0] as ImageContent;
	expect(image.data).not.toBe(original.data);
	const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
	expect(Math.min(metadata.width, metadata.height)).toBeGreaterThanOrEqual(200);
}

/** Route each completion by the state text embedded in the prompt; gated states block until released. */
function mockJudge(answers: Record<string, string | Promise<string>>): void {
	vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
		const user = context.messages.find(message => message.role === "user");
		const prompt = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
		let message = reply("tests: no");
		for (const state in answers) {
			if (prompt.includes(state)) {
				message = reply(await answers[state]);
				break;
			}
		}
		options?.onAttempt?.(message);
		return message;
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

afterAll(async () => {
	await disposeAllVmContexts();
});

describe("judge_batch bridge", () => {
	it("publishes live progress between cells without a job manager or drain calls", async () => {
		const gate = Promise.withResolvers<string>();
		mockJudge({ "state-fast": "tests: yes", "state-gated": gate.promise });
		const { session } = makeSession({ jobs: false });
		session.eventBus = new EventBus();
		const events: JudgmentBatchProgress[] = [];
		const intermediate = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		session.eventBus.on(JUDGMENT_BATCH_PROGRESS_EVENT_CHANNEL, event => {
			if (!isJudgmentBatchProgress(event)) return;
			events.push(event);
			if (event.running && event.done === 1) intermediate.resolve();
			if (!event.running) finished.resolve();
		});
		try {
			await create(session, ["state-fast", "state-gated"], {
				intent: "Classifying: Test idiomacy",
			});
			await intermediate.promise;
			expect(events[0]).toMatchObject({
				intent: "Classifying: Test idiomacy",
				done: 0,
				total: 2,
				cost: 0,
				running: true,
			});
			expect(events.at(-1)).toMatchObject({ done: 1, total: 2, running: true });
		} finally {
			gate.resolve("tests: no");
		}
		await finished.promise;
		expect(events.at(-1)).toMatchObject({
			done: 2,
			total: 2,
			failed: 0,
			running: false,
		});
		expect(events.at(-1)?.cost).toBeCloseTo(2 * REPLY_COST, 6);
	});
	it("validates items and options before starting", async () => {
		const { session } = makeSession();
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("tests: yes"));
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
			runEvalJudgmentBatch(
				{
					op: "create",
					items: [{ key: "a", state: "" }],
					questions: QUESTIONS,
				},
				{ session },
			),
		).rejects.toThrow("state must not be empty");
		await expect(
			runEvalJudgmentBatch(
				{
					op: "create",
					items: [{ key: "a", state: "x" }],
					questions: QUESTIONS,
					concurrency: -1,
				},
				{ session },
			),
		).rejects.toThrow("concurrency must be a non-negative integer");
		await expect(runEvalJudgmentBatch({ op: "drain", id: "jdgb-missing" }, { session })).rejects.toThrow(
			'unknown judge_batch "jdgb-missing"',
		);
		const legacyImages = {
			op: "create",
			items: [{ key: "a", state: "x" }],
			questions: QUESTIONS,
			images: { unknown: [IMAGE_ONE] },
		};
		await expect(runEvalJudgmentBatch(legacyImages, { session })).rejects.toThrow(
			"images must be provided on each item",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("routes distinct image mappings to matching keyed batch items", async () => {
		const completions: Array<{ prompt: string; images: unknown[] }> = [];
		const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
			const user = context.messages.find(message => message.role === "user");
			const content = user?.content;
			completions.push({
				prompt: typeof content === "string" ? content : JSON.stringify(content),
				images: Array.isArray(content) ? content.filter(block => block.type === "image") : [],
			});
			const message = reply("tests: yes");
			options?.onAttempt?.(message);
			return message;
		});
		const { session } = makeSession({ vision: true, jobs: false });
		const created = (await runEvalJudgmentBatch(
			{
				op: "create",
				items: [
					{ key: 0, state: "state-zero", images: [IMAGE_ONE] },
					{ key: 1, state: "state-one", images: [IMAGE_TWO] },
				],
				questions: QUESTIONS,
				concurrency: 2,
				retries: 0,
			},
			{ session },
		)) as JudgmentBatchStatus;

		const items = await drain(session, created.id, 5_000);
		expect(items.find(item => item.key === 0)?.answers).toEqual({ tests: { type: "bool", bool: 1 } });
		expect(items.find(item => item.key === 1)?.answers).toEqual({ tests: { type: "bool", bool: 1 } });
		expect(complete).toHaveBeenCalledTimes(2);
		for (const [state, original] of [
			["state-zero", IMAGE_ONE],
			["state-one", IMAGE_TWO],
		] as const) {
			await expectUpscaledImage(completions.find(item => item.prompt.includes(state))?.images, original);
		}
	});

	it("keeps malformed images as per-item failures without dropping valid sibling judgments", async () => {
		const tempDir = TempDir.createSync("@omp-eval-judge-batch-bad-image-");
		try {
			const brokenPath = path.join(tempDir.path(), "broken.png");
			await Bun.write(brokenPath, "not an image");
			const completions: Array<{ prompt: string; images: unknown[] }> = [];
			const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
				const user = context.messages.find(message => message.role === "user");
				const content = user?.content;
				completions.push({
					prompt: typeof content === "string" ? content : JSON.stringify(content),
					images: Array.isArray(content) ? content.filter(block => block.type === "image") : [],
				});
				const message = reply("tests: yes");
				options?.onAttempt?.(message);
				return message;
			});
			const { session } = makeSession({ vision: true, jobs: false });
			const created = (await runEvalJudgmentBatch(
				{
					op: "create",
					items: [
						{ key: "valid", state: "state-valid", images: [IMAGE_ONE] },
						{ key: "broken", state: "state-broken", images: [brokenPath] },
					],
					questions: QUESTIONS,
					concurrency: 2,
					retries: 0,
				},
				{ session },
			)) as JudgmentBatchStatus;
			const items = await drain(session, created.id, 5_000);

			expect(items.find(item => item.key === "valid")?.answers).toEqual({ tests: { type: "bool", bool: 1 } });
			expect(items.find(item => item.key === "broken")?.error).toContain("invalid judgment image source");
			expect(complete).toHaveBeenCalledTimes(1);
			expect(completions).toHaveLength(1);
			expect(completions[0]?.prompt).toContain("state-valid");
			await expectUpscaledImage(completions[0]?.images, IMAGE_ONE);
		} finally {
			tempDir.removeSync();
		}
	});

	it("waits for shared admission before loading images and releases after loader failure", async () => {
		let held = 0;
		const { session } = makeSession({ jobs: false });
		try {
			while (held < EVAL_HANDLE_CONCURRENCY) {
				await evalRequestSlots.acquire();
				held++;
			}
			let loaderStarted = false;
			const imageSources: unknown[] = [];
			Object.defineProperty(imageSources, "0", {
				get: () => {
					loaderStarted = true;
					return "";
				},
			});
			const created = (await runEvalJudgmentBatch(
				{
					op: "create",
					items: [{ key: "broken", state: "state-broken", images: imageSources }],
					questions: QUESTIONS,
					concurrency: 1,
					retries: 0,
				},
				{ session },
			)) as JudgmentBatchStatus;
			expect(await status(session, created.id)).toMatchObject({ done: 0, running: true });
			expect(await drain(session, created.id, 0)).toEqual([]);
			expect(loaderStarted).toBe(false);

			evalRequestSlots.release();
			held--;
			const [item] = await drain(session, created.id, 5_000);
			expect(loaderStarted).toBe(true);
			expect(item?.error).toContain("images[0] path must not be empty");

			const controller = new AbortController();
			const admission = evalRequestSlots.acquire(controller.signal).then(
				() => true,
				() => false,
			);
			controller.abort();
			const acquired = await admission;
			if (acquired) evalRequestSlots.release();
			expect(acquired).toBe(true);
		} finally {
			while (held > 0) {
				evalRequestSlots.release();
				held--;
			}
		}
	});

	it("cancels a batch item waiting for shared admission before image loading", async () => {
		let held = 0;
		const { session } = makeSession({ jobs: false });
		try {
			while (held < EVAL_HANDLE_CONCURRENCY) {
				await evalRequestSlots.acquire();
				held++;
			}
			let loaderStarted = false;
			const imageSources: unknown[] = [];
			Object.defineProperty(imageSources, "0", {
				get: () => {
					loaderStarted = true;
					return "";
				},
			});
			const created = (await runEvalJudgmentBatch(
				{
					op: "create",
					items: [{ key: "cancelled", state: "state-cancelled", images: imageSources }],
					questions: QUESTIONS,
					concurrency: 1,
					retries: 0,
				},
				{ session },
			)) as JudgmentBatchStatus;
			expect(await status(session, created.id)).toMatchObject({ done: 0, running: true });
			expect(await runEvalJudgmentBatch({ op: "cancel", id: created.id }, { session })).toEqual({
				cancelled: true,
			});
			expect(await drain(session, created.id, 5_000)).toEqual([{ key: "cancelled", error: "cancelled" }]);
			expect(loaderStarted).toBe(false);

			evalRequestSlots.release();
			held--;
			const controller = new AbortController();
			const admission = evalRequestSlots.acquire(controller.signal).then(
				() => true,
				() => false,
			);
			controller.abort();
			const acquired = await admission;
			if (acquired) evalRequestSlots.release();
			expect(acquired).toBe(true);
		} finally {
			while (held > 0) {
				evalRequestSlots.release();
				held--;
			}
		}
	});

	it("drains settled items through a cursor, records failures per item, and settles the job", async () => {
		const gate = Promise.withResolvers<string>();
		mockJudge({
			"state-a": "tests: yes",
			"state-b": "I cannot decide.",
			"state-c": gate.promise,
		});
		const { session, manager } = makeSession();
		const created = await create(session, ["state-a", "state-b", "state-c"], {
			retries: 0,
		});
		expect(created.total).toBe(3);
		expect(created.running).toBe(true);

		// Near-simultaneous settles coalesce into one drain instead of one round-trip each.
		const first = await drain(session, created.id, 5_000);
		expect(first.map(item => item.key).sort()).toEqual([0, 1]);
		expect(first.find(item => item.key === 0)).toEqual({
			key: 0,
			answers: { tests: { type: "bool", bool: 1 } },
			model: "p/smol",
		});
		expect(first.find(item => item.key === 1)?.error).toContain('judgment "tests"');
		// Nothing new and the run is still going: a zero timeout returns immediately with nothing.
		expect(await drain(session, created.id, 0)).toEqual([]);

		const pending = drain(session, created.id, 5_000);
		gate.resolve("tests: no");
		expect(await pending).toEqual([
			{
				key: 2,
				answers: { tests: { type: "bool", bool: 0 } },
				model: "p/smol",
			},
		]);
		expect(await drain(session, created.id, 0)).toEqual([]);

		const final = await status(session, created.id);
		expect(final).toMatchObject({
			done: 3,
			failed: 1,
			running: false,
			model: "p/smol",
		});
		expect(final.error).toBeUndefined();
		expect(await runEvalJudgmentBatch({ op: "results", id: created.id }, { session })).toEqual({
			results: {
				"0": { tests: { type: "bool", bool: 1 } },
				"2": { tests: { type: "bool", bool: 0 } },
			},
		});
		const failed = (await runEvalJudgmentBatch({ op: "failed", id: created.id }, { session })) as {
			failed: Record<string, string>;
		};
		expect(Object.keys(failed.failed)).toEqual(["1"]);

		const job = manager?.getJob(created.id);
		expect(job?.status).toBe("completed");
		// Five attempts: a, three parse retries on b, c — cost counts every attempt, not settled items.
		expect(job?.resultText).toMatch(/^judged 3\/3 · 1 failed · \$0\.0050 · p\/smol · [\d.]+s$/);
	});

	it("retries an image-backed item once and preserves its prepared image for the answer", async () => {
		let attempts = 0;
		const imageAttempts: unknown[][] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			attempts++;
			const user = context.messages.find(message => message.role === "user");
			const content = user?.content;
			imageAttempts.push(Array.isArray(content) ? content.filter(block => block.type === "image") : []);
			return reply(attempts <= 3 ? "I cannot decide." : "tests: yes");
		});
		const { session } = makeSession({ vision: true });
		const created = (await runEvalJudgmentBatch(
			{
				op: "create",
				items: [{ key: "retry", state: "state-a", images: [IMAGE_ONE] }],
				questions: QUESTIONS,
			},
			{ session },
		)) as JudgmentBatchStatus;
		const [item] = await drain(session, created.id, 5_000);
		expect(item?.answers).toEqual({ tests: { type: "bool", bool: 1 } });
		// Three off-format turns exhaust the first judgment; the retry answers on its first turn.
		expect(attempts).toBe(4);
		expect(imageAttempts).toHaveLength(4);
		for (const images of imageAttempts) await expectUpscaledImage(images, IMAGE_ONE);
	});

	it("raises from drain only after the cursor is exhausted when min_ok is unmet", async () => {
		mockJudge({ "state-a": "I cannot decide." });
		const { session, manager } = makeSession();
		const created = await create(session, ["state-a"], {
			retries: 0,
			minOk: 1,
		});
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
		const created = await create(session, ["state-a", "state-b"], {
			concurrency: 1,
		});
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
			{
				key: 0,
				answers: { tests: { type: "bool", bool: 1 } },
				model: "p/smol",
			},
		]);
		expect((await status(session, created.id)).running).toBe(false);
	});
});

describe("judgeBatch() JS runtime", () => {
	it("routes mapped images and settles malformed attachments per item through the actual bridge", async () => {
		const tempDir = TempDir.createSync("@omp-eval-judge-batch-js-");
		try {
			const completions: Array<{ prompt: string; images: unknown[] }> = [];
			const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
				const user = context.messages.find(message => message.role === "user");
				const content = user?.content;
				completions.push({
					prompt: typeof content === "string" ? content : JSON.stringify(content),
					images: Array.isArray(content) ? content.filter(block => block.type === "image") : [],
				});
				const message = reply("tests: yes");
				options?.onAttempt?.(message);
				return message;
			});
			const { session } = makeSession({ vision: true, jobs: false, cwd: tempDir.path() });
			const cell = [
				'const questions = { tests: { type: "bool", instructions: "Does the request mention tests?" } };',
				'const batch = await judgeBatch(["state-zero", "state-malformed"], questions, { images: { 0: [__IMAGE_ONE__], 1: "not an image list" }, concurrency: 2, retries: 0 });',
				"const items = [];",
				"for await (const entry of batch.drainIter({ timeout: 30 })) items.push(entry);",
				"await batch.close();",
				"let unknownImageError;",
				'try { await judgeBatch(["known"], questions, { images: { unknown: [__IMAGE_TWO__] } }); }',
				"catch (error) { unknownImageError = error.message; }",
				"return JSON.stringify({ items: items.map(([key, item]) => [key, item.ok, item.answers ?? item.error]), unknownImageError });",
			]
				.join("\n")
				.replaceAll("__IMAGE_ONE__", JSON.stringify(IMAGE_ONE))
				.replaceAll("__IMAGE_TWO__", JSON.stringify(IMAGE_TWO));
			const result = await executeJs(cell, {
				cwd: tempDir.path(),
				sessionId: "js-judge-batch-integration",
				session,
				sessionFile: path.join(tempDir.path(), "session.jsonl"),
			});
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.output.trim()) as {
				items: [JudgmentBatchItem["key"], boolean, JudgmentBatchItem["answers"] | JudgmentBatchItem["error"]][];
				unknownImageError: string;
			};
			expect(report.items).toHaveLength(2);
			expect(report.items.find(([key]) => key === 0)).toEqual([0, true, { tests: { type: "bool", bool: 1 } }]);
			expect(report.items.find(([key]) => key === 1)?.[2]).toBe(
				'images for input "1" must be an array of paths or image attachments',
			);
			expect(report.unknownImageError).toBe('images contains unknown input key "unknown"');
			expect(complete).toHaveBeenCalledTimes(1);
			expect(completions).toHaveLength(1);
			expect(completions[0]?.prompt).toContain("state-zero");
			await expectUpscaledImage(completions[0]?.images, IMAGE_ONE);
		} finally {
			// The JS worker holds the temp cwd open; Windows refuses to remove it until disposal.
			await disposeAllVmContexts();
			tempDir.removeSync();
		}
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
		'b = judge_batch({"a": "add tests please", "b": "rename a local"}, Q, intent="Classifying: Test idiomacy")',
		"first = await b.drain(timeout=30)",
		"second = await b.drain(timeout=30)",
		"items = sorted(first + second, key=lambda kv: kv[0])",
		"single = await judge('write tests', Q)",
		`image_batch = judge_batch({1.0: "image-float-one", "1": "image-string-one", 1.25: "image-fractional", 2.5: "image-invalid"}, Q, images={1.0: [${JSON.stringify(IMAGE_ONE)}], "1": [${JSON.stringify(IMAGE_TWO)}], 1.25: [${JSON.stringify(IMAGE_TWO)}], 2.5: "not an image list"}, retries=0)`,
		"image_items = [entry async for entry in image_batch.drain_iter(timeout=30)]",
		"image_results = {repr(k): [i.ok, i.answers or i.error] for k, i in image_items}",
		"image_batch.close()",
		"try:",
		'    judge_batch({"known": "state"}, Q, images={"unknown": []})',
		"except ValueError as error:",
		"    unknown_image_error = str(error)",
		"else:",
		'    raise AssertionError("unknown image key was accepted")',
		'print(json.dumps({"id": b.id, "total": b.total, "items": [[k, i.ok, i.answers or i.error] for k, i in items], "single": single, "image_items": image_results, "unknown_image_error": unknown_image_error}))',
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
import type { ImageContent } from ${JSON.stringify(aiPath)};
import { executePython } from ${JSON.stringify(executorPath)};
import { Settings } from ${JSON.stringify(settingsPath)};
import { ModelRegistry } from ${JSON.stringify(registryPath)};
import { createInMemoryAuthStorage } from ${JSON.stringify(setupPath)};

const SMOL = ${JSON.stringify(SMOL)};
const VISION = { ...SMOL, input: ["text", "image"] };
const settings = Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false, modelRoles: { judge: "p/smol" } });
const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("p", "test-key");
const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/judgment-batch-py-models.yml");
vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([VISION]);
const observedImageBlocks: Array<{ prompt: string; images: ImageContent[] }> = [];
vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
	const user = context.messages.find(message => message.role === "user");
	const prompt = (typeof user?.content === "string" ? user.content : JSON.stringify(user?.content)) ?? "";
	const images = Array.isArray(user?.content)
		? user.content.filter((block): block is ImageContent => block.type === "image")
		: [];
	if (images.length > 0) observedImageBlocks.push({ prompt, images });
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "p",
		model: "smol",
		stopReason: "stop",
		content: [{ type: "text", text: prompt.includes("tests") || prompt.includes("image-") ? "tests: yes" : "tests: no" }],
	};
});
const session = {
	cwd: ${JSON.stringify(tempDir.path())},
	hasUI: false,
	getSessionFile: () => ${JSON.stringify(path.join(tempDir.path(), "session.jsonl"))},
	getSessionSpawns: () => null,
	settings,
	modelRegistry,
};
const options = {
	cwd: ${JSON.stringify(tempDir.path())},
	sessionId: "py-judge-batch",
	sessionFile: ${JSON.stringify(path.join(tempDir.path(), "session.jsonl"))},
	toolSession: session,
};
const one = await executePython(${JSON.stringify(cellOne)}, options);
const two = await executePython(${JSON.stringify(cellTwo)}, options);
const imageReport = "\\n__IMAGE_BLOCKS__" + JSON.stringify(observedImageBlocks);
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ exitCode: one.exitCode || two.exitCode, output: one.output + "\\n" + two.output + imageReport }));
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
			expect(one.image_items).toEqual({
				"1": [true, { tests: { type: "bool", bool: 1 } }],
				"'1'": [true, { tests: { type: "bool", bool: 1 } }],
				"1.25": [true, { tests: { type: "bool", bool: 1 } }],
				"2.5": [false, 'images for input "2.5" must be an array of paths or image attachments'],
			});
			expect(one.unknown_image_error).toBe('images contains unknown input key "unknown"');
			const imageReport = result.output.split("\n").find(line => line.startsWith("__IMAGE_BLOCKS__"));
			expect(imageReport).toBeDefined();
			const imageCaptures = JSON.parse(imageReport?.slice("__IMAGE_BLOCKS__".length) ?? "null") as Array<{
				prompt: string;
				images: unknown[];
			}>;
			expect(imageCaptures).toHaveLength(3);
			for (const [prompt, original] of [
				["image-float-one", IMAGE_ONE],
				["image-string-one", IMAGE_TWO],
				["image-fractional", IMAGE_TWO],
			] as const) {
				const capture = imageCaptures.find(item => item.prompt.includes(prompt));
				expect(capture).toBeDefined();
				await expectUpscaledImage(capture?.images, original);
			}
		} finally {
			tempDir.removeSync();
		}
	});
});
