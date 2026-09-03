import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { runBenchCommand } from "@oh-my-pi/pi-coding-agent/cli/bench-cli";
import type { BenchModelRegistry } from "@oh-my-pi/pi-coding-agent/cli/bench-runtime";

const model = {
	provider: "openai",
	id: "gpt-cache-test",
	name: "gpt-cache-test",
	api: "openai-responses",
	maxTokens: 4096,
	contextWindow: 128_000,
} as unknown as Model<Api>;

const piNativeModel = {
	...model,
	transport: "pi-native",
} as unknown as Model<Api>;

const codexModel = {
	...model,
	provider: "openai-codex",
	id: "gpt-cache-codex-test",
	name: "gpt-cache-codex-test",
	api: "openai-codex-responses",
} as unknown as Model<Api>;

const registry: BenchModelRegistry = {
	getAll: () => [model],
	getAvailable: () => [model],
	getApiKey: async () => "sk-test",
	resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
};

function streamWithMessage(message: AssistantMessage, beforeDone?: () => void): AssistantMessageEventStream {
	const events = [
		{ type: "text_delta", delta: "ok" },
		{ type: "done", message },
	] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) {
			if (event.type === "done") beforeDone?.();
			yield event;
		}
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

function successfulMessage(cacheRead: number, cacheWrite: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		usage: {
			input: 20,
			output: 2,
			cacheRead,
			cacheWrite,
			totalTokens: 22 + cacheRead + cacheWrite,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
		},
		duration: 20,
		ttft: 5,
	} as unknown as AssistantMessage;
}

