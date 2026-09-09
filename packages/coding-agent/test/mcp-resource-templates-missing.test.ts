/**
 * Regression test: a server that declares the `resources` capability but does
 * NOT implement the optional `resources/templates/list` method answers with
 * JSON-RPC -32601 ("Method not found"). Before the fix, `listResourceTemplates`
 * rethrew that error, which made `MCPManager`'s
 * `Promise.all([listResources, listResourceTemplates])` reject and discard the
 * server's concrete resources too (the jcodemunch/jdocmunch bug).
 *
 * Contract this test defends: a missing templates method is treated as "no
 * templates" (returns []), so resources still load; any OTHER error from
 * `resources/templates/list` still propagates.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { listResourceTemplates } from "../src/mcp/client";
import { MCPManager } from "../src/mcp/manager";
import type { MCPServerConnection, MCPStdioServerConfig, MCPTransport } from "../src/mcp/types";
import { RESOURCE_URIS } from "./fixtures/resources-no-templates-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "resources-no-templates-mcp.ts");
const BUN_EXEC = process.execPath;

/** Minimal mock transport where `request` is controlled by the caller. */
function mockTransport(requestFn: (method: string) => Promise<unknown>): MCPTransport {
	return {
		connected: true,
		request: ((method: string) => requestFn(method)) as MCPTransport["request"],
		async notify() {},
		async close() {},
	};
}

function makeResourceConnection(transport: MCPTransport): MCPServerConnection {
	return {
		name: "docs",
		config: { type: "stdio", command: "echo" },
		transport,
		serverInfo: { name: "docs", version: "1.0" },
		capabilities: { resources: {} },
	};
}

describe("listResourceTemplates -32601 handling", () => {
	it("returns [] when the server answers resources/templates/list with -32601", async () => {
		const connection = makeResourceConnection(
			mockTransport(async method => {
				if (method === "resources/templates/list") {
					throw new Error("MCP error -32601: Method not found");
				}
				return { resourceTemplates: [] };
			}),
		);

		await expect(listResourceTemplates(connection)).resolves.toEqual([]);
		// Cached as "no templates" so a second call does not re-request.
		expect(connection.resourceTemplates).toEqual([]);
	});

	it("rethrows non-method-not-found errors", async () => {
		const connection = makeResourceConnection(
			mockTransport(async () => {
				throw new Error("MCP error -32603: Internal error");
			}),
		);

		await expect(listResourceTemplates(connection)).rejects.toThrow("-32603");
		// Not cached: a transient failure must be retryable.
		expect(connection.resourceTemplates).toBeUndefined();
	});
});

describe("MCPManager loads resources for a templates-less server", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-templates-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("keeps concrete resources when resources/templates/list is unimplemented", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};

		try {
			await manager.connectServers({ docs: config }, {});
			await manager.ensureServerResources("docs");
			const resources = manager.getServerResources("docs");

			expect(resources).toBeDefined();
			// The -32601 from templates/list must NOT discard the concrete resources.
			expect(resources?.resources.map(r => r.uri).sort()).toEqual([...RESOURCE_URIS].sort());
			// Templates are treated as empty, not an error.
			expect(resources?.templates).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);

	it("keeps concrete resources when resources/templates/list fails outright", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			// Fixture answers resources/templates/list with -32603 instead of
			// -32601 — a hard failure, not "method not found".
			env: { FIXTURE_TEMPLATES_ERROR_CODE: "-32603" },
		};

		try {
			await manager.connectServers({ docs: config }, {});
			await manager.ensureServerResources("docs");
			const resources = manager.getServerResources("docs");

			expect(resources).toBeDefined();
			// The still-in-flight resources/list result must not be discarded.
			expect(resources?.resources.map(r => r.uri).sort()).toEqual([...RESOURCE_URIS].sort());
			// Templates listing failed; treated as none until a later refresh.
			expect(resources?.templates).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);
});
