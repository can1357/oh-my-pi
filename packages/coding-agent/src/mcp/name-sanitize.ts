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
 * advertises separately (`read` vs `READ`). Both collapse runs and strip
 * leading/trailing `_`.
 */
export function sanitizeMCPToolNamePart(value: string, fallback: string, keepHyphen = false): string {
	const folded = keepHyphen ? value : value.toLowerCase().replaceAll("-", "_");
	const sanitized = folded
		.replace(keepHyphen ? /[^A-Za-z0-9_-]+/g : /[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}
