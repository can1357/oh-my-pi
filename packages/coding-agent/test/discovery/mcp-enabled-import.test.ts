import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// The Claude importer previously dropped the per-server `enabled` flag (issue #7652).
// Codex/OpenCode/native already propagate it and are covered elsewhere.
describe("translated MCP importers propagate enabled: false", () => {
	let tempCwd = "";

	beforeEach(async () => {
		tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-enabled-cwd-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempCwd);
	});

	test("claude carries enabled: false", async () => {
		const filePath = path.join(tempCwd, ".claude/.mcp.json");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(
			filePath,
			JSON.stringify({
				mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
			}),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd: tempCwd, providers: ["claude"] });
		const server = result.items.find(item => item.name === "markitdown");

		expect(server).toBeDefined();
		expect(server?.enabled).toBe(false);
	});
});
