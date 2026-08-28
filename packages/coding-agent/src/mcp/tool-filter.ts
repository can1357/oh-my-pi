/**
 * Per-server MCP tool filtering (`enabledTools` / `disabledTools`).
 *
 * Tool names are matched against the raw names the server advertises via
 * `tools/list` (not the `mcp__server_`-prefixed session names). Entries may be
 * literal tool names or fnmatch-style glob patterns (`"search"`, `"channel_*"`),
 * matching the wildcard vocabulary used by LangChain's MCP adapters and
 * Claude Code's `mcp__server__*` permissions deny patterns.
 *
 * Semantics, mirroring the server-level `enabledServers` / `disabledServers`
 * pair: an allowlist registers only matching tools, a denylist registers
 * everything except matching tools, and when both are set the denylist wins
 * (deny subtracts from allow).
 */
import { logger } from "@oh-my-pi/pi-utils";

/** A tool filter rule set for one server, with the raw advertised tool names. */
export interface MCPToolFilterInput {
	/** Raw tool names advertised by the server (from `tools/list`). */
	toolNames: string[];
	/** `enabledTools` from the server config, if any. */
	enabledTools?: readonly string[];
	/** `disabledTools` from the server config, if any. */
	disabledTools?: readonly string[];
}

/** Result of applying a tool filter. */
export interface MCPToolFilterResult {
	/** The subset of `toolNames` that passed the filter, in original order. */
	allowed: string[];
	/** Config entries that matched no advertised tool name, in config order. */
	unmatched: string[];
	/** True when a configured filter excluded every advertised tool; the healthy
	 * connection's stale tools must be cleared, not kept for transport-failure recovery. */
	filterEmpty: boolean;
}
/**
 * Translate an fnmatch-style glob pattern (over opaque tool names) into an
 * anchored `RegExp`. Unlike `Bun.Glob` (filesystem path semantics, where `*`
 * and `?` do not cross `/`), `*` and `?` here match any character including
 * `/`, because MCP tool names are opaque strings that may contain slashes.
 * Supports `*`, `?`, `[...]` (with `[!...]` negation), and non-nested
 * `{a,b,c}` brace alternation (wildcards inside alternatives are honored).
 */
function fnmatchRegex(pattern: string): RegExp {
	const escapeOutsideClass = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const translate = (start: number, end: number): string => {
		let out = "";
		let i = start;
		while (i < end) {
			const ch = pattern[i];
			if (ch === "*") {
				out += ".*";
				i++;
			} else if (ch === "?") {
				out += ".";
				i++;
			} else if (ch === "[") {
				const classStart = i;
				i++;
				let cls = "";
				if (pattern[i] === "!") {
					cls += "^";
					i++;
				}
				// a leading ^ is a literal member in fnmatch (only ! negates);
				// escape it so JavaScript doesn't read the class as negated
				if (pattern[i] === "^") {
					cls += "\\^";
					i++;
				}
				// a leading ] (first class body char) is a literal member
				if (cls === "" && pattern[i] === "]") {
					cls += "\\]";
					i++;
				}
				while (i < end && pattern[i] !== "]") {
					cls += pattern[i] === "\\" ? "\\\\" : pattern[i];
					i++;
				}
				if (i >= end) {
					// unterminated — treat the literal `[` (and body) as escaped text
					out += escapeOutsideClass(pattern.slice(classStart, end));
					i = end;
				} else {
					out += `[${cls}]`;
					i++; // consume ]
				}
			} else if (ch === "{") {
				const close = pattern.indexOf("}", i + 1);
				if (close === -1 || close >= end || pattern.slice(i + 1, close).includes("{")) {
					out += "\\{";
					i++;
					continue;
				}
				// Split the body on top-level commas (commas inside a `[...]` class
				// don't split). Translate each alternative so wildcards stay active.
				const parts: string[] = [];
				let segStart = i + 1;
				let classDepth = 0;
				for (let j = i + 1; j < close; j++) {
					const c = pattern[j];
					if (c === "[") classDepth++;
					else if (c === "]" && classDepth > 0) classDepth--;
					else if (c === "," && classDepth === 0) {
						parts.push(translate(segStart, j));
						segStart = j + 1;
					}
				}
				// Expand only real alternation; braces without a comma are literal
				// (`{delete}` matches `admin_{delete}`, not `admin_delete`).
				if (parts.length === 0) {
					out += "\\{";
					i++;
				} else {
					parts.push(translate(segStart, close));
					out += `(?:${parts.join("|")})`;
					i = close + 1;
				}
			} else {
				out += escapeOutsideClass(ch);
				i++;
			}
		}
		return out;
	};
	return new RegExp(`^${translate(0, pattern.length)}$`);
}

