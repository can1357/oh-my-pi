import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ActiveExposure,
	type ExposureConfig,
	parseBoreUrl,
	parseDevtunnelUrl,
	parseLocalhostRunUrl,
	parsePinggyUrl,
	parseZrokUrl,
	startExposure,
} from "../src/blob-broker/exposure";
import { writeFakeExecutable } from "./helpers/fake-executable";

const PORT = 43127;
const originalPath = process.env.PATH;
let fakeBinDir = "";
let invocationSequence = 0;
const activeExposures: ActiveExposure[] = [];

interface FakeInvocation {
	argsFile: string;
	runsFile: string;
	signalsFile: string;
}

function exposure(kind: ExposureConfig["kind"], overrides: Partial<ExposureConfig> = {}): ExposureConfig {
	return {
		kind,
		bindHost: "127.0.0.1",
		options: {},
		credentials: {},
		...overrides,
	} as ExposureConfig;
}

/**
 * Install fake tunnel binaries that record argv, runs, and caught signals.
 *
 * A fake that must wait on the test checks in on `controlPort` (see
 * {@link controlChannel}) and continues only once released. `holdExit` holds an
 * exiting run after it prints its URL, so the adapter scans that URL from a live
 * child. With `restartOnce`, the first run prints its URL and exits so the
 * adapter restarts it; the replacement checks in before printing its URL, so it
 * stays unready until released.
 */
function prepareFake(
	output: string,
	options: { exitCode?: number; controlPort?: number; holdExit?: boolean; restartOnce?: boolean } = {},
): FakeInvocation {
	const suffix = String(invocationSequence++);
	const invocationDir = path.join(fakeBinDir, suffix);
	fs.mkdirSync(invocationDir);
	const argsFile = path.join(invocationDir, "args.txt");
	const runsFile = path.join(invocationDir, "runs.txt");
	const signalsFile = path.join(invocationDir, "signals.txt");
	const restartMarker = path.join(invocationDir, "restart.txt");
	// Publish argv before printing anything, and atomically: every adapter
	// settles only after reading the fake's output or exit, so the file is
	// complete by then, and a restarted process replacing it mid-read never
	// exposes a partial file.
	const source = `import * as fs from "node:fs";
const config = ${JSON.stringify({ argsFile, runsFile, signalsFile, restartMarker, output, ...options })};
const tmp = \`\${config.argsFile}.\${process.pid}\`;
fs.writeFileSync(tmp, process.argv.slice(2).map(arg => \`\${arg}\\n\`).join(""));
fs.renameSync(tmp, config.argsFile);
fs.appendFileSync(config.runsFile, "run\\n");
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		fs.appendFileSync(config.signalsFile, \`\${signal}\\n\`);
		process.exit(0);
	});
}
async function checkIn() {
	const released = Promise.withResolvers();
	await Bun.connect({
		hostname: "127.0.0.1",
		port: config.controlPort,
		socket: { data() {}, end: () => released.resolve(), close: () => released.resolve() },
	});
	await released.promise;
}
const replacement = config.restartOnce === true && fs.existsSync(config.restartMarker);
if (replacement) await checkIn();
fs.writeSync(1, \`\${config.output}\\n\`);
let exitCode = config.exitCode;
if (config.restartOnce === true && !replacement) {
	fs.writeFileSync(config.restartMarker, "first\\n");
	exitCode = 23;
}
if (exitCode !== undefined) {
	if (config.holdExit === true) await checkIn();
	process.exit(exitCode);
}
// A live tunnel never exits on its own; the timer only keeps the stub alive
// until the adapter kills it (nothing here waits on wall-clock time).
setInterval(() => {}, 60_000);
`;
	for (const name of ["ssh", "devtunnel", "zrok", "bore", "cloudflared"]) {
		writeFakeExecutable(invocationDir, name, source);
	}
	process.env.PATH = invocationDir;
	return { argsFile, runsFile, signalsFile };
}

