import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../../src/mcp/manager";
import { authService } from "../../src/thread/services/auth";
import { integrationsThreadService } from "../../src/thread/services/integrations";
import { settingsThreadService } from "../../src/thread/services/settings";
import type { IntegrationsProbe } from "../fixtures/integrations-worker";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

it("a worker observes pending MCP startup settle after failure without a tool-view change", async () => {
	const dir = path.join(os.tmpdir(), `omp-mcp-startup-readiness-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	const initializing = Promise.withResolvers<void>();
	const failInitialization = Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as { id?: number | string; method: string };
			if (message.method !== "initialize") return new Response(null, { status: 202 });
			initializing.resolve();
			await failInitialization.promise;
			return Response.json({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32603, message: "Startup failed without tools" },
			});
		},
	});
	const manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
	let fixture: ServiceWorker<IntegrationsProbe> | undefined;
	try {
		MCPManager.setInstance(manager);
		const connecting = manager.connectServers(
			{ failing: { type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 10_000 } },
			{},
			undefined,
			1,
		);
		await Promise.all([initializing.promise, connecting]);
		expect(manager.hasPendingStartup()).toBe(true);
		const version = manager.toolViewsRevision;
		fixture = await startServiceWorker<IntegrationsProbe>(
			new URL("../fixtures/integrations-worker.ts", import.meta.url),
			[settingsThreadService, authService, integrationsThreadService],
		);
		expect((await fixture.probe.mcpGlobal()).remote).toBe(true);
		expect(await fixture.probe.mcpStartup(false)).toEqual({ pending: true, tools: [] });

		const settled = fixture.probe.mcpStartup(true);
		failInitialization.resolve();
		expect(await settled).toEqual({ pending: false, tools: [] });
		expect(await fixture.probe.mcpStartup(false)).toEqual({ pending: false, tools: [] });
		expect(manager.hasPendingStartup()).toBe(false);
		expect(manager.toolViewsRevision).toBe(version);
		expect((await manager.waitForStartup(0)).failed.map(failure => failure.name)).toEqual(["failing"]);
	} finally {
		failInitialization.resolve();
		await fixture?.stop();
		MCPManager.resetForTests();
		await manager.disconnectAll();
		await server.stop(true);
		removeSyncWithRetries(dir);
	}
}, 20_000);
