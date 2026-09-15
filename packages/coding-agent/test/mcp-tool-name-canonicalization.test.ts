import { describe, expect, it } from "bun:test";
import {
	canonicalMCPToolNameCandidates,
	createMCPToolName,
	resolveMCPToolAlias,
} from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { resolveMountedXdevExecutable, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools/index";

// `createMCPToolName` joins the sanitized server and tool with a SINGLE
// underscore, but the harness identifies itself to the model as Claude Code,
// whose convention is `mcp__<server>__<tool>`. A primed model therefore emits
// the doubled separator — frequently keeping the raw, unsanitized server
// spelling too (`mcp__seedpatch-client__bank`) — and strict exact-match
// dispatch answered every one of those with `Tool ... not found` for a tool the
// session really does expose.
//
// Every expectation below is asserted against the key `createMCPToolName`
// actually mints, so these tests cannot drift from the minting rule they are
// recovering.

describe("canonicalMCPToolNameCandidates", () => {
	/** First candidate that the registry would accept, for a one-tool registry. */
	const recover = (emitted: string, registered: string): string | undefined =>
		canonicalMCPToolNameCandidates(emitted).find(candidate => candidate === registered);

	it("recovers the registry key from the Claude Code separator", () => {
		const registered = createMCPToolName("seedpatch-client", "bank");
		expect(registered).toBe("mcp__seedpatch_client_bank");

		// Raw hyphenated server name + doubled separator: what a Claude
		// Code-primed model emits for a server literally named `seedpatch-client`.
		expect(recover("mcp__seedpatch-client__bank", registered)).toBe(registered);
		// Sanitized server name + doubled separator.
		expect(recover("mcp__seedpatch_client__bank", registered)).toBe(registered);
		// Single separator whose punctuation still differs from the minted key.
		expect(recover("mcp__seedpatch-client_bank", registered)).toBe(registered);
	});

	it("recovers multi-word tool names", () => {
		const registered = createMCPToolName("osrs-wiki", "search_cache");
		expect(recover("mcp__osrs-wiki__search_cache", registered)).toBe(registered);
		expect(recover("mcp__osrs_wiki__search_cache", registered)).toBe(registered);
	});

	it("recovers a name whose server segment carries digits", () => {
		// The sanitizer maps `[^a-z_]+` to `_`, so the digit in `context7` is
		// dropped when the name is minted. The doubled spelling must still land.
		const registered = createMCPToolName("context7", "resolve-library-id");
		expect(registered).toBe("mcp__context_resolve_library_id");
		expect(recover("mcp__context7__resolve_library_id", registered)).toBe(registered);
	});

	it("recovers a tool whose name repeats the server prefix", () => {
		// `createMCPToolName` strips the redundant prefix, so server `puppeteer`
		// with tool `puppeteer_screenshot` registers as `mcp__puppeteer_screenshot`.
		// Re-minting the split halves reproduces that; merely sanitizing the whole
		// suffix would yield the nonexistent `mcp__puppeteer_puppeteer_screenshot`.
		const registered = createMCPToolName("puppeteer", "puppeteer_screenshot");
		expect(registered).toBe("mcp__puppeteer_screenshot");
		expect(recover("mcp__puppeteer__puppeteer_screenshot", registered)).toBe(registered);
	});

	it("recovers when the raw server name itself contains a doubled separator", () => {
		// A *sanitized* server segment can never contain `__`, but the model emits
		// the raw name, which can. Splitting only at the first occurrence would
		// put the boundary inside the server and miss the key entirely.
		const registered = createMCPToolName("foo__bar", "foo_bar_baz");
		expect(registered).toBe("mcp__foo_bar_baz");
		expect(recover("mcp__foo__bar__foo_bar_baz", registered)).toBe(registered);

		// The common case must still rank first: with no `__` in the server name
		// the earliest boundary is the right one.
		const plain = createMCPToolName("seedpatch-client", "bank");
		expect(canonicalMCPToolNameCandidates("mcp__seedpatch-client__bank")[0]).toBe(plain);
	});

	it("recovers a name long enough to be hash-capped", () => {
		// Over 64 chars the minted key keeps a readable prefix plus a hash, so a
		// candidate built without the cap could never match it.
		const longTool = "a_very_long_tool_name_that_definitely_overflows_the_sixty_four_char_cap";
		const registered = createMCPToolName("srv", longTool);
		expect(registered.length).toBe(64);
		expect(recover(`mcp__srv__${longTool}`, registered)).toBe(registered);

		// Single-separator spelling of the same overlong tool: there is no
		// boundary to re-mint from, so this candidate needs the cap applied
		// directly or it can never match the hashed key either.
		const hyphenated = createMCPToolName("seedpatch-client", longTool);
		expect(hyphenated.length).toBe(64);
		expect(recover(`mcp__seedpatch-client_${longTool}`, hyphenated)).toBe(hyphenated);
	});

	it("yields nothing for an already-canonical name so exact match stays authoritative", () => {
		// An empty candidate list is what keeps this off the hot path: a registered
		// name is found by direct lookup and never reaches canonicalization.
		expect(canonicalMCPToolNameCandidates(createMCPToolName("seedpatch-client", "bank"))).toEqual([]);
		expect(canonicalMCPToolNameCandidates(createMCPToolName("osrs-wiki", "search_cache"))).toEqual([]);
		expect(canonicalMCPToolNameCandidates(createMCPToolName("puppeteer", "puppeteer_screenshot"))).toEqual([]);
	});

	it("never routes a non-MCP name", () => {
		// The registry holds first-party tools under bare names; canonicalization
		// must not offer a path to them from a hallucinated call.
		expect(canonicalMCPToolNameCandidates("read")).toEqual([]);
		expect(canonicalMCPToolNameCandidates("edit")).toEqual([]);
		expect(canonicalMCPToolNameCandidates("mcp__")).toEqual([]);
	});

	it("recovers a server name the sanitizer reduces to its placeholder", () => {
		// `validateServerName` accepts `^[a-zA-Z0-9_.:-]+$`, so an all-digit or
		// all-punctuation server name is configurable — and sanitizes away, which
		// makes `createMCPToolName` substitute its `server` placeholder. That is
		// the key registration really produces, so re-minting the split has to
		// reproduce it rather than refuse the name.
		for (const serverName of ["123", "1-2", "..."]) {
			const registered = createMCPToolName(serverName, "bank");
			expect(registered).toBe("mcp__server_bank");
			expect(recover(`mcp__${serverName}__bank`, registered)).toBe(registered);
		}
	});

	it("yields no split candidate when a half is genuinely absent", () => {
		// A missing half describes no split at all, so there is nothing faithful
		// to re-mint: the placeholder pair would be a key nobody registered.
		expect(canonicalMCPToolNameCandidates("mcp____")).toEqual([]);
		expect(canonicalMCPToolNameCandidates("mcp__")).toEqual([]);
		// Present-but-empty halves must not reach `createMCPToolName`.
		expect(canonicalMCPToolNameCandidates("mcp____bank")).not.toContain("mcp__server_bank");
		expect(canonicalMCPToolNameCandidates("mcp__srv__")).not.toContain("mcp__srv_tool");
	});

	it("keeps servers distinct whose sanitized names prefix-collide", () => {
		// `atlassian` vs `atlassian:atlassian` is the documented lossy-sanitization
		// hazard: a fuzzy matcher would conflate them. Each Claude Code spelling
		// must reach its own server's key and nothing else.
		const short = createMCPToolName("atlassian", "get_issue");
		const colon = createMCPToolName("atlassian:atlassian", "get_issue");
		expect(short).not.toBe(colon);

		expect(canonicalMCPToolNameCandidates("mcp__atlassian__get_issue")).not.toContain(colon);
		expect(recover("mcp__atlassian__get_issue", short)).toBe(short);
		expect(recover("mcp__atlassian:atlassian__get_issue", colon)).toBe(colon);
	});
});

/** Minimal state exposing the fields the mounted resolver reads. */
function xdevStateWith(options: { mounted?: string[]; active?: string[] }): XdevState {
	const mounted = options.mounted ?? [];
	const active = options.active ?? [];
	const tools = new Map<string, Tool>();
	for (const name of [...mounted, ...active]) tools.set(name, { name } as Tool);
	return {
		tools,
		mountedNames: new Set(mounted),
		builtInNames: new Set(),
		isActive: name => active.includes(name),
	};
}

describe("resolveMountedXdevExecutable", () => {
	it("resolves mounted devices only, never the active set", () => {
		const bank = createMCPToolName("seedpatch-client", "bank");
		const state = xdevStateWith({ mounted: ["github"], active: [bank] });

		expect(resolveMountedXdevExecutable(state, "github")?.name).toBe("github");
		expect(resolveMountedXdevExecutable(state, "xd://github")?.name).toBe("github");
		// Active but unmounted. Under Code Mode `#applyActiveToolsByName` clears
		// the mounted set while leaving the active predicate on the whole enabled
		// slate, so resolving active names here would dispatch a tool deliberately
		// demoted behind the eval bridge.
		expect(resolveMountedXdevExecutable(state, bank)).toBeUndefined();
	});
});

describe("resolveMCPToolAlias", () => {
	const bank = createMCPToolName("seedpatch-client", "bank");
	/** Lookup over one explicit name set — the shape every caller passes. */
	const over =
		(names: readonly string[]) =>
		(candidate: string): { name: string } | undefined =>
			names.includes(candidate) ? { name: candidate } : undefined;
	// What the isolated auto-learn capture agent advertises.
	const captureTools = ["learn", "manage_skill"];

	it("resolves only through the lookup it is given", () => {
		// The hazard this signature exists to prevent: one agent's resolver
		// reused for another. A capture response emitting the predictable
		// doubled spelling must not reach a main-session MCP tool.
		expect(resolveMCPToolAlias("mcp__seedpatch-client__bank", over(["read", bank]))?.name).toBe(bank);
		expect(resolveMCPToolAlias("mcp__seedpatch-client__bank", over(captureTools))).toBeUndefined();
		expect(resolveMCPToolAlias("mcp__seedpatch-client__bank", over([]))).toBeUndefined();
	});

	it("never resolves a non-MCP name even when that tool is advertised", () => {
		expect(resolveMCPToolAlias("read", over(["read", bank]))).toBeUndefined();
		expect(resolveMCPToolAlias("learn", over(captureTools))).toBeUndefined();
	});

	it("leaves an exactly-advertised name to the caller's own exact match", () => {
		// An already-canonical name yields no candidates, so dispatch's primary
		// lookup stays authoritative and this never shadows it.
		expect(resolveMCPToolAlias(bank, over([bank]))).toBeUndefined();
	});

	it("refuses an ambiguous alias rather than picking a boundary", () => {
		// Two boundaries, two genuinely registered tools, one emitted spelling:
		// nothing in the name says which was meant. MCP tools have side effects,
		// so guessing by candidate order could run an operation the model never
		// asked for. Refusing keeps it a recoverable `not found`.
		const viaFirst = createMCPToolName("foo", "bar__foo_bar_baz");
		const viaSecond = createMCPToolName("foo__bar", "foo_bar_baz");
		expect(viaFirst).not.toBe(viaSecond);

		const emitted = "mcp__foo__bar__foo_bar_baz";
		expect(canonicalMCPToolNameCandidates(emitted)).toEqual(expect.arrayContaining([viaFirst, viaSecond]));
		expect(resolveMCPToolAlias(emitted, over([viaFirst, viaSecond]))).toBeUndefined();

		// Each alone is unambiguous and still resolves.
		expect(resolveMCPToolAlias(emitted, over([viaFirst]))?.name).toBe(viaFirst);
		expect(resolveMCPToolAlias(emitted, over([viaSecond]))?.name).toBe(viaSecond);
	});

	it("refuses an alias ambiguous ACROSS presentation sets", () => {
		// `sdk.ts` folds mounted devices and the agent's advertised tools into ONE
		// lookup so uniqueness spans their union. Resolving each set with its own
		// call and taking the first hit would let a mounted match quietly win a
		// call that is ambiguous overall.
		const mountedName = createMCPToolName("foo", "bar__foo_bar_baz");
		const advertisedName = createMCPToolName("foo__bar", "foo_bar_baz");
		const state = xdevStateWith({ mounted: [mountedName] });
		const advertised = [{ name: advertisedName }];
		const emitted = "mcp__foo__bar__foo_bar_baz";

		const union = (candidate: string): { name: string } | undefined =>
			resolveMountedXdevExecutable(state, candidate) ?? advertised.find(t => t.name === candidate);
		expect(resolveMCPToolAlias(emitted, union)).toBeUndefined();

		// Either set on its own still resolves; only the union is ambiguous.
		expect(resolveMCPToolAlias(emitted, candidate => resolveMountedXdevExecutable(state, candidate))?.name).toBe(
			mountedName,
		);
		expect(resolveMCPToolAlias(emitted, over([advertisedName]))?.name).toBe(advertisedName);
	});
});
