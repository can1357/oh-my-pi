import type { OAuthCredentials } from "../registry/oauth/types";

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
 * never touched. A signal one of those calls hands its author goes through {@link AdmittedSignal}:
 * otherwise the author's abort listener would run outside that work.
 */
import { AsyncLocalStorage } from "node:async_hooks";

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
	/** A host value as that session is handed it: a copy, so what the author keeps is never the
	 *  host's own object (an abort `reason` the host reads again after the abort). Absent, the
	 *  value is handed as it is. */
	hand?<T>(value: T): T;
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

/**
 * The signal an admitted call hands its author in place of the caller's.
 *
 * It is a different object because an author's abort listener runs inside the host's
 * `controller.abort()`, in the caller's async context: Bun's `EventTarget` does not carry the
 * context from `addEventListener`. Handed the caller's own, the listener would run outside the
 * session that owns it — and once the call is over, even after that session has gone. This one
 * aborts inside the admission, with a copy of the caller's reason (`ProviderCallGate.hand`), so the
 * listeners on it run as the session's work and what they keep is not the host's own object, and
 * it stops following the caller's at the call's terminal.
 *
 * It says what the caller's says wherever the author can look. Already aborted, it is aborted
 * before the author is called. Otherwise one listener added just before the call forwards the
 * abort, so it fires where the author's own listener on the caller's signal would have, in the
 * same turn. That listener comes off when the abort fires (`once`) and when the call site
 * {@link release}s at the terminal of everything the call produced, fulfilled or failed, so a
 * long-lived caller signal gathers none across calls.
 *
 * A host registration has no gate and no admission to carry: its author is handed the caller's
 * own signal.
 */
export class AdmittedSignal {
	readonly #gate: ProviderCallGate | undefined;
	readonly #caller: AbortSignal | undefined;
	#admitted: AbortSignal | undefined;
	#forward: (() => void) | undefined;

	/** `gate` is the registration's, absent for the host's own; `caller` is the signal the host
	 *  was given for this call. */
	constructor(gate: ProviderCallGate | undefined, caller: AbortSignal | undefined) {
		this.#gate = gate;
		this.#caller = caller;
	}

	/**
	 * The signal to hand the author. Call it inside the admitted call: the async context it runs
	 * in is the admission the abort is carried into. Asking again returns the same signal.
	 */
	admit(): AbortSignal | undefined {
		const caller = this.#caller;
		if (!this.#gate || !caller) return caller;
		if (this.#admitted) return this.#admitted;
		const controller = new AbortController();
		this.#admitted = controller.signal;
		// The reason is handed as the session's own copy: the caller's object is the host's, which
		// it reads again after the abort (the text it persists for the turn).
		// Copying it can fail — a getter that throws, a reason too large to copy. The abort happens
		// regardless, with a reason of the session's own saying so; the failure is not thrown out of
		// the caller's abort listener, where it would reach the process.
		const reason = (): unknown => {
			const hand = this.#gate?.hand;
			if (!hand) return caller.reason;
			try {
				return hand(caller.reason);
			} catch {
				return new DOMException("The operation was aborted; its reason could not be handed over", "AbortError");
			}
		};
		if (caller.aborted) {
			controller.abort(reason());
		} else {
			const admission = AsyncLocalStorage.snapshot();
			const forward = () => admission(() => controller.abort(reason()));
			this.#forward = forward;
			caller.addEventListener("abort", forward, { once: true });
		}
		return this.#admitted;
	}

	/** Lets go of the caller's signal: the call site's, at the terminal of everything the admitted
	 *  call produced. Bound, and harmless to call again or when nothing was admitted. */
	readonly release = (): void => {
		const forward = this.#forward;
		if (!forward) return;
		this.#forward = undefined;
		this.#caller?.removeEventListener("abort", forward);
	};
}

/** Every field an `OAuthCredentials` has, and what it holds. `Required` so a field added to the
 *  type does not compile until someone says how it is copied. */
const OAUTH_CREDENTIAL_FIELDS: { readonly [K in keyof Required<OAuthCredentials>]: "string" | "number" } = {
	refresh: "string",
	access: "string",
	expires: "number",
	enterpriseUrl: "string",
	projectId: "string",
	email: "string",
	accountId: "string",
	apiEndpoint: "string",
	orgId: "string",
	orgName: "string",
	region: "string",
	inferenceRegion: "string",
	activeOrganizationId: "string",
	authorizedAt: "number",
};

/**
 * A host-owned copy of the credentials an extension's `login` or `refreshToken` handed back.
 *
 * A value an author RETURNS is author code as much as a property it exposes: its fields may be
 * getters, and the host persists what it reads from them. Read outside the owner's admission —
 * or after retirement, which both routes reached — that read runs extension code nobody is
 * answering for, and what it answers is what gets stored. So the fields are read once, here,
 * inside the admitted call, and nothing afterwards touches the original.
 *
 * By schema, like a `UsageReport`: each field the type declares, so a getter the type does not
 * know about is never consulted, and a function where data belongs is refused with its name.
 */
export function copyOAuthCredentials(
	credentials: OAuthCredentials,
	provider: string,
	method: "login" | "refreshToken",
): OAuthCredentials {
	const copy: Record<string, unknown> = {};
	for (const [field, kind] of Object.entries(OAUTH_CREDENTIAL_FIELDS)) {
		const value: unknown = (credentials as Record<string, unknown>)[field];
		if (value === undefined) continue;
		if (typeof value === "function") {
			throw new Error(
				`OAuth provider "${provider}": ${method}() returned a function for "${field}", but it must be data. ` +
					`Compute the value before returning it.`,
			);
		}
		if (typeof value !== kind) continue;
		copy[field] = value;
	}
	return copy as OAuthCredentials;
}

/**
 * The copy of a host credential record a session's callback is handed in place of the record.
 *
 * An object handed to author code is the author's from then on: it can install a getter on it or
 * assign into it. Handed the host's own record — the credential pool's entry, or the row a refresh
 * is about to merge — the host's next read of that record would run the author's getter or take
 * its assignment, outside the session's admission and after its retirement, from whichever
 * subsystem asks for the credential next. So the callback gets this copy and the host never reads
 * it again: changing it changes nothing the host stores, and what the author returns is what the
 * host keeps.
 *
 * Copied by the schema {@link copyOAuthCredentials} copies a returned record with, so the author
 * receives the fields its parameter type declares. The record is the host's own data, so nothing
 * in it is refused. A host registration is the host's code and is handed the record itself.
 */
export function handOAuthCredentials(credentials: OAuthCredentials): OAuthCredentials {
	const copy: Record<string, unknown> = {};
	for (const field in OAUTH_CREDENTIAL_FIELDS) {
		const value: unknown = Reflect.get(credentials, field);
		if (value !== undefined) copy[field] = value;
	}
	return copy as OAuthCredentials;
}
