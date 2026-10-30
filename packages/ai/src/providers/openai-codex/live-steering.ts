/**
 * Mid-turn steering over the Codex Responses WebSocket (`response.steer`).
 *
 * While a response streams, {@link CodexSteerPump} pulls user input from the
 * caller's {@link LiveSteering} source and submits it to that response. Accepted
 * input belongs to the server from then on: it either continues automatically in
 * a successor response (nothing client-owned is pending) or is prepended to the
 * next explicit `response.create` that returns the pending tool output.
 * {@link planSteeredRequest} maps the caller's next request onto whichever of
 * the two the server will do.
 *
 * Steering is new input, so each submission passes the request's dispatch hold
 * (`StreamOptions.beforeDispatch`) like a request does: a steer the server
 * accepts can start a successor response on its own. Reading a successor the
 * server already started sends nothing and is not held.
 *
 * @example
 * ```ts ignore
 * const pump = new CodexSteerPump(options.liveSteering, connection, toSteerInput, {
 * 	hold: options.beforeDispatch,
 * 	signal: requestSignal,
 * });
 * pump.start(responseId); // on `response.created`
 * const { accepted } = await pump.finish(); // after the terminal event
 * ```
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { DispatchHold, LiveSteering, UserMessage } from "../../types";
import { dispatchWhenOpen } from "../../utils/dispatch-hold";
import type { InputItem } from "./request-transformer";

/** The request a pump steers on behalf of, as its submissions see it. */
export interface CodexSteerDispatch {
	/** The request's `StreamOptions.beforeDispatch`, awaited before each submission. */
	hold?: DispatchHold;
	/** The request's signal: cancelling it stops the pump, a held submission included. */
	signal?: AbortSignal;
}

/** Server acknowledgement of one `response.steer` submission. */
export type CodexSteerAck = { accepted: true; id: string } | { accepted: false; code?: string; message?: string };

/** Socket surface the pump submits through. */
export interface CodexSteerSocket {
	/**
	 * Sends `response.steer` at once; resolves on the matching acknowledgement,
	 * rejects when the socket closes first. The pump calls it in the same
	 * synchronous step as the dispatch hold's last check, so it must reach the
	 * socket send without awaiting or calling caller code.
	 */
	steer(previousResponseId: string, input: InputItem[]): Promise<CodexSteerAck>;
}

/** Steering the server accepted, with the exact input items it queued. */
export interface CodexAcceptedSteer {
	id: string;
	items: InputItem[];
}

/** What a finished pump delivered into its response. */
export interface CodexSteerOutcome {
	responseId: string | undefined;
	accepted: CodexAcceptedSteer[];
	/** A steer was submitted, whether or not the server accepted it. */
	submitted: boolean;
	/**
	 * A submission ended without an acknowledgement, so the server may or may
	 * not hold it. The caller must drop the socket rather than chain from it.
	 */
	uncertain: boolean;
}

/** How long to wait for `response.steer.accepted`/`failed` before treating the outcome as unknown. */
const STEER_ACK_TIMEOUT_MS = 10_000;
/** Back-off when the source woke but had nothing deliverable (e.g. input still being prepared). */
const EMPTY_CLAIM_BACKOFF_MS = 25;

/**
 * Submits caller steering to one in-flight response. Stops after the first
 * rejection: the server only rejects when the response no longer accepts input,
 * and later submissions would reorder the caller's input.
 */
export class CodexSteerPump {
	readonly #source: LiveSteering;
	readonly #socket: CodexSteerSocket;
	readonly #toInput: (messages: readonly UserMessage[]) => InputItem[] | undefined;
	readonly #stop = new AbortController();
	readonly #dispatch: CodexSteerDispatch;
	readonly #accepted: CodexAcceptedSteer[] = [];
	#responseId: string | undefined;
	#run: Promise<void> | undefined;
	#uncertain = false;
	#submitted = false;

	constructor(
		source: LiveSteering,
		socket: CodexSteerSocket,
		toInput: (messages: readonly UserMessage[]) => InputItem[] | undefined,
		dispatch: CodexSteerDispatch = {},
	) {
		this.#source = source;
		this.#socket = socket;
		this.#toInput = toInput;
		this.#dispatch = dispatch;
	}

	/** The response this pump steers, once started. */
	get responseId(): string | undefined {
		return this.#responseId;
	}

