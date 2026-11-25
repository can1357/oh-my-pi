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

/** Standard schemes no session may claim: web, file and mail links. */
const STANDARD_SCHEMES: Readonly<Record<string, true>> = {
	about: true,
	blob: true,
	data: true,
	file: true,
	ftp: true,
	http: true,
	https: true,
	javascript: true,
	mailto: true,
	ssh: true,
	ws: true,
	wss: true,
};

/** Whether lowercase `scheme` is a standard web, file or mail scheme. */
export function isStandardScheme(scheme: string): boolean {
	// `=== true`: inherited keys such as `constructor` are not reserved.
	return STANDARD_SCHEMES[scheme] === true;
}
