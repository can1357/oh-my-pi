import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../../src/mcp/manager";
import { createMCPProxyTools } from "../../src/task/executor";
import { authService } from "../../src/thread/services/auth";
import { integrationsThreadService } from "../../src/thread/services/integrations";
import { settingsThreadService } from "../../src/thread/services/settings";
import { LOADED_TOOL, LOADER_TOOL } from "../fixtures/lazy-loader-mcp";
import type { IntegrationsProbe } from "../fixtures/integrations-worker";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures");

let dir: string;
let manager: MCPManager;
let fixture: ServiceWorker<IntegrationsProbe>;

beforeEach(async () => {
	dir = path.join(os.tmpdir(), `omp-mcp-scoped-tools-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
	await manager.connectServers(
		{ alpha: { type: "stdio", command: process.execPath, args: [path.join(FIXTURES, "lazy-loader-mcp.ts")] } },
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
	removeSyncWithRetries(dir);
});

it("a worker hosting two sessions reads each session's own MCP tool view", async () => {
	manager.openToolScope("loader");
	manager.openToolScope("sibling");
	const loader = createMCPProxyTools(manager, "loader").find(tool => tool.mcpToolName === LOADER_TOOL);
	if (!loader?.execute) throw new Error("expected the loader proxy");
	await loader.execute("load", {}, undefined, {} as CustomToolContext);

	// Read back to back at one tool-views version: the second scope must not reuse the first's cached views.
	const [loaderView, siblingView] = await fixture.probe.mcpViews(["loader", "sibling"]);
	expect(loaderView).toContain(LOADED_TOOL);
	expect(siblingView).not.toContain(LOADED_TOOL);
}, 20_000);

it("attributes identical provider call IDs to each worker's own completed call", async () => {
	const sibling = await startServiceWorker<IntegrationsProbe>(
		new URL("../fixtures/integrations-worker.ts", import.meta.url),
		[settingsThreadService, authService, integrationsThreadService],
	);
	try {
		const barrier = new Int32Array(new SharedArrayBuffer(4));
		const providerCallId = "ollama:0:load_extra";
		const [loaderOutcome, siblingOutcome] = await Promise.all([
			fixture.probe.mcpScopedCall("loader", LOADER_TOOL, providerCallId, barrier),
			sibling.probe.mcpScopedCall("sibling", LOADER_TOOL, providerCallId, barrier),
		]);
		expect(loaderOutcome.error).toBeUndefined();
		expect(siblingOutcome.error).toBeUndefined();

		const [loaderViews, siblingViews] = await Promise.all([
			fixture.probe.mcpViews(["loader"]),
			sibling.probe.mcpViews(["sibling"]),
		]);
		expect(loaderViews[0]).toContain(LOADED_TOOL);
		expect(siblingViews[0]).toContain(LOADED_TOOL);
		expect(manager.getTools().map(tool => tool.mcpToolName)).not.toContain(LOADED_TOOL);
	} finally {
		await sibling.stop();
	}
}, 20_000);