	/** Starts submitting steering to `responseId`; later calls are ignored. */
	start(responseId: string): void {
		if (this.#run || this.#stop.signal.aborted) return;
		this.#responseId = responseId;
		this.#run = this.#loop(responseId);
	}

	/** Stops claiming input, settles the submission in flight, and reports what the server accepted. */
	async finish(): Promise<CodexSteerOutcome> {
		this.#stop.abort();
		await this.#run;
		return {
			responseId: this.#responseId,
			accepted: this.#accepted,
			submitted: this.#submitted,
			uncertain: this.#uncertain,
		};
	}

	async #loop(responseId: string): Promise<void> {
		const requestSignal = this.#dispatch.signal;
		const signal = requestSignal ? AbortSignal.any([this.#stop.signal, requestSignal]) : this.#stop.signal;
		try {
			while (!signal.aborted) {
				await this.#source.wait(signal);
				if (signal.aborted) return;
				// Held before the claim, the input stays queued with the caller for
				// as long as a pause lasts; a response that ends meanwhile leaves it
				// there for the caller's next request.
				if (!(await this.#whenOpen(responseId, signal, () => {}))) return;
				const claimedAt = performance.now();
				const claim = await this.#source.claim(signal);
				if (!claim) {
					await Bun.sleep(EMPTY_CLAIM_BACKOFF_MS);
					continue;
				}
				// The response ended while the input was being prepared: the caller
				// delivers it with its next request instead.
				const input = signal.aborted ? undefined : this.#toInput(claim.messages);
				if (!input) {
					claim.reject();
					return;
				}
				const preparedAt = performance.now();
				// The claim awaited the caller's own preparation, which a pause can
				// outlast. The frame goes out in the same synchronous step as the
				// hold's last check, so a pause landing after the hold answered
				// still stops it. A steer the hold stops was never submitted; one
				// handed to the socket was, acknowledged or not.
				let sentAt = 0;
				const submitted = await this.#whenOpen(responseId, signal, () => {
					sentAt = performance.now();
					this.#submitted = true;
					return this.#submit(responseId, input);
				});
				if (!submitted) {
					claim.reject();
					return;
				}
				const ack = submitted.value;
				if (!ack) {
					this.#uncertain = true;
					claim.reject();
					return;
				}
				if (!ack.accepted) {
					logger.debug("Codex steering rejected", { responseId, code: ack.code, message: ack.message });
					claim.reject();
					return;
				}
				this.#accepted.push({ id: ack.id, items: input });
				claim.accept();
				logger.debug("Codex steering accepted", {
					responseId,
					steerId: ack.id,
					prepareMs: Math.round(preparedAt - claimedAt),
					ackMs: Math.round(performance.now() - sentAt),
				});
			}
		} catch (error) {
			logger.warn("Codex steering pump failed", {
				responseId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Await the request's dispatch hold, then call `send` in the same
	 * synchronous step as the hold's last check ({@link dispatchWhenOpen}), and
	 * return what it returned. Undefined when the pump stops instead: the
	 * response ended or the request was cancelled while held, or the hold
	 * failed, which fails the submission like any other dispatch error. `send`
	 * must not throw, or its failure would read as the hold's.
	 */
	async #whenOpen<T>(
		responseId: string,
		signal: AbortSignal,
		send: () => T,
	): Promise<{ value: Awaited<T> } | undefined> {
		try {
			return { value: await dispatchWhenOpen(this.#dispatch.hold, signal, send) };
		} catch (error) {
			if (!signal.aborted) {
				logger.debug("Codex steering hold failed", {
					responseId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return undefined;
		}
	}

	/**
	 * Send `response.steer` now and wait for its acknowledgement; undefined when
	 * none arrives, so the server may or may not hold the input. The frame goes
	 * out before the first await, and the acknowledgement clock starts with it.
	 */
	async #submit(responseId: string, input: InputItem[]): Promise<CodexSteerAck | undefined> {
		try {
			return await withTimeout(this.#socket.steer(responseId, input), STEER_ACK_TIMEOUT_MS);
		} catch (error) {
			logger.debug("Codex steering acknowledgement missing", {
				responseId,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	const { promise: timeout, resolve } = Promise.withResolvers<undefined>();
	const timer = setTimeout(() => resolve(undefined), timeoutMs);
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Converted steering input, or `undefined` when an item is not a plain user
 * message (the only shape `response.steer` accepts).
 */
export function toSteerInputItems(items: readonly InputItem[]): InputItem[] | undefined {
	if (items.length === 0) return undefined;
	for (const item of items) {
		if (item.role !== "user" || (item.type != null && item.type !== "message")) return undefined;
	}
	return [...items];
}

/** How the request after a steered response continues on the server. */
export type CodexSteerPlan =
	/** The server continues on its own: read its successor, send nothing. */
	| { kind: "attach" }
	/** The server awaits tool output: send only `input`; it prepends the accepted steering itself. */
	| { kind: "create"; input: InputItem[] }
	/** The request cannot line up with the server's queue: drop the socket and replay in full. */
	| { kind: "discard" };

/**
 * Line the next request up with steering the server accepted for the previous
 * response.
 *
 * `delta` is the chained input (new items after the previous response), or
 * `undefined` when the chain broke. The accepted steering must appear in it, in
 * order; what remains decides the plan: nothing means the server's automatic
 * successor is exactly this request, tool output means the server is waiting
 * for it, anything else runs concurrently with a successor and cannot be sent.
 */
export function planSteeredRequest(
	delta: readonly InputItem[] | undefined,
	steering: readonly InputItem[],
): CodexSteerPlan {
	if (!delta) return { kind: "discard" };
	const rest: InputItem[] = [];
	let next = 0;
	for (const item of delta) {
		if (next < steering.length && steerItemKey(item) === steerItemKey(steering[next]!)) {
			next++;
			continue;
		}
		rest.push(item);
	}
	if (next < steering.length) return { kind: "discard" };
	if (rest.length === 0) return { kind: "attach" };
	// Client-owned results (`*_output`) mean the server is waiting for them.
	if (rest.some(item => typeof item.type === "string" && item.type.endsWith("_output"))) {
		return { kind: "create", input: rest };
	}
	return { kind: "discard" };
}

/**
 * Identity of a user message item across the steer submission and the replayed
 * request: role plus content, ignoring the transport-only image `detail` hint
 * that Responses Lite strips from request bodies.
 */
function steerItemKey(item: InputItem): string {
	if (item.role !== "user") return `\0${item.type ?? ""}:${item.call_id ?? item.id ?? ""}`;
	const content =
		typeof item.content === "string"
			? [{ type: "input_text", text: item.content }]
			: Array.isArray(item.content)
				? item.content.map(part => {
						if (!part || typeof part !== "object") return part;
						const { detail: _detail, ...rest } = part as Record<string, unknown>;
						return rest;
					})
				: item.content;
	return JSON.stringify(content);
}
