/**
 * Lifetime of a provider somebody registered at runtime, as the registries and the call sites see
 * it.
 *
 * An extension's provider belongs to the session that registered it: once that session is gone,
 * its callbacks must not run, because they would act with credentials and a transcript that no
 * longer have an owner. Four rounds of review established how NOT to enforce that — by wrapping
 * the author's object. A provider is whatever its author wrote: frozen, callable, built from
 * getters, a class instance with private fields. Every wrapping scheme traded one of those shapes
 * for another, and a getter evaluated to find a callback had already run before any wrapper
 * existed.
 *
 * So the host asks before it calls instead. The places where WE invoke a provider's callback are
 * few, they are all in this repository, and they are listed in {@link callThroughGate}'s callers:
 * the usage service, the credential-health check, the header ingest, the OAuth registry's login,
 * refresh and key consumers, the model-modifier projection and the custom-API stream. Each one
 * selects a live registration and runs the call as that session's work; the author's object is
 * never touched.
 */
/**
 * What an admitted call produces, declared by the call site that admits it.
 *
 * `value` is the ordinary case: whatever comes back is finished, unless it is a thenable, in
 * which case settling is what finishing means. `stream` says the call returns a producer that
 * keeps working after it is handed back and reports completion through `result()`.
 *
 * The kind is declared rather than guessed. Inspecting the returned value was tried twice and is
 * wrong in both directions, because the author chooses the shape: a terminal `result()` that is
 * a CALLABLE thenable was missed, and an ordinary async-iterable data collection that happens to
 * carry an unrelated lazy `result()` was claimed as outstanding work and its method invoked for
 * nothing. We own every site that admits a call — that was the ruling — and the site knows
 * whether it is starting a stream.
 */
export type AdmittedWorkKind = "value" | "stream";

export interface ProviderCallGate {
	/** True once the session that registered this provider has gone. */
	readonly retired: boolean;
	/** Runs one call into the provider as that session's work: attributed to it, and awaited by
	 *  its disposal until the work of the declared {@link AdmittedWorkKind} is finished. Throws
	 *  if the session retired between selection and the call, and refuses a `stream` whose
	 *  producer reports no completion. */
	run<R>(call: () => R, kind?: AdmittedWorkKind): R;
}

/** A runtime registration and the session lifetime it belongs to. A host registration has no
 *  gate: it lives as long as the process. */
export interface GatedRegistration {
	readonly gate?: ProviderCallGate;
}

/**
 * The registration in force: the most recent one whose owner is still live.
 *
 * Registries here are keyed by provider or API name and several sessions can register the same
 * name — a subagent rebinding its parent's extensions does exactly that. Retirement must then be
 * a SELECTION question, not a refusal: the child's entry stops being chosen and the parent's
 * earlier one answers again, so disposing the child cannot break a parent that is still running.
 */
export function selectLiveRegistration<T extends GatedRegistration>(entries: readonly T[]): T | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry && entry.gate?.retired !== true) return entry;
	}
	return undefined;
}

/** Runs a call into a registered provider as its owning session's work, or directly when the
 *  registration is the host's own. `kind` is what this call site knows it is starting. */
export function callThroughGate<R>(
	gate: ProviderCallGate | undefined,
	call: () => R,
	kind: AdmittedWorkKind = "value",
): R {
	return gate ? gate.run(call, kind) : call();
}
