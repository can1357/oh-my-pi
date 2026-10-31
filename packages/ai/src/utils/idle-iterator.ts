import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { EventStream, LocalWorkSource } from "./event-stream";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS = 300_000;
/** Re-mint persistent race promises every N iterations (see hoisted-racer comment). */
const RACER_REMINT_INTERVAL = 1024;

function normalizeIdleTimeoutMs(value: string | undefined, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return undefined;
	return Math.trunc(parsed);
}

/**
 * Returns the idle timeout used for provider streaming transports.
 *
 * `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` is accepted as a backward-compatible alias.
 * Set `PI_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 *
 * Providers that legitimately stream much slower than the global default can pass
 * `fallbackMs` to widen the floor used when neither env var nor caller option is set.
 * Caller options still take precedence; env overrides still trump the fallback.
 */
export function getStreamIdleTimeoutMs(fallbackMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS): number | undefined {
	return normalizeIdleTimeoutMs($env.PI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS, fallbackMs);
}

/**
 * Returns the idle timeout used for OpenAI-family streaming transports.
 *
 * `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` takes precedence over the generic
 * `PI_STREAM_IDLE_TIMEOUT_MS` because some deployments tune OpenAI-compatible
 * backends separately from Anthropic/Gemini-style transports.
 *
 * Set `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getOpenAIStreamIdleTimeoutMs(fallbackMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS): number | undefined {
	return normalizeIdleTimeoutMs($env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_STREAM_IDLE_TIMEOUT_MS, fallbackMs);
}

/**
 * Returns the timeout used while waiting for the first stream event.
 * The first token can legitimately take longer than later inter-event gaps,
 * so the default never undershoots the steady-state idle timeout.
 *
 * Set `PI_STREAM_FIRST_EVENT_TIMEOUT_MS=0` to disable the watchdog.
 *
 * Providers whose first response can legitimately take longer (heavy reasoning,
 * slow cold-start proxies) can pass `fallbackMs` to widen the floor used when
 * neither env var nor caller option is set. Caller options still take precedence;
 * env overrides still trump the fallback.
 */
export function getStreamFirstEventTimeoutMs(
	idleTimeoutMs?: number,
	fallbackMs: number = DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS,
): number | undefined {
	const fallback = idleTimeoutMs === undefined ? fallbackMs : Math.max(fallbackMs, idleTimeoutMs);
	return normalizeIdleTimeoutMs($env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS, fallback);
}

/**
 * Returns the first-event timeout used for OpenAI-family streaming transports.
 *
 * Precedence: explicit `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` (including a
 * `"0"` disable) wins outright. Otherwise the resolved idle (caller-supplied
 * `idleTimeoutMs` — which itself already encompasses per-call
 * `streamIdleTimeoutMs` or `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` resolved
 * upstream) floors the first-event budget so slow OpenAI-compatible servers
 * are not undercut by a shorter `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` or the
 * global default during prompt processing. A zero per-provider fallback
 * disables the first-event watchdog unless an environment override is set.
 *
 * Returns `0` when an explicit env knob or per-provider fallback disables the
 * watchdog, preserving the sentinel through iterator timeout resolution.
 */
export function getOpenAIStreamFirstEventTimeoutMs(
	idleTimeoutMs?: number,
	fallbackMs: number = DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS,
): number | undefined {
	const openAIFirstEventRaw = $env.PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS;
	if (openAIFirstEventRaw !== undefined) {
		return normalizeIdleTimeoutMs(openAIFirstEventRaw, fallbackMs) ?? 0;
	}
	const base = normalizeIdleTimeoutMs($env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS, fallbackMs);
	if (base === undefined || base <= 0) return 0;
	if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return base;
	return Math.max(base, idleTimeoutMs);
}

