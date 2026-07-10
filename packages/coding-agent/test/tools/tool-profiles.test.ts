import { describe, expect, test } from "bun:test";
import {
	filterAutoToolNames,
	filterToolCapabilities,
	isToolCapabilityAllowed,
	resolveToolProfile,
	type ToolCapability,
} from "../../src/tools/tool-profiles";

describe("resolveToolProfile", () => {
	test("source identity prevents extension read from shadowing builtin read", () => {
		const profile = resolveToolProfile({
			tier: "light",
			autonomy: "bound",
			agentTools: ["read", "find", "search"],
		});

		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "read" })).toBe(true);
		expect(isToolCapabilityAllowed(profile, { source: "extension", name: "read" })).toBe(false);
		expect(isToolCapabilityAllowed(profile, { source: "mcp", name: "read" })).toBe(false);
	});

	test("automatic additions are filtered through the immutable ceiling", () => {
		const profile = resolveToolProfile({
			tier: "light",
			autonomy: "independent",
			agentTools: ["read", "search"],
		});

		expect(filterAutoToolNames(profile, ["ast_grep", "ast_edit", "recall", "search_tool_bm25", "read"])).toEqual([
			"read",
		]);
	});

	test("explicit tools: [] is deny-all except classified control tools", () => {
		const profile = resolveToolProfile({
			tier: "frontier",
			autonomy: "independent",
			agentTools: [],
		});

		expect(profile.toolsConstrained).toBe(true);
		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "yield" })).toBe(true);
		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "read" })).toBe(false);
		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "bash" })).toBe(false);
	});

	test("tier never grants autonomy; light independent still cannot discover or shell", () => {
		const profile = resolveToolProfile({
			tier: "light",
			autonomy: "independent",
		});

		expect(profile.tier).toBe("light");
		expect(profile.autonomy).toBe("independent");
		expect(profile.allowDiscovery).toBe(false);
		expect(profile.editMode).toBe("none");
		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "bash" })).toBe(false);
		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "search_tool_bm25" })).toBe(false);
		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "task" })).toBe(false);
	});

	test("frontier bound cannot activate extension/custom tools", () => {
		const profile = resolveToolProfile({
			tier: "frontier",
			autonomy: "bound",
			declaredCapabilities: [
				{ source: "builtin", name: "read" },
				{ source: "extension", name: "browser_helper" },
				{ source: "custom", name: "deploy" },
			],
		});

		const filtered = filterToolCapabilities(profile, [
			{ source: "builtin", name: "read" },
			{ source: "extension", name: "browser_helper" },
			{ source: "custom", name: "deploy" },
		] satisfies ToolCapability[]);

		expect(filtered).toEqual([{ source: "builtin", name: "read" }]);
	});

	test("omitted tools remain unrestricted within tier/autonomy caps", () => {
		const profile = resolveToolProfile({
			tier: "mid",
			autonomy: "supervised",
		});
		expect(profile.toolsConstrained).toBe(false);
		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "edit" })).toBe(true);
		expect(profile.editMode).toBe("replace");
	});
});

describe("BM25 capability double-check helpers", () => {
	test("forbidden (source,name) pairs stay denied after ranking filter", () => {
		const profile = resolveToolProfile({
			tier: "mid",
			autonomy: "supervised",
			agentTools: ["read", "search", "search_tool_bm25"],
		});

		const candidates: ToolCapability[] = [
			{ source: "builtin", name: "read" },
			{ source: "mcp", name: "mcp__db__query" },
			{ source: "extension", name: "read" },
		];

		const allowed = filterToolCapabilities(profile, candidates);
		expect(allowed).toEqual([{ source: "builtin", name: "read" }]);
		expect(isToolCapabilityAllowed(profile, { source: "mcp", name: "mcp__db__query" })).toBe(false);
	});
});
