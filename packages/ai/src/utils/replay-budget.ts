import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { findRetryRefusal, longestRetryHint, RetryRefusedError } from "@oh-my-pi/pi-utils";
import type { AssistantMessage } from "../types";
import { getHeadersFromError } from "./retry-after";
import { type RetryWaitHook, waitForRetry } from "./retry-wait";

/**
 * A replay admitted by a {@link ReplayBudget} whose own request has not yet
 * been sent. `refused` is set when the deadline refused it first.
 */
export interface ReplayArm {
	readonly replaced: unknown;
	refused: boolean;
}

/**
 * The budget an options bag carries down to the provider call and every call
 * nested in it (the replay-safe wrapper's attempts, an auth retry, a delegated
 * provider). A symbol, so object spreads carry it and serialized options drop it.
 */
const REPLAY_BUDGET = Symbol("omp.replayBudget");

interface ReplayBudgetCarrier {
	readonly [REPLAY_BUDGET]?: ReplayBudget;
	readonly replayBudgetMs?: number;
}

/**
 * One streaming call's {@link StreamOptions.replayBudgetMs}, measured on the
 * monotonic clock from the start of the call: every public entry point
 * establishes it before any awaited work, so no dependency can delay its start.
 *
 * A replay goes through three steps, each of which can refuse it:
 * 1. a rung decides to replay and asks {@link admits} with the wait ahead of
 *    it — the server's longest named wait included ({@link delayFor});
 * 2. the wait itself runs through {@link wait}, raced against the deadline and
 *    the caller's signal;
 * 3. the replay's own request is checked at the moment it is handed to the
 *    transport.
 *
 * An admission arms the replay, and the arm stays held until a send takes it.
 * While a replay is being prepared its arm is pending: arming it again (the
 * rung's decision, then the send path that names the failure once more)
 * renames that one pending arm. A send takes the pending arm and holds it under
 * its own identity: the provider's send gate ({@link gateFetch}) takes it when
 * its call begins and releases exactly that arm when the call settles, and an
 * explicit transport site (the HTTP/2 stream open, the WebSocket frame write)
 * takes and releases it in one step with {@link handoff}. So a replay armed
 * after a send began is never released by that send, and an arm a send already
 * holds cannot be displaced by a newer one.
 *
 * Which request carries the replay is held by convention, not by construction:
 * the gate gives the pending arm to the first request that goes through it. The
 * convention is that a gated fetch carries only the provider's own request (every
 * install point of {@link gateFetch} and {@link gateOptionalFetch} wraps the
 * inference fetch alone), and that every other request on the replay's way —
 * a token exchange, a credential probe, a library wrapper's inner fetch, the
 * innermost transport fetch — goes through a {@link checkpoint}, which checks
 * the deadline and takes nothing. A caller who sends another request through
 * a gated fetch lets that request take the arm, and the replay's own request
 * then passes unchecked.
 *
 * While any arm is pending or held, every checkpoint is checked against the
 * deadline and none of them takes or releases an arm. So a token fetch or a
 * library wrapper that runs between the decision and the send neither spends
 * the replay's check nor stands in for it: the gated request is still checked.
 *
 * A refusal throws a `RetryRefusedError` carrying the failure the replay would
 * have replaced ({@link arm}); the layer that admitted the replay answers with
 * that failure ({@link restoreReplaced}). A refused arm is not released by the
 * check that refused it: a wrapper that catches the refusal and checks again
 * is refused again, and a refused pending arm refuses the replay's own send
 * when that send takes it. What the transport does with a request after the
 * handoff — a caller-supplied `fetch` that queues it, a socket that buffers it
 * — is outside the budget's reach.
 *
 * Requests made while no replay is armed — the call's first attempt, and
 * requests a replay makes after its own request was sent (a streaming append,
 * a diagnostic lookup) — are not checked. A refusal latches for the rest of the
 * call.
 */
export class ReplayBudget {
	readonly #deadline: number;
	readonly #gated = new WeakSet<FetchImpl>();
	#refused = false;
	/** The replay being prepared: armed, and taken by no send yet. */
	#pending: ReplayArm | undefined;
	/** Arms a send has taken, each released when that send settles. */
	readonly #held = new Set<ReplayArm>();
	#refusedReplaced: unknown;

