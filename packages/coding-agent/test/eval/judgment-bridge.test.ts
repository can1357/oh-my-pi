import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as vm from "node:vm";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { releaseCompletionHandles } from "../../src/eval/completion-bridge";
import { runEvalWait } from "../../src/eval/handle-bridge";
import { runEvalJudgment } from "../../src/eval/judgment-bridge";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { disposeAllKernelSessions, executePython } from "../../src/eval/py/executor";
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
	releaseCompletionHandles("Main");
});

/** Start a judgment and wait on its handle the way both preludes do. */
async function judgeAndWait(args: unknown, session: ToolSession): Promise<unknown> {
	const { id } = runEvalJudgment(args, { session });
	const { items } = await runEvalWait({ items: [{ kind: "judgment", id }] }, { session });
	const snapshot = items[0];
	if (snapshot?.status !== "completed") throw new Error(snapshot?.error ?? `judgment ${id} did not complete`);
	return snapshot.data;
}

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

	it("answers through the smol chat model and settles the handle with typed answers", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("bucket: hard\ntests: yes\ntone: 2"));
		const answers = await judgeAndWait(
			{ state: { request: "please add tests for the parser" }, questions: QUESTIONS },
			makeSession(),
		);

		expect(answers).toEqual({
			bucket: { type: "choice", choice: "hard", probabilities: { trivial: 0, hard: 1 }, confidence: 1 },
			tests: { type: "bool", bool: 1 },
			tone: { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 },
		});
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
		const answers = await judgeAndWait(
			{ state: ["add tests"], questions: { tests: QUESTIONS.tests } },
			makeSession({ typesafe: true }),
		);

		expect(answers).toEqual({ tests: { type: "bool", bool: 0.83 } });
		expect(body?.state).toEqual(["add tests"]);
		expect(body?.questions).toEqual({ tests: { type: "noul", instructions: QUESTIONS.tests.instructions } });
		expect(chat).not.toHaveBeenCalled();
	});

	it("fails the handle when the chat model answers off-format", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("I cannot decide."));
		await expect(judgeAndWait({ state: "x", questions: { tests: QUESTIONS.tests } }, makeSession())).rejects.toThrow(
			'judgment "tests"',
		);
	});
});

describe("eval js judge() prelude", () => {
	function loadPrelude(): vm.Context {
		let next = 0;
		const ok = { ok: { type: "bool", bool: 1 } };
		const judged = new Map<string, unknown>();
		const sandbox: Record<string, unknown> = {
			__omp_call_tool__: async (name: string, args: { state?: unknown; items?: Array<{ id: string }> }) => {
				if (name === "__judge__") {
					const id = `jdg-${next++}`;
					judged.set(id, args.state);
					return { id };
				}
				if (name === "__wait__") {
					return {
						items: args.items?.map(({ id }) =>
							judged.get(id) === "bad"
								? { kind: "judgment", id, status: "failed", error: "judge failed" }
								: { kind: "judgment", id, status: "completed", text: "", data: ok },
						),
					};
				}
				throw new Error(`unexpected bridge call ${name}`);
			},
		};
		vm.createContext(sandbox);
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
		return sandbox;
	}

	it("resolves the handle through await, .wait(), and wait() with failures kept in their slot", async () => {
		const sandbox = loadPrelude();
		const result = await vm.runInContext(
			`(async () => {
				const q = { ok: { type: "bool", instructions: "Is it ready?" } };
				const awaited = await judge("ship it", q);
				const waited = await judge("ship it", q).wait();
				const slots = await wait([judge("ship it", q), judge("bad", q)], { raiseErrors: false });
				return { awaited, waited, slots: slots.map(slot => (slot instanceof Error ? slot.message : slot)) };
			})()`,
			sandbox,
		);

		const ok = { ok: { type: "bool", bool: 1 } };
		expect(result).toEqual({ awaited: ok, waited: ok, slots: [ok, "judge failed"] });
	});
});

describe("eval python judge() prelude", () => {
	afterAll(async () => {
		await disposeAllKernelSessions();
	});

	it("returns a handle resolved by .wait(), wait(raise_errors=False), and await", async () => {
		vi.spyOn(ai, "completeSimple").mockImplementation((async (_model: unknown, context: unknown) =>
			reply(JSON.stringify(context).includes("STATE_BAD") ? "I cannot decide." : "ok: yes")) as never);
		using tempDir = TempDir.createSync("@omp-eval-judge-py-");
		const code = [
			"import json",
			'q = {"ok": {"type": "bool", "instructions": "Is it ready?"}}',
			'waited = judge("STATE_GOOD 1", q).wait()',
			'slots = wait([judge("STATE_GOOD 2", q), judge("STATE_BAD", q)], raise_errors=False)',
			'awaited = await judge("STATE_GOOD 3", q)',
			"print(json.dumps({",
			'    "waited": waited,',
			'    "slots": [slot if isinstance(slot, dict) else f"{type(slot).__name__}: {slot}" for slot in slots],',
			'    "awaited": awaited,',
			"}))",
		].join("\n");
		const result = await executePython(code, {
			cwd: tempDir.path(),
			sessionId: `py-judge:${crypto.randomUUID()}`,
			sessionFile: `${tempDir.path()}/session.jsonl`,
			toolSession: makeSession(),
			kernelMode: "per-call",
		});

		expect(result.exitCode).toBe(0);
		const ok = { ok: { type: "bool", bool: 1 } };
		const output = JSON.parse(result.output.trim());
		expect(output.waited).toEqual(ok);
		expect(output.awaited).toEqual(ok);
		expect(output.slots[0]).toEqual(ok);
		expect(output.slots[1]).toStartWith("RuntimeError: ");
		expect(output.slots[1]).toContain('judgment "ok"');
	});
});
