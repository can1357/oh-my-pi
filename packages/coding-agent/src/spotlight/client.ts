import { decodeJwtPayload } from "@oh-my-pi/pi-ai/registry/engine/common";
import { getRetryAfterMsFromHeaders } from "@oh-my-pi/pi-ai/utils/retry-after";
import { logger, USER_AGENT } from "@oh-my-pi/pi-utils";
import { StencilCredential } from "../stencil/credential";
import { DEFAULT_SPOTLIGHT_MODEL, DEFAULT_SPOTLIGHT_URL, type SpotlightThinking } from "./types";

/** How long a warm-up request may take. */
const WARM_TIMEOUT_MS = 120_000;
/** How long a `waitlisted`/`forbidden` answer stands before the same account asks again. */
export const DENIED_BACKOFF_MS = 6 * 60 * 60_000;
/** Pause after a 429 or 503 that names no usable `Retry-After`. */
const BUSY_BACKOFF_MS = 60_000;

/** An answer that stands until `until`: requests in between fail with it instead of being sent. */
interface Pause {
	until: number;
	message: string;
	status: number;
	code: string | null;
}

/**
 * Process-wide pauses, shared by every client (each session and subagent makes its own). A denial is keyed by
 * endpoint and account, so signing in to another account asks again at once; a 429/503 pause by endpoint alone.
 */
const pauses = new Map<string, Pause>();
/** Denials (endpoint and account) the user was already told about, so each is shown once per process. */
const deniedNoticed = new Set<string>();

/** The account a credential belongs to: a login token's `sub`, stable across refreshes, else the key itself. */
function accountOf(token: string): string {
	const sub = decodeJwtPayload(token)?.sub;
	return typeof sub === "string" && sub ? sub : token;
}

function deniedKey(url: string, token: string): string {
	return `${url}\n${accountOf(token)}`;
}

/** Spotlight's `state`: the conversation context sent with the output. */
export interface SpotlightState {
	/** The user turn. */
	task?: string;
	/** Earlier bash calls, shown with their output omitted. */
	commands?: string[];
	/** What the current assistant turn says before its call. */
	said?: string;
	/** The current turn's reasoning; also fills `{intent}` in probes. */
	intent?: string;
}

/** One ranking request: every question reads the same items after the same state. */
export interface SpotlightRequest {
	state: SpotlightState;
	/** The command whose output the items are. */
	source: string;
	/** Output items, one or more lines each; at most 32,768 prompt tokens per question. */
	items: readonly string[];
	/** Question id → probe Spotlight scores each item's relevance under (1–32 questions). */
	questions: Readonly<Record<string, string>>;
	thinking?: SpotlightThinking;
}

/** Per-question item scores in [0, 1] (comparable within one request only), and what the request cost. */
export interface SpotlightReply {
	scores: Record<string, number[]>;
	inputTokens: number;
	/** `Stencil-Cost-Usd`: the charged list price (exempt accounts see the would-be price). */
	costUsd: number;
	ms: number;
	requestId: string | null;
}

/** A failed ranking: no credential, transport failure, timeout, or a non-200 answer. */
export class SpotlightError extends Error {
	constructor(
		message: string,
		/** HTTP status, or 0 when the request never got an answer. */
		readonly status: number,
		/** The error code the service sent, if any. */
		readonly code: string | null,
	) {
		super(message);
		this.name = "SpotlightError";
	}
}

export interface SpotlightClientOptions {
	url?: string;
	model?: string;
	/** Budget of one {@link SpotlightClient.rank} call. */
	timeoutMs: number;
	credential?: StencilCredential;
	/** Whether this request is permitted by the active session's auxiliary-model policy. */
	allowRequest?: () => boolean;
	fetch?: typeof fetch;
}

/**
 * `POST /v1/spotlight` with the session's Stencil credential (`STENCIL_API_KEY`, else the stencil.so login, the
 * token `omp token stencil` prints). No retries: callers are inside a tool call and fall back to a rule instead.
 */