/**
 * Arms a clearable pre-response (time-to-first-byte) abort guard for a streaming
 * fetch, combined with the caller's signal.
 *
 * `AbortSignal.timeout(ms)` is an *absolute* wall-clock deadline: once handed to
 * `fetch` it keeps governing the request after the response headers arrive, so
 * it aborts an actively-streaming body the moment it fires — not just a stalled
 * pre-response request (issue #2422 regression: large `write` tool-call streams
 * died at the budget with `TimeoutError: The operation timed out.` despite
 * deltas actively flowing). This arms a `clearTimeout`-able timer instead;
 * callers MUST `clear()` as soon as the guarded transport attempt settles, so
 * the guard never aborts a body that is already streaming.
 *
 * Clearing the guard at headers does not end the first-event budget. One
 * budget covers the wait from the wire to the first stream event, and headers
 * do not renew it: the guard bounds the part before them, and whatever waits
 * for the first event after them gets only what is left, which
 * {@link PreResponseTimeout.remaining} reports. A host that holds its headers
 * while the model thinks therefore spends the same budget as one that sends
 * headers at once and then thinks. The shared stream watchdog that
 * `register-builtins` installs keeps this rule by itself, because its
 * first-item deadline runs from the wire on the same budget, so a provider
 * behind it only clears the guard. Factory's Gemini route keeps its guard
 * armed until the first chunk instead. Every other provider that owns its
 * first-event watchdog (Anthropic, OpenAI completions and responses, Azure,
 * Codex's SSE transport, Gemini CLI and pi-native) hands that watchdog the
 * remainder.
 *
 * `stream()` and `streamSimple()` are what arm that shared body watchdog,
 * through `register-builtins`; the provider modules do not arm one of their
 * own. Bedrock (`amazon-bedrock`), Google (`google`), Vertex (`google-vertex`),
 * Ollama, Cursor, Devin and Apple's on-device model rely on it for both the
 * first event and the gaps after it, and Gemini CLI relies on it for the gaps.
 * A caller that imports one of those modules through
 * `@oh-my-pi/pi-ai/providers/*` and calls its stream function directly gets
 * none of it: the module's own pre-response guard, where it has one, bounds
 * the wait for headers, and nothing bounds the stream after them. Such a
 * caller must wrap the returned stream in {@link iterateWithIdleTimeout}
 * itself, as `register-builtins` does: the first-event and idle budgets, the
 * `start` event excluded from progress, and the returned stream as
 * `localWork` so the first-event deadline runs from the wire. This is
 * deliberate. A body watchdog inside each module would stack a second one
 * under `register-builtins` on every request made the supported way.
 *
 * Retrying callers SHOULD arm a fresh guard for each transport attempt and keep
 * the retry loop's base signal reserved for caller cancellation. Reusing the
 * guard as the loop signal makes its timeout indistinguishable from
 * cancellation — and the budget it carries is the *total* one for that call:
 * see the stop-the-clock contract below.
 *
 * The budget is a stopwatch, not a deadline. {@link PreResponseGuard.suspend}
 * stops it and {@link PreResponseGuard.resume} starts it again with whatever is
 * left, so the time the transport spends preparing a request or parked on a
 * caller's dispatch hold is excluded, while the time it spends waiting for a
 * provider's first byte accumulates across every attempt the same guard covers.
 * A caller that reuses one guard across its own retries therefore keeps one
 * aggregate first-byte budget for the whole call; only a fresh guard buys a
 * fresh budget.
 *
 * `heldWork` is the stream whose own watchdog must not count the time this
 * guard excludes. While the transport has the clock stopped, the stream reports
 * local work in flight, so a stream-level first-event or idle deadline (see
 * {@link IdleTimeoutIteratorOptions.localWork}) cannot expire during a hold and
 * restarts from the moment the request reaches the wire. What it excludes is
 * the transport's own preparation and the caller's dispatch hold, never the
 * provider's latency: the window closes when the request goes out, and also
 * when the guard is cleared or its signal aborts, so a failed or cancelled
 * request cannot leave the stream reporting work forever.
 *
 * A guard armed over a signal that already carries one — a client's own
 * timeout inside a provider's, or a transport's inside a client's — passes its
 * stops and starts on to that enclosing guard. The transport only sees the
 * innermost signal, and `AbortSignal.any` hides every guard behind it, so
 * without this an outer budget would keep running through a hold the inner
 * one excludes.
 *
 * Returns the caller signal unchanged, a no-op `clear` and no remainder when
 * no positive timeout is configured.
 */