/**
 * Apply a per-server tool filter.
 *
 * Literal entries match exactly; entries containing glob metacharacters
 * (`*`, `?`, `[...]`, `{...}`) are matched with fnmatch semantics where
 * `*` and `?` cross `/` — MCP tool names are opaque strings, not paths, so a
 * denylist entry like `*` must match a tool named `admin/delete`. Denylist
 * entries subtract from the allowlist when both are set.
 */
export function filterMCPTools(input: MCPToolFilterInput): MCPToolFilterResult {
	const { toolNames, enabledTools, disabledTools } = input;
	const filterConfigured = Boolean(enabledTools?.length || disabledTools?.length);
	if (!filterConfigured) {
		return { allowed: [...toolNames], unmatched: [], filterEmpty: false };
	}

	const matches = (name: string, pattern: string): boolean => {
		if (pattern === name) return true;
		if (!/[*?[\]{}]/.test(pattern)) return false;
		try {
			return fnmatchRegex(pattern).test(name);
		} catch {
			return false;
		}
	};

	let allowed: string[];
	let unmatched: string[];

	if (enabledTools?.length) {
		allowed = toolNames.filter(name => enabledTools.some(pattern => matches(name, pattern)));
		unmatched = enabledTools.filter(pattern => !toolNames.some(name => matches(name, pattern)));
	} else {
		allowed = [...toolNames];
		unmatched = [];
	}

	if (disabledTools?.length) {
		allowed = allowed.filter(name => !disabledTools.some(pattern => matches(name, pattern)));
		unmatched = [...unmatched, ...disabledTools.filter(pattern => !toolNames.some(name => matches(name, pattern)))];
	}

	return { allowed, unmatched, filterEmpty: allowed.length === 0 && toolNames.length > 0 };
}

/**
 * Apply a per-server tool filter and surface diagnostics.
 *
 * Unknown entries (patterns matching no advertised tool) are warned about —
 * a typo is a config bug, but a server renaming tools upstream must degrade
 * to "filter ignored" rather than disabling an otherwise usable server.
 *
 * Never throws: an all-excluding filter logs once and returns `[]`, so callers
 * clear stale tools instead of treating a healthy connection as a failure.
 */
export function applyMCPToolFilter(serverName: string, input: MCPToolFilterInput): string[] {
	const { allowed, unmatched, filterEmpty } = filterMCPTools(input);
	const { toolNames, enabledTools, disabledTools } = input;

	if (unmatched.length > 0) {
		logger.warn(`MCP server "${serverName}": tool filter entries matched no advertised tool; ignoring them`, {
			path: `mcp:${serverName}`,
			unmatched,
			advertised: toolNames,
		});
	}

	if (filterEmpty) {
		logger.error(
			`MCP server "${serverName}": tool filter (enabledTools=${JSON.stringify(enabledTools)}, disabledTools=${JSON.stringify(disabledTools)}) excludes all ${toolNames.length} advertised tools; the server would contribute nothing to the session. Remove the filter or widen it.`,
			{ path: `mcp:${serverName}` },
		);
		return [];
	}

	return allowed;
}
