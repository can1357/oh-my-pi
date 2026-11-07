/**
 * Helper for wiring the `compact` action of an {@link ExtensionContext}.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. This helper splits the
 * union so the same adapter can be reused by every mode (interactive, print, rpc,
 * acp) — it is the single place that keeps the "never rejects" guarantee.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger, toError } from "@oh-my-pi/pi-utils";
import type { CompactOptions } from "./types";

interface CompactableSession {
	compact(instructions?: string, options?: CompactOptions): Promise<unknown>;
}

/**
 * Call an extension callback and contain whatever it throws or rejects with.
 *
 * Both `CompactOptions` callbacks are typed `void`, but an `async` implementation
 * returns a promise, and the session invokes them without observing the result.
 * A rejection there surfaces as an unhandled rejection after `ctx.compact()` has
 * already resolved — the same fatal path as issue #12041 — so observe it here.
 */
function invokeCallback<Value>(name: string, callback: (value: Value) => void, value: Value): void {
	try {
		const result = callback(value) as PromiseLike<unknown> | undefined;
		if (typeof result?.then === "function") {
			void Promise.resolve(result).catch(thrown => {
				logCallbackFailure(name, thrown);
			});
		}
	} catch (thrown) {
		logCallbackFailure(name, thrown);
	}
}

function logCallbackFailure(name: string, thrown: unknown): void {
	logger.warn(`Extension compaction ${name} threw`, { error: toError(thrown).message });
}

/**
 * Create the reporter that delivers a failed compaction to an extension.
 *
 * The returned function invokes `onError` at most once, so the session's own
 * report and the catch that follows it collapse into a single call — the
 * contract is "exactly once per failed compaction" (issue #12041).
 *
 * Anything `onError` throws, or rejects with, is logged instead of escaping:
 * the callback runs inside extension code, and neither a synchronous throw nor
 * a rejected promise may become an unhandled rejection. `onMissing` runs when
 * the extension supplied no callback at all.
 */
export function createCompactErrorReporter(
	onError: ((error: Error) => void) | undefined,
	onMissing?: (error: Error) => void,
): (error: Error) => void {
	let reported = false;
	return (error: Error): void => {
		if (reported) return;
		reported = true;
		if (!onError) {
			onMissing?.(error);
			return;
		}
		invokeCallback("onError", onError, error);
	};
}

/** The extension-facing compaction options plus the reporter that owns `onError`. */
export interface PreparedCompactOptions {
	/** Options to hand to the session; both callbacks contained, or `undefined` when none were given. */
	options: CompactOptions | undefined;
	/** Deliver a failure the session rejected before it reached its own `onError` call. */
	reportFailure: (error: Error) => void;
}

/**
 * Contain the callbacks an extension hands to `ctx.compact()`.
 *
 * `onError` is replaced by the exactly-once reporter, and `onComplete` is
 * wrapped because the session calls it without observing the result: an
 * `async onComplete` that rejects would otherwise kill the host after an
 * otherwise successful compaction. Returns `reportFailure` so a caller that
 * shells out to `session.compact()` itself can report the rejections the
 * session raises before its own report (issue #12041).
 */
export function prepareCompactOptions(
	options: CompactOptions | undefined,
	onMissing?: (error: Error) => void,
): PreparedCompactOptions {
	const reportFailure = createCompactErrorReporter(options?.onError, onMissing);
	if (!options) return { options: undefined, reportFailure };
	const onComplete = options.onComplete;
	return {
		options: {
			...options,
			onError: reportFailure,
			onComplete: onComplete ? result => invokeCallback("onComplete", onComplete, result) : undefined,
		},
		reportFailure,
	};
}

/**
 * Run `ctx.compact()` for an extension.
 *
 * The session reports a failed compaction through `CompactOptions.onError` and
 * then rethrows, so awaiting `session.compact()` directly rejects even when
 * the extension only wants the callback. Extensions commonly fire `ctx.compact()`
 * without awaiting it, and a rejection with no handler is an unhandled
 * rejection that tears down RPC hosts (issue #12041). Catch here, report the
 * failure exactly once through the extension's own error path, and resolve.
 */
export async function runExtensionCompact(
	session: CompactableSession,
	instructionsOrOptions: string | CompactOptions | undefined,
): Promise<void> {
	const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
	const options =
		instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
	// Without an extension callback there is nobody to tell, so log the failure
	// instead of dropping it.
	const prepared = prepareCompactOptions(options, error => {
		logger.warn("Extension compaction failed", { error: error.message });
	});
	try {
		await session.compact(instructions, prepared.options);
	} catch (error) {
		prepared.reportFailure(toError(error));
	}
}

interface SetModelCapableSession {
	modelRegistry: { getApiKey(model: Model): Promise<string | undefined> };
	setModel(model: Model): Promise<unknown>;
}

/**
 * Helper for wiring the `setModel` action of an {@link ExtensionContext}.
 *
 * Returns false when no API key is available for the requested model.
 */
export async function runExtensionSetModel(session: SetModelCapableSession, model: Model): Promise<boolean> {
	const key = await session.modelRegistry.getApiKey(model);
	if (!key) return false;
	await session.setModel(model);
	return true;
}
