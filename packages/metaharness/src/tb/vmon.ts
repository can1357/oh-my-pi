import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { type Client, connect, type HostGateway, type Process, type Sandbox } from "@stencil-hq/vibemon";
import type { GuestArch, VmonConfig } from "./types";

const INPUT_CHUNK_BYTES = 256 * 1024;
const STDERR_TAIL_BYTES = 32 * 1024;

/** Captured result from a Vibemon guest command. */
export interface VmonCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Options applied to one captured command inside a trial VM. */
export interface VmonExecOptions {
	/** Guest process deadline in seconds. */
	timeoutSec?: number;
	/** Environment merged over task defaults. */
	env?: Record<string, string>;
	/** `null` preserves the image default; omitted reuses the probed task workdir. */
	cwd?: string | null;
}

function quoteGuestShell(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function vmonArch(arch: GuestArch): "x86_64" | "aarch64" {
	return arch === "x64" ? "x86_64" : "aarch64";
}

function decodeBase64(value: string): string {
	const raw = atob(value);
	const bytes = new Uint8Array(raw.length);
	for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
	return new TextDecoder().decode(bytes);
}

function commandError(action: string, result: VmonCommandResult): Error {
	const detail = result.stderr.trim() || result.stdout.trim();
	return new Error(`${action} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`);
}

const clients = new Map<string, Client>();

function clientFor(config: VmonConfig): Client {
	const key = `${config.url}\0${config.token}`;
	let client = clients.get(key);
	if (!client) {
		client = connect(config.url, { token: config.token || undefined });
		clients.set(key, client);
	}
	return client;
}

async function waitUntilRunning(sandbox: Sandbox, timeoutSec: number): Promise<void> {
	const deadline = Date.now() + timeoutSec * 1_000;
	while (Date.now() < deadline) {
		const info = await sandbox.refresh();
		const state = String(info.observed_state ?? info.status ?? "").toLowerCase();
		if (state === "running") return;
		if (["exited", "failed", "stopped", "terminated"].includes(state)) {
			throw new Error(`Vibemon VM ${sandbox.id} entered ${state} before becoming ready`);
		}
		await Bun.sleep(250);
	}
	throw new Error(`Timed out waiting ${timeoutSec} seconds for Vibemon VM ${sandbox.id} to become ready`);
}

async function archiveDirectory(root: string): Promise<Blob> {
	const entries: Record<string, Uint8Array> = {};
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(absolute);
			} else if (entry.isFile()) {
				const relative = path.relative(root, absolute).split(path.sep).join("/");
				entries[relative] = new Uint8Array(await Bun.file(absolute).arrayBuffer());
			}
		}
	};
	await visit(root);
	return new Bun.Archive(entries, { compress: "gzip", level: 6 }).blob();
}

async function captureProcess(process: Process): Promise<VmonCommandResult> {
	const stdoutDecoder = new TextDecoder();
	const stderrDecoder = new TextDecoder();
	let stdout = "";
	let stderr = "";
	const drain = (async () => {
		for await (const event of process) {
			if (event.stream === "stdout") stdout += stdoutDecoder.decode(event.data, { stream: true });
			if (event.stream === "stderr") stderr += stderrDecoder.decode(event.data, { stream: true });
		}
	})();
	const [exit] = await Promise.all([process.wait(), drain]);
	stdout += stdoutDecoder.decode();
	stderr += stderrDecoder.decode();
	return { exitCode: exit.code, stdout, stderr };
}

