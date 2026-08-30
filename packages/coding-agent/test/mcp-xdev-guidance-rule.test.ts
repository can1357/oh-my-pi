/**
 * The MCP route block used to spend one prompt line per mounted MCP tool. When
 * `createMCPToolName` reproduces a server's live names, one sentence states the
 * rule for the whole server instead; only servers with a name the rule cannot
 * derive still list their routes.
 */
import { describe, expect, it } from "bun:test";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { projectMountedMCPXdevGuidance } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { prompt } from "@oh-my-pi/pi-utils";
import mcpXdevGuidanceTemplate from "../src/prompts/system/mcp-xdev-guidance-compact.md" with { type: "text" };

const route = (mcpServerName: string, mcpToolName: string, name?: string) => ({
	mcpServerName,
	mcpToolName,
	name: name ?? createMCPToolName(mcpServerName, mcpToolName),
});

describe("MCP xd:// guidance", () => {
	it("states the rule once for a server whose every route it derives", () => {
		const projection = projectMountedMCPXdevGuidance(
			[
				route("basic-memory", "write_note"),
				route("basic-memory", "search_notes"),
				route("basic-memory", "recent_activity"),
			],
			true,
		);
		expect(projection.ruleServerNames).toEqual(["basic-memory"]);
		expect(projection.mappings).toHaveLength(0);
		expect(projection.hasOmittedMappings).toBe(false);
	});

	it("explains redundant server-prefix stripping in the derivation rule", () => {
		const rendered = prompt.render(mcpXdevGuidanceTemplate, {
			ruleServers: ["puppeteer"],
			tools: [],
			xdPrefix: "xd://",
			hasOmittedTools: false,
		});
		expect(rendered).toContain("drop that redundant server prefix");
		expect(createMCPToolName("puppeteer", "puppeteer_screenshot")).toBe("mcp__puppeteer_screenshot");
	});

	it("lists hashed routes explicitly because a model cannot derive their suffix", () => {
		const projection = projectMountedMCPXdevGuidance(
			[route("very-long-server-name-that-keeps-going", "very-long-tool-name-that-also-keeps-going")],
			true,
		);
		expect(projection.ruleServerNames).toEqual([]);
		expect(projection.mappings).toHaveLength(1);
	});

	it("bounds the server rule list and points omitted routes to discovery", () => {
		const projection = projectMountedMCPXdevGuidance(
			Array.from({ length: 75 }, (_, index) => route(`server-${index.toString().padStart(2, "0")}`, "read")),
			true,
		);
		expect(projection.ruleServerNames).toHaveLength(50);
		expect(projection.hasOmittedMappings).toBe(true);
	});

	it("signs rule-covered catalog routes in visible insertion order", () => {
		const routes = Array.from({ length: 75 }, (_, index) =>
			route("memory", index === 0 ? "z_first" : `a_${index.toString().padStart(2, "0")}`),
		);
		const projection = projectMountedMCPXdevGuidance(routes, true);

		expect(projection.ruleRouteNames).toHaveLength(50);
		expect(projection.ruleRouteNames[0]).toBe(routes[0]?.name);
		expect(projection.ruleRouteNames[49]).toBe(routes[49]?.name);
	});

	it("lists routes explicitly for a server with a name the rule cannot derive", () => {
		const projection = projectMountedMCPXdevGuidance(
			[route("weird", "alpha", "mcp__weird_alpha_deadbeef"), route("weird", "beta")],
			true,
		);
		expect(projection.ruleServerNames).toEqual([]);
		expect(projection.mappings.map(m => m.mcpToolName)).toEqual(["alpha", "beta"]);
		// `label` is the JSON-quoted form the prompt renders.
		expect(projection.mappings.map(m => m.label)).toEqual(['"alpha"', '"beta"']);
	});

	it("keeps a derivable server on the rule while another server falls back to a list", () => {
		const projection = projectMountedMCPXdevGuidance(
			[route("basic-memory", "write_note"), route("weird", "alpha", "mcp__weird_alpha_deadbeef")],
			true,
		);
		expect(projection.ruleServerNames).toEqual(["basic-memory"]);
		expect(projection.mappings).toHaveLength(1);
		expect(projection.mappings[0]?.path).toBe("xd://mcp__weird_alpha_deadbeef");
	});

	it("returns nothing to render when no MCP tool is mounted", () => {
		const projection = projectMountedMCPXdevGuidance([], true);
		expect(projection.ruleServerNames).toEqual([]);
		expect(projection.mappings).toHaveLength(0);
	});

	it("keeps the legacy full-profile projection as exact route mappings", () => {
		const projection = projectMountedMCPXdevGuidance([
			route("basic-memory", "write_note"),
			route("basic-memory", "search_notes"),
		]);

		expect(projection.ruleServerNames).toEqual([]);
		expect(projection.mappings.map(mapping => mapping.path)).toEqual([
			"xd://mcp__basic_memory_write_note",
			"xd://mcp__basic_memory_search_notes",
		]);
	});
});