	constructor(budgetMs: number) {
		this.#deadline = performance.now() + budgetMs;
	}

	/**
	 * The budget for `budgetMs`, or `undefined` when it is unset or infinite —
	 * which keeps the provider's own ceiling, with no budget consulted at all.
	 * Negative and `NaN` values refuse every replay.
	 */
	static from(budgetMs: number | undefined): ReplayBudget | undefined {
		if (budgetMs === undefined || budgetMs === Number.POSITIVE_INFINITY) return undefined;
		return new ReplayBudget(budgetMs > 0 ? budgetMs : 0);
	}

	/**
	 * The budget governing a call made with `options`: the one the options
	 * carry ({@link share}, {@link withReplayBudget}), otherwise a new one from
	 * `replayBudgetMs`.
	 */
	static forCall(options: object | undefined): ReplayBudget | undefined {
		const carrier = options as ReplayBudgetCarrier | undefined;
		return carrier?.[REPLAY_BUDGET] ?? ReplayBudget.from(carrier?.replayBudgetMs);
	}

	/** A copy of `options` whose call, and every call nested in it, spends this budget. */
	share<O extends object>(options: O): O {
		return { ...options, [REPLAY_BUDGET]: this };
	}

	/**
	 * Whether a replay that starts after waiting `delayMs` begins inside the
	 * budget. An admission arms the replay, so its request is checked again
	 * when it is sent. A refusal latches: every later replay in the call is
	 * refused too. Bound, so it can be handed to `fetchWithRetry` as its
	 * `retryGate`.
	 */
	readonly admits = (delayMs: number): boolean => {
		if (!this.allowsWait(delayMs)) return false;
		this.#pending ??= { replaced: undefined, refused: false };
		return true;
	};