function adaptRpcProcess(process: Process): RpcAgentProcess {
	const stderrChunks: Uint8Array[] = [];
	let stderrBytes = 0;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			void (async () => {
				try {
					for await (const event of process) {
						if (event.stream === "stdout") {
							controller.enqueue(event.data);
							continue;
						}
						if (event.stream !== "stderr") continue;
						stderrChunks.push(event.data);
						stderrBytes += event.data.byteLength;
						while (stderrBytes > STDERR_TAIL_BYTES) {
							const first = stderrChunks[0];
							const excess = stderrBytes - STDERR_TAIL_BYTES;
							if (first.byteLength <= excess) {
								stderrChunks.shift();
								stderrBytes -= first.byteLength;
							} else {
								stderrChunks[0] = first.slice(excess);
								stderrBytes -= excess;
							}
						}
					}
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			})();
		},
		cancel() {
			process.close();
		},
	});
	return {
		stdin: {
			write(data) {
				process.stdin.write(data);
			},
		},
		stdout,
		peekStderr() {
			const tail = new Uint8Array(stderrBytes);
			let offset = 0;
			for (const chunk of stderrChunks) {
				tail.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return new TextDecoder().decode(tail);
		},
		kill() {
			process.close();
		},
		exited: process.wait().then(exit => {
			const code: unknown = exit.code;
			if (typeof code === "number" && Number.isFinite(code)) return code;
			return exit.signal === null ? 1 : 128 + Math.abs(exit.signal);
		}),
	};
}

/** One persistent Vibemon microVM running a Terminal-Bench task image. */
export class TrialVm {
	/** Stable sandbox name used by every lifecycle call. */
	readonly name: string;
	/** Guest CPU architecture selecting the matching omp binary. */
	readonly arch: GuestArch;
	/** OCI image working directory probed after boot. */
	readonly workdir: string;
	/** Explicit agent home because TB images commonly leave HOME unset. */
	readonly home = "/root";
	readonly #sandbox: Sandbox;
	readonly #env: Record<string, string>;
	#gateway: HostGateway | null = null;

	constructor(sandbox: Sandbox, name: string, arch: GuestArch, workdir: string, env: Record<string, string>) {
		this.#sandbox = sandbox;
		this.name = name;
		this.arch = arch;
		this.workdir = workdir;
		this.#env = env;
	}

	/** Boot a detached OCI image as a KVM/HVF microVM. */
	static async start(opts: {
		config: VmonConfig;
		image: string;
		name: string;
		cpus: number;
		memoryMb: number;
		storageMb: number;
		timeoutSec: number;
		env: Record<string, string>;
	}): Promise<TrialVm> {
		const sandbox = await clientFor(opts.config).sandboxes.create({
			image: opts.image,
			name: opts.name,
			cpus: Math.max(1, Math.ceil(opts.cpus)),
			memory: Math.max(512, Math.ceil(opts.memoryMb)),
			disk_mb: Math.max(1_024, Math.ceil(opts.storageMb)),
			timeout: opts.timeoutSec,
			arch: vmonArch(opts.config.arch),
			allow_host_gateway: true,
			block_network: false,
			command: ["sh", "-c", "sleep infinity"],
			env: opts.env,
		});
		const provisional = new TrialVm(sandbox, opts.name, opts.config.arch, "/", opts.env);
		try {
			await waitUntilRunning(sandbox, Math.min(opts.timeoutSec, 1_200));
			const pwd = await provisional.exec("pwd", { timeoutSec: 30, cwd: null });
			if (pwd.exitCode !== 0 || pwd.stdout.trim().length === 0) {
				throw commandError(`Probing ${opts.name} workdir`, pwd);
			}
			return new TrialVm(sandbox, opts.name, opts.config.arch, pwd.stdout.trim(), opts.env);
		} catch (error) {
			await provisional.rm();
			throw error;
		}
	}

