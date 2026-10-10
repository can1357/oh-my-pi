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
 * containerized omp deployments (such as robomp slots) that
 * route every LLM call through a credential-holding sidecar so the slot
 * itself stays credential-free.
 */
import * as os from "node:os";
import { getAppName, getInstallId, readSseJson } from "@oh-my-pi/pi-utils";
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
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { assertSafeGovernedJson, createRequestSelectionGuard, serializeRequestBody } from "../utils/request-selection";
import {
	PI_NATIVE_ADMISSION_HEADER,
	PI_NATIVE_ADMISSION_PATH,
	PI_NATIVE_ADMISSION_VERSION,
	PI_NATIVE_GOVERNED_STREAM_PATH,
	isPiNativeAdmissionEvent,
	type PiNativeAdmissionEvent,
} from "./pi-native-admission";

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
	"onBeforeRequest",
	"onResponse",
	"onSseEvent",
	"execHandlers",
	"cursorExecHandlers",
	"cursorOnToolResult",
	"providerSessionState",
]);
const PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR = "pi-native stream stalled while waiting for the next event";
const PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR = "pi-native stream timed out while waiting for the first event";

function isPiNativeProgressEvent(event: unknown): boolean {
	if (typeof event !== "object" || event === null || !("type" in event)) return true;
	return event.type !== "start" && event.type !== "inference_admission";
}

function buildWireOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
	if (!options) return {};
	const wire: Record<string, unknown> = {};
	if (options.preserveModelSelection || options.preserveThinkingEffort) {
		const descriptors = Object.getOwnPropertyDescriptors(options);
		for (const key of NON_WIRE_KEYS) delete descriptors[key];
		assertSafeGovernedJson(Object.create(Object.getPrototypeOf(options), descriptors));
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (descriptor.enumerable && descriptor.value !== undefined) wire[key] = descriptor.value;
		}
		return wire;
	}
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
function resolveStreamUrl(model: Model<Api>, governed = false): string {
	if (!model.baseUrl) {
		throw new AIError.ConfigurationError(
			`pi-native transport requires \`baseUrl\` on model ${model.id} (set it on the provider config in models.yml)`,
		);
	}
	return `${model.baseUrl.replace(/\/+$/, "")}${governed ? PI_NATIVE_GOVERNED_STREAM_PATH : "/v1/pi/stream"}`;
}

