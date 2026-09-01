import { AsyncLocalStorage } from "node:async_hooks";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { ToolError, throwIfAborted } from "./tool-errors";

const browserRunRejections = new WeakMap<object, object>();

/** Associates a browser operation failure with its owning evaluated run. */
export function markBrowserRunRejection<T>(reason: T, owner: object): T {
	if (reason !== null && (typeof reason === "object" || typeof reason === "function")) {
		browserRunRejections.set(reason, owner);
	}
	return reason;
}

/** Returns whether a rejection was marked for the specified evaluated run. */
export function isBrowserRunRejection(reason: unknown, owner: object): boolean {
	return (
		reason !== null &&
		(typeof reason === "object" || typeof reason === "function") &&
		browserRunRejections.get(reason) === owner
	);
}

/** Returns whether a rejection belongs to the marked browser run or its evaluated source file. */
export function isBrowserRunOwnedRejection(reason: unknown, owner: object, filename: string): boolean {
	if (isBrowserRunRejection(reason, owner)) return true;
	return reason instanceof Error && typeof reason.stack === "string" && reason.stack.includes(filename);
}

type FloatingRejectionHandler = (reason: unknown) => void;

interface ObservedPromiseState {
	handled: boolean;
	userContinuationFailed: boolean;
}

const observedBrowserPromises = new WeakMap<Promise<unknown>, ObservedPromiseState>();
const observedPromiseConstructor = { [Symbol.species]: Promise };

type PromiseCombinatorName = "all" | "race" | "allSettled" | "any";
type PromiseCombinator = (this: PromiseConstructor, values: Iterable<unknown>) => Promise<unknown>;

interface PromiseCombinatorTrackingContext {
	owner: object;
	onFloatingRejection: FloatingRejectionHandler;
}

const PROMISE_COMBINATORS: readonly PromiseCombinatorName[] = ["all", "race", "allSettled", "any"];
const NativePromise = Promise;
const nativePromiseCombinators: Record<PromiseCombinatorName, PromiseCombinator> = {
	all: Promise.all,
	race: Promise.race,
	allSettled: Promise.allSettled,
	any: Promise.any,
};
const promiseCombinatorTracking = new AsyncLocalStorage<PromiseCombinatorTrackingContext>();
let previousPromiseDescriptor: PropertyDescriptor | undefined;
let promiseCombinatorTrackingScopes = 0;

/**
 * Observes native promise-combinator results derived from browser promises for
 * the duration of one evaluated run. Native `await` remains unchanged; dropped
 * user continuations from `Promise.all` and `Promise.race` are routed to the
 * owning run.
 */
export async function withBrowserPromiseCombinatorTracking<T>(
	owner: object,
	onFloatingRejection: FloatingRejectionHandler,
	run: () => Promise<T>,
): Promise<T> {
	installPromiseCombinatorTracking();
	try {
		return await promiseCombinatorTracking.run({ owner, onFloatingRejection }, run);
	} finally {
		restorePromiseCombinatorTracking();
	}
}

function installPromiseCombinatorTracking(): void {
	if (promiseCombinatorTrackingScopes > 0) {
		promiseCombinatorTrackingScopes++;
		return;
	}
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Promise");
	if (!descriptor) throw new Error("Global Promise descriptor is unavailable");
	const trackedPromise = createTrackedPromiseConstructor();
	Object.defineProperty(globalThis, "Promise", { ...descriptor, value: trackedPromise });
	previousPromiseDescriptor = descriptor;
	promiseCombinatorTrackingScopes = 1;
}

function restorePromiseCombinatorTracking(): void {
	if (promiseCombinatorTrackingScopes > 1) {
		promiseCombinatorTrackingScopes--;
		return;
	}
	const descriptor = previousPromiseDescriptor;
	try {
		if (!descriptor) throw new Error("Global Promise tracking scope is not installed");
		Object.defineProperty(globalThis, "Promise", descriptor);
	} finally {
		previousPromiseDescriptor = undefined;
		promiseCombinatorTrackingScopes = 0;
	}
}

function createTrackedPromiseConstructor(): PromiseConstructor {
	class TrackedPromise<T> extends NativePromise<T> {}
	for (const name of PROMISE_COMBINATORS) {
		const original = nativePromiseCombinators[name];
		Object.defineProperty(TrackedPromise, name, {
			configurable: true,
			writable: true,
			value(this: PromiseConstructor, values: Iterable<unknown>): Promise<unknown> {
				let hasObservedInput = false;
				const result = Reflect.apply(original, this, [
					tapObservedBrowserPromises(values, () => {
						hasObservedInput = true;
					}),
				]) as Promise<unknown>;
				const context = promiseCombinatorTracking.getStore();
				return hasObservedInput && context
					? observeBrowserRunPromise(result, context.owner, context.onFloatingRejection)
					: result;
			},
		});
	}
	return TrackedPromise;
}

