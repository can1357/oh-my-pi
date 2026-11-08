/**
 * A2A v1.0 JSON-RPC client for the omp bridge.
 *
 * Wire contract (mirrors `./rpc.ts` and `./server.ts`):
 * - PascalCase methods: `SendMessage`, `GetTask`, `CancelTask`.
 * - Proto task states (`TASK_STATE_*`); `INPUT_REQUIRED`/`AUTH_REQUIRED` are
 *   *interrupted*, not terminal: the remote paused for a human, and omp v1 has
 *   no way to answer, so the caller reports that instead of hanging.
 * - A completed run's text is read from `artifacts[].parts[].text`, then the
 *   status message, then the agent's history messages. Files never travel:
 *   `metadata.outputPath` is a path on the *server's* disk.
 *
 * Transport:
 * - `SendMessage` then `GetTask` polling. A2A is async-first, so the total
 *   budget is unlimited by default (`a2a.clientTimeoutMs` opts in); connect is
 *   bounded at 10s per request, and polling backs off from 2s to 30s.
 * - The whole-run budget bounds the ENTIRE run (including the initial
 *   `SendMessage`) through one combined abort signal; the connect timeout
 *   stays a separate, per-request budget.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentCard } from "./card";
import { type A2aMessage, type A2aPart, type A2aTask, TASK_STATE, TERMINAL_TASK_STATES, type TaskState } from "./rpc";

export const A2A_CARD_PATH = "/.well-known/agent-card.json";
/** Per-request HTTP budget: a dead endpoint must not hang a task call. */
export const A2A_CONNECT_TIMEOUT_MS = 10_000;
export const A2A_POLL_INTERVAL_MS = 2_000;
export const A2A_MAX_POLL_INTERVAL_MS = 30_000;
/** Consecutive transport failures a poll loop tolerates before failing the run. */
const A2A_MAX_POLL_FAILURES = 3;

/**
 * An interrupted task stays open until a human answers; omp v1 cannot answer,
 * so the client reports that instead of polling. Checked lazily: a module-level
 * `Set` built from `TASK_STATE` lands in a circular-import TDZ when the bridge
 * modules load through the agent session.
 */
function isInterruptedState(state: TaskState): boolean {
	return state === TASK_STATE.INPUT_REQUIRED || state === TASK_STATE.AUTH_REQUIRED;
}

export class A2aClientError extends Error {
	readonly code: number | undefined;
	readonly httpStatus: number | undefined;

