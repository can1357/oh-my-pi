/**
 * Pure MCP tool-name minting. Kept free of runtime imports (no transport, no
 * settings) so leaf modules — `session/settings` names the loop-guard exempt
 * tool by its minted key — can import it without closing an init cycle.
 */

/**
 * Create a unique tool name for an MCP tool.
 *
 * Prefixes with server name to avoid conflicts. If the tool name already
 * starts with the server name (e.g., server "puppeteer" with tool
 * "puppeteer_screenshot"), strips the redundant prefix to produce
 * "mcp__puppeteer_screenshot" instead of "mcp__puppeteer_puppeteer_screenshot".
 */
export function sanitizeMCPToolNamePart(value: string, fallback: string, keepDigits: boolean): string {
	const sanitized = value
		.toLowerCase()
		.replace(keepDigits ? /[^a-z0-9_]+/g : /[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * Shared mint pipeline. `keepDigits` selects the sanitizer variant: the
 * current mint keeps `0-9`, the legacy variant strips them exactly as the
 * pre-fix `sanitizeMCPToolNamePart` did. Both halves route through this one
 * function so the two mints can only ever differ by that character class —
 * if the prefix-strip or cap rules change, the legacy alias changes with them.
 */
function mintMCPToolName(serverName: string, toolName: string, keepDigits: boolean): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server", keepDigits);
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool", keepDigits);

	// Strip redundant server name prefix from tool name if present
	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return capMCPToolNameLength(`mcp__${sanitizedServerName}_${normalizedToolName}`);
}

/**
 * Longest tool name strict validators accept. OpenAI Responses/Completions and
 * Meta Responses enforce `^[a-zA-Z0-9_-]{1,64}$`; names over 64 chars are
 * rejected with HTTP 400 `name must be at most 64 characters` (#9130).
 */
const MAX_MCP_TOOL_NAME_LENGTH = 64;
/** Length of the deterministic hash suffix appended when a minted name overflows. */
const MCP_TOOL_NAME_HASH_LENGTH = 8;

/**
 * Cap a minted MCP tool name at {@link MAX_MCP_TOOL_NAME_LENGTH}. An overlong
 * name keeps a readable prefix and gains a deterministic base-36 hash suffix of
 * the full name, so distinct long names stay unique and the same name is stable
 * across turns — the model must call the exact registry key, and the hash is
 * seed-fixed so it never shifts between processes.
 */
export function capMCPToolNameLength(name: string): string {
	if (name.length <= MAX_MCP_TOOL_NAME_LENGTH) return name;
	const hash = Bun.hash(name).toString(36).slice(0, MCP_TOOL_NAME_HASH_LENGTH);
	const keep = MAX_MCP_TOOL_NAME_LENGTH - hash.length - 1;
	return `${name.slice(0, keep)}_${hash}`;
}

export function createMCPToolName(serverName: string, toolName: string): string {
	return mintMCPToolName(serverName, toolName, true);
}

/**
 * Mint the name {@link createMCPToolName} produced before digits were kept in
 * sanitized parts (`[^a-z_]+` collapsed to `_`). Digit-bearing servers/tools
 * were renamed by that fix, so user config keys written against the old form
 * (`tools.approval`, `tools.xdevInlineDevices`) would no longer match.
 * Approval resolution consults this legacy key as a fail-closed fallback.
 * Returns `undefined` when minting is unchanged (no digits involved).
 */
export function createLegacyMCPToolName(serverName: string, toolName: string): string | undefined {
	const legacyName = mintMCPToolName(serverName, toolName, false);
	const currentName = createMCPToolName(serverName, toolName);
	return legacyName !== currentName ? legacyName : undefined;
}
