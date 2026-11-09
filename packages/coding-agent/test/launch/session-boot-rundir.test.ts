// Integration test — real timers are required (ts-no-test-timers exception):
// the launcher boots a real broker-spawned owner over a real PTY, and the
// assertions read the sidecar and socket that owner really published. Awaited
// signals are file markers, socket frames and process exits, never fixed delays.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const LAUNCHER = path.join(import.meta.dir, "../fixtures/session-boot-rundir-launcher.ts");
const REPORT_TIMEOUT_MS = 90_000;
const BASE_ARGS = [
	"--model",
	"claude-sonnet-4-5",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-lsp",
	"--no-prewalk",
];

interface LauncherReport {
	error?: string;
	name?: string;
	id?: string;
	pid?: number;
	sessionId?: string;
	endpointDir?: string;
	probe?: string;
}

interface LaunchedLauncher {
	readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	readonly stderr: Promise<string>;
}

interface Harness {
	readonly home: string;
	readonly projectDir: string;
	readonly runDir: string;
	readonly sessionsDir: string;
	readonly runtimeDir: string;
	readonly configFile: string;
	readonly reportFile: string;
	readonly stopFile: string;
	readonly env: Record<string, string>;
}

function launcherEnvironment(home: string, agentDir: string, runtimeDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key === "HOME" || key === "USERPROFILE" || key === "PI_CODING_AGENT_DIR") continue;
		if (key === "OMP_RUN_DIR" || key === "OMP_DAEMON_RUNTIME_DIR" || key === "OMP_SESSION_OWNER_CONTEXT") continue;
		if (key.startsWith("XDG_")) continue;
		env[key] = value;
	}
	env.HOME = home;
	env.USERPROFILE = home;
	env.PI_CODING_AGENT_DIR = agentDir;
	env.OMP_DAEMON_RUNTIME_DIR = runtimeDir;
	env.TMPDIR = os.tmpdir();
	env.NO_COLOR = "1";
	env.PI_NO_TITLE = "1";
	return env;
}

function createHarness(root: string): Harness {
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	const projectDir = path.join(root, "project");
	const runDir = path.join(root, "run");
	const sessionsDir = path.join(root, "sessions");
	const runtimeDir = path.join(root, "daemons");
	for (const dir of [agentDir, projectDir, runDir, sessionsDir, runtimeDir]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	fs.writeFileSync(path.join(agentDir, "config.yml"), "setupVersion: 99\n");
	return {
		home,
		projectDir,
		runDir,
		sessionsDir,
		runtimeDir,
		configFile: path.join(root, "launcher.json"),
		reportFile: path.join(root, "report.json"),
		stopFile: path.join(root, "stop"),
		env: launcherEnvironment(home, agentDir, runtimeDir),
	};
}

function spawnLauncher(harness: Harness, argv: readonly string[], expectedSessionId?: string): LaunchedLauncher {
	fs.writeFileSync(
		harness.configFile,
		JSON.stringify({
			projectDir: harness.projectDir,
			endpointDir: harness.runDir,
			runtimeDir: harness.runtimeDir,
			argv,
			...(expectedSessionId === undefined ? {} : { expectedSessionId }),
			reportFile: harness.reportFile,
			stopFile: harness.stopFile,
		}),
	);
	const proc = Bun.spawn([process.execPath, LAUNCHER, harness.configFile], {
		cwd: harness.projectDir,
		env: harness.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return { proc, stderr: new Response(proc.stderr).text() };
}

function readReport(file: string): LauncherReport | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as LauncherReport;
	} catch {
		return undefined;
	}
}

async function waitForReport(harness: Harness, launcher: LaunchedLauncher): Promise<LauncherReport> {
	const deadline = Date.now() + REPORT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const report = readReport(harness.reportFile);
		if (report !== undefined) return report;
		if (launcher.proc.exitCode !== null) {
			throw new Error(
				`launcher exited ${launcher.proc.exitCode} before reporting; stderr: ${(await launcher.stderr).slice(-4_000)}`,
			);
		}
		await Bun.sleep(25);
	}
	throw new Error(`launcher never reported a publication; stderr: ${(await launcher.stderr).slice(-4_000)}`);
}