export function armPreResponseTimeout(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number | undefined,
	heldWork?: Pick<EventStream<unknown>, "trackLocalWork">,
): PreResponseTimeout {
	if (timeoutMs === undefined || timeoutMs <= 0) {
		return { signal: callerSignal, clear: () => {}, remaining: () => undefined };
	}
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	let remainingMs = timeoutMs;
	let startedAt = 0;
	let cleared = false;
	const expire = () => controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
	const arm = () => {
		startedAt = Date.now();
		timer = setTimeout(expire, remainingMs);
		timer.unref?.();
	};
	const stop = () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
		remainingMs -= Date.now() - startedAt;
	};
	arm();
	const signal: PreResponseGuardedSignal = callerSignal
		? AbortSignal.any([callerSignal, controller.signal])
		: controller.signal;
	// Settles the window `suspend` opened on `heldWork`; at most one is open.
	let settleHeld: (() => void) | undefined;
	const openHeld = () => {
		if (!heldWork || settleHeld || cleared || signal.aborted) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		settleHeld = resolve;
		void heldWork.trackLocalWork(promise);
	};
	const closeHeld = () => {
		const settle = settleHeld;
		settleHeld = undefined;
		settle?.();
	};
	const enclosing = preResponseGuard(callerSignal);
	let enclosingStopped = false;
	const stopEnclosing = () => {
		if (!enclosing || enclosingStopped || cleared || signal.aborted) return;
		enclosingStopped = true;
		enclosing.suspend();
	};
	const startEnclosing = () => {
		if (!enclosingStopped) return;
		enclosingStopped = false;
		enclosing?.resume();
	};
	if (heldWork || enclosing) {
		signal.addEventListener(
			"abort",
			() => {
				closeHeld();
				startEnclosing();
			},
			{ once: true },
		);
	}
	// The guard is armed where the request is built, but what it bounds is the
	// provider's latency. Everything between the two — a caller's dispatch hold
	// above all, which a human releases — is our own preparation: the transport
	// stops the clock while it prepares and holds, and starts it again at the
	// wire with the budget that is left.
	signal[PRE_RESPONSE_GUARD] = {
		suspend: () => {
			stop();
			openHeld();
			stopEnclosing();
		},
		resume: () => {
			closeHeld();
			startEnclosing();
			if (cleared || timer !== undefined || controller.signal.aborted) return;
			if (remainingMs <= 0) {
				expire();
				return;
			}
			arm();
		},
	};
	return {
		signal,
		clear: () => {
			cleared = true;
			stop();
			closeHeld();
			startEnclosing();
		},
		remaining: () => Math.max(1, timer === undefined ? remainingMs : remainingMs - (Date.now() - startedAt)),
	};
}

/** A pre-response budget armed by {@link armPreResponseTimeout}. */
export interface PreResponseTimeout {
	/** The caller's signal combined with the budget; the caller's own signal when no budget is armed. */
	signal: AbortSignal | undefined;
	/** Disarms the guard for good, once the attempt it covers has its headers or has failed. */
	clear: () => void;
	/**
	 * What is left of the budget for the watchdog that waits for the first
	 * event after headers; `undefined` when no budget is armed. Read it once
	 * headers arrive. That watchdog starts its own clock when the body is first
	 * read, so a caller's `onResponse` hook in between counts as our time, as a
	 * hold does. Never below 1 ms: a budget that ran out in the turn the headers
	 * arrived must still bound the first event, and 0 would read as no
	 * watchdog at all.
	 */
	remaining: () => number | undefined;
}

/** Attached by {@link armPreResponseTimeout} to the signal it hands the transport. */
const PRE_RESPONSE_GUARD = Symbol("omp.preResponseTimeout");

interface PreResponseGuard {
	/** Stop the clock: the request is still being prepared or held. */
	suspend: () => void;
	/** Start the clock again with the budget that is left: the request is going out. */
	resume: () => void;
}

type PreResponseGuardedSignal = AbortSignal & { [PRE_RESPONSE_GUARD]?: PreResponseGuard };

/**
 * The pre-response budget riding on a request's signal, if any: the transport
 * stops it while it prepares and holds the request, and starts it again — with
 * whatever is left of it — when the request reaches the wire. A signal without
 * one yields `undefined` and nothing changes.
 */
export function preResponseGuard(signal: AbortSignal | undefined | null): PreResponseGuard | undefined {
	return (signal as PreResponseGuardedSignal | undefined | null)?.[PRE_RESPONSE_GUARD];
}

