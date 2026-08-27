/**
 * The MCP route block used to spend one prompt line per mounted MCP tool. When
 * `createMCPToolName` reproduces a server's live names, one sentence states the
 * rule for the whole server instead; only servers with a name the rule cannot
 * derive still list their routes.
 */
import { describe, expect, it } from "bun:test";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { projectMountedMCPXdevGuidance } from "@oh-my-pi/pi-coding-agent/session/session-tools";

const route = (mcpServerName: string, mcpToolName: string, name?: string) => ({
	mcpServerName,
	mcpToolName,
	name: name ?? createMCPToolName(mcpServerName, mcpToolName),
});

describe("MCP xd:// guidance", () => {
	it("states the rule once for a server whose every route it derives", () => {
		const projection = projectMountedMCPXdevGuidance([
			route("basic-memory", "write_note"),
			route("basic-memory", "search_notes"),
			route("basic-memory", "recent_activity"),
		]);
		expect(projection.ruleServerNames).toEqual(["basic-memory"]);
		expect(projection.mappings).toHaveLength(0);
		expect(projection.hasOmittedMappings).toBe(false);
	});

	it("lists routes explicitly for a server with a name the rule cannot derive", () => {
		const projection = projectMountedMCPXdevGuidance([
			route("weird", "alpha", "mcp__weird_alpha_deadbeef"),
			route("weird", "beta"),
		]);
		expect(projection.ruleServerNames).toEqual([]);
		expect(projection.mappings.map(m => m.mcpToolName)).toEqual(["alpha", "beta"]);
		// `label` is the JSON-quoted form the prompt renders.
		expect(projection.mappings.map(m => m.label)).toEqual(['"alpha"', '"beta"']);
	});

	it("keeps a derivable server on the rule while another server falls back to a list", () => {
		const projection = projectMountedMCPXdevGuidance([
			route("basic-memory", "write_note"),
			route("weird", "alpha", "mcp__weird_alpha_deadbeef"),
		]);
		expect(projection.ruleServerNames).toEqual(["basic-memory"]);
		expect(projection.mappings).toHaveLength(1);
		expect(projection.mappings[0]?.path).toBe("xd://mcp__weird_alpha_deadbeef");
	});

	it("returns nothing to render when no MCP tool is mounted", () => {
		const projection = projectMountedMCPXdevGuidance([]);
		expect(projection.ruleServerNames).toEqual([]);
		expect(projection.mappings).toHaveLength(0);
	});
});