function recordedArgs(invocation: FakeInvocation): string[] {
	const text = fs.readFileSync(invocation.argsFile, "utf8");
	return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

async function stopAndObserve(exposure: ActiveExposure, invocation: FakeInvocation): Promise<void> {
	exposure.stop();
	// stop() escalates to SIGKILL, so the tunnel always ends.
	await exposure.exited;
	// Windows kill() is TerminateProcess: there is no catchable SIGTERM for
	// the fake to record, so only observe that the tunnel process ended.
	if (process.platform === "win32") return;
	// The fake records SIGTERM before it exits, so the record is complete now;
	// a missing file means the tunnel died without handling SIGTERM.
	expect(fs.readFileSync(invocation.signalsFile, "utf8")).toContain("SIGTERM");
}

/** Temporary tunnel log directories whose log mentions `banner`. */
function tunnelLogDirsContaining(banner: string): string[] {
	return fs
		.readdirSync(os.tmpdir())
		.filter(name => name.startsWith("omp-blob-tunnel-"))
		.map(name => path.join(os.tmpdir(), name))
		.filter(dir => {
			try {
				return fs.readFileSync(path.join(dir, "tunnel.log"), "utf8").includes(banner);
			} catch {
				return false;
			}
		});
}

/**
 * Log removal is scheduled after `exited` settles (and may back off on
 * transient Windows errors) without a completion event, so poll for the
 * directory to disappear rather than asserting right after exit. Existence is
 * polled directly: `fs.watchFile` can miss a change racing Bun's deferred
 * initial stat, and an `fs.watch` handle would block the removal on Windows.
 */
async function waitForRemoval(target: string): Promise<void> {
	while (fs.existsSync(target)) await Bun.sleep(25);
}

interface ControlChannel {
	port: number;
	/** Next held fake check-in; rejects once `ended` settles first, so a dead fake never hangs the test. */
	nextCheckIn(ended: Promise<unknown>): Promise<Bun.Socket>;
	stop(): void;
}

/**
 * Loopback rendezvous for fakes: the adapters expose no restart or readiness
 * events, so a fake reports in by connecting and holds until the test ends
 * that connection.
 */
function controlChannel(): ControlChannel {
	const arrived: Bun.Socket[] = [];
	const waiters: Array<(socket: Bun.Socket) => void> = [];
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				const waiter = waiters.shift();
				if (waiter) waiter(socket);
				else arrived.push(socket);
			},
			data() {},
		},
	});
	return {
		port: listener.port,
		nextCheckIn(ended) {
			const socket = arrived.shift();
			if (socket) return Promise.resolve(socket);
			const { promise, resolve } = Promise.withResolvers<Bun.Socket>();
			waiters.push(resolve);
			return Promise.race([
				promise,
				ended.then(() => {
					throw new Error("the tunnel settled before the fake checked in");
				}),
			]);
		},
		stop: () => listener.stop(true),
	};
}

beforeAll(() => {
	fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-blob-tunnels-"));
});

