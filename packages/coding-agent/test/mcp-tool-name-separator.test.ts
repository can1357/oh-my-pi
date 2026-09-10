/**
 * Regression test: a Claude-Code-shaped `mcp__<server>__<tool>` call must
 * resolve to the registry key OMP mints, `mcp__<server>_<tool>` (#11516).
 *
 * OMP advertises a Claude Code identity to Anthropic endpoints, so a model
 * trained on that client emits its double-underscore separator while dispatch
 * exact-matches OMP's single-underscore key — the call fails with
 * `Tool <name> not found` though the server and tool both exist.
 *
 * The repair re-mints through `createMCPToolName` rather than splicing the
 * separator, because sanitization is lossy: `sanitizeMCPToolNamePart` maps
 * `[^a-z_]+` to `_` and strips edges, so server `context7` becomes `context`
 * and the real key is `mcp__context_resolve_library_id`. A literal collapse
 * yields `mcp__context7_resolve_library_id` and still misses.
 */
import { describe, expect, it } from "bun:test";
import { collapseMCPToolNameSeparator, createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";

/** Exactly what `createMCPToolName` mints for these servers. */
const REGISTERED: Record<string, true> = {
	[createMCPToolName("context7", "resolve_library_id")]: true,
	[createMCPToolName("brave-search", "web_search")]: true,
	[createMCPToolName("github", "create_issue")]: true,
};

const isRegistered = (candidate: string): boolean => REGISTERED[candidate] === true;

describe("collapseMCPToolNameSeparator", () => {
	it("re-mints segments to the registry key, applying lossy sanitization", () => {
		// Trailing-strip branch: the digit becomes `_`, then edge-strips away, so
		// the key is `context`, not `context7`. A literal separator splice misses.
		expect(REGISTERED["mcp__context_resolve_library_id"]).toBe(true);
		expect(collapseMCPToolNameSeparator("mcp__context7__resolve_library_id", isRegistered)).toBe(
			"mcp__context_resolve_library_id",
		);
		// Internal-replace branch: the hyphen becomes an underscore.
		expect(collapseMCPToolNameSeparator("mcp__brave-search__web_search", isRegistered)).toBe(
			"mcp__brave_search_web_search",
		);
		// Already-sanitized segments re-mint unchanged.
		expect(collapseMCPToolNameSeparator("mcp__github__create_issue", isRegistered)).toBe("mcp__github_create_issue");
	});

	it("preserves the failure when the re-minted key is not registered", () => {
		// Unknown server: repairing a separator must not invent a target.
		expect(collapseMCPToolNameSeparator("mcp__stripe__create_charge", isRegistered)).toBeUndefined();
	});

	it("does not repair a name the model reconstructed rather than mis-separated", () => {
		// Doubled-prefix and bare-namespace shapes are transcription damage, not a
		// separator mismatch; they must keep failing rather than bind to some
		// unrelated tool.
		expect(
			collapseMCPToolNameSeparator("mcp__oclqnh2yz7ln__mcp__oclqnh2yz7ln__k3wwvy6fs5ah_read", isRegistered),
		).toBeUndefined();
		expect(collapseMCPToolNameSeparator("mcp__oclqnh2yz7ln__glob", isRegistered)).toBeUndefined();
	});

	it("leaves already-correct and non-MCP names untouched", () => {
		// Already the registry key: no second separator, so nothing to repair.
		expect(collapseMCPToolNameSeparator("mcp__github_create_issue", isRegistered)).toBeUndefined();
		// Builtins must never be rewritten by MCP name repair.
		expect(collapseMCPToolNameSeparator("read", isRegistered)).toBeUndefined();
	});
});
