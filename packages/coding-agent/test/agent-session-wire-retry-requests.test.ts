/**
 * Counts the requests that actually reach the wire when a connection dies,
 * driving the real provider loops under a real `AgentSession` against a local
 * TCP server — `anthropic-messages`, whose client retries ten times of its
 * own and reports how often it did, and the fetch route (`openai-completions`),
 * where `fetchWithRetry` replays six times, the pre-output retry runs that
 * cycle twice, and nothing reports a count.
 *
 * The session-level retry tests script a mock stream, so they see one request
 * per turn attempt and cannot see the provider's own retry budget at all. That
 * blind spot is exactly what let a change multiply whole provider loops: the
 * Anthropic provider retries up to ten times on its own while nothing has
 * streamed, so a chain hold that fires on a contentless failure runs those ten
 * again, and a hold that reads streamed content as "made once" repeats a 503
 * that `fetchWithRetry` already replayed. These tests pin the request counts
 * on both sides of that line.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ApiKey, Model } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

/**
 * How the stub answers one request. The Anthropic ones speak Anthropic's SSE,
 * the `openai*` ones the chat-completions SSE, and `status503` either: an
 * overload with `retry-after: 0`, which `fetchWithRetry` replays on its own.
 * `encodingRejected` is the host's refusal of a compressed body, and
 * `identityDenied` GitHub Copilot's refusal of a client identity.
 */
type WireScript =
	| "cutBeforeHeaders"
	| "cutAfterReasoning"
	| "cutAfterReasoningWithHint"
	| "ok"
	| "status503"
	| "encodingRejected"
	| "identityDenied"
	| "openaiInbandCut"
	| "openaiReasoningCut";

/** What the stub saw of one request, for a script that answers by it. */
interface WireRequest {
	/** Requests this model has made so far, this one included. */
	nth: number;
	model: string;
	encoding: string | undefined;
	identity: string | undefined;
}

function resolveKey(apiKey: ApiKey | undefined): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	const bearer =
		typeof resolved === "string" ? resolved : resolved && "apiKey" in resolved ? resolved.apiKey : undefined;
	if (typeof bearer !== "string") throw new Error("expected a resolved bearer token");
	return bearer;
}

function sse(event: Record<string, unknown>): string {
	return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function chunk(text: string): string {
	return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
}

const MESSAGE_START = sse({
	type: "message_start",
	message: {
		id: "msg_wire",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-4-5",
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 1 },
	},
});

const REASONING = [
	sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
	sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "partial plan" } }),
].join("");

const COMPLETE_TURN = [
	MESSAGE_START,
	sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered on primary" } }),
	sse({ type: "content_block_stop", index: 0 }),
	sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
	sse({ type: "message_stop" }),
].join("");

function openaiFrame(body: Record<string, unknown>): string {
	return `data: ${JSON.stringify(body)}\n\n`;
}

const OPENAI_REASONING = openaiFrame({
	id: "chatcmpl_wire",
	object: "chat.completion.chunk",
	choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "partial plan" }, finish_reason: null }],
});

/** A gateway's in-band report that its upstream died before any content: an HTTP 200 SSE body. */
const OPENAI_INBAND_CUT = openaiFrame({ error: { message: "upstream closed the connection", type: "api_error" } });

/** Reasoning, then the gateway reports its upstream cut and names a 900 ms wait. */
const REASONING_THEN_CUT_WITH_HINT = `${MESSAGE_START}${REASONING}${sse({
	type: "error",
	error: { type: "api_error", message: "upstream closed the connection retry-after-ms=900" },
})}`;

const OVERLOADED_BODY = JSON.stringify({ error: { message: "overloaded", type: "overloaded_error" } });
const ENCODING_REJECTED_BODY = JSON.stringify({
	type: "error",
	error: {
		type: "invalid_request_error",
		message: "Request body is not valid gzip.",
		details: { error_code: "request_body_encoding_invalid" },
	},
});
const IDENTITY_DENIED_BODY = '{"error":{"message":"client identity denied"}}';

interface Conn {
	answered: boolean;
	buf: Buffer;
}

function decodeBody(body: Buffer, encoding: string | undefined): string {
	if (encoding === "gzip") return Buffer.from(Bun.gunzipSync(new Uint8Array(body))).toString("utf8");
	if (encoding === "zstd") return Buffer.from(Bun.zstdDecompressSync(body)).toString("utf8");
	return body.toString("utf8");
}

