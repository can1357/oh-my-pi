/**
 * Helpers for wiring the `compact` and `setModel` actions of an {@link ExtensionContext}. Every
 * mode binds both actions through these, so each value an extension hands over is copied once,
 * at the boundary, and the host's check and its action both read that copy.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. {@link runExtensionCompact} splits the
 * union so the same adapter can be reused by print-mode, rpc-mode, interactive mode and the executor.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { MODEL_ROW } from "../../config/model-registry";
import { CALLBACK, DATA, fieldsOf, snapshotAuthorData } from "./author-data";
import type { CompactOptions } from "./types";

/** Every field `CompactOptions` has. A field it does not declare is not copied. */
const COMPACT_OPTIONS = fieldsOf<CompactOptions>({
	onComplete: CALLBACK,
	onError: CALLBACK,
	mode: DATA,
	internalGuidance: DATA,
	suppressContinuation: DATA,
});

interface CompactableSession {
	compact(instructions?: string, options?: CompactOptions): Promise<unknown>;
}

/**
 * Compaction checks `internalGuidance` against a mode that rejects focus text and then hands it to
 * the summarizer, and tests `mode` before resolving it. The options are the extension's object, so
 * they are copied once, here, by {@link COMPACT_OPTIONS} — each field read once, a function where
 * data belongs refused with its path — and compaction reads only that copy. `onComplete` and
 * `onError` are callbacks, kept as the same functions for compaction to own when it calls them.
 */
export async function runExtensionCompact(
	session: CompactableSession,
	instructionsOrOptions: string | CompactOptions | undefined,
): Promise<void> {
	const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
	const options =
		instructionsOrOptions && typeof instructionsOrOptions === "object"
			? (snapshotAuthorData(
					instructionsOrOptions,
					COMPACT_OPTIONS,
					{ subject: "ctx.compact()", path: ["options"], advice: "Compute the value before handing it over." },
					new Map(),
				) as CompactOptions)
			: undefined;
	await session.compact(instructions, options);
}

interface SetModelCapableSession {
	modelRegistry: { getApiKey(model: Model): Promise<string | undefined> };
	setModel(model: Model): Promise<unknown>;
}

/**
 * Helper for wiring the `setModel` action of an {@link ExtensionContext}.
 *
 * The model is the extension's object, so it is copied once, here, by {@link MODEL_ROW} — each
 * field read once, a function where data belongs refused with its path — and the credential check
 * and the selection both use that copy. A `resolveHeaders` is a capability, not data: the copy
 * keeps the same function, so a projected resolver stays owned by its registration.
 *
 * Returns false when no API key is available for the requested model.
 */
export async function runExtensionSetModel(session: SetModelCapableSession, model: Model): Promise<boolean> {
	const selected = snapshotAuthorData(
		model,
		MODEL_ROW,
		{ subject: "pi.setModel()", path: ["model"], advice: "Compute the value before handing the model over." },
		new Map(),
	) as Model;
	const key = await session.modelRegistry.getApiKey(selected);
	if (!key) return false;
	await session.setModel(selected);
	return true;
}
