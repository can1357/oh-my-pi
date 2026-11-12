/**
 * Typed accessors over the compiled catalog-provider entries
 * (`rules/providers/<id>.kdl`): default model, env keys, discovery flags, and
 * authored seed rows. `provider-models/descriptors.ts` pairs these with the
 * per-provider model-manager factories; the generator bundles seed rows per
 * each entry's `bundle` policy.
 */
import rules from "./rules.json";
import type { Api, ModelSpec } from "../types";
import type { CompiledProvider } from "./types";

const EMPTY: readonly ModelSpec<Api>[] = [];

/** Every catalog provider entry keyed by id (sorted). */
export function providerEntries(): Readonly<Record<string, CompiledProvider>> {
	return rules.providers;
}

/** One provider's catalog entry, or `undefined` for ids without one. */
export function providerEntry(provider: string): CompiledProvider | undefined {
	return rules.providers[provider];
}

/**
 * The authored seed rows for one provider (empty when it has none). Rows are
 * the compiled JSON verbatim; callers that mutate must copy.
 */
export function seedModels<TApi extends Api = Api>(provider: string): readonly ModelSpec<TApi>[] {
	// Compile-time validated JSON; the only untyped edge is `thinking`/`compat`
	// arriving as resolved-key records rather than the spec interfaces.
	return (rules.providers[provider]?.seed?.models ?? EMPTY) as unknown as readonly ModelSpec<TApi>[];
}

/** A provider declaring `native-transport-only`, and the built-in API that alone serves it. */
export interface NativeTransportOwner {
	provider: string;
	api: Api;
}

let nativeTransportOwners: ReadonlyMap<string, NativeTransportOwner> | undefined;

/**
 * The `native-transport-only` provider that owns `id`, when `id` is such a
 * provider or the built-in API it declares; `undefined` for every other id.
 */
export function nativeTransportOwner(id: string): NativeTransportOwner | undefined {
	if (!nativeTransportOwners) {
		const owners = new Map<string, NativeTransportOwner>();
		for (const entry of Object.values(rules.providers)) {
			if (entry.nativeTransportOnly === undefined) continue;
			const owner = { provider: entry.id, api: entry.nativeTransportOnly };
			owners.set(entry.id, owner);
			owners.set(entry.nativeTransportOnly, owner);
		}
		nativeTransportOwners = owners;
	}
	return nativeTransportOwners.get(id);
}
