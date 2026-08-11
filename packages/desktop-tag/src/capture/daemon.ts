/**
 * Detached lifecycle control for the desktop-tag gateway (`src/cli.ts`).
 *
 * Follows the same pid-lock conventions as coding-agent's gopk-clips ingest
 * daemon: the gateway process owns `gateway.pid`; controllers (the /telegram
 * slash command) start/stop it and treat "pid alive AND image looks like
 * ours" as running. The lock lives at a machine-fixed path (NOT the
 * CAPTURE_DATA_DIR override) so controller and daemon agree even when their
 * environments differ — real exclusivity comes from the gateway's TCP port;
 * the pid file just names the owner.
 *
 * Kill semantics: on Windows `process.kill(pid)` is a hard TerminateProcess.
 * That is tolerated by design — capture runs resume from their session files
 * alone (see ./runner.ts) and Telegram update dedup lives in the store — so
 * `stopGatewayDaemon` confirms death and then clears the leftover pid file.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";

/** Package root; spawn cwd so Bun auto-loads `packages/desktop-tag/.env`. */
export const GATEWAY_PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GATEWAY_CLI_ENTRY = fileURLToPath(new URL("../cli.ts", import.meta.url));

const LOG_TAIL_LINES = 10;

/**
 * Idle timeout the controller injects when spawning the daemon. An explicit
 * CAPTURE_IDLE_EXIT_MS in the inherited/provided env (including 0 = never)
 * always wins over this default.
 */
export const DEFAULT_GATEWAY_IDLE_EXIT_MS = 30 * 60_000;

export interface GatewayDaemonPaths {
	/** Directory holding the lock and log; created on demand. */
	root: string;
	pidFile: string;
	logFile: string;
}

export function resolveGatewayDaemonPaths(root: string = path.join(getAgentDir(), "capture")): GatewayDaemonPaths {
	return {
		root,
		pidFile: path.join(root, "gateway.pid"),
		logFile: path.join(root, "gateway.log"),
	};
}

export interface GatewayLockPayload {
	pid: number;
	gatewayId: string;
	createdAt: number;
}

let currentGatewayId = "";

/**
 * Verify that the PID is one of our gateway processes.
 * Fails closed (returns false) if lookup fails or process identity cannot be proven.
 */
