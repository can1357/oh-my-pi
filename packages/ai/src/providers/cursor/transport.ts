import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders } from "node:http2";
import { connect } from "node:http2";
import { gzipSync } from "node:zlib";
import type {
	InferenceStreamRequest,
	RunInferenceClientMessage,
	RunInferenceInvocationEnd,
	RunInferenceInvocationError,
	RunInferenceRunReady,
	RunInferenceServerMessage,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	RunInferenceCancelInvocationSchema,
	RunInferenceClientMessageSchema,
	RunInferenceFinishRunSchema,
	RunInferenceInvokeModelSchema,
	RunInferenceServerMessageSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { isRecord, withTimeout } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { ProviderResponseMetadata } from "../../types";
import { raceWithSignal } from "../../utils/abort";
import { formatConnectEndStreamError, summarizeConnectErrorDetails } from "../connect-error-detail";
import { CONNECT_FLAG_COMPRESSED, CONNECT_MAX_FRAME_BYTES, ConnectFrameDecoder, encodeConnectFrame } from "./connect";
import { cursorErrorDetailValue, cursorProviderStatusCode } from "./error-detail";
import { inferenceRequestHeaders } from "./headers";
import type { CursorMachineIdentity } from "./identity";
import { withoutRunScopedReasoning } from "./request";

const CONNECT_COMPRESSION_MIN_BYTES = 1_024;
const RESPONSE_TIMEOUT_MS = 65_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_PENDING_INVOCATIONS = 64;
const MAX_QUEUED_RESPONSE_MESSAGES = 512;
const MAX_QUEUED_RESPONSE_BYTES = 8 * 1024 * 1024;

interface ConnectTrailerError {
	readonly code: string;
	readonly message?: string;
	readonly [key: string]: unknown;
}

interface ConnectTrailer {
	readonly error?: ConnectTrailerError;
}

export interface CursorInferenceRuntimeOptions {
	readonly backendUrl: string;
	readonly token: string;
	readonly ghostMode: boolean;
	readonly identity: CursorMachineIdentity;
	readonly connect?: (authority: string | URL) => ClientHttp2Session | Promise<ClientHttp2Session>;
	readonly responseTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly createRequestId?: () => string;
	readonly createClientKey?: () => string;
	readonly now?: () => number;
	readonly timezone?: () => string;
}

export interface CursorInferenceInvokeOptions {
	/** Reuse the current outer run for a tool-result continuation when it is still active. */
	readonly reuseRun?: boolean;
	readonly signal?: AbortSignal;
	readonly callerHeaders?: Record<string, string>;
	readonly onResponse?: (response: ProviderResponseMetadata) => void | Promise<void>;
	readonly onMessage: (message: RunInferenceServerMessage) => void | Promise<void>;
}

export interface CursorInferenceInvocation {
	readonly invocationId: string;
	readonly end: RunInferenceInvocationEnd;
}

interface PendingInvocation {
	readonly onMessage: CursorInferenceInvokeOptions["onMessage"];
	readonly resolve: (value: CursorInferenceInvocation) => void;
	readonly reject: (error: unknown) => void;
	readonly signal: AbortSignal | undefined;
	readonly abort: () => void;
	delivery: Promise<void>;
}

function randomHex(bytes: number): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function validateBackendUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error("Cursor backend authority is invalid", { cause: error });
	}
	const loopbackHttp =
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
	if (
		(url.protocol !== "https:" && !loopbackHttp) ||
		url.username !== "" ||
		url.password !== "" ||
		(url.pathname !== "" && url.pathname !== "/") ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("Cursor backend authority must be an HTTPS origin or loopback HTTP origin");
	}
	return new URL(url.origin);
}

function encodeClientMessage(message: RunInferenceClientMessage): Uint8Array {
	const protobufBody = toBinary(RunInferenceClientMessageSchema, message);
	if (protobufBody.byteLength > CONNECT_MAX_FRAME_BYTES) {
		throw new Error("Cursor RunInference client message exceeds the Connect frame limit");
	}
	return protobufBody.byteLength < CONNECT_COMPRESSION_MIN_BYTES
		? encodeConnectFrame(protobufBody)
		: encodeConnectFrame(gzipSync(protobufBody), CONNECT_FLAG_COMPRESSED);
}

