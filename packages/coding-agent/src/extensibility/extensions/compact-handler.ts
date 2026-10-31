/**
 * Helpers for wiring the `compact` and `setModel` actions of an {@link ExtensionContext}. Every
 * mode binds both actions through these, so each value an extension hands over is copied once,
 * at the boundary, and the host's check and its action both read that copy.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. {@link runExtensionCompact} splits the
 * union so the same adapter can be reused by print-mode, rpc-mode, interactive mode and the executor.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { AdmittedSignal } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { MODEL_ROW } from "../../config/model-registry";
import { type AuthorDataSite, CALLBACK, DATA, fieldsOf, snapshotAuthorData } from "./author-data";
import { providerCallGate } from "./callback-ownership";
import type { CompactOptions, ExtensionCallbackOwner } from "./types";
import { copyHostData } from "./boundary-data";

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
	try {
		await session.compact(instructions, options);
	} catch (error) {
		// The failure is the host's own object; the extension's `await` is handed a copy.
		throw copyHostData(error);
	}
}

interface SetModelCapableSession {
	modelRegistry: { getApiKey(model: Model): Promise<string | undefined> };
	setModel(model: Model): Promise<unknown>;
}

type HeaderResolver = NonNullable<Model<Api>["resolveHeaders"]>;

/**
 * Helper for wiring the `setModel` action of an {@link ExtensionContext}: the model is copied once
 * ({@link copyHandedModel}), and the credential check and the selection both use that copy.
 * `owner` is the session that handed it over.
 *
 * Returns false when no API key is available for the requested model.
 */
export async function runExtensionSetModel(
	session: SetModelCapableSession,
	model: Model,
	owner: ExtensionCallbackOwner,
): Promise<boolean> {
	const selected = copyHandedModel(model, owner, "pi.setModel()");
	const key = await session.modelRegistry.getApiKey(selected);
	if (!key) return false;
	await session.setModel(selected);
	return true;
}

/**
 * A model an extension hands the host, as the host keeps it: copied once by {@link MODEL_ROW},
 * inside the admission of `owner` — the session that handed it over, refused once it has gone —
 * each field read once and a function where data belongs refused with its path. A
 * `resolveHeaders` is a capability, not data: the host calls it for every request it builds with
 * the model from then on ({@link handedResolver}).
 */
export function copyHandedModel(model: Model, owner: ExtensionCallbackOwner, subject: string): Model {
	const copied = owner.runOwned(
		() =>
			snapshotAuthorData(
				model,
				MODEL_ROW,
				{ subject, path: ["model"], advice: "Compute the value before handing the model over." },
				new Map(),
			) as Model,
	);
	const resolver = copied.resolveHeaders;
	return resolver ? { ...copied, resolveHeaders: handedResolver(resolver, model, owner, subject) } : copied;
}

/**
 * The `resolveHeaders` a handed-over model brings, as the host keeps it. It is applied to the
 * object it was handed on, not to the copy: a class-written model's resolver reads its own fields
 * through `this`. A session's resolver is that session's code, called from host code for every
 * request from then on, so it runs as the session's work — handed a signal of the session's own,
 * its answer copied as data inside the admission — and is refused once the session has gone. A
 * resolver the model carried from the registry is called the same way; it answers as it did.
 */
function handedResolver(
	resolver: HeaderResolver,
	receiver: Model,
	owner: ExtensionCallbackOwner,
	subject: string,
): HeaderResolver {
	const gate = providerCallGate(owner);
	const site: AuthorDataSite = {
		subject,
		path: ["model.resolveHeaders() result"],
		advice: "Compute the value before returning it.",
	};
	return async signal => {
		const admitted = new AdmittedSignal(gate, signal);
		try {
			const produced: unknown = await owner.runOwned(() => Reflect.apply(resolver, receiver, [admitted.admit()]));
			// Read inside a second admission: a session gone while the resolver ran answers nothing.
			return owner.runOwned(() => snapshotAuthorData(produced, DATA, site, new Map())) as
				| Record<string, string>
				| undefined;
		} finally {
			admitted.release();
		}
	};
}