describe("bench cache mode", () => {
	it("splits the cache breakpoint prefix from each variable suffix with native OMP messages", async () => {
		const calls: Array<{ context: Context; options: SimpleStreamOptions }> = [];
		let coldCompleted = false;
		let stdout = "";
		let id = 0;
		const summary = await runBenchCommand(
			{ models: ["openai/gpt-cache-test"], flags: { cache: true, json: true } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => `session-${++id}`,
				writeStdout: text => {
					stdout += text;
				},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context, options) => {
					const phase = calls.length === 0 ? "cold" : "warm";
					if (phase === "warm") expect(coldCompleted).toBe(true);
					calls.push({ context, options: options! });
					void options?.onPayload?.({ input: context.messages, model: "gpt-cache-test" });
					void options?.onResponse?.({
						status: 200,
						requestId: phase === "cold" ? "request-cold" : "request-warm",
						headers: phase === "warm" ? { "cf-aig-cache-status": "HIT" } : {},
					});
					const message = successfulMessage(phase === "warm" ? 100 : 0, phase === "cold" ? 100 : 0);
					return streamWithMessage(
						message,
						phase === "cold"
							? () => {
									coldCompleted = true;
								}
							: undefined,
					);
				},
				stdoutIsTTY: false,
			},
		);

		expect(summary.runs).toBe(2);
		expect(summary.maxTokens).toBe(64);
		expect(summary.cache).toEqual({ pairs: 1, concurrency: 1 });
		expect(calls).toHaveLength(2);
		expect(calls[0]?.options.promptCacheKey).toBe(calls[1]?.options.promptCacheKey);
		expect(calls[0]?.options.apiKey).toBe(calls[1]?.options.apiKey);
		expect(calls[0]?.options.sessionId).toBe(calls[1]?.options.sessionId);
		expect(calls[0]?.options.providerSessionState).not.toBe(calls[1]?.options.providerSessionState);
		expect(calls[0]?.options.providerSessionState?.size).toBe(0);
		expect(calls[1]?.options.providerSessionState?.size).toBe(0);
		expect(calls[0]?.options.statefulResponses).toBe(false);
		expect(calls[1]?.options.statefulResponses).toBe(false);
		expect(calls[0]?.options.headers).toBeUndefined();
		const coldMessages = calls[0]?.context.messages;
		const warmMessages = calls[1]?.context.messages;
		expect(coldMessages).toHaveLength(2);
		expect(warmMessages).toHaveLength(2);
		expect(coldMessages?.[0]?.content).toBe(warmMessages?.[0]?.content);
		expect(coldMessages?.[1]?.content).toBe("Cache benchmark suffix A.");
		expect(warmMessages?.[1]?.content).toBe("Cache benchmark suffix B.");
		const pair = summary.models[0]?.cachePairs?.[0];
		expect(pair?.cold.observations).toEqual(["prompt_cache_write_observed"]);
		expect(pair?.warm.observations).toEqual(["prompt_cache_read_observed", "response_cache_hit_observed"]);
		expect(pair?.payloadStructureStable).toBe(true);
		expect(pair?.coldAlreadyWarm).toBe(false);
		expect(stdout).not.toContain("Prompt-cache benchmark stable prefix");
		expect(stdout).not.toContain("bench-cache:");
		expect(stdout).not.toContain("Cache benchmark suffix");
	});

	it("keeps pi-native credential affinity while marking gateway-hidden payload diagnostics unavailable", async () => {
		const calls: SimpleStreamOptions[] = [];
		const summary = await runBenchCommand(
			{ models: ["openai/gpt-cache-test"], flags: { cache: true, json: true } },
			{
				createRuntime: async () => ({
					modelRegistry: { ...registry, getAll: () => [piNativeModel] },
					close: () => {},
				}),
				randomSessionId: (() => {
					let id = 0;
					return () => `session-${++id}`;
				})(),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, _context, options) => {
					calls.push(options!);
					void options?.onResponse?.({
						status: 200,
						requestId: `gateway-request-${calls.length}`,
						headers: { "x-request-id": `gateway-request-${calls.length}` },
					});
					return streamWithMessage(successfulMessage(0, 0));
				},
				stdoutIsTTY: false,
			},
		);

		expect(calls).toHaveLength(2);
		expect(calls[0]?.sessionId).toBe(calls[1]?.sessionId);
		expect(calls[0]?.promptCacheKey).toBe(calls[1]?.promptCacheKey);
		expect(calls[0]?.providerSessionState).not.toBe(calls[1]?.providerSessionState);
		const pair = summary.models[0]?.cachePairs?.[0];
		expect(pair?.payloadStructureStable).toBe("unavailable");
		expect(pair?.cold.requestIdObserved).toBe(true);
		expect(pair?.warm.requestIdObserved).toBe(true);
		expect(pair?.cold.observations).toEqual(["no_provider_proof"]);
		expect(pair?.warm.observations).toEqual(["no_provider_proof"]);
	});

	it("rejects Codex Responses cache mode before credentials or requests can imply independent pairs", async () => {
		let credentialLookups = 0;
		await expect(
			runBenchCommand(
				{ models: ["openai-codex/gpt-cache-codex-test"], flags: { cache: true } },
				{
					createRuntime: async () => ({
						modelRegistry: {
							...registry,
							getAll: () => [codexModel],
							getApiKey: async () => {
								credentialLookups++;
								return "sk-test";
							},
						},
						close: () => {},
					}),
					streamSimple: () => {
						throw new Error("Codex cache mode must reject before issuing a request");
					},
				},
			),
		).rejects.toThrow(
			"--cache is not supported for openai-codex-responses because Codex WebSocket chaining cannot produce independent prompt-cache pairs",
		);
		expect(credentialLookups).toBe(0);
	});

	it("gives every pair a private stable namespace and flags a prewarmed cold request", async () => {
		const calls: Array<{ context: Context; options: SimpleStreamOptions }> = [];
		let stdout = "";
		const summary = await runBenchCommand(
			{ models: ["openai/gpt-cache-test"], flags: { cache: true, cachePairs: 2 } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: (() => {
					let id = 0;
					return () => `session-${++id}`;
				})(),
				writeStdout: text => {
					stdout += text;
				},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context, options) => {
					const callIndex = calls.length;
					calls.push({ context, options: options! });
					void options?.onPayload?.({ input: context.messages });
					const cold = callIndex % 2 === 0;
					return streamWithMessage(successfulMessage(callIndex === 2 ? 100 : 0, cold ? 100 : 0));
				},
				stdoutIsTTY: false,
			},
		);

		expect(calls).toHaveLength(4);
		const stablePrefixes = calls.map(call => call.context.messages[0]?.content);
		expect(stablePrefixes[0]).toBe(stablePrefixes[1]);
		expect(stablePrefixes[2]).toBe(stablePrefixes[3]);
		expect(stablePrefixes[0]).not.toBe(stablePrefixes[2]);
		expect(calls[0]?.options.promptCacheKey).toBe(calls[1]?.options.promptCacheKey);
		expect(calls[2]?.options.promptCacheKey).toBe(calls[3]?.options.promptCacheKey);
		expect(calls[0]?.options.promptCacheKey).not.toBe(calls[2]?.options.promptCacheKey);
		expect(summary.models[0]?.cachePairs?.[0]?.coldAlreadyWarm).toBe(false);
		expect(summary.models[0]?.cachePairs?.[1]?.coldAlreadyWarm).toBe(true);
		expect(stdout).toContain("cold (already warm)");
	});

	it("overlaps cache cold requests while preserving phase ordering and pair affinity", async () => {
		const calls: Array<{
			phase: "cold" | "warm";
			cacheKey: string;
			sessionId: SimpleStreamOptions["sessionId"];
			apiKey: SimpleStreamOptions["apiKey"];
			stablePrefix: string;
		}> = [];
		const coldCompleted = new Set<string>();
		const bothColdsStarted = Promise.withResolvers<void>();
		const releaseColds = Promise.withResolvers<void>();
		let coldInFlight = 0;
		let maxColdInFlight = 0;
		let id = 0;
		const benchmark = runBenchCommand(
			{
				models: ["openai/gpt-cache-test"],
				flags: { cache: true, cachePairs: 2, cacheConcurrency: 2, json: true },
			},
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => `session-${++id}`,
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context, options) => {
					if (!options?.promptCacheKey) throw new Error("cache requests must have a prompt cache key");
					const cacheKey = options.promptCacheKey;
					const phase = context.messages[1]?.content === "Cache benchmark suffix B." ? "warm" : "cold";
					calls.push({
						phase,
						cacheKey,
						sessionId: options.sessionId,
						apiKey: options.apiKey,
						stablePrefix: context.messages[0]?.content as string,
					});
					const message = successfulMessage(phase === "warm" ? 100 : 0, phase === "cold" ? 100 : 0);
					const iterator = (async function* () {
						if (phase === "cold") {
							coldInFlight++;
							maxColdInFlight = Math.max(maxColdInFlight, coldInFlight);
							if (coldInFlight === 2) bothColdsStarted.resolve();
							await releaseColds.promise;
							coldInFlight--;
							yield { type: "text_delta", delta: "ok" } as unknown as AssistantMessageEvent;
							yield { type: "done", message } as unknown as AssistantMessageEvent;
							coldCompleted.add(cacheKey);
							return;
						}
						expect(coldCompleted.has(cacheKey)).toBe(true);
						yield { type: "text_delta", delta: "ok" } as unknown as AssistantMessageEvent;
						yield { type: "done", message } as unknown as AssistantMessageEvent;
					})();
					return Object.assign(iterator, {
						result: async () => message,
					}) as unknown as AssistantMessageEventStream;
				},
				stdoutIsTTY: false,
			},
		);

		await bothColdsStarted.promise;
		releaseColds.resolve();
		const summary = await benchmark;

		expect(maxColdInFlight).toBe(2);
		expect(summary.cache).toEqual({ pairs: 2, concurrency: 2 });
		expect(calls).toHaveLength(4);
		const callsByKey = new Map<string, (typeof calls)[number][]>();
		for (const call of calls) {
			const pair = callsByKey.get(call.cacheKey) ?? [];
			pair.push(call);
			callsByKey.set(call.cacheKey, pair);
		}
		expect(callsByKey.size).toBe(2);
		for (const pair of callsByKey.values()) {
			const cold = pair.find(call => call.phase === "cold");
			const warm = pair.find(call => call.phase === "warm");
			expect(cold).toBeDefined();
			expect(warm).toBeDefined();
			expect(warm?.sessionId).toBe(cold?.sessionId);
			expect(warm?.apiKey).toBe(cold?.apiKey);
			expect(warm?.stablePrefix).toBe(cold?.stablePrefix);
		}
		const coldPrefixes = calls.filter(call => call.phase === "cold").map(call => call.stablePrefix);
		expect(new Set(coldPrefixes).size).toBe(2);
	});

	it("prints cold and warm cache token breakdowns and cost for human output", async () => {
		let stdout = "";
		let calls = 0;
		await runBenchCommand(
			{ models: ["openai/gpt-cache-test"], flags: { cache: true } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: (() => {
					let id = 0;
					return () => `session-${++id}`;
				})(),
				writeStdout: text => {
					stdout += text;
				},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context, options) => {
					calls++;
					void options?.onPayload?.({ input: context.messages });
					return streamWithMessage(successfulMessage(calls === 2 ? 100 : 0, calls === 1 ? 100 : 0));
				},
				stdoutIsTTY: false,
			},
		);

		expect(stdout).toContain(
			"cold prompt_cache_write_observed input 20 cache-read 0 cache-write 100 output 2 total 122 cost $4.00",
		);
		expect(stdout).toContain(
			"warm prompt_cache_read_observed input 20 cache-read 100 cache-write 0 output 2 total 122 cost $4.00",
		);
		expect(stdout).toContain("TTFT");
		expect(stdout).toContain("duration");
		expect(stdout).toContain("throughput");
	});

	it("keeps normal defaults and requires explicit cache concurrency", async () => {
		let active = 0;
		let maxActive = 0;
		let started = 0;
		const release = Promise.withResolvers<void>();
		let id = 0;
		const summary = await runBenchCommand(
			{ models: ["openai/gpt-cache-test"], flags: { json: true } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => `session-${++id}`,
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: () => {
					const message = successfulMessage(0, 0);
					const iterator = (async function* () {
						active++;
						maxActive = Math.max(maxActive, active);
						started++;
						if (started === 4) release.resolve();
						await release.promise;
						active--;
						yield { type: "text_delta", delta: "ok" } as unknown as AssistantMessageEvent;
						yield { type: "done", message } as unknown as AssistantMessageEvent;
					})();
					return Object.assign(iterator, {
						result: async () => message,
					}) as unknown as AssistantMessageEventStream;
				},
				stdoutIsTTY: false,
			},
		);
		expect(summary.runs).toBe(9);
		expect(summary.maxTokens).toBeUndefined();
		expect(summary.profile).toBe("mix");
		expect(maxActive).toBe(4);
		await expect(
			runBenchCommand(
				{ models: ["openai/gpt-cache-test"], flags: { cache: true, par: 2 } },
				{ createRuntime: async () => ({ modelRegistry: registry, close: () => {} }) },
			),
		).rejects.toThrow("--cache-concurrency");
	});
	it("reads only the configured prefix bytes without exposing the file", async () => {
		const stablePrefixes: string[] = [];
		await runBenchCommand(
			{
				models: ["openai/gpt-cache-test"],
				flags: { cache: true, cachePrefixFile: "private-prefix.txt", cachePrefixBytes: 5, json: true },
			},
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: (() => {
					let id = 0;
					return () => `session-${++id}`;
				})(),
				readTextFile: async (path, maxBytes) => {
					expect(path).toBe("private-prefix.txt");
					expect(maxBytes).toBe(5);
					return "ab😀cd";
				},
				writeStdout: text => {
					expect(text).not.toContain("ab😀cd");
				},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context, options) => {
					stablePrefixes.push(context.messages[0]?.content as string);
					void options?.onPayload?.({ input: context.messages });
					return streamWithMessage(successfulMessage(0, 0));
				},
				stdoutIsTTY: false,
			},
		);
		expect(stablePrefixes).toHaveLength(2);
		expect(stablePrefixes[0]).toBe(stablePrefixes[1]);
		expect(stablePrefixes[0]).toStartWith("ab\n\nPrompt-cache benchmark namespace:");
	});

	it("truncates the default prefix-file reader at a UTF-8 boundary before decoding", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bench-cache-prefix-"));
		const prefixPath = path.join(tempDir, "prefix.txt");
		const stablePrefixes: string[] = [];
		await Bun.write(prefixPath, "ab😀cd");
		try {
			await runBenchCommand(
				{
					models: ["openai/gpt-cache-test"],
					flags: { cache: true, cachePrefixFile: prefixPath, cachePrefixBytes: 3, json: true },
				},
				{
					createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
					randomSessionId: (() => {
						let id = 0;
						return () => `session-${++id}`;
					})(),
					writeStdout: () => {},
					writeStderr: () => {},
					setExitCode: () => {},
					streamSimple: (_model, context, options) => {
						stablePrefixes.push(context.messages[0]?.content as string);
						void options?.onPayload?.({ input: context.messages });
						return streamWithMessage(successfulMessage(0, 0));
					},
					stdoutIsTTY: false,
				},
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}

		expect(stablePrefixes).toHaveLength(2);
		expect(stablePrefixes[0]).toBe(stablePrefixes[1]);
		expect(stablePrefixes[0]).toStartWith("ab\n\nPrompt-cache benchmark namespace:");
		expect(stablePrefixes[0]).not.toContain("\uFFFD");
	});

	it("preserves significant whitespace and replacement patterns from the default prefix-file reader", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bench-cache-prefix-whitespace-"));
		const prefixPath = path.join(tempDir, "prefix.txt");
		const exactPrefix = "line one  \n\n\n$& $' $` $$ line two\t\n";
		const stablePrefixes: string[] = [];
		await Bun.write(prefixPath, exactPrefix);
		try {
			await runBenchCommand(
				{
					models: ["openai/gpt-cache-test"],
					flags: { cache: true, cachePrefixFile: prefixPath, cachePrefixBytes: 128, json: true },
				},
				{
					createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
					randomSessionId: (() => {
						let id = 0;
						return () => `session-${++id}`;
					})(),
					writeStdout: () => {},
					writeStderr: () => {},
					setExitCode: () => {},
					streamSimple: (_model, context, options) => {
						stablePrefixes.push(context.messages[0]?.content as string);
						void options?.onPayload?.({ input: context.messages });
						return streamWithMessage(successfulMessage(0, 0));
					},
					stdoutIsTTY: false,
				},
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}

		expect(stablePrefixes).toHaveLength(2);
		expect(stablePrefixes[0]).toBe(stablePrefixes[1]);
		expect(stablePrefixes[0]?.startsWith(exactPrefix)).toBe(true);
		expect(stablePrefixes[0]?.slice(exactPrefix.length)).toStartWith("\n\nPrompt-cache benchmark namespace:");
	});

	it("does not turn zero cache counters into a miss", async () => {
		const summary = await runBenchCommand(
			{ models: ["openai/gpt-cache-test"], flags: { cache: true, json: true } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: (() => {
					let id = 0;
					return () => `session-${++id}`;
				})(),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context, options) => {
					void options?.onPayload?.({ input: context.messages });
					return streamWithMessage(successfulMessage(0, 0));
				},
				stdoutIsTTY: false,
			},
		);
		const pair = summary.models[0]?.cachePairs?.[0];
		expect(pair?.cold.observations).toEqual(["no_provider_proof"]);
		expect(pair?.warm.observations).toEqual(["no_provider_proof"]);
	});
});