function parseTrailer(body: Uint8Array): ConnectTrailer {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(body));
	} catch (error) {
		throw new Error("Cursor returned an invalid Connect end-of-stream trailer", { cause: error });
	}
	if (!isRecord(raw)) throw new Error("Cursor returned an invalid Connect end-of-stream trailer");
	if (raw.error === undefined) return {};
	if (!isRecord(raw.error) || typeof raw.error.code !== "string") {
		throw new Error("Cursor returned an invalid Connect error trailer");
	}
	const code = raw.error.code.trim();
	const message = raw.error.message;
	if (code === "" || (message !== undefined && typeof message !== "string")) {
		throw new Error("Cursor returned an invalid Connect error trailer");
	}
	return {
		error: {
			...raw.error,
			code,
			...(message === undefined ? {} : { message }),
		},
	};
}

export function cursorInvocationErrorMessage(error: RunInferenceInvocationError): string {
	const message = error.message.trim() === "" ? `Cursor invocation error ${error.code}` : error.message;
	const detail = summarizeConnectErrorDetails(
		error.details.map(entry => ({
			type: entry.type,
			value: cursorErrorDetailValue(entry),
		})),
	);
	return detail === undefined ? message : `${message} [details: ${detail}]`;
}

function cursorInvocationError(error: RunInferenceInvocationError): Error {
	const message = `Cursor invocation failed: ${cursorInvocationErrorMessage(error)}`;
	const providerStatus = cursorProviderStatusCode(error.details);
	const status =
		providerStatus ??
		(error.code === 16 ? 401 : error.code === 7 ? 403 : error.code === 8 ? 429 : error.code === 14 ? 503 : undefined);
	return status === undefined
		? new AIError.ProviderResponseError(message, { provider: "cursor", kind: "output" })
		: new AIError.ProviderHttpError(message, status, { code: String(error.code) });
}

function cursorTrailerError(error: ConnectTrailerError): Error {
	const message = `Cursor RunInference failed: ${formatConnectEndStreamError(error)}`;
	const status =
		error.code === "unauthenticated"
			? 401
			: error.code === "permission_denied"
				? 403
				: error.code === "resource_exhausted"
					? 429
					: error.code === "unavailable"
						? 503
						: undefined;
	return status === undefined
		? new AIError.ProviderResponseError(message, { provider: "cursor", kind: "output" })
		: new AIError.ProviderHttpError(message, status, { code: error.code });
}

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw abortError();
}

function waitForHttp2Connect(session: ClientHttp2Session): Promise<ClientHttp2Session> {
	if (!session.connecting) return Promise.resolve(session);
	const { promise, resolve, reject } = Promise.withResolvers<ClientHttp2Session>();
	const cleanup = (): void => {
		session.off("connect", connected);
		session.off("error", failed);
		session.off("close", closed);
	};
	const connected = (): void => {
		cleanup();
		resolve(session);
	};
	const failed = (error: Error): void => {
		cleanup();
		reject(error);
	};
	const closed = (): void => {
		cleanup();
		reject(new Error("Cursor HTTP/2 session closed before connecting"));
	};
	session.once("connect", connected);
	session.once("error", failed);
	session.once("close", closed);
	return promise;
}

function responseMetadata(headers: IncomingHttpHeaders): ProviderResponseMetadata {
	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(":")) continue;
		if (typeof value === "string") normalized[name] = value;
		else if (typeof value === "number") normalized[name] = String(value);
		else if (Array.isArray(value)) normalized[name] = value.join(", ");
	}
	const requestId = normalized["x-request-id"] ?? normalized["x-amzn-trace-id"] ?? null;
	return { status: Number(headers[":status"] ?? 0), headers: normalized, requestId };
}

export class CursorInferenceRun {
	readonly routeKey: string;
	readonly ready: Promise<RunInferenceRunReady>;
	readonly response: Promise<ProviderResponseMetadata>;
	readonly completion: Promise<ConnectTrailer>;
	readonly #request: ClientHttp2Stream;
	readonly #pending = new Map<string, PendingInvocation>();
	readonly #cancelled = new Set<string>();
	readonly #responseTimeoutMs: number;
	readonly #resolveReady: (value: RunInferenceRunReady) => void;
	readonly #rejectReady: (error: unknown) => void;
	readonly #resolveResponse: (value: ProviderResponseMetadata) => void;
	readonly #rejectResponse: (error: unknown) => void;
	readonly #resolveCompletion: (value: ConnectTrailer) => void;
	readonly #rejectCompletion: (error: unknown) => void;
	#writeQueue = Promise.resolve();
	#deliveryQueue = Promise.resolve();
	#queuedDeliveryMessages = 0;
	#queuedDeliveryBytes = 0;
	#runReady: RunInferenceRunReady | undefined;
	#trailer: ConnectTrailer | undefined;
	#failed: unknown;
	#finishing = false;