	/**
	 * Whether a wait of `delayMs` that starts now ends inside the budget, for
	 * work that sleeps on the way to a replay without being the replay (a
	 * credential rotation waiting out a sibling's block). A refusal latches like
	 * {@link admits}; nothing is armed. Bound, so it can be handed down as a
	 * callback.
	 */
	readonly allowsWait = (delayMs: number): boolean => {
		if (!this.#refused && performance.now() + delayMs < this.#deadline) return true;
		this.#refused = true;
		return false;
	};

	/**
	 * `work`'s result, unless the deadline passes first: then `undefined`, and
	 * the refusal latches. For preparation a replay waits on whose duration the
	 * budget cannot see in advance (a caller's credential resolver). `work`
	 * keeps running when the race is lost; its result is no longer watched. A
	 * budget already spent answers `undefined` at once.
	 */
	async race<T>(work: Promise<T>): Promise<{ value: T } | undefined> {
		// Work the race no longer watches must not surface as an unhandled rejection.
		work.catch(() => {});
		const remainingMs = this.#deadline - performance.now();
		if (this.#refused || remainingMs <= 0) {
			this.#refused = true;
			return undefined;
		}
		const deadline = Promise.withResolvers<undefined>();
		const timer = setTimeout(() => deadline.resolve(undefined), remainingMs);
		try {
			const result = await Promise.race([work.then(value => ({ value })), deadline.promise]);
			if (result === undefined) this.#refused = true;
			return result;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Names the failure the replay being prepared replaces: this becomes the
	 * pending arm, in place of any earlier pending arm. An arm a send has
	 * already taken is not affected. A refusal before the replay's request is
	 * sent throws a `RetryRefusedError` carrying `replaced`.
	 */
	arm(replaced: unknown): ReplayArm {
		const arm: ReplayArm = { replaced, refused: false };
		this.#pending = arm;
		return arm;
	}

	/** Drops `arm` when it is still the pending arm, the one no send has taken. */
	disarm(arm: ReplayArm): void {
		if (this.#pending === arm) this.#pending = undefined;
	}

	/**
	 * Checks every pending or held arm against the deadline without taking or
	 * releasing any. For a request that may not be the replay's own (a token
	 * fetch, an inner library wrapper, the innermost transport fetch) and before
	 * opening a connection: refused, it throws; passed, the replay's own send is
	 * still checked later.
	 */
	readonly checkpoint = (): void => {
		this.#check();
	};

	/**
	 * Called by an explicit transport site immediately before it sends the
	 * replay's own request (an HTTP/2 stream open, a WebSocket frame): takes the
	 * pending arm, checks it, and releases it, so the attempt's later requests
	 * pass. Refused, it throws and the arm is spent with the refused request.
	 */
	readonly handoff = (): void => {
		const own = this.#take();
		try {
			this.#check();
		} finally {
			if (own) this.#held.delete(own);
		}
	};

	/** The pending arm, now held by the send that takes it; `undefined` when none is pending. */
	#take(): ReplayArm | undefined {
		const arm = this.#pending;
		if (arm === undefined) return undefined;
		this.#pending = undefined;
		this.#held.add(arm);
		return arm;
	}

	/**
	 * Refuses when an arm is pending or held and the deadline has passed (or a
	 * replay was already refused). Every pending and held arm is marked refused
	 * and none is released: a refused pending arm refuses every later check
	 * until the send that carries its replay takes it, and that send is refused
	 * too. The refusal names the failure the pending arm replaces, or else the
	 * newest held arm's — the arm the checking send just took, when it took one.
	 */
	#check(): void {
		const pending = this.#pending;
		if (pending === undefined && this.#held.size === 0) return;
		if (!this.#refused && performance.now() < this.#deadline) return;
		this.#refused = true;
		if (pending) pending.refused = true;
		let newest: ReplayArm | undefined;
		for (const arm of this.#held) {
			arm.refused = true;
			newest = arm;
		}
		const replaced = (pending ?? newest)?.replaced;
		if (this.#refusedReplaced === undefined) this.#refusedReplaced = replaced;
		throw new RetryRefusedError(replaced);
	}

	/**
	 * The failure the first refused replay would have replaced, when it named
	 * one. A layer that turned the refusal into another error (a credential
	 * probe that read it as "no credentials") still answers with this
	 * ({@link restoreReplaced}).
	 */
	get refusedReplaced(): unknown {
		return this.#refusedReplaced;
	}

	/**
	 * The provider's send gate around `base`, the fetch its own request goes
	 * through. Each call takes the pending arm — the replay its request carries
	 * — and is checked like a {@link checkpoint}; the arm stays held while the
	 * call runs, so a check inside it (an inner wrapper's, the transport's)
	 * still sees it. When the call settles, that arm, and only that arm, is
	 * released. A fetch this budget already gates is returned as it is.
	 */
	gateFetch(base: FetchImpl): FetchImpl {
		if (this.#gated.has(base)) return base;
		const gated: FetchImpl = async (input, init) => {
			const own = this.#take();
			try {
				this.#check();
				return await base(input, init);
			} finally {
				if (own) this.#held.delete(own);
			}
		};
		if (base.preconnect) gated.preconnect = base.preconnect;
		this.#gated.add(gated);
		return gated;
	}

	/** The wait a replay of `failure` must take: its own backoff, or the server's longest named wait. */
	delayFor(failure: unknown, ownDelayMs: number): number {
		return Math.max(ownDelayMs, longestServerWaitMs(failure) ?? 0);
	}

	/**
	 * Waits `delayMs` before an admitted replay — through `hook` when the caller
	 * injected one — and asks the budget again. Raced against the deadline and
	 * against `signal`: a wait still running at the deadline refuses the replay
	 * (`false`), however long the hook goes on, and an abort rejects at once.
	 */
	async wait(delayMs: number, signal: AbortSignal | undefined, hook: RetryWaitHook | undefined): Promise<boolean> {
		if (signal?.aborted) throw abortError(signal);
		const remainingMs = this.#deadline - performance.now();
		if (this.#refused || delayMs >= remainingMs) {
			this.#refused = true;
			return false;
		}
		const raced = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => raced.resolve(false), remainingMs);
		const onAbort = (): void => raced.reject(abortError(signal));
		signal?.addEventListener("abort", onAbort, { once: true });
		const waited = waitForRetry(hook, delayMs, signal).then(() => true);
		// A hook still running when the race ends is no longer watched.
		waited.catch(() => {});
		try {
			if (!(await Promise.race([waited, raced.promise]))) {
				this.#refused = true;
				return false;
			}
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
		return this.admits(0);
	}

	/**
	 * Decides, waits for and arms a replay of `failure` in one step: the wait
	 * is {@link delayFor}, raced by {@link wait}. `false` when any step refuses.
	 * For a rung with no work between its decision and its resend.
	 */
	async replayAfter(
		failure: unknown,
		ownDelayMs: number,
		signal: AbortSignal | undefined,
		hook: RetryWaitHook | undefined,
	): Promise<boolean> {
		return this.replayAfterDelay(this.delayFor(failure, ownDelayMs), failure, signal, hook);
	}

	/**
	 * {@link replayAfter} for a caller that already knows the wait: admits a
	 * replay of `replaced` after `delayMs`, waits it out raced against the
	 * deadline and `signal`, and arms the replay. `false` when any step refuses.
	 */
	async replayAfterDelay(
		delayMs: number,
		replaced: unknown,
		signal: AbortSignal | undefined,
		hook: RetryWaitHook | undefined,
	): Promise<boolean> {
		if (!this.admits(delayMs)) return false;
		if (delayMs > 0 && !(await this.wait(delayMs, signal, hook))) return false;
		this.arm(replaced);
		return true;
	}

	/** Marks `message` as the result of a refused replay, when one was refused. */
	stamp(message: AssistantMessage): void {
		if (this.#refused) message.replayBudgetExhausted = true;
	}
}

/**
 * `options` carrying the budget that governs the call — created from
 * `replayBudgetMs` when they carry none — so every layer and nested call below
 * spends the same one. `options` unchanged when no budget is set.
 */
export function withReplayBudget<O extends object>(options: O): O {
	const budget = ReplayBudget.forCall(options);
	if (!budget || (options as ReplayBudgetCarrier)[REPLAY_BUDGET] === budget) return options;
	return budget.share(options);
}

/**
 * `target` carrying the budget that governs a call made with `source`, for a
 * provider that builds its delegate call's options field by field.
 */
export function inheritReplayBudget<T extends object>(source: object | undefined, target: T): T {
	const budget = ReplayBudget.forCall(source);
	return budget ? budget.share(target) : target;
}

/** `true` when no budget governs the call, otherwise whether `budget` admits a replay after `delayMs`. */
export function admitsReplay(budget: ReplayBudget | undefined, delayMs: number): boolean {
	return budget === undefined || budget.admits(delayMs);
}

/** `base` gated by `budget`'s handoff check, or `base` itself when no budget governs the call. */
export function gateFetch(budget: ReplayBudget | undefined, base: FetchImpl): FetchImpl {
	return budget ? budget.gateFetch(base) : base;
}

/**
 * For a provider that passes `options.fetch` through as given: under a budget,
 * that fetch (or the global one) gated; with no budget, `fetch` exactly as given.
 */
export function gateOptionalFetch(
	budget: ReplayBudget | undefined,
	fetch: FetchImpl | undefined,
): FetchImpl | undefined {
	return budget ? budget.gateFetch(fetch ?? globalThis.fetch) : fetch;
}

/**
 * The failure a call answers with once one of its replays was refused: the
 * failure a refusal in `error` (or in its causes) named, or the refusal itself
 * when it named none. When `error` carries no refusal but `budget` refused a
 * replay that named a failure, that failure: a layer between the refusal and
 * this answer turned it into `error` (a credential probe that read it as "no
 * credentials"), and no request could follow it. Otherwise `error` unchanged.
 */
export function restoreReplaced(error: unknown, budget?: ReplayBudget): unknown {
	const refusal = findRetryRefusal(error);
	if (refusal) return refusal.replaced ?? refusal;
	return budget?.refusedReplaced ?? error;
}

/**
 * The longest wait a failure's server asked for, across every retry header it
 * carries and every hint in the text of its message or error; `undefined`
 * when it named none.
 */
export function longestServerWaitMs(failure: unknown): number | undefined {
	const headers = getHeadersFromError(failure);
	const text = failure instanceof Error ? failure.message : typeof failure === "string" ? failure : undefined;
	return longestRetryHint(headers ? toHeaders(headers) : undefined, text);
}

function toHeaders(headers: Headers | Record<string, string | undefined>): Headers {
	if (headers instanceof Headers) return headers;
	const result = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value !== "string") continue;
		try {
			result.set(name, value);
		} catch {
			// A name or value `Headers` rejects names no wait.
		}
	}
	return result;
}

function abortError(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError");
}
