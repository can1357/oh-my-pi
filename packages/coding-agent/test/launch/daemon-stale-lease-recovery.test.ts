import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";

const TEST_TIMEOUT_MS = 30_000;

async function waitForFileGone(filePath: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!(await Bun.file(filePath).exists())) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(50);
	}
}

/** Run one client against a private scope, then shut the broker down again. */
async function withScope(
	projectDir: string,
	runtimeDir: string,
	body: (client: DaemonBrokerClient) => Promise<void>,
): Promise<void> {
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(runtimeDir, { recursive: true });
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
	try {
		await body(client);
	} finally {
		try {
			await client.request({ op: "shutdown" });
		} catch {
			// The last-client grace may already have stopped the broker.
		}
		client.close();
	}
}

describe("daemon broker lease recovery", () => {
	it(
		"starts a broker when broker.pid records a live but unrelated PID (issue #11080)",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stale-lease-"));
			const pidPath = path.join(root, "run", "broker.pid");
			try {
				await fs.mkdir(path.join(root, "run"), { recursive: true });
				// A broker killed before it could clean up leaves its lease behind,
				// and the OS can later hand that PID to an unrelated live process.
				// Liveness of the recorded PID therefore says nothing about the broker.
				await Bun.write(pidPath, JSON.stringify({ pid: process.pid, instanceId: "crashed-broker" }));

				await withScope(path.join(root, "project"), path.join(root, "run"), async client => {
					const ping = await client.request({ op: "ping" });
					if (ping.op !== "ping") throw new Error(`unexpected daemon result ${ping.op}`);
					expect(ping.projectDir).toBe(client.projectDir);

					const lease = (await Bun.file(pidPath).json()) as { pid?: number };
					expect(lease.pid).toBeDefined();
					expect(lease.pid).not.toBe(process.pid);
				});

				// Cleanup semantics survive recovery: the lease goes with the broker.
				expect(await waitForFileGone(pidPath, 5_000)).toBe(true);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"starts a broker from a cold scope with no broker.pid",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cold-lease-"));
			try {
				await withScope(path.join(root, "project"), path.join(root, "run"), async client => {
					const ping = await client.request({ op: "ping" });
					if (ping.op !== "ping") throw new Error(`unexpected daemon result ${ping.op}`);
					expect(ping.projectDir).toBe(client.projectDir);
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
});