	constructor(message: string, options?: { code?: number; httpStatus?: number; cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "A2aClientError";
		this.code = options?.code;
		this.httpStatus = options?.httpStatus;
	}
}

/** The whole-run budget ran out while the remote task was still working. */
export class A2aTimeoutError extends A2aClientError {
	constructor(message: string) {
		super(message);
		this.name = "A2aTimeoutError";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The card lives at `<base>/.well-known/agent-card.json`; a direct card URL is kept verbatim. */
export function resolveAgentCardUrl(url: string): string {
	const parsed = new URL(url.trim());
	if (parsed.pathname.endsWith("/agent-card.json")) return parsed.toString();
	parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}${A2A_CARD_PATH}`;
	return parsed.toString();
}

/** The JSON-RPC endpoint a card advertises; `fallbackUrl` is the URL the card was fetched from. */
export function resolveRpcEndpoint(card: AgentCard, fallbackUrl?: string): string {
	const advertised = (card.supportedInterfaces ?? []).find(
		(iface): iface is { url: string } & typeof iface => typeof iface?.url === "string" && iface.url.length > 0,
	);
	if (advertised) return advertised.url;
	if (fallbackUrl) return new URL(fallbackUrl).toString();
	throw new A2aClientError("Agent card does not advertise a JSON-RPC endpoint");
}

/** Whether the card expects a bearer token on the RPC endpoint. */
export function cardRequiresBearer(card: AgentCard): boolean {
	return Object.values(card.securitySchemes ?? {}).some(scheme => {
		const http = isRecord(scheme) ? scheme.httpAuthSecurityScheme : undefined;
		return isRecord(http) && typeof http.scheme === "string" && http.scheme.toLowerCase() === "bearer";
	});
}

async function requestWithConnectTimeout(
	url: string,
	init: RequestInit,
	options: { fetch: typeof fetch; connectTimeoutMs: number; signal: AbortSignal | undefined; what: string },
): Promise<Response> {
	const timeout = AbortSignal.timeout(options.connectTimeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		return await options.fetch(url, { ...init, signal });
	} catch (error) {
		if (options.signal?.aborted) {
			throw options.signal.reason instanceof Error
				? options.signal.reason
				: new A2aClientError(`${options.what} aborted`);
		}
		if (timeout.aborted) {
			throw new A2aClientError(`${options.what} connect timed out after ${options.connectTimeoutMs}ms`, {
				cause: error,
			});
		}
		throw new A2aClientError(`${options.what} failed: ${errorMessage(error)}`, { cause: error });
	}
}

/** Text of a `parts` array, joined with a blank line; non-text parts are ignored. */
function partsText(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	return parts
		.filter((part): part is { text: string } => isRecord(part) && typeof part.text === "string")
		.map(part => part.text.trim())
		.filter(text => text.length > 0)
		.join("\n\n");
}

function isAgentRole(role: unknown): boolean {
	return typeof role === "string" && (role.toUpperCase() === "ROLE_AGENT" || role.toLowerCase() === "agent");
}

/** True when a SendMessage task is an addressed delivery receipt (metadata.delivery) — the work happens in the remote session. */
function isDeliveryReceipt(task: A2aTask): boolean {
	const metadata =
		typeof task.metadata === "object" && task.metadata !== null
			? (task.metadata as Record<string, unknown>)
			: undefined;
	return metadata?.delivery !== undefined;
}

export function taskText(task: A2aTask): string {
	const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
	const artifactTexts = artifacts
		.map(artifact => partsText(isRecord(artifact) ? artifact.parts : undefined))
		.filter(text => text.length > 0);
	if (artifactTexts.length > 0) return artifactTexts.join("\n\n");

	const statusText = partsText(task.status?.message?.parts);
	if (statusText.length > 0) return statusText;

	const history = Array.isArray(task.history) ? task.history : [];
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index];
		if (!message || !isAgentRole(message.role)) continue;
		const text = partsText(message.parts);
		if (text.length > 0) return text;
	}
	return "";
}

function isTaskLike(value: unknown): value is A2aTask {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || value.id.length === 0) return false;
	const status = value.status;
	return isRecord(status) && typeof status.state === "string";
}

export interface A2aSendResponse {
	task?: A2aTask;
	/** A direct answer instead of a task (spec `SendMessageResponse.message`). */
	message?: A2aMessage;
}

function asSendResponse(result: unknown): A2aSendResponse {
	if (isTaskLike(result)) return { task: result };
	if (isRecord(result)) {
		if (isTaskLike(result.task)) return { task: result.task };
		const message = result.message;
		if (isRecord(message) && typeof message.messageId === "string" && Array.isArray(message.parts)) {
			const reply: A2aMessage = {
				messageId: message.messageId,
				role: isAgentRole(message.role) ? "ROLE_AGENT" : "ROLE_USER",
				parts: message.parts as A2aPart[],
			};
			return { message: reply };
		}
	}
	throw new A2aClientError("SendMessage result carried neither a task nor a message");
}

function asTask(result: unknown): A2aTask {
	if (isTaskLike(result)) return result;
	if (isRecord(result) && isTaskLike(result.task)) return result.task;
	throw new A2aClientError("A2A response did not carry a Task");
}

export interface A2aRunResult {
	state: TaskState;
	task?: A2aTask;
	message?: A2aMessage;
	text: string;
	/** The remote paused on INPUT_REQUIRED/AUTH_REQUIRED; omp v1 cannot answer it. */
	interrupted: boolean;
}

export interface A2aClientOptions {
	/** JSON-RPC endpoint, normally `card.supportedInterfaces[0].url`. */
	url: string;
	token?: string;
	connectTimeoutMs?: number;
	/** Whole-run budget in milliseconds; `0` (default) waits indefinitely. */
	totalTimeoutMs?: number;
	pollIntervalMs?: number;
	maxPollIntervalMs?: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal?.reason instanceof Error ? signal.reason : new A2aClientError("A2A wait aborted"));
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	if (signal?.aborted) {
		onAbort();
		return promise;
	}
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

export class A2aClient {
	readonly url: string;
	readonly #token: string | undefined;
	readonly #connectTimeoutMs: number;
	readonly #totalTimeoutMs: number;
	readonly #pollIntervalMs: number;
	readonly #maxPollIntervalMs: number;
	readonly #fetch: typeof fetch;
	readonly #signal: AbortSignal | undefined;

	constructor(options: A2aClientOptions) {
		this.url = options.url;
		this.#token = options.token?.trim() || undefined;
		this.#connectTimeoutMs = options.connectTimeoutMs ?? A2A_CONNECT_TIMEOUT_MS;
		this.#totalTimeoutMs = Math.max(0, options.totalTimeoutMs ?? 0);
		this.#pollIntervalMs = Math.max(1, options.pollIntervalMs ?? A2A_POLL_INTERVAL_MS);
		this.#maxPollIntervalMs = Math.max(this.#pollIntervalMs, options.maxPollIntervalMs ?? A2A_MAX_POLL_INTERVAL_MS);
		this.#fetch = options.fetch ?? fetch;
		this.#signal = options.signal;
	}

	async sendMessage(
		prompt: string,
		options?: { contextId?: string; metadata?: Record<string, unknown>; messageId?: string },
		signal?: AbortSignal,
	): Promise<A2aSendResponse> {
		const params = {
			message: {
				messageId: options?.messageId ?? `omp-${crypto.randomUUID()}`,
				role: "ROLE_USER",
				parts: [{ text: prompt }],
				...(options?.contextId ? { contextId: options.contextId } : {}),
			},
			...(options?.metadata ? { metadata: options.metadata } : {}),
		};
		return asSendResponse(await this.#post("SendMessage", params, signal));
	}

	async getTask(id: string, signal?: AbortSignal): Promise<A2aTask> {
		return asTask(await this.#post("GetTask", { id }, signal));
	}

	async cancelTask(id: string, signal?: AbortSignal): Promise<A2aTask> {
		return asTask(await this.#post("CancelTask", { id }, signal));
	}

	/** Send one prompt and wait for the remote task to settle (or pause for input). */
	async sendAndWait(
		prompt: string,
		options?: { contextId?: string; metadata?: Record<string, unknown>; messageId?: string },
	): Promise<A2aRunResult> {
		// One combined signal bounds the WHOLE run - the initial SendMessage and
		// every GetTask poll - so a remote that accepts a request but never answers
		// cannot outlive `a2a.clientTimeoutMs`. Connect stays a per-request budget.
		const controller = new AbortController();
		const timer =
			this.#totalTimeoutMs > 0
				? setTimeout(
						() => controller.abort(new A2aTimeoutError(`A2A run timed out after ${this.#totalTimeoutMs}ms`)),
						this.#totalTimeoutMs,
					)
				: undefined;
		const runSignal =
			this.#totalTimeoutMs > 0
				? this.#signal
					? AbortSignal.any([this.#signal, controller.signal])
					: controller.signal
				: this.#signal;
		try {
			const deadline = this.#totalTimeoutMs > 0 ? Date.now() + this.#totalTimeoutMs : undefined;
			const sent = await this.sendMessage(prompt, options, runSignal);
			if (sent.task) {
				const settled = this.#settled(sent.task);
				if (settled) return settled;
				// An addressed delivery to a running agent carries the bus receipt:
				// the work now happens in the remote session, nothing left to poll.
				if (isDeliveryReceipt(sent.task))
					return {
						state: sent.task.status?.state ?? TASK_STATE.WORKING,
						task: sent.task,
						text: taskText(sent.task),
						interrupted: false,
					};
				return await this.#awaitTask(sent.task, deadline, runSignal);
			}
			if (sent.message) {
				return {
					state: TASK_STATE.COMPLETED,
					message: sent.message,
					text: partsText(sent.message.parts),
					interrupted: false,
				};
			}
			throw new A2aClientError("SendMessage result carried neither a task nor a message");
		} catch (error) {
			if (controller.signal.aborted && !(error instanceof A2aTimeoutError)) {
				throw new A2aTimeoutError(`A2A run timed out after ${this.#totalTimeoutMs}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Terminal/interrupted view of a task, or `undefined` while it is still open. */
	#settled(task: A2aTask): A2aRunResult | undefined {
		const state = task.status?.state;
		const interrupted = isInterruptedState(state);
		if (!interrupted && !TERMINAL_TASK_STATES.has(state)) return undefined;
		return {
			state,
			task,
			text: taskText(task),
			interrupted,
		};
	}

	async #awaitTask(
		initial: A2aTask,
		deadline: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<A2aRunResult> {
		let task = initial;
		let interval = this.#pollIntervalMs;
		let failures = 0;
		for (;;) {
			const settled = this.#settled(task);
			if (settled) return settled;
			if (deadline !== undefined) {
				const remaining = deadline - Date.now();
				if (remaining <= 0 || interval > remaining) {
					throw new A2aTimeoutError(
						`A2A task ${task.id} timed out after ${this.#totalTimeoutMs}ms (last state ${task.status.state})`,
					);
				}
			}
			await sleep(interval, signal);
			interval = Math.min(Math.max(interval + 1, Math.floor(interval * 1.5)), this.#maxPollIntervalMs);
			try {
				task = await this.getTask(task.id, signal);
				failures = 0;
			} catch (error) {
				// A JSON-RPC error is the server speaking; only transport failures retry.
				if (error instanceof A2aClientError && error.code !== undefined) throw error;
				failures += 1;
				if (failures >= A2A_MAX_POLL_FAILURES) throw error;
			}
		}
	}

	async #post(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json",
		};
		if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
		const response = await requestWithConnectTimeout(
			this.url,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
			},
			{
				fetch: this.#fetch,
				connectTimeoutMs: this.#connectTimeoutMs,
				signal: signal ?? this.#signal,
				what: `A2A ${method}`,
			},
		);
		const raw = await response.text();
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch (error) {
			throw new A2aClientError(`A2A ${method} returned non-JSON (HTTP ${response.status})`, {
				httpStatus: response.status,
				cause: error,
			});
		}
		if (isRecord(payload) && isRecord(payload.error)) {
			const { code, message } = payload.error;
			throw new A2aClientError(typeof message === "string" ? message : `A2A ${method} failed`, {
				...(typeof code === "number" ? { code } : {}),
				httpStatus: response.status,
			});
		}
		if (!response.ok) {
			throw new A2aClientError(`A2A ${method} failed (HTTP ${response.status})`, { httpStatus: response.status });
		}
		if (!isRecord(payload) || !("result" in payload)) {
			throw new A2aClientError(`A2A ${method} returned no JSON-RPC result`, { httpStatus: response.status });
		}
		return payload.result;
	}
}

export interface FetchAgentCardOptions {
	/** Base URL of the remote bridge, or a direct `agent-card.json` URL. */
	url: string;
	token?: string;
	connectTimeoutMs?: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export async function fetchAgentCard(options: FetchAgentCardOptions): Promise<{ card: AgentCard; endpoint: string }> {
	const cardUrl = resolveAgentCardUrl(options.url);
	const headers: Record<string, string> = { accept: "application/json" };
	if (options.token?.trim()) headers.authorization = `Bearer ${options.token.trim()}`;
	const response = await requestWithConnectTimeout(
		cardUrl,
		{ method: "GET", headers },
		{
			fetch: options.fetch ?? fetch,
			connectTimeoutMs: options.connectTimeoutMs ?? A2A_CONNECT_TIMEOUT_MS,
			signal: options.signal,
			what: "A2A agent card",
		},
	);
	if (!response.ok) {
		throw new A2aClientError(`Agent card ${cardUrl} returned HTTP ${response.status}`, {
			httpStatus: response.status,
		});
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new A2aClientError(`Agent card ${cardUrl} is not JSON`, { httpStatus: response.status, cause: error });
	}
	if (!isRecord(payload) || !Array.isArray(payload.skills)) {
		throw new A2aClientError(`Agent card ${cardUrl} is not an A2A v1.0 card`);
	}
	const card = payload as unknown as AgentCard;
	return { card, endpoint: resolveRpcEndpoint(card, options.url) };
}
