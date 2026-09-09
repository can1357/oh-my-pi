import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../../src/eval/bridge-timeout";
import {
	getCompletionHandle,
	releaseCompletionHandles,
	runEvalCompletion,
	type EvalCompletionBridgeOptions,
	type EvalCompletionResult,
} from "../../src/eval/completion-bridge";
import { runEvalWait } from "../../src/eval/handle-bridge";
import { IdleTimeout } from "../../src/eval/idle-timeout";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { disposeAllKernelSessions, type PythonResult } from "../../src/eval/py/executor";
import type { ToolSession } from "../../src/tools";
import { ToolError } from "../../src/tools/tool-errors";

async function runEvalCompletionAndWait(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionResult> {
	const handle = await runEvalCompletion(args, options);
	const entry = getCompletionHandle(handle.id);
	if (!entry) throw new Error(`Missing completion handle ${handle.id}`);
	const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, options);
	const snapshot = waited.items[0];
	if (snapshot?.status === "failed" || snapshot?.status === "cancelled") {
		throw new ToolError(snapshot.error || `Completion handle ${handle.id} failed`);
	}
	if (entry.error) throw new ToolError(entry.error);
	if (!entry.result) throw new Error(`Completion handle ${handle.id} returned no result`);
	return entry.result;
}

function makeModel(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
		...extra,
	} as Model<Api>;
}

const SMOL = makeModel("p", "smol");
const DEFAULT = makeModel("p", "default");
const SLOW = makeModel("p", "slow");
const REASONING_SLOW = makeModel("p", "slow", {
	api: "anthropic-messages",
	reasoning: true,
	thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High], mode: "anthropic-adaptive" },
});

interface SessionOptions {
	available?: Model<Api>[];
	apiKey?: string | null;
	activeModel?: string;
	roles?: Partial<Record<"smol" | "default" | "slow", string>>;
}

function makeSession(opts: SessionOptions = {}): ToolSession {
	const settings = Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false });
	const roles = opts.roles ?? { smol: "p/smol", slow: "p/slow" };
	for (const role in roles) {
		const value = roles[role as keyof typeof roles];
		if (value) settings.setModelRole(role, value);
	}
	const modelRegistry = {
		getAvailable: () => opts.available ?? [SMOL, DEFAULT, SLOW],
		getApiKey: async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
		resolver: () => async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
	} as unknown as ModelRegistry;
	return {
		settings,
		modelRegistry,
		getActiveModelString: () => opts.activeModel ?? "p/default",
	} as unknown as ToolSession;
}

function assistant(opts: {
	text?: string;
	toolCall?: { name: string; arguments: Record<string, unknown> };
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (opts.text) content.push({ type: "text", text: opts.text });
	if (opts.toolCall) {
		content.push({ type: "toolCall", id: "tc-1", name: opts.toolCall.name, arguments: opts.toolCall.arguments });
	}
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "p",
		model: "default",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: opts.stopReason ?? "stop",
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}

async function runPythonCompletionsInSubprocess(tempDir: TempDir): Promise<PythonResult> {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const scriptPath = path.join(tempDir.path(), "run-python-completion.ts");
	const resultPath = path.join(tempDir.path(), "python-completion-result.json");
	const aiPath = path.resolve(import.meta.dir, "../../../ai/src/index.ts");
	const executorPath = path.resolve(import.meta.dir, "../../src/eval/py/executor.ts");
	const settingsPath = path.resolve(import.meta.dir, "../../src/config/settings.ts");
	const code = [
		"import json",
		'plain = completion("hi", model="smol").wait()',
		'structured = completion("hi", schema={"type": "object"}).wait()',
		'print(json.dumps({"plain": plain, "structured": structured}))',
	].join("\n");
	await Bun.write(
		scriptPath,
		`
import { vi } from "bun:test";
import * as ai from ${JSON.stringify(aiPath)};
import { executePython } from ${JSON.stringify(executorPath)};
import { Settings } from ${JSON.stringify(settingsPath)};

const SMOL = {
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
};
const settings = Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false });
settings.setModelRole("smol", "p/smol");
settings.setModelRole("slow", "p/slow");
const session = {
	settings,
	modelRegistry: {
		getAvailable: () => [SMOL],
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	},
	getActiveModelString: () => "p/smol",
};
vi.spyOn(ai, "completeSimple")
	.mockResolvedValueOnce({
		role: "assistant",
		api: "openai-responses",
		provider: "p",
		model: "smol",
		stopReason: "stop",
		content: [{ type: "text", text: "hello from python" }],
	})
	.mockResolvedValueOnce({
		role: "assistant",
		api: "openai-responses",
		provider: "p",
		model: "smol",
		stopReason: "stop",
		content: [{ type: "toolCall", id: "tc-1", name: "respond", arguments: { ok: true } }],
	});
const result = await executePython(${JSON.stringify(code)}, {
	cwd: ${JSON.stringify(tempDir.path())},
	sessionId: "py-completion",
	sessionFile: ${JSON.stringify(path.join(tempDir.path(), "session.jsonl"))},
	toolSession: session,
	kernelMode: "per-call",
});
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));
process.exit(0);
`,
	);
	const child = await $`bun ${scriptPath}`.cwd(repoRoot).quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0)
		throw new Error(stderr || stdout || `Python completion subprocess exited with ${child.exitCode}`);
	return (await Bun.file(resultPath).json()) as PythonResult;
}

