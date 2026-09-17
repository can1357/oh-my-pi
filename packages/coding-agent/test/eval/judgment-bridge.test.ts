import { afterEach, describe, expect, it, vi } from "bun:test";
import * as vm from "node:vm";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { releaseCompletionHandles } from "../../src/eval/completion-bridge";
import { type EvalHandleSnapshot, runEvalWait } from "../../src/eval/handle-bridge";
import { runEvalJudgment } from "../../src/eval/judgment-bridge";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import type { ToolSession } from "../../src/tools";
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

function makeSession(opts: { typesafe?: boolean } = {}): ToolSession {
	const settings = Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false });
	settings.setModelRole("smol", "p/smol");
	const modelRegistry = {
		authStorage: {
			hasAuth: (provider: string) => Boolean(opts.typesafe) && provider === "jev" || provider === "typesafe",
			resolver: () => async () => "ts-key",
		},
		getAvailable: () => [SMOL],
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
	return { settings, modelRegistry, getSessionId: () => "sess-1" } as unknown as ToolSession;
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

	it("routes to TypeSafe when credentialed and forwards questions verbatim", async () => {
		const chat = vi.spyOn(ai, "completeSimple");
		let body: { state: unknown; questions: unknown } | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return Response.json({
					model: "jev-latest",
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
							},
						],
					};
				}
				throw new Error(`unexpected bridge call ${name}`);
			},
		};
		vm.createContext(sandbox);
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);

		const answers = await vm.runInContext(
			`judge("ship it", { ok: { type: "noul", instructions: "Is it ready?" } }).wait()`,
			sandbox,
		);

		expect(answers).toEqual({ ok: { type: "noul", noul: 1 } });
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
