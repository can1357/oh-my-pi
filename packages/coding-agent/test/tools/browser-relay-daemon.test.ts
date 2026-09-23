import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { findFreeCdpPort } from "../../src/tools/browser/attach";
import { probeRelayServer } from "../../src/tools/browser/relay/daemon";

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

type ConsumerProcess = Bun.Subprocess<"pipe", "ignore", "pipe">;

interface ObservedConsumer {
	process: ConsumerProcess;
	stderr: () => string;
	stderrClosed: Promise<void>;
}

function observeConsumer(process: ConsumerProcess): ObservedConsumer {
	let stderr = "";
	const stderrClosed = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of process.stderr) {
			stderr += decoder.decode(chunk, { stream: true });
		}
		stderr += decoder.decode();
	})();
	return { process, stderr: () => stderr, stderrClosed };
}

async function waitForConsumerReady(consumer: ObservedConsumer, marker: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(marker).exists()) return;
		if (consumer.process.exitCode !== null) break;
		// The readiness signal crosses a real child-process/filesystem boundary, so fake timers cannot drive it.
		await Promise.race([Bun.sleep(50), consumer.process.exited]);
	}
	if (await Bun.file(marker).exists()) return;
	const exitCode = consumer.process.exitCode;
	if (exitCode !== null) {
		await consumer.stderrClosed;
		const stderr = consumer.stderr().trim();
		throw new Error(
			`Relay consumer exited with code ${exitCode} before becoming ready${stderr ? `:\n${stderr}` : ""}`,
		);
	}
	expect(
		false,
		`Relay consumer did not become ready within ${timeoutMs}ms; stderr: ${consumer.stderr().trim() || "(empty)"}`,
	).toBeTrue();
}

async function stopConsumer(consumer: ObservedConsumer): Promise<void> {
	consumer.process.stdin.end();
	const [exitCode] = await Promise.all([consumer.process.exited, consumer.stderrClosed]);
	if (exitCode !== 0) throw new Error(consumer.stderr());
}

async function terminateConsumer(consumer: ObservedConsumer): Promise<void> {
	if (consumer.process.exitCode === null) consumer.process.kill();
	await Promise.all([consumer.process.exited, consumer.stderrClosed]);
}

describe("browser relay daemon", () => {
	it("bypasses HTTP_PROXY when probing the loopback relay", async () => {
		let relayHits = 0;
		let proxyHits = 0;
		const relay = Bun.serve({
			port: 0,
			fetch: () => {
				relayHits++;
				return new Response("waiting", { status: 503 });
			},
		});
		const proxy = Bun.serve({
			port: 0,
			fetch: () => {
				proxyHits++;
				return new Response("Bad Gateway", { status: 502 });
			},
		});
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { probeRelayServer } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/daemon.ts"))};
const url = Bun.env.OMP_TEST_RELAY_URL;
if (!url) throw new Error("missing relay URL");
process.stdout.write(String(await probeRelayServer(url)));`,
			],
			{
				env: {
					...process.env,
					HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
					http_proxy: `http://127.0.0.1:${proxy.port}`,
					NO_PROXY: "",
					no_proxy: "",
					OMP_TEST_RELAY_URL: `http://127.0.0.1:${relay.port}`,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toBe("true");
			expect(relayHits).toBe(1);
			expect(proxyHits).toBe(0);
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			await relay.stop(true);
			await proxy.stop(true);
		}
	});

	it("surfaces stderr when a consumer exits before becoming ready", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-failed-consumer-"));
		const marker = path.join(home, "ready");
		const consumer = observeConsumer(
			Bun.spawn([process.execPath, "-e", 'console.error("synthetic relay startup failure"); process.exit(1)'], {
				stdin: "pipe",
				stdout: "ignore",
				stderr: "pipe",
			}),
		);
		try {
			await expect(waitForConsumerReady(consumer, marker, 5_000)).rejects.toThrow("synthetic relay startup failure");
		} finally {
			await terminateConsumer(consumer);
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	it("stays alive while a consumer in another project holds the global broker lease", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-global-"));
		const firstProject = path.join(home, "project-a");
		const secondProject = path.join(home, "project-b");
		const firstMarker = path.join(home, "first-ready");
		const secondMarker = path.join(home, "second-ready");
		const globalRuntimeDir = path.join(home, ".omp", "run", "daemons", "global", "browser-relay");
		const cdpUrl = `http://127.0.0.1:${await findFreeCdpPort()}`;
		const scriptPath = path.join(home, "consumer.ts");
		await Promise.all([fs.mkdir(firstProject), fs.mkdir(secondProject)]);
		await Bun.write(
			scriptPath,
			`
import { closeDaemonClients } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/launch/client.ts"))};
import { ensureRelayDaemon } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/daemon.ts"))};

const cdpUrl = process.env.OMP_TEST_RELAY_URL;
const marker = process.env.OMP_TEST_READY_MARKER;
if (!cdpUrl || !marker) throw new Error("relay consumer environment is incomplete");
try {
	if (!(await ensureRelayDaemon({ cdpUrl }))) throw new Error("relay did not start");
	await Bun.write(marker, "ready");
	const stopped = Promise.withResolvers<void>();
	process.stdin.once("end", () => stopped.resolve());
	process.stdin.resume();
	await stopped.promise;
} finally {
	await closeDaemonClients();
}
`,
		);

		const spawnConsumer = (cwd: string, profile: string, marker: string) =>
			observeConsumer(
				Bun.spawn([process.execPath, scriptPath], {
					cwd,
					env: {
						...process.env,
						HOME: home,
						USERPROFILE: home,
						PI_CONFIG_DIR: ".omp",
						OMP_PROFILE: profile,
						OMP_DAEMON_IDLE_GRACE_MS: "200",
						OMP_TEST_RELAY_URL: cdpUrl,
						OMP_TEST_READY_MARKER: marker,
					},
					stdin: "pipe",
					stdout: "ignore",
					stderr: "pipe",
				}),
			);

		const first = spawnConsumer(firstProject, "profile-a", firstMarker);
		try {
			await waitForConsumerReady(first, firstMarker, 15_000);
			expect(await probeRelayServer(cdpUrl)).toBeTrue();

			const second = spawnConsumer(secondProject, "profile-b", secondMarker);
			try {
				await waitForConsumerReady(second, secondMarker, 15_000);
				await stopConsumer(first);
				// The global broker's real idle clock must pass while the second client remains connected.
				await Bun.sleep(500);
				expect(await probeRelayServer(cdpUrl)).toBeTrue();

				await stopConsumer(second);
				expect(await waitUntil(async () => !(await probeRelayServer(cdpUrl)), 5_000)).toBeTrue();
			} finally {
				await terminateConsumer(second);
			}
		} finally {
			await terminateConsumer(first);
			const rescue = await createDaemonBrokerClient(globalRuntimeDir, {
				runtimeDir: globalRuntimeDir,
				idleGraceMs: 200,
			});
			try {
				await rescue.request({ op: "shutdown" });
			} catch {
				// The last-client grace may already have stopped the broker.
			}
			rescue.close();
			await fs.rm(home, { recursive: true, force: true });
		}
		// Budget must exceed the sum of the bounds inside the test: two 15s marker waits
		// plus the 5s shutdown probe are 35s of legitimate waiting, so a 30s cap let a
		// loaded runner kill the test mid-`waitUntil` and report only "timed out after
		// 30000ms" instead of the marker assertion that actually failed. Each consumer is
		// a cold `bun` process importing the daemon module graph, so the spawns are slow
		// exactly when the machine is busy.
	}, 60_000);
});
