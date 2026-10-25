/**
 * The capability MCP server is registered by default with the request
 * deadline disabled: its blocking wait runs up to 30 minutes, and omp's 30 s
 * default (mcp/timeout.ts) would kill it. The default ships in code, so
 * nothing in a user's MCP config needs hand-editing.
 */
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { mcpCapability, type MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import {
	CAPABILITY_SERVER_NAME,
	setCapabilityCommandResolverForTests,
} from "@oh-my-pi/pi-coding-agent/discovery/capability-server";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";

async function loadBuiltinServers(): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd: os.tmpdir(),
		providers: ["capability-native"],
	});
	return result.items;
}

describe("built-in capability server registration", () => {
	afterEach(() => {
		setCapabilityCommandResolverForTests();
	});

	test("registers `capability mcp` over stdio with the request timeout disabled", async () => {
		setCapabilityCommandResolverForTests(() => "/usr/local/bin/capability");
		const servers = await loadBuiltinServers();
		expect(servers).toHaveLength(1);
		const [server] = servers;
		expect(server).toMatchObject({
			name: CAPABILITY_SERVER_NAME,
			command: "capability",
			args: ["mcp"],
			transport: "stdio",
			timeout: 0,
		});
		// The transport resolves the per-server timeout to "no deadline".
		const prior = process.env.OMP_MCP_TIMEOUT_MS;
		delete process.env.OMP_MCP_TIMEOUT_MS;
		try {
			expect(isMCPTimeoutEnabled(resolveMCPTimeoutMs(server.timeout))).toBe(false);
		} finally {
			if (prior !== undefined) process.env.OMP_MCP_TIMEOUT_MS = prior;
		}
	});

	test("contributes nothing on a machine without the capability CLI", async () => {
		setCapabilityCommandResolverForTests(() => null);
		expect(await loadBuiltinServers()).toHaveLength(0);
	});
});
