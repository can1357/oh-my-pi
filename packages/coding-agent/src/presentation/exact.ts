/**
 * Compile-time type identity, and why mutual assignability is not it.
 *
 * The parity assertions that pin each zod schema against its producer's own
 * interface used to be written with a mutual-assignability check:
 *
 * ```ts
 * type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
 * ```
 *
 * That does not detect **optional-field drift**, which is the drift that actually
 * happens. Add `extra?: string` to one side and both directions still hold: the
 * wider type satisfies `extends` because excess properties are allowed there, and
 * the narrower type satisfies it because an optional property need not be present.
 * So a producer could gain, lose or rename an optional field — exactly the fields
 * that gate a fact — and the "parity" test stayed green.
 *
 * {@link IsExact} compares the two types in an invariant position instead, so it is
 * `true` only for identical types. It is the conditional-type identity trick: two
 * generic signatures are mutually assignable only when their deferred conditional
 * types are structurally identical, which TypeScript decides by comparing `A` and
 * `B` themselves rather than by assignability in either direction.
 */

/** `true` only when `A` and `B` are the *same* type, optional modifiers included. */
export type IsExact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** `true` only when `K` is not a key of `T`. Used to keep a surface closed. */
export type LacksKey<T, K extends string> = K extends keyof T ? false : true;

// ---------------------------------------------------------------------------
// Negative fixtures for the mechanism itself.
//
// Each `@ts-expect-error` below is the assertion: if `IsExact` ever went back to
// mutual assignability these expressions would type-check, the directive would
// become unused, and TypeScript would fail the file with TS2578. They are
// deliberately inside the strict presentation project so its own check enforces
// them.
// ---------------------------------------------------------------------------

interface DriftBaseline {
	readonly kept: string;
	readonly optional?: number;
}

/** An added optional property. The classic silent drift. */
interface DriftAddedOptional {
	readonly kept: string;
	readonly optional?: number;
	readonly added?: boolean;
}

/** A removed optional property. */
interface DriftRemovedOptional {
	readonly kept: string;
}

/** A renamed optional property. */
interface DriftRenamedOptional {
	readonly kept: string;
	readonly renamed?: number;
}

/** A retyped optional property. */
interface DriftRetypedOptional {
	readonly kept: string;
	readonly optional?: string;
}

// @ts-expect-error -- an added optional property is drift, so this must not be `true`.
const addedOptionalIsDrift: IsExact<DriftBaseline, DriftAddedOptional> = true;
// @ts-expect-error -- a removed optional property is drift.
const removedOptionalIsDrift: IsExact<DriftBaseline, DriftRemovedOptional> = true;
// @ts-expect-error -- a renamed optional property is drift.
const renamedOptionalIsDrift: IsExact<DriftBaseline, DriftRenamedOptional> = true;
// @ts-expect-error -- a retyped optional property is drift.
const retypedOptionalIsDrift: IsExact<DriftBaseline, DriftRetypedOptional> = true;

/** Identity still holds for genuinely identical types. */
const identityHolds: IsExact<DriftBaseline, { readonly kept: string; readonly optional?: number }> = true;

/**
 * The fixtures above are compile-time only; this keeps the bindings referenced so
 * `noUnusedLocals`-style lint passes cannot delete the assertions as dead code.
 */
export const EXACTNESS_FIXTURES: readonly boolean[] = [
	addedOptionalIsDrift,
	removedOptionalIsDrift,
	renamedOptionalIsDrift,
	retypedOptionalIsDrift,
	identityHolds,
];
