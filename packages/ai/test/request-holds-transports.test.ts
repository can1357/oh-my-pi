/**
 * Every transport waits for the request holds of its async context right
 * before it sends a model request. Each test drives a real transport through
 * its narrowest real seam (a local HTTP server, the `fetch` option, the
 * WebSocket constructor, `http2.connect`, the native bridge) inside a context
 * whose hold is pending, and checks that the transport reached the hold, sent
 * nothing while held, and sent once the hold let go.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import http2 from "node:http2";
import { type RequestHolds, type RequestHoldView, runWithRequestHolds } from "@oh-my-pi/pi-ai";
import { listRegisteredApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { embed } from "@oh-my-pi/pi-ai/embeddings";
import { generateImage } from "@oh-my-pi/pi-ai/images";
import { NativeJudge } from "@oh-my-pi/pi-ai/judgment";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { rerank } from "@oh-my-pi/pi-ai/rerank";
import { SPEECH_APIS, synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { CodexSteerPump, type CodexSteerSocket } from "@oh-my-pi/pi-ai/providers/openai-codex/live-steering";
import type { InputItem } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import { transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import type {
	Api,
	AssistantMessage,
	Context,
	LiveSteering,
	FetchImpl,
	Model,
	ModelSpec,
	OptionsForApi,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { submitVideo } from "@oh-my-pi/pi-ai/video";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { IMAGE_GENERATION_APIS } from "@oh-my-pi/pi-catalog/types";
import * as natives from "@oh-my-pi/pi-natives";
import { withEnv } from "./helpers";
import { bedrockTestModel } from "./helpers/bedrock-stream";
import { factoryModel, gemini as factoryGemini, kimiK3, WORKOS_TOKEN } from "./helpers/factory-droid";

afterEach(() => {
	vi.restoreAllMocks();
});

/** A hold that holds while `armed`, counting its checks. */
class TestHolds implements RequestHolds {
	armed = true;
	release = Promise.withResolvers<void>();
	checks = 0;
	open(): RequestHoldView {
		return {
			check: () => {
				this.checks++;
				return this.armed ? this.release.promise : undefined;
			},
			release: () => {},
		};
	}
	let(): void {
		this.armed = false;
		this.release.resolve();
	}
}

async function turns(count = 10): Promise<void> {
	for (let i = 0; i < count; i++) {
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
}

/** Waits, an event-loop turn at a time, until `condition` holds; fails after a bound instead of hanging. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await turns(1);
	}
}

const context: Context = { messages: [{ role: "user", content: "hold me", timestamp: 1 }] };

/** One request through one transport, and the model-request I/O it caused. */
interface Driver {
	/** `chat` settles with an `AssistantMessage`; `call` settles with a value or rejects. */
	kind: "chat" | "call";
	/**
	 * How this chat transport reports a caller abort before its response
	 * arrives, when that is not `stopReason: "aborted"`. The held request must
	 * end the same way.
	 */
	abortedAs?: "error" | "rejection";
	/** Starts one request; called inside the holds' context. */
	start(signal: AbortSignal): Promise<unknown>;
	/** Model-request sends observed at the seam so far. */
	sent(): number;
	dispose?(): void | Promise<void>;
}

type DriverFactory = () => Driver;

function urlOf(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function refusal(): Response {
	return Response.json(
		{ error: { message: "held-test refusal", type: "invalid_request_error", code: "invalid_request" } },
		{ status: 400 },
	);
}

const DEVIN_AUTH = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "user-jwt" }));

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_held" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function heldModel<TApi extends Api>(
	api: TApi,
	provider: string,
	baseUrl: string,
	extra: Partial<ModelSpec<TApi>> = {},
): Model<TApi> {
	return buildModel({
		id: "held-test-model",
		name: "Held test model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
		...extra,
	} as ModelSpec<TApi>);
}

/** A fetch-based chat request: where it goes, how it is started, and which sends are model requests. */
interface FetchSpec {
	model: Model<Api>;
	options?: Record<string, unknown>;
	/** Start through `stream` (provider options) instead of `streamSimple`. */
	viaStream?: boolean;
	isModelRequest(url: string, method: string): boolean;
	/** Reply to a request; a refusal by default, so the stream ends. */
	reply?(url: string): Response;
	/** False when the transport cannot be pointed at a local server. */
	local?: false;
	abortedAs?: Driver["abortedAs"];
}

