import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ToolSource } from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-profiles";
import { XdevRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/tools/xdev";
import { type } from "arktype";

function createTool(name: string, description = `${name} description`): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: type({ "value?": "string" }),
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

function createRegistry(sources: ReadonlyMap<string, ToolSource>): XdevRegistry {
	return new XdevRegistry({ enabled: true, sourceOf: name => sources.get(name) });
}

describe("XdevRegistry", () => {
	it("mounts MCP, custom, and extension tools while excluding protected surfaces", () => {
		const sources = new Map<string, ToolSource>([
			["custom_report", "custom"],
			["extension_lookup", "extension"],
			["read", "custom"],
			["irc", "custom"],
			["job", "custom"],
			["task", "custom"],
			["ssh", "custom"],
			["search_tool_bm25", "custom"],
			["DEBUG", "extension"],
		]);
		const registry = createRegistry(sources);
		registry.reconcile([
			createTool("mcp__server__lookup"),
			createTool("custom_report"),
			createTool("extension_lookup"),
			createTool("read"),
			createTool("irc"),
			createTool("job"),
			createTool("task"),
			createTool("ssh"),
			createTool("search_tool_bm25"),
			createTool("DEBUG"),
		]);

		expect(registry.list().map(tool => tool.name)).toEqual([
			"custom_report",
			"extension_lookup",
			"mcp__server__lookup",
		]);
		expect(registry.listing()).toContain("xd://mcp__server__lookup");
		expect(registry.docs("custom_report")).toContain('"value"');
	});

	it("replaces stale devices when reconciling", () => {
		const sources = new Map<string, ToolSource>([
			["first", "custom"],
			["second", "custom"],
		]);
		const registry = createRegistry(sources);
		registry.reconcile([createTool("first")]);
		expect(registry.get("first")).toBeDefined();

		registry.reconcile([createTool("second")]);
		expect(registry.get("first")).toBeUndefined();
		expect(registry.get("second")).toBeDefined();
	});

	it("mounts nothing when disabled", () => {
		const registry = new XdevRegistry({ enabled: false, sourceOf: () => "custom" });
		registry.reconcile([createTool("custom_report"), createTool("mcp__server__lookup")]);
		expect(registry.list()).toEqual([]);
	});
});
