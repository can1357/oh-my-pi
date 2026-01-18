import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import type { Subprocess } from "bun";
import { getAgentDir } from "../config";
import { getShellConfig, killProcessTree } from "../utils/shell";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { logger } from "./logger";

const GATEWAY_DIR_NAME = "python-gateway";
const GATEWAY_INFO_FILE = "gateway.json";
const GATEWAY_STARTUP_TIMEOUT_MS = 30000;
const GATEWAY_IDLE_TIMEOUT_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;

const DEFAULT_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"VIRTUAL_ENV",
	"PYTHONPATH",
]);

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "OMP_"];

const DEFAULT_ENV_DENYLIST = new Set([
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"PERPLEXITY_API_KEY",
	"EXA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"MISTRAL_API_KEY",
]);

export interface GatewayInfo {
	url: string;
	pid: number;
	startedAt: number;
	refCount: number;
	cwd: string;
}

interface AcquireResult {
	url: string;
	isShared: boolean;
}

let localGatewayProcess: Subprocess | null = null;
let localGatewayUrl: string | null = null;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let isCoordinatorInitialized = false;

function filterEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const filtered: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (DEFAULT_ENV_DENYLIST.has(key)) continue;
		if (DEFAULT_ENV_ALLOWLIST.has(key)) {
			filtered[key] = value;
			continue;
		}
		if (DEFAULT_ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

async function resolveVenvPath(cwd: string): Promise<string | null> {
	if (process.env.VIRTUAL_ENV) return process.env.VIRTUAL_ENV;
	const candidates = [join(cwd, ".venv"), join(cwd, "venv")];
	for (const candidate of candidates) {
		if (await Bun.file(candidate).exists()) {
			return candidate;
		}
	}
	return null;
}

async function resolvePythonRuntime(cwd: string, baseEnv: Record<string, string | undefined>) {
	const env = { ...baseEnv };
	const venvPath = env.VIRTUAL_ENV ?? (await resolveVenvPath(cwd));
	if (venvPath) {
		env.VIRTUAL_ENV = venvPath;
		const binDir = process.platform === "win32" ? join(venvPath, "Scripts") : join(venvPath, "bin");
		const pythonCandidate = join(binDir, process.platform === "win32" ? "python.exe" : "python");
		if (await Bun.file(pythonCandidate).exists()) {
			env.PATH = env.PATH ? `${binDir}${delimiter}${env.PATH}` : binDir;
			return { pythonPath: pythonCandidate, env };
		}
	}

	const pythonPath = Bun.which("python") ?? Bun.which("python3");
	if (!pythonPath) {
		throw new Error("Python executable not found on PATH");
	}
	return { pythonPath, env };
}

async function allocatePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				const port = address.port;
				server.close((err: Error | null | undefined) => {
					if (err) {
						reject(err);
					} else {
						resolve(port);
					}
				});
			} else {
				server.close();
				reject(new Error("Failed to allocate port"));
			}
		});
	});
}

function getGatewayDir(): string {
	return join(getAgentDir(), GATEWAY_DIR_NAME);
}

function getGatewayInfoPath(): string {
	return join(getGatewayDir(), GATEWAY_INFO_FILE);
}

function ensureGatewayDir(): void {
	const dir = getGatewayDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function readGatewayInfo(): GatewayInfo | null {
	const infoPath = getGatewayInfoPath();
	if (!existsSync(infoPath)) return null;
	try {
		const content = readFileSync(infoPath, "utf-8");
		return JSON.parse(content) as GatewayInfo;
	} catch {
		return null;
	}
}

function writeGatewayInfo(info: GatewayInfo): void {
	const infoPath = getGatewayInfoPath();
	writeFileSync(infoPath, JSON.stringify(info, null, 2));
}

function clearGatewayInfo(): void {
	const infoPath = getGatewayInfoPath();
	if (existsSync(infoPath)) {
		try {
			unlinkSync(infoPath);
		} catch {
			// Ignore errors on cleanup
		}
	}
}

function isPidRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function isGatewayHealthy(url: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
		const response = await fetch(`${url}/api/kernelspecs`, {
			signal: controller.signal,
		});
		clearTimeout(timeout);
		return response.ok;
	} catch {
		return false;
	}
}

async function isGatewayAlive(info: GatewayInfo): Promise<boolean> {
	if (!isPidRunning(info.pid)) return false;
	return await isGatewayHealthy(info.url);
}