/** Fetch-based chat APIs, each built against `baseUrl` (a local server, or a placeholder host for the fetch seam). */
const fetchSpecs: Record<string, (baseUrl: string) => FetchSpec> = {
	"openai-completions": baseUrl => ({
		model: heldModel("openai-completions", "held-test", `${baseUrl}/v1`),
		isModelRequest: url => url.endsWith("/chat/completions"),
	}),
	"openai-responses": baseUrl => ({
		model: heldModel("openai-responses", "held-test", `${baseUrl}/v1`),
		isModelRequest: url => url.endsWith("/responses"),
	}),
	openrouter: baseUrl => ({
		model: heldModel("openrouter", "openrouter", `${baseUrl}/api/v1`),
		isModelRequest: url => /\/(responses|chat\/completions)$/.test(url),
	}),
	"openai-codex-responses": baseUrl => ({
		model: heldModel("openai-codex-responses", "openai-codex", `${baseUrl}/backend-api`, {
			preferWebsockets: false,
		}),
		options: { apiKey: codexToken() },
		isModelRequest: url => url.endsWith("/responses"),
	}),
	"azure-openai-responses": baseUrl => ({
		model: heldModel("azure-openai-responses", "azure", `${baseUrl}/openai/v1`),
		options: { azureBaseUrl: `${baseUrl}/openai/v1`, azureApiVersion: "v1" },
		viaStream: true,
		isModelRequest: url => url.includes("/responses"),
	}),
	"anthropic-messages": baseUrl => ({
		model: heldModel("anthropic-messages", "held-test", baseUrl),
		isModelRequest: url => url.includes("/v1/messages"),
	}),
	"bedrock-converse-stream": baseUrl => ({
		model: bedrockTestModel({ baseUrl }),
		options: { apiKey: "held-test-bearer", region: "us-east-1" },
		viaStream: true,
		isModelRequest: url => url.includes("/converse-stream"),
	}),
	"google-generative-ai": baseUrl => ({
		model: heldModel("google-generative-ai", "held-test", `${baseUrl}/v1beta`),
		isModelRequest: url => url.includes(":streamGenerateContent"),
	}),
	"google-gemini-cli": baseUrl => ({
		model: heldModel("google-gemini-cli", "google-gemini-cli", baseUrl),
		options: { apiKey: JSON.stringify({ token: "token", projectId: "proj-held" }) },
		isModelRequest: url => url.includes("v1internal:streamGenerateContent"),
	}),
	"google-vertex": () => ({
		model: heldModel("google-vertex", "google-vertex", "https://aiplatform.googleapis.com"),
		options: { apiKey: "vertex-key", location: "us-central1" },
		viaStream: true,
		isModelRequest: url => url.includes(":streamGenerateContent"),
		local: false,
	}),
	"ollama-chat": baseUrl => ({
		model: heldModel("ollama-chat", "ollama", baseUrl),
		isModelRequest: url => url.endsWith("/api/chat"),
	}),
	"devin-agent": baseUrl => ({
		model: heldModel("devin-agent", "devin", baseUrl),
		isModelRequest: url => !url.includes("GetUserJwt"),
		reply: url => (url.includes("GetUserJwt") ? new Response(DEVIN_AUTH) : refusal()),
	}),
	"factory-droid-agent": () => ({
		model: kimiK3(),
		options: { apiKey: WORKOS_TOKEN },
		isModelRequest: (_url, method) => method === "POST",
		local: false,
	}),
};

/** Fetch-based routes inside an API (a second wire, a gateway, a wrapping fetch), driven through the fetch seam. */
const fetchRouteSpecs: Record<string, () => FetchSpec> = {
	"factory-droid-agent Gemini wire": () => ({
		model: factoryGemini(),
		options: { apiKey: WORKOS_TOKEN },
		isModelRequest: (_url, method) => method === "POST",
	}),
	"pi-native gateway": () => ({
		model: heldModel("anthropic-messages", "held-test", "http://gateway.held.test:4000", { transport: "pi-native" }),
		isModelRequest: url => url.endsWith("/v1/pi/stream"),
		// The client fails its stream on an abort before the gateway answers (pi-native-client.test.ts pins it).
		abortedAs: "rejection",
	}),
	"kimi-code (OpenAI/Anthropic shim)": () => ({
		model: heldModel("openai-completions", "kimi-code", "https://api.kimi.com/coding/v1"),
		isModelRequest: (_url, method) => method === "POST",
	}),
};

