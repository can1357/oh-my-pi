import * as http2 from "node:http2";
import type { InferenceStreamRequest, RunInferenceServerMessage } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { RunInferenceClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import * as AIError from "../error";
import type {
	AssistantMessage,
	Context,
	Model,
	ProviderSessionState,
	StreamFunction,
	StreamOptions,
	ToolChoice,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { connectProxiedSocket, getProxyForUrl } from "../utils/proxy";
import { sanitizeCursorCallerHeaders } from "./cursor/headers";
import { loadCursorMachineIdentity } from "./cursor/identity";
import { buildInferenceRequest, buildInferenceRunRequest, inferenceRoutingKey } from "./cursor/request";
import { CursorInferenceMapper } from "./cursor/response";
import { CursorInferenceRuntime } from "./cursor/transport";

export const CURSOR_API_URL = "https://api2.cursor.sh";
const CURSOR_RUNTIME_STATE_KEY = "cursor-managed-inference";
const CURSOR_PROXY_TUNNEL_TIMEOUT_MS = 30_000;

export interface CursorOptions extends StreamOptions {
	/** Standard tool selection; RunInference supports auto or none. */
	toolChoice?: ToolChoice;
	/** Wire model id selected after OMP thinking-effort routing. */
	wireModelId?: string;
}

class CursorRuntimeState implements ProviderSessionState {
	readonly #runtimes = new Map<string, Promise<CursorInferenceRuntime>>();
	readonly #identity = loadCursorMachineIdentity();

	async runtimeFor(token: string, baseUrl: string, provider: string): Promise<CursorInferenceRuntime> {
		const proxyUrl = getProxyForUrl(provider, new URL(baseUrl));
		const digest = new Bun.CryptoHasher("sha256")
			.update(`${baseUrl}\0${proxyUrl?.toString() ?? ""}\0${token}`)
			.digest("hex");
		const existing = this.#runtimes.get(digest);
		if (existing !== undefined) return await existing;
		const pending = this.#createRuntime(token, baseUrl, proxyUrl);
		this.#runtimes.set(digest, pending);
		try {
			return await pending;
		} catch (error) {
			if (this.#runtimes.get(digest) === pending) this.#runtimes.delete(digest);
			throw error;
		}
	}

	async #createRuntime(token: string, baseUrl: string, proxyUrl: string | undefined): Promise<CursorInferenceRuntime> {
		return new CursorInferenceRuntime({
			backendUrl: baseUrl,
			token,
			ghostMode: false,
			identity: await this.#identity,
			connect:
				proxyUrl === undefined
					? authority => http2.connect(authority)
					: async authority => {
							const socket = await connectProxiedSocket(proxyUrl, baseUrl, {
								timeoutMs: CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
							});
							return http2.connect(authority, { createConnection: () => socket });
						},
		});
	}

	close(): void {
		const runtimes = [...this.#runtimes.values()];
		this.#runtimes.clear();
		for (const pending of runtimes) {
			void pending.then(
				runtime => runtime.shutdown(),
				() => undefined,
			);
		}
	}
}

function getCursorRuntimeState(providerSessionState: Map<string, ProviderSessionState> | undefined): {
	readonly state: CursorRuntimeState;
	readonly ephemeral: boolean;
} {
	const existing = providerSessionState?.get(CURSOR_RUNTIME_STATE_KEY);
	if (existing instanceof CursorRuntimeState) return { state: existing, ephemeral: false };
	existing?.close();
	const state = new CursorRuntimeState();
	providerSessionState?.set(CURSOR_RUNTIME_STATE_KEY, state);
	return { state, ephemeral: providerSessionState === undefined };
}

function outputFor(model: Model<"cursor-agent">, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "stop",
		timestamp,
	};
}

function isToolContinuation(context: Context): boolean {
	return context.messages.at(-1)?.role === "toolResult";
}

function stableHeaderKey(headers: Record<string, string> | undefined): string {
	return JSON.stringify(
		Object.entries(sanitizeCursorCallerHeaders(headers)).sort(([left], [right]) => left.localeCompare(right)),
	);
}

export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
		return new AIError.ProviderResponseError(
			`Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
				"This host serves RunInference over HTTP/2 only, and the TLS handshake did not negotiate h2 via ALPN. " +
				"Front the provider with a local HTTP/2 bridge and set providers.cursor.baseUrl to it.",
			{ provider: "cursor", kind: "runtime", cause: error },
		);
	}
	return error;
}

/** Streams one OMP-owned invocation through Cursor's native managed-inference RPC. */
export const streamCursor: StreamFunction<"cursor-agent"> = (model, context, rawOptions) => {
	const options = rawOptions as CursorOptions;
	const stream = new AssistantMessageEventStream();
	const startTime = performance.now();
	const output = outputFor(model, Date.now());
	let firstTokenTime: number | undefined;
	let ephemeralState: CursorRuntimeState | undefined;

	void (async () => {
		try {
			stream.push({ type: "start", partial: output });
			const apiKey = options?.apiKey;
			if (!apiKey) throw new AIError.MissingApiKeyError(undefined, "Cursor API key (access token) is required");
			const { state, ephemeral } = getCursorRuntimeState(options?.providerSessionState);
			if (ephemeral) ephemeralState = state;
			const sessionId = options.sessionId ?? crypto.randomUUID();

			const requestedModel = { wireModelId: options.wireModelId, maxMode: model.cursorMaxMode === true };
			const invocationId = crypto.randomUUID();
			const runRequestValue = buildInferenceRunRequest(model, context, sessionId, requestedModel);
			let request = buildInferenceRequest(model, context, {
				maxTokens: options.maxTokens,
				temperature: options.temperature,
				topP: options.topP,
				stopSequences: options.stopSequences,
				toolChoice: options.toolChoice,
			});
			const replacement = await options.onPayload?.(request, model);
			if (replacement !== undefined) request = replacement as InferenceStreamRequest;

			const runRequest = create(RunInferenceClientMessageSchema, {
				message: {
					case: "runRequest",
					value: runRequestValue,
				},
			});
			const mapper = new CursorInferenceMapper(
				stream,
				output,
				new Set([...request.tools.map(({ name }) => name), ...request.acceptedUnadvertisedToolNames]),
				invocationId,
				() => {
					firstTokenTime ??= performance.now();
				},
			);
			const baseUrl = model.baseUrl || CURSOR_API_URL;
			const runtime = await state.runtimeFor(apiKey, baseUrl, model.provider);
			const routeKey = `${inferenceRoutingKey(model, requestedModel)}\0${stableHeaderKey(options.headers)}`;
			await runtime.invoke(sessionId, routeKey, runRequest, invocationId, request, {
				reuseRun: isToolContinuation(context),
				signal: options.signal,
				callerHeaders: options.headers,
				onResponse: metadata => options.onResponse?.(metadata, model),
				onMessage: (message: RunInferenceServerMessage) => mapper.handle(message),
			});
			const result = mapper.finish();
			output.stopReason = result.stopReason;
			if (result.errorMessage !== undefined) output.errorMessage = result.errorMessage;
			if (result.errorStatus !== undefined) output.errorStatus = result.errorStatus;
			calculateCost(model, output.usage);
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			if (output.stopReason === "error") {
				stream.push({ type: "error", reason: "error", error: output });
			} else if (output.stopReason === "stop" || output.stopReason === "toolUse" || output.stopReason === "length") {
				stream.push({ type: "done", reason: output.stopReason, message: output });
			} else {
				throw new Error(`Cursor mapper returned invalid terminal '${output.stopReason}'`);
			}
			stream.end();
		} catch (rawError) {
			const error = mapH2TransportError(rawError, model.baseUrl || CURSOR_API_URL);
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			ephemeralState?.close();
		}
	})();

	return stream;
};
