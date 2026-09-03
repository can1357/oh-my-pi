/**
 * Type-level assertion helpers for the ported arktype test suite.
 *
 * `Eq` is `true` only when `a` and `b` are exactly the same type, letting
 * ported `attest<X>(T.infer)` assertions survive as compile-time checks:
 *
 * ```ts
 * const _check: Eq<typeof T.infer, { name: string }> = true;
 * ```
 */
export type Eq<a, b> = (<t>() => t extends a ? 1 : 2) extends <t>() => t extends b ? 1 : 2 ? true : false;
