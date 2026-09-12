import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { callTool } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { TOOL_NAME, TOOL_RESULT } from "./fixtures/delayed-tool-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "delayed-tool-mcp.ts");

beforeAll(() => {
	initTheme();
});

describe("/mcp reload status", () => {
	it("reports servers still connecting after the bounded reload window", async () => {
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: [FIXTURE_PATH],
		};
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { delayed: config },
			sources: {},
			exaApiKeys: [],
		}));
		const ctx = createInteractiveModeContext({ mcpManager: manager });
		const controller = new MCPCommandController(ctx);

		try {
			await controller.handle("/mcp reload");

			const output = ctx.chatContainer.render(120).join("\n");
			expect(output).toContain("Connected servers: 0");
			expect(output).toContain("Connecting servers: 1");

			const connection = await manager.waitForConnection("delayed");
			const result = await callTool(connection, TOOL_NAME);
			expect(result.content).toEqual([{ type: "text", text: TOOL_RESULT }]);
			expect(manager.getConnectedServers()).toEqual(["delayed"]);
		} finally {
			await manager.disconnectAll();
		}
	}, 5_000);
});
