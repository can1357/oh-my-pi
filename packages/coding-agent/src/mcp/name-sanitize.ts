/**
 * One identifier spelling for a tool or server name.
 *
 * Two alphabets, one function: the harness mint (`mcp__…` registry names) is
 * validator-strict — lowercase, hyphen folded to `_`, everything outside
 * `[a-z0-9_]` collapsed — while the filter domain additionally keeps the
 * hyphen, because tool names are hyphen-bearing in practice (SEP-986 names
 * `[a-zA-Z0-9_-]`) and a filter entry written for the hyphenated spelling
 * would otherwise not reach its tool. Both collapse runs, strip
 * leading/trailing `_`, and fall back when nothing survives.
 */
export function sanitizeMCPToolNamePart(value: string, fallback: string, keepHyphen = false): string {
	const folded = keepHyphen ? value.toLowerCase() : value.toLowerCase().replaceAll("-", "_");
	const sanitized = folded
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}