/** Starts `spec`'s request with `fetch` and the given extra options. */
function startFetchSpec(
	spec: FetchSpec,
	signal: AbortSignal,
	fetch: FetchImpl | undefined,
	extra: Record<string, unknown> = {},
): Promise<AssistantMessage> {
	const options = { apiKey: "held-test-key", ...spec.options, ...extra, ...(fetch ? { fetch } : {}), signal };
	return spec.viaStream
		? stream(spec.model, context, options as OptionsForApi<Api>).result()
		: streamSimple(spec.model, context, options as SimpleStreamOptions).result();
}

/** Drives `spec` through the `fetch` option; counts the model requests that reached it. */
function fetchSeamDriver(spec: FetchSpec): Driver {
	let sent = 0;
	const fetch: FetchImpl = async (input, init) => {
		const url = urlOf(input);
		if (spec.isModelRequest(url, init?.method ?? "GET")) sent++;
		return spec.reply?.(url) ?? refusal();
	};
	return {
		kind: "chat",
		abortedAs: spec.abortedAs,
		sent: () => sent,
		start: signal => startFetchSpec(spec, signal, fetch),
	};
}

/** A local HTTP server that counts the model requests `spec` describes. */
function startModelServer(build: (baseUrl: string) => FetchSpec): {
	spec: FetchSpec;
	sent(): number;
	stop(): void;
} {
	let sent = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			await request.arrayBuffer();
			if (spec.isModelRequest(request.url, request.method)) sent++;
			return spec.reply?.(request.url) ?? refusal();
		},
	});
	const spec = build(`http://127.0.0.1:${server.port}`);
	return { spec, sent: () => sent, stop: () => server.stop(true) };
}

/** Cursor over HTTP/1.1: RunSSE and BidiAppend against a local server. */
function cursorHttp1Driver(): Driver {
	let sent = 0;
	const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			await request.arrayBuffer();
			const { pathname } = new URL(request.url);
			if (pathname === "/agent.v1.AgentService/RunSSE") {
				sent++;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streams.push(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (pathname === "/aiserver.v1.BidiService/BidiAppend") {
				sent++;
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});
	const model = heldModel("cursor-agent", "cursor", `http://127.0.0.1:${server.port}`);
	return {
		kind: "chat",
		sent: () => sent,
		start: signal =>
			stream(model, context, {
				apiKey: "cursor-key",
				transport: "http1",
				signal,
			} as OptionsForApi<"cursor-agent">).result(),
		dispose: () => {
			for (const controller of streams) {
				try {
					controller.close();
				} catch {}
			}
			server.stop(true);
		},
	};
}

/** Cursor over HTTP/2: the request stream `http2.connect(...).request(...)` opens. */
function cursorHttp2Driver(): Driver {
	let sent = 0;
	vi.spyOn(http2, "connect").mockImplementation((() => {
		const client = {
			on: () => client,
			once: () => client,
			off: () => client,
			removeListener: () => client,
			close: () => {},
			destroy: () => {},
			request: () => {
				sent++;
				const stream = {
					on: () => stream,
					once: () => stream,
					off: () => stream,
					removeListener: () => stream,
					write: () => true,
					end: () => {},
					close: () => {},
					destroy: () => {},
				};
				return stream;
			},
		};
		return client;
	}) as unknown as typeof http2.connect);
	const model = heldModel("cursor-agent", "cursor", "https://cursor.held.test");
	return {
		kind: "chat",
		sent: () => sent,
		start: signal =>
			stream(model, context, {
				apiKey: "cursor-key",
				transport: "http2",
				signal,
			} as OptionsForApi<"cursor-agent">).result(),
	};
}

/** Codex over its WebSocket: the request frame on the socket. */
function codexWebSocketDriver(extra: Partial<SimpleStreamOptions> = {}): Driver {
	let sent = 0;
	const originalWebSocket = globalThis.WebSocket;
	class HeldWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readyState = 0;
		binaryType = "blob";
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: Event) => void) | null = null;
		constructor(_url: string, _options?: unknown) {
			setImmediate(() => {
				this.readyState = 1;
				this.onopen?.(new Event("open"));
			});
		}
		send(): void {
			sent++;
		}
		close(): void {
			this.readyState = 3;
		}
	}
	globalThis.WebSocket = HeldWebSocket as unknown as typeof WebSocket;
	const providerSessionState = new Map();
	let httpSent = 0;
	const model = heldModel("openai-codex-responses", "openai-codex", "https://chatgpt.com/backend-api", {
		preferWebsockets: true,
	});
	return {
		kind: "chat",
		sent: () => sent + httpSent,
		start: signal =>
			streamSimple(model, context, {
				apiKey: codexToken(),
				sessionId: "held-websocket",
				providerSessionState,
				fetch: async () => {
					httpSent++;
					return refusal();
				},
				signal,
				...extra,
			} as SimpleStreamOptions).result(),
		dispose: () => {
			for (const state of providerSessionState.values()) state.close();
			globalThis.WebSocket = originalWebSocket;
		},
	};
}

