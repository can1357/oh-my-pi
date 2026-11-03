import { types } from "node:util";
import { describeError, logger, observeRejection } from "@oh-my-pi/pi-utils";

// Captured when this module loads: code running in the same realm can replace the globals.
const reflectApply = Reflect.apply;
const reflectGet = Reflect.get;
const promiseThen = Promise.prototype.then;

/**
 * Hands every rejection `value` can produce to `onRejected`, and calls
 * `onSettled` once `value` settles either way. Never throws, and leaves nothing
 * it can reach unhandled.
 *
 * A value that is not a thenable settles at once. A native promise (one with
 * the internal promise slot, which `types.isPromise` tests without running any
 * of its code) is observed through the built-in `then`, whatever its own `then`
 * says: an own `then` set to `null` or to a function that drops its callbacks
 * would otherwise leave its rejection unhandled. The built-in `then` reads the
 * promise's `constructor` (and calls the species constructor it names); when
 * that throws, the throw is reported as a rejection and the value counts as
 * settled. Such a promise's own rejection stays unobserved: a promise whose
 * `constructor` or species refuses observation is outside what this can handle.
 *
 * Any other thenable has its `then` read once (a getter can answer differently
 * on a second read) and called with both callbacks; a `then` that throws counts
 * as a rejection. What `then` returns is observed as well: an `async then()`
 * that throws, or any `then` that returns a rejected promise, rejects that
 * promise instead of calling back, so that rejection goes to `onRejected` too
 * and counts as settling. `onSettled` runs at most once; `onRejected` runs once
 * per rejection the value reports. A throw from either callback is dropped:
 * they report a failure, and the report must not become a failure of its own.
 *
 * Not covered: a native promise whose `constructor` or species refuses
 * observation (above); a thenable that is not a native promise and whose `then`
 * never calls back and returns nothing that settles never settles.
 */
function observe(value: unknown, onRejected: (reason: unknown) => void, onSettled?: () => void): void {
	let settled = false;
	const settle = (): void => {
		if (settled) return;
		settled = true;
		try {
			onSettled?.();
		} catch {
			// See the doc comment: a report must not fail.
		}
	};
	const reject = (reason: unknown): void => {
		try {
			onRejected(reason);
		} catch {
			// See the doc comment: a report must not fail.
		}
		settle();
	};
	// A native promise whose own `then` was removed is not adopted, so a promise can fulfil with
	// one. Such a value is followed like the promise itself, so its rejection is reported too;
	// each is followed once, which ends a cycle of promises fulfilled with one another.
	const followed = new Set<object>();
	const fulfil = (result: unknown): void => {
		if (!types.isPromise(result) || followed.has(result)) {
			settle();
			return;
		}
		followed.add(result);
		try {
			reflectApply(promiseThen, result, [fulfil, reject]);
		} catch (error) {
			// Its `constructor` or species refused: reported, as below.
			reject(error);
		}
	};
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		settle();
		return;
	}
	if (types.isPromise(value)) {
		followed.add(value);
		try {
			reflectApply(promiseThen, value, [fulfil, reject]);
		} catch (error) {
			// Its `constructor` getter, or the species constructor it names, threw before the
			// built-in `then` attached the callbacks. That is reported; the promise itself
			// cannot be observed by any built-in, so its own rejection is not.
			reject(error);
		}
		return;
	}
	let then: unknown;
	let returned: unknown;
	try {
		then = reflectGet(value, "then");
		if (typeof then !== "function") {
			// A `then` getter may return a rejected promise instead of a function.
			observeRejection(then);
			settle();
			return;
		}
		returned = reflectApply(then, value, [fulfil, reject]);
	} catch (error) {
		reject(error);
		return;
	}
	// The built-in `then` returns a promise that rejects only when a callback throws, and these do not.
	if (then === promiseThen || !types.isPromise(returned)) return;
	try {
		// Only a native promise reports an unhandled rejection. The built-in `then` observes one
		// without calling any `then` it overrides; what it fulfils with is observed in turn, and
		// its callbacks return nothing, so nothing is forwarded into a child promise.
		reflectApply(promiseThen, returned, [observeRejection, reject]);
	} catch (error) {
		// The returned promise's `constructor` or species refused: reported, as above.
		reject(error);
	}
}

/** Hands every rejection `value` can produce to `onRejected` (see {@link observe}). Never throws. */
export function catchRejection(value: unknown, onRejected: (reason: unknown) => void): void {
	observe(value, onRejected);
}

/**
 * Resolves once `value` settles, after handing each rejection it produces to
 * `onRejected` (see {@link observe}). Never rejects. For a caller that awaits
 * a callback's result: `await` alone ignores what a thenable's `then` returns,
 * so an `async then()` that throws would leave its rejection unhandled and the
 * `await` waiting forever.
 */
export function settled(value: unknown, onRejected: (reason: unknown) => void): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	observe(value, onRejected, resolve);
	return promise;
}

/**
 * Send a message to a Bun subprocess over IPC, neutralizing both the
 * synchronous throw ("cannot be used after the process has exited") and any
 * asynchronous rejection (EPIPE from a pipe that broke between exit being
 * observed and the next `send()`). The dead worker is detected separately via
 * `onExit`/`onError` and respawned or disabled by the owning client; an
 * un-awaited EPIPE rejection must not escape as a fatal unhandled rejection
 * that takes down the whole session. See issue #2997.
 *
 * `label` prefixes the debug log on synchronous failure (e.g. "tts"). Serializing
 * `message` runs its getters, so the failure can be any value.
 */
export function safeSend(proc: { send(message: unknown): unknown }, message: unknown, label: string): void {
	try {
		catchRejection(proc.send(message), () => {});
	} catch (error) {
		logger.debug(`${label}: send to subprocess failed`, { error: describeError(error).message });
	}
}
