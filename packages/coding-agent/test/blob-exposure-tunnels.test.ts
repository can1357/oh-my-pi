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

const PORT = 43127;
const originalPath = process.env.PATH;
let fakeBinDir = "";
let invocationSequence = 0;
const activeExposures: ActiveExposure[] = [];

interface FakeInvocation {
	argsFile: string;
	runsFile: string;
	signalsFile: string;
	restartMarker?: string;
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

function prepareFake(output: string, options: { exitCode?: number; restartOnce?: boolean } = {}): FakeInvocation {
	const suffix = String(invocationSequence++);
	const argsFile = path.join(fakeBinDir, `args-${suffix}.json`);
	const runsFile = path.join(fakeBinDir, `runs-${suffix}.txt`);
	const signalsFile = path.join(fakeBinDir, `signals-${suffix}.txt`);
	process.env.OMP_FAKE_TUNNEL_ARGS = argsFile;
	process.env.OMP_FAKE_TUNNEL_RUNS = runsFile;
	process.env.OMP_FAKE_TUNNEL_SIGNALS = signalsFile;
	process.env.OMP_FAKE_TUNNEL_OUTPUT = output;
	if (options.exitCode === undefined) delete process.env.OMP_FAKE_TUNNEL_EXIT_CODE;
	else process.env.OMP_FAKE_TUNNEL_EXIT_CODE = String(options.exitCode);
	const restartMarker = options.restartOnce ? path.join(fakeBinDir, `restart-${suffix}.txt`) : undefined;
	if (restartMarker === undefined) delete process.env.OMP_FAKE_TUNNEL_RESTART_MARKER;
	else process.env.OMP_FAKE_TUNNEL_RESTART_MARKER = restartMarker;
	return { argsFile, runsFile, signalsFile, restartMarker };
}

async function waitForFileContent(filePath: string, matches: (text: string) => boolean): Promise<void> {
	const matchesCurrentContent = (): boolean => {
		try {
			return matches(fs.readFileSync(filePath, "utf8"));
		} catch {
			return false;
		}
	};
	if (matchesCurrentContent()) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const listener = (): void => {
		if (matchesCurrentContent()) resolve();
	};
	fs.watchFile(filePath, { interval: 25, persistent: false }, listener);
	listener();
	try {
		await promise;
	} finally {
		fs.unwatchFile(filePath, listener);
	}
}

async function waitForRestart(marker: string): Promise<void> {
	await waitForFileContent(marker, text => text.includes("restarted"));
}

function recordedArgs(invocation: FakeInvocation): string[] {
	const text = fs.readFileSync(invocation.argsFile, "utf8");
	return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

async function waitForSignal(invocation: FakeInvocation): Promise<void> {
	await waitForFileContent(invocation.signalsFile, text => text.includes("SIGTERM"));
}

async function stopAndObserve(exposure: ActiveExposure, invocation: FakeInvocation): Promise<void> {
	const signalObserved = waitForSignal(invocation);
	exposure.stop();
	await Promise.all([exposure.exited, signalObserved]);
	expect(fs.readFileSync(invocation.signalsFile, "utf8")).toContain("SIGTERM");
}

beforeAll(() => {
	fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-blob-tunnels-"));
	const target = path.join(fakeBinDir, "fake-tunnel");
	fs.writeFileSync(
		target,
		`#!/bin/sh\n` +
			`: > "$OMP_FAKE_TUNNEL_ARGS"\n` +
			`for arg do printf '%s\\n' "$arg" >> "$OMP_FAKE_TUNNEL_ARGS"; done\n` +
			`printf 'run\\n' >> "$OMP_FAKE_TUNNEL_RUNS"\n` +
			`trap 'printf "SIGINT\\n" >> "$OMP_FAKE_TUNNEL_SIGNALS"; exit 0' INT\n` +
			`trap 'printf "SIGTERM\\n" >> "$OMP_FAKE_TUNNEL_SIGNALS"; exit 0' TERM\n` +
			`if [ -n "$OMP_FAKE_TUNNEL_OUTPUT" ]; then printf '%s\\n' "$OMP_FAKE_TUNNEL_OUTPUT"; fi\n` +
			`if [ -n "$OMP_FAKE_TUNNEL_RESTART_MARKER" ]; then\n` +
			`  if [ ! -e "$OMP_FAKE_TUNNEL_RESTART_MARKER" ]; then\n` +
			`    printf 'first\\n' > "$OMP_FAKE_TUNNEL_RESTART_MARKER"\n` +
			`    exit 23\n` +
			`  fi\n` +
			`  printf 'restarted\\n' >> "$OMP_FAKE_TUNNEL_RESTART_MARKER"\n` +
			`fi\n` +
			`if [ -n "$OMP_FAKE_TUNNEL_EXIT_CODE" ]; then exit "$OMP_FAKE_TUNNEL_EXIT_CODE"; fi\n` +
			`while :; do /bin/sleep 1; done\n`,
	);
	fs.chmodSync(target, 0o755);
	for (const name of ["ssh", "devtunnel", "zrok", "bore", "cloudflared"]) {
		fs.symlinkSync(target, path.join(fakeBinDir, name));
	}
	process.env.PATH = fakeBinDir;
});

afterAll(async () => {
	for (const active of activeExposures) active.stop();
	await Promise.all(activeExposures.map(active => active.exited));
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	delete process.env.OMP_FAKE_TUNNEL_ARGS;
	delete process.env.OMP_FAKE_TUNNEL_RUNS;
	delete process.env.OMP_FAKE_TUNNEL_SIGNALS;
	delete process.env.OMP_FAKE_TUNNEL_OUTPUT;
	delete process.env.OMP_FAKE_TUNNEL_EXIT_CODE;
	delete process.env.OMP_FAKE_TUNNEL_RESTART_MARKER;
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

	it("never reconnects a free Pinggy tunnel behind a different published hostname", async () => {
		const invocation = prepareFake("Tunnel established at https://random-one.a.pinggy.link", { exitCode: 23 });
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
		await active.exited;
		expect(fs.readFileSync(invocation.runsFile, "utf8")).toBe("run\n");
	});

	it("uses a configured stable Pinggy base with authenticated SSH", async () => {
		const invocation = prepareFake("Tunnel established at https://different-random.a.pinggy.link", {
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
		expect(active.baseUrl).toBe("https://stable.example.test");
		expect(recordedArgs(invocation)).toContain("fake-pinggy-token@pro.pinggy.io");
		await waitForRestart(invocation.restartMarker!);
		expect(fs.readFileSync(invocation.runsFile, "utf8")).toBe("run\nrun\n");
		expect(active.baseUrl).toBe("https://stable.example.test");
		await stopAndObserve(active, invocation);
	});

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
