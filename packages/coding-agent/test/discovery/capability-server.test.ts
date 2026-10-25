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
	CAPABILITY_WAIT_TOOL_NAME,
	setCapabilityCommandResolverForTests,
} from "@oh-my-pi/pi-coding-agent/discovery/capability-server";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

describe("capability server tool-name contract", () => {
	// The fixture is a real `capability mcp` tools/list snapshot (see its
	// header for the refresh procedure). omp matches the wait by the exact
	// published name, so a server-side rename must break this test instead of
	// silently disabling steering, detection and the loop-guard exemption.
	test("the snapshot publishes the wait under the name omp matches", () => {
		const fixture = path.join(import.meta.dir, "..", "fixtures", "capability-tools-list.jsonl");
		const names: string[] = [];
		for (const line of fs.readFileSync(fixture, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("//")) continue;
			const parsed = JSON.parse(trimmed) as { result?: { tools?: Array<{ name?: unknown }> } };
			for (const tool of parsed.result?.tools ?? []) {
				if (typeof tool.name === "string") names.push(tool.name);
			}
		}
		expect(names.length).toBeGreaterThan(0);
		expect(names).toContain(CAPABILITY_WAIT_TOOL_NAME);
		// The published names are namespaced: a bare "wait" would mean the
		// server dropped the prefix and every omp match is now wrong.
		expect(names).not.toContain("wait");
	});
});