function readPidFile(file: string): number | undefined {
	try {
		const pid = Number(fs.readFileSync(file, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function readDaemonPids(runtimeDir: string): number[] {
	const root = path.join(runtimeDir, "daemons");
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const name of names) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(root, name, "meta.json"), "utf8")) as {
				daemon?: { pid?: unknown };
			};
			const pid = raw.daemon?.pid;
			if (typeof pid === "number" && Number.isInteger(pid)) pids.push(pid);
		} catch {}
	}
	return pids;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (!processAlive(pid)) return;
		await Bun.sleep(25);
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}

async function stopLauncher(harness: Harness, launcher: LaunchedLauncher, report?: LauncherReport): Promise<void> {
	fs.writeFileSync(harness.stopFile, "");
	await withTimeout(launcher.proc.exited, 30_000, "launcher did not stop").catch(() => launcher.proc.kill("SIGKILL"));
	const pids = new Set<number>(readDaemonPids(harness.runtimeDir));
	const brokerPid = readPidFile(path.join(harness.runtimeDir, "broker.pid"));
	if (brokerPid !== undefined) pids.add(brokerPid);
	if (report?.pid !== undefined) pids.add(report.pid);
	for (const pid of pids) {
		if (processAlive(pid)) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
	}
	await Promise.all([...pids].map(pid => waitForProcessExit(pid)));
}

function expectPublication(harness: Harness, report: LauncherReport): void {
	const sessionId = report.sessionId;
	if (sessionId === undefined) throw new Error(`launcher reported no session id: ${JSON.stringify(report)}`);
	const sidecarPath = path.join(harness.runDir, `${sessionId}.json`);
	const socketPath = path.join(harness.runDir, `${sessionId}.sock`);
	const sidecarStat = fs.lstatSync(sidecarPath);
	expect(sidecarStat.isSymbolicLink()).toBe(false);
	expect(sidecarStat.isFile()).toBe(true);
	const socketStat = fs.lstatSync(socketPath);
	expect(socketStat.isSymbolicLink()).toBe(false);
	const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as { pid?: number; sessionId?: string };
	expect(sidecar.sessionId).toBe(sessionId);
	expect(sidecar.pid).toBe(report.pid);
	const defaultRunDir = path.join(harness.home, ".omp", "run");
	for (const suffix of [".json", ".sock"]) {
		expect(fs.existsSync(path.join(defaultRunDir, `${sessionId}${suffix}`))).toBe(false);
	}
}

describe("brokered owner publication run directory", () => {
	it("publishes a fresh owner under the launcher's endpoint dir", async () => {
		using temp = TempDir.createSync("@omp-boot-rundir-fresh-");
		const harness = createHarness(temp.path());
		const launcher = spawnLauncher(harness, BASE_ARGS);
		let report: LauncherReport | undefined;
		try {
			report = await waitForReport(harness, launcher);
			expect(report.error).toBeUndefined();
			expect(report.endpointDir).toBe(harness.runDir);
			expect(report.probe).toBe("live");
			expectPublication(harness, report);
		} finally {
			await stopLauncher(harness, launcher, report);
		}
	}, 180_000);

	it("publishes a resumed owner under the launcher's endpoint dir", async () => {
		using temp = TempDir.createSync("@omp-boot-rundir-resume-");
		const harness = createHarness(temp.path());
		const project = fs.realpathSync(harness.projectDir);
		const manager = SessionManager.create(project, harness.sessionsDir, new FileSessionStorage());
		await manager.ensureOnDisk();
		manager.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
		await manager.flush();
		const sessionId = manager.getSessionId();
		await manager.close();

		const launcher = spawnLauncher(
			harness,
			["--resume", sessionId, "--session-dir", harness.sessionsDir, ...BASE_ARGS],
			sessionId,
		);
		let report: LauncherReport | undefined;
		try {
			report = await waitForReport(harness, launcher);
			expect(report.error).toBeUndefined();
			expect(report.sessionId).toBe(sessionId);
			expect(report.endpointDir).toBe(harness.runDir);
			expect(report.probe).toBe("live");
			expectPublication(harness, report);
		} finally {
			await stopLauncher(harness, launcher, report);
		}
	}, 180_000);
});