afterAll(async () => {
	for (const active of activeExposures) active.stop();
	await Promise.all(activeExposures.map(active => active.exited));
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

describe("tunnel URL parsers", () => {
	it("parses localhost.run JSON events and text banners", () => {
		expect(parseLocalhostRunUrl('{"type":"registered","domain":"quiet-owl.lhr.life"}')).toBe(
			"https://quiet-owl.lhr.life",
		);
		expect(parseLocalhostRunUrl("Connect to https://quiet-owl.localhost.run for TLS termination")).toBe(
			"https://quiet-owl.localhost.run",
		);
		expect(parseLocalhostRunUrl('{"type":"registered","domain":17}')).toBeNull();
		expect(parseLocalhostRunUrl("not a tunnel banner")).toBeNull();
	});

	it("accepts Pinggy public domains and rejects non-HTTPS banners", () => {
		for (const url of [
			"https://fox.a.pinggy.link",
			"https://fox.free.pinggy.link",
			"https://fox.pinggy.link",
			"https://fox.pinggy.online",
		]) {
			expect(parsePinggyUrl(`Tunnel: ${url}`)).toBe(url);
		}
		expect(parsePinggyUrl("http://fox.a.pinggy.link")).toBeNull();
	});

	it("parses devtunnel, zrok, and bore readiness lines", () => {
		expect(parseDevtunnelUrl("Hosting port 43127 at https://blue-43127.use2.devtunnels.ms/")).toBe(
			"https://blue-43127.use2.devtunnels.ms",
		);
		expect(parseDevtunnelUrl("https://blue.example.invalid")).toBeNull();
		expect(parseZrokUrl("[INFO]: frontend endpoint: https://violet.share.zrok.io")).toBe(
			"https://violet.share.zrok.io",
		);
		expect(parseZrokUrl("frontend endpoint unavailable")).toBeNull();
		expect(parseBoreUrl("INFO bore_cli::client: listening at bore.pub:38912")).toBe("http://bore.pub:38912");
		expect(parseBoreUrl("INFO listening at 41321", "bore.internal")).toBe("http://bore.internal:41321");
		expect(parseBoreUrl("listening at bore.pub:not-a-port")).toBeNull();
	});
});

describe("startExposure tunnel adapters", () => {
	it("starts localhost.run with official SSH argv and owns its process", async () => {
		const invocation = prepareFake('{"type":"registered","domain":"quiet-owl.lhr.life"}');
		const active = await startExposure(exposure("localhost-run"), PORT);
		activeExposures.push(active);
		expect(active.baseUrl).toBe("https://quiet-owl.lhr.life");
		expect(recordedArgs(invocation)).toEqual([
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ServerAliveInterval=30",
			"-o",
			"ServerAliveCountMax=3",
			"-o",
			"ExitOnForwardFailure=yes",
			"-R",
			`80:127.0.0.1:${PORT}`,
			"nokey@localhost.run",
			"--",
			"--output",
			"json",
		]);
		await stopAndObserve(active, invocation);
	});

	it("removes its file-backed tunnel log directory after stop completes", async () => {
		const banner = "cleanup-owl.lhr.life";
		const invocation = prepareFake(`{"type":"registered","domain":"${banner}"}`);
		const active = await startExposure(exposure("localhost-run"), PORT);
		activeExposures.push(active);
		const createdLogDirs = tunnelLogDirsContaining(banner);
		expect(createdLogDirs).toHaveLength(1);

		await stopAndObserve(active, invocation);
		await waitForRemoval(createdLogDirs[0]);
	});

	it("gives concurrently started tunnels distinct log directories", async () => {
		// One fake serves both children (prepareFake() owns PATH), so the banner
		// is shared and only the per-spawn mkdtemp keeps the logs apart.
		const banner = "twin-owl.lhr.life";
		const invocation = prepareFake(`{"type":"registered","domain":"${banner}"}`);
		const started = await Promise.all([
			startExposure(exposure("localhost-run"), PORT),
			startExposure(exposure("localhost-run"), PORT),
		]);
		activeExposures.push(...started);
		// readdir entries are distinct by construction: two hits means two directories.
		const logDirs = tunnelLogDirsContaining(banner);
		expect(logDirs).toHaveLength(2);

		await Promise.all(started.map(active => stopAndObserve(active, invocation)));
		await Promise.all(logDirs.map(dir => waitForRemoval(dir)));
	});

	it("never reconnects a free Pinggy tunnel behind a different published hostname", async () => {
		// Free Pinggy is unsupervised: a child that dies before its URL is
		// scanned is rejected rather than recovered from the log after exit, so
		// the fake holds its exit until startup has accepted the live tunnel.
		const control = controlChannel();
		try {
			const invocation = prepareFake("Tunnel established at https://random-one.a.pinggy.link", {
				exitCode: 23,
				controlPort: control.port,
				holdExit: true,
			});
			const active = await startExposure(exposure("pinggy"), PORT);
			activeExposures.push(active);
			expect(active.baseUrl).toBe("https://random-one.a.pinggy.link");
			expect(recordedArgs(invocation)).toEqual([
				"-p",
				"443",
				"-o",
				"BatchMode=yes",
				"-o",
				"StrictHostKeyChecking=accept-new",
				"-o",
				"ServerAliveInterval=30",
				"-o",
				"ServerAliveCountMax=3",
				"-o",
				"ExitOnForwardFailure=yes",
				"-R",
				`0:127.0.0.1:${PORT}`,
				"free.pinggy.io",
			]);
			(await control.nextCheckIn(active.exited!)).end();
			await active.exited;
			expect(fs.readFileSync(invocation.runsFile, "utf8")).toBe("run\n");
		} finally {
			control.stop();
		}
	});

	it("rejects an unsupervised Pinggy tunnel that exits after publishing its URL", async () => {
		const invocation = prepareFake("Tunnel established at https://already-dead.a.pinggy.link", { exitCode: 23 });
		await expect(startExposure(exposure("pinggy"), PORT)).rejects.toThrow(
			"exited with code 23 after reporting a tunnel URL",
		);
		expect(fs.readFileSync(invocation.runsFile, "utf8")).toBe("run\n");
	});

	it("waits for replacement readiness before publishing a configured stable Pinggy base", async () => {
		const control = controlChannel();
		try {
			const invocation = prepareFake("Tunnel established at https://different-random.a.pinggy.link", {
				controlPort: control.port,
				restartOnce: true,
			});
			const starting = startExposure(
				exposure("pinggy", {
					publicBaseUrl: "https://stable.example.test/",
					credentials: { token: "fake-pinggy-token" },
				}),
				PORT,
			);
			// The first child published its URL and exited. Startup must not
			// publish the stable base while the replacement is still unready, so
			// it settling before the replacement checks in fails this wait.
			(await control.nextCheckIn(starting)).end();
			const active = await starting;
			activeExposures.push(active);
			expect(active.baseUrl).toBe("https://stable.example.test");
			expect(recordedArgs(invocation)).toContain("fake-pinggy-token@pro.pinggy.io");
			expect(fs.readFileSync(invocation.runsFile, "utf8")).toBe("run\nrun\n");
			await stopAndObserve(active, invocation);
		} finally {
			control.stop();
		}
	});

	it("cancels an authenticated Pinggy restart that has not published readiness", async () => {
		const control = controlChannel();
		try {
			const invocation = prepareFake("Tunnel established at https://gated-random.a.pinggy.link", {
				controlPort: control.port,
				holdExit: true,
				restartOnce: true,
			});
			const active = await startExposure(
				exposure("pinggy", {
					publicBaseUrl: "https://stable.example.test/",
					credentials: { token: "fake-pinggy-token" },
				}),
				PORT,
			);
			activeExposures.push(active);
			// Startup accepted the live first child; release it so supervision restarts.
			(await control.nextCheckIn(active.exited!)).end();
			// The replacement checks in and stays unready until stop cancels it.
			await control.nextCheckIn(active.exited!);

			await stopAndObserve(active, invocation);
			expect(fs.readFileSync(invocation.runsFile, "utf8")).toBe("run\nrun\n");
		} finally {
			control.stop();
		}
	});

	it("backs off and gives up on a stable Pinggy tunnel that keeps dying after publishing its URL", async () => {
		// Every run prints a URL and exits immediately, mimicking a persistent
		// auth failure. Without backoff the supervisor would hot-loop respawns
		// and `exited` would never settle. The elapsed-time bound deliberately
		// measures the adapter's real backoff sleeps, which expose no clock seam.
		const invocation = prepareFake("Tunnel established at https://doomed-random.a.pinggy.link", { exitCode: 23 });
		const startedAt = Date.now();
		await expect(
			startExposure(
				exposure("pinggy", {
					publicBaseUrl: "https://stable.example.test/",
					credentials: { token: "fake-pinggy-token" },
				}),
				PORT,
			),
		).rejects.toThrow("keeps exiting right after startup");
		// Bounded: exactly the quick-exit budget of runs, never a hot loop.
		expect(fs.readFileSync(invocation.runsFile, "utf8")).toBe("run\n".repeat(5));
		// Delayed: respawns sit behind 250/500/1000/2000ms backoff sleeps.
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_500);
	}, 20_000);

	it("starts devtunnel and zrok with public HTTP argv", async () => {
		const devInvocation = prepareFake(`Hosting port ${PORT} at https://blue-${PORT}.use2.devtunnels.ms/`);
		const dev = await startExposure(exposure("devtunnel"), PORT);
		activeExposures.push(dev);
		expect(dev.baseUrl).toBe(`https://blue-${PORT}.use2.devtunnels.ms`);
		expect(recordedArgs(devInvocation)).toEqual([
			"host",
			"-p",
			String(PORT),
			"--allow-anonymous",
			"--protocol",
			"http",
		]);
		await stopAndObserve(dev, devInvocation);

		const zrokInvocation = prepareFake("[INFO]: frontend endpoint: https://violet.share.zrok.io");
		const zrok = await startExposure(exposure("zrok"), PORT);
		activeExposures.push(zrok);
		expect(zrok.baseUrl).toBe("https://violet.share.zrok.io");
		expect(recordedArgs(zrokInvocation)).toEqual([
			"share",
			"public",
			`http://127.0.0.1:${PORT}`,
			"--headless",
			"--backend-mode",
			"proxy",
		]);
		await stopAndObserve(zrok, zrokInvocation);
	});

	it("publishes bore as HTTP and forwards server and secret as separate argv", async () => {
		const invocation = prepareFake("INFO bore_cli::client: listening at tunnel.example.test:38912");
		const active = await startExposure(
			exposure("bore", {
				options: { server: "tunnel.example.test" },
				credentials: { secret: "fake-bore-secret" },
			}),
			PORT,
		);
		activeExposures.push(active);
		expect(active.baseUrl).toBe("http://tunnel.example.test:38912");
		expect(recordedArgs(invocation)).toEqual([
			"local",
			String(PORT),
			"--to",
			"tunnel.example.test",
			"--secret",
			"fake-bore-secret",
		]);
		await stopAndObserve(active, invocation);
	});

	it("starts named Cloudflare token and local-config modes only after registration", async () => {
		const tokenInvocation = prepareFake("Registered tunnel connection connIndex=0 location=sjc");
		const token = await startExposure(
			exposure("named-cloudflared", {
				publicBaseUrl: "https://blobs.example.test/",
				credentials: { tunnelToken: "super-secret-token" },
			}),
			PORT,
		);
		activeExposures.push(token);
		expect(token.baseUrl).toBe("https://blobs.example.test");
		expect(recordedArgs(tokenInvocation)).toEqual([
			"tunnel",
			"--no-autoupdate",
			"run",
			"--token",
			"super-secret-token",
		]);
		await stopAndObserve(token, tokenInvocation);

		const configInvocation = prepareFake("Connection abc123 registered with protocol quic");
		const configured = await startExposure(
			exposure("named-cloudflared", {
				publicBaseUrl: "https://config.example.test",
				options: { configFile: "/tmp/cloudflared.yml", tunnelName: "blob-tunnel" },
			}),
			PORT,
		);
		activeExposures.push(configured);
		expect(configured.baseUrl).toBe("https://config.example.test");
		expect(recordedArgs(configInvocation)).toEqual([
			"tunnel",
			"--no-autoupdate",
			"--config",
			"/tmp/cloudflared.yml",
			"run",
			"blob-tunnel",
		]);
		await stopAndObserve(configured, configInvocation);
	});

	it("reports invalid adapter configuration without echoing named Cloudflare tokens", async () => {
		await expect(startExposure(exposure("bore", { options: { server: 17 } }), PORT)).rejects.toThrow(
			"Destination option server must be a string",
		);
		await expect(startExposure(exposure("named-cloudflared"), PORT)).rejects.toThrow("publicBaseUrl");
		await expect(
			startExposure(exposure("named-cloudflared", { publicBaseUrl: "https://blobs.example.test" }), PORT),
		).rejects.toThrow("credentials.tunnelToken or options.configFile and options.tunnelName");
		await expect(
			startExposure(
				exposure("named-cloudflared", {
					publicBaseUrl: "https://blobs.example.test",
					options: { configFile: "/tmp/cloudflared.yml" },
				}),
				PORT,
			),
		).rejects.toThrow("options.configFile and options.tunnelName");

		const invocation = prepareFake("cloudflared failed internally", { exitCode: 19 });
		const secret = "must-not-appear-in-errors";
		let failure = "";
		try {
			await startExposure(
				exposure("named-cloudflared", {
					publicBaseUrl: "https://blobs.example.test",
					credentials: { tunnelToken: secret },
				}),
				PORT,
			);
		} catch (error) {
			failure = String(error);
		}
		expect(failure).toContain("exited with code 19");
		expect(failure).not.toContain(secret);
		expect(recordedArgs(invocation)).toContain(secret);
	});

	it("reports absent adapter binaries without invoking the network", async () => {
		const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "omp-no-tunnel-bin-"));
		const fakePath = process.env.PATH;
		process.env.PATH = emptyPath;
		try {
			const cases: Array<[ExposureConfig, string]> = [
				[exposure("localhost-run"), "ssh binary"],
				[exposure("pinggy"), "ssh binary"],
				[exposure("devtunnel"), "devtunnel binary"],
				[exposure("zrok"), "zrok binary"],
				[exposure("bore"), "bore binary"],
				[
					exposure("named-cloudflared", {
						publicBaseUrl: "https://blobs.example.test",
						credentials: { tunnelToken: "not-logged" },
					}),
					"cloudflared binary",
				],
			];
			for (const [config, message] of cases) {
				await expect(startExposure(config, PORT)).rejects.toThrow(message);
			}
		} finally {
			process.env.PATH = fakePath;
			fs.rmSync(emptyPath, { recursive: true, force: true });
		}
	});
});