async function startGatewayProcess(cwd: string): Promise<{ url: string; pid: number }> {
	const { shell, env } = await getShellConfig();
	const filteredEnv = filterEnv(env);
	const runtime = await resolvePythonRuntime(cwd, filteredEnv);
	const snapshotPath = await getOrCreateSnapshot(shell, env).catch((err: unknown) => {
		logger.warn("Failed to resolve shell snapshot for shared Python gateway", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	});

	const kernelEnv: Record<string, string | undefined> = {
		...runtime.env,
		PYTHONUNBUFFERED: "1",
		OMP_SHELL_SNAPSHOT: snapshotPath ?? undefined,
	};

	const pythonPathParts = [cwd, kernelEnv.PYTHONPATH].filter(Boolean).join(delimiter);
	if (pythonPathParts) {
		kernelEnv.PYTHONPATH = pythonPathParts;
	}

	const gatewayPort = await allocatePort();
	const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

	const gatewayProcess = Bun.spawn(
		[
			runtime.pythonPath,
			"-m",
			"kernel_gateway",
			"--KernelGatewayApp.ip=127.0.0.1",
			`--KernelGatewayApp.port=${gatewayPort}`,
			"--KernelGatewayApp.port_retries=0",
			"--KernelGatewayApp.allow_origin=*",
			"--JupyterApp.answer_yes=true",
		],
		{
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: kernelEnv,
		},
	);

	let exited = false;
	gatewayProcess.exited
		.then(() => {
			exited = true;
		})
		.catch(() => {
			exited = true;
		});

	// Wait for gateway to become healthy
	const startTime = Date.now();
	while (Date.now() - startTime < GATEWAY_STARTUP_TIMEOUT_MS) {
		if (exited) {
			throw new Error("Gateway process exited during startup");
		}
		if (await isGatewayHealthy(gatewayUrl)) {
			localGatewayProcess = gatewayProcess;
			localGatewayUrl = gatewayUrl;
			return { url: gatewayUrl, pid: gatewayProcess.pid };
		}
		await Bun.sleep(100);
	}

	killProcessTree(gatewayProcess.pid);
	throw new Error("Gateway startup timeout");
}

function scheduleIdleShutdown(): void {
	if (idleShutdownTimer) {
		clearTimeout(idleShutdownTimer);
	}
	idleShutdownTimer = setTimeout(async () => {
		const info = readGatewayInfo();
		if (info && info.refCount === 0) {
			logger.debug("Shutting down idle shared gateway", { pid: info.pid });
			shutdownLocalGateway();
			clearGatewayInfo();
		}
		idleShutdownTimer = null;
	}, GATEWAY_IDLE_TIMEOUT_MS);
}

function cancelIdleShutdown(): void {
	if (idleShutdownTimer) {
		clearTimeout(idleShutdownTimer);
		idleShutdownTimer = null;
	}
}

function shutdownLocalGateway(): void {
	if (localGatewayProcess) {
		try {
			killProcessTree(localGatewayProcess.pid);
		} catch (err) {
			logger.warn("Failed to kill shared gateway process", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		localGatewayProcess = null;
		localGatewayUrl = null;
	}
}

export async function acquireSharedGateway(cwd: string): Promise<AcquireResult | null> {
	if (process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test") {
		return null;
	}

	try {
		ensureGatewayDir();

		// Try to use existing gateway first (without lock for quick check)
		const existingInfo = readGatewayInfo();
		if (existingInfo && (await isGatewayAlive(existingInfo))) {
			// Increment ref count atomically
			const updatedInfo = { ...existingInfo, refCount: existingInfo.refCount + 1 };
			writeGatewayInfo(updatedInfo);
			cancelIdleShutdown();
			logger.debug("Reusing shared gateway", { url: existingInfo.url, refCount: updatedInfo.refCount });
			isCoordinatorInitialized = true;
			return { url: existingInfo.url, isShared: true };
		}

		// Need to start new gateway - clean up stale info if any
		if (existingInfo) {
			logger.debug("Cleaning up stale gateway info", { pid: existingInfo.pid });
			clearGatewayInfo();
		}

		// Start new gateway
		const { url, pid } = await startGatewayProcess(cwd);
		const info: GatewayInfo = {
			url,
			pid,
			startedAt: Date.now(),
			refCount: 1,
			cwd,
		};
		writeGatewayInfo(info);
		isCoordinatorInitialized = true;
		logger.debug("Started shared gateway", { url, pid });
		return { url, isShared: true };
	} catch (err) {
		logger.warn("Failed to acquire shared gateway, falling back to local", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

export async function releaseSharedGateway(): Promise<void> {
	if (!isCoordinatorInitialized) return;

	try {
		const info = readGatewayInfo();
		if (!info) return;

		const newRefCount = Math.max(0, info.refCount - 1);
		if (newRefCount === 0) {
			// Schedule idle shutdown instead of immediate shutdown
			const updatedInfo = { ...info, refCount: 0 };
			writeGatewayInfo(updatedInfo);
			scheduleIdleShutdown();
			logger.debug("Scheduled idle shutdown for shared gateway", { pid: info.pid });
		} else {
			const updatedInfo = { ...info, refCount: newRefCount };
			writeGatewayInfo(updatedInfo);
			logger.debug("Released shared gateway reference", { url: info.url, refCount: newRefCount });
		}
	} catch (err) {
		logger.warn("Failed to release shared gateway", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function getSharedGatewayUrl(): string | null {
	return localGatewayUrl;
}

export function isSharedGatewayActive(): boolean {
	return localGatewayProcess !== null && localGatewayUrl !== null;
}

export async function shutdownSharedGateway(): Promise<void> {
	cancelIdleShutdown();
	const info = readGatewayInfo();
	if (info) {
		clearGatewayInfo();
	}
	shutdownLocalGateway();
	isCoordinatorInitialized = false;
}
