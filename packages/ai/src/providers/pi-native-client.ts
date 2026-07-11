/**
 * Client half of the pi-native auth-gateway protocol.
 *
 * Dispatches a {@link streamSimple}-shaped request to an `omp auth-gateway`
 * via `POST /v1/pi/stream`, reads the SSE event stream back, and pushes the
 * parsed events into a local {@link AssistantMessageEventStream} — the same
 * stream type every other provider client produces. Callers downstream of
 * `streamSimple` cannot tell whether the events came from a real provider
 * SDK or from a gateway hop; they consume `AssistantMessageEvent`s either
 * way.
 *
 * Activated when a {@link Model} has `transport: "pi-native"` set; the
 * dispatch hook lives in `streamSimple()` (see `../stream.ts`). Used by
 * containerized omp deployments (robomp slots, the swarm extension) that
 * route every LLM call through a credential-holding sidecar so the slot
 * itself stays credential-free.
 */
import { readSseJson } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream as AssistantMessageEventStreamType,
	Context,
	Model,
	SimpleStreamOptions,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

/**
 * Fields that must not cross the wire — either non-serializable (functions,
 * `AbortSignal`, the provider-session `Map`) or server-controlled
 * (`apiKey`, which the gateway injects from its own credential store; the
 * client's `apiKey` is the gateway *bearer*, sent in the `Authorization`
 * header rather than the request body).
 */
const NON_WIRE_KEYS = new Set<keyof SimpleStreamOptions>([
	"signal",
	"apiKey",
	"fetch",
	"onPayload",
	"onResponse",
	"onSseEvent",
	"execHandlers",
	"cursorExecHandlers",
	"cursorOnToolResult",
	"providerSessionState",
]);

function buildWireOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
	if (!options) return {};
	const wire: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(options)) {
		if (v === undefined) continue;
		if (NON_WIRE_KEYS.has(k as keyof SimpleStreamOptions)) continue;
		wire[k] = v;
	}
	return wire;
}

async function decodeGatewayError(response: Response): Promise<AIError.AuthGatewayError> {
	const status = response.status;
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = await response.text().catch(() => "");
	}
	if (typeof body === "object" && body !== null && "error" in body) {
		const err = (body as { error: unknown }).error;
		if (typeof err === "object" && err !== null) {
			const message = (err as { message?: unknown }).message;
			const type = (err as { type?: unknown }).type;
			return new AIError.AuthGatewayError(
				typeof message === "string" ? message : `auth-gateway ${status}`,
				status,
				response.headers,
				typeof type === "string" ? type : undefined,
			);
		}
	}
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new AIError.AuthGatewayError(
		`auth-gateway ${status}: ${text || response.statusText}`,
		status,
		response.headers,
	);
}

/**
 * Resolve the `/v1/pi/stream` endpoint URL from the model's `baseUrl`.
 * Trims a trailing slash so concatenation can't double-slash; throws when
 * the baseUrl is missing (transport=pi-native without a gateway target is
 * a configuration error, not a runtime recoverable one).
 */
function resolveStreamUrl(model: Model<Api>): string {
	if (!model.baseUrl) {
		throw new AIError.ConfigurationError(
			`pi-native transport requires \`baseUrl\` on model ${model.id} (set it on the provider config in models.yml)`,
		);
	}
	return `${model.baseUrl.replace(/\/+$/, "")}/v1/pi/stream`;
}

function buildHeaders(model: Model<Api>, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		...(model.headers ?? {}),
	};
	if (apiKey && !headers.Authorization) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

/**
 * Stream a turn through an `omp auth-gateway` over the pi-native protocol.
 *
 * The returned {@link AssistantMessageEventStream} receives each parsed
 * `AssistantMessageEvent` verbatim from the gateway; the terminal `done` /
 * `error` event resolves `.result()` automatically via the base class's
 * completion check. Non-streaming consumers just call `.result()` and pay
 * for SSE framing they don't use — that overhead is dominated by provider
 * latency, so we always stream rather than maintaining a parallel
 * non-streaming path.
 */
export function streamPiNative<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStreamType {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const signal = options?.signal;
		// Abort propagation: cancel the response body when the caller's signal
		// fires. Mirror `streamProxy`'s shape — explicit listener + finally
		// cleanup — so we don't leak listeners on the long-running case.
		let response: Response | null = null;
		const onAbort = (): void => {
			const body = response?.body;
			if (body) body.cancel("Request aborted by caller").catch(() => {});
		};
		if (signal) {
			if (signal.aborted) {
				stream.fail(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			const url = resolveStreamUrl(model as Model<Api>);
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const headers = buildHeaders(
				model as Model<Api>,
				typeof options?.apiKey === "string" ? options.apiKey : undefined,
			);
			const body = JSON.stringify({
				modelId: `${model.provider}/${model.id}`,
				context,
				options: buildWireOptions(options),
				stream: true,
			});

			response = await fetchImpl(url, { method: "POST", headers, body, signal });
			if (!response.ok) {
				stream.fail(await decodeGatewayError(response));
				return;
			}
			if (!response.body) {
				stream.fail(
					new AIError.AuthGatewayError("auth-gateway returned empty body", response.status, response.headers),
				);
				return;
			}

			let sawTerminal = false;
			for await (const event of readSseJson<AssistantMessageEvent>(
				response.body as ReadableStream<Uint8Array>,
				signal,
			)) {
				if (event.type === "done" || event.type === "error") sawTerminal = true;
				stream.push(event);
				// `stream.push` resolves `.result()` on `done`/`error`; subsequent
				// pushes are silently dropped by the base class. We still iterate
				// to drain any trailing bytes from the wire so the underlying TCP
				// stream closes cleanly.
			}

			if (!sawTerminal) {
				// SSE closed before a terminal event reached us — synthesize one
				// so awaiters of `.result()` resolve instead of hanging forever.
				// Matches the gateway's own defensive fallback in
				// `pi-native-server.encodeStream`.
				const aborted = signal?.aborted === true;
				const partial = makeSyntheticAssistant(model as Model<Api>);
				if (aborted) {
					partial.stopReason = "aborted";
					partial.errorMessage = "stream closed without terminal event";
					stream.push({ type: "error", reason: "aborted", error: partial });
				} else {
					partial.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message: partial });
				}
			}
			stream.end();
		} catch (err) {
			stream.fail(err);
		} finally {
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	})();

	return stream;
}

function makeSyntheticAssistant(model: Model<Api>): AssistantMessage {
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
		timestamp: Date.now(),
	};
}
