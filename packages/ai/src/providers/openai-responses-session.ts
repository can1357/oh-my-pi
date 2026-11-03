import { cloneJsonTree, extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { RawSseEvent } from "../types";
import { sanitizeOpenAIResponsesAssistantHistoryItemsForReplay } from "../utils";
import { toWebSocketUrl } from "../utils/websocket";
import { hasOpenAIResponsesGenerationEvidence, readOpenAIResponsesRequestRejection } from "./openai-request-error";
import type {
	ResponseCreateParamsBase,
	ResponseInput,
	ResponseOutputItem,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import { buildResponsesDeltaInput, isOpenAIResponsesStalePreviousResponseError } from "./openai-shared";
import { ResponsesWebSocketConnection, ResponsesWebSocketTransportError } from "./responses-websocket-connection";

const IDLE_REUSE_MS = 30_000;

export interface ResponsesTransportScope {
	url: string;
	modelId: string;
	sessionId?: string;
}

/** Standard Responses protocol state; all networking belongs to the shared Codex-derived channel. */
export class StandardResponsesWebSocketSession {
	readonly connection: ResponsesWebSocketConnection;
	#completed = false;
	#lastResponseId?: string;
	#lastRequest?: ResponseCreateParamsBase;
	#lastResponseItems?: ResponseInput;

	constructor(
		url: string,
		readonly headers: Record<string, string>,
		proxy: string | undefined,
		connectTimeoutMs: number,
	) {
		this.connection = new ResponsesWebSocketConnection({
			url: toWebSocketUrl(url),
			headers,
			proxy,
			connectTimeoutMs,
			maxIdleReuseMs: IDLE_REUSE_MS,
			messageQueueCapacity: 4096,
			inspectUpgradeResponse: true,
		});
	}

	get reusable(): boolean {
		return this.#completed && this.connection.isHealthyForReuse();
	}

	#clearBaseline(): void {
		this.#lastResponseId = undefined;
		this.#lastRequest = undefined;
		this.#lastResponseItems = undefined;
	}

	async *events(
		body: ResponseCreateParamsBase,
		options: {
			signal: AbortSignal;
			chain: boolean;
			supportsImageDetailOriginal?: boolean;
			onSseEvent?: (event: RawSseEvent) => void;
		},
	): AsyncGenerator<ResponseStreamEvent> {
		this.#completed = false;
		const request: ResponseCreateParamsBase & Record<string, unknown> & { type: string } = {
			...body,
			type: "response.create",
		};
		delete request.stream;
		delete request.stream_options;
		delete request.background;
		const delta =
			options.chain && this.#lastResponseId
				? buildResponsesDeltaInput(this.#lastRequest, this.#lastResponseItems, request)
				: null;
		let wireRequest =
			delta !== null ? { ...request, previous_response_id: this.#lastResponseId, input: delta } : request;
		let chained = delta !== null;
		this.#clearBaseline();
		for (;;) {
			let exchangeEnded = false;
			let staleRetry = false;
			let first = true;
			const outputItems: ResponseOutputItem[] = [];
			try {
				const closedError = this.connection.closedError;
				if (closedError) throw closedError;
				for await (const raw of this.connection.streamRequest(
					{ send: wireRequest },
					{},
					options.signal,
					options.onSseEvent,
				)) {
					const event = raw as unknown as ResponseStreamEvent;
					const anchorError = event.type === "response.failed" ? event.response.error : raw;
					if (
						first &&
						chained &&
						isOpenAIResponsesStalePreviousResponseError(anchorError) &&
						!hasOpenAIResponsesGenerationEvidence(event)
					) {
						const status = extractHttpStatusFromError(raw) ?? extractHttpStatusFromError(anchorError);
						if (status === undefined || status === 400 || status === 422) {
							exchangeEnded = true;
							staleRetry = true;
							break;
						}
					}
					if (first) {
						const rejection = readOpenAIResponsesRequestRejection(event);
						if (rejection) {
							exchangeEnded = true;
							throw rejection;
						}
					}
					first = false;
					if (event.type === "response.output_item.done") outputItems[event.output_index] = event.item;
					const type: string = event.type;
					const terminal =
						type === "response.completed" || type === "response.incomplete" || type === "response.done";
					if (terminal) {
						exchangeEnded = true;
						this.#completed = true;
						if ("response" in event && event.response && typeof event.response === "object") {
							const response = event.response;
							if (
								type !== "response.incomplete" &&
								response.status !== "incomplete" &&
								response.status !== "failed" &&
								typeof response.id === "string"
							) {
								const items = Array.isArray(response.output) ? response.output : outputItems;
								const replayable = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
									cloneJsonTree(items as unknown as Array<Record<string, unknown>>),
									{ supportsImageDetailOriginal: options.supportsImageDetailOriginal },
								);
								if (replayable && replayable.length === items.length) {
									this.#lastResponseId = response.id;
									this.#lastRequest = cloneJsonTree(request);
									this.#lastResponseItems = replayable;
								}
							}
						}
					}
					yield event;
					if (terminal) return;
				}
				if (!exchangeEnded) {
					throw new ResponsesWebSocketTransportError(
						"closed",
						"before-terminal",
						"websocket closed before response completion",
					);
				}
			} finally {
				if (!exchangeEnded) this.close();
			}
			if (!staleRetry) return;
			// A definite first-frame rejection permits one full exchange, not a reconnect or uncertain replay.
			if (!this.connection.isOpen()) {
				throw new ResponsesWebSocketTransportError("unavailable", "stream", "websocket connection is unavailable");
			}
			chained = false;
			wireRequest = request;
		}
	}

	close(): void {
		this.#completed = false;
		this.#clearBaseline();
		this.connection.close("released");
	}
}

interface SessionConnection {
	sessionId?: string;
	session: StandardResponsesWebSocketSession;
	busy: boolean;
	timer?: NodeJS.Timeout;
}

interface TransportSession {
	sessionId: string;
	sseOnly: boolean;
	activeLeases: number;
	connection?: SessionConnection;
}

export interface StandardResponsesWebSocketLease {
	session: StandardResponsesWebSocketSession;
	/** Mark only the logical entry this lease acquired, never a replacement created after releaseSession/close. */
	markSseOnly(): void;
	release(): void;
}

/** The existing session pool owns both sticky transport choice and optional physical connection. */
export class OpenAIResponsesTransportSessions {
	#sessions = new Map<string, TransportSession>();
	#active = new Set<SessionConnection>();

	#key(scope: ResponsesTransportScope): string | undefined {
		return scope.sessionId ? `${scope.url}\u0000${scope.modelId}\u0000${scope.sessionId}` : undefined;
	}

	isSseOnly(scope: ResponsesTransportScope): boolean {
		const key = this.#key(scope);
		return key !== undefined && this.#sessions.get(key)?.sseOnly === true;
	}

	#discardUnused(key: string, entry: TransportSession): void {
		if (!entry.sseOnly && entry.activeLeases === 0 && !entry.connection && this.#sessions.get(key) === entry) {
			this.#sessions.delete(key);
		}
	}

	acquire(args: {
		scope: ResponsesTransportScope;
		headers: Record<string, string>;
		proxy?: string;
		connectTimeoutMs: number;
		retainConnection: boolean;
	}): StandardResponsesWebSocketLease {
		const key = this.#key(args.scope);
		let entry = key ? this.#sessions.get(key) : undefined;
		if (key && !entry) {
			entry = { sessionId: args.scope.sessionId!, sseOnly: false, activeLeases: 0 };
			this.#sessions.set(key, entry);
		}
		let cached = entry?.connection;
		if (cached && !cached.busy) {
			clearTimeout(cached.timer);
			const previousHeaders = cached.session.headers;
			const names = Object.keys(args.headers);
			const sameHeaders =
				names.length === Object.keys(previousHeaders).length &&
				names.every(name => args.headers[name] === previousHeaders[name]);
			if (!cached.session.reusable || !sameHeaders || !args.retainConnection || entry?.sseOnly) {
				cached.session.close();
				entry!.connection = undefined;
				cached = undefined;
			}
		}
		const retained = entry !== undefined && args.retainConnection && !entry.sseOnly && !cached?.busy;
		const leased =
			cached && retained
				? cached
				: {
						sessionId: args.scope.sessionId,
						session: new StandardResponsesWebSocketSession(
							args.scope.url,
							args.headers,
							args.proxy,
							args.connectTimeoutMs,
						),
						busy: false,
					};
		if (retained) entry!.connection = leased;
		if (entry) entry.activeLeases++;
		leased.busy = true;
		this.#active.add(leased);
		let released = false;
		return {
			session: leased.session,
			markSseOnly: () => {
				if (!key || !entry || this.#sessions.get(key) !== entry) return;
				entry.sseOnly = true;
				const idle = entry.connection;
				if (idle && !idle.busy) {
					clearTimeout(idle.timer);
					idle.session.close();
					entry.connection = undefined;
				}
			},
			release: () => {
				if (released) return;
				released = true;
				leased.busy = false;
				this.#active.delete(leased);
				if (entry) entry.activeLeases--;
				if (
					retained &&
					key &&
					this.#sessions.get(key) === entry &&
					entry?.connection === leased &&
					!entry.sseOnly &&
					leased.session.reusable
				) {
					leased.timer = setTimeout(() => {
						if (this.#sessions.get(key) === entry && entry.connection === leased) {
							entry.connection = undefined;
						}
						leased.session.close();
						this.#discardUnused(key, entry!);
					}, IDLE_REUSE_MS);
					leased.timer.unref();
				} else {
					leased.session.close();
					if (key && this.#sessions.get(key) === entry && entry?.connection === leased)
						entry.connection = undefined;
				}
				if (key && entry) this.#discardUnused(key, entry);
			},
		};
	}

	releaseSession(sessionId?: string): void {
		for (const [key, entry] of this.#sessions) {
			if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
			clearTimeout(entry.connection?.timer);
			entry.connection?.session.close();
			this.#sessions.delete(key);
		}
		for (const entry of this.#active) {
			if (sessionId === undefined || entry.sessionId === sessionId) entry.session.close();
		}
	}

	close(): void {
		this.releaseSession();
	}
}