/** GitLab Duo Workflow: the start frame on its WebSocket begins the model run. */
function gitlabWorkflowDriver(): Driver {
	let sent = 0;
	const model = heldModel("gitlab-duo-agent", "gitlab-duo-agent", "https://gitlab.held.test");
	const fetch: FetchImpl = async input => {
		const url = urlOf(input);
		if (url.includes("/api/v4/ai/duo_workflows/direct_access")) {
			return Response.json({ gitlab_rails: { token: "rails-token" } });
		}
		if (url.includes("/api/v4/ai/duo_workflows/workflows")) return Response.json({ id: "workflow-1" });
		return new Response("{}", { status: 404 });
	};
	return {
		kind: "chat",
		// The provider ends a caller abort as an error (gitlab-duo-workflow-provider.test.ts pins it).
		abortedAs: "error",
		sent: () => sent,
		start: signal =>
			stream(model, context, {
				apiKey: "pat-token",
				rootNamespaceId: "gid://gitlab/Group/1",
				fetch,
				webSocketFactory: () => {
					const socket = {
						onopen: null as ((event: Event) => void) | null,
						onmessage: null,
						onerror: null,
						onclose: null,
						send() {
							sent++;
						},
						close() {},
					};
					setImmediate(() => socket.onopen?.(new Event("open")));
					return socket;
				},
				signal,
			} as OptionsForApi<"gitlab-duo-agent">).result(),
	};
}

/** Apple Foundation Models: the native bridge's generate call. */
function appleDriver(): Driver {
	let sent = 0;
	vi.spyOn(natives, "appleFmGenerate").mockImplementation((_request, callback) => {
		sent++;
		queueMicrotask(() => callback(null, JSON.stringify({ type: "done" })));
		return 1;
	});
	vi.spyOn(natives, "appleFmCancel").mockImplementation(() => {});
	const model = heldModel("apple-foundation-models", "apple", "");
	return {
		kind: "chat",
		sent: () => sent,
		start: signal => streamSimple(model, context, { apiKey: "on-device", signal }).result(),
	};
}

registerMockApi("held-test/mock");

/** The mock provider, served through the custom API registry. */
function mockDriver(): Driver {
	const model = createMockModel({ handler: { content: ["ok"] } });
	return {
		kind: "chat",
		sent: () => model.calls.length,
		start: signal => streamSimple(model, context, { signal }).result(),
	};
}

const HOST_API = "held-test-host";
let hostCalls = 0;
registerCustomApi(
	HOST_API,
	(model, _context, options) => {
		hostCalls++;
		const events = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "host" }],
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
			stopReason: options?.signal?.aborted ? "aborted" : "stop",
			timestamp: Date.now(),
		};
		queueMicrotask(() => events.push({ type: "done", reason: "stop", message }));
		return events;
	},
	"held-test/host",
);

/** A provider a host registered at runtime; its transport is opaque, so the hand-off is the send. */
function hostDriver(): Driver {
	const start = hostCalls;
	const model = heldModel(HOST_API as Api, "held-test-host", "");
	return {
		kind: "chat",
		sent: () => hostCalls - start,
		start: signal => streamSimple(model, context, { apiKey: "host-key", signal }).result(),
	};
}

