import { afterEach, describe, expect, it, vi } from "bun:test";
import * as vm from "node:vm";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { runEvalJudgment } from "../../src/eval/judgment-bridge";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
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

function makeSession(opts: { typesafe?: boolean } = {}): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": false,
		modelRoles: { judge: opts.typesafe ? "typesafe/jev-preview" : "p/smol" },
		"retry.fallbackChains": { judge: ["p/smol"] },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("p", "test-key");
	if (opts.typesafe) authStorage.keys.setRuntime("typesafe", "ts-key");
	const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/judgment-bridge-models.yml");
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(opts.typesafe ? [JEV_PREVIEW, SMOL] : [SMOL]);
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
});

describe("eval judge() bridge", () => {
	it("rejects malformed questions before touching any backend", async () => {
		const session = makeSession();
		const spy = vi.spyOn(ai, "completeSimple");
		await expect(
			runEvalJudgment({ state: "x", questions: { q: { type: "rank", instructions: "?" } } }, { session }),
		).rejects.toThrow('question "q" type must be "choice", "bool", or "score"');
		await expect(
			runEvalJudgment(
				{ state: "x", questions: { q: { type: "score", instructions: "?", criteria: ["only"] } } },
				{ session },
			),
		).rejects.toThrow('score question "q" needs at least two levels');
		await expect(
			runEvalJudgment(
				{ state: "x", questions: { q: { type: "choice", instructions: "?", criteria: { a: null } } } },
				{ session },
			),
		).rejects.toThrow('choice question "q" needs at least two options');
		await expect(runEvalJudgment({ state: "", questions: QUESTIONS }, { session })).rejects.toThrow(
			"state must not be empty",
		);
		await expect(runEvalJudgment({ state: { fn: () => 1 }, questions: QUESTIONS }, { session })).rejects.toThrow(
			"state must be a string, a JSON object, or a JSON array",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("answers through the smol chat model and returns typed answers with the backend", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("bucket: hard\ntests: yes\ntone: 2"));
		const result = await runEvalJudgment(
			{ state: { request: "please add tests for the parser" }, questions: QUESTIONS },
			{ session: makeSession() },
		);

		expect(result.answers).toEqual({
			bucket: { type: "choice", choice: "hard", probabilities: { trivial: 0, hard: 1 }, confidence: 1 },
			tests: { type: "bool", bool: 1 },
			tone: { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 },
		});
		expect(result.model).toBe("p/smol");
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
		const result = await runEvalJudgment(
			{ state: ["add tests"], questions: { tests: QUESTIONS.tests } },
			{ session: makeSession({ typesafe: true }) },
		);

		expect(result.answers).toEqual({ tests: { type: "bool", bool: 0.83 } });
		expect(body?.state).toEqual(["add tests"]);
		expect(body?.questions).toEqual({ tests: { type: "noul", instructions: QUESTIONS.tests.instructions } });
		expect(chat).not.toHaveBeenCalled();
	});

	it("rejects when the chat model answers off-format", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("I cannot decide."));
		await expect(
			runEvalJudgment({ state: "x", questions: { tests: QUESTIONS.tests } }, { session: makeSession() }),
		).rejects.toThrow('judgment "tests"');
	});
});

describe("eval js judge() prelude", () => {
	it("awaits to the structured answers", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox: Record<string, unknown> = {
			__omp_call_tool__: async (name: string, args: unknown) => {
				calls.push({ name, args });
				if (name === "__judge__") return { answers: { ok: { type: "bool", bool: 1 } }, model: "p/smol" };
				throw new Error(`unexpected bridge call ${name}`);
			},
		};
		vm.createContext(sandbox);
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);

		const answers = await vm.runInContext(
			`judge("ship it", { ok: { type: "bool", instructions: "Is it ready?" } })`,
			sandbox,
		);

		expect(answers).toEqual({ ok: { type: "bool", bool: 1 } });
		expect(calls).toEqual([
			{
				name: "__judge__",
				args: { state: "ship it", questions: { ok: { type: "bool", instructions: "Is it ready?" } } },
			},
		]);
	});
});
