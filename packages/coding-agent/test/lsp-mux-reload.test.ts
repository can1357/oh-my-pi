import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as daemonClient from "../src/launch/client";
import { daemonRuntimeDir } from "../src/launch/paths";
import * as lspClient from "../src/lsp/client";
import { LspMuxServer } from "../src/lsp/mux/server";
import type { ServerConfig } from "../src/lsp/types";

const fixturePath = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
	// The mux stops servers asynchronously; poll with a wall-clock bound far below its 5-minute idle linger.
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isRunning(pid)) return true;
		await Bun.sleep(25);
	}
	return !isRunning(pid);
}

describe("lsp reload through the shared mux", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stops the server of a superseded shared client instead of leaving it idle in the mux", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-mux-reload-");
		const runtimeDir = daemonRuntimeDir(tempDir.path());
		const mux = new LspMuxServer();
		const shared = lspClient.holdSharedLsp(true);
		try {
			await fs.mkdir(runtimeDir, { recursive: true });
			await mux.listen(ipcEndpoint(runtimeDir, "lsp-mux"));
			// The client finds this in-process mux at the project's endpoint; the broker only has to answer its ping.
			vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue({
				projectDir: tempDir.path(),
				request: async () => ({}),
			} as unknown as daemonClient.DaemonBrokerClient);

			const config: ServerConfig = {
				command: process.execPath,
				args: ["run", fixturePath],
				fileTypes: [".ts"],
				rootMarkers: [],
			};
			const client = await lspClient.getOrCreateClient(config, tempDir.path());
			expect(client.proc.sharedMux).toBe(true);
			const serverPid = client.proc.pid;
			if (serverPid === undefined) throw new Error("mux handshake reported no server pid");
			expect(isRunning(serverPid)).toBe(true);

			const reloaded: ServerConfig = { ...config, initOptions: { reloaded: true } };
			expect(await lspClient.shutdownStaleClients(tempDir.path(), [reloaded])).toEqual([process.execPath]);
			expect(await waitForProcessExit(serverPid, 3_000)).toBe(true);
		} finally {
			shared.release();
			await lspClient.shutdownAll();
			await mux.shutdown();
			await fs.rm(runtimeDir, { recursive: true, force: true });
			tempDir.removeSync();
		}
	}, 15_000);
});
