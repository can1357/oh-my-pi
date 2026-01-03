import { logger } from "@oh-my-pi/pi-coding-agent";

export type SandboxConfig = { type: "host" } | { type: "docker"; container: string };

export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			console.error("Error: docker sandbox requires container name (e.g., docker:mom-sandbox)");
			process.exit(1);
		}
		return { type: "docker", container };
	}
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host' or 'docker:<container-name>'`);
	process.exit(1);
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		return;
	}

	// Check if Docker is available
	try {
		await execSimple("docker", ["--version"]);
	} catch {
		console.error("Error: Docker is not installed or not in PATH");
		process.exit(1);
	}

	// Check if container exists and is running
	try {
		const result = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", config.container]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: docker start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error("Create it with: ./docker.sh create <data-dir>");
		process.exit(1);
	}

	console.log(`  Docker container '${config.container}' is running.`);
}

async function execSimple(cmd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code === 0) return stdout;
	throw new Error(stderr || `Exit code ${code}`);
}

/**
 * Create an executor that runs commands either on host or in Docker container
 */
export function createExecutor(config: SandboxConfig): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}
	return new DockerExecutor(config.container);
}

export interface Executor {
	/**
	 * Execute a bash command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Get the workspace path prefix for this executor
	 * Host: returns the actual path
	 * Docker: returns /workspace
	 */
	getWorkspacePath(hostPath: string): string;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

class HostExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const shell = process.platform === "win32" ? "cmd" : "sh";
		const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

		// Fix 4: Use object for flag visibility across async boundaries
		const state = { timedOut: false };
		let proc: ReturnType<typeof Bun.spawn> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const abortControllers: AbortController[] = [];

		const cleanup = () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			// Cancel all stream readers
			for (const controller of abortControllers) {
				controller.abort();
			}
		};

		const onAbort = () => {
			// Fix 1: Capture process reference atomically
			const p = proc;
			if (p) killProcessTree(p.pid);
		};

		// Fix 2: Register signal listener before spawning process
		if (options?.signal) {
			if (options.signal.aborted) {
				throw new Error("Command aborted");
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		proc = Bun.spawn([shell, ...shellArgs, command], {
			stdout: "pipe",
			stderr: "pipe",
		});

		// Start timeout after process is spawned
		if (options?.timeout && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				state.timedOut = true;
				// Fix 1: Capture process reference atomically
				const p = proc;
				if (p) killProcessTree(p.pid);
			}, options.timeout * 1000);
		}

		const MAX_BYTES = 10 * 1024 * 1024;

		// Fix 3: Make stream readers cancellable
		const readStream = async (stream: ReadableStream<Uint8Array>, abortSignal: AbortSignal): Promise<string> => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let result = "";
			try {
				while (true) {
					if (abortSignal.aborted) break;
					const { done, value } = await reader.read();
					if (done) break;
					result += decoder.decode(value, { stream: true });
					if (result.length > MAX_BYTES) {
						result = result.slice(0, MAX_BYTES);
						break;
					}
				}
			} finally {
				reader.releaseLock();
			}
			return result;
		};

		const stdoutController = new AbortController();
		const stderrController = new AbortController();
		abortControllers.push(stdoutController, stderrController);

		const [stdout, stderr] = await Promise.all([
			readStream(proc.stdout as ReadableStream<Uint8Array>, stdoutController.signal),
			readStream(proc.stderr as ReadableStream<Uint8Array>, stderrController.signal),
		]);

		const code = await proc.exited;

		cleanup();

		if (options?.signal?.aborted) {
			throw new Error(`${stdout}\n${stderr}\nCommand aborted`.trim());
		}

		if (state.timedOut) {
			throw new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim());
		}

		return { stdout, stderr, code };
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

class DockerExecutor implements Executor {
	constructor(private container: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		// Wrap command for docker exec
		const dockerCmd = `docker exec ${this.container} sh -c ${shellEscape(command)}`;
		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(dockerCmd, options);
	}

	getWorkspacePath(_hostPath: string): string {
		// Docker container sees /workspace
		return "/workspace";
	}
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			Bun.spawn(["taskkill", "/F", "/T", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
		} catch (err) {
			logger.debug("Process kill failed", { pid, error: String(err) });
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch (err) {
			logger.debug("Process kill failed", { pid, error: String(err) });
			try {
				process.kill(pid, "SIGKILL");
			} catch (err) {
				logger.debug("Process kill failed", { pid, error: String(err) });
			}
		}
	}
}

function shellEscape(s: string): string {
	// Escape for passing to sh -c
	return `'${s.replace(/'/g, "'\\''")}'`;
}
