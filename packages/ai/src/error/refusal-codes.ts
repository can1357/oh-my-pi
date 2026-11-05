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
 * Codes where every credential of the refusing organization sees the same verdict, so rotating to
 * a sibling spends it on a decided answer. This is the "may a sibling see something different"
 * question; whether a resend is worth trying is {@link UNSTABLE_REFUSAL_CODES}.
 */
export const CONTENT_POLICY_REFUSAL_CODES: Readonly<Record<string, true>> = {
	cyber_policy: true,
	reasoning_extraction: true,
};

/**
 * Codes whose verdict is not stable for the same input, so resending the identical request on the
 * same model may clear it. These earn the bounded same-model allowance (`retry.refusalRetries`).
 */
export const UNSTABLE_REFUSAL_CODES: Readonly<Record<string, true>> = {
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
	return (
		typeof value === "string" &&
		(Object.hasOwn(CONTENT_POLICY_REFUSAL_CODES, value) || Object.hasOwn(UNSTABLE_REFUSAL_CODES, value))
	);
}
