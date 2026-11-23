import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthStorage, type Context, type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { ModelRegistry, type ProviderConfigInput } from "../../src/config/model-registry";
import { authService, prewarmModelRegistryMirror } from "../../src/thread/services/auth";
import { type FetchSeen, scriptedFetch } from "../fixtures/model-registry-mirror-fetch";
import type { MirrorProbe, StreamRecord } from "../fixtures/model-registry-mirror-worker";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

const PROVIDER = "unit-runtime-mirror";
const SOURCE = "unit-runtime-mirror-extension";
const DYNAMIC_PROVIDER = "unit-dynamic-mirror";
const DYNAMIC_SOURCE = "unit-dynamic-mirror-extension";

type ModelDefinition = NonNullable<ProviderConfigInput["models"]>[number];

function modelDefinition(id: string): ModelDefinition {
	return {
		id,
		name: `Model ${id}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
		maxTokens: 4_096,
	};
}

/** Main-thread record of what the custom stream saw. */
interface StreamCalls {
	apiKeys: (string | undefined)[];
	aborted: boolean;
	/** `context.tools` of each request, when recorded. */
	tools?: Context["tools"][];
}

/** `fetch-*` models request this host's `/ok`, `/hold` or `/fail` through the stream's `fetch` option. */
const FETCH_PATHS: Record<string, string> = { "fetch-model": "/ok", "fetch-hold": "/hold", "fetch-fail": "/fail" };

/**
 * A custom `streamSimple` that exists only on the main thread: "hel" + "lo" then done;
 * `hold-model` waits for abort after "hel"; `throw-model` throws before streaming;
 * `fetch-*` models stream the response of a request made with `options.fetch`
 * (status line, then each body chunk), reporting a failure as `<error name>: <message>`.
 */
function mainOnlyStream(calls: StreamCalls): NonNullable<ProviderConfigInput["streamSimple"]> {
	return (model, context, options?: SimpleStreamOptions) => {
		if (model.id === "throw-model") throw new Error("scripted main-thread failure");
		calls.apiKeys.push(typeof options?.apiKey === "string" ? options.apiKey : undefined);
		calls.tools?.push(context.tools);
		const stream = new AssistantMessageEventStream();
		const message = (text: string, stopReason: "stop" | "aborted" | "error", errorMessage?: string) => ({
			role: "assistant" as const,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 0,
			content: [{ type: "text" as const, text }],
			stopReason,
			errorMessage,
		});
		const fetchPath = FETCH_PATHS[model.id];
		if (fetchPath) {
			const fetchImpl = options?.fetch;
			if (!fetchImpl) throw new Error(`${model.id} needs a fetch override`);
			void (async () => {
				stream.push({ type: "start", partial: message("", "stop") });
				let text = "";
				const delta = (chunk: string): void => {
					text += chunk;
					stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: message(text, "stop") });
				};
				try {
					const response = await fetchImpl(`https://fetch.example.invalid${fetchPath}`, {
						method: "POST",
						headers: { "x-probe": "from-provider" },
						body: "provider-payload",
						signal: options?.signal,
					});
					delta(`${response.status} ${response.statusText} ${response.headers.get("x-reply")};`);
					const body = response.body;
					if (!body) throw new Error("response has no body");
					const reader = body.getReader();
					const decoder = new TextDecoder();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						delta(decoder.decode(value));
					}
					stream.push({ type: "done", reason: "stop", message: message(text, "stop") });
				} catch (error) {
					const name = error instanceof Error ? error.name : typeof error;
					const failure = `${name}: ${error instanceof Error ? error.message : String(error)}`;
					const aborted = options?.signal?.aborted === true;
					stream.push({
						type: "error",
						reason: aborted ? "aborted" : "error",
						error: message(text, aborted ? "aborted" : "error", failure),
					});
				}
			})();
			return stream;
		}
		void (async () => {
			stream.push({ type: "start", partial: message("", "stop") });
			await Promise.resolve();
			stream.push({ type: "text_delta", contentIndex: 0, delta: "hel", partial: message("hel", "stop") });
			if (model.id === "hold-model") {
				const signal = options?.signal;
				if (!signal) throw new Error("hold-model needs an abort signal");
				const { promise, resolve } = Promise.withResolvers<void>();
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
				await promise;
				calls.aborted = true;
				stream.push({ type: "error", reason: "aborted", error: message("hel", "aborted") });
				return;
			}
			await Promise.resolve();
			stream.push({ type: "text_delta", contentIndex: 0, delta: "lo", partial: message("hello", "stop") });
			stream.push({ type: "done", reason: "stop", message: message("hello", "stop") });
		})();
		return stream;
	};
}

