import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { renderToolInventory } from "../src/dialect/inventory";
import type { InbandTool } from "../src/dialect/types";

const searchTool: InbandTool = {
	name: "web_search",
	description: "Searches the web.",
	parameters: type({
		query: type("string").describe("search query"),
		"recency?": type("'day' | 'week'"),
	}),
	examples: [{ caption: "Basic", call: { query: "rust", recency: "week" } }],
};

describe("renderToolInventory", () => {
	it("renders the catalog as a Harmony functions namespace", () => {
		const out = renderToolInventory([searchTool]);
		expect(out).toStartWith("## functions\n\nnamespace functions {\n");
		expect(out).toEndWith("\n} // namespace functions");
		expect(out).toContain("// Searches the web.");
		expect(out).toContain("type web_search = (_: {");
		expect(out).toContain("// search query");
		expect(out).toContain("query: string,");
		expect(out).toContain('recency?: "day" | "week",');
		expect(out).toContain("});");
	});

	it("renders examples as @example comment lines above the declaration", () => {
		const out = renderToolInventory([searchTool]);
		expect(out).toContain('// @example "Basic"');
		expect(out).toContain('// web_search(query="rust", recency="week")');
		expect(out).not.toContain("<examples>");
		// Examples sit between the description and the type declaration.
		expect(out.indexOf("// Searches the web.")).toBeLessThan(out.indexOf('// @example "Basic"'));
		expect(out.indexOf('// @example "Basic"')).toBeLessThan(out.indexOf("type web_search"));
	});

	it("omits the examples comment block when a tool has none", () => {
		const tool: InbandTool = {
			name: "noop",
			description: "No examples.",
			parameters: type({ x: type("string") }),
		};
		const out = renderToolInventory([tool]);
		expect(out).toContain("type noop = (_: {");
		expect(out).not.toContain("@example");
	});

	it("renders a parameterless tool without an args object", () => {
		const tool: InbandTool = {
			name: "ping",
			description: "Pings.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		};
		expect(renderToolInventory([tool])).toContain("type ping = ();");
	});

	it("returns an empty string when there are no tools", () => {
		expect(renderToolInventory([])).toBe("");
	});

	it("comments every description line, including markdown headers and fences", () => {
		const tool: InbandTool = {
			name: "shell",
			description: ["Runs commands.", "", "# Usage", "", "```bash", "ls", "```"].join("\n"),
			parameters: type({ cmd: type("string") }),
		};
		const out = renderToolInventory([tool]);
		expect(out).toContain("// Runs commands.");
		expect(out).toContain("// # Usage");
		expect(out).toContain("// ```bash");
		// Blank description lines become bare comment markers, keeping the block contiguous.
		expect(out).toContain("//\n// # Usage");
	});
});
