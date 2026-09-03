/**
 * Regression: Exa MCP servers are filtered out by default because the native
 * Exa integration covers `web_search_exa`. But a config that explicitly
 * requests Exa tools the native integration does NOT provide (e.g.
 * `web_fetch_exa`, `web_search_advanced_exa`) must stay mounted as an MCP
 * server instead of being dropped.
 */
import { describe, expect, test } from "bun:test";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { filterExaMCPServers } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const SOURCE: SourceMeta = {
	provider: "test",
	providerName: "Test",
	path: "/tmp/mcp.json",
	level: "user",
};

describe("Exa MCP filtering", () => {
	test("filters an exa server restricted to the native web_search_exa tool", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp?tools=web_search_exa&exaApiKey=sk-1" },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(result.configs).toEqual({});
		expect(result.exaApiKeys).toEqual(["sk-1"]);
	});

	test("keeps an exa server that requests tools beyond the native integration", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "http",
				url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa&exaApiKey=sk-1",
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
		expect(result.sources.exa).toEqual(SOURCE);
		expect(result.exaApiKeys).toEqual(["sk-1"]);
	});

	test("filters an exa server with no tools restriction", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp" },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(result.configs).toEqual({});
	});

	test("keeps a stdio exa server that requests extra tools", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "stdio",
				command: "npx",
				args: ["-y", "exa-mcp-server", "--tools=web_search_exa,web_fetch_exa"],
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});

	test("keeps a stdio exa server with a separate tools argument", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "stdio",
				command: "npx",
				args: ["-y", "exa-mcp-server", "--tools", "web_search_exa,web_fetch_exa"],
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});
});
