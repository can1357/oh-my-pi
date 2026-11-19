/**
 * Contract every benchmark candidate implements.
 *
 * `type(def)` mirrors arktype: returns a callable schema. Calling it with a
 * value returns the (possibly morphed: defaults applied, extras deleted) value
 * on success, or an error object recognized by `isErrors` on failure.
 */
import type { Def } from "./ir";

/** Callable validation result contract used by timed candidates. */
export type SchemaFn = (value: unknown) => unknown;
/** Boolean-only validation contract used by timed candidates. */
export type CheckFn = (value: unknown) => boolean;

/** One library implementation exercised by the benchmark harness. */
export interface Candidate {
	name: string;
	type(def: Def): SchemaFn;
	/** Native boolean-only validation path, when the library exposes one. */
	allows?(def: Def): CheckFn;
	isErrors(result: unknown): boolean;
	/** Optional error summary string for correctness diagnostics. */
	summary?(result: unknown): string;
}