function startWireStub(script: (requestIndex: number, request: WireRequest) => WireScript): {
	port: number;
	requests: () => number;
	/** Requests whose body named `model`. */
	requestsFor: (model: string) => number;
	/** Cut every stream that has sent its partial body and waits for the client to read it. */
	releaseCuts: () => void;
	stop: () => void;
} {
	let requests = 0;
	const models: string[] = [];
	const pendingCuts: (() => void)[] = [];
	const server = Bun.listen<Conn>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { answered: false, buf: Buffer.alloc(0) };
			},
			data(socket, data) {
				if (socket.data.answered) return;
				socket.data.buf = Buffer.concat([socket.data.buf, Buffer.from(data)]);
				const headerEnd = socket.data.buf.indexOf("\r\n\r\n");
				if (headerEnd < 0) return;
				const head = socket.data.buf.subarray(0, headerEnd).toString("latin1");
				const header = (name: string) => new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im").exec(head)?.[1];
				const length = Number(header("content-length") ?? 0);
				const body = socket.data.buf.subarray(headerEnd + 4);
				if (body.length < length) return;
				socket.data.answered = true;
				const encoding = header("content-encoding")?.toLowerCase();
				const parsed: unknown = JSON.parse(decodeBody(body, encoding));
				const model =
					parsed && typeof parsed === "object" && "model" in parsed && typeof parsed.model === "string"
						? parsed.model
						: "";
				models.push(model);
				const mode = script(requests++, {
					nth: models.filter(candidate => candidate === model).length,
					model,
					encoding,
					identity: header("copilot-integration-id"),
				});
				const respond = (status: string, contentType: string, payload: string) =>
					socket.end(
						`HTTP/1.1 ${status}\r\ncontent-type: ${contentType}\r\nretry-after: 0\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
					);
				if (mode === "cutBeforeHeaders") {
					socket.terminate();
					return;
				}
				if (mode === "ok") return void respond("200 OK", "text/event-stream", COMPLETE_TURN);
				if (mode === "status503")
					return void respond("503 Service Unavailable", "application/json", OVERLOADED_BODY);
				if (mode === "encodingRejected") {
					return void respond("400 Bad Request", "application/json", ENCODING_REJECTED_BODY);
				}
				if (mode === "identityDenied")
					return void respond("403 Forbidden", "application/json", IDENTITY_DENIED_BODY);
				if (mode === "openaiInbandCut") return void respond("200 OK", "text/event-stream", OPENAI_INBAND_CUT);
				if (mode === "cutAfterReasoningWithHint") {
					return void respond("200 OK", "text/event-stream", REASONING_THEN_CUT_WITH_HINT);
				}
				const partial = mode === "openaiReasoningCut" ? OPENAI_REASONING : `${MESSAGE_START}${REASONING}`;
				socket.write(
					`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n${chunk(partial)}`,
				);
				socket.flush();
				// The cut must reach the client after the partial body. A reset that
				// lands before the client has read the body makes the kernel drop
				// that body, so the cut would look like one before any output, and a
				// fixed delay lost that race under load. The harness releases the cut
				// once the session has seen the reasoning (`releaseCuts`); the timer
				// only keeps a run that never surfaces reasoning from hanging.
				const cut = () => socket.terminate();
				pendingCuts.push(cut);
				setTimeout(() => {
					const index = pendingCuts.indexOf(cut);
					if (index >= 0) pendingCuts.splice(index, 1)[0]!();
				}, 2_000);
			},
		},
	});
	return {
		port: server.port,
		requests: () => requests,
		requestsFor: model => models.filter(candidate => candidate === model).length,
		releaseCuts: () => {
			for (const cut of pendingCuts.splice(0)) cut();
		},
		stop: () => server.stop(true),
	};
}

describe("wire retries reaching the provider", () => {
	let fixtureDir: TempDir;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-wire-retry-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});
	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-wire-retry-");
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		// The registry is shared; a chain entry an earlier test walked off is
		// left cooling down and would never be offered to the next test's chain.
		modelRegistry.clearSuppressedSelectors();
	});
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});
	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	/**
	 * Runs one prompt on a real Anthropic-messages stream pointed at the stub,
	 * with a mocked fallback model at the end of the chain so the chain hop is
	 * observable without another wire. Returns how many requests reached the
	 * stub before the fallback, and the waits the session scheduled.
	 *
	 * `chain` puts more Anthropic-messages models, served by the same stub,
	 * ahead of the mocked one. `catalogUrl` keeps each model's real base URL —
	 * request compression is scoped to the provider's own hosts — and routes the
	 * runtime's `fetch` to the stub instead, one call for one call.
	 */
	async function run(
		script: (requestIndex: number, request: WireRequest) => WireScript,
		options: {
			primary?: Model<"anthropic-messages">;
			chain?: Model<"anthropic-messages">[];
			maxRetries?: number;
			baseDelayMs?: number;
			maxDelayMs?: number;
			catalogUrl?: boolean;
			prompt?: string;
		} = {},
	): Promise<{
		requestsBeforeFallback: number | undefined;
		totalWireRequests: number;
		requestedModels: string[];
		requestsFor: (model: string) => number;
		retryDelaysMs: number[];
	}> {
		const stub = startWireStub(script);
		cleanups.push(() => stub.stop());
		const stubOrigin = `http://127.0.0.1:${stub.port}`;
		if (options.catalogUrl) {
			const runtimeFetch = globalThis.fetch.bind(globalThis);
			vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				return runtimeFetch(`${stubOrigin}${url.pathname}${url.search}`, init);
			}) as typeof fetch);
		}
		// The catalog getter returns the wide union; these rows' api is anthropic-messages.
		const primaryModel =
			options.primary ?? (getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">);
		const wireModels = [primaryModel, ...(options.chain ?? [])];
		const fallbackModel = getBundledModel("openai", "gpt-5.5");
		for (const model of wireModels) authStorage.keys.setRuntime(model.provider, `${model.provider}-test-key`);
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const selector = (model: Model) => `${model.provider}/${model.id}`;
		const chain = [...(options.chain ?? []).map(selector), selector(fallbackModel)];

		const requestedModels: string[] = [];
		let requestsBeforeFallback: number | undefined;
		const fallbackMock = createMockModel({
			responses: [{ content: ["recovered on fallback"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, streamOptions) => {
				requestedModels.push(selector(requestedModel));
				if (requestedModel.api === "anthropic-messages") {
					const wireModel = requestedModel as Model<"anthropic-messages">;
					return streamAnthropic(options.catalogUrl ? wireModel : { ...wireModel, baseUrl: stubOrigin }, context, {
						...streamOptions,
						apiKey: resolveKey(streamOptions?.apiKey),
					});
				}
				requestsBeforeFallback ??= stub.requests();
				return fallbackMock.stream(requestedModel, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": options.baseDelayMs ?? 5,
			"retry.maxDelayMs": options.maxDelayMs ?? 100,
			"retry.maxRetries": options.maxRetries ?? 10,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: chain },
		});
		settings.setModelRole("default", selector(primaryModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanups.push(() => sessionManager.close());
		cleanups.push(() => session.dispose());
		const retryDelaysMs: number[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryDelaysMs.push(event.delayMs);
			if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta")
				stub.releaseCuts();
		});
		mockSchedulerWaitWithClock();

		await session.prompt(options.prompt ?? "count the wire requests");
		await session.waitForIdle();
		return {
			requestsBeforeFallback,
			totalWireRequests: stub.requests(),
			requestedModels,
			requestsFor: stub.requestsFor,
			retryDelaysMs,
		};
	}

	it("does not re-run the provider's own retry budget for a reset before headers", async () => {
		// Nothing streams, so the provider loop owns the replay: eleven requests,
		// its ten retries plus the first. Turn recovery must then go to the chain
		// rather than hold, or those eleven happen again, and again.
		const { requestsBeforeFallback, requestedModels } = await run(() => "cutBeforeHeaders");

		expect(requestsBeforeFallback).toBe(11);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5.5"]);
	}, 60_000);

	it("holds the chain for a cut after reasoning streamed, and only for two retries", async () => {
		// Reasoning streamed, so the provider loop declines to retry and the
		// request reaches turn recovery having been made once. Three requests on
		// the model in all, then the chain.
		const { requestsBeforeFallback, requestedModels } = await run(() => "cutAfterReasoning");

		expect(requestsBeforeFallback).toBe(3);
		expect(requestedModels).toEqual([
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-5.5",
		]);
	}, 60_000);

	it("recovers on the same model when a held retry succeeds", async () => {
		const { totalWireRequests, requestedModels } = await run(index => (index === 0 ? "cutAfterReasoning" : "ok"));

		expect(totalWireRequests).toBe(2);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"]);
	}, 60_000);

	it("spends at most two held retries across the chain, not two per model", async () => {
		// Two held retries on the primary spend the budget, and the chain's
		// first entry — another Anthropic model on the same wire — gets a fresh
		// budget. Its own cut after reasoning walks on at once: the recovery's two
		// held retries are spent, so the chain does not wait a third time.
		const chainHead = getBundledModel("anthropic", "claude-opus-4-5") as Model<"anthropic-messages">;
		const { requestsBeforeFallback, requestedModels, requestsFor } = await run(() => "cutAfterReasoning", {
			chain: [chainHead],
			maxRetries: 2,
		});

		expect(requestsFor("claude-sonnet-4-5")).toBe(3);
		expect(requestsFor(chainHead.id)).toBe(1);
		expect(requestsBeforeFallback).toBe(4);
		expect(requestedModels).toEqual([
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-sonnet-4-5",
			`anthropic/${chainHead.id}`,
			"openai/gpt-5.5",
		]);
	}, 60_000);

	it("does not hold after the Copilot identity resend, which the native fetch made", async () => {
		// No fetch is supplied: the identity resend is the repository's own,
		// inside `wrapFetchForCopilotFallback`. It used to sit below the count, so
		// each failed call reported `0` for two requests and earned a hold — six
		// identical bodies before the chain. Counted, the first call reports a
		// replay and the chain is consulted at once.
		const identities: (string | undefined)[] = [];
		const { requestsBeforeFallback, requestedModels } = await run(
			(_index, request) => {
				identities.push(request.identity);
				return request.identity === "copilot-chat" ? "identityDenied" : "cutAfterReasoning";
			},
			{ primary: getBundledModel("github-copilot", "claude-opus-4.6") as Model<"anthropic-messages"> },
		);

		expect(identities).toEqual(["copilot-chat", "copilot-developer-cli"]);
		expect(requestsBeforeFallback).toBe(2);
		expect(requestedModels).toEqual(["github-copilot/claude-opus-4.6", "openai/gpt-5.5"]);
	}, 60_000);

	it("does not hold after the uncompressed resend of a refused compressed body", async () => {
		// The official API host gets a compressed body; a refusal is resent plain
		// inside `wrapFetchForRequestCompression`, below the client's own loop.
		const encodings: (string | undefined)[] = [];
		const { requestsBeforeFallback, requestedModels } = await run(
			(_index, request) => {
				encodings.push(request.encoding);
				return request.encoding ? "encodingRejected" : "cutAfterReasoning";
			},
			{ catalogUrl: true, prompt: "a detailed prompt ".repeat(500) },
		);

		expect(encodings.map(Boolean)).toEqual([true, false]);
		expect(requestsBeforeFallback).toBe(2);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5.5"]);
	}, 60_000);

	it("does not sleep a provider hint longer than the held window", async () => {
		// Each failure names a 900 ms wait at the 500 ms default base. Honouring it
		// as a held retry broke the bound on the sleep a hold adds — twice is
		// 1.8 s, and a 9 s hint was 18 s — so the chain is consulted instead.
		const { requestsBeforeFallback, retryDelaysMs } = await run(() => "cutAfterReasoningWithHint", {
			baseDelayMs: 500,
			maxDelayMs: 10_000,
		});

		expect(requestsBeforeFallback).toBe(1);
		expect(retryDelaysMs).toEqual([0]);
	}, 60_000);

	it("lets one held call spend a provider budget, not one per model the recovery reaches", async () => {
		// Sonnet's first request is cut after reasoning and reports no replay, so
		// it is held; the held call meets 503s, spends the provider's ten replays
		// and reports them. Opus then spends the session budget, and Haiku starts
		// on a fresh one. Holding Haiku spent another eleven-request budget.
		const opus = getBundledModel("anthropic", "claude-opus-4-5") as Model<"anthropic-messages">;
		const haiku = getBundledModel("anthropic", "claude-haiku-4-5") as Model<"anthropic-messages">;
		const { requestsBeforeFallback, requestsFor } = await run(
			(_index, request) => (request.nth === 1 || request.model === opus.id ? "cutAfterReasoning" : "status503"),
			{ chain: [opus, haiku], maxRetries: 2 },
		);

		expect([requestsFor("claude-sonnet-4-5"), requestsFor(opus.id), requestsFor(haiku.id)]).toEqual([12, 1, 1]);
		expect(requestsBeforeFallback).toBe(14);
	}, 60_000);

	/**
	 * The same questions on the fetch route, where the provider reports no
	 * replay count. A reset before headers is replayed by `fetchWithRetry` (six
	 * attempts) and that whole cycle again by the pre-output provider retry,
	 * whatever the diagnostic says — the layer reads no text. A hold on top of
	 * those twelve would make it thirty-six.
	 */
	async function runFetchRoute(
		script: (requestIndex: number) => WireScript = () => "cutBeforeHeaders",
	): Promise<{ requestsBeforeFallback: number | undefined; requestedModels: string[] }> {
		const stub = startWireStub(script);
		cleanups.push(() => stub.stop());
		// Its own credential store and registry: the runs above spend anthropic
		// and openai credentials on a dead wire, and a provider those runs left
		// cooling down would never be offered as this run's chain candidate.
		const routeStorage = await AuthStorage.create(path.join(tempDir.path(), "fetch-route-auth.db"));
		cleanups.push(() => routeStorage.close());
		const routeRegistry = new ModelRegistry(routeStorage, path.join(tempDir.path(), "fetch-route-models.yml"));
		const bundled = getBundledModel("openai", "gpt-4o") as Model;
		const primaryModel: Model<"openai-completions"> = {
			...bundled,
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${stub.port}/v1`,
		} as Model<"openai-completions">;
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		routeStorage.keys.setRuntime("openai", "openai-test-key");
		routeStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;

		const requestedModels: string[] = [];
		let requestsBeforeFallback: number | undefined;
		const fallbackMock = createMockModel({
			responses: [{ content: ["recovered on fallback"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => routeRegistry.resolver(requestedModel, agent.sessionId),
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === "openai") {
					return streamOpenAICompletions(primaryModel, context, {
						...options,
						apiKey: resolveKey(options?.apiKey),
					});
				}
				requestsBeforeFallback ??= stub.requests();
				return fallbackMock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 10,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [fallback] },
		});
		settings.setModelRole("default", primary);
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry: routeRegistry });
		cleanups.push(() => sessionManager.close());
		cleanups.push(() => session.dispose());
		session.subscribe(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta")
				stub.releaseCuts();
		});
		mockSchedulerWaitWithClock();

		await session.prompt("count the wire requests");
		await session.waitForIdle();
		return { requestsBeforeFallback, requestedModels };
	}

	it("does not re-run the fetch budget for a reset before headers", async () => {
		// Twelve: six `fetchWithRetry` attempts, the whole cycle again under the
		// pre-output provider retry, and then the chain. A hold here would make
		// it thirty-six.
		const { requestsBeforeFallback, requestedModels } = await runFetchRoute();

		expect(requestsBeforeFallback).toBe(12);
		expect(requestedModels).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
	}, 60_000);

	it.each<[string, WireScript]>([
		["an in-band cut that streamed nothing", "openaiInbandCut"],
		["a chunked transfer cut after reasoning", "openaiReasoningCut"],
	])(
		"does not replay a 503 that fetchWithRetry already replayed, then %s",
		async (_label, cut) => {
			// `fetchWithRetry` replays the 503 on its own, and the replay is the one
			// that dies. The message it surfaces carries no replay count, and either
			// streamed content or a wording no provider loop retries — the two things
			// that used to stand in for "made once". Two requests, then the chain;
			// holding sent the pair three times.
			const { requestsBeforeFallback, requestedModels } = await runFetchRoute(index =>
				index % 2 === 0 ? "status503" : cut,
			);

			expect(requestsBeforeFallback).toBe(2);
			expect(requestedModels).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
		},
		60_000,
	);
});