/** A Messages client the caller injects: its `create` may start I/O itself. */
function injectedAnthropicClientDriver(): Driver {
	let created = 0;
	const create = () => {
		created++;
		return { asResponse: () => Promise.resolve(refusal()) };
	};
	const model = heldModel("anthropic-messages", "held-test", "https://held.test");
	return {
		kind: "chat",
		sent: () => created,
		start: signal =>
			stream(model, context, {
				apiKey: "held-test-key",
				client: { messages: { create }, beta: { messages: { create } } },
				signal,
			} as OptionsForApi<"anthropic-messages">).result(),
	};
}

/** Wraps `driver` so `env` is set for the whole request, credential resolution included. */
function withEnvDriver(env: Record<string, string | undefined>, driver: Driver): Driver {
	return {
		...driver,
		start: signal => {
			let outcome: unknown;
			return withEnv(env, async () => {
				outcome = await driver.start(signal);
			}).then(() => outcome);
		},
	};
}

/** Bedrock Mantle signed with SigV4: the credential lookup and signature come before the held send. */
function mantleSigV4Driver(): Driver {
	const spec: FetchSpec = {
		model: heldModel("openai-responses", "bedrock-mantle", "https://bedrock-mantle.{region}.api.aws/openai/v1"),
		options: { apiKey: undefined, providerOptions: { region: "us-east-2" } },
		viaStream: true,
		isModelRequest: url => url.endsWith("/responses"),
	};
	return withEnvDriver(
		{
			AWS_BEARER_TOKEN_BEDROCK: undefined,
			AWS_PROFILE: undefined,
			AWS_ACCESS_KEY_ID: "AKIDHELDTEST",
			AWS_SECRET_ACCESS_KEY: "held-test-secret",
			AWS_SESSION_TOKEN: undefined,
			AWS_EC2_METADATA_DISABLED: "true",
		},
		fetchSeamDriver(spec),
	);
}

/** An OpenAI-wire model on Vertex: the access token is fetched before the held send. */
function vertexAuthenticatedDriver(): Driver {
	const spec: FetchSpec = {
		model: heldModel(
			"openai-completions",
			"google-vertex",
			"https://aiplatform.googleapis.com/v1/projects/held/locations/global/endpoints/openapi",
		),
		isModelRequest: url => url.endsWith("/chat/completions"),
	};
	return withEnvDriver({ GOOGLE_CLOUD_ACCESS_TOKEN: "held-test-token" }, fetchSeamDriver(spec));
}

const chatDrivers: Record<string, DriverFactory> = {
	...Object.fromEntries(
		Object.entries(fetchSpecs).map(([api, build]): [string, DriverFactory] => [
			api,
			() => fetchSeamDriver(build("https://held.test")),
		]),
	),
	"cursor-agent": cursorHttp1Driver,
	"gitlab-duo-agent": gitlabWorkflowDriver,
	"apple-foundation-models": appleDriver,
	mock: mockDriver,
	[HOST_API]: hostDriver,
};

const routeDrivers: Record<string, DriverFactory> = {
	...Object.fromEntries(
		Object.entries(fetchRouteSpecs).map(([route, build]): [string, DriverFactory] => [
			route,
			() => fetchSeamDriver(build()),
		]),
	),
	"openai-codex-responses over WebSocket": codexWebSocketDriver,
	"cursor-agent over HTTP/2": cursorHttp2Driver,
	"anthropic-messages with an injected client": injectedAnthropicClientDriver,
	"bedrock-mantle signed with SigV4": mantleSigV4Driver,
	"openai-completions on Vertex with an access token": vertexAuthenticatedDriver,
};

/** A non-chat request through the `fetch` option. */
function callDriver(
	isModelRequest: (url: string, method: string) => boolean,
	call: (fetch: FetchImpl, signal: AbortSignal) => Promise<unknown>,
): Driver {
	let sent = 0;
	const fetch: FetchImpl = async (input, init) => {
		if (isModelRequest(urlOf(input), init?.method ?? "GET")) sent++;
		return refusal();
	};
	return { kind: "call", sent: () => sent, start: signal => call(fetch, signal) };
}

const isPost = (_url: string, method: string) => method === "POST";