export interface IdleTimeoutIteratorOptions {
	idleTimeoutMs?: number;
	firstItemTimeoutMs?: number;
	errorMessage: string;
	firstItemErrorMessage?: string;
	onIdle?: () => void;
	onFirstItemTimeout?: () => void;
	/**
	 * Optional semantic-progress predicate. Non-progress items are still yielded,
	 * but they do not reset the idle deadline. This prevents provider
	 * keepalive/no-op events from keeping a stalled tool call alive forever.
	 */
	isProgressItem?: (item: unknown) => boolean;
	/**
	 * Consumer-side local work in flight for the stream: the provider transport
	 * is waiting on a server-requested local tool bridge (e.g. the Cursor exec
	 * channel) before anything can flow upstream again. While work is pending,
	 * an expired idle / first-item deadline slides forward instead of aborting —
	 * the silence is ours, not a provider stall. The provider cannot respond
	 * before it receives the local result, so both deadlines are measured from
	 * no earlier than `localWorkSettledAt`: a tool that finishes just before the
	 * deadline gets a full budget, and a provider that stalls afterwards is
	 * still caught.
	 */
	localWork?: LocalWorkSource;
	/**
	 * Cancel iteration as soon as this signal aborts. Required for caller-driven
	 * cancellation (ESC) when the underlying transport does not surface signal
	 * aborts to the iterator (HTTP/2 proxies, native sockets, mocked fetch).
	 * Without this, the consumer sleeps on iterator.next() until the idle/first
	 * -event watchdog fires — observable as the issue #912 "Working… forever"
	 * symptom on the github-copilot provider.
	 */
	abortSignal?: AbortSignal;
}

/**
 * Yields items from an async iterable while enforcing a maximum idle gap between items.
 *
 * The first item may use a shorter timeout so stuck requests can be aborted and retried
 * before any user-visible content has streamed.
 */
