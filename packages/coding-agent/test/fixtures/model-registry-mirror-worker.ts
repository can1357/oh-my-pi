import { type MessagePort, parentPort } from "node:worker_threads";
import { Type } from "@oh-my-pi/omptype/typebox";
import { type AgentTool, normalizeTools } from "@oh-my-pi/pi-agent-core";
import { type Api, type Context, type Model, streamSimple } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../src/config/model-registry";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { authService } from "../../src/thread/services/auth";
import { type FetchSeen, scriptedFetch } from "./model-registry-mirror-fetch";

/** What a worker-side stream through a mirrored custom API delivered. */
export interface StreamRecord {
	events: string[];
	stopReason: string;
	text: string;
	errorMessage: string | undefined;
	/** Requests the stream's `fetch` override served (empty without one). */
	fetched: FetchSeen[];
}

/** Worker-side reads and calls on a decoded registry mirror; each crosses to main as an async function. */
export interface MirrorProbe {
	/** JSON of the mirror's models of `provider` (functions dropped), in `getAll("all")` order. */
	providerModels(registry: ModelRegistry, provider: string): Promise<string>;
	/** JSON of `find(provider, id)`, or undefined. */
	find(registry: ModelRegistry, provider: string, id: string): Promise<string | undefined>;
	available(registry: ModelRegistry, provider: string, id: string): Promise<boolean>;
	apiKey(registry: ModelRegistry, provider: string): Promise<string | undefined>;
	/** `hasConfiguredAuth` of `provider/id` on the mirror: the pre-flight every model switch runs. */
	hasConfiguredAuth(registry: ModelRegistry, provider: string, id: string): Promise<boolean>;
	/**
	 * Stream `provider/id` through pi-ai's `streamSimple`; abort after `abortAfterDeltas` text deltas
	 * when given; pass this thread's {@link scriptedFetch} as the `fetch` override with `withFetch`.
	 */
	stream(
		registry: ModelRegistry,
		provider: string,
		id: string,
		abortAfterDeltas?: number,
		withFetch?: boolean,
	): Promise<StreamRecord>;
	/**
	 * Stream `provider/id` with one tool in the context, built as the agent loop builds it
	 * from a session tool whose own fields hold class instances (see {@link SessionBoundTool}).
	 */
	streamWithTools(registry: ModelRegistry, provider: string, id: string): Promise<StreamRecord>;
	/** Request-time headers of `provider/id` on the mirror, resolving `!command` values in this worker. */
	resolveHeaders(registry: ModelRegistry, provider: string, id: string): Promise<Record<string, string> | undefined>;
	/** `refreshRuntimeProviders` on the mirror (runs on main). */
	refreshRuntimeProviders(registry: ModelRegistry): Promise<void>;
	/** Register a provider on the mirror itself; returns whether the mirror then serves it. */
	registerLocally(registry: ModelRegistry, provider: string): Promise<boolean>;
}

function isTestGlobals(value: unknown): value is { ready(probe: MirrorProbe): void } {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

class ProbeSession {
	readonly cwd = "/probe";
}

const PROBE_PARAMETERS = Type.Object({ path: Type.String() });

/** A session tool like `ExtensionToolWrapper`: its constructor fields are live class instances. */
class SessionBoundTool implements AgentTool<typeof PROBE_PARAMETERS> {
	readonly name = "probe_tool";
	readonly label = "Probe";
	readonly description = "Reads a path";
	readonly parameters = PROBE_PARAMETERS;

	constructor(readonly session: ProbeSession) {}

	async execute(): Promise<never> {
		throw new Error("not run");
	}
}

async function recordStream(
	model: Model<Api>,
	context: Context,
	abortAfterDeltas?: number,
	withFetch?: boolean,
): Promise<StreamRecord> {
	const controller = new AbortController();
	const fetched: FetchSeen[] = [];
	const stream = streamSimple(model, context, {
		apiKey: "worker-request-key",
		signal: controller.signal,
		fetch: withFetch ? scriptedFetch(fetched) : undefined,
	});
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

const USER_HI: Context["messages"] = [{ role: "user", content: "hi", timestamp: 0 }];

const probe: MirrorProbe = {
	providerModels: async (registry, provider) =>
		JSON.stringify(registry.getAll("all").filter(model => model.provider === provider)),
	find: async (registry, provider, id) => {
		const model = registry.find(provider, id);
		return model ? JSON.stringify(model) : undefined;
	},
	available: async (registry, provider, id) =>
		registry.getAvailable("all").some(model => model.provider === provider && model.id === id),
	apiKey: (registry, provider) => registry.getApiKeyForProvider(provider),
	hasConfiguredAuth: async (registry, provider, id) => {
		const model = registry.find(provider, id);
		if (!model) throw new Error(`mirror has no ${provider}/${id}`);
		return registry.hasConfiguredAuth(model);
	},
	stream: async (registry, provider, id, abortAfterDeltas, withFetch) => {
		const model = registry.find(provider, id);
		if (!model) throw new Error(`mirror has no ${provider}/${id}`);
		return recordStream(model, { messages: USER_HI }, abortAfterDeltas, withFetch);
	},
	streamWithTools: async (registry, provider, id) => {
		const model = registry.find(provider, id);
		if (!model) throw new Error(`mirror has no ${provider}/${id}`);
		const tool = new SessionBoundTool(new ProbeSession());
		return recordStream(model, { messages: USER_HI, tools: normalizeTools([tool], { injectIntent: false }) });
	},
	resolveHeaders: async (registry, provider, id) => {
		const model = registry.find(provider, id);
		if (!model) throw new Error(`mirror has no ${provider}/${id}`);
		return registry.resolveModelHeaders(model);
	},
	refreshRuntimeProviders: registry => registry.refreshRuntimeProviders("online"),
	registerLocally: async (registry, provider) => {
		registry.registerProvider(
			provider,
			{
				baseUrl: "https://worker-local.example.invalid/v1",
				api: "openai-completions",
				apiKey: "worker-local-key",
				models: [
					{
						id: "worker-local-model",
						name: "Worker Local",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 4096,
						maxTokens: 1024,
					},
				],
			},
			"worker-local-extension",
		);
		return registry.find(provider, "worker-local-model") !== undefined;
	},
};

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "model-registry-mirror-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	authService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await authService.boot?.(globals[authService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("model registry mirror fixture: missing test globals");
		await test.ready(probe);
	});
	port.postMessage({ ready: true });
});
