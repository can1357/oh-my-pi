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
	EVAL_HANDLE_CONCURRENCY,
	evalRequestSlots,
	getCompletionHandle,
	releaseCompletionHandles,
	retainCompletionHandle,
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

import { cfgRetryFallbackChains, cfgRetryMaxRetries } from "@oh-my-pi/pi-coding-agent/session/settings";

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
	cwd?: string;
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
		cwd: opts.cwd ?? process.cwd(),
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
		// `await` resolves on a worker thread; it must keep the cell's run context.
		'structured = await completion("hi", schema={"type": "object"})',
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
	cwd: ${JSON.stringify(tempDir.path())},
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

	it("uses the tier fallback chain after the primary model fails", async () => {
		const fallback = makeModel("p", "fallback");
		const session = makeSession({ available: [SMOL, fallback] });
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/fallback"] });
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
		cfgRetryFallbackChains.set(session.settings, { slow: ["p/slow:low"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "quota exhausted" }))
			.mockResolvedValueOnce(assistant({ text: "low-effort answer" }));

		const result = await runEvalCompletionAndWait({ prompt: "q", model: "slow" }, { session });
		expect(spy.mock.calls.map(call => (call[0] as Model<Api>).id)).toEqual(["slow", "slow"]);
		const primaryOpts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		const fallbackOpts = spy.mock.calls[1]?.[2] as { reasoning?: unknown };
		expect(primaryOpts.reasoning).toBe(Effort.High);
		expect(fallbackOpts.reasoning).toBe(Effort.Low);
		expect(result.text).toBe("low-effort answer");
	});

	it("applies the tier chain when the role assignment is too unqualified to parse", async () => {
		const fallback = makeModel("p", "fallback");
		const session = makeSession({ available: [SMOL, fallback], roles: { smol: "smol" } });
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/fallback"] });
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
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/b"], "p/b": ["p/c"] });
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
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/b"], "p/b": ["p/smol"] });
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
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/b", "p/c"], vision: ["p/d", "p/e"] });
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
		cfgRetryFallbackChains.set(session.settings, { slow: ["p/b:low"], "p/b": ["p/c"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "slow down" }))
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "b down" }))
			.mockResolvedValueOnce(assistant({ text: "c answer" }));

		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		const providerOptions = spy.mock.calls.map(call => call[2] as { reasoning?: Effort; disableReasoning?: boolean });
		expect(providerOptions.map(options => options.reasoning)).toEqual([Effort.High, Effort.Low, Effort.Low]);
		const finalOptions = providerOptions[providerOptions.length - 1];
		const metadata = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata;
		expect(metadata).toMatchObject({
			requestedRole: "slow",
			configuredSelector: "p/slow",
			configuredEffort: null,
			fallbackUsed: true,
			effortEvidence: "provider-options",
		});
		expect(metadata?.requestEffort).toBe(finalOptions?.reasoning ?? null);
		expect(metadata?.reasoningDisabled).toBe(finalOptions?.disableReasoning ?? null);
		expect(
			metadata?.attempts.map(attempt => ({
				requestEffort: attempt.requestEffort,
				reasoningDisabled: attempt.reasoningDisabled,
				outcome: attempt.outcome,
			})),
		).toEqual(
			providerOptions.map((options, index) => ({
				requestEffort: options.reasoning ?? null,
				reasoningDisabled: options.disableReasoning ?? null,
				outcome: index === providerOptions.length - 1 ? "succeeded" : "failed",
			})),
		);
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
		cfgRetryFallbackChains.set(session.settings, { slow: ["p/b:off"], "p/b": ["p/c"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "slow down" }))
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "b down" }))
			.mockResolvedValueOnce(assistant({ text: "c answer" }));

		const handle = await runEvalCompletion({ prompt: "q", model: "slow" }, { session });
		await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		const providerOptions = spy.mock.calls.map(call => call[2] as { reasoning?: Effort; disableReasoning?: boolean });
		expect(providerOptions.map(options => [options.reasoning, options.disableReasoning])).toEqual([
			[Effort.High, false],
			[undefined, true],
			[undefined, true],
		]);
		const finalOptions = providerOptions[providerOptions.length - 1];
		const metadata = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata;
		expect(metadata).toMatchObject({
			requestedRole: "slow",
			configuredSelector: "p/slow",
			configuredEffort: null,
			finalModel: "p/c",
			fallbackUsed: true,
			effortEvidence: "provider-options",
		});
		expect(metadata?.requestEffort).toBe(finalOptions?.reasoning ?? null);
		expect(metadata?.reasoningDisabled).toBe(finalOptions?.disableReasoning ?? null);
		expect(
			metadata?.attempts.map(attempt => ({
				requestEffort: attempt.requestEffort,
				reasoningDisabled: attempt.reasoningDisabled,
				outcome: attempt.outcome,
			})),
		).toEqual(
			providerOptions.map((options, index) => ({
				requestEffort: options.reasoning ?? null,
				reasoningDisabled: options.disableReasoning ?? null,
				outcome: index === providerOptions.length - 1 ? "succeeded" : "failed",
			})),
		);
	});

	it("skips keyless fallbacks without spending retry budget", async () => {
		const b = makeModel("p", "b");
		const c = makeModel("p", "c");
		const session = makeSession({ available: [SMOL, b, c] });
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/b", "p/c"] });
		cfgRetryMaxRetries.set(session.settings, 1);
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
		cfgRetryFallbackChains.set(session.settings, {
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
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/b1", "p/b2", "p/b3"] });
		cfgRetryMaxRetries.set(session.settings, 1);
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
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/fallback"] });
		cfgRetryMaxRetries.set(session.settings, 0);
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

	it("exposes live metadata through status while keeping wait snapshots unchanged", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<AssistantMessage>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			started.resolve();
			return await finish.promise;
		});
		const session = makeSession();
		const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		await started.promise;

		const running = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session });
		expect(running).toMatchObject({
			kind: "completion",
			id: handle.id,
			status: "running",
			metadata: {
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
						outcome: "running",
					},
				],
			},
		});

		finish.resolve(assistant({ text: "done" }));
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]).toEqual({
			kind: "completion",
			id: handle.id,
			status: "completed",
			text: "done",
		});
		expect(Object.hasOwn(waited.items[0] ?? {}, "metadata")).toBe(false);

		const settled = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session });
		expect(settled.metadata?.attempts[0]?.outcome).toBe("succeeded");
	});

	it("reports configured selector effort separately from provider request options", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({ roles: { smol: "p/smol:max" } });
		const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });

		const options = spy.mock.calls[0]?.[2] as { reasoning?: unknown; disableReasoning?: unknown };
		expect(options.reasoning).toBeUndefined();
		expect(options.disableReasoning).toBe(false);
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata).toMatchObject({
			configuredSelector: "p/smol:max",
			configuredEffort: "max",
			requestEffort: null,
			reasoningDisabled: false,
			effortEvidence: "provider-options",
		});
	});

	it("captures max from short smol and default selectors without changing provider options", async () => {
		const short = makeModel("p", "a", {
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max], mode: "effort" },
		});
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({
			available: [short],
			roles: { smol: "p/a:max", default: "p/a:max" },
		});

		for (const tier of ["smol", "default"] as const) {
			const handle = await runEvalCompletion({ prompt: "q", model: tier }, { session });
			await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
			expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata).toMatchObject({
				requestedRole: tier,
				configuredSelector: "p/a:max",
				configuredEffort: Effort.Max,
				finalModel: "p/a",
				requestEffort: null,
				reasoningDisabled: false,
				fallbackUsed: false,
			});
		}

		expect(
			spy.mock.calls.map(call => {
				const options = call[2] as { reasoning?: unknown; disableReasoning?: unknown };
				return [options.reasoning, options.disableReasoning];
			}),
		).toEqual([
			[undefined, false],
			[undefined, false],
		]);
	});

	it("does not infer effort from unqualified literal max and auto model IDs", async () => {
		const makeLiteral = (id: string) =>
			makeModel("p", id, {
				reasoning: true,
				thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max], mode: "effort" },
			});
		const maxLiteral = makeLiteral("a:max");
		const autoLiteral = makeLiteral("a:auto");
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({
			available: [maxLiteral, autoLiteral],
			roles: { smol: "a:max" },
		});

		for (const selector of ["A:max", "a:auto"] as const) {
			session.settings.setModelRole("smol", selector);
			const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
			await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
			expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata).toMatchObject({
				requestedRole: "smol",
				configuredSelector: selector,
				configuredEffort: null,
				finalModel: `p/${selector.toLowerCase()}`,
				requestEffort: null,
				reasoningDisabled: false,
				fallbackUsed: false,
			});
		}

		expect(
			spy.mock.calls.map(call => {
				const options = call[2] as { reasoning?: unknown; disableReasoning?: unknown };
				return [options.reasoning, options.disableReasoning];
			}),
		).toEqual([
			[undefined, false],
			[undefined, false],
		]);
	});

	it("records primary failure and fallback success without claiming an unused request", async () => {
		const fallback = makeModel("p", "fallback");
		const session = makeSession({ available: [SMOL, fallback] });
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/fallback"] });
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "primary down" }))
			.mockResolvedValueOnce(assistant({ text: "fallback answer" }));

		const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]).toMatchObject({ status: "completed", text: "fallback answer" });
		expect(Object.hasOwn(waited.items[0] ?? {}, "metadata")).toBe(false);
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata).toEqual({
			requestedRole: "smol",
			configuredSelector: "p/smol",
			configuredEffort: null,
			finalModel: "p/fallback",
			requestEffort: null,
			reasoningDisabled: false,
			fallbackUsed: true,
			effortEvidence: "provider-options",
			attempts: [
				{
					candidateIndex: 0,
					model: "p/smol",
					requestEffort: null,
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
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("preserves raw multi-item wait order without completion metadata", async () => {
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => assistant({ text: model.id }));
		const session = makeSession();
		const first = await runEvalCompletion({ prompt: "first", model: "smol" }, { session });
		const second = await runEvalCompletion({ prompt: "second", model: "default" }, { session });

		const waited = await runEvalWait(
			{
				items: [
					{ kind: "completion", id: second.id },
					{ kind: "completion", id: first.id },
				],
			},
			{ session },
		);
		expect(
			waited.items.map(item => ({
				id: item.id,
				status: item.status,
				text: item.text,
				hasMetadata: Object.hasOwn(item, "metadata"),
			})),
		).toEqual([
			{ id: second.id, status: "completed", text: "default", hasMetadata: false },
			{ id: first.id, status: "completed", text: "smol", hasMetadata: false },
		]);
	});

	it("omits retry-budget-truncated candidates from metadata", async () => {
		const models = ["b", "c"].map(id => makeModel("p", id));
		const session = makeSession({ available: [SMOL, ...models] });
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/b", "p/c"] });
		cfgRetryMaxRetries.set(session.settings, 1);
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ stopReason: "error", errorMessage: "all unavailable" }));

		const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]?.status).toBe("failed");
		const metadata = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata;
		expect(metadata?.attempts.map(attempt => [attempt.candidateIndex, attempt.outcome])).toEqual([
			[0, "failed"],
			[1, "failed"],
		]);
		expect(metadata?.attempts).toHaveLength(2);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("records structured parsing failures as failed provider attempts", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "not-json" }));
		const session = makeSession();
		const handle = await runEvalCompletion({ prompt: "q", model: "smol", schema: { type: "object" } }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]).toMatchObject({ status: "failed" });
		expect(Object.hasOwn(waited.items[0] ?? {}, "metadata")).toBe(false);
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata).toMatchObject({
			finalModel: "p/smol",
			requestEffort: null,
			reasoningDisabled: false,
			attempts: [
				{
					candidateIndex: 0,
					model: "p/smol",
					requestEffort: null,
					reasoningDisabled: false,
					outcome: "failed",
				},
			],
		});
	});

	it("records missing credentials without fabricating adapter evidence", async () => {
		const session = makeSession({ apiKey: null });
		const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]?.status).toBe("failed");
		const metadata = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata;
		expect(metadata).toEqual({
			requestedRole: "smol",
			configuredSelector: "p/smol",
			configuredEffort: null,
			finalModel: null,
			requestEffort: null,
			reasoningDisabled: null,
			fallbackUsed: false,
			effortEvidence: "provider-options",
			attempts: [
				{
					candidateIndex: 0,
					model: "p/smol",
					requestEffort: null,
					reasoningDisabled: null,
					outcome: "skipped-no-credentials",
				},
			],
		});
	});

	it("records adapter entry after cancellation during credential preflight", async () => {
		const lookupStarted = Promise.withResolvers<void>();
		const releaseLookup = Promise.withResolvers<void>();
		const observedSignals: AbortSignal[] = [];
		const spy = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, requestOptions) => {
			if (requestOptions?.signal) observedSignals.push(requestOptions.signal);
			throw new Error("adapter request receives an already-aborted signal");
		});
		const session = makeSession();
		const registry = session.modelRegistry;
		if (!registry) throw new Error("test requires a model registry");
		registry.getApiKey = async () => {
			lookupStarted.resolve();
			await releaseLookup.promise;
			return "test-key";
		};

		const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		await lookupStarted.promise;
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session })).toMatchObject({
			status: "running",
			metadata: {
				finalModel: null,
				requestEffort: null,
				reasoningDisabled: null,
				fallbackUsed: false,
				attempts: [
					{
						candidateIndex: 0,
						model: "p/smol",
						requestEffort: null,
						reasoningDisabled: null,
						outcome: "running",
					},
				],
			},
		});
		expect(runEvalCancel({ item: { kind: "completion", id: handle.id } }, { session })).toEqual({ cancelled: true });
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session })).toMatchObject({
			status: "running",
			metadata: {
				finalModel: null,
				requestEffort: null,
				reasoningDisabled: null,
				fallbackUsed: false,
				attempts: [{ candidateIndex: 0, outcome: "running" }],
			},
		});

		releaseLookup.resolve();
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]?.status).toBe("cancelled");
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session })).toMatchObject({
			status: "cancelled",
			metadata: {
				finalModel: "p/smol",
				requestEffort: null,
				reasoningDisabled: false,
				fallbackUsed: false,
				attempts: [
					{
						candidateIndex: 0,
						model: "p/smol",
						requestEffort: null,
						reasoningDisabled: false,
						outcome: "cancelled",
					},
				],
			},
		});
		expect(spy).toHaveBeenCalledTimes(1);
		expect(observedSignals).toHaveLength(1);
		expect(observedSignals[0]?.aborted).toBe(true);
	});

	it("records fallback adapter entry when cancellation happens during fallback credentials", async () => {
		const lookupStarted = Promise.withResolvers<void>();
		const releaseLookup = Promise.withResolvers<void>();
		const session = makeSession();
		cfgRetryFallbackChains.set(session.settings, { smol: ["p/default"] });
		const registry = session.modelRegistry;
		if (!registry) throw new Error("test requires a model registry");
		registry.getApiKey = async model => {
			if (model.id === "default") {
				lookupStarted.resolve();
				await releaseLookup.promise;
			}
			return "test-key";
		};
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "primary failed" }))
			.mockImplementationOnce(async (_model, _context, options) => {
				expect(options?.signal?.aborted).toBe(true);
				throw new Error("cancelled fallback adapter");
			});
		const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		await lookupStarted.promise;
		runEvalCancel({ item: { kind: "completion", id: handle.id } }, { session });
		releaseLookup.resolve();
		await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(spy).toHaveBeenCalledTimes(2);
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session })).toMatchObject({
			status: "cancelled",
			metadata: {
				finalModel: "p/default",
				requestEffort: null,
				reasoningDisabled: false,
				fallbackUsed: true,
				attempts: [
					{ model: "p/smol", outcome: "failed" },
					{ model: "p/default", reasoningDisabled: false, outcome: "cancelled" },
				],
			},
		});
	});

	it("cancels a queued completion without fabricating a provider attempt", async () => {
		let heldSlots = 0;
		try {
			for (let index = 0; index < EVAL_HANDLE_CONCURRENCY; index++) {
				await evalRequestSlots.acquire();
				heldSlots++;
			}
			const spy = vi.spyOn(ai, "completeSimple");
			const session = makeSession();
			const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
			expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session })).toMatchObject({
				status: "running",
				metadata: {
					finalModel: null,
					requestEffort: null,
					reasoningDisabled: null,
					fallbackUsed: false,
					attempts: [],
				},
			});
			expect(runEvalCancel({ item: { kind: "completion", id: handle.id } }, { session })).toEqual({
				cancelled: true,
			});
			const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
			expect(waited.items[0]?.status).toBe("cancelled");
			expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session })).toMatchObject({
				status: "cancelled",
				metadata: {
					finalModel: null,
					requestEffort: null,
					reasoningDisabled: null,
					fallbackUsed: false,
					attempts: [],
				},
			});
			expect(spy).not.toHaveBeenCalled();
		} finally {
			for (let index = 0; index < heldSlots; index++) evalRequestSlots.release();
		}
	});

	it("retains the last observed provider options when a request is cancelled", async () => {
		const started = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, requestOptions) => {
			started.resolve();
			const signal = requestOptions?.signal;
			if (!signal) throw new Error("completion provider request did not receive an abort signal");
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			throw new Error("unreachable");
		});
		const session = makeSession();
		const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		await started.promise;
		expect(runEvalCancel({ item: { kind: "completion", id: handle.id } }, { session })).toEqual({ cancelled: true });
		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]?.status).toBe("cancelled");
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata).toMatchObject({
			finalModel: "p/smol",
			requestEffort: null,
			reasoningDisabled: false,
			attempts: [
				{
					candidateIndex: 0,
					model: "p/smol",
					requestEffort: null,
					reasoningDisabled: false,
					outcome: "cancelled",
				},
			],
		});
	});

	it("isolates metadata snapshots and preserves owner and retention boundaries", async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "private" }));
			const owner = makeSession();
			owner.getAgentId = () => "metadata-owner";
			const other = makeSession();
			other.getAgentId = () => "metadata-other";
			const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, { session: owner });
			await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session: owner });

			const copy = runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session: owner });
			if (!copy.metadata) throw new Error("completion status did not include metadata");
			copy.metadata.attempts[0]!.model = "tampered";
			expect(
				runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session: owner }).metadata?.attempts[0]
					?.model,
			).toBe("p/smol");
			expect(() => runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session: other })).toThrow(
				"unknown completion handle",
			);

			vi.advanceTimersByTime(30 * 60 * 1000 - 1);
			expect(
				runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session: owner }).metadata,
			).not.toBeNull();
			vi.advanceTimersByTime(1);
			expect(() => runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session: owner })).toThrow(
				"unknown completion handle",
			);
		} finally {
			vi.useRealTimers();
			releaseCompletionHandles("metadata-owner");
		}
	});

	it("returns null metadata for legacy retained completion handles", async () => {
		const session = makeSession();
		const handle = retainCompletionHandle("legacy", { session }, async () => ({
			text: "legacy",
			details: { model: "p/smol", tier: "smol", structured: false },
		}));
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata).toBeNull();

		const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, { session });
		expect(waited.items[0]).toEqual({
			kind: "completion",
			id: handle.id,
			status: "completed",
			text: "legacy",
		});
		expect(runEvalStatus({ item: { kind: "completion", id: handle.id } }, { session }).metadata).toBeNull();
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

	it("bounds in-flight handles and admits queued ones as earlier requests settle", async () => {
		const total = EVAL_HANDLE_CONCURRENCY + 8;
		const gate = Promise.withResolvers<void>();
		let inFlight = 0;
		let peak = 0;
		const admitted = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			if (inFlight === EVAL_HANDLE_CONCURRENCY) admitted.resolve();
			await gate.promise;
			inFlight--;
			return assistant({ text: "ok" });
		});
		const session = makeSession();

		const handles = await Promise.all(
			Array.from({ length: total }, () => runEvalCompletion({ prompt: "q", model: "smol" }, { session })),
		);
		await admitted.promise;
		expect(peak).toBe(EVAL_HANDLE_CONCURRENCY);
		gate.resolve();
		const waited = await runEvalWait(
			{ items: handles.map(handle => ({ kind: "completion", id: handle.id })) },
			{ session },
		);

		expect(waited.items.map(item => item.status)).toEqual(Array(total).fill("completed"));
		expect(peak).toBe(EVAL_HANDLE_CONCURRENCY);
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
			{ cwd: tempDir.path(), sessionId, session: makeSession({ cwd: tempDir.path() }), sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({
			plain: "hello from smol",
			structured: { ok: true, n: 3 },
		});
	});

	it("exposes metadata through JavaScript pending handles", async () => {
		using tempDir = TempDir.createSync("@omp-eval-completion-js-metadata-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-completion-metadata:${crypto.randomUUID()}`;
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<AssistantMessage>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			started.resolve();
			return await finish.promise;
		});

		const execution = executeJs(
			[
				'const pending = completion("hi", { model: "smol" });',
				"const before = await pending.metadata();",
				"const value = await pending.wait();",
				"const after = await pending.metadata();",
				"return JSON.stringify({ beforeRole: before?.requestedRole, value, after });",
			].join("\n"),
			{ cwd: tempDir.path(), sessionId, session: makeSession({ cwd: tempDir.path() }), sessionFile },
		);
		await started.promise;
		finish.resolve(assistant({ text: "hello with metadata" }));
		const result = await execution;

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toMatchObject({
			beforeRole: "smol",
			value: "hello with metadata",
			after: {
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
		});
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