export async function* iterateWithIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options: IdleTimeoutIteratorOptions,
): AsyncGenerator<T> {
	const firstItemTimeoutMs = options.firstItemTimeoutMs ?? options.idleTimeoutMs;
	let firstItemDeadlineMs =
		firstItemTimeoutMs !== undefined && firstItemTimeoutMs > 0 ? Date.now() + firstItemTimeoutMs : undefined;
	const abortSignal = options.abortSignal;
	const iterator = iterable[Symbol.asyncIterator]();
	let iteratorClosed = false;

	const closeIterator = (): void => {
		if (iteratorClosed) return;
		iteratorClosed = true;
		const returnPromise = iterator.return?.();
		if (returnPromise) {
			void returnPromise.catch(() => {});
		}
	};

	if (abortSignal?.aborted) {
		closeIterator();
		throw abortReason(abortSignal);
	}

	const withRacy = <T>(promise: Promise<T>) =>
		promise.then(
			result => ({ kind: "next" as const, result }),
			error => ({ kind: "error" as const, error }),
		);

	let awaitingFirstItem = true;
	const markFirstItemReceived = () => {
		awaitingFirstItem = false;
	};
	const isProgressItem = (item: T): boolean => {
		if (!options.isProgressItem) return true;
		try {
			return options.isProgressItem(item);
		} catch {
			return true;
		}
	};
	let lastProgressAt = Date.now();

	const hasPendingLocalWork = (): boolean => options.localWork?.hasPendingLocalWork ?? false;
	const localWorkSettledAt = (): number => options.localWork?.localWorkSettledAt ?? 0;
	// Local work means the current gap is attributable to the consumer side,
	// not the provider: slide the active deadline a full budget past now
	// instead of aborting. Completion restarts the budget via
	// `localWorkSettledAt`, so a provider that stalls afterwards is still caught.
	const extendDeadlineForLocalWork = (): void => {
		if (awaitingFirstItem) {
			if (firstItemDeadlineMs !== undefined && firstItemTimeoutMs !== undefined) {
				firstItemDeadlineMs = Date.now() + firstItemTimeoutMs;
			}
		} else {
			lastProgressAt = Date.now();
		}
	};
	// Deadlines as seen by the provider: never earlier than a full budget after
	// the last local tool result became available to send upstream.
	const firstItemDeadline = (): number | undefined => {
		if (firstItemDeadlineMs === undefined || firstItemTimeoutMs === undefined) return firstItemDeadlineMs;
		const settledAt = localWorkSettledAt();
		return settledAt > 0 ? Math.max(firstItemDeadlineMs, settledAt + firstItemTimeoutMs) : firstItemDeadlineMs;
	};

	const noTimeoutEnforced =
		(firstItemTimeoutMs === undefined || firstItemTimeoutMs <= 0) &&
		(options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0);

	// Persistent racers, hoisted out of the per-item loop. The abort promise can
	// only ever resolve once (abort latches), and a timeout resolution always
	// precedes a throw — so neither needs per-item re-creation. This keeps the
	// token hot path free of timer create/destroy and listener churn.
	//
	// Each Promise.race() call still attaches a reaction record to every pending
	// racer, and those records live until the racer settles — so a never-firing
	// abort/timeout promise would accumulate one record per streamed item for
	// the stream's whole life. The loop re-mints both promises every
	// RACER_REMINT_INTERVAL iterations to keep that retention bounded; the
	// listener and timer callbacks resolve through late-bound variables so a
	// re-mint never strands them.
	let abortPromise: Promise<{ kind: "abort" }> | undefined;
	let abortListener: (() => void) | undefined;
	let resolveAbort: ((value: { kind: "abort" }) => void) | undefined;
	if (abortSignal) {
		const { promise, resolve } = Promise.withResolvers<{ kind: "abort" }>();
		resolveAbort = resolve;
		abortListener = () => resolveAbort?.({ kind: "abort" });
		abortSignal.addEventListener("abort", abortListener, { once: true });
		abortPromise = promise;
	}

	let timeoutPromise: Promise<{ kind: "timeout" }> | undefined;
	let resolveTimeout: ((value: { kind: "timeout" }) => void) | undefined;
	let timeoutFired = false;
	let timer: NodeJS.Timeout | undefined;
	let timerFireAtMs = Infinity;

	const currentDeadlineMs = (): number | undefined => {
		if (awaitingFirstItem) return firstItemDeadline();
		if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
			return Math.max(lastProgressAt, localWorkSettledAt()) + options.idleTimeoutMs;
		}
		return undefined;
	};
	const onTimerFire = (): void => {
		timer = undefined;
		timerFireAtMs = Infinity;
		const deadlineMs = currentDeadlineMs();
		if (deadlineMs === undefined) return;
		const remainingMs = deadlineMs - Date.now();
		if (remainingMs > 0) {
			// Progress moved the deadline since this timer was armed — re-arm for
			// the remainder. One stale wake per idle period, not one per item.
			timerFireAtMs = deadlineMs;
			timer = setTimeout(onTimerFire, remainingMs);
			return;
		}
		timeoutFired = true;
		resolveTimeout?.({ kind: "timeout" });
	};
	const armTimer = (deadlineMs: number): void => {
		if (timeoutPromise === undefined || timeoutFired) {
			// A fired-but-unconsumed resolution (the item won the same race) is
			// stale — racing it again would fake a timeout, so mint a fresh one.
			const { promise, resolve } = Promise.withResolvers<{ kind: "timeout" }>();
			timeoutPromise = promise;
			resolveTimeout = resolve;
			timeoutFired = false;
		}
		if (timer !== undefined) {
			// An armed timer firing at or before the new deadline re-arms itself.
			if (timerFireAtMs <= deadlineMs) return;
			clearTimeout(timer);
		}
		timerFireAtMs = deadlineMs;
		timer = setTimeout(onTimerFire, Math.max(0, deadlineMs - Date.now()));
	};

	// The in-flight iterator.next() promise, persisted across loop iterations:
	// a deadline extension for pending local work loops without consuming it,
	// and issuing a second next() while one is outstanding would drop an item.
	let pendingNext:
		| Promise<{ kind: "next"; result: IteratorResult<T> } | { kind: "error"; error: unknown }>
		| undefined;
	try {
		let raceCount = 0;
		while (true) {
			if (++raceCount % RACER_REMINT_INTERVAL === 0) {
				if (abortPromise !== undefined && !abortSignal!.aborted) {
					const { promise, resolve } = Promise.withResolvers<{ kind: "abort" }>();
					resolveAbort = resolve;
					abortPromise = promise;
				}
				if (timeoutPromise !== undefined && !timeoutFired) {
					const { promise, resolve } = Promise.withResolvers<{ kind: "timeout" }>();
					resolveTimeout = resolve;
					timeoutPromise = promise;
				}
			}
			let activeTimeoutMs: number | undefined;
			if (awaitingFirstItem) {
				const deadlineMs = firstItemDeadline();
				if (deadlineMs !== undefined) {
					activeTimeoutMs = deadlineMs - Date.now();
					if (activeTimeoutMs <= 0) {
						if (!hasPendingLocalWork()) {
							options.onFirstItemTimeout?.();
							closeIterator();
							throw new AIError.StreamTimeoutError(options.firstItemErrorMessage ?? options.errorMessage);
						}
						extendDeadlineForLocalWork();
						activeTimeoutMs = firstItemDeadline()! - Date.now();
					}
				}
			} else if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
				activeTimeoutMs = options.idleTimeoutMs - (Date.now() - Math.max(lastProgressAt, localWorkSettledAt()));
				if (activeTimeoutMs <= 0) {
					if (!hasPendingLocalWork()) {
						options.onIdle?.();
						closeIterator();
						throw new AIError.StreamTimeoutError(options.errorMessage);
					}
					extendDeadlineForLocalWork();
					activeTimeoutMs = options.idleTimeoutMs;
				}
			}

			pendingNext ??= withRacy(iterator.next());

			const racers: Array<
				Promise<
					| { kind: "next"; result: IteratorResult<T> }
					| { kind: "error"; error: unknown }
					| { kind: "timeout" }
					| { kind: "abort" }
				>
			> = [pendingNext];

			const enforceTimeout = !noTimeoutEnforced && activeTimeoutMs !== undefined && activeTimeoutMs > 0;
			if (enforceTimeout) {
				armTimer(Date.now() + activeTimeoutMs!);
				racers.push(timeoutPromise!);
			}
			if (abortPromise) {
				racers.push(abortPromise);
			}

			// Tracks whether this iteration handed an item to the consumer and resumed
			// normally. Any other exit — internal throw, `done` return, or the consumer
			// abandoning us via `.return()`/`.throw()` at the `yield` below — must close
			// the upstream iterator so the underlying SSE body / SDK stream (and its
			// socket) is released instead of being left suspended.
			let continuing = false;
			try {
				const outcome = await Promise.race(racers);
				if (outcome.kind === "next" || outcome.kind === "error") {
					pendingNext = undefined;
				}
				if (outcome.kind === "abort") {
					closeIterator();
					throw abortReason(abortSignal!);
				}
				if (outcome.kind === "timeout") {
					if (hasPendingLocalWork()) {
						// A local tool is still running; the provider cannot make
						// progress until we hand its result back. Keep waiting.
						extendDeadlineForLocalWork();
						continuing = true;
						continue;
					}
					if (!awaitingFirstItem) {
						options.onIdle?.();
					} else {
						options.onFirstItemTimeout?.();
					}
					closeIterator();
					throw new AIError.StreamTimeoutError(
						!awaitingFirstItem ? options.errorMessage : (options.firstItemErrorMessage ?? options.errorMessage),
					);
				}
				if (outcome.kind === "error") {
					throw outcome.error;
				}
				if (outcome.result.done) {
					markFirstItemReceived();
					return;
				}
				const item = outcome.result.value;
				// Non-progress items (e.g. provider keepalives, synthetic `start` events that
				// arrive before the model has produced any tokens) MUST NOT flip us out of
				// `awaitingFirstItem`. Otherwise the next iteration switches from the (longer)
				// first-item watchdog to the (shorter) idle watchdog while we're still waiting
				// on the model's first real output.
				if (isProgressItem(item)) {
					markFirstItemReceived();
					lastProgressAt = Date.now();
				}
				yield item;
				continuing = true;
			} finally {
				if (!continuing) closeIterator();
			}
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		// Settle the persistent racers so the final Promise.race releases them.
		resolveTimeout?.({ kind: "timeout" });
		if (abortListener && abortSignal) {
			abortSignal.removeEventListener("abort", abortListener);
		}
		resolveAbort?.({ kind: "abort" });
	}
}

