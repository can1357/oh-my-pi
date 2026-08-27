import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

describe("parseAgentFields", () => {
	test("parses blocking from boolean frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: true,
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(true);
	});

	test("parses blocking from string frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "false",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(false);
	});

	test("ignores invalid blocking values", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "sometimes",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBeUndefined();
	});
	test("parses legacy thinking key", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "medium",
		});

		expect(fields).toBeDefined();
		expect(fields?.thinkingLevel).toBe(Effort.Medium);
	});

	test("prefers thinking-level over legacy thinking", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "minimal",
			thinkingLevel: Effort.High,
		});

		expect(fields?.thinkingLevel).toBe(Effort.High);
	});
	test("accepts the auto thinking selector", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "auto",
		});

		expect(fields?.thinkingLevel).toBe(AUTO_THINKING);
	});

	test("rejects unknown thinking selectors", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "turbo",
		});

		expect(fields?.thinkingLevel).toBeUndefined();
	});

	test("lowercases tool names", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Read", "Search"],
		});

		expect(fields?.tools).toEqual(["read", "grep", "yield"]);
	});
	test("keeps an explicitly empty tools list distinct from an absent one", () => {
		expect(parseAgentFields({ name: "quiet", description: "desc", tools: [] })?.tools).toEqual(["yield"]);
		expect(parseAgentFields({ name: "quiet", description: "desc" })?.tools).toBeUndefined();
	});

	test("maps legacy search and find tool names", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Find", "Glob", "Search", "Grep"],
		});

		expect(fields?.tools).toEqual(["glob", "grep", "yield"]);
	});

	test("parses autoloadSkills from array frontmatter", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: ["user-created-skill-a", "user-created-skill-b"],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("parses autoloadSkills from CSV string", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: "user-created-skill-a, user-created-skill-b",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("returns undefined autoloadSkills when field absent", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("returns undefined autoloadSkills for empty array", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: [],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("parses readSummarize from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: false })?.readSummarize).toBe(false);
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: true })?.readSummarize).toBe(true);
	});

	test("parses readSummarize from string frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: "false" })?.readSummarize).toBe(
			false,
		);
	});

	test("ignores invalid readSummarize values", () => {
		expect(
			parseAgentFields({ name: "scout", description: "desc", readSummarize: "nope" })?.readSummarize,
		).toBeUndefined();
	});

	test("returns undefined readSummarize when field absent", () => {
		expect(parseAgentFields({ name: "scout", description: "desc" })?.readSummarize).toBeUndefined();
	});

	test("normalizes and dedupes xdevPromote names, preserving mcp__ case", () => {
		// Builtin names fold via the canonical map; mcp__ names pass through
		// unchanged here — uppercase folding happens only when the promote set
		// is compiled (compileXdevPromoteSet), not in shared normalization.
		expect(
			parseAgentFields({
				name: "scout",
				description: "desc",
				xdevPromote: ["LSP", "mcp__Context7_Resolve", "lsp"],
			})?.xdevPromote,
		).toEqual(["lsp", "mcp__Context7_Resolve"]);
	});

	test("keeps uppercase mcp__ tools entries from newly matching minted names", () => {
		// Shared `tools:` allowlist semantics are untouched: a non-builtin
		// name passes through normalizeToolNames verbatim, so an uppercase
		// mcp__ entry cannot start matching the lowercase minted tool name.
		expect(parseAgentFields({ name: "scout", description: "desc", tools: ["MCP__Context_Resolve"] })?.tools).toEqual([
			"MCP__Context_Resolve",
			"yield",
		]);
	});

	test("parses xdevPromote from CSV string", () => {
		expect(
			parseAgentFields({
				name: "scout",
				description: "desc",
				xdevPromote: "lsp, mcp__context7_resolve_library_id",
			})?.xdevPromote,
		).toEqual(["lsp", "mcp__context7_resolve_library_id"]);
	});

	test("returns undefined xdevPromote when field absent, [] when explicitly empty", () => {
		// Absent inherits the global tools.xdevPromote...
		expect(parseAgentFields({ name: "scout", description: "desc" })?.xdevPromote).toBeUndefined();
		// ...while an explicit empty value clears it ([] is distinguishable from absent).
		expect(parseAgentFields({ name: "scout", description: "desc", xdevPromote: [] })?.xdevPromote).toEqual([]);
		expect(parseAgentFields({ name: "scout", description: "desc", xdevPromote: "" })?.xdevPromote).toEqual([]);
	});

	test("ignores malformed xdevPromote values instead of clearing the inherited promotion", () => {
		// false / 0 / objects are not documented empty forms; they must be
		// treated as absent (undefined) so a parent's tools.xdevPromote
		// survives, not as an explicit empty override.
		expect(parseAgentFields({ name: "scout", description: "desc", xdevPromote: false })?.xdevPromote).toBeUndefined();
		expect(parseAgentFields({ name: "scout", description: "desc", xdevPromote: 0 })?.xdevPromote).toBeUndefined();
		expect(
			parseAgentFields({ name: "scout", description: "desc", xdevPromote: { a: 1 } })?.xdevPromote,
		).toBeUndefined();
		expect(
			parseAgentFields({ name: "scout", description: "desc", xdevPromote: [false, 1] })?.xdevPromote,
		).toBeUndefined();
		// Whitespace-only strings still count as the documented empty form.
		expect(parseAgentFields({ name: "scout", description: "desc", xdevPromote: "  " })?.xdevPromote).toEqual([]);
	});
	test("parses prewalk from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: true })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: false })?.prewalk).toBe(false);
	});

	test("parses prewalk boolean strings as booleans", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "true" })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "false" })?.prewalk).toBe(false);
	});

	test("parses prewalk model pattern strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: " @smol " })?.prewalk).toBe("@smol");
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "openai/gpt-5-mini" })?.prewalk).toBe(
			"openai/gpt-5-mini",
		);
	});

	test("ignores empty and absent prewalk values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "  " })?.prewalk).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.prewalk).toBeUndefined();
	});
	test("parses advisor from boolean frontmatter and boolean strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: true })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: false })?.advisor).toBe(false);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "true" })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "false" })?.advisor).toBe(false);
	});

	test("parses advisor model pattern strings and ignores empty/absent values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: " moonshot/k3 " })?.advisor).toBe(
			"moonshot/k3",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "@smol:high" })?.advisor).toBe(
			"@smol:high",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "  " })?.advisor).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.advisor).toBeUndefined();
	});
});
