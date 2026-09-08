import { beforeAll, describe, expect, it } from "bun:test";

import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { renderMCPResult } from "../../src/mcp/render";
import { MCPTool, type MCPToolDetails } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult, MCPToolDefinition } from "../../src/mcp/types";
import { getThemeByName, initTheme } from "../../src/modes/theme/theme";
import type { CustomToolContext, CustomToolResult } from "../../src/extensibility/custom-tools/types";

function toolFor(result: MCPToolCallResult): MCPTool {
	const connection = {
		name: "rhizome-mcp",
		transport: {
			request: async (method: string) => {
				if (method === "tools/call") return result as unknown;
				throw new Error(`unexpected method ${method}`);
			},
			close: async () => {},
		},
	} as unknown as MCPServerConnection;
	const definition: MCPToolDefinition = { name: "list_issues", inputSchema: { type: "object" } };
	return new MCPTool(connection, definition);
}

function build(result: MCPToolCallResult): Promise<CustomToolResult<MCPToolDetails>> {
	return toolFor(result).execute("call-1", {}, undefined, {} as CustomToolContext);
}

async function modelText(result: MCPToolCallResult): Promise<string> {
	const built = await build(result);
	return built.content.map(block => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

describe("MCP bridge structuredContent", () => {
	it("surfaces structuredContent when content is a minimal ack", async () => {
		// rhizome-mcp shape: terse ack in content, real payload in structuredContent.
		const text = await modelText({
			content: [{ type: "text", text: "issues listed" }],
			structuredContent: {
				items: [],
				next_cursor: null,
				next_actions: ["Inspect a claimable issue with get_work_context."],
			},
		});

		expect(text).toContain("issues listed");
		expect(text).toContain("next_actions");
		expect(text).toContain("Inspect a claimable issue with get_work_context.");
	});

	it("does not duplicate structuredContent already echoed verbatim in a text block", async () => {
		const payload = { lease_token: "abc123", expires_in: 900 };
		const text = await modelText({
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			structuredContent: payload,
		});

		// The token must be reachable exactly once — not appended a second time.
		const occurrences = text.split("abc123").length - 1;
		expect(occurrences).toBe(1);
	});

	it("leaves results without structuredContent untouched", async () => {
		const text = await modelText({ content: [{ type: "text", text: "plain result" }] });
		expect(text).toBe("plain result");
	});
});

describe("MCP result rendering with structuredContent", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme(false, undefined, undefined, "dark", "light");
	}, 15_000);

	async function renderText(result: MCPToolCallResult): Promise<string> {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme missing");
		const built = await build(result);
		return Bun.stripANSI(renderMCPResult(built, { expanded: true, isPartial: false }, theme).render(160).join("\n"));
	}

	it("renders the appended structured payload, not just the ack", async () => {
		const rendered = await renderText({
			content: [{ type: "text", text: "issues listed" }],
			structuredContent: { next_actions: ["Inspect a claimable issue with get_work_context."] },
		});

		expect(rendered).toContain("issues listed");
		expect(rendered).toContain("next_actions");
	});

	it("renders a structured-only result instead of showing (no output)", async () => {
		const rendered = await renderText({
			content: [],
			structuredContent: { lease_token: "abc123" },
		});

		expect(rendered).not.toContain("(no output)");
		expect(rendered).toContain("lease_token");
		expect(rendered).toContain("abc123");
	});
});