describe("runEvalCompletion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		releaseCompletionHandles("Main");
	});

	it("resolves each tier to its expected model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession();

		await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session });
		await runEvalCompletionAndWait({ prompt: "q", model: "default" }, { session });
		await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session });

		const resolved = spy.mock.calls.map(call => {
			const model = call[0] as Model<Api>;
			return `${model.provider}/${model.id}`;
		});
		expect(resolved).toEqual(["p/smol", "p/default", "p/slow"]);
	});

	it("prefers the session active model for the default tier, falling back to @default", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({ available: [SMOL, DEFAULT, SLOW], activeModel: "p/slow" });

		await runEvalCompletionAndWait({ prompt: "q", model: "default" }, { session });

		const model = spy.mock.calls[0]?.[0] as Model<Api>;
		expect(`${model.provider}/${model.id}`).toBe("p/slow");
	});

	it("returns the completion text in plain mode", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "the answer" }));
		const result = await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session: makeSession() });
		expect(result.text).toBe("the answer");
		expect(result.details).toEqual({ model: "p/smol", tier: "smol", structured: false });
	});

	it("supplies a non-empty systemPrompt when system is omitted (codex 'Instructions are required' guard)", async () => {
		// The openai-codex Responses transformer drops `instructions` when no
		// system prompt is provided, and the remote endpoint then 400s with
		// "Instructions are required". runEvalCompletion must always carry a non-empty
		// systemPrompt so `completion("…")` without a `system` argument works.
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session: makeSession() });
		const ctx = spy.mock.calls[0]?.[1] as { systemPrompt?: string[] };
		expect(ctx.systemPrompt).toBeDefined();
		expect(ctx.systemPrompt?.length).toBeGreaterThan(0);
		expect(ctx.systemPrompt?.[0]).toMatch(/.+/);
	});

	it("honors an explicit system prompt instead of overriding it", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		await runEvalCompletionAndWait({ prompt: "q", model: "smol", system: "Be terse." }, { session: makeSession() });
		const ctx = spy.mock.calls[0]?.[1] as { systemPrompt?: string[] };
		expect(ctx.systemPrompt).toEqual(["Be terse."]);
	});

	it("forces a respond tool call and returns its arguments in structured mode", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ toolCall: { name: "respond", arguments: { answer: 42 } } }));
		const result = await runEvalCompletionAndWait(
			{ prompt: "q", model: "smol", schema: { type: "object", properties: { answer: { type: "number" } } } },
			{ session: makeSession() },
		);

		expect(JSON.parse(result.text)).toEqual({ answer: 42 });
		expect(result.details.structured).toBe(true);

		const ctx = spy.mock.calls[0]?.[1] as { tools?: Array<{ name: string }> };
		const opts = spy.mock.calls[0]?.[2] as { toolChoice?: unknown };
		expect(ctx.tools?.[0]?.name).toBe("respond");
		expect(opts.toolChoice).toEqual({ type: "tool", name: "respond" });
	});

	it("falls back to JSON embedded in text when the model skips the respond tool", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: 'here: {"answer": 7}' }));
		const result = await runEvalCompletionAndWait(
			{ prompt: "q", model: "smol", schema: { type: "object" } },
			{ session: makeSession() },
		);
		expect(JSON.parse(result.text)).toEqual({ answer: 7 });
	});

	it("requests reasoning only for the slow tier on a reasoning-capable model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({ available: [SMOL, DEFAULT, REASONING_SLOW] });

		await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session });
		await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session });

		const smolOpts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		const slowOpts = spy.mock.calls[1]?.[2] as { reasoning?: unknown };
		expect(smolOpts.reasoning).toBeUndefined();
		expect(slowOpts.reasoning).toBe(Effort.High);
	});

	it("does not request reasoning for the slow tier on a non-reasoning model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		// SLOW is reasoning:false — must not trip requireSupportedEffort downstream.
		const result = await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session: makeSession() });
		expect(result.text).toBe("ok");
		const opts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		expect(opts.reasoning).toBeUndefined();
	});

	it("throws ToolError on invalid arguments", async () => {
		await expect(runEvalCompletionAndWait({ prompt: "" }, { session: makeSession() })).rejects.toBeInstanceOf(
			ToolError,
		);
		await expect(
			runEvalCompletionAndWait({ prompt: "q", model: "huge" }, { session: makeSession() }),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("throws ToolError when no model resolves for the tier", async () => {
		const session = makeSession({ available: [DEFAULT], roles: { smol: "missing/model" } });
		await expect(runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session })).rejects.toBeInstanceOf(
			ToolError,
		);
	});

	it("throws ToolError when the resolved model has no API key", async () => {
		const session = makeSession({ apiKey: null });
		await expect(runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session })).rejects.toBeInstanceOf(
			ToolError,
		);
	});

	it("maps error and aborted stop reasons to ToolError", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "boom" }));
		await expect(
			runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session: makeSession() }),
		).rejects.toThrow("boom");

		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(assistant({ stopReason: "aborted" }));
		await expect(
			runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session: makeSession() }),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("throws ToolError when plain mode produces no text", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "" }));
		await expect(
			runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session: makeSession() }),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("pauses the idle watchdog while a slow completion() request is in flight", async () => {
		vi.useFakeTimers();
		try {
			// A oneshot completion emits no status until it returns; delegated model
			// time must be invisible to the eval timeout budget.
			const started = Promise.withResolvers<void>();
			vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
				started.resolve();
				await Bun.sleep(200);
				return assistant({ text: "the answer" });
			});

			const ops: string[] = [];
			using idle = new IdleTimeout(60);
			const pendingResult = runEvalCompletionAndWait(
				{ prompt: "q", model: "smol" },
				{
					session: makeSession(),
					signal: idle.signal,
					emitStatus: event => {
						ops.push(event.op);
						if (event.op === EVAL_TIMEOUT_PAUSE_OP) idle.pause();
						if (event.op === EVAL_TIMEOUT_RESUME_OP) idle.resume();
					},
				},
			);
			await started.promise;
			vi.advanceTimersByTime(200);
			const result = await pendingResult;

			expect(result.text).toBe("the answer");
			expect(ops).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
			expect(idle.signal.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("completion() through eval runtimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		releaseCompletionHandles("Main");
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		await disposeAllKernelSessions();
	});

	it("exposes plain and structured completion() in the JavaScript runtime", async () => {
		using tempDir = TempDir.createSync("@omp-eval-completion-js-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-completion:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ text: "hello from smol" }))
			.mockResolvedValueOnce(assistant({ toolCall: { name: "respond", arguments: { ok: true, n: 3 } } }));

		const result = await executeJs(
			[
				'const handles = [completion("hi", { model: "smol" }), completion("hi", { schema: { type: "object" } })];',
				"const [plain, structured] = await wait(handles);",
				"return JSON.stringify({ plain, structured });",
			].join("\n"),
			{ cwd: tempDir.path(), sessionId, session: makeSession(), sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({
			plain: "hello from smol",
			structured: { ok: true, n: 3 },
		});
	});

	it("exposes plain and structured completion() in the Python runtime", async () => {
		const tempDir = TempDir.createSync("@omp-eval-completion-py-");
		try {
			const result = await runPythonCompletionsInSubprocess(tempDir);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output.trim())).toEqual({
				plain: "hello from python",
				structured: { ok: true },
			});
		} finally {
			tempDir.removeSync();
		}
	});
});
