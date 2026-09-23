import { afterEach, expect, it, vi } from "bun:test";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionContext,
	ExtensionRuntime as ExtensionRuntimeType,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { JudgmentError, type JudgmentBatchEntry, type JudgmentBatchRequest } from "@oh-my-pi/pi-coding-agent/judgment";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

const QUESTIONS = {
	level: { type: "choice", instructions: "Choose a tier.", criteria: { low: "simple", high: "complex" } },
} as const;

const NATIVE = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as unknown as Model<Api>;

const CHAT = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!CHAT) throw new Error("Expected a bundled chat model for the judge fallback route");

function createRunnerWithoutJudgment(): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntimeType;
	return new ExtensionRunner([], runtime, "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
}

/** A runner whose `judge` role routes to `model`, with that provider credentialed. */
function createJudgmentRunner(
	model: Model<Api> = NATIVE,
	extensions: Extension[] = [],
): { runner: ExtensionRunner; manager: SessionManager } {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime(model.provider, "test-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/extension-judgment-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
	const manager = SessionManager.inMemory();
	const runner = new ExtensionRunner(
		extensions,
		new ExtensionRuntime(),
		"/tmp",
		manager,
		registry,
		undefined,
		Settings.isolated({ modelRoles: { judge: `${model.provider}/${model.id}` } }),
		undefined,
		undefined,
		{},
	);
	return { runner, manager };
}

function nativeResponse(choice: "low" | "high"): Response {
	return Response.json({
		model: "jev-1.13.0",
		answers: { level: { type: "choice", choice } },
		usage: { input_tokens: 8, output_tokens: 2 },
	});
}

/** One extension whose `tool_call` handler receives the scoped context. */
function toolCallExtension(handler: (ctx: ExtensionContext) => Promise<void>): Extension {
	return {
		path: "judgment-scope.ts",
		resolvedPath: "judgment-scope.ts",
		handlers: new Map([["tool_call", [async (...args: unknown[]) => handler(args[1] as ExtensionContext)]]]),
		tools: new Map(),
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

afterEach(() => vi.restoreAllMocks());

it("omits both judgment methods when the host has no judgment runtime", () => {
	const context = createRunnerWithoutJudgment().createContext();

	expect(context.judge).toBeUndefined();
	expect(context.judgeBatch).toBeUndefined();
});

it("routes typed ExtensionContext judgments and journals their usage", async () => {
	const { runner, manager } = createJudgmentRunner();
	vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async () => nativeResponse("high")));
	const judge = runner.createContext().judge;
	if (!judge) throw new Error("expected judgment context");

	const result = await judge({ state: "complex work", questions: QUESTIONS });

	expect(result.answers.level.choice).toBe("high");
	expect(manager.getEntries().some(entry => entry.type === "model_usage")).toBe(true);
});

it("answers every batch item in request order, isolating an item whose attempts fail", async () => {
	const { runner, manager } = createJudgmentRunner();
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (_url, init) => {
			const { state } = JSON.parse(String(init?.body)) as { state: string };
			if (state === "unanswerable") return new Response("rejected", { status: 400 });
			return nativeResponse(state === "complex work" ? "high" : "low");
		}),
	);
	const judgeBatch = runner.createContext().judgeBatch;
	if (!judgeBatch) throw new Error("expected batch judgment context");
	const request: JudgmentBatchRequest<typeof QUESTIONS> = {
		items: [
			{ key: "first", state: "complex work" },
			{ key: "second", state: "unanswerable" },
			{ key: 2, state: "simple work" },
		],
		questions: QUESTIONS,
	};

	const entries: JudgmentBatchEntry<typeof QUESTIONS>[] = await judgeBatch(request, { concurrency: 3 });

	expect(entries.map(entry => entry.key)).toEqual(["first", "second", 2]);
	expect(entries[0].result?.answers.level.choice).toBe("high");
	expect(entries[2].result?.answers.level.choice).toBe("low");
	expect(entries[1].result).toBeUndefined();
	expect(entries[1].error?.message).toContain("400");
	// Every answered item is journaled on the session ledger like a single
	// judgment, so batch cost lands in session totals. (The host also journals
	// the failed attempt, carrying its error message.)
	const journaled = manager
		.getEntries()
		.filter(entry => entry.type === "model_usage" && entry.purpose === "extension-judge-batch");
	expect(journaled.filter(entry => entry.type === "model_usage" && entry.errorMessage === undefined)).toHaveLength(2);
});

it("retries a batch item through the chain before reporting it as failed", async () => {
	const { runner } = createJudgmentRunner();
	let attempts = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async () => {
			attempts++;
			return attempts === 1 ? new Response("rejected", { status: 400 }) : nativeResponse("low");
		}),
	);
	const judgeBatch = runner.createContext().judgeBatch;
	if (!judgeBatch) throw new Error("expected batch judgment context");

	const entries = await judgeBatch(
		{ items: [{ key: "only", state: "flaky work" }], questions: QUESTIONS },
		{ retries: 1 },
	);

	expect(attempts).toBe(2);
	expect(entries[0].result?.answers.level.choice).toBe("low");
});