	constructor(
		session: ClientHttp2Session,
		routeKey: string,
		headers: Record<string, string>,
		responseTimeoutMs = RESPONSE_TIMEOUT_MS,
	) {
		this.routeKey = routeKey;
		this.#responseTimeoutMs = responseTimeoutMs;
		const ready = Promise.withResolvers<RunInferenceRunReady>();
		this.ready = ready.promise;
		this.#resolveReady = ready.resolve;
		this.#rejectReady = ready.reject;
		void this.ready.catch(() => undefined);
		const response = Promise.withResolvers<ProviderResponseMetadata>();
		this.response = response.promise;
		this.#resolveResponse = response.resolve;
		this.#rejectResponse = response.reject;
		void this.response.catch(() => undefined);
		const completion = Promise.withResolvers<ConnectTrailer>();
		this.completion = completion.promise;
		this.#resolveCompletion = completion.resolve;
		this.#rejectCompletion = completion.reject;
		void this.completion.catch(() => undefined);
		this.#request = session.request(headers);
		this.#bindResponse();
	}

	#bindResponse(): void {
		const decoder = new ConnectFrameDecoder();
		let status = 0;
		this.#request.on("response", headers => {
			status = Number(headers[":status"] ?? 0);
			const metadata = responseMetadata(headers);
			if (status !== 200) {
				this.#fail(
					new AIError.ProviderHttpError(`Cursor RunInference returned HTTP ${status}`, status, {
						headers: new Headers(metadata.headers),
					}),
				);
				return;
			}
			const contentType = headers["content-type"] ?? "";
			if (!String(contentType).startsWith("application/connect+proto")) {
				this.#fail(new Error("Cursor RunInference returned an invalid content type"));
				return;
			}
			this.#resolveResponse(metadata);
		});
		this.#request.on("data", (chunk: Uint8Array) => {
			try {
				for (const frame of decoder.push(chunk)) {
					if (this.#trailer !== undefined) throw new Error("Cursor sent data after the Connect trailer");
					if (frame.endOfStream) {
						this.#trailer = parseTrailer(frame.body);
						if (this.#trailer.error !== undefined) throw cursorTrailerError(this.#trailer.error);
						continue;
					}
					const message = fromBinary(RunInferenceServerMessageSchema, frame.body);
					this.#queuedDeliveryMessages++;
					this.#queuedDeliveryBytes += frame.body.byteLength;
					if (
						this.#queuedDeliveryMessages > MAX_QUEUED_RESPONSE_MESSAGES ||
						this.#queuedDeliveryBytes > MAX_QUEUED_RESPONSE_BYTES
					) {
						throw new Error("Cursor RunInference response delivery exceeded its bound");
					}
					this.#deliveryQueue = this.#deliveryQueue.then(async () => {
						try {
							await this.#handle(message);
						} finally {
							this.#queuedDeliveryMessages--;
							this.#queuedDeliveryBytes -= frame.body.byteLength;
						}
					});
					void this.#deliveryQueue.catch(error => this.#fail(error));
				}
			} catch (error) {
				this.#fail(error);
			}
		});
		this.#request.on("error", error => this.#fail(error));
		this.#request.on("aborted", () => this.#fail(new Error("Cursor RunInference stream aborted")));
		this.#request.on("end", () => {
			try {
				decoder.end();
			} catch (error) {
				this.#fail(error);
				return;
			}
			void this.#deliveryQueue.then(() => {
				if (this.#failed !== undefined || status !== 200) return;
				if (this.#trailer === undefined) {
					this.#fail(new Error("Cursor RunInference ended without a Connect trailer"));
					return;
				}
				if (this.#pending.size > 0) {
					this.#fail(new Error("Cursor RunInference ended with pending invocations"));
					return;
				}
				this.#resolveCompletion(this.#trailer);
			});
		});
	}

	async #handle(message: RunInferenceServerMessage): Promise<void> {
		switch (message.message.case) {
			case "heartbeat":
				return;
			case "runReady":
				if (this.#runReady !== undefined) throw new Error("Cursor sent duplicate runReady");
				if (
					message.message.value.resolvedModel === undefined ||
					message.message.value.resolvedModel.modelId === ""
				) {
					throw new Error("Cursor runReady has no resolved model");
				}
				this.#runReady = message.message.value;
				this.#resolveReady(message.message.value);
				return;
			case "invocationResponse": {
				const { invocationId } = message.message.value;
				if (this.#cancelled.has(invocationId)) return;
				const pending = this.#pending.get(invocationId);
				if (pending === undefined) throw new Error(`Cursor response has unknown invocation '${invocationId}'`);
				pending.delivery = pending.delivery.then(async () => await pending.onMessage(message));
				await pending.delivery;
				return;
			}
			case "invocationEnd": {
				const end = message.message.value;
				if (this.#cancelled.delete(end.invocationId)) return;
				const pending = this.#pending.get(end.invocationId);
				if (pending === undefined) throw new Error(`Cursor ended unknown invocation '${end.invocationId}'`);
				this.#pending.delete(end.invocationId);
				pending.signal?.removeEventListener("abort", pending.abort);
				await pending.delivery;
				if (end.error === undefined) pending.resolve({ invocationId: end.invocationId, end });
				else pending.reject(cursorInvocationError(end.error));
				return;
			}
			case undefined:
				throw new Error("Cursor RunInference server message has no arm");
		}
	}

	#fail(error: unknown): void {
		if (this.#failed !== undefined) return;
		this.#failed = error;
		this.#rejectReady(error);
		this.#rejectResponse(error);
		for (const pending of this.#pending.values()) {
			pending.signal?.removeEventListener("abort", pending.abort);
			pending.reject(error);
		}
		this.#pending.clear();
		this.#rejectCompletion(error);
		this.#request.destroy(error instanceof Error ? error : new Error(String(error)));
	}

	async send(message: RunInferenceClientMessage): Promise<void> {
		if (this.#failed !== undefined) throw this.#failed;
		const frame = encodeClientMessage(message);
		this.#writeQueue = this.#writeQueue.then(async () => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			this.#request.write(frame, error => {
				if (error === undefined || error === null) resolve();
				else reject(error);
			});
			await promise;
		});
		await this.#writeQueue;
	}

	async waitUntilReady(): Promise<RunInferenceRunReady> {
		return await withTimeout(this.ready, this.#responseTimeoutMs, "Cursor runReady timed out");
	}

	async start(message: RunInferenceClientMessage): Promise<RunInferenceRunReady> {
		return await withTimeout(
			this.send(message).then(async () => await this.ready),
			this.#responseTimeoutMs,
			"Cursor runReady timed out",
		);
	}

	abort(error: unknown): void {
		this.#fail(error);
	}

	async invoke(
		invocationId: string,
		request: InferenceStreamRequest,
		options: CursorInferenceInvokeOptions,
	): Promise<CursorInferenceInvocation> {
		if (this.#finishing) throw new Error("Cursor RunInference run is finishing");
		await this.waitUntilReady();
		throwIfAborted(options.signal);
		await options.onResponse?.(await this.response);
		if (this.#pending.size >= MAX_PENDING_INVOCATIONS)
			throw new Error("Cursor RunInference has too many pending invocations");
		if (this.#pending.has(invocationId) || this.#cancelled.has(invocationId)) {
			throw new Error(`Cursor invocation '${invocationId}' already exists`);
		}
		const result = Promise.withResolvers<CursorInferenceInvocation>();
		const abort = (): void => {
			const pending = this.#pending.get(invocationId);
			if (pending === undefined) return;
			this.#pending.delete(invocationId);
			this.#cancelled.add(invocationId);
			result.reject(abortError());
			void this.send(
				create(RunInferenceClientMessageSchema, {
					message: {
						case: "cancelInvocation",
						value: create(RunInferenceCancelInvocationSchema, { invocationId }),
					},
				}),
			).catch(error => this.#fail(error));
		};
		this.#pending.set(invocationId, {
			onMessage: options.onMessage,
			resolve: result.resolve,
			reject: result.reject,
			signal: options.signal,
			abort,
			delivery: Promise.resolve(),
		});
		if (options.signal?.aborted === true) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		if (this.#cancelled.has(invocationId)) return await result.promise;
		const send = this.send(
			create(RunInferenceClientMessageSchema, {
				message: {
					case: "invokeModel",
					value: create(RunInferenceInvokeModelSchema, { invocationId, request }),
				},
			}),
		).catch(error => {
			this.#pending.delete(invocationId);
			options.signal?.removeEventListener("abort", abort);
			result.reject(error);
			this.#fail(error);
		});
		await Promise.race([send, result.promise]);
		return await result.promise;
	}

	async #finishSequence(): Promise<void> {
		for (const [invocationId, pending] of this.#pending) {
			this.#pending.delete(invocationId);
			this.#cancelled.add(invocationId);
			pending.signal?.removeEventListener("abort", pending.abort);
			pending.reject(new Error("Cursor RunInference closed before invocation completed"));
			await this.send(
				create(RunInferenceClientMessageSchema, {
					message: {
						case: "cancelInvocation",
						value: create(RunInferenceCancelInvocationSchema, { invocationId }),
					},
				}),
			);
		}
		await this.send(
			create(RunInferenceClientMessageSchema, {
				message: { case: "finishRun", value: create(RunInferenceFinishRunSchema) },
			}),
		);
		this.#request.end();
		await this.completion;
	}

	async finish(timeoutMs: number): Promise<void> {
		try {
			if (this.#finishing) {
				await withTimeout(this.completion, timeoutMs, "Cursor RunInference shutdown timed out");
				return;
			}
			this.#finishing = true;
			await withTimeout(this.#finishSequence(), timeoutMs, "Cursor RunInference shutdown timed out");
		} catch (error) {
			this.abort(error);
			throw error;
		}
	}
}

interface RunSlot {
	readonly routeKey: string;
	readonly run: CursorInferenceRun;
}

interface RunSelection {
	readonly run: CursorInferenceRun;
	readonly reused: boolean;
}

/** Account-scoped managed-inference runtime with routed runs isolated by OMP session id. */
export class CursorInferenceRuntime {
	readonly #options: CursorInferenceRuntimeOptions;
	readonly #backend: URL;
	readonly #clientKey: string;
	readonly #runs = new Map<string, RunSlot>();
	readonly #runLocks = new Map<string, Promise<void>>();
	#session: ClientHttp2Session | undefined;
	#connectingSession: ClientHttp2Session | undefined;
	#sessionPromise: Promise<ClientHttp2Session> | undefined;
	#closed = false;

	constructor(options: CursorInferenceRuntimeOptions) {
		this.#backend = validateBackendUrl(options.backendUrl);
		this.#options = options;
		this.#clientKey = (options.createClientKey ?? (() => randomHex(32)))();
		if (!/^[0-9a-f]{64}$/u.test(this.#clientKey)) throw new Error("Cursor client key must be 32-byte lowercase hex");
	}

	async #getSession(): Promise<ClientHttp2Session> {
		if (this.#closed) throw new Error("Cursor managed-inference runtime is shut down");
		if (this.#session !== undefined && !this.#session.destroyed && !this.#session.closed) return this.#session;
		if (this.#sessionPromise !== undefined) return await this.#sessionPromise;

		let expired = false;
		let connectingSession: ClientHttp2Session | undefined;
		const establish = Promise.resolve(
			(this.#options.connect ?? (authority => connect(authority)))(this.#backend.origin),
		).then(async session => {
			connectingSession = session;
			if (expired || this.#closed) {
				session.destroy();
				throw new Error(
					this.#closed ? "Cursor managed-inference runtime is shut down" : "Cursor HTTP/2 connection timed out",
				);
			}
			this.#connectingSession = session;
			return await waitForHttp2Connect(session);
		});
		const attempt = withTimeout(
			establish,
			this.#options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS,
			"Cursor HTTP/2 connection timed out",
		)
			.then(session => {
				if (this.#connectingSession === session) this.#connectingSession = undefined;
				if (this.#closed) {
					session.destroy();
					throw new Error("Cursor managed-inference runtime is shut down");
				}
				this.#session = session;
				if (this.#sessionPromise === attempt) this.#sessionPromise = undefined;
				const clear = (): void => {
					if (this.#session === session) this.#session = undefined;
				};
				session.once("goaway", clear);
				session.on("error", clear);
				session.once("close", clear);
				return session;
			})
			.catch(error => {
				expired = true;
				connectingSession?.destroy();
				if (this.#connectingSession === connectingSession) this.#connectingSession = undefined;
				if (this.#sessionPromise === attempt) this.#sessionPromise = undefined;
				throw error;
			});
		this.#sessionPromise = attempt;
		return await attempt;
	}

	async #newRun(
		routeKey: string,
		runRequest: RunInferenceClientMessage,
		callerHeaders: Record<string, string> | undefined,
		signal: AbortSignal | undefined,
	): Promise<CursorInferenceRun> {
		const requestId = (this.#options.createRequestId ?? (() => crypto.randomUUID()))();
		const headers = inferenceRequestHeaders({
			token: this.#options.token,
			ghostMode: this.#options.ghostMode,
			identity: this.#options.identity,
			requestId,
			clientKey: this.#clientKey,
			callerHeaders,
			nowMs: (this.#options.now ?? Date.now)(),
			timezone: (this.#options.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))(),
		});
		const session = await raceWithSignal(this.#getSession(), signal);
		const run = new CursorInferenceRun(session, routeKey, headers, this.#options.responseTimeoutMs);
		const abort = (): void => run.abort(abortError());
		if (signal?.aborted === true) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		try {
			await run.start(runRequest);
			return run;
		} catch (error) {
			run.abort(error);
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async #runFor(
		sessionId: string,
		routeKey: string,
		runRequest: RunInferenceClientMessage,
		callerHeaders?: Record<string, string>,
		signal?: AbortSignal,
		reuseRun = true,
	): Promise<RunSelection> {
		if (sessionId === "") throw new Error("Cursor managed inference requires a stable session id");
		const previous = this.#runLocks.get(sessionId) ?? Promise.resolve();
		const gate = Promise.withResolvers<void>();
		const lock = previous.then(async () => await gate.promise);
		this.#runLocks.set(sessionId, lock);
		try {
			await raceWithSignal(previous, signal);
		} catch (error) {
			gate.resolve();
			const release = (): void => {
				if (this.#runLocks.get(sessionId) === lock) this.#runLocks.delete(sessionId);
			};
			void lock.then(release, release);
			throw error;
		}
		try {
			const slot = this.#runs.get(sessionId);
			if (reuseRun && slot?.routeKey === routeKey) return { run: slot.run, reused: true };
			if (slot !== undefined) {
				this.#runs.delete(sessionId);
				try {
					await slot.run.finish(this.#options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
				} catch (error) {
					slot.run.abort(error);
				}
			}
			const run = await this.#newRun(routeKey, runRequest, callerHeaders, signal);
			this.#runs.set(sessionId, { routeKey, run });
			const removeRun = (): void => {
				if (this.#runs.get(sessionId)?.run === run) this.#runs.delete(sessionId);
			};
			void run.completion.then(removeRun, removeRun);
			return { run, reused: false };
		} finally {
			gate.resolve();
			if (this.#runLocks.get(sessionId) === lock) this.#runLocks.delete(sessionId);
		}
	}

	async invoke(
		sessionId: string,
		routeKey: string,
		runRequest: RunInferenceClientMessage,
		invocationId: string,
		request: InferenceStreamRequest,
		options: CursorInferenceInvokeOptions,
	): Promise<CursorInferenceInvocation> {
		const selection = await this.#runFor(
			sessionId,
			routeKey,
			runRequest,
			options.callerHeaders,
			options.signal,
			options.reuseRun,
		);
		const invocationRequest = withoutRunScopedReasoning(request, selection.reused);
		return await selection.run.invoke(invocationId, invocationRequest, options);
	}

	async shutdown(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const runs = [...this.#runs.values()];
		this.#runs.clear();
		await Promise.allSettled(
			runs.map(async ({ run }) => await run.finish(this.#options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS)),
		);
		this.#connectingSession?.destroy();
		this.#connectingSession = undefined;
		this.#session?.destroy();
		this.#session = undefined;
	}
}
