import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type BenchSummary, runBenchCommand } from "@oh-my-pi/pi-coding-agent/cli/bench-cli";
import { type BenchModelRegistry, resolveBenchTargets } from "@oh-my-pi/pi-coding-agent/cli/bench-runtime";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getModelDbPath, TempDir } from "@oh-my-pi/pi-utils";
import { endpoint as responsesEndpoint } from "../../ai/test/fixtures/openai-responses-server";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function fakeModel(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 4096,
		contextWindow: 128_000,
	});
}

function fakeStream(): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 5, output: 20 },
		duration: 120,
		ttft: 30,
	} as unknown as AssistantMessage;
	const events = [
		{ type: "text_delta", delta: "hi" },
		{ type: "done", message },
	] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

function emptyStream(): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 5, output: 0 },
		duration: 120,
	} as unknown as AssistantMessage;
	const events = [{ type: "done", message }] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

/** A stream that records the key its request resolves before replaying {@link fakeStream}. */
function keyRecordingStream(options: SimpleStreamOptions | undefined, keys: unknown[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		try {
			if (typeof options?.apiKey !== "function") throw new Error("Missing resolver");
			keys.push(await options.apiKey({ error: undefined, lastChance: false }));
			for await (const event of fakeStream()) stream.push(event);
		} catch (error) {
			stream.fail(error);
		}
	})();
	return stream;
}

interface FakeRegistryOptions {
	models: Model<Api>[];
	authedProviders: string[];
}

function fakeRegistry(opts: FakeRegistryOptions): BenchModelRegistry {
	const authed = new Set(opts.authedProviders);
	return {
		getAll: () => opts.models,
		getAvailable: () => opts.models.filter(model => authed.has(model.provider)),
		hasConfiguredAuth: model => authed.has(model.provider),
		getApiKey: async model => (authed.has(model.provider) ? "sk-test" : undefined),
		resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
	};
}

