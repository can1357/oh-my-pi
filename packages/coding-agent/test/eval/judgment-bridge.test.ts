import { afterEach, describe, expect, it, vi } from "bun:test";
import * as vm from "node:vm";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { releaseCompletionHandles } from "../../src/eval/completion-bridge";
import { type EvalHandleSnapshot, runEvalCancel, runEvalWait } from "../../src/eval/handle-bridge";
import { runEvalJudgment } from "../../src/eval/judgment-bridge";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";

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

const JEV_PREVIEW: Model<Api> = {
	...SMOL,
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
} as Model<Api>;

function makeSession(opts: { typesafe?: boolean; sessionManager?: SessionManager } = {}): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": false,
		modelRoles: { judge: opts.typesafe ? "typesafe/jev-preview" : "p/smol" },
		"retry.fallbackChains": { judge: ["p/smol"] },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("p", "test-key");
	if (opts.typesafe) authStorage.setRuntimeApiKey("typesafe", "ts-key");
	const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/judgment-bridge-models.yml");
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(opts.typesafe ? [JEV_PREVIEW, SMOL] : [SMOL]);
	return {
		settings,
		modelRegistry,
		sessionManager: opts.sessionManager,
		getSessionId: () => opts.sessionManager?.getSessionId() ?? "sess-1",
	} as unknown as ToolSession;
}

function reply(text: string, input = 0, output = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "p",
		model: "smol",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function judgeAndWait(args: unknown, session: ToolSession): Promise<EvalHandleSnapshot> {
	const handle = runEvalJudgment(args, { session });
	const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
	const snapshot = waited.items[0];
	if (!snapshot) throw new Error("wait() returned no snapshot");
	return snapshot;
}

const QUESTIONS = {
	bucket: {
		type: "choice",
		instructions: "How hard is the request?",
		criteria: { trivial: "one-liner", hard: null },
	},
	tests: { type: "bool", instructions: "Does the request mention tests?" },
	tone: { type: "score", instructions: "How polite is the request?", criteria: ["rude", "neutral", "polite"] },
};

afterEach(() => {
	vi.restoreAllMocks();
	releaseCompletionHandles("Main");
});

describe("eval judge() bridge", () => {
	it("rejects malformed questions before touching any backend", () => {
		const session = makeSession();
		const spy = vi.spyOn(ai, "completeSimple");
		expect(() =>
			runEvalJudgment({ state: "x", questions: { q: { type: "rank", instructions: "?" } } }, { session }),
		).toThrow('question "q" type must be "choice", "bool", or "score"');
		expect(() =>
			runEvalJudgment(
				{ state: "x", questions: { q: { type: "score", instructions: "?", criteria: ["only"] } } },
				{ session },
			),
		).toThrow('score question "q" needs at least two levels');
		expect(() =>
			runEvalJudgment(
				{ state: "x", questions: { q: { type: "choice", instructions: "?", criteria: { a: null } } } },
				{ session },
			),
		).toThrow('choice question "q" needs at least two options');
		expect(() => runEvalJudgment({ state: "", questions: QUESTIONS }, { session })).toThrow(
			"state must not be empty",
		);
		expect(() => runEvalJudgment({ state: { fn: () => 1 }, questions: QUESTIONS }, { session })).toThrow(
			"state must be a string, a JSON object, or a JSON array",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("answers through the smol chat model and settles the handle with typed answers as data", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("bucket: hard\ntests: yes\ntone: 2"));
		const snapshot = await judgeAndWait(
			{ state: { request: "please add tests for the parser" }, questions: QUESTIONS },
			makeSession(),
		);

		expect(snapshot.status).toBe("completed");
		expect(snapshot.data).toEqual({
			bucket: { type: "choice", choice: "hard", probabilities: { trivial: 0, hard: 1 }, confidence: 1 },
			tests: { type: "bool", bool: 1 },
			tone: { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 },
		});
		expect(JSON.parse(snapshot.text ?? "")).toEqual(snapshot.data);
		const options = spy.mock.calls[0]?.[2] as { disableReasoning?: boolean; temperature?: number };
		expect(options.disableReasoning).toBe(true);
		expect(options.temperature).toBe(0);
	});

	it("routes to the selected TypeSafe judge and forwards questions verbatim", async () => {
		const chat = vi.spyOn(ai, "completeSimple");
		let body: { model: string; state: unknown; questions: unknown } | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (url, init) => {
				expect(String(url)).toBe("https://judge.example.test/v1/systemone");
				body = JSON.parse(String(init?.body));
				expect(body).toEqual(expect.objectContaining({ model: "jev-preview" }));
				return Response.json({
					model: "jev-preview",
					answers: { tests: { type: "noul", noul: 0.83 } },
					usage: { input_tokens: 10, output_tokens: 1 },
				});
			}),
		);
		const snapshot = await judgeAndWait(
			{ state: ["add tests"], questions: { tests: QUESTIONS.tests } },
			makeSession({ typesafe: true }),
		);

		expect(snapshot.status).toBe("completed");
		expect(snapshot.data).toEqual({ tests: { type: "bool", bool: 0.83 } });
		expect(body?.state).toEqual(["add tests"]);
		expect(body?.questions).toEqual({ tests: { type: "noul", instructions: QUESTIONS.tests.instructions } });
		expect(chat).not.toHaveBeenCalled();
	});

	it("persists failed and successful judgment attempts for session accounting", async () => {
		using tempDir = TempDir.createSync("@omp-eval-judge-usage-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			manager.appendMessage({ role: "user", content: "classify this", timestamp: 1 });
			vi.spyOn(globalThis, "fetch").mockImplementation(
				asGlobalFetch(async () => new Response("unauthorized", { status: 401 })),
			);
			const response = reply("tests: yes", 11, 2);
			vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
				options?.onAttempt?.(response);
				return response;
			});

			const snapshot = await judgeAndWait(
				{ state: "add tests", questions: { tests: QUESTIONS.tests } },
				makeSession({ typesafe: true, sessionManager: manager }),
			);
			await manager.ensureOnDisk();
			await manager.flush();

			const usageEntries = manager.getEntries().filter(entry => entry.type === "model_usage");
			expect(snapshot.details).toEqual({ model: "p/smol", structured: true });
			expect(usageEntries).toHaveLength(2);
			expect(usageEntries[0]).toMatchObject({
				purpose: "eval-judge",
				handleId: snapshot.id,
				questionIds: ["tests"],
				role: "typesafe",
				api: "typesafe",
				provider: "typesafe",
				model: JEV_PREVIEW.id,
				stopReason: "error",
				usage: { totalTokens: 0 },
			});
			expect(usageEntries[0]?.errorMessage).toContain("unauthorized");
			expect(usageEntries[1]).toMatchObject({
				parentId: usageEntries[0]?.id,
				purpose: "eval-judge",
				handleId: snapshot.id,
				questionIds: ["tests"],
				role: "judge",
				api: SMOL.api,
				provider: SMOL.provider,
				model: SMOL.id,
				stopReason: "stop",
				usage: { input: 11, output: 2, totalTokens: 13 },
			});
			expect(manager.getUsageStatistics()).toMatchObject({ input: 11, output: 2, totalTokens: 13 });

			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			const persisted = (await Bun.file(sessionFile).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { type?: string })
				.filter(entry => entry.type === "model_usage");
			expect(persisted).toHaveLength(2);
		} finally {
			await manager.close();
		}
	});

	it("records a cancelled TypeSafe attempt without falling back", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "classify this", timestamp: 1 });
		const session = makeSession({ typesafe: true, sessionManager: manager });
		const started = Promise.withResolvers<void>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				const signal = init?.signal;
				if (!signal) throw new Error("Expected TypeSafe request signal");
				started.resolve();
				const pending = Promise.withResolvers<Response>();
				signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
				return await pending.promise;
			}),
		);
		const chat = vi.spyOn(ai, "completeSimple");
		const handle = runEvalJudgment({ state: "x", questions: { tests: QUESTIONS.tests } }, { session });
		await started.promise;

		expect(runEvalCancel({ item: { kind: "completion", id: handle.id } }, { session })).toEqual({
			cancelled: true,
		});
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		expect(waited.items[0]?.status).toBe("cancelled");
		expect(manager.getEntries().filter(entry => entry.type === "model_usage")).toEqual([
			expect.objectContaining({
				purpose: "eval-judge",
				handleId: handle.id,
				questionIds: ["tests"],
				role: "typesafe",
				stopReason: "aborted",
				usage: expect.objectContaining({ totalTokens: 0 }),
			}),
		]);
		expect(chat).not.toHaveBeenCalled();
	});

	it("fails the handle when the chat model answers off-format", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("I cannot decide."));
		const snapshot = await judgeAndWait({ state: "x", questions: { tests: QUESTIONS.tests } }, makeSession());
		expect(snapshot.status).toBe("failed");
		expect(snapshot.error).toContain('judgment "tests"');
	});
});

