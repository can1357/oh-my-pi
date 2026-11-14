import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../../src/mcp/manager";
import { authService } from "../../src/thread/services/auth";
import { integrationsThreadService } from "../../src/thread/services/integrations";
import { settingsThreadService } from "../../src/thread/services/settings";
import type { IntegrationsProbe } from "../fixtures/integrations-worker";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures");

let dir: string;
let authStorage: AuthStorage;
let manager: MCPManager;
let fixture: ServiceWorker<IntegrationsProbe>;

beforeEach(async () => {
	dir = path.join(os.tmpdir(), `omp-mcp-tools-version-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	authStorage = createInMemoryAuthStorage();
	manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
	await manager.connectServers(
		{
			progress: { type: "stdio", command: process.execPath, args: [path.join(FIXTURES, "progress-mcp.ts")] },
			cancel: {
				type: "stdio",
				command: process.execPath,
				args: [path.join(FIXTURES, "cancellable-mcp.ts"), path.join(dir, "frames.log")],
			},
		},
		{},
	);
	expect((await manager.waitForStartup(0)).failed).toEqual([]);
	MCPManager.setInstance(manager);
	fixture = await startServiceWorker<IntegrationsProbe>(
		new URL("../fixtures/integrations-worker.ts", import.meta.url),
		[settingsThreadService, authService, integrationsThreadService],
	);
});

afterEach(async () => {
	await fixture.stop();
	MCPManager.resetForTests();
	await manager.disconnectAll();
	authStorage.close();
	removeSyncWithRetries(dir);
});

function mainToolNames(): string[] {
	return manager
		.getTools()
		.map(tool => tool.name)
		.sort();
}

it("a worker's MCP tool list follows main's tool set after it was read once", async () => {
	const before = mainToolNames();
	expect((await fixture.probe.mcpGlobal()).tools.sort()).toEqual(before);
	// Unchanged set: the worker answers from what it already holds.
	expect((await fixture.probe.mcpGlobal()).tools.sort()).toEqual(before);

	await manager.disconnectServer("cancel");
	const after = mainToolNames();
	expect(after.length).toBeLessThan(before.length);
	expect((await fixture.probe.mcpGlobal()).tools.sort()).toEqual(after);
}, 20_000);
