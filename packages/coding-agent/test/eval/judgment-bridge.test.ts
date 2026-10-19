import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
import * as ai from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { runEvalJudgment } from "../../src/eval/judgment-bridge";
import { EVAL_HANDLE_CONCURRENCY, evalRequestSlots } from "../../src/eval/completion-bridge";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import type { ToolSession } from "../../src/tools";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";
import { TempDir } from "@oh-my-pi/pi-utils";

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

const JEV_PREVIEW: Model<Api> = {
	...SMOL,
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
} as Model<Api>;

const OPENAI_DECISIONS: Model<Api> = {
	...SMOL,
	id: "gpt-6-luna-decisions",
	requestModelId: "gpt-6-luna",
	name: "GPT-6 Luna Decisions",
	api: "openai-decisions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
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

function makeSession(
	opts: { typesafe?: boolean; decisions?: boolean; vision?: boolean; cwd?: string } = {},
): ToolSession {
	const selected = opts.decisions ? "openai/gpt-6-luna-decisions" : opts.typesafe ? "typesafe/jev-preview" : "p/smol";
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": false,
		modelRoles: { judge: selected },
		"retry.fallbackChains": { judge: ["p/smol"] },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("p", "test-key");
	if (opts.typesafe) authStorage.keys.setRuntime("typesafe", "ts-key");
	if (opts.decisions) authStorage.keys.setRuntime("openai", "openai-key");
	const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/judgment-bridge-models.yml");
	const models = opts.decisions
		? [OPENAI_DECISIONS]
		: opts.typesafe
			? [JEV_PREVIEW, SMOL]
			: [opts.vision ? VISION : SMOL];
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(models);
	return {
		cwd: opts.cwd ?? process.cwd(),
		settings,
		modelRegistry,
		getSessionId: () => "sess-1",
	} as unknown as ToolSession;
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

	it("passes local and embedded images to vision chat as real image blocks", async () => {
		const tempDir = TempDir.createSync("@omp-eval-judge-image-");
		const embeddedImage: ImageContent = { ...IMAGE_TWO, detail: "original" };
		try {
			await Bun.write(path.join(tempDir.path(), "local.png"), Buffer.from(IMAGE_ONE.data, "base64"));
			const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("tests: yes"));
			const result = await runEvalJudgment(
				{
					state: "classify this request",
					questions: { tests: QUESTIONS.tests },
					images: ["local.png", embeddedImage],
				},
				{ session: makeSession({ vision: true, cwd: tempDir.path() }) },
			);
			expect(result.answers.tests).toEqual({ type: "bool", bool: 1 });
			const user = spy.mock.calls[0]?.[1].messages.find(message => message.role === "user");
			const content = user?.content;
			const imageBlocks = Array.isArray(content)
				? content.filter((block): block is ImageContent => block.type === "image")
				: [];
			expect(imageBlocks).toHaveLength(2);
			for (const [index, image] of imageBlocks.entries()) {
				const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
				expect(Math.min(metadata.width, metadata.height)).toBeGreaterThanOrEqual(200);
				expect(image.data).not.toBe(index === 0 ? IMAGE_ONE.data : embeddedImage.data);
			}
			expect(imageBlocks[1]?.detail).toBe("original");
		} finally {
			tempDir.removeSync();
		}
	});

	it("rejects image requests when no compatible judge is available without network calls", async () => {
		const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("tests: yes"));
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));

		await expect(
			runEvalJudgment(
				{ state: "classify this request", questions: { tests: QUESTIONS.tests }, images: [IMAGE_ONE] },
				{ session: makeSession() },
			),
		).rejects.toThrow("no compatible judge candidate supports images");

		expect(complete).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects malformed local images instead of silently dropping them", async () => {
		const tempDir = TempDir.createSync("@omp-eval-judge-bad-image-");
		try {
			await Bun.write(path.join(tempDir.path(), "broken.png"), "not an image");
			const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("tests: yes"));
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));

			await expect(
				runEvalJudgment(
					{
						state: "classify this request",
						questions: { tests: QUESTIONS.tests },
						images: ["broken.png"],
					},
					{ session: makeSession({ vision: true, cwd: tempDir.path() }) },
				),
			).rejects.toThrow("invalid judgment image source");

			expect(complete).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			tempDir.removeSync();
		}
	});

	it("pauses the watchdog before image loading and waits for a shared request slot", async () => {
		let held = 0;
		try {
			while (held < EVAL_HANDLE_CONCURRENCY) {
				await evalRequestSlots.acquire();
				held++;
			}
			const events: unknown[] = [];
			let loaderStarted = false;
			const imageSources: unknown[] = [];
			Object.defineProperty(imageSources, "0", {
				get: () => {
					loaderStarted = true;
					events.push({ op: "image-load" });
					return "";
				},
			});
			const request = runEvalJudgment(
				{ state: "x", questions: { tests: QUESTIONS.tests }, images: imageSources },
				{ session: makeSession(), emitStatus: event => events.push(event) },
			);
			expect(events).toEqual([{ op: "timeout-pause" }]);
			expect(loaderStarted).toBe(false);

			evalRequestSlots.release();
			held--;
			await expect(request).rejects.toThrow("images[0] path must not be empty");
			expect(loaderStarted).toBe(true);
			expect(events).toEqual([{ op: "timeout-pause" }, { op: "image-load" }, { op: "timeout-resume" }]);

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

	it("honors a pre-aborted caller before loading images or contacting a judge", async () => {
		const complete = vi.spyOn(ai, "completeSimple");
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));

		await expect(
			runEvalJudgment(
				{ state: "x", questions: { tests: QUESTIONS.tests }, images: "not an image list" },
				{ session: makeSession(), signal: controller.signal },
			),
		).rejects.toThrow("caller cancelled");
		expect(complete).not.toHaveBeenCalled();
	});

	it("keeps image-shaped judgment state as text when no attachments are supplied", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("tests: yes"));
		await runEvalJudgment({ state: IMAGE_ONE, questions: { tests: QUESTIONS.tests } }, { session: makeSession() });

		const user = spy.mock.calls[0]?.[1].messages.find(message => message.role === "user");
		expect(user?.content).toEqual(expect.stringContaining(IMAGE_ONE.data));
	});

	it("forwards image options through the JavaScript judge helper callback", async () => {
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

		await vm.runInContext(
			`judge("ship it", { ok: { type: "bool", instructions: "Is it ready?" } }, { images: [${JSON.stringify(IMAGE_ONE)}] })`,
			sandbox,
		);

		expect(calls).toEqual([
			{
				name: "__judge__",
				args: {
					state: "ship it",
					questions: { ok: { type: "bool", instructions: "Is it ready?" } },
					images: [IMAGE_ONE],
				},
			},
		]);
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