export class SpotlightClient {
	readonly url: string;
	readonly model: string;
	#timeoutMs: number;
	#credential: StencilCredential;
	/** The credential was created here, so close() releases its auth store; an injected one stays the caller's. */
	#ownsCredential: boolean;
	#fetch: typeof fetch;
	#allowRequest: () => boolean;
	#warming?: Promise<void>;
	/** The last ranking found no credential; cleared once one resolves, so a later loss is reported again. */
	#credentialMissing = false;
	/**
	 * Called when a ranking finds no Stencil credential, once per loss: the first such ranking, then again only
	 * after a credential resolved in between.
	 */
	onCredentialMissing?: () => void;
	/**
	 * Called with Cloud's message when the account has no Spotlight access (403 `waitlisted`/`forbidden`), once per
	 * process and account across every client: the first client with this set that meets the denial reports it.
	 */
	onAccessDenied?: (message: string) => void;

	constructor(options: SpotlightClientOptions) {
		this.url = options.url || DEFAULT_SPOTLIGHT_URL;
		this.model = options.model || DEFAULT_SPOTLIGHT_MODEL;
		this.#timeoutMs = options.timeoutMs;
		this.#credential = options.credential ?? new StencilCredential();
		this.#ownsCredential = options.credential === undefined;
		this.#fetch = options.fetch ?? fetch;
		this.#allowRequest = options.allowRequest ?? (() => true);
	}

	/**
	 * Ranks `request.items` for every question.
	 *
	 * @throws {SpotlightError} without a Stencil credential (status 0, code `no_credential`), on a transport failure
	 * or timeout (status 0), for any non-200 answer (its status and Cloud's error code), and for a reply that does not
	 * score every item of every question (status 200, code `bad_reply`). After a 403 `waitlisted`/`forbidden` (for
	 * {@link DENIED_BACKOFF_MS}, per account) or a 429/503 (for its `Retry-After`), it rethrows that answer without
	 * sending anything.
	 */
	async rank(request: SpotlightRequest, signal?: AbortSignal, timeoutMs = this.#timeoutMs): Promise<SpotlightReply> {
		if (!this.#allowRequest()) throw new SpotlightError("spotlight: disabled by model policy", 0, "policy");
		const token = await this.#credential.resolve();
		if (!token) {
			if (!this.#credentialMissing) {
				this.#credentialMissing = true;
				logger.warn("spotlight: no Stencil credential; shaping falls back to unranked rules until sign-in");
				this.onCredentialMissing?.();
			}
			throw new SpotlightError(StencilCredential.missingMessage, 0, "no_credential");
		}
		this.#credentialMissing = false;
		const pause = this.#activePause(token);
		if (pause) throw new SpotlightError(pause.message, pause.status, pause.code);
		return this.#post(token, request, signal, timeoutMs);
	}

	/**
	 * The pause this client's next request to `token`'s account falls in, if any; a denial in force is reported
	 * here too, for a client that did not meet it itself.
	 */
	#activePause(token: string): Pause | undefined {
		const now = Date.now();
		const key = deniedKey(this.url, token);
		const denied = pauses.get(key);
		if (denied && denied.until > now) {
			this.#reportDenied(key, denied.message);
			return denied;
		}
		const busy = pauses.get(this.url);
		return busy && busy.until > now ? busy : undefined;
	}

