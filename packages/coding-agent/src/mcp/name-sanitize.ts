/**
 * One identifier spelling for a tool or server name: lowercase, everything
 * outside `[a-z]` collapsed to one `_`, runs collapsed, leading/trailing `_`
 * stripped, and a name that normalizes to nothing falling back. This is the
 * spelling every minted `mcp__server_tool` registry name is built from and the
 * spelling tool filters match against, so a pattern written for the
 * model-visible name keeps working.
 */
export function sanitizeMCPToolNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}
