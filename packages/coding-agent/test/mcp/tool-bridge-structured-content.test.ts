import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { type MCPToolDetails, renderMCPResult } from "@oh-my-pi/pi-tui/tools/mcp";

import { resetSettingsForTest, Settings } from "../../src/config/settings";
import type { CustomToolContext, CustomToolResult } from "../../src/extensibility/custom-tools/types";
import { CustomToolAdapter } from "../../src/extensibility/custom-tools/wrapper";
import { bridgeValueFromToolResult } from "../../src/eval/js/tool-bridge";
import { MCPTool } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallParams, MCPToolCallResult, MCPToolDefinition } from "../../src/mcp/types";
import { SessionManager } from "../../src/session/session-manager";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";

function toolFor(result: MCPToolCallResult | ((params: MCPToolCallParams) => MCPToolCallResult)): MCPTool {
	const connection = {
		name: "rhizome-mcp",
		transport: {
			request: async (method: string, params: MCPToolCallParams) => {
				if (method === "tools/call") return typeof result === "function" ? result(params) : result;
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

	it("lets an eval consumer advance pages using opaque cursors rather than display text", async () => {
		const cursor = "next:λ/```json";
		const tool = toolFor(params => {
			const next = params.arguments?.cursor;
			if (next !== undefined && next !== cursor) throw new Error("invalid cursor");
			return {
				content: [{ type: "text", text: "Page returned; this text is not a data API." }],
				structuredContent: {
					items: next === undefined ? ["first"] : ["second"],
					next_cursor: next === undefined ? cursor : null,
				},
			};
		});
		const items: string[] = [];
		let next: string | null | undefined;
		do {
			const args = next === undefined ? {} : { cursor: next };
			const result = await tool.execute("page", args, undefined, {} as CustomToolContext);
			const value = bridgeValueFromToolResult(tool.name, args, result);
			if (typeof value !== "object" || !("details" in value)) throw new Error("missing tool details");
			const page = (value.details as MCPToolDetails).structuredContent;
			if (!page || !Array.isArray(page.items)) throw new Error("missing structured page");
			items.push(...page.items);
			next = page.next_cursor as string | null;
			if (items.length > 2) throw new Error("pagination did not terminate");
		} while (next !== null);
		expect(items).toEqual(["first", "second"]);
	});
	it("keeps oversized structured data available to eval without duplicating it in the session JSONL", async () => {
		using temp = TempDir.createSync("@mcp-structured-spill-");
		const manager = SessionManager.create(temp.path(), temp.path());
		await manager.ensureOnDisk();
		const cursor = "next:λ/```json";
		const structuredContent = {
			pages: [{ cursor, rows: [{ label: "東京", body: "é🦊".repeat(180_000) }] }],
			next_cursor: cursor,
		};
		const renderedPayload = JSON.stringify(structuredContent, null, 2);
		expect(Buffer.byteLength(renderedPayload, "utf8")).toBeGreaterThan(524 * 1024);
		const tool = wrapToolWithMetaNotice(
			CustomToolAdapter.wrap(
				toolFor({
					content: [{ type: "text", text: "page returned" }],
					structuredContent,
					isError: true,
				}),
				() => ({}) as CustomToolContext,
			),
		);
		const context = {
			sessionManager: manager,
			settings: Settings.isolated({
				"tools.artifactSpillThreshold": 512,
				"tools.artifactTailBytes": 1,
				"tools.artifactTailLines": 10,
			}),
		} as unknown as AgentToolContext;
		try {
			const result = await tool.execute("large-page", {}, undefined, undefined, context);
			const details = result.details as MCPToolDetails;
			const artifactId = details.meta?.truncation?.artifactId;
			if (!artifactId) throw new Error("Expected the MCP display to spill");
			expect(details.structuredContent).toEqual(structuredContent);
			expect(details.serverName).toBe("rhizome-mcp");
			expect(details.mcpToolName).toBe("list_issues");
			expect(details.isError).toBe(true);
			const value = bridgeValueFromToolResult(tool.name, {}, result);
			if (typeof value !== "object" || !("details" in value)) throw new Error("Expected eval details");
			expect((value.details as MCPToolDetails).structuredContent).toEqual(structuredContent);
			expect(value.hasError).toBe(true);
			expect(value.text).not.toContain(structuredContent.pages[0]!.rows[0]!.body);
			expect(value.text).toContain(`artifact://${artifactId}`);

			const message = {
				role: "toolResult" as const,
				toolCallId: "large-page",
				toolName: tool.name,
				content: result.content,
				details: result.details,
				isError: true,
				timestamp: Date.now(),
			};
			manager.appendMessage(message);
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected session JSONL");
			const entries = (await Bun.file(sessionFile).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			const persisted = entries.find(entry => entry.message?.toolCallId === "large-page")?.message;
			if (!persisted) throw new Error("Expected persisted MCP result");
			expect(persisted.details).not.toHaveProperty("structuredContent");
			expect(persisted.details).toMatchObject({
				serverName: "rhizome-mcp",
				mcpToolName: "list_issues",
				isError: true,
				meta: { truncation: { artifactId } },
			});
			expect(persisted.isError).toBe(true);
			expect(persisted.toolName).toBe(tool.name);
			expect(persisted.content).toEqual(result.content);
			expect(JSON.stringify(persisted)).not.toContain(structuredContent.pages[0]!.rows[0]!.body);
			expect(message.details?.structuredContent).toBe(structuredContent);
			const artifactPath = await manager.getArtifactPath(artifactId);
			if (!artifactPath) throw new Error("Expected recoverable artifact");
			expect(await Bun.file(artifactPath).text()).toContain(renderedPayload);
		} finally {
			await manager.close();
		}
	});

	it("persists unspilled MCP data and spilled non-MCP detail collisions", async () => {
		using temp = TempDir.createSync("@mcp-structured-boundaries-");
		const manager = SessionManager.create(temp.path(), temp.path());
		await manager.ensureOnDisk();
		const context = {
			sessionManager: manager,
			settings: Settings.isolated({
				"tools.artifactSpillThreshold": 1,
				"tools.artifactHeadBytes": 0,
				"tools.artifactTailBytes": 1,
			}),
		} as unknown as AgentToolContext;
		try {
			const mcp = wrapToolWithMetaNotice(
				CustomToolAdapter.wrap(
					toolFor({ content: [{ type: "text", text: "ok" }], structuredContent: { next_cursor: "λ" } }),
					() => ({}) as CustomToolContext,
				),
			);
			const unspilled = await mcp.execute("small-page", {}, undefined, undefined, {
				...context,
				settings: Settings.isolated({ "tools.artifactSpillThreshold": 512 }),
			});
			expect(unspilled.details?.meta?.truncation?.artifactId).toBeUndefined();
			const collision = { next_cursor: "keep this SDK-owned data" };
			const sdk = wrapToolWithMetaNotice<AgentTool>({
				name: "sdk_page",
				description: "SDK result",
				label: "SDK result",
				parameters: mcp.parameters,
				execute: async () => ({
					content: [{ type: "text" as const, text: "long SDK output\n".repeat(100) }],
					details: { structuredContent: collision },
				}),
			});
			const spilled = await sdk.execute("sdk-page", {}, undefined, undefined, context);
			expect(spilled.details?.meta?.truncation?.artifactId).toBeDefined();
			for (const [id, name, result] of [
				["small-page", mcp.name, unspilled],
				["sdk-page", sdk.name, spilled],
			] as const) {
				manager.appendMessage({
					role: "toolResult",
					toolCallId: id,
					toolName: name,
					content: result.content,
					details: result.details,
					isError: false,
					timestamp: Date.now(),
				});
			}
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected session JSONL");
			const entries = (await Bun.file(sessionFile).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(
				entries.find(entry => entry.message?.toolCallId === "small-page")?.message.details.structuredContent,
			).toEqual({
				next_cursor: "λ",
			});
			expect(
				entries.find(entry => entry.message?.toolCallId === "sdk-page")?.message.details.structuredContent,
			).toEqual(collision);
		} finally {
			await manager.close();
		}
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