async function runBench(
	selector: string,
	registry: BenchModelRegistry,
	streamFactory: () => AssistantMessageEventStream = fakeStream,
	settings?: Settings,
) {
	const stderr: string[] = [];
	const summary = await runBenchCommand(
		{ models: [selector], flags: { runs: 1, maxTokens: 64, json: false } },
		{
			createRuntime: async () => ({ modelRegistry: registry, settings, close: () => {} }),
			randomSessionId: () => "sess-1",
			writeStdout: () => {},
			writeStderr: text => stderr.push(text),
			setExitCode: () => {},
			streamSimple: () => streamFactory(),
			now: () => 0,
			stdoutIsTTY: false,
		},
	);
	return { summary, stderr: stderr.join("") };
}
describe("bench discovery fallback", () => {
	it("awaits a cache-aware discovery refresh and retries before failing on a cache-missed selector", async () => {
		const model = fakeModel("lm-studio", "local-27b");
		let models: Model<Api>[] = [];
		let refreshCalls = 0;
		const registry: BenchModelRegistry = {
			getAll: () => models,
			getAvailable: () => models,
			hasConfiguredAuth: () => false,
			getApiKey: async () => undefined,
			resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
			getDiscoverableProviders: () => ["lm-studio"],
			refresh: async () => {
				refreshCalls += 1;
				models = [model];
			},
		};
		const [target] = await resolveBenchTargets(["local-27b"], registry, undefined, () => {});
		expect(refreshCalls).toBe(1);
		expect(target.model.id).toBe("local-27b");
	});

	it("throws the original per-selector errors after the refreshed catalog still misses them", async () => {
		let refreshCalls = 0;
		const registry: BenchModelRegistry = {
			getAll: () => [],
			getAvailable: () => [],
			hasConfiguredAuth: () => false,
			getApiKey: async () => undefined,
			resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
			getDiscoverableProviders: () => ["lm-studio"],
			refresh: async () => {
				refreshCalls += 1;
			},
		};
		await expect(resolveBenchTargets(["local-27b"], registry, undefined, () => {})).rejects.toThrow(/local-27b/);
		expect(refreshCalls).toBe(1);
	});
	it("re-resolves already-resolved selectors from the refreshed catalog, dropping stale rows", async () => {
		const staleSpec: ModelSpec<"openai-completions"> = {
			provider: "lm-studio",
			id: "model-a",
			name: "model-a",
			api: "openai-completions",
			baseUrl: "https://stale.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 4096,
			contextWindow: 128_000,
		};
		const stale = buildModel(staleSpec);
		const fresh = buildModel({
			...staleSpec,
			baseUrl: "https://fresh.test/v1",
		});
		let models: Model<Api>[] = [stale];
		let refreshCalls = 0;
		const registry: BenchModelRegistry = {
			getAll: () => models,
			getAvailable: () => models,
			hasConfiguredAuth: () => true,
			getApiKey: async () => "sk-test",
			resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
			getDiscoverableProviders: () => ["lm-studio"],
			refresh: async () => {
				refreshCalls += 1;
				models = [fresh, fakeModel("lm-studio", "model-b")];
			},
		};

		const [targetA, targetB] = await resolveBenchTargets(["model-a", "model-b"], registry, undefined, () => {});

		expect(refreshCalls).toBe(1);
		expect(targetA.model.baseUrl).toBe(fresh.baseUrl);
		expect(targetB.model.id).toBe("model-b");
	});

	it("repeats no redirect warning when the fallback pass re-resolves an already-resolved selector", async () => {
		let models: Model<Api>[] = [
			fakeModel("groq", "openai/gpt-oss-20b"),
			fakeModel("openrouter", "openai/gpt-oss-20b"),
		];
		const stderr: string[] = [];
		const registry: BenchModelRegistry = {
			getAll: () => models,
			getAvailable: () => models.filter(model => model.provider === "openrouter"),
			hasConfiguredAuth: model => model.provider === "openrouter",
			getApiKey: async model => (model.provider === "openrouter" ? "sk-test" : undefined),
			resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
			getDiscoverableProviders: () => ["openrouter"],
			refresh: async () => {
				models = [...models, fakeModel("acme", "other")];
			},
		};

		const [redirected] = await resolveBenchTargets(["openai/gpt-oss-20b", "other"], registry, undefined, text =>
			stderr.push(text),
		);

		expect(redirected.model.provider).toBe("openrouter");
		expect(stderr.filter(text => text.includes("no credentials for")).length).toBe(1);
	});

	it("drops the first-pass redirect warning when the refreshed catalog no longer redirects", async () => {
		let models: Model<Api>[] = [
			fakeModel("groq", "openai/gpt-oss-20b"),
			fakeModel("openrouter", "openai/gpt-oss-20b"),
		];
		const stderr: string[] = [];
		const registry: BenchModelRegistry = {
			getAll: () => models,
			getAvailable: () => models.filter(model => model.provider === "openrouter"),
			hasConfiguredAuth: model => model.provider === "openrouter",
			getApiKey: async model => (model.provider === "openrouter" ? "sk-test" : undefined),
			resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
			getDiscoverableProviders: () => ["openrouter"],
			refresh: async () => {
				models = [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("acme", "other")];
			},
		};

		const [pinned] = await resolveBenchTargets(["openai/gpt-oss-20b", "other"], registry, undefined, text =>
			stderr.push(text),
		);

		expect(pinned.model.provider).toBe("groq");
		expect(stderr).toEqual([]);
	});
});

describe("default bench runtime", () => {
	it("hydrates credential-scoped model caches before selector resolution", async () => {
		const tempDir = TempDir.createSync("@omp-bench-runtime-");
		const apiKey = "bench-cache-test-key";
		const modelId = "cached-bench-model";
		const cacheDbPath = getModelDbPath(tempDir.path());
		await fs.mkdir(path.dirname(cacheDbPath), { recursive: true });
		try {
			writeModelCache(
				resolveModelCacheProviderId("opencode-go", { apiKey }),
				Date.now(),
				[
					buildModel({
						id: modelId,
						name: "Cached Bench Model",
						provider: "opencode-go",
						api: "openai-completions",
						baseUrl: "https://opencode.ai/zen/go/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 4096,
					}),
				],
				true,
				"",
				cacheDbPath,
			);
			const script = `
				import { createDefaultBenchRuntime, resolveBenchTargets } from "./packages/coding-agent/src/cli/bench-runtime.ts";
				const runtime = await createDefaultBenchRuntime();
				try {
				const [target] = await resolveBenchTargets(
						["opencode-go/${modelId}"],
						runtime.modelRegistry,
						runtime.settings,
						() => {},
					);
					console.log(target.model.provider + "/" + target.model.id);
				} finally {
					runtime.close?.();
				}
			`;
			const child = Bun.spawn([process.execPath, "-e", script], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					NO_COLOR: "1",
					OPENCODE_API_KEY: apiKey,
					PI_CODING_AGENT_DIR: tempDir.path(),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout.trim()).toBe(`opencode-go/${modelId}`);
		} finally {
			await tempDir.remove();
		}
	});
});