function isOurProcess(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		let cmdline = "";
		if (process.platform === "win32") {
			const result = Bun.spawnSync(
				[
					"powershell",
					"-NoProfile",
					"-Command",
					`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
				],
				{ stdout: "pipe", stderr: "ignore" },
			);
			if (result.exitCode !== 0) return false;
			cmdline = result.stdout.toString().toLowerCase();
		} else {
			if (fs.existsSync(`/proc/${pid}/cmdline`)) {
				cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").toLowerCase();
			} else {
				const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], {
					stdout: "pipe",
					stderr: "ignore",
				});
				if (result.exitCode !== 0) return false;
				cmdline = result.stdout.toString().toLowerCase();
			}
		}
		if (!cmdline.trim()) return false;
		return (
			cmdline.includes("cli.ts") ||
			cmdline.includes("ompk-tag") ||
			cmdline.includes("fake-gateway-daemon") ||
			cmdline.includes("desktop-tag")
		);
	} catch {
		return false;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readGatewayLock(pidFile: string): GatewayLockPayload | undefined {
	try {
		const raw = fs.readFileSync(pidFile, "utf8").trim();
		if (!raw) return undefined;
		if (raw.startsWith("{")) {
			const parsed = JSON.parse(raw) as Partial<GatewayLockPayload>;
			if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
				return {
					pid: parsed.pid,
					gatewayId: typeof parsed.gatewayId === "string" ? parsed.gatewayId : "",
					createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
				};
			}
		}
		const pid = Number(raw);
		if (Number.isInteger(pid) && pid > 0) {
			return { pid, gatewayId: "", createdAt: Date.now() };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** The pid recorded in the lock when that process is alive AND ours, else undefined. */
export function readAlivePid(pidFile: string): number | undefined {
	const lock = readGatewayLock(pidFile);
	if (!lock) return undefined;
	if (!pidAlive(lock.pid)) return undefined;
	return isOurProcess(lock.pid) ? lock.pid : undefined;
}

/** Record the calling process as the gateway owner. */
export function writeGatewayPidFile(paths: GatewayDaemonPaths, gatewayId?: string): string {
	fs.mkdirSync(paths.root, { recursive: true });
	const id = gatewayId || currentGatewayId || crypto.randomUUID();
	currentGatewayId = id;
	const payload: GatewayLockPayload = {
		pid: process.pid,
		gatewayId: id,
		createdAt: Date.now(),
	};
	fs.writeFileSync(paths.pidFile, JSON.stringify(payload));
	return id;
}

/**
 * Acquire daemon ownership atomically before initialization.
 * Retains and releases lock safely so concurrent startup cannot orphan gateways.
 */
export function acquireGatewayLock(paths: GatewayDaemonPaths): { acquired: boolean; pid?: number; gatewayId?: string } {
	const existing = readGatewayLock(paths.pidFile);
	if (existing) {
		if (pidAlive(existing.pid) && isOurProcess(existing.pid)) {
			if (existing.pid === process.pid) {
				return { acquired: true, pid: process.pid, gatewayId: existing.gatewayId };
			}
			return { acquired: false, pid: existing.pid, gatewayId: existing.gatewayId };
		}
		// Stale lock: clean up safely
		try {
			fs.unlinkSync(paths.pidFile);
		} catch {
			// already gone
		}
	}

	fs.mkdirSync(paths.root, { recursive: true });
	const id = crypto.randomUUID();
	currentGatewayId = id;
	const payload: GatewayLockPayload = {
		pid: process.pid,
		gatewayId: id,
		createdAt: Date.now(),
	};

	try {
		const fd = fs.openSync(paths.pidFile, "wx");
		fs.writeSync(fd, JSON.stringify(payload));
		fs.closeSync(fd);
		return { acquired: true, pid: process.pid, gatewayId: id };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			const winner = readGatewayLock(paths.pidFile);
			if (winner && pidAlive(winner.pid) && isOurProcess(winner.pid)) {
				return { acquired: false, pid: winner.pid, gatewayId: winner.gatewayId };
			}
		}
		throw error;
	}
}

/** Remove the lock iff it still names the calling process and gatewayId. */
export function releaseGatewayPidLock(paths: GatewayDaemonPaths): void {
	removePidFileFor(paths, process.pid, currentGatewayId);
}

function removePidFileFor(paths: GatewayDaemonPaths, pid: number, gatewayId?: string): void {
	try {
		const lock = readGatewayLock(paths.pidFile);
		if (!lock) return;
		if (lock.pid !== pid) return;
		if (gatewayId && lock.gatewayId && lock.gatewayId !== gatewayId) return;
		fs.unlinkSync(paths.pidFile);
	} catch {
		// already gone
	}
}

export interface GatewayDaemonStatus {
	running: boolean;
	pid?: number;
}

export function gatewayDaemonStatus(paths: GatewayDaemonPaths = resolveGatewayDaemonPaths()): GatewayDaemonStatus {
	const pid = readAlivePid(paths.pidFile);
	return pid === undefined ? { running: false } : { running: true, pid };
}

export type GatewayStartResult =
	| { started: true; pid: number; logFile: string }
	| { started: false; alreadyRunning: true; pid: number }
	| { started: false; alreadyRunning?: undefined; reason: string; logFile: string };

export interface GatewayStartOptions {
	paths?: GatewayDaemonPaths;
	/** Full launch command; defaults to `bun <package cli.ts>`. */
	cmd?: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	readyTimeoutMs?: number;
	pollIntervalMs?: number;
}

/**
 * Spawn the gateway detached and wait until it owns the pid lock (written
 * after its HTTP server is listening) or exits early. The child survives the
 * calling TUI: stdio goes to the log file and the handle is unref'd.
 */
export async function startGatewayDaemon(options: GatewayStartOptions = {}): Promise<GatewayStartResult> {
	const paths = options.paths ?? resolveGatewayDaemonPaths();
	const existing = readAlivePid(paths.pidFile);
	if (existing !== undefined) return { started: false, alreadyRunning: true, pid: existing };

	await fs.promises.mkdir(paths.root, { recursive: true });
	const cmd = options.cmd ?? [process.execPath, GATEWAY_CLI_ENTRY];
	const logHandle = await fs.promises.open(paths.logFile, "a");
	const logFd = logHandle.fd;
	let child: ChildProcess;
	try {
		const envToPass: Record<string, string | undefined> = {
			CAPTURE_IDLE_EXIT_MS: String(DEFAULT_GATEWAY_IDLE_EXIT_MS),
			GATEWAY_DEFAULT_IDLE_EXIT_MS: String(DEFAULT_GATEWAY_IDLE_EXIT_MS),
			...(options.env ?? process.env),
		};
		if (options.env && "CAPTURE_IDLE_EXIT_MS" in options.env) {
			envToPass.CAPTURE_IDLE_EXIT_MS = options.env.CAPTURE_IDLE_EXIT_MS;
		}
		child = spawn(cmd[0] as string, cmd.slice(1), {
			cwd: options.cwd ?? GATEWAY_PACKAGE_ROOT,
			env: envToPass as NodeJS.ProcessEnv,
			// POSIX: new session so terminal signals to the TUI never reach the
			// gateway. Windows: children are independent already; detaching would
			// allocate a new console instead.
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["ignore", logFd, logFd],
		});
	} finally {
		await logHandle.close();
	}

	let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	child.once("exit", (code, signal) => {
		exited = { code, signal };
	});
	child.once("error", () => {
		// Surfaced via the `exited` poll below; spawn failures also emit "exit" on
		// some platforms, so normalize to one signal.
		exited ??= { code: null, signal: null };
	});
	child.unref();

	const deadline = Date.now() + (options.readyTimeoutMs ?? 10_000);
	const poll = options.pollIntervalMs ?? 150;
	while (Date.now() < deadline) {
		const pid = readAlivePid(paths.pidFile);
		if (pid !== undefined && pid === child.pid) return { started: true, pid, logFile: paths.logFile };
		// Another instance won a concurrent race; treat it as the running gateway.
		if (pid !== undefined) return { started: false, alreadyRunning: true, pid };
		if (exited) {
			const exit = exited.signal ? `signal ${exited.signal}` : `exit code ${exited.code ?? "unknown"}`;
			const tail = await formatLogTail(paths.logFile);
			return {
				started: false,
				reason: `gateway exited before becoming ready (${exit})${tail}`,
				logFile: paths.logFile,
			};
		}
		await Bun.sleep(poll);
	}

	// Alive but never wrote the lock — don't leave an untracked orphan behind.
	try {
		child.kill();
	} catch {
		// already gone
	}
	const tail = await formatLogTail(paths.logFile);
	return {
		started: false,
		reason: `gateway did not become ready within ${options.readyTimeoutMs ?? 10_000}ms${tail}`,
		logFile: paths.logFile,
	};
}

export type GatewayStopResult =
	| { stopped: true; pid: number }
	| { stopped: false; running: false }
	| { stopped: false; running: true; pid: number; reason: string };

export interface GatewayStopOptions {
	paths?: GatewayDaemonPaths;
	killTimeoutMs?: number;
	pollIntervalMs?: number;
}

/**
 * Terminate the running gateway and wait for the pid to die. Clears the pid
 * file afterwards because a hard kill (always the case on Windows) skips the
 * gateway's own exit cleanup.
 */
export async function stopGatewayDaemon(options: GatewayStopOptions = {}): Promise<GatewayStopResult> {
	const paths = options.paths ?? resolveGatewayDaemonPaths();
	const pid = readAlivePid(paths.pidFile);
	if (pid === undefined) return { stopped: false, running: false };

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Died between the read and the kill.
	}
	const deadline = Date.now() + (options.killTimeoutMs ?? 8_000);
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) {
			removePidFileFor(paths, pid);
			return { stopped: true, pid };
		}
		await Bun.sleep(options.pollIntervalMs ?? 100);
	}
	return {
		stopped: false,
		running: true,
		pid,
		reason: `pid ${pid} did not exit within ${options.killTimeoutMs ?? 8_000}ms`,
	};
}

async function formatLogTail(logFile: string): Promise<string> {
	try {
		const text = await Bun.file(logFile).text();
		const lines = text
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0)
			.slice(-LOG_TAIL_LINES);
		if (lines.length === 0) return "";
		return `\nlog tail (${logFile}):\n${lines.join("\n")}`;
	} catch {
		return "";
	}
}
