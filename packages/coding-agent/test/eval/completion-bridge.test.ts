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
import { runEvalCancel, runEvalStatus, runEvalWait } from "../../src/eval/handle-bridge";
import { IdleTimeout } from "../../src/eval/idle-timeout";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { disposeAllKernelSessions, type PythonResult } from "../../src/eval/py/executor";
import type { ToolSession } from "../../src/tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

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
const REASONING_MAX = makeModel("p", "slow-max", {
	api: "anthropic-messages",
	reasoning: true,
	thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max], mode: "anthropic-adaptive" },
});
const REASONING_XHIGH = makeModel("p", "slow-xhigh", {
	api: "anthropic-messages",
	reasoning: true,
	thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh], mode: "anthropic-adaptive" },
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
	const available = opts.available ?? [SMOL, DEFAULT, SLOW];
	const modelRegistry = {
		getAvailable: () => available,
		find: (provider: string, id: string) => available.find(model => model.provider === provider && model.id === id),
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
		'plain_handle = completion("hi", model="smol")',
		"plain = plain_handle.wait()",
		"plain_metadata = plain_handle.metadata()",
		'structured = completion("hi", schema={"type": "object"}).wait()',
		'print(json.dumps({"plain": plain, "plain_metadata": plain_metadata, "structured": structured}))',
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
		find: (provider, id) => (provider === "p" && id === "smol" ? SMOL : undefined),
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

	it("uses the tier fallback chain after the primary model fails", async () => {
		const fallback = makeModel("p", "fallback");
		const session = makeSession({ available: [SMOL, fallback] });
		session.settings.set("retry.fallbackChains", { smol: ["p/fallback"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "quota exhausted" }))
			.mockResolvedValueOnce(assistant({ text: "fallback answer" }));

		const result = await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session });

		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["smol", "fallback"]);
		expect(result).toEqual({
			text: "fallback answer",
			details: { model: "p/fallback", tier: "smol", structured: false },
		});
	});

	it("retries the same model at a lower effort when the fallback chain suffixes it", async () => {
		const session = makeSession({ available: [SMOL, DEFAULT, REASONING_SLOW], roles: { slow: "p/slow" } });
		session.settings.set("retry.fallbackChains", { slow: ["p/slow:low"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "quota exhausted" }))
			.mockResolvedValueOnce(assistant({ text: "low-effort answer" }));

		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]?.text).toBe("low-effort answer");

		const primaryOpts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		const fallbackOpts = spy.mock.calls[1]?.[2] as { reasoning?: unknown };
		expect(primaryOpts.reasoning).toBe(Effort.High);
		expect(fallbackOpts.reasoning).toBe(Effort.Low);
		expect(waited.items[0]?.metadata).toMatchObject({
			finalModel: "p/slow",
			requestEffort: Effort.Low,
			reasoningDisabled: false,
			fallbackUsed: true,
			attempts: [
				{
					candidateIndex: 0,
					model: "p/slow",
					requestEffort: Effort.High,
					reasoningDisabled: false,
					outcome: "failed",
				},
				{
					candidateIndex: 1,
					model: "p/slow",
					requestEffort: Effort.Low,
					reasoningDisabled: false,
					outcome: "succeeded",
				},
			],
		});
	});

	it("applies the tier chain when the role assignment is too unqualified to parse", async () => {
		const fallback = makeModel("p", "fallback");
		const session = makeSession({ available: [SMOL, fallback], roles: { smol: "smol" } });
		session.settings.set("retry.fallbackChains", { smol: ["p/fallback"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "quota exhausted" }))
			.mockResolvedValueOnce(assistant({ text: "fallback answer" }));

		const result = await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session });

		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["smol", "fallback"]);
		expect(result.text).toBe("fallback answer");
	});

	it("walks into a failed fallback's own model chain", async () => {
		const b = makeModel("p", "b");
		const c = makeModel("p", "c");
		const session = makeSession({ available: [SMOL, b, c] });
		session.settings.set("retry.fallbackChains", { smol: ["p/b"], "p/b": ["p/c"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "smol down" }))
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "b down" }))
			.mockResolvedValueOnce(assistant({ text: "c answer" }));

		const result = await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session });

		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["smol", "b", "c"]);
		expect(result.text).toBe("c answer");
	});

	it("terminates on cyclic fallback chains instead of looping", async () => {
		const b = makeModel("p", "b");
		const session = makeSession({ available: [SMOL, b] });
		session.settings.set("retry.fallbackChains", { smol: ["p/b"], "p/b": ["p/smol"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ stopReason: "error", errorMessage: "always down" }));

		await expect(runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session })).rejects.toThrow(
			"always down",
		);
		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["smol", "b"]);
	});

	it("resolves nested fallbacks without the root tier hint", async () => {
		const [b, c, d, e] = ["b", "c", "d", "e"].map(id => makeModel("p", id));
		const session = makeSession({ available: [SMOL, b, c, d, e] });
		session.settings.setModelRole("vision", "p/b");
		session.settings.set("retry.fallbackChains", { smol: ["p/b", "p/c"], vision: ["p/d", "p/e"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "smol down" }))
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "b down" }))
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "d down" }))
			.mockResolvedValueOnce(assistant({ text: "e answer" }));

		const result = await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session });

		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["smol", "b", "d", "e"]);
		expect(result.text).toBe("e answer");
	});

	it("inherits the failed candidate's effort for bare nested entries", async () => {
		const thinking = {
			api: "anthropic-messages",
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High], mode: "anthropic-adaptive" },
		} as const;
		const b = makeModel("p", "b", { ...thinking });
		const c = makeModel("p", "c", { ...thinking });
		const session = makeSession({ available: [REASONING_SLOW, b, c], roles: { slow: "p/slow" } });
		session.settings.set("retry.fallbackChains", { slow: ["p/b:low"], "p/b": ["p/c"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "slow down" }))
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "b down" }))
			.mockResolvedValueOnce(assistant({ text: "c answer" }));

		await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session });

		const efforts = spy.mock.calls.map(call => (call[2] as { reasoning?: unknown }).reasoning);
		expect(efforts).toEqual([Effort.High, Effort.Low, Effort.Low]);
	});

	it("keeps reasoning disabled for bare nested entries after an :off fallback", async () => {
		const thinking = {
			api: "anthropic-messages",
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High], mode: "anthropic-adaptive" },
		} as const;
		const b = makeModel("p", "b", { ...thinking });
		const c = makeModel("p", "c", { ...thinking });
		const session = makeSession({ available: [REASONING_SLOW, b, c], roles: { slow: "p/slow" } });
		session.settings.set("retry.fallbackChains", { slow: ["p/b:off"], "p/b": ["p/c"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "slow down" }))
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "b down" }))
			.mockResolvedValueOnce(assistant({ text: "c answer" }));

		await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session });

		const nested = spy.mock.calls[2]?.[2] as { reasoning?: unknown; disableReasoning?: unknown };
		expect(nested.reasoning).toBeUndefined();
		expect(nested.disableReasoning).toBe(true);
	});

	it("skips keyless fallbacks without spending retry budget", async () => {
		const b = makeModel("p", "b");
		const c = makeModel("p", "c");
		const session = makeSession({ available: [SMOL, b, c] });
		session.settings.set("retry.fallbackChains", { smol: ["p/b", "p/c"] });
		session.settings.set("retry.maxRetries", 1);
		const registry = session.modelRegistry;
		if (!registry) throw new Error("test requires a model registry");
		registry.getApiKey = async model => (model.id === "b" ? undefined : "test-key");
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "smol down" }))
			.mockResolvedValueOnce(assistant({ text: "c answer" }));

		const result = await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session });

		// b never reaches completeSimple: the keyless preflight skips it.
		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["smol", "c"]);
		expect(result.text).toBe("c answer");
	});

	it("walks shared descendants once per inherited effort", async () => {
		const thinking = {
			api: "anthropic-messages",
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High], mode: "anthropic-adaptive" },
		} as const;
		const models = Object.fromEntries(["b", "d", "c", "e"].map(id => [id, makeModel("p", id, { ...thinking })]));
		const session = makeSession({
			available: [REASONING_SLOW, models.b, models.d, models.c, models.e],
			roles: { slow: "p/slow" },
		});
		session.settings.set("retry.fallbackChains", {
			slow: ["p/b:low", "p/d:high"],
			"p/b": ["p/c"],
			"p/d": ["p/c"],
			"p/c": ["p/e"],
		});
		const failures = ["slow", "b", "c:low", "e:low", "d", "c:high"].map(
			name => () => assistant({ stopReason: "error", errorMessage: `${name} down` }),
		);
		const spy = vi.spyOn(ai, "completeSimple");
		for (const respond of failures) spy.mockResolvedValueOnce(respond());
		spy.mockResolvedValue(assistant({ text: "e:high answer" }));

		const result = await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session });

		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["slow", "b", "c", "e", "d", "c", "e"]);
		const efforts = spy.mock.calls.map(call => (call[2] as { reasoning?: unknown }).reasoning);
		expect(efforts).toEqual([Effort.High, Effort.Low, Effort.Low, Effort.Low, Effort.High, Effort.High, Effort.High]);
		expect(result.text).toBe("e:high answer");
	});

	it("stops the candidate walk once retry.maxRetries is spent", async () => {
		const models = ["b1", "b2", "b3"].map(id => makeModel("p", id));
		const session = makeSession({ available: [SMOL, ...models] });
		session.settings.set("retry.fallbackChains", { smol: ["p/b1", "p/b2", "p/b3"] });
		session.settings.set("retry.maxRetries", 1);
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ stopReason: "error", errorMessage: "quota exhausted" }));

		await expect(runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session })).rejects.toThrow(
			"quota exhausted",
		);
		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["smol", "b1"]);
	});

	it("attempts only the primary when retry.maxRetries is zero", async () => {
		const fallback = makeModel("p", "fallback");
		const session = makeSession({ available: [SMOL, fallback] });
		session.settings.set("retry.fallbackChains", { smol: ["p/fallback"] });
		session.settings.set("retry.maxRetries", 0);
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ stopReason: "error", errorMessage: "quota exhausted" }));

		await expect(runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session })).rejects.toThrow(
			"quota exhausted",
		);
		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["smol"]);
	});

	it("forwards the session id to the API key lookup", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession();
		session.getSessionId = () => "sess-1";
		const seen: unknown[][] = [];
		const registry = session.modelRegistry;
		if (!registry) throw new Error("test requires a model registry");
		registry.getApiKey = async (model, sessionId, options) => {
			seen.push([model, sessionId, options]);
			return "test-key";
		};

		await runEvalCompletionAndWait({ prompt: "q", model: "smol" }, { session });

		expect(seen.length).toBe(1);
		expect(seen[0]?.[1]).toBe("sess-1");
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
	it("honors an explicit max effort on the slow role", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({
			available: [REASONING_MAX],
			roles: { slow: "p/slow-max:max" },
		});

		await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session });

		const opts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		expect(opts.reasoning).toBe(Effort.Max);
	});

	it("clamps explicit max to the highest effort supported by the slow model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({
			available: [REASONING_XHIGH],
			roles: { slow: "p/slow-xhigh:max" },
		});

		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		const opts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		expect(opts.reasoning).toBe(Effort.XHigh);
		expect(waited.items[0]?.metadata).toMatchObject({
			configuredEffort: Effort.Max,
			requestEffort: Effort.XHigh,
		});
	});

	it("preserves an explicit off effort on the slow role", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({
			available: [REASONING_SLOW],
			roles: { slow: "p/slow:off" },
		});

		await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session });

		const opts = spy.mock.calls[0]?.[2] as { reasoning?: unknown; disableReasoning?: unknown };
		expect(opts.reasoning).toBeUndefined();
		expect(opts.disableReasoning).toBe(true);
	});
	it("retains non-slow explicit selector metadata without sending provider effort", async () => {
		const cases = [
			{ tier: "smol" as const, roles: { smol: "p/slow-max:max" } },
			{ tier: "default" as const, activeModel: "p/missing", roles: { default: "p/slow-max:max" } },
		];
		for (const testCase of cases) {
			const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
			const session = makeSession({
				available: [REASONING_MAX],
				activeModel: testCase.activeModel,
				roles: testCase.roles,
			});
			const handle = await runEvalCompletion({ prompt: "q", model: testCase.tier }, { session });
			const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

			const options = spy.mock.calls[0]?.[2] as { reasoning?: unknown; disableReasoning?: unknown };
			expect(options.reasoning).toBeUndefined();
			expect(options.disableReasoning).toBe(false);
			expect(waited.items[0]?.metadata).toMatchObject({
				requestedRole: testCase.tier,
				configuredSelector: "p/slow-max:max",
				configuredEffort: Effort.Max,
				requestEffort: null,
				reasoningDisabled: false,
			});
			vi.restoreAllMocks();
		}
	});

	it("keeps auto as configured metadata while retaining the slow tier default", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({
			available: [REASONING_SLOW],
			roles: { slow: "p/slow:auto" },
		});

		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		const firstCall = spy.mock.calls[0];
		if (!firstCall) throw new Error("completion did not call the provider");
		const autoOptions = firstCall[2] as { reasoning?: unknown };
		expect(autoOptions.reasoning).toBe(Effort.High);
		expect(waited.items[0]?.metadata).toMatchObject({
			configuredSelector: "p/slow:auto",
			configuredEffort: "auto",
			requestEffort: Effort.High,
		});
	});

	it("does not reinterpret a literal model id ending in :max as an effort suffix", async () => {
		const literal = makeModel("p", "slow:max", {
			api: "anthropic-messages",
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High], mode: "anthropic-adaptive" },
		});
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({
			available: [literal],
			roles: { slow: "p/slow:max" },
		});

		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		const firstCall = spy.mock.calls[0];
		if (!firstCall) throw new Error("completion did not call the provider");
		const literalModel = firstCall[0] as Model<Api>;
		const literalOptions = firstCall[2] as { reasoning?: unknown };
		expect(literalModel.id).toBe("slow:max");
		expect(literalOptions.reasoning).toBe(Effort.High);
	});

	it("retains provider-option metadata on completion snapshots", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const fallback = makeModel("p", "unused");
		const session = makeSession({
			available: [REASONING_MAX, fallback],
			roles: { slow: "p/slow-max:max" },
		});
		session.settings.set("retry.fallbackChains", { slow: ["p/unused"] });
		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		const waitedMetadata = waited.items[0]?.metadata;
		const statusMetadata = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata;

		expect(spy).toHaveBeenCalledTimes(1);
		expect(waitedMetadata).toEqual({
			requestedRole: "slow",
			configuredSelector: "p/slow-max:max",
			configuredEffort: Effort.Max,
			finalModel: "p/slow-max",
			requestEffort: Effort.Max,
			reasoningDisabled: false,
			fallbackUsed: false,
			effortEvidence: "provider-options",
			attempts: [
				{
					candidateIndex: 0,
					model: "p/slow-max",
					requestEffort: Effort.Max,
					reasoningDisabled: false,
					outcome: "succeeded",
				},
			],
		});
		expect(statusMetadata).toEqual(waitedMetadata);
		if (statusMetadata) statusMetadata.attempts[0]!.model = "tampered";
		expect(
			runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata?.attempts[0]?.model,
		).toBe("p/slow-max");
	});

	it("exposes a running metadata snapshot before the provider settles", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<AssistantMessage>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			started.resolve();
			return await finish.promise;
		});
		const session = makeSession();
		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		await started.promise;

		const running = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session });
		expect(running.status).toBe("running");
		expect(running.metadata).toMatchObject({
			requestedRole: "slow",
			finalModel: "p/slow",
			requestEffort: null,
			reasoningDisabled: false,
			attempts: [
				{
					candidateIndex: 0,
					model: "p/slow",
					requestEffort: null,
					reasoningDisabled: false,
					outcome: "running",
				},
			],
		});

		finish.resolve(assistant({ text: "done" }));
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]?.status).toBe("completed");
	});

	it("retains cancelled provider request metadata", async () => {
		const started = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, requestOptions) => {
			started.resolve();
			const signal = requestOptions?.signal;
			if (!signal) throw new Error("completion provider request did not receive an abort signal");
			if (signal.aborted) throw signal.reason;
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			throw new Error("unreachable");
		});
		const session = makeSession();
		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		await started.promise;

		expect(runEvalCancel({ item: { kind: "completion", id: handle.id } }, { session })).toEqual({ cancelled: true });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		expect(waited.items[0]?.status).toBe("cancelled");
		expect(waited.items[0]?.metadata).toMatchObject({
			finalModel: "p/slow",
			requestEffort: null,
			reasoningDisabled: false,
			attempts: [
				{
					candidateIndex: 0,
					model: "p/slow",
					requestEffort: null,
					reasoningDisabled: false,
					outcome: "cancelled",
				},
			],
		});
	});

	it("records fallback request metadata without claiming an unused fallback", async () => {
		const fallback = makeModel("p", "fallback");
		const session = makeSession({
			available: [REASONING_MAX, fallback],
			roles: { slow: "p/slow-max:max" },
		});
		session.settings.set("retry.fallbackChains", { slow: ["p/fallback"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "primary down" }))
			.mockResolvedValueOnce(assistant({ text: "fallback answer" }));

		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		expect(waited.items[0]?.metadata).toMatchObject({
			finalModel: "p/fallback",
			requestEffort: null,
			reasoningDisabled: false,
			fallbackUsed: true,
			attempts: [
				{
					candidateIndex: 0,
					model: "p/slow-max",
					requestEffort: Effort.Max,
					reasoningDisabled: false,
					outcome: "failed",
				},
				{
					candidateIndex: 1,
					model: "p/fallback",
					requestEffort: null,
					reasoningDisabled: false,
					outcome: "succeeded",
				},
			],
		});
		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["slow-max", "fallback"]);
	});

	it("keeps completion metadata scoped to the owning agent session", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "private" }));
		const owner = makeSession();
		owner.getAgentId = () => "owner-a";
		const other = makeSession();
		other.getAgentId = () => "owner-b";
		try {
			const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session: owner });
			expect(() => runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session: other })).toThrow(
				"unknown completion handle",
			);
			const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session: owner });
			expect(waited.items[0]?.metadata?.finalModel).toBe("p/smol");
		} finally {
			releaseCompletionHandles("owner-a");
		}
	});

	it("records skipped candidates without fabricating provider request evidence", async () => {
		const session = makeSession({
			available: [REASONING_MAX],
			apiKey: null,
			roles: { slow: "p/slow-max:max" },
		});
		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		const snapshot = waited.items[0];

		expect(snapshot?.status).toBe("failed");
		expect(snapshot?.metadata).toEqual({
			requestedRole: "slow",
			configuredSelector: "p/slow-max:max",
			configuredEffort: Effort.Max,
			finalModel: null,
			requestEffort: null,
			reasoningDisabled: null,
			fallbackUsed: false,
			effortEvidence: "provider-options",
			attempts: [
				{
					candidateIndex: 0,
					model: "p/slow-max",
					requestEffort: null,
					reasoningDisabled: false,
					outcome: "skipped-no-credentials",
				},
			],
		});
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

	it("exposes live completion metadata through the JavaScript handle", async () => {
		using tempDir = TempDir.createSync("@omp-eval-completion-js-metadata-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-completion-metadata:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "hello with metadata" }));

		const result = await executeJs(
			[
				'const pending = completion("hi", { model: "slow" });',
				"const before = await pending.metadata();",
				"const value = await pending.wait();",
				"const after = await pending.metadata();",
				"return JSON.stringify({ value, beforeRole: before?.requestedRole, after });",
			].join("\n"),
			{ cwd: tempDir.path(), sessionId, session: makeSession(), sessionFile },
		);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.output.trim()) as {
			value: string;
			beforeRole: string;
			after: Record<string, unknown>;
		};
		expect(output.value).toBe("hello with metadata");
		expect(output.beforeRole).toBe("slow");
		expect(output.after).toMatchObject({
			requestedRole: "slow",
			configuredSelector: "p/slow",
			configuredEffort: null,
			finalModel: "p/slow",
			requestEffort: null,
			reasoningDisabled: false,
			fallbackUsed: false,
			effortEvidence: "provider-options",
		});
		expect(output.after.attempts).toEqual([
			{
				candidateIndex: 0,
				model: "p/slow",
				requestEffort: null,
				reasoningDisabled: false,
				outcome: "succeeded",
			},
		]);
	});

	it("exposes plain and structured completion() in the Python runtime", async () => {
		const tempDir = TempDir.createSync("@omp-eval-completion-py-");
		try {
			const result = await runPythonCompletionsInSubprocess(tempDir);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output.trim())).toEqual({
				plain: "hello from python",
				plain_metadata: {
					requestedRole: "smol",
					configuredSelector: "p/smol",
					configuredEffort: null,
					finalModel: "p/smol",
					requestEffort: null,
					reasoningDisabled: false,
					fallbackUsed: false,
					effortEvidence: "provider-options",
					attempts: [
						{
							candidateIndex: 0,
							model: "p/smol",
							requestEffort: null,
							reasoningDisabled: false,
							outcome: "succeeded",
						},
					],
				},
				structured: { ok: true },
			});
		} finally {
			tempDir.removeSync();
		}
	});
});