describe("bench OAuth account selection", () => {
	it("uses the selected account for every request instead of rotating", async () => {
		const auth = createInMemoryAuthStorage();
		try {
			await auth.credentials.set(
				"anthropic",
				["a", "b"].map(suffix => ({
					type: "oauth" as const,
					access: `access-${suffix}`,
					refresh: `refresh-${suffix}`,
					expires: Date.now() + 3_600_000,
					accountId: suffix,
					email: `${suffix}@example.com`,
					orgId: suffix,
				})),
			);
			const model = fakeModel("anthropic", "test-model");
			const registry = fakeRegistry({ models: [model], authedProviders: ["anthropic"] });
			const keys: unknown[] = [];
			const summary = await runBenchCommand(
				{ models: ["anthropic/test-model"], flags: { account: 2, runs: 2, json: true } },
				{
					createRuntime: async () => ({ modelRegistry: registry, oauth: auth.oauth }),
					writeStdout: () => {},
					writeStderr: () => {},
					setExitCode: () => {},
					streamSimple: (_model, _context, options) => keyRecordingStream(options, keys),
				},
			);
			expect(summary.failures).toBe(0);
			expect(keys).toEqual(["access-b", "access-b"]);
		} finally {
			auth.close();
		}
	});

	it("sends a structured-credential provider's encoded key for the selected account", async () => {
		const auth = createInMemoryAuthStorage();
		try {
			await auth.credentials.set(
				"google-gemini-cli",
				["a", "b"].map(suffix => ({
					type: "oauth" as const,
					access: `access-${suffix}`,
					refresh: `refresh-${suffix}`,
					expires: Date.now() + 3_600_000,
					projectId: `project-${suffix}`,
					email: `${suffix}@example.com`,
				})),
			);
			const model = fakeModel("google-gemini-cli", "test-model");
			const registry = fakeRegistry({ models: [model], authedProviders: ["google-gemini-cli"] });
			const keys: unknown[] = [];
			const summary = await runBenchCommand(
				{ models: ["google-gemini-cli/test-model"], flags: { account: 2, runs: 1, json: true } },
				{
					createRuntime: async () => ({ modelRegistry: registry, oauth: auth.oauth }),
					writeStdout: () => {},
					writeStderr: () => {},
					setExitCode: () => {},
					streamSimple: (_model, _context, options) => keyRecordingStream(options, keys),
				},
			);
			expect(summary.failures).toBe(0);
			expect(keys.map(key => JSON.parse(String(key)))).toEqual([
				expect.objectContaining({ token: "access-b", projectId: "project-b", refreshToken: "refresh-b" }),
			]);
		} finally {
			auth.close();
		}
	});
});

