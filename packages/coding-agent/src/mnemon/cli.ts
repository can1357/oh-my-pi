import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, toError } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

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

async function spawnOnce(
	command: string,
	args: string[],
	options: MnemonRunOptions = {},
): Promise<MnemonProcessResult> {
	const timeoutMs = options.timeoutMs ?? 8_000;
	let child: Subprocess;
	try {
		child = Bun.spawn([command, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		throw new Error(`failed to launch mnemon (${JSON.stringify(command)}): ${toError(error).message}`);
	}
	const stdoutStream = child.stdout as ReadableStream<Uint8Array>;
	const stderrStream = child.stderr as ReadableStream<Uint8Array>;
	const stdoutDecoder = new TextDecoder();
	const stderrDecoder = new TextDecoder();
	let stdout = "";
	let stderr = "";
	let bytes = 0;
	let pendingError: Error | null = null;
	let killTimer: Timer | undefined;

	const stop = (error: Error) => {
		pendingError = error;
		if (child.exitCode !== null) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// Exited between the check and the signal.
		}
		killTimer ??= setTimeout(() => {
			if (child.exitCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {
					// Exited between the check and the signal.
				}
			}
		}, KILL_GRACE_MS);
	};
	const onAbort = () => {
		stop(new Error(`mnemon aborted: ${String(options.signal?.reason ?? "cancelled")}`));
	};
	const pump = async (stream: ReadableStream<Uint8Array>, decoder: TextDecoder, kind: "stdout" | "stderr") => {
		for await (const value of stream) {
			bytes += value.byteLength;
			if (bytes > MAX_OUTPUT_BYTES) {
				stop(new Error(`mnemon output exceeded ${MAX_OUTPUT_BYTES} bytes`));
				return;
			}
			const text = decoder.decode(value, { stream: true });
			if (kind === "stdout") stdout += text;
			else stderr += text;
		}
	};

	const timeout = setTimeout(() => {
		stop(new Error(`mnemon did not respond within ${timeoutMs}ms`));
	}, timeoutMs);
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const [, , exitCode] = await Promise.all([
			pump(stdoutStream, stdoutDecoder, "stdout"),
			pump(stderrStream, stderrDecoder, "stderr"),
			child.exited,
		]);
		stdout += stdoutDecoder.decode();
		stderr += stderrDecoder.decode();
		if (pendingError) throw pendingError;
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(timeout);
		clearTimeout(killTimer);
		options.signal?.removeEventListener("abort", onAbort);
	}
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
