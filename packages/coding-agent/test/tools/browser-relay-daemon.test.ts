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

	it("keeps one port's relay running when another relay starts on a different port", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-ports-"));
		const globalRuntimeDir = path.join(home, ".omp", "run", "daemons", "global", "browser-relay");
		const firstPort = await findFreeCdpPort();
		let secondPort = await findFreeCdpPort();
		// The finder releases its probe listener, so it can hand back the same port twice.
		while (secondPort === firstPort) secondPort = await findFreeCdpPort();
		const firstUrl = `http://127.0.0.1:${firstPort}`;
		const secondUrl = `http://127.0.0.1:${secondPort}`;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { closeDaemonClients } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/launch/client.ts"))};
import { ensureRelayDaemon, probeRelayServer } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/daemon.ts"))};
const [first, second] = [Bun.env.OMP_TEST_FIRST_RELAY_URL!, Bun.env.OMP_TEST_SECOND_RELAY_URL!];
try {
	const started = [await ensureRelayDaemon({ cdpUrl: first }), await ensureRelayDaemon({ cdpUrl: second })];
	const serving = [await probeRelayServer(first), await probeRelayServer(second)];
	process.stdout.write(JSON.stringify({ started, serving }));
} finally {
	await closeDaemonClients();
}`,
			],
			{
				cwd: home,
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					PI_CONFIG_DIR: ".omp",
					OMP_DAEMON_IDLE_GRACE_MS: "200",
					OMP_TEST_FIRST_RELAY_URL: firstUrl,
					OMP_TEST_SECOND_RELAY_URL: secondUrl,
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
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({ started: [true, true], serving: [true, true] });
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
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
	}, 60_000);

	it("replaces a broker-owned relay from an older omp version, also after another omp stopped it, but not a starting replacement, a newer relay, or a manually started one", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-restart-"));
		const ownedPort = await findFreeCdpPort();
		let manualPort = await findFreeCdpPort();
		while (manualPort === ownedPort) manualPort = await findFreeCdpPort();
		// Stands in for a relay: serves /json/version after an optional delay, reporting the given version or,
		// like a relay from an older omp, no version or capability markers.
		const staleRelayPath = path.join(home, "stand-in-relay.ts");
		await Bun.write(
			staleRelayPath,
			`const [port, delayMs, version] = process.argv.slice(2);
await Bun.sleep(Number(delayMs ?? 0));
Bun.serve({ hostname: "127.0.0.1", port: Number(port), fetch: () => Response.json({ Browser: "Chrome/1", ompRelayVersion: version }) });
console.log(\`omp browser relay listening on http://127.0.0.1:\${port}\`);
`,
		);
		const result = await runWithIsolatedBroker(
			home,
			`import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { closeDaemonClients, daemonClientForGlobal } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/launch/client.ts"))};
import { restartRelayDaemon } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/daemon.ts"))};
const [ownedPort, manualPort, standIn] = [Bun.env.OMP_TEST_OWNED_PORT!, Bun.env.OMP_TEST_MANUAL_PORT!, Bun.env.OMP_TEST_STALE_RELAY!];
const name = \`omp.browser.relay.\${ownedPort}\`;
const ownedUrl = \`http://127.0.0.1:\${ownedPort}\`;
const versionAt = async (port: string) => {
	const response = await fetch(\`http://127.0.0.1:\${port}/json/version\`).catch(() => null);
	if (!response) return "unreachable";
	const body: unknown = await response.json();
	return typeof body === "object" && body !== null && "ompRelayVersion" in body ? body.ompRelayVersion : null;
};
const manual = Bun.spawn([process.execPath, standIn, manualPort], { stdout: "pipe" });
let manualOverRecord: { kill(): void } | undefined;
try {
	const client = await daemonClientForGlobal("browser-relay");
	const start = (args: string[]) =>
		client.request({
			op: "start",
			spec: {
				name,
				application: process.execPath,
				args: [standIn, ...args],
				env: {},
				cwd: process.cwd(),
				pty: false,
				ready: { log: "browser relay listening", timeoutMs: 15_000 },
				restart: "no",
				persist: false,
				detached: false,
			},
		});
	const describe = async () => (await client.request({ op: "describe", name })).daemon;
	await start([ownedPort]);
	await manual.stdout.getReader().read();
	const owned = await restartRelayDaemon({ cdpUrl: ownedUrl });
	const ownedVersionIsCurrent = (await versionAt(ownedPort)) === VERSION;
	// Another omp of this version is still starting its replacement when this one decides to restart.
	await client.request({ op: "stop", name, timeoutMs: 5_000 });
	const starting = start([ownedPort, "1000", VERSION]);
	let snapshot = await describe();
	while (snapshot?.state === "exited") snapshot = await describe();
	const startingPid = snapshot?.pid;
	const startingRestarted = await restartRelayDaemon({ cdpUrl: ownedUrl });
	await starting;
	const startingKeptPid = (await describe())?.pid;
	// Another omp stopped the outdated relay and has not registered its replacement yet.
	await client.request({ op: "stop", name, timeoutMs: 5_000 });
	const exitedRestarted = await restartRelayDaemon({ cdpUrl: ownedUrl });
	const exitedVersionIsCurrent = (await versionAt(ownedPort)) === VERSION;
	// A relay started by hand on a port whose broker record has exited is not the broker's to replace.
	await client.request({ op: "stop", name, timeoutMs: 5_000 });
	const manualOnOwnedPort = Bun.spawn([process.execPath, standIn, ownedPort], { stdout: "pipe" });
	manualOverRecord = manualOnOwnedPort;
	await manualOnOwnedPort.stdout.getReader().read();
	const manualOverRecordRestarted = await restartRelayDaemon({ cdpUrl: ownedUrl });
	const manualOverRecordVersion = await versionAt(ownedPort);
	const ownedRecordState = (await describe())?.state;
	manualOnOwnedPort.kill();
	await manualOnOwnedPort.exited;
	// A concurrently running newer omp owns a newer relay; replacing it would only start a tug of war.
	await start([ownedPort, "0", "999.0.0"]);
	const newerPid = (await describe())?.pid;
	const newerRestarted = await restartRelayDaemon({ cdpUrl: ownedUrl });
	const newerKept = newerPid !== undefined && (await describe())?.pid === newerPid;
	const newerVersion = await versionAt(ownedPort);
	const manualRestarted = await restartRelayDaemon({ cdpUrl: \`http://127.0.0.1:\${manualPort}\` });
	const manualRecord = await client
		.request({ op: "describe", name: \`omp.browser.relay.\${manualPort}\` })
		.then(response => response.daemon ?? null, () => null);
	process.stdout.write(
		JSON.stringify({
			owned,
			ownedVersionIsCurrent,
			startingRestarted,
			startingKept: startingPid !== undefined && startingPid === startingKeptPid,
			exitedRestarted,
			exitedVersionIsCurrent,
			manualOverRecordRestarted,
			manualOverRecordVersion,
			ownedRecordState,
			newerRestarted,
			newerKept,
			newerVersion,
			manualRestarted,
			manualVersion: await versionAt(manualPort),
			manualRecord,
		}),
	);
} finally {
	manual.kill();
	manualOverRecord?.kill();
	await closeDaemonClients();
}`,
			{
				OMP_TEST_OWNED_PORT: String(ownedPort),
				OMP_TEST_MANUAL_PORT: String(manualPort),
				OMP_TEST_STALE_RELAY: staleRelayPath,
			},
		);
		expect(result).toEqual({
			owned: true,
			ownedVersionIsCurrent: true,
			startingRestarted: true,
			startingKept: true,
			exitedRestarted: true,
			exitedVersionIsCurrent: true,
			manualOverRecordRestarted: false,
			manualOverRecordVersion: null,
			ownedRecordState: "exited",
			newerRestarted: false,
			newerKept: true,
			newerVersion: "999.0.0",
			manualRestarted: false,
			manualVersion: null,
			manualRecord: null,
		});
	}, 60_000);

	it("replaces a compatible older broker-owned relay only while no CDP client uses it and it reports its clients", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-idle-restart-"));
		const ownedPort = await findFreeCdpPort();
		let manualPort = await findFreeCdpPort();
		while (manualPort === ownedPort) manualPort = await findFreeCdpPort();
		// Stands in for a ready relay of the given version; an empty client count stands in for a relay that predates it.
		const standIn = path.join(home, "stand-in-relay.ts");
		await Bun.write(
			standIn,
			`const [port, version, clients] = process.argv.slice(2);
Bun.serve({
	hostname: "127.0.0.1",
	port: Number(port),
	fetch: () =>
		Response.json({ Browser: "Chrome/1", ompRelayVersion: version, ...(clients ? { ompRelayCdpClients: Number(clients) } : {}) }),
});
console.log(\`omp browser relay listening on http://127.0.0.1:\${port}\`);
`,
		);
		const result = await runWithIsolatedBroker(
			home,
			`import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { closeDaemonClients, daemonClientForGlobal } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/launch/client.ts"))};
import { restartRelayDaemon } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/daemon.ts"))};
const [ownedPort, manualPort, standIn] = [Bun.env.OMP_TEST_OWNED_PORT!, Bun.env.OMP_TEST_MANUAL_PORT!, Bun.env.OMP_TEST_STALE_RELAY!];
const name = \`omp.browser.relay.\${ownedPort}\`;
const ownedUrl = \`http://127.0.0.1:\${ownedPort}\`;
const manual = Bun.spawn([process.execPath, standIn, manualPort, "18.0.0", "0"], { stdout: "pipe" });
try {
	const client = await daemonClientForGlobal("browser-relay");
	const describe = () =>
		client.request({ op: "describe", name }).then(
			response => response.daemon,
			() => undefined,
		);
	const versionAt = async (port: string) => {
		const body: unknown = await (await fetch(\`http://127.0.0.1:\${port}/json/version\`)).json();
		return typeof body === "object" && body !== null && "ompRelayVersion" in body ? body.ompRelayVersion : null;
	};
	// Starts a stand-in under the broker, asks for an idle-only restart, and reports whether the stand-in kept serving.
	const restartOwned = async (version: string, clients: string) => {
		const previous = await describe();
		if (previous && previous.state !== "exited" && previous.state !== "failed") {
			await client.request({ op: "stop", name, timeoutMs: 5_000 });
		}
		await client.request({
			op: "start",
			spec: {
				name,
				application: process.execPath,
				args: [standIn, ownedPort, version, clients],
				env: {},
				cwd: process.cwd(),
				pty: false,
				ready: { log: "browser relay listening", timeoutMs: 15_000 },
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		const pid = (await describe())?.pid;
		const restarted = await restartRelayDaemon({ cdpUrl: ownedUrl, idleOnly: true });
		return { restarted, kept: pid !== undefined && (await describe())?.pid === pid, version: await versionAt(ownedPort) };
	};
	const olderIdle = await restartOwned("18.0.0", "0");
	const olderInUse = await restartOwned("18.0.0", "1");
	const newerIdle = await restartOwned("999.0.0", "0");
	const olderUncounted = await restartOwned("18.0.0", "");
	await manual.stdout.getReader().read();
	const manualRestarted = await restartRelayDaemon({ cdpUrl: \`http://127.0.0.1:\${manualPort}\`, idleOnly: true });
	process.stdout.write(
		JSON.stringify({
			olderIdle: { ...olderIdle, version: olderIdle.version === VERSION ? "current" : olderIdle.version },
			olderInUse,
			newerIdle,
			olderUncounted,
			manual: { restarted: manualRestarted, version: await versionAt(manualPort) },
		}),
	);
} finally {
	manual.kill();
	await closeDaemonClients();
}`,
			{
				OMP_TEST_OWNED_PORT: String(ownedPort),
				OMP_TEST_MANUAL_PORT: String(manualPort),
				OMP_TEST_STALE_RELAY: standIn,
			},
		);
		expect(result).toEqual({
			olderIdle: { restarted: true, kept: false, version: "current" },
			olderInUse: { restarted: false, kept: true, version: "18.0.0" },
			newerIdle: { restarted: false, kept: true, version: "999.0.0" },
			olderUncounted: { restarted: false, kept: true, version: "18.0.0" },
			manual: { restarted: false, version: "18.0.0" },
		});
	}, 60_000);

	it("keeps a replacement another omp started while this one was about to stop the outdated relay", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-restart-race-"));
		const port = String(await findFreeCdpPort());
		const standIn = path.join(home, "stand-in-relay.ts");
		await Bun.write(
			standIn,
			`const port = Number(process.argv[2]);
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ Browser: "Chrome/1" }) });
console.log(\`omp browser relay listening on http://127.0.0.1:\${port}\`);
`,
		);
		const result = await runWithIsolatedBroker(
			home,
			`import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { closeDaemonClients, daemonClientForGlobal } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/launch/client.ts"))};
import { restartRelayDaemon } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/daemon.ts"))};
const [port, standIn] = [Bun.env.OMP_TEST_PORT!, Bun.env.OMP_TEST_STALE_RELAY!];
const name = \`omp.browser.relay.\${port}\`;
const cdpUrl = \`http://127.0.0.1:\${port}\`;
try {
	const client = await daemonClientForGlobal("browser-relay");
	await client.request({
		op: "start",
		spec: {
			name,
			application: process.execPath,
			args: [standIn, port],
			env: {},
			cwd: process.cwd(),
			pty: false,
			ready: { log: "browser relay listening", timeoutMs: 15_000 },
			restart: "no",
			persist: false,
			detached: false,
		},
	});
	// The late omp has judged the relay outdated; its stop reaches the broker only after another omp replaced it.
	const request = client.request.bind(client);
	const stopHeld = Promise.withResolvers<void>();
	const stopReleased = Promise.withResolvers<void>();
	let holdStop = true;
	client.request = async (operation, signal) => {
		if (operation.op === "stop" && holdStop) {
			holdStop = false;
			stopHeld.resolve();
			await stopReleased.promise;
		}
		return request(operation, signal);
	};
	const late = restartRelayDaemon({ cdpUrl });
	await stopHeld.promise;
	const first = await restartRelayDaemon({ cdpUrl });
	const replacement = (await client.request({ op: "describe", name })).daemon;
	stopReleased.resolve();
	const lateRestarted = await late;
	const current = (await client.request({ op: "describe", name })).daemon;
	const body: unknown = await (await fetch(\`\${cdpUrl}/json/version\`)).json();
	process.stdout.write(
		JSON.stringify({
			first,
			lateRestarted,
			replacementKept: current.id === replacement.id && current.pid === replacement.pid,
			state: current.state,
			versionIsCurrent: typeof body === "object" && body !== null && "ompRelayVersion" in body && body.ompRelayVersion === VERSION,
		}),
	);
} finally {
	await closeDaemonClients();
}`,
			{ OMP_TEST_PORT: port, OMP_TEST_STALE_RELAY: standIn },
		);
		expect(result).toEqual({
			first: true,
			lateRestarted: true,
			replacementKept: true,
			state: "ready",
			versionIsCurrent: true,
		});
	}, 60_000);

	it("rejects with an abort, not an outdated relay, when aborted while probing a relay the broker does not run", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-restart-abort-"));
		const result = await runWithIsolatedBroker(
			home,
			`import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { closeDaemonClients, daemonClientForGlobal } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/launch/client.ts"))};
import { acquireBrowser } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/registry.ts"))};
const controller = new AbortController();
let restarting = false;
// A relay started by hand from an older omp; the acquisition is aborted while the restart probes it.
const relay = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => {
		if (restarting) controller.abort();
		return Response.json({ Browser: "Chrome/1" });
	},
});
const cdpUrl = \`http://127.0.0.1:\${relay.port}\`;
try {
	// Start the broker first: the declared host is this script, which cannot serve as the broker.
	const client = await daemonClientForGlobal("browser-relay");
	await client.request({ op: "ping" });
	const request = client.request.bind(client);
	// Only the restart describes the relay's broker record; the first ensure adopts the serving relay.
	client.request = (operation, signal) => {
		if (operation.op === "describe") restarting = true;
		return request(operation, signal);
	};
	declareWorkerHostEntry();
	const error = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd(), signal: controller.signal }).then(
		() => null,
		(failure: unknown) => failure,
	);
	process.stdout.write(
		JSON.stringify({
			abortedWhileRestarting: restarting && controller.signal.aborted,
			error: error instanceof Error ? error.name : String(error),
			relayServing: (await fetch(\`\${cdpUrl}/json/version\`)).ok,
		}),
	);
} finally {
	await relay.stop(true);
	await closeDaemonClients();
}`,
			{},
		);
		expect(result).toEqual({ abortedWhileRestarting: true, error: "ToolAbortError", relayServing: true });
	}, 60_000);

	it("replaces a compatible older broker-owned relay nobody uses when acquiring the browser, and connects to the replacement", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-idle-acquire-"));
		const port = String(await findFreeCdpPort());
		const source = (file: string) => JSON.stringify(path.resolve(import.meta.dir, "../../src", file));
		const utils = (file: string) => JSON.stringify(path.resolve(import.meta.dir, "../../../utils/src", file));
		const standIn = path.join(home, "stand-in-relay.ts");
		await Bun.write(
			standIn,
			`import { DISCARDED_TABS_PROTOCOL_VERSION } from ${source("tools/browser/relay/protocol.ts")};
const port = Number(process.argv[2]);
// A compatible relay from an older omp with no CDP client; it never accepts an extension.
Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch: () =>
		Response.json({
			ompRelayVersion: "18.0.0",
			ompRelayDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
			ompExtensionDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
			ompRelayCdpClients: 0,
		}),
});
console.log(\`omp browser relay listening on http://127.0.0.1:\${port}\`);
`,
		);
		// The acquiring omp is also the worker host the registry spawns its replacement relay through.
		const host = path.join(home, "host.ts");
		await Bun.write(
			host,
			`import { VERSION } from ${utils("dirs.ts")};
import { declareWorkerHostEntry } from ${utils("worker-host.ts")};
import { closeDaemonClients, daemonClientForGlobal } from ${source("launch/client.ts")};
import { acquireBrowser, releaseBrowser } from ${source("tools/browser/registry.ts")};
import { DISCARDED_TABS_PROTOCOL_VERSION } from ${source("tools/browser/relay/protocol.ts")};
import { startRelayServer } from ${source("tools/browser/relay/server.ts")};

if (process.argv[2] === "browser-relay") {
	const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
	startRelayServer({ port });
	console.log(\`omp browser relay listening on http://127.0.0.1:\${port}\`);
} else {
	const [port, standIn] = [Bun.env.OMP_TEST_PORT!, Bun.env.OMP_TEST_STALE_RELAY!];
	const name = \`omp.browser.relay.\${port}\`;
	const cdpUrl = \`http://127.0.0.1:\${port}\`;
	// Stands in for the extension: redials until a relay accepts it, as the real one does after its relay stops.
	const connectExtension = async (): Promise<WebSocket> => {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const socket = new WebSocket(\`ws://127.0.0.1:\${port}/ext\`);
			const opened = Promise.withResolvers<boolean>();
			socket.addEventListener("open", () => opened.resolve(true), { once: true });
			socket.addEventListener("error", () => opened.resolve(false), { once: true });
			if (await opened.promise) {
				socket.send(JSON.stringify({ t: "hello", userAgent: "test", browserVersion: "Chrome/1", tabs: [], attachedTabIds: [], discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION }));
				return socket;
			}
			await Bun.sleep(50);
		}
		throw new Error("no relay accepted the extension");
	};
	try {
		// Start the broker before declaring this script the worker host: it cannot serve as the broker.
		const client = await daemonClientForGlobal("browser-relay");
		await client.request({
			op: "start",
			spec: {
				name,
				application: process.execPath,
				args: [standIn, port],
				env: {},
				cwd: process.cwd(),
				pty: false,
				ready: { log: "browser relay listening", timeoutMs: 15_000 },
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		const olderPid = (await client.request({ op: "describe", name })).daemon.pid;
		declareWorkerHostEntry();
		const extension = connectExtension();
		const handle = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() });
		const body: unknown = await (await fetch(\`\${cdpUrl}/json/version\`)).json();
		const current = (await client.request({ op: "describe", name })).daemon;
		process.stdout.write(
			JSON.stringify({
				connected: "browser" in handle && handle.browser.connected,
				replaced: current.pid !== olderPid && current.state === "ready",
				versionIsCurrent: typeof body === "object" && body !== null && "ompRelayVersion" in body && body.ompRelayVersion === VERSION,
				cdpClients: typeof body === "object" && body !== null && "ompRelayCdpClients" in body ? body.ompRelayCdpClients : null,
			}),
		);
		await releaseBrowser(handle, { kill: false });
		(await extension).close();
	} finally {
		await closeDaemonClients();
	}
}
`,
		);
		const result = await runWithIsolatedBroker(
			home,
			{ file: host },
			{ OMP_TEST_PORT: port, OMP_TEST_STALE_RELAY: standIn },
		);
		expect(result).toEqual({ connected: true, replaced: true, versionIsCurrent: true, cdpClients: 1 });
	}, 60_000);

	it("probes again when another omp replaced the idle older relay with an incompatible newer one before the restart", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-idle-raced-"));
		const result = await runWithIsolatedBroker(
			home,
			`import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { closeDaemonClients, daemonClientForGlobal } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/launch/client.ts"))};
import { acquireBrowser } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/registry.ts"))};
import { DISCARDED_TABS_PROTOCOL_VERSION } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/protocol.ts"))};
// A compatible relay from an older omp that nobody is connected to, until a newer omp with another protocol replaces it.
let served = {
	ompRelayVersion: "18.0.0",
	ompRelayDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
	ompExtensionDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
	ompRelayCdpClients: 0,
};
const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(served) });
const cdpUrl = \`http://127.0.0.1:\${relay.port}\`;
try {
	// Start the broker first: the declared host is this script, which cannot serve as the broker.
	const client = await daemonClientForGlobal("browser-relay");
	await client.request({ op: "ping" });
	const request = client.request.bind(client);
	// Only the restart describes the relay's broker record; the newer relay is in place by then.
	client.request = (operation, signal) => {
		if (operation.op === "describe") {
			served = {
				ompRelayVersion: "999.0.0",
				ompRelayDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION + 1),
				ompExtensionDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION + 1),
				ompRelayCdpClients: 0,
			};
		}
		return request(operation, signal);
	};
	declareWorkerHostEntry();
	const error = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() }).then(
		() => null,
		(failure: unknown) => failure,
	);
	process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
} finally {
	await relay.stop(true);
	await closeDaemonClients();
}`,
			{},
		);
		expect(result).toEqual({ error: expect.stringContaining("is out of date") });
	}, 60_000);
});

/** Runs `script` (source, or a script file) in a child bun with an isolated HOME and global broker; returns its JSON stdout. */
async function runWithIsolatedBroker(
	home: string,
	script: string | { file: string },
	env: Record<string, string>,
): Promise<unknown> {
	const globalRuntimeDir = path.join(home, ".omp", "run", "daemons", "global", "browser-relay");
	const child = Bun.spawn([process.execPath, ...(typeof script === "string" ? ["-e", script] : [script.file])], {
		cwd: path.resolve(import.meta.dir, "../.."),
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			PI_CONFIG_DIR: ".omp",
			OMP_DAEMON_IDLE_GRACE_MS: "200",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout);
	} finally {
		if (child.exitCode === null) child.kill();
		await child.exited;
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
}