describe("bench credential-aware provider selection", () => {
	it("redirects an ambiguous shared-id selector to an authenticated provider", async () => {
		// Built-in provider priority makes the unauthenticated `groq` win the default resolution.
		const registry = fakeRegistry({
			models: [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});

		const { summary, stderr } = await runBench("openai/gpt-oss-20b", registry);

		expect(summary.models[0].model).toBe("openrouter/openai/gpt-oss-20b");
		expect(summary.failures).toBe(0);
		expect(stderr).toContain('no credentials for "groq"');
		expect(stderr).toContain("openrouter/openai/gpt-oss-20b");
	});

	it("does not redirect across providers whose local ids differ", async () => {
		// Bare `gpt-oss-20b` resolves to fireworks (unauthed) by flat-id match.
		// The authenticated openrouter entry has a different local id, so it is
		// not considered an equivalent fallback.
		const registry = fakeRegistry({
			models: [fakeModel("fireworks", "gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});

		const { summary } = await runBench("gpt-oss-20b", registry);

		expect(summary.models[0].model).toBe("fireworks/gpt-oss-20b");
		expect(summary.failures).toBe(1);
		expect(summary.models[0].results[0]).toMatchObject({ ok: false });
	});

	it("honors an explicitly pinned provider even without credentials", async () => {
		const registry = fakeRegistry({
			models: [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});

		const { summary, stderr } = await runBench("groq/openai/gpt-oss-20b", registry);

		// Pinned selector is authoritative: no redirect, surfaces the no-credentials failure.
		expect(summary.models[0].model).toBe("groq/openai/gpt-oss-20b");
		expect(summary.failures).toBe(1);
		expect(summary.models[0].results[0]).toMatchObject({ ok: false });
		expect(stderr).not.toContain("benchmarking");
	});
});

describe("bench configured role selection", () => {
	it("resolves configured bare role names", async () => {
		const model = fakeModel("acme", "bench-model");
		const registry = fakeRegistry({ models: [model], authedProviders: ["acme"] });
		const settings = Settings.isolated({ modelRoles: { task: "acme/bench-model" } });

		const { summary } = await runBench("task", registry, fakeStream, settings);

		expect(summary.models[0].model).toBe("acme/bench-model");
		expect(summary.failures).toBe(0);
	});

	it("honors provider-pinned configured role targets", async () => {
		const registry = fakeRegistry({
			models: [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});
		const settings = Settings.isolated({
			modelRoles: { task: "groq/openai/gpt-oss-20b" },
		});

		const { summary, stderr } = await runBench("task", registry, fakeStream, settings);

		expect(summary.models[0].model).toBe("groq/openai/gpt-oss-20b");
		expect(summary.failures).toBe(1);
		expect(summary.models[0].results[0]).toMatchObject({ ok: false });
		expect(stderr).not.toContain("benchmarking");
	});
});

describe("bench empty-output guard", () => {
	it("reports a run with no streamed content and no tokens as a failure", async () => {
		const registry = fakeRegistry({ models: [fakeModel("acme", "model-x")], authedProviders: ["acme"] });

		const { summary } = await runBench("acme/model-x", registry, emptyStream);

		expect(summary.failures).toBe(1);
		const run = summary.models[0].results[0];
		expect(run.ok).toBe(false);
		if (!run.ok) expect(run.error).toContain("no output");
		expect(summary.models[0].stats).toBeNull();
	});
});

function settingsStub(serviceTier: string | undefined): Settings | undefined {
	if (serviceTier === undefined) return undefined;
	return Settings.isolated({ "tier.openai": serviceTier, "tier.anthropic": "none", "tier.google": "none" });
}

async function captureServiceTier(opts: {
	flag?: string;
	setting?: string;
}): Promise<{ wire: SimpleStreamOptions["serviceTier"]; summary: BenchSummary["serviceTierByFamily"] }> {
	const registry = fakeRegistry({ models: [fakeModel("openai-codex", "gpt-5.5")], authedProviders: ["openai-codex"] });
	let captured: SimpleStreamOptions | undefined;
	const summary = await runBenchCommand(
		{
			models: ["openai-codex/gpt-5.5"],
			flags: { runs: 1, maxTokens: 64, json: true, serviceTier: opts.flag },
		},
		{
			createRuntime: async () => ({
				modelRegistry: registry,
				settings: settingsStub(opts.setting),
				close: () => {},
			}),
			randomSessionId: () => "sess-1",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			streamSimple: (_model, _context, options) => {
				captured = options;
				return fakeStream();
			},
			now: () => 0,
			stdoutIsTTY: false,
		},
	);
	return { wire: captured?.serviceTier, summary: summary.serviceTierByFamily };
}

describe("bench Codex provider state", () => {
	it("closes request-owned Codex state after each run", async () => {
		const model = { ...fakeModel("openai-codex", "gpt-5.5"), api: "openai-codex-responses" } as Model;
		const registry = fakeRegistry({ models: [model], authedProviders: ["openai-codex"] });
		const captured: SimpleStreamOptions[] = [];
		let closed = 0;
		const summary = await runBenchCommand(
			{ models: ["openai-codex/gpt-5.5"], flags: { runs: 2, maxTokens: 64, json: true } },
			{
				createRuntime: async () => ({ modelRegistry: registry }),
				randomSessionId: () => "sess-1",
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, _context, options) => {
					if (!options?.providerSessionState) throw new Error("Missing request-owned provider state");
					captured.push(options);
					options.providerSessionState.set("codex-test", { close: () => closed++ });
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);
		expect(summary.failures).toBe(0);
		expect(captured).toHaveLength(2);
		expect(captured[0]?.providerSessionState).not.toBe(captured[1]?.providerSessionState);
		expect(captured.every(options => options.providerSessionState?.size === 0)).toBe(true);
		expect(closed).toBe(2);
	});
});

describe("bench standard Responses transport", () => {
	it.each([false, true])(
		"uses the standard Responses setting %s before falling back to HTTP on an HTTP-only gateway",
		async enabled => {
			let posts = 0;
			let upgrades = 0;
			const item = {
				type: "message",
				id: "msg_bench",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "OK" }],
			};
			const sse = [
				{ type: "response.created", response: { id: "resp_bench" } },
				{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						id: "resp_bench",
						status: "completed",
						usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
					},
				},
			]
				.map(event => `data: ${JSON.stringify(event)}\n\n`)
				.join("");
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.get("upgrade")) {
						upgrades++;
						return new Response("HTTP only", { status: 426 });
					}
					if (request.method !== "POST") return new Response("Unexpected request", { status: 404 });
					posts++;
					return new Response(sse, { headers: { "content-type": "text/event-stream" } });
				},
			});
			try {
				const model = buildModel({
					provider: "openai",
					id: "gpt-5.4",
					name: "OpenAI gateway",
					api: "openai-responses",
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					preferWebsockets: true,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 64,
				});
				const registry = fakeRegistry({ models: [model], authedProviders: ["openai"] });
				const summary = await runBenchCommand(
					{ models: ["openai/gpt-5.4"], flags: { runs: 1, maxTokens: 8, json: true } },
					{
						createRuntime: async () => ({
							modelRegistry: registry,
							settings: Settings.isolated({ "providers.openaiResponsesWebsockets": enabled }),
						}),
						writeStdout: () => {},
						writeStderr: () => {},
						setExitCode: () => {},
						stdoutIsTTY: false,
					},
				);
				expect(summary.failures).toBe(0);
				expect(summary.models[0]?.stats?.outputTokens).toBe(2);
				expect(posts).toBe(1);
				expect(upgrades).toBe(enabled ? 1 : 0);
			} finally {
				await server.stop(true);
			}
		},
	);

	it("does not report a WebSocket handshake as per-generation response-cache evidence", async () => {
		const fixture = responsesEndpoint(undefined, {
			upgradeHeaders: { "cf-aig-cache-status": "HIT", "x-request-id": "handshake-not-generation" },
		});
		try {
			const model = {
				...getBundledModel("openai", "gpt-5-mini"),
				baseUrl: `${fixture.server.url.origin}/v1`,
			};
			const registry = fakeRegistry({ models: [model], authedProviders: ["openai"] });
			const summary = await runBenchCommand(
				{ models: ["openai/gpt-5-mini"], flags: { cache: true, json: true } },
				{
					createRuntime: async () => ({
						modelRegistry: registry,
						settings: Settings.isolated({ "providers.openaiResponsesWebsockets": true }),
					}),
					writeStdout: () => {},
					writeStderr: () => {},
					setExitCode: () => {},
					stdoutIsTTY: false,
				},
			);
			expect(summary.failures).toBe(0);
			expect(summary.models[0]?.stats?.outputTokens).toBe(3);
			const pair = summary.models[0]?.cachePairs?.[0];
			expect(pair?.cold.result).toMatchObject({ ok: true, transport: "websocket" });
			expect(pair?.cold.requestIdObserved).toBe(false);
			expect(pair?.cold.observations).not.toContain("response_cache_hit_observed");
			expect(fixture.requests).toHaveLength(2);
		} finally {
			await fixture.server.stop(true);
		}
	});
});

describe("bench service tier", () => {
	it("rejects a priority run that fell back to standard speed", async () => {
		const model = getBundledModel("anthropic", "claude-opus-4-5");
		if (!model) throw new Error("Missing Anthropic model");
		const registry = fakeRegistry({ models: [model], authedProviders: ["anthropic"] });
		const summary = await runBenchCommand(
			{ models: ["anthropic/claude-opus-4-5"], flags: { runs: 1, serviceTier: "priority", json: true } },
			{
				createRuntime: async () => ({ modelRegistry: registry }),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: () => {
					const stream = new AssistantMessageEventStream();
					void (async () => {
						try {
							for await (const event of fakeStream()) {
								if (event.type === "done") event.message.disabledFeatures = ["priority"];
								stream.push(event);
							}
						} catch (error) {
							stream.fail(error);
						}
					})();
					return stream;
				},
			},
		);
		expect(summary.failures).toBe(1);
		expect(summary.models[0]?.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("fell back") });
	});

	it("sends the configured serviceTier setting when no flag is passed", async () => {
		const { wire, summary } = await captureServiceTier({ setting: "flex" });
		expect(wire).toBe("flex");
		expect(summary).toEqual({ openai: "flex" });
	});

	it("lets an explicit --service-tier override the configured setting", async () => {
		const { wire, summary } = await captureServiceTier({ flag: "priority", setting: "flex" });
		expect(wire).toBe("priority");
		expect(summary).toEqual({ openai: "priority", anthropic: "priority", google: "priority" });
	});

	it("omits service_tier when the setting is none and no flag is passed", async () => {
		const { wire, summary } = await captureServiceTier({ setting: "none" });
		expect(wire).toBeUndefined();
		expect(summary).toEqual({});
	});

	it("omits service_tier when neither flag nor settings are present", async () => {
		const { wire, summary } = await captureServiceTier({});
		expect(wire).toBeUndefined();
		expect(summary).toEqual({});
	});
});
