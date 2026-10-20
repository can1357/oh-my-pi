/**
 * Helper for wiring the `compact` action of an {@link ExtensionContext}.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. This helper splits the
 * union so the same adapter can be reused by every mode (interactive, print, rpc,
 * acp) — it is the single place that keeps the "never rejects" guarantee.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { CompactOptions } from "./types";

interface CompactableSession {
	compact(instructions?: string, options?: CompactOptions): Promise<unknown>;
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
	let reported = false;
	const onError = options?.onError;
	const reportError = (error: Error): void => {
		if (reported) return;
		reported = true;
		if (!onError) {
			logger.warn("Extension compaction failed", { error: error.message });
			return;
		}
		try {
			onError(error);
		} catch (thrown) {
			// The extension's own error handler threw. The returned promise must
			// not reject, so log the throw instead of dropping it silently.
			logger.warn("Extension compaction onError threw", {
				error: thrown instanceof Error ? thrown.message : String(thrown),
			});
		}
	};
	// The session reports the failure through `onError` and then rethrows it into
	// the `catch` below; wrap it so the extension sees exactly one report.
	const compactOptions = options ? { ...options, onError: (error: Error): void => reportError(error) } : undefined;
	try {
		await session.compact(instructions, compactOptions);
	} catch (error) {
		reportError(error instanceof Error ? error : new Error(String(error)));
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