it("rejects a batch width that would schedule no worker or a fraction of one", async () => {
	const { runner } = createJudgmentRunner();
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async () => nativeResponse("low")));
	const judgeBatch = runner.createContext().judgeBatch;
	if (!judgeBatch) throw new Error("expected batch judgment context");
	const request: JudgmentBatchRequest<typeof QUESTIONS> = {
		items: [{ key: "only", state: "simple work" }],
		questions: QUESTIONS,
	};

	// 0 and -1 leave no worker, 1.5 truncates to a different width than asked,
	// and NaN/Infinity produce an unusable worker count; each would otherwise
	// resolve with holes where entries belong.
	for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		await expect(judgeBatch(request, { concurrency })).rejects.toBeInstanceOf(JudgmentError);
	}

	expect(fetchSpy).not.toHaveBeenCalled();
});

it("rejects a retry budget that is negative, fractional, or unbounded", async () => {
	const { runner } = createJudgmentRunner();
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async () => nativeResponse("low")));
	const judgeBatch = runner.createContext().judgeBatch;
	if (!judgeBatch) throw new Error("expected batch judgment context");
	const request: JudgmentBatchRequest<typeof QUESTIONS> = {
		items: [{ key: "only", state: "simple work" }],
		questions: QUESTIONS,
	};

	// -1 and NaN skip the attempt loop entirely (the item would report an
	// invented failure), 0.5 asks for half an attempt, and Infinity never stops
	// re-walking the chain.
	for (const retries of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		await expect(judgeBatch(request, { retries })).rejects.toBeInstanceOf(JudgmentError);
	}

	expect(fetchSpy).not.toHaveBeenCalled();
});

it("judges a batch through a configured chat model when the judge role routes to one", async () => {
	const { runner, manager } = createJudgmentRunner(CHAT);
	vi.spyOn(ai, "completeSimple").mockImplementation(async (model, _context, options) => {
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "level: high" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 3,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 4,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		options?.onAttempt?.(response);
		return response;
	});
	const judgeBatch = runner.createContext().judgeBatch;
	if (!judgeBatch) throw new Error("expected batch judgment context");

	const entries = await judgeBatch({ items: [{ key: 0, state: "complex work" }], questions: QUESTIONS });

	expect(entries[0].result?.provider).toBe(CHAT.provider);
	expect(entries[0].result?.answers.level.choice).toBe("high");
	expect(manager.getEntries().some(entry => entry.type === "model_usage")).toBe(true);
});

it("cancels an in-flight ExtensionContext judgment when the runner is disposed", async () => {
	const { runner } = createJudgmentRunner();
	const requestStarted = Promise.withResolvers<void>();
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch((_url, init) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			requestStarted.resolve();
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			return promise;
		}),
	);
	const judge = runner.createContext().judge;
	if (!judge) throw new Error("expected judgment context");
	const pending = judge({ state: "pending work", questions: QUESTIONS });
	await requestStarted.promise;

	runner.disposeJudgments(new Error("session ended"));

	await expect(pending).rejects.toThrow("session ended");
});

it("stops an in-flight batch on disposal and refuses later batches", async () => {
	const { runner } = createJudgmentRunner();
	const requestStarted = Promise.withResolvers<void>();
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch((_url, init) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			requestStarted.resolve();
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			return promise;
		}),
	);
	const judgeBatch = runner.createContext().judgeBatch;
	if (!judgeBatch) throw new Error("expected batch judgment context");
	const request: JudgmentBatchRequest<typeof QUESTIONS> = {
		items: [{ key: "pending", state: "pending work" }],
		questions: QUESTIONS,
	};
	const pending = judgeBatch(request);
	await requestStarted.promise;

	runner.disposeJudgments(new Error("session ended"));

	await expect(pending).rejects.toThrow("session ended");
	await expect(judgeBatch(request)).rejects.toBeInstanceOf(JudgmentError);
});

it("cancels judgments a handler started when its tool call is aborted", async () => {
	const requestStarted = Promise.withResolvers<void>();
	const scoped = Promise.withResolvers<PromiseSettledResult<unknown>[]>();
	const handlerBlocked = Promise.withResolvers<void>();
	const { runner } = createJudgmentRunner(NATIVE, [
		toolCallExtension(async ctx => {
			if (!ctx.judge || !ctx.judgeBatch) throw new Error("expected judgment context");
			scoped.resolve(
				Promise.allSettled([
					ctx.judge({ state: "handler work", questions: QUESTIONS }),
					ctx.judgeBatch({ items: [{ key: "handler", state: "handler work" }], questions: QUESTIONS }),
				]),
			);
			await handlerBlocked.promise;
		}),
	]);
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch((_url, init) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			requestStarted.resolve();
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			return promise;
		}),
	);
	const controller = new AbortController();
	const emitted = runner.emitToolCall(
		{ type: "tool_call", toolCallId: "call-1", toolName: "judge-probe", input: {} },
		controller.signal,
	);
	await requestStarted.promise;

	controller.abort(new Error("tool call cancelled"));

	const settled = await scoped.promise;
	expect(settled.map(entry => entry.status)).toEqual(["rejected", "rejected"]);
	for (const entry of settled) {
		expect(entry.status === "rejected" && String(entry.reason)).toContain("tool call cancelled");
	}
	handlerBlocked.resolve();
	await emitted;
});
