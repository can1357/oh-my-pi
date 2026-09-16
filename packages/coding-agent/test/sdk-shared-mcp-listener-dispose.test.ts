/**
 * A session handed a caller-supplied `MCPManager` (`options.mcpManager`)
 * observes late tool sets through `addToolsChangedListener`. The manager
 * outlives the session, so that listener MUST be torn down when the session is
 * disposed.
 *
 * The bug: `sdk.ts` registered the listener's unsubscribe ONLY with the
 * process-global postmortem registry and discarded the returned cancel handle.
 * `session.dispose()` runs `disposeCallbacks`, not postmortem cleanup — so the
 * listener stayed on the manager and fired on every later tool update, and the
 * postmortem list kept the session closure alive until process exit. In a
 * long-running host that creates and disposes many sessions this is an
 * accumulating memory + notification-chain leak.
 *
 * The fix registers the unsubscribe with the session's disposal callbacks AND
 * cancels the postmortem registration during explicit dispose. This test
 * asserts both observable consequences: the listener no longer fires after
 * `dispose()`, and the postmortem registration is released on dispose.
 */
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "notifications-mcp.ts");
const SHARED_TOOLS_POSTMORTEM_ID = "mcp-shared-tools-listener";

function serverConfig(): MCPServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] };
}

describe("shared-manager tools listener teardown on session dispose", () => {
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	const tempDirs: string[] = [];
	const managers: MCPManager[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.disconnectAll();
		for (const dir of tempDirs.splice(0)) {
			if (fs.existsSync(dir)) removeSyncWithRetries(dir);
		}
		MCPManager.setInstance(undefined);
		spyOn(postmortem, "register").mockRestore();
	});

	function makeTempDir(): string {
		const dir = path.join(os.tmpdir(), `pi-shared-mcp-listener-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	it("stops firing the shared listener and releases its postmortem after dispose", async () => {
		// Wrap the postmortem cancel handle for the shared-tools registration so
		// its release is directly observable: pre-fix the returned cancel was
		// discarded and never invoked, so the registration leaked for the process
		// lifetime; post-fix explicit dispose invokes it.
		const realRegister = postmortem.register;
		let sharedToolsCancelReleases = 0;
		spyOn(postmortem, "register").mockImplementation((id, callback, options) => {
			const cancel = realRegister(id, callback, options);
			if (id !== SHARED_TOOLS_POSTMORTEM_ID) return cancel;
			return () => {
				sharedToolsCancelReleases += 1;
				cancel();
			};
		});

		const tempDir = makeTempDir();
		// A caller-supplied manager the session does NOT own: connected to a real
		// stdio fixture so a tools-changed emission has a live connection to fan
		// out from. It outlives the session, exactly the leak scenario.
		const manager = new MCPManager(tempDir);
		managers.push(manager);
		await manager.connectServers({ notifications: serverConfig() }, {});

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			enableMCP: true,
			// The seam that installs the observer: a manager the session shares
			// rather than owns.
			mcpManager: manager,
		});

		// The shared-tools listener rebinds through `session.refreshMCPTools`, so
		// spy it to observe whether the listener fires.
		const refreshSpy = spyOn(session, "refreshMCPTools");

		// While the session is live the observer fires on a tools-changed emit.
		await manager.refreshServerTools("notifications");
		const callsWhileLive = refreshSpy.mock.calls.length;
		expect(callsWhileLive).toBeGreaterThan(0);

		await session.dispose();

		// Consequence 1: the postmortem registration is released on dispose.
		// Pre-fix the cancel handle was discarded, so this stayed 0 and the
		// registration (with the whole session closure) leaked to process exit.
		expect(sharedToolsCancelReleases).toBe(1);

		// Consequence 2: the listener no longer fires. Pre-fix it was never
		// unsubscribed on dispose (only postmortem-registered), so this emit
		// rebound tools onto the disposed session — a call here would prove the
		// leaking notification chain.
		refreshSpy.mockClear();
		await manager.refreshServerTools("notifications");
		expect(refreshSpy).not.toHaveBeenCalled();
	}, 60_000);
});
