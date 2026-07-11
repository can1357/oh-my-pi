import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/mcp";
import { loadCapability } from "@pk-nerdsaver-ai/pi-coding-agent/discovery";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

async function loadOpenCodeMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["opencode"],
	});
	return result.items;
}

describe("OpenCode MCP discovery", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-opencode-mcp-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	test("normalizes array commands and OpenCode environment fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					sequentialthinking: {
						type: "local",
						command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
						enabled: true,
					},
					github: {
						type: "local",
						command: ["npx", "-y", "@modelcontextprotocol/server-github"],
						environment: {
							GITHUB_PERSONAL_ACCESS_TOKEN: "token",
						},
						enabled: true,
					},
					firecrawl: {
						type: "local",
						command: ["firecrawl-mcp"],
						env: {
							FIRECRAWL_API_KEY: "legacy-token",
						},
					},
				},
			}),
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);
		const byName = Object.fromEntries(servers.map(server => [server.name, server]));

		expect(byName.sequentialthinking).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
			transport: "stdio",
		});
		expect(byName.github).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "token" },
			transport: "stdio",
		});
		expect(byName.firecrawl).toMatchObject({
			command: "firecrawl-mcp",
			env: { FIRECRAWL_API_KEY: "legacy-token" },
			transport: "stdio",
		});
		expect(byName.firecrawl?.args).toBeUndefined();
	});

	test("omits empty args for scalar OpenCode commands", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					plain: {
						type: "local",
						command: "server-bin",
					},
				},
			}),
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);
		const server = servers.find(item => item.name === "plain");

		expect(server?.command).toBe("server-bin");
		expect(server?.args).toBeUndefined();
	});
});
