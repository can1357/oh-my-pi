/**
 * The refusal vocabulary: which provider codes name a content refusal, and what each membership
 * means. A leaf module with no imports, because two different layers need it and neither may
 * depend on the other — the classifier (`./flags`) asks what a code *means*, and the envelope
 * resolver (`./classes`) asks whether a string *is* a code at all.
 *
 * That second question is not a convenience. A wire body can put a refusal code in `type`, and a
 * stream frame puts its own name there, and the two are structurally identical:
 * `{ type: "error", error: { code: "cyber_policy" } }` must read the inner object, while
 * `{ type: "cyber_policy", error: { code: "server_error" } }` must read the root. Nothing about
 * the shape separates them — only whether the string is a code we know. So the vocabulary is what
 * disambiguates, and it lives here so that asking it creates no cycle.
 */

/**
 * The refusal codes this system knows.
 *
 * Membership answers two questions, and today every member answers both the same way:
 *
 * - **is rotating to a sibling credential a recovery?** No. The classifier belongs to the
 *   refusing organization, not to the key, so the siblings this rotation would spend are the
 *   ones that answer the same way ({@link isContentPolicyRefusal}).
 * - **is the verdict stable for the same input?** No. The classifier is probabilistic, so
 *   resending the identical request on the same model may clear it, and these codes earn the
 *   bounded same-model allowance `retry.refusalRetries` ({@link isUnstableProviderRefusal}).
 *
 * A code that ever answers them differently — refused identically on every resend, say — splits
 * this into two tables at that point, not before.
 */
export const REFUSAL_CODES: Readonly<Record<string, true>> = {
	cyber_policy: true,
	reasoning_extraction: true,
};

/**
 * Whether a string is a refusal code this system knows, rather than a frame name or free text.
 *
 * Used by the envelope resolver to decide whether a root `type` is the error's own code. A code
 * outside this vocabulary is read as a frame name and the resolver prefers a nested envelope —
 * the one residual of the disambiguation, and the reason adding a code here is also what teaches
 * the resolver to find it.
 */
export function isKnownRefusalCode(value: unknown): value is string {
	return typeof value === "string" && Object.hasOwn(REFUSAL_CODES, value);
}
