/**
 * Internal URL scheme syntax shared by the router, selector peeling and
 * transcript presenters.
 */

/**
 * Mutation class of a writable scheme; drives the plan-mode `write` gate.
 * - `workspace`: mutates user/external state; blocked in plan mode.
 * - `sandbox`: session scratch space (local://); allowed in plan mode.
 * - `coordination`: peer messaging (agent://); always allowed. `SchemeWritePolicy.cancels` grants the same per URL.
 * - `reply`: a message to the user (out://); always allowed, and transcripts draw the content as assistant prose.
 */
export type SchemeWriteScope = "workspace" | "sandbox" | "coordination" | "reply";

const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Split a hierarchical `scheme://rest` URL into its lowercased scheme and the text after `://`. */
export function splitUrlScheme(input: string): { scheme: string; rest: string } | undefined {
	const match = URL_SCHEME_RE.exec(input);
	return match ? { scheme: match[1].toLowerCase(), rest: input.slice(match[0].length) } : undefined;
}