function* tapObservedBrowserPromises(
	values: Iterable<unknown>,
	onObserved: () => void,
): Generator<unknown, void, undefined> {
	for (const value of values) {
		if (observedBrowserPromises.has(value as Promise<unknown>)) onObserved();
		yield value;
	}
}

/**
 * Observes every explicit continuation of a browser promise without replacing
 * the native promise. Browser failures remain contained; an unhandled error
 * created by user continuation code is reported to the owning run.
 */
export function observeBrowserRunPromise<T>(
	promise: Promise<T>,
	owner: object,
	onFloatingRejection: FloatingRejectionHandler,
): Promise<T> {
	return observeBrowserRunPromiseWithState(promise, owner, onFloatingRejection, {
		handled: false,
		userContinuationFailed: false,
	});
}

function observeBrowserRunPromiseWithState<T>(
	promise: Promise<T>,
	owner: object,
	onFloatingRejection: FloatingRejectionHandler,
	state: ObservedPromiseState,
): Promise<T> {
	if (observedBrowserPromises.has(promise)) return promise;
	observedBrowserPromises.set(promise, state);
	const originalThen = promise.then.bind(promise);
	const originalFinally = promise.finally.bind(promise);
	void originalThen(undefined, reason => {
		setTimeout(() => {
			if (!state.handled && (state.userContinuationFailed || !isBrowserRunRejection(reason, owner))) {
				onFloatingRejection(reason);
			}
		}, 0);
	});
	Object.defineProperties(promise, {
		constructor: { configurable: true, value: observedPromiseConstructor },
		// biome-ignore lint/suspicious/noThenProperty: native Promise continuations must remain thenable.
		then: {
			configurable: true,
			value: <TResult1 = T, TResult2 = never>(
				onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
				onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
			): Promise<TResult1 | TResult2> => {
				state.handled = true;
				const childState = createContinuationState();
				return observeBrowserRunPromiseWithState(
					originalThen(
						recordContinuationFailure(onFulfilled, childState),
						recordContinuationFailure(onRejected, childState),
					),
					owner,
					onFloatingRejection,
					childState,
				);
			},
		},
		catch: {
			configurable: true,
			value: <TResult = never>(
				onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
			): Promise<T | TResult> => {
				state.handled = true;
				const childState = createContinuationState();
				return observeBrowserRunPromiseWithState(
					originalThen(undefined, recordContinuationFailure(onRejected, childState)),
					owner,
					onFloatingRejection,
					childState,
				);
			},
		},
		finally: {
			configurable: true,
			value: (onFinally?: (() => void) | null): Promise<T> => {
				state.handled = true;
				const childState = createContinuationState();
				return observeBrowserRunPromiseWithState(
					originalFinally(recordContinuationFailure(onFinally, childState)),
					owner,
					onFloatingRejection,
					childState,
				);
			},
		},
	});
	return promise;
}

function createContinuationState(): ObservedPromiseState {
	return { handled: false, userContinuationFailed: false };
}

function recordContinuationFailure<TArgs extends unknown[], TResult>(
	continuation: ((...args: TArgs) => TResult | PromiseLike<TResult>) | null | undefined,
	state: ObservedPromiseState,
): ((...args: TArgs) => TResult | PromiseLike<TResult>) | null | undefined {
	if (!continuation) return continuation;
	return (...args) => {
		try {
			const result = continuation(...args);
			if (!isThenable(result)) return result;
			return Promise.resolve(result).catch(reason => {
				state.userContinuationFailed = true;
				throw reason;
			}) as PromiseLike<TResult>;
		} catch (reason) {
			state.userContinuationFailed = true;
			throw reason;
		}
	};
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	return typeof Reflect.get(value, "then") === "function";
}

function trackBrowserRunPromise<T>(
	promise: Promise<T>,
	owner?: object,
	onFloatingRejection?: FloatingRejectionHandler,
): Promise<T> {
	if (!owner) return markHandled(promise);
	const tracked = promise.catch(error => {
		throw markBrowserRunRejection(error, owner);
	});
	return onFloatingRejection ? observeBrowserRunPromise(tracked, owner, onFloatingRejection) : tracked;
}

/**
 * Installs worker-realm rejection routing. Consumed browser-run failures stay in
 * the worker; unrelated failures retain the default fatal worker behavior.
 */
export function installBrowserWorkerRejectionGuard(consume: (reason: unknown) => boolean): () => void {
	const onRejection = (reason: unknown): void => {
		if (postmortem.isExpectedCleanupError(reason) || consume(reason)) return;
		setTimeout(() => {
			throw reason;
		}, 0);
	};
	process.on("unhandledRejection", onRejection);
	return () => process.off("unhandledRejection", onRejection);
}

/**
 * Marks a run-scoped promise as observed without changing its behavior for awaited callers.
 *
 * Run teardown aborts can reject promises created for evaluated code after user code
 * has stopped observing them (for example fire-and-forget `wait()`/facade calls). In 16.3.0
 * those zero-consumer rejections reached the process-level `unhandledRejection` handler and
 * killed every subagent sharing the process (issues #4499/#4672). Attaching a no-op rejection
 * handler at creation makes the promise observed while returning the original promise so callers
 * that do await it still receive the rejection.
 */