export interface TerminalGraceIteratorOptions {
	/**
	 * Epoch-ms timestamp at which the consumer observed a logically terminal
	 * item (e.g. a chat-completions chunk carrying `finish_reason`), or
	 * `undefined` while the stream is still mid-response. Read before every
	 * pull, so the consumer can flip it between yields.
	 */
	finishedAtMs: () => number | undefined;
	/**
	 * Post-terminal budget: how long after `finishedAtMs()` to keep draining
	 * trailing items (e.g. a usage-only chunk or the `[DONE]` sentinel) before
	 * ending the iteration cleanly. The deadline is fixed at
	 * `finishedAtMs() + graceMs`; trailing items do not extend it, so
	 * keepalive-only servers cannot hold the stream open.
	 */
	graceMs: number;
	/**
	 * Invoked when the grace window closes with the source still open. Use it
	 * to abort the underlying request: the source generator is typically parked
	 * mid-`next()` (not at a yield), so a queued `.return()` alone cannot reach
	 * the transport until that pending read settles.
	 */
	onGraceEnd?: () => void;
	/**
	 * Wait for the bounded drain when the consumer returns early. Capped
	 * requests must not release their in-flight permit while the transport
	 * still owns a live connection.
	 */
	awaitDrainOnReturn?: boolean;
}

