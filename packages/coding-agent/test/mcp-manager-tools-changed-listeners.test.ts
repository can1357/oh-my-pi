/**
 * `setOnToolsChanged` has exactly ONE owner slot, held by whoever built the
 * manager. A session handed a manager it does not own — a top-level embedder
 * passing `mcpManager`, or a subagent sharing its parent's — therefore had no
 * way to receive a tool set published after its own snapshot, so a server whose
 * listing outlives the startup timeout (left in the background by
 * `connectServers`) never reached that session's registry.
 *
 * `addToolsChangedListener` is the non-destructive observer that fixes it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "notifications-mcp.ts");
const BUN_EXEC = process.execPath;

function serverConfig(): MCPServerConfig {
	return { type: "stdio", command: BUN_EXEC, args: [FIXTURE_PATH] };
}

describe("MCPManager tools-changed listeners", () => {
	let tempDir: string;
	let manager: MCPManager | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-changed-"));
	});

	afterEach(async () => {
		await manager?.disconnectAll();
		manager = undefined;
		removeSyncWithRetries(tempDir);
	});

	it("notifies an observer without displacing the owner handler", async () => {
		manager = new MCPManager(tempDir);
		const ownerCalls: number[] = [];
		const observerCalls: number[] = [];
		const owner = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<void>();
		// The owner slot, as the session that BUILT the manager takes it.
		manager.setOnToolsChanged(tools => {
			ownerCalls.push(tools.length);
			owner.resolve();
		});
		// A second session sharing the manager, which must not take that slot.
		const unsubscribe = manager.addToolsChangedListener(tools => {
			observerCalls.push(tools.length);
			observed.resolve();
		});

		await manager.connectServers({ notifications: serverConfig() }, {});
		await Promise.all([owner.promise, observed.promise]);

		// RED (pre-fix): no observer hook existed at all, so a shared-manager
		// session received nothing.
		expect(observerCalls.length).toBeGreaterThan(0);
		// And the owner still fires — the observer is additive, not a replacement.
		expect(ownerCalls.length).toBeGreaterThan(0);

		// Unsubscribing stops delivery, so a disposed session cannot be rebound.
		unsubscribe();
		const before = observerCalls.length;
		await manager.refreshServerTools("notifications");
		expect(observerCalls.length).toBe(before);
	}, 60_000);

	it("isolates a throwing observer from the owner handler", async () => {
		manager = new MCPManager(tempDir);
		const ownerCalls: number[] = [];
		const owner = Promise.withResolvers<void>();
		// Records that the throwing observer actually RAN: without it this test
		// also passes when observers are never invoked at all.
		let observerRan = false;
		manager.addToolsChangedListener(() => {
			observerRan = true;
			throw new Error("observer failure");
		});
		manager.setOnToolsChanged(tools => {
			ownerCalls.push(tools.length);
			owner.resolve();
		});

		await manager.connectServers({ notifications: serverConfig() }, {});
		await owner.promise;

		expect(observerRan).toBe(true);
		expect(ownerCalls.length).toBeGreaterThan(0);
	}, 60_000);

	it("isolates a rejecting owner handler from observers", async () => {
		manager = new MCPManager(tempDir);
		// The owner slot rejects — exactly the caller-supplied `setOnToolsChanged`
		// handler that throws or returns a rejected promise. Before the fix the
		// await in `#emitToolsChanged` rejected here, so no observer ran and the
		// discarded promise surfaced as an unhandled rejection.
		manager.setOnToolsChanged(async () => {
			throw new Error("owner failure");
		});
		// Records that the observer actually RAN: without it this test also passes
		// when observers are never reached because the fixture never fires.
		let observerRan = false;
		const observed = Promise.withResolvers<void>();
		const observerCalls: number[] = [];
		manager.addToolsChangedListener(tools => {
			observerRan = true;
			observerCalls.push(tools.length);
			observed.resolve();
		});

		await manager.connectServers({ notifications: serverConfig() }, {});
		await observed.promise;

		// RED (pre-fix): the owner reject short-circuited the emit, so the
		// observer never ran and `observerRan` stayed false.
		expect(observerRan).toBe(true);
		expect(observerCalls.length).toBeGreaterThan(0);
	}, 60_000);
});