	/** Run a captured shell command inside the guest. */
	async exec(command: string, opts: VmonExecOptions = {}): Promise<VmonCommandResult> {
		const result = await this.#sandbox.run(["sh", "-c", command], {
			env: { ...this.#env, HOME: this.home, ...opts.env },
			workdir: opts.cwd === null ? null : (opts.cwd ?? this.workdir),
			timeout: opts.timeoutSec,
		});
		return {
			exitCode: result.exit,
			stdout: decodeBase64(result.stdout_b64),
			stderr: decodeBase64(result.stderr_b64),
		};
	}

	/** Stream one host file into the guest without a gRPC message-size copy. */
	async copyTo(hostPath: string, guestPath: string): Promise<void> {
		const file = Bun.file(hostPath);
		if (!(await file.exists())) throw new Error(`Host file does not exist: ${hostPath}`);
		const result = await this.#pipeInput(
			file,
			[
				"sh",
				"-c",
				`mkdir -p ${quoteGuestShell(path.posix.dirname(guestPath))} && cat > ${quoteGuestShell(guestPath)}`,
			],
			900,
		);
		if (result.exitCode !== 0) throw commandError(`Uploading ${hostPath} to ${this.name}:${guestPath}`, result);
	}

	/** Stream a host directory as a gzip-compressed tar archive into the guest. */
	async copyDirectory(hostDir: string, guestDir: string): Promise<void> {
		const archive = await archiveDirectory(hostDir);
		const result = await this.#pipeInput(
			archive,
			["sh", "-c", `mkdir -p ${quoteGuestShell(guestDir)} && tar xzf - -C ${quoteGuestShell(guestDir)}`],
			900,
		);
		if (result.exitCode !== 0) throw commandError(`Uploading ${hostDir} to ${this.name}:${guestDir}`, result);
	}

	async #pipeInput(input: Blob, command: string[], timeoutSec: number): Promise<VmonCommandResult> {
		const process = await this.#sandbox.exec(command, {
			env: { ...this.#env, HOME: this.home },
			workdir: this.workdir,
			timeout: timeoutSec,
		});
		const reader = input.stream().getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			for (let offset = 0; offset < value.byteLength; offset += INPUT_CHUNK_BYTES) {
				process.stdin.write(value.slice(offset, offset + INPUT_CHUNK_BYTES));
			}
		}
		process.stdin.close();
		return captureProcess(process);
	}

	/** Read one guest file, returning null when it does not exist. */
	async readFile(guestPath: string): Promise<string | null> {
		const result = await this.exec(
			`if [ -e ${quoteGuestShell(guestPath)} ]; then cat -- ${quoteGuestShell(guestPath)}; else exit 44; fi`,
		);
		if (result.exitCode === 44) return null;
		if (result.exitCode !== 0) throw commandError(`Reading ${this.name}:${guestPath}`, result);
		return result.stdout;
	}

	/** Attach the sandbox host gateway to a local HTTP(S) target. */
	async startGateway(localUrl: string): Promise<string> {
		if (this.#gateway) throw new Error(`Gateway already attached to ${this.name}`);
		const pathname = new URL(localUrl).pathname.replace(/\/+$/, "");
		const gateway = await this.#sandbox.hostGateway(localUrl);
		this.#gateway = gateway;
		return `${gateway.url.replace(/\/+$/, "")}${pathname}`;
	}

	/** Build an RpcClient launcher backed by a streaming Vibemon exec. */
	rpcTransport(entrypoint: string, timeoutSec: number): (agentArgs: string[]) => Promise<RpcAgentProcess> {
		return async agentArgs => {
			const process = await this.#sandbox.exec([entrypoint, ...agentArgs], {
				env: { ...this.#env, HOME: this.home },
				workdir: this.workdir,
				timeout: timeoutSec,
			});
			return adaptRpcProcess(process);
		};
	}

	/** Stop and permanently remove the trial microVM. */
	async rm(): Promise<void> {
		if (this.#gateway) {
			const gateway = this.#gateway;
			this.#gateway = null;
			gateway.close();
			await gateway.closed.catch(() => {});
		}
		try {
			await this.#sandbox.remove();
			return;
		} catch {
			// A running sandbox may need to be stopped before removal.
		}
		await this.#sandbox.stop().catch(() => {});
		await this.#sandbox.remove().catch(() => {});
	}
}
