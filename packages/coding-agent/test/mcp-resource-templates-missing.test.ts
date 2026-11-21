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
 * `resources/templates/list` still propagates. A handshake-era server gets
 * that treatment inside the MCP host; a 2026-07-28 server's -32601 reaches the
 * session, which is what the scripted host plays here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import {
	connectToServer,
	disconnectServer,
	type HostedMCPConnection,
	listResourceTemplates,
} from "@oh-my-pi/pi-coding-agent/mcp/client";
import { disposeLocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { RESOURCE_URIS } from "./fixtures/resources-no-templates-mcp";
import { rejectionOf } from "./helpers/rejection";
import { FakeHost } from "./mcp-host/link-fake-host";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "resources-no-templates-mcp.ts");
const BUN_EXEC = process.execPath;

const TEMPLATES = "resources/templates/list";

describe("listResourceTemplates -32601 handling", () => {
	let host: FakeHost;
	let connection: HostedMCPConnection | undefined;

	/** A modern server with resources whose templates listing answers with `code`. */
	async function connectAnsweringTemplatesWith(code: number, message: string): Promise<HostedMCPConnection> {
		host = new FakeHost();
		host.answer = (request, tunnel) => {
			if (request.method === "server/discover") {
				queueMicrotask(() =>
					tunnel.push({
						id: request.id,
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: { resources: {} },
						},
					}),
				);
			} else if (request.method === "subscriptions/listen") {
				queueMicrotask(() => tunnel.acknowledge(request));
			} else if (request.method === TEMPLATES) {
				queueMicrotask(() => tunnel.push({ id: request.id, error: { code, message } }));
			}
		};
		connection = await connectToServer(
			"docs",
			{ type: "http", url: "https://mcp.example.test/mcp" },
			{ access: host },
		);
		return connection;
	}

	afterEach(async () => {
		if (connection) await disconnectServer(connection);
		connection = undefined;
	});

	it("returns [] when the server answers resources/templates/list with -32601", async () => {
		const docs = await connectAnsweringTemplatesWith(-32601, "Method not found");

		expect(await listResourceTemplates(docs)).toEqual([]);
		// Remembered as "no templates": a second call does not ask again.
		expect(await listResourceTemplates(docs)).toEqual([]);
		expect(host.tunnel.sent.filter(request => request.method === TEMPLATES)).toHaveLength(1);
	});

	it("rethrows non-method-not-found errors", async () => {
		const docs = await connectAnsweringTemplatesWith(-32603, "Internal error");

		expect(String(await rejectionOf(listResourceTemplates(docs)))).toContain("-32603");
		// Not remembered: a transient failure must be retryable.
		expect(String(await rejectionOf(listResourceTemplates(docs)))).toContain("-32603");
		expect(host.tunnel.sent.filter(request => request.method === TEMPLATES)).toHaveLength(2);
	});
});

describe("MCPManager loads resources for a templates-less server", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-templates-"));
	});

	afterEach(async () => {
		await disposeLocalMcpHost();
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
			// A zero startup window waits for the fresh fixture to connect.
			await manager.connectServers({ docs: config }, {}, undefined, 0);
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
			// A zero startup window waits for the fresh fixture to connect.
			await manager.connectServers({ docs: config }, {}, undefined, 0);
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