describe("eval js judge() prelude", () => {
	it("returns a JudgmentHandle whose wait() yields the structured answers", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox: Record<string, unknown> = {
			__omp_call_tool__: async (name: string, args: unknown) => {
				calls.push({ name, args });
				if (name === "__judge__") return { id: "jdg-1" };
				if (name === "__wait__") {
					return {
						items: [
							{
								status: "completed",
								text: '{"ok":{"type":"noul","noul":1}}',
								data: { ok: { type: "noul", noul: 1 } },
								details: { model: "typesafe/jev-latest", structured: true },
							},
						],
					};
				}
				throw new Error(`unexpected bridge call ${name}`);
			},
		};
		vm.createContext(sandbox);
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);

		const result = await vm.runInContext(
			`(async () => {
				const handle = judge("ship it", { ok: { type: "noul", instructions: "Is it ready?" } });
				const answers = await handle.wait();
				return { answers, model: handle.details?.model };
			})()`,
			sandbox,
		);

		expect(result).toEqual({
			answers: { ok: { type: "noul", noul: 1 } },
			model: "typesafe/jev-latest",
		});
		expect(calls[0]).toEqual({
			name: "__judge__",
			args: { state: "ship it", questions: { ok: { type: "noul", instructions: "Is it ready?" } } },
		});
		expect(calls[1]?.args).toEqual({ items: [{ kind: "completion", id: "jdg-1" }] });
		expect(String(await vm.runInContext(`judge("x", { q: { type: "noul", instructions: "?" } })`, sandbox))).toBe(
			"<judgment jdg-1>",
		);
	});
});
