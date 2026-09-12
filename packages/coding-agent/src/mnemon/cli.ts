import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { $which } from "@oh-my-pi/pi-utils";

const MAX_OUTPUT_BYTES = 256 * 1024;
const KILL_GRACE_MS = 1_500;

export interface MnemonRunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	readonly?: boolean;
}

export interface MnemonProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface MnemonCli {
	command: string;
	runText(args: string[], options?: MnemonRunOptions): Promise<string>;
	runJson(args: string[], options?: MnemonRunOptions): Promise<unknown>;
}

const COMMON_PATHS = [
	path.join(os.homedir(), ".local", "bin", "mnemon"),
	path.join(os.homedir(), "go", "bin", "mnemon"),
	"/opt/homebrew/bin/mnemon",
	"/usr/local/bin/mnemon",
];

export function findMnemonCommand(configured?: string) {
	// An explicit override is authoritative: spawning a bad path must surface an actionable
	// error instead of silently running a different mnemon found on PATH.
	const explicit = configured?.trim() || process.env.MNEMON_CLI_PATH?.trim();
	if (explicit) return explicit;
	return $which("mnemon") ?? COMMON_PATHS.find(candidate => fs.existsSync(candidate)) ?? "mnemon";
}

async function spawnOnce(command: string, args: string[], options: MnemonRunOptions = {}) {
	const { promise, resolve, reject } = Promise.withResolvers<MnemonProcessResult>();
	const child = spawn(command, args, {
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
		env: process.env,
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let bytes = 0;
	let settled = false;
	let pendingError: Error | null = null;
	let killTimer: Timer | undefined;
	const timeoutMs = options.timeoutMs ?? 8_000;

	const finish = (error: Error | null, result?: MnemonProcessResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		clearTimeout(killTimer);
		options.signal?.removeEventListener("abort", onAbort);
		if (error) reject(error);
		else resolve(result!);
	};
	const stop = (error: Error) => {
		pendingError = error;
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		child.kill("SIGTERM");
		killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, KILL_GRACE_MS);
	};
	const onAbort = () => {
		stop(new Error(`mnemon aborted: ${String(options.signal?.reason ?? "cancelled")}`));
	};
	const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
		bytes += chunk.byteLength;
		if (bytes > MAX_OUTPUT_BYTES) {
			stop(new Error(`mnemon output exceeded ${MAX_OUTPUT_BYTES} bytes`));
			return;
		}
		const text = kind === "stdout" ? stdoutDecoder.write(chunk) : stderrDecoder.write(chunk);
		if (kind === "stdout") stdout += text;
		else stderr += text;
	};

	child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
	child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
	child.on("error", (error: Error) => {
		finish(new Error(`failed to launch mnemon (${JSON.stringify(command)}): ${error.message}`));
	});
	child.on("close", exitCode => {
		stdout += stdoutDecoder.end();
		stderr += stderrDecoder.end();
		finish(pendingError, pendingError ? undefined : { stdout, stderr, exitCode });
	});
	const timeout = setTimeout(() => {
		stop(new Error(`mnemon did not respond within ${timeoutMs}ms`));
	}, timeoutMs);

	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

export function createMnemonCli(command = findMnemonCommand()): MnemonCli {
	let queue = Promise.resolve();
	const enqueue = <T>(work: () => Promise<T>) => {
		const run = queue.then(work, work);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const runText = (args: string[], options: MnemonRunOptions = {}) =>
		enqueue(async () => {
			if (options.signal?.aborted) {
				throw new Error(`mnemon aborted: ${String(options.signal.reason ?? "cancelled")}`);
			}
			const argv = options.readonly ? ["--readonly", ...args] : [...args];
			const result = await spawnOnce(command, argv, options);
			if (result.exitCode !== 0) {
				const detail = result.stderr.trim() || result.stdout.trim() || "no output";
				throw new Error(`mnemon ${args.join(" ")} exited ${String(result.exitCode)}: ${detail}`);
			}
			return String(result.stdout ?? "").trim();
		});

	const runJson = async (args: string[], options: MnemonRunOptions = {}) => {
		const stdout = await runText(args, options);
		try {
			return JSON.parse(stdout) as unknown;
		} catch {
			throw new Error(`mnemon ${args.join(" ")} returned invalid JSON`);
		}
	};

	return { command, runText, runJson };
}