function runtimeConfig(calls: StreamCalls): ProviderConfigInput {
	return {
		baseUrl: "https://unit-runtime-mirror.example.invalid/v1",
		api: "unit-runtime-mirror-api",
		apiKey: "runtime-literal-key",
		headers: { "x-runtime": "mirror" },
		streamSimple: mainOnlyStream(calls),
		models: [
			modelDefinition("runtime-model"),
			modelDefinition("hold-model"),
			modelDefinition("throw-model"),
			...Object.keys(FETCH_PATHS).map(modelDefinition),
		],
	};
}

describe("worker model registry mirror", () => {
	let dir = "";
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let fixture: ServiceWorker<MirrorProbe>;
	let probe: MirrorProbe;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), `omp-registry-mirror-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		const modelsPath = path.join(dir, "models.yml");
		fs.writeFileSync(modelsPath, "providers: {}\n");
		registry = new ModelRegistry(authStorage, modelsPath, { cacheDbPath: path.join(dir, "models.db") });
		fixture = await startServiceWorker<MirrorProbe>(
			new URL("../fixtures/model-registry-mirror-worker.ts", import.meta.url),
			[authService],
		);
		probe = fixture.probe;
	});

	afterEach(async () => {
		await fixture.stop();
		registry.clearSourceRegistrations([SOURCE, DYNAMIC_SOURCE]);
		authStorage.close();
		removeSyncWithRetries(dir);
	});

	it("answers the model-switch auth pre-flight for a provider keyed on main", async () => {
		authStorage.keys.setRuntime("openai", "sk-main-runtime");
		expect(registry.hasConfiguredAuth(registry.find("openai", "gpt-4o-mini")!)).toBe(true);

		expect(await probe.hasConfiguredAuth(registry, "openai", "gpt-4o-mini")).toBe(true);
		expect(await probe.hasConfiguredAuth(registry, "openai", "gpt-4o-mini")).toBe(true);
	});

	/** Main batches changes per microtask; let that flush post them ahead of the next probe call. */
	async function flushToMirrors(): Promise<void> {
		await Promise.resolve();
	}

	it("re-runs a worker-cached `!command` header after main's credential refresh", async () => {
		const tokenFile = path.join(dir, "header-token.txt");
		fs.writeFileSync(tokenFile, "stale-header");
		fs.writeFileSync(
			path.join(dir, "models.yml"),
			JSON.stringify({
				providers: {
					"command-header-proxy": {
						baseUrl: "https://command-header-proxy.example.invalid/v1",
						api: "openai-completions",
						apiKey: "literal-key",
						headers: { "x-token": `!cat ${JSON.stringify(tokenFile)}` },
						models: [{ id: "command-header-model", name: "Command Header Model" }],
					},
				},
			}),
		);
		await registry.refresh("offline");
		await flushToMirrors();
		const workerHeader = async (): Promise<string | undefined> =>
			(await probe.resolveHeaders(registry, "command-header-proxy", "command-header-model"))?.["x-token"];
		expect(await workerHeader()).toBe("stale-header");

		fs.writeFileSync(tokenFile, "fresh-header");
		expect(await workerHeader()).toBe("stale-header");

		await registry.refresh("offline", { refreshCommandCredentials: true });
		await flushToMirrors();
		expect(await workerHeader()).toBe("fresh-header");
	});

	function mainProviderModels(provider: string): string {
		return JSON.stringify(registry.getAll("all").filter(model => model.provider === provider));
	}

	/** The fixture's `stream` probe, run in-process on main against main's registry. */
	async function streamOnMain(id: string, abortAfterDeltas?: number, withFetch?: boolean): Promise<StreamRecord> {
		const model = registry.find(PROVIDER, id);
		if (!model) throw new Error(`main has no ${PROVIDER}/${id}`);
		const controller = new AbortController();
		const fetched: FetchSeen[] = [];
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "worker-request-key",
				signal: controller.signal,
				fetch: withFetch ? scriptedFetch(fetched) : undefined,
			},
		);
		const events: string[] = [];
		let deltas = 0;
		for await (const event of stream) {
			events.push(event.type === "text_delta" ? `text_delta:${event.delta}` : event.type);
			if (event.type === "text_delta" && ++deltas === abortAfterDeltas) controller.abort();
		}
		const result = await stream.result();
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		return { events, stopReason: result.stopReason, text, errorMessage: result.errorMessage, fetched };
	}

	it("mirrors a provider main registers after the mirror was built, with identical models and its runtime key", async () => {
		// Build the mirror before main registers anything.
		expect(await probe.providerModels(registry, PROVIDER)).toBe("[]");

		registry.registerProvider(PROVIDER, runtimeConfig({ apiKeys: [], aborted: false }), SOURCE);
		await flushToMirrors();

		const mirrored = await probe.providerModels(registry, PROVIDER);
		expect(JSON.parse(mirrored)).toHaveLength(6);
		expect(mirrored).toBe(mainProviderModels(PROVIDER));
		expect(await probe.find(registry, PROVIDER, "runtime-model")).toBe(
			JSON.stringify(registry.find(PROVIDER, "runtime-model")),
		);
		expect(await probe.available(registry, PROVIDER, "runtime-model")).toBe(true);
		expect(await probe.apiKey(registry, PROVIDER)).toBe("runtime-literal-key");
	});

	it("streams a custom API defined only on main from the worker, including abort and failure", async () => {
		expect(await probe.providerModels(registry, PROVIDER)).toBe("[]");
		const calls: StreamCalls = { apiKeys: [], aborted: false };
		registry.registerProvider(PROVIDER, runtimeConfig(calls), SOURCE);
		await flushToMirrors();

		const inProcess = await streamOnMain("runtime-model");
		expect(inProcess).toMatchObject({ stopReason: "stop", text: "hello" });
		expect(inProcess.events).toContain("text_delta:lo");
		const fromWorker = await probe.stream(registry, PROVIDER, "runtime-model");
		expect(fromWorker).toEqual(inProcess);
		// Both requests ran the main thread's stream function.
		expect(calls.apiKeys).toEqual(["worker-request-key", "worker-request-key"]);

		const abortedInProcess = await streamOnMain("hold-model", 1);
		expect(abortedInProcess).toMatchObject({ stopReason: "aborted", text: "hel" });
		calls.aborted = false;
		expect(await probe.stream(registry, PROVIDER, "hold-model", 1)).toEqual(abortedInProcess);
		expect(calls.aborted).toBe(true);

		const failureMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
		const failure = await streamOnMain("throw-model").then(() => "resolved", failureMessage);
		expect(failure).toContain("scripted main-thread failure");
		// Settled by hand: `expect(…).rejects` waits without servicing the worker's messages.
		const workerFailure = await probe
			.stream(registry, PROVIDER, "throw-model")
			.then(() => "resolved", failureMessage);
		expect(workerFailure).toBe(failure);
	});

	it("streams a worker request whose tools carry class instances, handing main only their tool definitions", async () => {
		expect(await probe.providerModels(registry, PROVIDER)).toBe("[]");
		const calls: StreamCalls = { apiKeys: [], aborted: false, tools: [] };
		registry.registerProvider(PROVIDER, runtimeConfig(calls), SOURCE);
		await flushToMirrors();

		expect(await probe.streamWithTools(registry, PROVIDER, "runtime-model")).toMatchObject({
			stopReason: "stop",
			text: "hello",
		});
		// Main receives declaration fields only: no `session`, `label` or other live tool state.
		const sentKeys = calls.tools?.map(tools =>
			tools?.map(tool =>
				Object.entries(tool)
					.filter(([, value]) => value !== undefined)
					.map(([key]) => key)
					.sort(),
			),
		);
		expect(sentKeys).toEqual([[["description", "name", "parameters"]]]);
	});

	it("runs the worker's fetch override for a main-side custom API, streaming the response body back", async () => {
		expect(await probe.providerModels(registry, PROVIDER)).toBe("[]");
		registry.registerProvider(PROVIDER, runtimeConfig({ apiKeys: [], aborted: false }), SOURCE);
		await flushToMirrors();
		const request: FetchSeen = {
			url: "https://fetch.example.invalid/ok",
			method: "POST",
			probeHeader: "from-provider",
			body: "provider-payload",
		};

		const inProcess = await streamOnMain("fetch-model", undefined, true);
		expect(inProcess).toMatchObject({ stopReason: "stop", text: "201 Created from-fetch;chunk-1;chunk-2;" });
		expect(inProcess.fetched).toEqual([request]);
		// The request reached the worker's own fetch, and its streamed response came back in order.
		expect(await probe.stream(registry, PROVIDER, "fetch-model", undefined, true)).toEqual(inProcess);

		const failedInProcess = await streamOnMain("fetch-fail", undefined, true);
		expect(failedInProcess).toMatchObject({
			stopReason: "error",
			errorMessage: "TypeError: scripted network failure",
		});
		expect(await probe.stream(registry, PROVIDER, "fetch-fail", undefined, true)).toEqual(failedInProcess);

		// Abort after the first body chunk: the worker's body fails with the abort reason mid-stream.
		const abortedInProcess = await streamOnMain("fetch-hold", 2, true);
		expect(abortedInProcess).toMatchObject({ stopReason: "aborted", text: "201 Created from-fetch;chunk-1;" });
		expect(abortedInProcess.errorMessage).toStartWith("AbortError: ");
		expect(await probe.stream(registry, PROVIDER, "fetch-hold", 2, true)).toEqual(abortedInProcess);
	});

	it("adopts main's in-memory discovery results, including refreshes the worker asks main for", async () => {
		expect(await probe.providerModels(registry, DYNAMIC_PROVIDER)).toBe("[]");
		let fetches = 0;
		registry.registerProvider(
			DYNAMIC_PROVIDER,
			{
				baseUrl: "https://unit-dynamic-mirror.example.invalid/v1",
				api: "openai-completions",
				apiKey: "dynamic-literal-key",
				fetchDynamicModels: async () => {
					fetches++;
					return fetches === 1 ? [modelDefinition("dyn-a")] : [modelDefinition("dyn-a"), modelDefinition("dyn-b")];
				},
			},
			DYNAMIC_SOURCE,
		);
		await registry.refreshRuntimeProviders("online");
		await flushToMirrors();

		const first = await probe.providerModels(registry, DYNAMIC_PROVIDER);
		expect(JSON.parse(first)).toHaveLength(1);
		expect(first).toBe(mainProviderModels(DYNAMIC_PROVIDER));

		// The refresh runs on main; its result reaches the mirror before the call resolves.
		await probe.refreshRuntimeProviders(registry);
		expect(fetches).toBe(2);
		const second = await probe.providerModels(registry, DYNAMIC_PROVIDER);
		expect(JSON.parse(second)).toHaveLength(2);
		expect(second).toBe(mainProviderModels(DYNAMIC_PROVIDER));
	});

	it("drops providers main unregisters or whose extension source goes away", async () => {
		expect(await probe.providerModels(registry, PROVIDER)).toBe("[]");
		registry.registerProvider(PROVIDER, runtimeConfig({ apiKeys: [], aborted: false }), SOURCE);
		registry.registerProvider(
			DYNAMIC_PROVIDER,
			{
				baseUrl: "https://unit-dynamic-mirror.example.invalid/v1",
				api: "openai-completions",
				apiKey: "dynamic-literal-key",
				models: [modelDefinition("static-dyn")],
			},
			DYNAMIC_SOURCE,
		);
		await flushToMirrors();
		expect(await probe.find(registry, PROVIDER, "runtime-model")).toBeDefined();
		expect(await probe.find(registry, DYNAMIC_PROVIDER, "static-dyn")).toBeDefined();

		registry.unregisterProvider(PROVIDER);
		await flushToMirrors();
		expect(await probe.find(registry, PROVIDER, "runtime-model")).toBeUndefined();
		expect(await probe.providerModels(registry, PROVIDER)).toBe(mainProviderModels(PROVIDER));

		registry.syncExtensionSources([]);
		await flushToMirrors();
		expect(await probe.find(registry, DYNAMIC_PROVIDER, "static-dyn")).toBeUndefined();
	});

	it("keeps main the only source of runtime registrations", async () => {
		expect(await probe.registerLocally(registry, "unit-worker-local")).toBe(false);
		expect(registry.find("unit-worker-local", "worker-local-model")).toBeUndefined();
	});

	it("prewarms a worker's mirror that later changes still reach", async () => {
		await prewarmModelRegistryMirror(fixture.peer, registry);
		registry.registerProvider(PROVIDER, runtimeConfig({ apiKeys: [], aborted: false }), SOURCE);
		await flushToMirrors();
		expect(await probe.providerModels(registry, PROVIDER)).toBe(mainProviderModels(PROVIDER));
	});
});