function imageDriver(api: string): Driver {
	const carrier =
		api === "openai-codex-responses"
			? heldModel("openai-codex-responses", "openai-codex", "https://chatgpt.com/backend-api")
			: heldModel("openai-responses", "held-test", "https://held.test/v1");
	const model =
		api === "factory-droid-agent"
			? factoryModel("gpt-image-2.5-flare")
			: heldModel(api as Api, "held-test", "https://held.test/v1");
	const apiKey =
		api === "factory-droid-agent"
			? WORKOS_TOKEN
			: api === "google-gemini-cli"
				? JSON.stringify({ token: "token", projectId: "proj-held" })
				: api === "openai-codex-responses"
					? codexToken()
					: "held-test-key";
	return callDriver(
		(url, method) => method === "POST" && (api !== "google-gemini-cli" || url.includes("streamGenerateContent")),
		(fetch, signal) => generateImage(model, { prompt: "a held circle" }, { apiKey, fetch, signal, carrier }),
	);
}

const callDrivers: Record<string, DriverFactory> = {
	embeddings: () =>
		callDriver(isPost, (fetch, signal) =>
			embed(
				heldModel("openai-embeddings" as Api, "held-test", "https://held.test/v1"),
				{ input: "held", encodingFormat: "float" },
				{ apiKey: "held-test-key", fetch, signal },
			),
		),
	rerank: () =>
		callDriver(isPost, (fetch, signal) =>
			rerank(
				heldModel("openrouter-rerank" as Api, "held-test", "https://held.test/v1"),
				{ query: "held", documents: ["a", "b"] },
				{ apiKey: "held-test-key", fetch, signal },
			),
		),
	transcription: () =>
		callDriver(isPost, (fetch, signal) =>
			transcribeAudio(
				heldModel("openai-transcriptions" as Api, "held-test", "https://held.test/v1"),
				{ audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", responseFormat: "json" },
				{ apiKey: "held-test-key", fetch, signal },
			),
		),
	"video submission": () =>
		callDriver(isPost, (fetch, signal) =>
			submitVideo(
				heldModel("openrouter-video" as Api, "held-test", "https://held.test/api/v1"),
				{ prompt: "a held wave" },
				{ apiKey: "held-test-key", fetch, signal },
			),
		),
	"native judgment": () =>
		callDriver(isPost, (fetch, signal) =>
			new NativeJudge({ apiKey: "held-test-key", fetch, baseUrl: "https://held.test" }).judge(
				{ state: "held", questions: { held: { type: "noul", instructions: "Is it held?" } } },
				{ signal },
			),
		),
	...Object.fromEntries(
		SPEECH_APIS.map((api): [string, DriverFactory] => [
			`speech ${api}`,
			() =>
				callDriver(isPost, (fetch, signal) =>
					synthesizeSpeech(
						heldModel(api as Api, "held-test", "https://held.test/v1"),
						{ text: "held", format: "mp3" },
						{ apiKey: "held-test-key", fetch, signal },
					),
				),
		]),
	),
	...Object.fromEntries(
		IMAGE_GENERATION_APIS.map((api): [string, DriverFactory] => [`image ${api}`, () => imageDriver(api)]),
	),
};

/** Runs `start` in a context whose hold is pending, then lets the hold go. */
async function expectHeldThenSent(driver: Driver): Promise<void> {
	const holds = new TestHolds();
	const controller = new AbortController();
	const done = runWithRequestHolds(holds, () => driver.start(controller.signal)).catch(() => undefined);
	try {
		await waitFor(() => holds.checks > 0 || driver.sent() > 0, "the request to reach the hold");
		await turns();
		expect({ reachedHold: holds.checks > 0, sentWhileHeld: driver.sent() }).toEqual({
			reachedHold: true,
			sentWhileHeld: 0,
		});
		holds.let();
		await waitFor(() => driver.sent() > 0, "the request to be sent once the hold let go");
	} finally {
		holds.let();
		controller.abort();
		await done;
		await driver.dispose?.();
	}
}

/** Aborts the request while it is held: it ends as the transport ends an abort, and sends nothing. */
async function expectAbortWhileHeld(driver: Driver): Promise<void> {
	const holds = new TestHolds();
	const controller = new AbortController();
	const done = runWithRequestHolds(holds, () => driver.start(controller.signal)).then(
		value => ({ value, error: undefined }),
		(error: unknown) => ({ value: undefined, error }),
	);
	try {
		await waitFor(() => holds.checks > 0 || driver.sent() > 0, "the request to reach the hold");
		controller.abort();
		const outcome = await done;
		await turns();
		if (driver.kind === "call" || driver.abortedAs === "rejection") {
			expect({ sent: driver.sent(), rejected: outcome.error instanceof Error }).toEqual({ sent: 0, rejected: true });
		} else {
			expect({
				sent: driver.sent(),
				stopReason: (outcome.value as AssistantMessage | undefined)?.stopReason,
				error: outcome.error,
			}).toEqual({ sent: 0, stopReason: driver.abortedAs ?? "aborted", error: undefined });
		}
	} finally {
		holds.let();
		await driver.dispose?.();
	}
}

const TIMEOUT_MS = 30_000;

describe("model request transports wait for request holds", () => {
	it("has a hold driver for every registered chat API", () => {
		const missing = listRegisteredApis().filter(api => !(api in chatDrivers));
		expect(missing).toEqual([]);
	});

	for (const api of listRegisteredApis()) {
		const factory = chatDrivers[api];
		it(
			`${api}: holds the request, then sends it once the hold lets go`,
			async () => {
				if (!factory) throw new Error(`no hold driver for ${api}`);
				await expectHeldThenSent(factory());
			},
			TIMEOUT_MS,
		);
		it(
			`${api}: an abort while held ends the request as aborted without sending`,
			async () => {
				if (!factory) throw new Error(`no hold driver for ${api}`);
				await expectAbortWhileHeld(factory());
			},
			TIMEOUT_MS,
		);
	}

	for (const [route, factory] of Object.entries(routeDrivers)) {
		it(
			`${route}: holds the request, then sends it once the hold lets go`,
			() => expectHeldThenSent(factory()),
			TIMEOUT_MS,
		);
		it(
			`${route}: an abort while held ends the request as aborted without sending`,
			() => expectAbortWhileHeld(factory()),
			TIMEOUT_MS,
		);
	}

	for (const [name, factory] of Object.entries(callDrivers)) {
		it(
			`${name}: holds the request, then sends it once the hold lets go`,
			() => expectHeldThenSent(factory()),
			TIMEOUT_MS,
		);
		it(`${name}: an abort while held rejects without sending`, () => expectAbortWhileHeld(factory()), TIMEOUT_MS);
	}
});

describe("a hold registered inside onPayload holds the HTTP request", () => {
	for (const [family, build] of Object.entries(fetchSpecs)) {
		if (build("https://held.test").local === false) continue;
		it(
			`${family}: the server sees no request until the hold lets go`,
			async () => {
				const server = startModelServer(build);
				const holds = new TestHolds();
				holds.armed = false;
				let payloadSeen = false;
				const controller = new AbortController();
				const done = runWithRequestHolds(holds, () =>
					startFetchSpec(server.spec, controller.signal, undefined, {
						onPayload: () => {
							payloadSeen = true;
							holds.armed = true;
							return undefined;
						},
					}),
				).catch(() => undefined);
				try {
					await waitFor(() => holds.checks > 0 || server.sent() > 0, "the request to reach the hold");
					await turns();
					expect({ payloadSeen, reachedHold: holds.checks > 0, sentWhileHeld: server.sent() }).toEqual({
						payloadSeen: true,
						reachedHold: true,
						sentWhileHeld: 0,
					});
					holds.let();
					await waitFor(() => server.sent() > 0, "the server to see the request once the hold let go");
				} finally {
					holds.let();
					controller.abort();
					await done;
					server.stop();
				}
			},
			TIMEOUT_MS,
		);
	}
});

describe("frames sent on an open model connection wait for request holds", () => {
	it("Codex: no host code runs between the last check and the request frame's send", async () => {
		// The diagnostic observer is host code: a hold it adds cannot be checked
		// before this frame, so it must hear of the frame only once it went out.
		const sentWhenObserved: number[] = [];
		const driver: Driver = codexWebSocketDriver({
			onSseEvent: event => {
				if (event.raw[0]?.startsWith(": ws →")) sentWhenObserved.push(driver.sent());
			},
		});
		const controller = new AbortController();
		const done = driver.start(controller.signal).catch(() => undefined);
		try {
			await waitFor(() => sentWhenObserved.length > 0, "the observer to hear of the request frame");
			expect(sentWhenObserved[0]).toBe(1);
		} finally {
			controller.abort();
			await done;
			await driver.dispose?.();
		}
	});

	it("Codex: a steering frame is held, and not sent when the response ends while held", async () => {
		const steers: string[] = [];
		const socket: CodexSteerSocket = {
			steer: async previousResponseId => {
				steers.push(previousResponseId);
				return { accepted: true, id: `steer-${steers.length}` };
			},
		};
		let rejected = 0;
		let offered = 0;
		const source: LiveSteering = {
			wait: async signal => {
				if (offered === 0) return;
				const stopped = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => stopped.resolve(), { once: true });
				await stopped.promise;
			},
			claim: async () => {
				offered++;
				return {
					messages: [{ role: "user", content: "steer", timestamp: 1 }],
					accept: () => {},
					reject: () => rejected++,
				};
			},
		};
		const toInput = (): InputItem[] => [];

		// Held, then let go: the frame goes out.
		const holds = new TestHolds();
		const pump = runWithRequestHolds(holds, () => {
			const created = new CodexSteerPump(source, socket, toInput);
			created.start("resp-1");
			return created;
		});
		await waitFor(() => holds.checks > 0, "the steering frame to reach the hold");
		await turns();
		expect(steers).toEqual([]);
		holds.let();
		await waitFor(() => steers.length === 1, "the steering frame once the hold let go");
		expect((await pump.finish()).accepted.map(steer => steer.id)).toEqual(["steer-1"]);

		// Held when the response ends: nothing is sent and the input goes back to the caller.
		offered = 0;
		const heldToEnd = new TestHolds();
		const ended = runWithRequestHolds(heldToEnd, () => {
			const created = new CodexSteerPump(source, socket, toInput);
			created.start("resp-2");
			return created;
		});
		await waitFor(() => heldToEnd.checks > 0, "the second steering frame to reach the hold");
		const outcome = await ended.finish();
		expect({ steers, rejected, submitted: outcome.submitted, uncertain: outcome.uncertain }).toEqual({
			steers: ["resp-1"],
			rejected: 1,
			submitted: false,
			uncertain: false,
		});
	});

	it("Cursor over HTTP/2: frames written after the stream opens are held, in order", async () => {
		const writes: string[] = [];
		let opened = false;
		vi.spyOn(http2, "connect").mockImplementation((() => {
			const client = {
				on: () => client,
				once: () => client,
				off: () => client,
				removeListener: () => client,
				close: () => {},
				destroy: () => {},
				request: () => {
					opened = true;
					const stream = {
						writableEnded: false,
						closed: false,
						on: () => stream,
						once: () => stream,
						off: () => stream,
						removeListener: () => stream,
						write: () => {
							writes.push("frame");
							return true;
						},
						end: () => {
							writes.push("end");
							stream.writableEnded = true;
						},
						close: () => {},
						destroy: () => {},
					};
					return stream;
				},
			};
			return client;
		}) as unknown as typeof http2.connect);
		// Lets the stream open, then holds everything written on it until released.
		const writesHeld = Promise.withResolvers<void>();
		let released = false;
		const opening: RequestHolds = {
			open: () => ({
				check: () => (opened && !released ? writesHeld.promise : undefined),
				release: () => {},
			}),
		};
		const controller = new AbortController();
		const model = heldModel("cursor-agent", "cursor", "https://cursor.held.test");
		const done = runWithRequestHolds(opening, () =>
			stream(model, context, {
				apiKey: "cursor-key",
				transport: "http2",
				signal: controller.signal,
			} as OptionsForApi<"cursor-agent">).result(),
		).catch(() => undefined);
		try {
			await waitFor(() => opened, "the request stream to open");
			await turns();
			expect(writes).toEqual([]);
			released = true;
			writesHeld.resolve();
			await waitFor(() => writes.length > 0, "the run request frame once the hold let go");
			expect(writes[0]).toBe("frame");
		} finally {
			released = true;
			writesHeld.resolve();
			controller.abort();
			await done;
		}
	});
});
