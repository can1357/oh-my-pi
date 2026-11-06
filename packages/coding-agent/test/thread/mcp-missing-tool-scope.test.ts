/**
 * The missing-tool note a worker session reads is its own session's, not the
 * owner's.
 *
 * `RemoteMCPManager.explainMissingTool` is a `callSync` served on main, and
 * since per-session tool views the group a down server falls into is a
 * question about the asking session's view: a server whose whole catalog is
 * a tool one session's call loaded is registered on main and invisible to
 * every other session. A subagent told that such a server is "still serving
 * the tools cached from an earlier connect" is reading a claim its own tool
 * list refutes.
 */
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
import type { IntegrationsProbe } from "../fixtures/integrations-worker";
import { MARKER_ENV, RENAME_TOOL, RENAMED_TOOL } from "../fixtures/renaming-mcp";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures");

let dir: string;
let manager: MCPManager;
let fixture: ServiceWorker<IntegrationsProbe>;

beforeEach(() => {
	dir = path.join(os.tmpdir(), `omp-mcp-missing-scope-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	// One connect attempt, no ladder: the server settles as disconnected instead of retrying.
	manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }), {
		ladderMs: [],
		retryBaseMs: 60_000,
		retryMaxMs: 60_000,
	});
});

afterEach(async () => {
	await fixture?.stop();
	MCPManager.resetForTests();
	await manager.disconnectAll();
	removeSyncWithRetries(dir);
});

it("a worker reads the down server's note through its own session's view", async () => {
	const { promise: failed, resolve: onFailed } = Promise.withResolvers<void>();
	const unsubscribe = manager.addConnectionStatusListener(event => {
		if (event.type === "failed" && event.serverName === "kata") onFailed();
	});
	try {
		await manager.connectServers(
			{
				kata: {
					type: "stdio",
					command: process.execPath,
					args: [path.join(FIXTURES, "renaming-mcp.ts")],
					env: { [MARKER_ENV]: path.join(dir, "kata-spawned") },
					timeout: 5_000,
				},
			},
			{},
		);
		expect((await manager.waitForStartup(0)).failed).toEqual([]);

		// The child's call renames the server's only tool, so the renamed one
		// reaches the child's view alone; the server then dies for good.
		manager.openToolScope("worker-child");
		manager.openToolScope("worker-sibling");
		const loader = createMCPProxyTools(manager, "worker-child").find(tool => tool.mcpToolName === RENAME_TOOL);
		if (!loader?.execute) throw new Error("expected the child's proxy for the loader");
		await loader.execute("kata-call", {}, undefined, {} as CustomToolContext);
		await failed;
		await manager.waitForStartup(5_000);
		expect(manager.getTools("worker-child").map(tool => tool.name)).toEqual([`mcp__kata_${RENAMED_TOOL}`]);
		expect(manager.getTools("worker-sibling")).toHaveLength(0);
	} finally {
		unsubscribe();
	}

	MCPManager.setInstance(manager);
	fixture = await startServiceWorker<IntegrationsProbe>(
		new URL("../fixtures/integrations-worker.ts", import.meta.url),
		[settingsThreadService, authService, integrationsThreadService],
	);
	const [childNote, siblingNote] = await fixture.probe.mcpMissingToolNotes("mcp__kata_other", [
		"worker-child",
		"worker-sibling",
	]);
	expect(childNote).toContain("still serving the tools cached from an earlier connect");
	expect(childNote).not.toContain("tools are not mounted");
	expect(siblingNote).toContain("so its tools are not mounted: kata");
	expect(siblingNote).not.toContain("still serving the tools cached from an earlier connect");
}, 30_000);