function buildHeaders(model: Model<Api>, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		// Usage-attribution identity: the gateway reports this request's token
		// burn to the broker under the ORIGINATING client, not the gateway host.
		// Attribution-only — the gateway never forwards x-omp-* upstream. Header
		// values must stay ISO-8859-1-safe, hence the hostname scrub.
		"x-omp-install-id": getInstallId(),
		"x-omp-hostname": os.hostname().replace(/[^\x20-\x7e]/g, "?"),
		"x-omp-app": getAppName(),
		...model.headers,
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
		const callerSignal = options?.signal;
		const abortTracker = createAbortSourceTracker(callerSignal);
		// Abort propagation: cancel the response body when the caller's signal
		// fires. Mirror `streamProxy`'s shape — explicit listener + finally
		// cleanup — so we don't leak listeners on the long-running case.
		let response: Response | null = null;
		const onAbort = (): void => {
			const body = response?.body;
			if (body) body.cancel("Request aborted by caller").catch(() => {});
		};
		if (callerSignal) {
			if (callerSignal.aborted) {
				stream.fail(
					callerSignal.reason instanceof Error
						? callerSignal.reason
						: new Error(String(callerSignal.reason ?? "aborted")),
				);
				return;
			}
			callerSignal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			const governed = options?.preserveModelSelection === true || options?.preserveThinkingEffort === true;
			const url = resolveStreamUrl(model as Model<Api>, governed);
			const admissionUrl = governed
				? `${url.slice(0, -PI_NATIVE_GOVERNED_STREAM_PATH.length)}${PI_NATIVE_ADMISSION_PATH}`
				: undefined;
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const headers = buildHeaders(
				model as Model<Api>,
				typeof options?.apiKey === "string" ? options.apiKey : undefined,
			);
			const envelope = {
				modelId: `${model.provider}/${model.id}`,
				context,
				options: buildWireOptions(options),
				stream: true,
				...(governed ? { admission: { version: PI_NATIVE_ADMISSION_VERSION } } : {}),
			};
			const selectionGuard = createRequestSelectionGuard(options, envelope, payload => ({
				...(options?.preserveModelSelection
					? { modelId: payload.modelId, preserveModelSelection: payload.options.preserveModelSelection }
					: {}),
				...(options?.preserveThinkingEffort
					? {
							reasoning: payload.options.reasoning,
							disableReasoning: payload.options.disableReasoning,
							forceReasoningOff: payload.options.forceReasoningOff,
							thinkingBudgets: payload.options.thinkingBudgets,
							preserveThinkingEffort: payload.options.preserveThinkingEffort,
						}
					: {}),
			}));
			const body = serializeRequestBody(envelope, options, selectionGuard);

			await options?.onBeforeRequest?.();
			response = await fetchImpl(url, { method: "POST", headers, body, signal: abortTracker.requestSignal });
			if (!response.ok) {
				stream.fail(await decodeGatewayError(response));
				return;
			}
			const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
			if (
				governed &&
				(response.headers.get(PI_NATIVE_ADMISSION_HEADER) !== String(PI_NATIVE_ADMISSION_VERSION) || !requestId)
			) {
				throw new AIError.ModelSelectionError("The gateway did not accept request-scoped origin admission.");
			}
			// Callers can truthfully inspect the gateway HTTP response, but its
			// request body is opaque here; callbacks themselves never cross the wire.
			await notifyProviderResponse(
				options,
				response,
				model,
				response.headers.get("x-request-id") ?? response.headers.get("request-id"),
			);
			if (!response.body) {
				stream.fail(
					new AIError.AuthGatewayError("auth-gateway returned empty body", response.status, response.headers),
				);
				return;
			}

			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			const source = readSseJson<AssistantMessageEvent | PiNativeAdmissionEvent>(
				response.body as ReadableStream<Uint8Array>,
				abortTracker.requestSignal,
			);
			const watchedSource = iterateWithIdleTimeout(source, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				errorMessage: PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR,
				firstItemErrorMessage: PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR,
				onIdle: () =>
					abortTracker.abortLocally(new AIError.StreamTimeoutError(PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR)),
				onFirstItemTimeout: () =>
					abortTracker.abortLocally(new AIError.StreamTimeoutError(PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR)),
				isProgressItem: isPiNativeProgressEvent,
			});
			let sawTerminal = false;
			let admittedAttempts = 0;
			for await (const event of watchedSource) {
				if (event.type === "inference_admission") {
					if (
						!isPiNativeAdmissionEvent(event) ||
						!governed ||
						event.requestId !== requestId ||
						event.attempt !== admittedAttempts + 1
					) {
						throw new AIError.ModelSelectionError("The gateway sent an unrelated or replayed admission request.");
					}
					const decide = async (allow: boolean): Promise<void> => {
						const decisionResponse = await fetchImpl(admissionUrl!, {
							method: "POST",
							headers: { ...headers, Accept: "application/json" },
							body: JSON.stringify({ requestId: event.requestId, nonce: event.nonce, allow }),
							signal: abortTracker.requestSignal,
						});
						if (!decisionResponse.ok) throw await decodeGatewayError(decisionResponse);
						const acknowledgment = await decisionResponse.json();
						if (
							typeof acknowledgment !== "object" ||
							acknowledgment === null ||
							!("accepted" in acknowledgment) ||
							acknowledgment.accepted !== true
						) {
							throw new AIError.ModelSelectionError("The gateway did not acknowledge this admission decision.");
						}
					};
					try {
						await options?.onBeforeRequest?.();
					} catch (error) {
						await decide(false).catch(() => {});
						throw error;
					}
					await decide(true);
					admittedAttempts = event.attempt;
					continue;
				}
				if (governed && admittedAttempts === 0 && event.type !== "start" && event.type !== "error") {
					throw new AIError.ModelSelectionError("The gateway produced inference output without origin admission.");
				}
				const message =
					event.type === "error" ? event.error : event.type === "done" ? event.message : event.partial;
				if (message && typeof message.errorId === "number") {
					message.errorId &= ~AIError.Flag.HostAdmission;
				}
				if (event.type === "done" || event.type === "error") sawTerminal = true;
				stream.push(event);
				// `stream.push` resolves `.result()` on `done`/`error`; subsequent
				// pushes are silently dropped by the base class. We still iterate
				// to drain any trailing bytes from the wire so the underlying TCP
				// stream closes cleanly.
			}

			if (!sawTerminal) {
				const aborted = abortTracker.wasCallerAbort();
				const partial = makeSyntheticAssistant(model as Model<Api>);
				if (aborted) {
					partial.stopReason = "aborted";
					partial.errorMessage = "stream closed without terminal event";
					stream.push({ type: "error", reason: "aborted", error: partial });
				} else {
					stream.fail(
						new AIError.ProviderResponseError(
							"pi-native stream read error: stream closed before a terminal response event",
							{
								provider: model.provider,
								kind: "incomplete-stream",
							},
						),
					);
					return;
				}
			}
			stream.end();
		} catch (err) {
			stream.fail(err);
			abortTracker.abortLocally(err instanceof Error ? err : new Error(String(err)));
		} finally {
			if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
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
