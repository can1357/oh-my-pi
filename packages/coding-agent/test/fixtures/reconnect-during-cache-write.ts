import * as path from "node:path";
import { MCPManager } from "../../src/mcp/manager";
import { MCPToolCache } from "../../src/mcp/tool-cache";
import type { MCPResultCacheHint, MCPServerConfig, MCPToolDefinition } from "../../src/mcp/types";
import { AgentStorage } from "../../src/session/agent-storage";

/** Real SQLite cache with a scheduling barrier around its persistence boundary. */
class CloseDuringWriteCache extends MCPToolCache {
	#beforeWrite: (name: string) => Promise<void>;

	constructor(storage: AgentStorage, beforeWrite: (name: string) => Promise<void>) {
		super(storage);
		this.#beforeWrite = beforeWrite;
	}

	override async set(
		name: string,
		config: MCPServerConfig,
		tools: MCPToolDefinition[],
		hint: MCPResultCacheHint | undefined,
	): Promise<boolean> {
		await this.#beforeWrite(name);
		return super.set(name, config, tools, hint);
	}
}

const [workDir, spawnLog] = process.argv.slice(2);
if (!workDir || !spawnLog) throw new Error("Expected isolated work directory and spawn log");
const storage = await AgentStorage.open(path.join(workDir, "agent.db"));
let observedCloses = 0;
const cache = new CloseDuringWriteCache(storage, async name => {
	const connection = manager.getConnection(name);
	if (!connection) throw new Error("Connection missing before persistence barrier");
	const closed = Promise.withResolvers<void>();
	const onClose = connection.transport.onClose;
	connection.transport.onClose = () => {
		onClose?.();
		observedCloses++;
		closed.resolve();
	};
	// The real server exits only after this notification. Its real EOF event
	// must reach the manager while cache persistence is still awaiting it.
	await connection.transport.notify("notifications/test/exit", {});
	await closed.promise;
});
const manager = new MCPManager(workDir, cache);
try {
	await manager.connectServers(
		{
			crashy: {
				type: "stdio",
				command: process.execPath,
				args: [path.join(import.meta.dir, "crash-after-init-mcp.ts")],
				env: { OMP_TEST_SPAWN_LOG: spawnLog, OMP_TEST_EXIT_ON_NOTIFICATION: "1" },
			},
		},
		{},
	);
	const deadline = Date.now() + 25_000;
	while (manager.getConnectionStatus("crashy") !== "disconnected" && Date.now() < deadline) await Bun.sleep(5);
	const spawnCount = (await Bun.file(spawnLog).text()).split("\n").filter(Boolean).length;
	process.stdout.write(
		`${JSON.stringify({
			status: manager.getConnectionStatus("crashy"),
			spawnCount,
			observedCloses,
			hasConnection: !!manager.getConnection("crashy"),
		})}\n`,
	);
} finally {
	await manager.disconnectAll();
	// This fixture runs in its own process; closing its SQLite singletons cannot
	// disturb other test files or their in-flight requests.
	AgentStorage.resetInstance();
}