	#reportDenied(key: string, message: string): void {
		if (!this.onAccessDenied || deniedNoticed.has(key)) return;
		deniedNoticed.add(key);
		this.onAccessDenied(message);
	}

	/** Holds a refusal that asking again would not change: no access (hours, per account), or 429/503 (Retry-After). */
	#pauseAfter(token: string, response: Response, message: string, code: string | null): void {
		const status = response.status;
		const pause = { message: `spotlight HTTP ${status}: ${message}`, status, code };
		// Cloud's 403 codes for an account (or a key's workspace) without Stencil Cloud access.
		if (status === 403 && (code === "waitlisted" || code === "forbidden")) {
			const key = deniedKey(this.url, token);
			pauses.set(key, { ...pause, until: Date.now() + DENIED_BACKOFF_MS });
			logger.warn("spotlight: account has no Stencil Cloud access; not asking again for hours", { code });
			this.#reportDenied(key, message);
			return;
		}
		if (status !== 429 && status !== 503) return;
		const wait = Math.min(getRetryAfterMsFromHeaders(response.headers) ?? BUSY_BACKOFF_MS, DENIED_BACKOFF_MS);
		pauses.set(this.url, { ...pause, until: Date.now() + wait });
	}

	async #post(
		token: string,
		request: SpotlightRequest,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<SpotlightReply> {
		if (!this.#allowRequest()) throw new SpotlightError("spotlight: disabled by model policy", 0, "policy");
		const questions: Record<string, { probe: string }> = {};
		for (const id in request.questions) questions[id] = { probe: request.questions[id] };
		const body = JSON.stringify({
			model: this.model,
			state: request.state,
			source: request.source,
			items: request.items,
			questions,
			thinking: request.thinking ?? "low",
		});
		const deadline = AbortSignal.timeout(timeoutMs);
		const started = performance.now();
		let response: Response;
		try {
			response = await this.#fetch(this.url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"user-agent": USER_AGENT,
				},
				body,
				signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
			});
		} catch (error) {
			const timedOut = deadline.aborted && !signal?.aborted;
			throw new SpotlightError(
				timedOut ? `spotlight: no answer within ${timeoutMs} ms` : `spotlight: ${String(error)}`,
				0,
				timedOut ? "timeout" : "transport",
			);
		}
		const text = await response.text();
		const ms = Math.round(performance.now() - started);
		if (response.status !== 200) {
			let code: string | null = null;
			let message = text.slice(0, 300);
			try {
				const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
				if (typeof parsed.error === "string") code = parsed.error;
				if (typeof parsed.message === "string") message = parsed.message;
			} catch {
				// A non-JSON body (proxy page) keeps its first characters as the message.
			}
			this.#pauseAfter(token, response, message, code);
			throw new SpotlightError(`spotlight HTTP ${response.status}: ${message}`, response.status, code);
		}
		// The account has access (again): a later loss of it is reported anew.
		deniedNoticed.delete(deniedKey(this.url, token));
		const reply = parseReply(text, Object.keys(request.questions), request.items.length);
		return {
			...reply,
			costUsd: Number(response.headers.get("stencil-cost-usd") ?? 0) || 0,
			ms,
			requestId: response.headers.get("x-request-id"),
		};
	}

	/**
	 * Releases the auth store the client's own credential opened: its broker snapshot stream otherwise keeps a
	 * one-shot process such as `omp find` alive until the store idles out (20 s). The client must not be used after.
	 */
	close(): void {
		if (this.#ownsCredential) this.#credential.close();
	}

	/**
	 * Wakes the endpoint in the background so the session's first real ranking doesn't pay the cold start; at most
	 * one warm-up in flight per client (a later call, e.g. after a timed-out ranking, wakes it again), failures
	 * logged only. A missing credential is left for the first real ranking to report.
	 */
	warm(): void {
		if (this.#warming || !this.#allowRequest()) return;
		this.#warming = this.#credential
			.resolve()
			.then(async token => {
				if (!token) {
					logger.debug("spotlight warm skipped: no credential");
					return;
				}
				if (this.#activePause(token)) {
					logger.debug("spotlight warm skipped: paused after a refusal");
					return;
				}
				const reply = await this.#post(
					token,
					{
						state: { task: "warm-up" },
						source: "true",
						items: ["ok"],
						questions: { q: "The most important line in this output is: `" },
					},
					undefined,
					WARM_TIMEOUT_MS,
				);
				logger.debug("spotlight warm", { ms: reply.ms });
			})
			.catch(error => logger.debug("spotlight warm failed", { error: String(error) }));
		void this.#warming.finally(() => {
			this.#warming = undefined;
		});
	}
}

/** The reply's scores, checked to cover every item of every question. */
function parseReply(text: string, questions: string[], items: number): Pick<SpotlightReply, "scores" | "inputTokens"> {
	let parsed: { answers?: Record<string, { scores?: unknown }>; usage?: { input_tokens?: unknown } };
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new SpotlightError("spotlight: reply is not JSON", 200, "bad_reply");
	}
	const scores: Record<string, number[]> = {};
	for (const id of questions) {
		const values = parsed.answers?.[id]?.scores;
		if (!Array.isArray(values) || values.length !== items || !values.every(v => typeof v === "number")) {
			throw new SpotlightError(`spotlight: question ${id} did not score all ${items} items`, 200, "bad_reply");
		}
		scores[id] = values;
	}
	const tokens = parsed.usage?.input_tokens;
	return { scores, inputTokens: typeof tokens === "number" ? tokens : 0 };
}