export function markHandled<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => undefined);
	return promise;
}

/** Headroom subtracted from the cell budget so an in-run deadline fires before the opaque whole-cell timeout. */
export const CELL_BUDGET_SLACK_MS = 1_000;

/** Default poll deadline for `wait(predicate)` before clamping to the cell budget. */
export const DEFAULT_PREDICATE_TIMEOUT_MS = 30_000;

/** Options for the predicate form of the run-scoped `wait()` helper. */
export interface WaitPredicateOptions {
	/** Max time to poll before failing, in ms (default 30s, clamped to the cell budget). */
	timeout?: number;
	/** Poll interval in ms (default 100, floor 10). */
	interval?: number;
}

/**
 * Effective `wait(predicate)` deadline for a given cell budget. Always strictly below
 * the cell budget so the named `wait(predicate) timed out` error wins the race against
 * the opaque whole-cell execution timeout. `0`/`Infinity` ("disable") map to the largest
 * bounded deadline; negative/NaN garbage falls back to the default.
 */
export function resolvePredicateTimeout(cellTimeoutMs: number, explicit?: number): number {
	const budgetBound = Math.max(1, cellTimeoutMs - CELL_BUDGET_SLACK_MS);
	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
	if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
	return Math.min(DEFAULT_PREDICATE_TIMEOUT_MS, budgetBound);
}

/**
 * Run-scoped `wait()` helper for evaluated code (browser and computer workers), honoring
 * the owning run's cancellation signal.
 *
 * - `wait(ms)` sleeps for `ms` milliseconds.
 * - `wait(fn, { timeout?, interval? })` polls `fn` (sync or async) until it returns a
 *   truthy value and resolves with that value; throws a named `ToolError` on timeout
 *   instead of stalling into the whole-cell deadline. Predicate errors propagate.
 */
export function waitForRun(
	msOrPredicate: number | (() => unknown),
	signal: AbortSignal,
	opts?: WaitPredicateOptions,
): Promise<unknown> {
	const promise = (async (): Promise<unknown> => {
		throwIfAborted(signal);
		if (typeof msOrPredicate === "number") {
			await untilAborted(signal, async () => await Bun.sleep(msOrPredicate));
			throwIfAborted(signal);
			return undefined;
		}
		if (typeof msOrPredicate !== "function") {
			throw new ToolError("wait(...) expects milliseconds (number) or a predicate function to poll");
		}
		const timeout =
			opts?.timeout !== undefined && Number.isFinite(opts.timeout) && opts.timeout > 0
				? opts.timeout
				: DEFAULT_PREDICATE_TIMEOUT_MS;
		const interval = Math.max(opts?.interval ?? 100, 10);
		const deadline = Date.now() + timeout;
		for (;;) {
			const value = await untilAborted(signal, async () => await msOrPredicate());
			throwIfAborted(signal);
			if (value) return value;
			if (Date.now() + interval > deadline) {
				throw new ToolError(`wait(predicate) timed out after ${timeout}ms — predicate never returned truthy`);
			}
			await untilAborted(signal, async () => await Bun.sleep(interval));
		}
	})();
	return trackBrowserRunPromise(promise);
}

/** Binds a long-lived scope facade (page/tab/desktop objects) to one evaluated run's abort signal. */
export function bindRunFacade<T extends object>(
	target: T,
	signal: AbortSignal,
	rejectionOwner?: object,
	onFloatingRejection?: FloatingRejectionHandler,
): T {
	const cache = new Map<PropertyKey, unknown>();
	return new Proxy(target, {
		get(current, prop) {
			throwIfAborted(signal);
			const cached = cache.get(prop);
			if (cached) return cached;
			const value = Reflect.get(current, prop, current);
			if (typeof value === "function") {
				const wrapped = (...args: unknown[]): unknown => {
					throwIfAborted(signal);
					const result = Reflect.apply(value, current, args);
					if (result && typeof result === "object") {
						const then = Reflect.get(result, "then");
						if (typeof then === "function") {
							return trackBrowserRunPromise(
								Promise.resolve(result).then(resolved => {
									throwIfAborted(signal);
									return resolved;
								}),
								rejectionOwner,
								onFloatingRejection,
							);
						}
					}
					throwIfAborted(signal);
					return result;
				};
				cache.set(prop, wrapped);
				return wrapped;
			}
			if (value && typeof value === "object") {
				// Never proxy AbortSignals: native combinators (AbortSignal.any, fetch)
				// brand-check internal slots that a Proxy cannot forward, and reading a
				// signal needs no abort gating anyway.
				if (value instanceof AbortSignal) return value;
				const wrapped = bindRunFacade(value, signal, rejectionOwner, onFloatingRejection);
				cache.set(prop, wrapped);
				return wrapped;
			}
			return value;
		},
	});
}
