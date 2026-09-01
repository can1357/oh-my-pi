import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { findFreeCdpPort } from "../../src/tools/browser/attach";
import { probeRelayServer } from "../../src/tools/browser/relay/daemon";

/**
 * Per-consumer ready budget. Each consumer is a cold `bun` process that imports the whole
 * daemon module graph, which on a saturated CI runner has been observed to take longer than
 * the previous 15s. `awaitConsumerReady` aborts immediately if the consumer dies, so this
 * ceiling is only ever reached by a slow-but-healthy start.
 */
const MARKER_TIMEOUT_MS = 30_000;

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

/** The subset of a spawned consumer this file needs, kept structural so it survives Bun typing changes. */
type RelayConsumer = {
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	readonly exited: Promise<number>;
	kill(): void;
};

/**
 * Waits for a consumer to publish its ready marker, and explains itself when it does not.
 *
 * A bare `waitUntil(...marker exists...)` collapses three distinct outcomes into one
 * `expected false to be true`: the consumer threw, the consumer exited non-zero, or the
 * consumer is merely slow. The consumers are spawned with `stderr: "pipe"`, but that pipe
 * was only ever drained on the success path, and the enclosing `finally` removes the temp
 * home, so the evidence was destroyed before anyone could read it.
 *
 * Racing the marker against `exited` separates "dead" from "slow" and always surfaces the
 * child's stderr. It also means a crashed consumer fails in milliseconds instead of burning
 * the whole marker budget.
 */
async function awaitConsumerReady(
	consumer: RelayConsumer,
	marker: string,
	label: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(marker).exists()) return;
		if (consumer.exitCode !== null || consumer.signalCode !== null) {
			// Lost the race against a dying child: re-check the marker so a consumer that
			// wrote it and exited in the same tick is not misreported as a failure.
			if (await Bun.file(marker).exists()) return;
			throw new Error(
				`${label} consumer exited before publishing its ready marker ` +
					`(code=${consumer.exitCode}, signal=${consumer.signalCode})\n${await readStderr(consumer)}`,
			);
		}
		await Bun.sleep(50);
	}
	if (await Bun.file(marker).exists()) return;
	consumer.kill();
	await consumer.exited;
	throw new Error(
		`${label} consumer did not publish its ready marker within ${timeoutMs}ms ` +
			`(code=${consumer.exitCode}, signal=${consumer.signalCode})\n${await readStderr(consumer)}`,
	);
}

async function readStderr(consumer: RelayConsumer): Promise<string> {
	try {
		const text = (await new Response(consumer.stderr).text()).trim();
		return text || "<no stderr>";
	} catch (err) {
		return `<stderr unavailable: ${err}>`;
	}
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
			});

		const first = spawnConsumer(firstProject, "profile-a", firstMarker);
		try {
			await awaitConsumerReady(first, firstMarker, "first", MARKER_TIMEOUT_MS);
			expect(await probeRelayServer(cdpUrl)).toBeTrue();

			const second = spawnConsumer(secondProject, "profile-b", secondMarker);
			try {
				await awaitConsumerReady(second, secondMarker, "second", MARKER_TIMEOUT_MS);
				first.stdin.end();
				const firstExit = await first.exited;
				if (firstExit !== 0) throw new Error(await new Response(first.stderr).text());

				// The global broker's real idle clock must pass while the second client remains connected.
				await Bun.sleep(500);
				expect(await probeRelayServer(cdpUrl)).toBeTrue();

				second.stdin.end();
				const secondExit = await second.exited;
				if (secondExit !== 0) throw new Error(await new Response(second.stderr).text());
				expect(await waitUntil(async () => !(await probeRelayServer(cdpUrl)), 5_000)).toBeTrue();
			} finally {
				if (second.exitCode === null) second.kill();
				await second.exited;
			}
		} finally {
			if (first.exitCode === null) first.kill();
			await first.exited;
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
		// Budget must exceed the sum of the bounds inside the test: two MARKER_TIMEOUT_MS marker
		// waits plus the 5s shutdown probe are 65s of legitimate waiting, so a 60s cap let a
		// loaded runner kill the test mid-wait and report only "timed out after 60000ms" instead
		// of the marker diagnosis that actually failed. Each consumer is a cold `bun` process
		// importing the daemon module graph, so the spawns are slow exactly when the machine is
		// busy. Raising the ceiling is safe now that `awaitConsumerReady` fails fast on a dead
		// consumer: only a genuinely slow-but-alive start can reach the full budget.
	}, 120_000);
});
