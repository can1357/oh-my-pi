/**
 * Scheme facts supplied by the internal URL host. pi-tui cannot import the
 * coding-agent router, so the router installs this bridge when it loads;
 * selector peeling and transcript renderers consult it instead of hardcoding
 * scheme names.
 */

/**
 * Mutation class of a writable scheme; drives plan-mode and device-only `write` gates.
 * - `workspace`: mutates user/external state; blocked in plan mode and device-only sessions.
 * - `sandbox`: session scratch space (local://); allowed in plan mode and device-only sessions.
 * - `coordination`: peer messaging (agent://); always allowed. `SchemeWritePolicy.cancels` grants the same per URL.
 * - `device`: tool-device dispatch (xd://); always allowed, the device enforces its own policy.
 * - `reply`: a message to the user (out://); always allowed, and transcripts draw the content as assistant prose.
 */
export type SchemeWriteScope = "workspace" | "sandbox" | "coordination" | "device" | "reply";

/** Renderer-relevant subset of a registered scheme's declared spec. */
export interface InternalUrlSchemeSpec {
	/** `lines`: a trailing `:<selector>` chain is a read selector; `none`/`opaque`: never peel. */
	readonly selectors: "lines" | "none" | "opaque";
	/** A trailing `:N` with no path after the authority is a port, not a selector (ssh://host:2222). */
	readonly portAuthority?: boolean;
	/** Read cards collapse into the compact read group like plain files instead of expanding. */
	readonly compactTranscript?: boolean;
	/** Write policy; absent on read-only schemes. Transcripts draw `reply`-scoped writes as assistant prose. */
	readonly write?: { readonly scope: SchemeWriteScope };
}

/** Scheme registry capabilities installed by the internal URL host. */
export interface InternalUrlSchemeHost {
	/** Declared spec of a registered scheme (case-insensitive); undefined when unregistered. */
	spec(scheme: string): InternalUrlSchemeSpec | undefined;
	/** Declared specs of every registered scheme, keyed by lowercased scheme. */
	specs(): ReadonlyMap<string, InternalUrlSchemeSpec>;
}

let schemeHost: InternalUrlSchemeHost | undefined;

/** Install the scheme registry. Until one is installed, no URL counts as an internal scheme. */
export function setInternalUrlSchemeHost(host: InternalUrlSchemeHost): void {
	schemeHost = host;
}

/** Declared spec of `scheme`; undefined when it is unregistered or no host is installed. */
export function internalUrlSchemeSpec(scheme: string): InternalUrlSchemeSpec | undefined {
	return schemeHost?.spec(scheme);
}

const NO_SPECS: ReadonlyMap<string, InternalUrlSchemeSpec> = new Map();

/** Declared specs of every registered scheme, keyed by lowercased scheme; empty when no host is installed. */
export function internalUrlSchemeSpecs(): ReadonlyMap<string, InternalUrlSchemeSpec> {
	return schemeHost?.specs() ?? NO_SPECS;
}

const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Split a hierarchical `scheme://rest` URL into its lowercased scheme and the text after `://`. */
export function splitUrlScheme(input: string): { scheme: string; rest: string } | undefined {
	const match = URL_SCHEME_RE.exec(input);
	return match ? { scheme: match[1].toLowerCase(), rest: input.slice(match[0].length) } : undefined;
}