/**
 * Yields items from an async iterable until the consumer marks the stream
 * logically finished AND the source stays silent past a short grace window.
 *
 * Misbehaving OpenAI-compatible servers deliver the terminal chunk but never
 * send `[DONE]` nor close the connection; without this guard the consumer
 * hangs on `iterator.next()` until the idle watchdog converts an
 * already-successful turn into a timeout error. Grace expiry is a clean end
 * of iteration, never an error.
 *
 * A consumer that stops early (`break`) after `finishedAtMs()` is set leaves
 * the source draining until `[DONE]`/EOF or the same grace deadline. Without
 * `awaitDrainOnReturn`, the consumer is not held up; capped requests await
 * the drain before completing and releasing their in-flight permit.
 */
export async function* iterateWithTerminalGrace<T>(
	iterable: AsyncIterable<T>,
	options: TerminalGraceIteratorOptions,
): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	// Set only while suspended at `yield`: `finally` then runs because the
	// consumer stopped early, not because the source ended or failed.
	let consumerStopped = false;
	try {
		while (true) {
			const result = await nextWithinGrace(iterator, options);
			if (result.done) return;
			consumerStopped = true;
			yield result.value;
			consumerStopped = false;
		}
	} finally {
		if (consumerStopped && options.finishedAtMs() !== undefined) {
			if (options.awaitDrainOnReturn) await drainWithinGrace(iterator, options);
			else void drainWithinGrace(iterator, options);
		} else {
			releaseIterator(iterator);
		}
	}
}

const GRACE_ENDED: IteratorReturnResult<undefined> = { done: true, value: undefined };

/**
 * Pulls the next item, ending with `done` (after `onGraceEnd`) once the
 * post-terminal grace deadline passes. Unbounded while `finishedAtMs()` is unset.
 */
async function nextWithinGrace<T>(
	iterator: AsyncIterator<T>,
	options: TerminalGraceIteratorOptions,
): Promise<IteratorResult<T, unknown>> {
	const finishedAtMs = options.finishedAtMs();
	if (finishedAtMs === undefined) return iterator.next();
	const remainingMs = finishedAtMs + options.graceMs - Date.now();
	if (remainingMs <= 0) {
		options.onGraceEnd?.();
		return GRACE_ENDED;
	}
	const nextPromise = iterator.next();
	const timeout = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
	try {
		const outcome = await Promise.race([nextPromise, timeout.promise]);
		if (outcome !== "timeout") return outcome;
		// The abandoned read settles (likely rejects) once onGraceEnd aborts
		// the transport — mark it handled so it cannot surface as an
		// unhandled rejection.
		nextPromise.catch(() => {});
		options.onGraceEnd?.();
		return GRACE_ENDED;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Discards the source's trailing items until it ends or the grace window
 * closes, then releases it. Failures are swallowed: the consumer already
 * accepted the response.
 */
async function drainWithinGrace<T>(iterator: AsyncIterator<T>, options: TerminalGraceIteratorOptions): Promise<void> {
	try {
		while (!(await nextWithinGrace(iterator, options)).done) {}
	} catch {
		// Transport errors after the consumer finished cannot change its result.
	} finally {
		releaseIterator(iterator);
	}
}

function releaseIterator<T>(iterator: AsyncIterator<T>): void {
	const returnPromise = iterator.return?.();
	if (returnPromise) {
		void Promise.resolve(returnPromise).catch(() => {});
	}
}

function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new AIError.AbortError(reason);
	return new AIError.AbortError();
}
