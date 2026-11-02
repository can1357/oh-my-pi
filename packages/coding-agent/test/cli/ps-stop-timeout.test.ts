import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { runPsCommand } from "../../src/cli/ps-cli";
import * as launchClient from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";

/** `omp ps stop --timeout`, in seconds: the first whole second past the ~24.8-day platform timer ceiling. */
const STOP_TIMEOUT_SECONDS = 2_147_484;
/** The client gives the broker the whole grace period plus 5 s to answer a stop. */
const REQUEST_TIMEOUT_MS = STOP_TIMEOUT_SECONDS * 1000 + 5_000;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Run every queued microtask; `setImmediate` is not faked by `vi.useFakeTimers()`. */
async function drainMicrotasks(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("omp ps stop --timeout", () => {
	it("waits for the broker's answer for the whole grace period past the platform timer ceiling", async () => {
		const exitCode = process.exitCode;
		cleanups.push(() => {
			process.exitCode = exitCode ?? 0;
		});
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ps-stop-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const projectDir = path.join(root, "project");
		const runtimeDir = path.join(root, "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir);

		// A broker that reads the stop request and never answers it.
		const received = Promise.withResolvers<unknown>();
		const connections = new Set<IpcConnection>();
		const server = await IpcServer.listen(daemonBrokerEndpoint(runtimeDir), { framing: "lines" }, connection => {
			connections.add(connection);
			connection.start(
				line => received.resolve(JSON.parse(line)),
				() => {},
			);
		});
		cleanups.push(async () => {
			for (const connection of connections) connection.destroy();
			await server.close();
		});
		const client = await launchClient.createDaemonBrokerClient(projectDir, { runtimeDir });
		cleanups.push(() => client.close());
		vi.spyOn(launchClient, "daemonClientForProject").mockResolvedValue(client);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		vi.useFakeTimers();
		let settled = false;
		const run = runPsCommand({
			action: "stop",
			name: "web",
			flags: { all: false, json: false, plain: false, follow: false, head: false, timeout: STOP_TIMEOUT_SECONDS },
		}).finally(() => {
			settled = true;
		});
		expect(await received.promise).toMatchObject({
			operation: { op: "stop", name: "web", timeoutMs: STOP_TIMEOUT_SECONDS * 1000 },
		});

		vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
		await drainMicrotasks();
		expect(errors).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(1);
		await run;
		expect(errors).toHaveBeenCalledTimes(1);
		expect(String(errors.mock.calls[0][0])).toContain("Daemon stop request timed out");
		expect(process.exitCode).toBe(1);
	});
});
