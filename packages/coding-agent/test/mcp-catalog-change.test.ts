import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { ExtensionDashboard } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-dashboard";
import { snapshotMcpRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { PROMPT_NAME, RESOURCE_NAME, RESOURCE_URI, TOOL_NAME } from "./fixtures/delayed-catalog-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "delayed-catalog-mcp.ts");
const SERVER = "catalog";

beforeAll(async () => {
	await initTheme(false);
});

function waitUntil(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const start = Date.now();
	const tick = () => {
		if (predicate()) {
			resolve();
			return;
		}
		if (Date.now() - start > timeoutMs) {
			reject(new Error(`timed out waiting for ${label}`));
			return;
		}
		setTimeout(tick, 15);
	};
	tick();
	return promise;
}

describe("MCP catalog-change after connect", () => {
	let workDir = "";
	let gate = "";
	let manager: MCPManager;

	function fixtureConfig(): MCPStdioServerConfig {
		return {
			type: "stdio",
			command: process.execPath,
			args: [FIXTURE_PATH],
			env: { DELAY_CATALOG_UNTIL: gate },
		};
	}

	beforeEach(() => {
		resetSettingsForTest();
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-catalog-"));
		gate = path.join(workDir, "release-catalog");
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		resetSettingsForTest();
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("emits catalog change after delayed resources and prompts, not as another connected", async () => {
		const lifecycle: string[] = [];
		const catalogs: Array<{ kind: string; name: string }> = [];
		manager.addConnectionStatusListener(event => {
			lifecycle.push(event.type);
		});
		manager.addCatalogChangeListener(event => {
			catalogs.push({ kind: event.kind, name: event.serverName });
		});

		const connect = manager.connectServers({ [SERVER]: fixtureConfig() }, {});
		await waitUntil(() => lifecycle.includes("connected"), "connected");
		await connect;

		expect(manager.getConnectionStatus(SERVER)).toBe("connected");
		expect(manager.getConnection(SERVER)?.tools?.some(tool => tool.name === TOOL_NAME)).toBe(true);
		expect(manager.getConnection(SERVER)?.resources).toBeUndefined();
		expect(manager.getConnection(SERVER)?.prompts).toBeUndefined();
		expect(catalogs).toEqual([]);
		expect(lifecycle.filter(type => type === "connected")).toHaveLength(1);

		fs.writeFileSync(gate, "go");
		await waitUntil(() => catalogs.length >= 2, "both catalog kinds");

		expect(catalogs).toEqual(
			expect.arrayContaining([
				{ kind: "resources", name: SERVER },
				{ kind: "prompts", name: SERVER },
			]),
		);
		expect(manager.getServerResources(SERVER)?.resources.map(item => item.uri)).toEqual([RESOURCE_URI]);
		expect(manager.getServerPrompts(SERVER)?.map(item => item.name)).toEqual([PROMPT_NAME]);
		expect(lifecycle.filter(type => type === "connected")).toHaveLength(1);

		const snap = snapshotMcpRuntime(
			{
				name: SERVER,
				command: process.execPath,
				_source: { provider: "native", providerName: "OMP", level: "user", path: workDir },
			},
			manager,
		);
		expect(snap.health).toBe("connected");
		expect(snap.resources.map(item => item.name)).toContain(RESOURCE_NAME);
		expect(snap.prompts.map(item => item.name)).toContain(PROMPT_NAME);
	}, 20_000);

	it("repaints after reconnect catalogs finish, then stops after dashboard dispose", async () => {
		const settings = await Settings.init({ inMemory: true, cwd: workDir });
		const dashboard = await ExtensionDashboard.create({
			cwd: workDir,
			settings,
			mcpManager: manager,
		});
		let paints = 0;
		dashboard.onRequestRender = () => {
			paints += 1;
		};

		const lifecycle: string[] = [];
		const catalogs: Array<{ kind: string }> = [];
		manager.addConnectionStatusListener(event => {
			lifecycle.push(event.type);
		});
		manager.addCatalogChangeListener(event => {
			catalogs.push({ kind: event.kind });
		});

		await manager.connectServers({ [SERVER]: fixtureConfig() }, {});
		await waitUntil(() => lifecycle.includes("connected"), "initial connected");
		const paintsAtConnected = paints;
		expect(paintsAtConnected).toBeGreaterThan(0);
		expect(manager.getConnection(SERVER)?.resources).toBeUndefined();

		fs.writeFileSync(gate, "go");
		await waitUntil(() => catalogs.length >= 2, "initial catalogs");
		expect(paints).toBeGreaterThan(paintsAtConnected);
		expect(manager.getServerResources(SERVER)?.resources[0]?.uri).toBe(RESOURCE_URI);

		fs.unlinkSync(gate);
		const paintsBeforeReconnect = paints;
		const connectedBefore = lifecycle.filter(type => type === "connected").length;
		manager.getConnection(SERVER)?.transport.onClose?.();
		await waitUntil(
			() => lifecycle.filter(type => type === "connected").length > connectedBefore,
			"reconnect connected",
		);
		expect(lifecycle).toContain("connecting");
		expect(manager.getConnection(SERVER)?.resources).toBeUndefined();
		expect(manager.getConnection(SERVER)?.prompts).toBeUndefined();
		const catalogsBeforeRelease = catalogs.length;
		expect(paints).toBeGreaterThan(paintsBeforeReconnect);

		fs.writeFileSync(gate, "go");
		await waitUntil(() => catalogs.length >= catalogsBeforeRelease + 2, "reconnect catalogs");
		expect(manager.getServerPrompts(SERVER)?.[0]?.name).toBe(PROMPT_NAME);
		const paintsAfterReconnectCatalogs = paints;
		expect(paintsAfterReconnectCatalogs).toBeGreaterThan(paintsBeforeReconnect);

		dashboard.dispose();
		const paintsAtDispose = paints;
		await manager.refreshServerResources(SERVER);
		await Bun.sleep(50);
		expect(paints).toBe(paintsAtDispose);
	}, 20_000);
});
