import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { type BenchSummary, runBenchCommand } from "@oh-my-pi/pi-coding-agent/cli/bench-cli";
import type { BenchModelRegistry } from "@oh-my-pi/pi-coding-agent/cli/bench-runtime";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getModelDbPath, TempDir } from "@oh-my-pi/pi-utils";

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		maxTokens: 4096,
		contextWindow: 128_000,
	} as unknown as Model<Api>;
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
					const [target] = resolveBenchTargets(
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

describe("bench credential-aware provider selection", () => {
	it("redirects an ambiguous shared-id selector to an authenticated provider", async () => {
		// Catalog order makes the unauthenticated `groq` win the default resolution.
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
	return {
		get: (key: string) =>
			key === "tier.openai" ? serviceTier : key === "tier.anthropic" || key === "tier.google" ? "none" : undefined,
	} as unknown as Settings;
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

describe("bench provider session state and websocket preference", () => {
	it("sends providerSessionState and preferWebsockets to the stream", async () => {
		const registry = fakeRegistry({
			models: [fakeModel("openai-codex", "gpt-5.5")],
			authedProviders: ["openai-codex"],
		});
		let captured: SimpleStreamOptions | undefined;
		await runBenchCommand(
			{ models: ["openai-codex/gpt-5.5"], flags: { runs: 1, maxTokens: 64, json: true } },
			{
				createRuntime: async () => ({
					modelRegistry: registry,
					settings: undefined,
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
		expect(captured?.providerSessionState).toBeInstanceOf(Map);
		expect(captured?.providerSessionState?.size).toBe(0);
		expect(captured?.preferWebsockets).toBe(true);
	});
});

describe("bench service tier", () => {
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
