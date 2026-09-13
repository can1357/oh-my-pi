/**
 * One identifier spelling for a tool or server name.
 *
 * Two alphabets, one function: the harness mint (`mcp__…` registry names) is
 * validator-strict — lowercase, hyphen folded to `_`, every digit or other
 * non-`[a-z_]` character collapsed and the caller's placeholder substituted
 * when nothing survives — while the filter domain keeps the case, the digits,
 * and the hyphen, because tool names are hyphen-bearing and case-bearing in
 * practice (SEP-986 names `[a-zA-Z0-9_-]`). A filter entry written for the
 * hyphenated spelling would otherwise not reach its tool, and folding case
 * would let a literal entry admit a differently-cased sibling the server
 * advertises separately (`read` vs `READ`). A value already inside its
 * domain's alphabet is returned unchanged, so the filter domain stays
 * injective over the advertised names it must distinguish; a value outside it
 * has its runs collapsed and its leading/trailing `_` stripped to reach a
 * spelling both domains can address.
 */
export function sanitizeMCPToolNamePart(value: string, fallback: string, keepHyphen = false): string {
	const folded = keepHyphen ? value : value.toLowerCase().replaceAll("-", "_");
	const alphabet = keepHyphen ? /^[A-Za-z0-9_-]+$/ : /^[a-z_]+$/;
	// Already inside the alphabet: return it byte-identical. The filter domain is
	// an advertised-name domain, and `_` is part of that alphabet, so collapsing
	// or trimming here would make the domain non-injective — an entry for `read`
	// would also select a separately advertised `_read`, and `foo_bar` would
	// also select `foo__bar`. The mint domain still normalizes unconditionally,
	// because it builds `mcp__<server>_<tool>` where a stray or doubled
	// underscore would corrupt the server/tool boundary.
	if (alphabet.test(folded)) return folded;
	const sanitized = folded
		.replace(keepHyphen ? /[^A-Za-z0-9_-]+/g : /[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}
