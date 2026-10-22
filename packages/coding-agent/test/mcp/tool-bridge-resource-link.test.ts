import { describe, expect, it } from "bun:test";
import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { MCPTool } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult } from "../../src/mcp/types";

async function modelText(result: MCPToolCallResult): Promise<string> {
	const connection = {
		name: "docs",
		transport: {
			request: async (method: string) => {
				if (method === "tools/call") return result;
				throw new Error(`unexpected method ${method}`);
			},
			close: async () => {},
		},
	} as unknown as MCPServerConnection;
	const tool = new MCPTool(connection, { name: "find_docs", inputSchema: { type: "object" } });
	const built = await tool.execute("call-1", {}, undefined, {} as CustomToolContext);
	return built.content.map(block => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

describe("MCP bridge resource links", () => {
	it("gives the model the links a tool returns instead of an empty result", async () => {
		const text = await modelText({
			content: [
				{
					type: "resource_link",
					uri: "file:///project/docs/setup.md",
					name: "setup.md",
					title: "Setup guide",
					description: "How to install and configure the project",
					mimeType: "text/markdown",
					// Spec ResourceLink fields; `bun check` rejects this literal if MCPResourceLinkContent lacks them.
					size: 2048,
					annotations: { audience: ["assistant"], priority: 0.8, lastModified: "2026-10-01T00:00:00Z" },
					icons: [
						{ src: "https://docs.example/icon.png", mimeType: "image/png", sizes: ["48x48"], theme: "dark" },
					],
					_meta: { "example.com/revision": 7 },
				},
				{ type: "resource_link", uri: "file:///project/docs/api.md", name: "api.md" },
			],
		});

		// A dropped link leaves the model an empty result with nothing to follow up on.
		expect(text).toContain("file:///project/docs/setup.md");
		expect(text).toContain("text/markdown");
		expect(text).toContain("Setup guide");
		expect(text).toContain("How to install and configure the project");
		expect(text).toContain("file:///project/docs/api.md");
		// The bare name is its own line; the URI above already contains "api.md".
		expect(text.split("\n")).toContain("api.md");
	});
});
