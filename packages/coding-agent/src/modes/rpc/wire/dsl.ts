/**
 * Helpers for authoring the RPC wire schema in omptype's definition syntax.
 *
 * Wire definitions are plain omptype definitions (strings, object literals,
 * tuple expressions) that name each other through the shared scope built in
 * `./index.ts`. These helpers only wrap the tuple operators so field-level
 * documentation and decoder defaults read as intent.
 */

/** A named group of scope definitions. */
export type WireDefs = Record<string, unknown>;

/** Attaches a description; generators emit it as documentation on the type or field. */
export function doc(def: unknown, description: string): readonly unknown[] {
	return [def, "@", description];
}

/**
 * Marks a field older servers may omit: decoders substitute `value` when it is absent.
 * Object and array defaults are cloned per decode.
 */
export function absentAs(def: unknown, value: unknown): readonly unknown[] {
	const fallback = typeof value === "object" && value !== null ? () => structuredClone(value) : value;
	return [def, "=", fallback];
}
