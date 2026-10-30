/**
 * Runner for the official Muse Code client (`muse exec --json`).
 *
 * The invocation follows the observed contract from the Muse 1.4.14 capture:
 * a prompt file, an absolute workspace, `--no-session-log`, non-interactive
 * stdin, and a temporary directory outside the workspace (the runtime host
 * refuses a TMPDIR inside its workspace). Approval and sandbox stay at the
 * client's documented defaults; this runner never adds `--yolo`,
 * `--disable-approval`, `--disable-sandbox`, `--trust-workspace`, or network
 * widening. It also never selects a provider: the client's licensed default is
 * the production path. `--provider echo` exists only as the explicit
 * `provider: "echo"` test seam used by the offline smoke script.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { ToolAbortError } from "../tools/tool-errors";
import { TOOL_TIMEOUTS } from "../tools/tool-timeouts";
import {
	MUSE_MAX_LINE_CHARS,
	MUSE_MAX_STDERR_BYTES,
	MuseExecStreamParser,
	type MuseExecOutcome,
	type MuseExecStreamEvent,
	sanitizeMuseText,
} from "./protocol";

/** Installed client name resolved through PATH. */
export const MUSE_BIN = "muse";
/** Tool output bytes fed back to the model per step; the client requires 0 or >= 9. */
export const MUSE_DEFAULT_MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
/** Default whole-run deadline; mirrors the `muse` entry in TOOL_TIMEOUTS for direct runners. */
export const MUSE_DEFAULT_TIMEOUT_MS = TOOL_TIMEOUTS.muse.default * 1000;

/** Offline provider used only by tests and the echo smoke script. */
export type MuseExecProvider = "echo";

export interface MuseExecChild {
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number>;
	kill(signal?: NodeJS.Signals | number): void;
}
/** Grace period between cancellation's SIGTERM and a SIGKILL. */
export const MUSE_ABORT_KILL_GRACE_MS = 5_000;
/** Extra wait for stdout/stderr to close after the client is killed. */
export const MUSE_PIPE_DRAIN_GRACE_MS = 5_000;

export interface MuseExecSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin: "ignore";
	stdout: "pipe";
	stderr: "pipe";
}

export type MuseExecSpawn = (command: string[], options: MuseExecSpawnOptions) => MuseExecChild;

const defaultSpawn: MuseExecSpawn = (command, options) => {
	const child = Bun.spawn(command, options);
	return {
		stdout: child.stdout as ReadableStream<Uint8Array> | null,
		stderr: child.stderr as ReadableStream<Uint8Array> | null,
		exited: child.exited,
		kill: signal => child.kill(signal),
	};
};

export interface MuseExecInvocationOptions {
	/** Absolute workspace root handed to policy-gated tools. */
	workspace: string;
	/** Client binary to invoke; defaults to `muse` resolved on PATH. */
	bin?: string;
	/** Prompt file inside {@link tempDir}. */
	promptFile: string;
	/** Temporary directory, outside the workspace. */
	tempDir: string;
	maxModelSteps?: number;
	maxToolOutputBytes?: number;
	/** Offline test seam; production callers omit it. */
	provider?: MuseExecProvider;
}

export interface MuseExecInvocation {
	command: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
}

function isInsideWorkspace(candidate: string, workspace: string): boolean {
	const relative = path.relative(path.resolve(workspace), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Pick a temporary root outside the workspace. The client's runtime host fails
 * at startup when its process-lifetime tool-output root lands inside the
 * configured workspace or repository, so neither an OS temp dir inside the
 * workspace nor its parent (often another directory in the same repository)
 * is a safe fallback.
 */
export function resolveMuseTempRoot(workspace: string): string {
	const candidates = [os.tmpdir(), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		if (path.isAbsolute(candidate) && !isInsideWorkspace(candidate, workspace)) return candidate;
	}
	throw new ToolError(
		`No temporary directory outside the Muse workspace ${workspace}; set TMPDIR to a directory outside it.`,
	);
}

/** Build the exact `muse exec` argv and environment for one delegation. */
export function buildMuseExecInvocation(options: MuseExecInvocationOptions): MuseExecInvocation {
	if (!path.isAbsolute(options.workspace)) {
		throw new ToolError(`Muse workspace must be absolute: ${options.workspace}`);
	}
	if (!path.isAbsolute(options.promptFile) || !path.isAbsolute(options.tempDir)) {
		throw new ToolError("Muse prompt file and temporary directory must be absolute paths");
	}
	if (isInsideWorkspace(options.tempDir, options.workspace)) {
		throw new ToolError(`Muse temporary directory must be outside the workspace: ${options.tempDir}`);
	}
	const maxToolOutputBytes = options.maxToolOutputBytes ?? MUSE_DEFAULT_MAX_TOOL_OUTPUT_BYTES;
	if (maxToolOutputBytes !== 0 && maxToolOutputBytes < 9) {
		throw new ToolError("Muse max tool output bytes must be 0 or at least 9");
	}
	const command = [
		options.bin ?? MUSE_BIN,
		"exec",
		"--json",
		"--prompt-file",
		options.promptFile,
		"--workspace",
		options.workspace,
		"--no-session-log",
		"--user-input-auto-resolve",
		"--max-tool-output-bytes",
		String(maxToolOutputBytes),
	];
	if (options.maxModelSteps !== undefined) {
		if (!Number.isInteger(options.maxModelSteps) || options.maxModelSteps < 1) {
			throw new ToolError("Muse max model steps must be a positive integer");
		}
		command.push("--max-model-steps", String(options.maxModelSteps));
	}
	if (options.provider) command.push("--provider", options.provider);
	return {
		command,
		cwd: options.workspace,
		env: {
			...process.env,
			MUSE_NO_AUTO_UPDATE: "1",
			TMPDIR: options.tempDir,
			TMP: options.tempDir,
			TEMP: options.tempDir,
		},
	};
}

export interface MuseExecRunOptions {
	/** The full prompt. Written to a 0600 file, never passed as argv. */
	prompt: string;
	/** Absolute workspace root. */
	workspace: string;
	/** Client binary override; defaults to {@link MUSE_BIN}. */
	bin?: string;
	maxModelSteps?: number;
	maxToolOutputBytes?: number;
	timeoutMs?: number;
	/** Offline test seam; production callers omit it. */
	provider?: MuseExecProvider;
	signal?: AbortSignal;
	/** Receives sanitized, size-capped delta/terminal/task events while running. */
	onEvent?: (event: MuseExecStreamEvent) => void;
	spawn?: MuseExecSpawn;
}

export interface MuseExecRunResult {
	outcome: MuseExecOutcome;
	exitCode: number;
	elapsedMs: number;
	/** Sanitized, bounded stderr text (client info lines plus failures). */
	stderr: string;
	/** Raw stdout line count, including skipped lines. */
	stdoutLines: number;
}

async function consumeStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let captured = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (captured < MUSE_MAX_STDERR_BYTES) {
				const take = Math.min(value.byteLength, MUSE_MAX_STDERR_BYTES - captured);
				if (take > 0) {
					chunks.push(value.subarray(0, take));
					captured += take;
				}
			} else {
				truncated = true;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const raw = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
	const sanitized = sanitizeMuseText(raw, MUSE_MAX_STDERR_BYTES);
	const text = sanitized.text.trim();
	return truncated ? `${text}\n[… stderr truncated]` : text;
}

async function consumeStdout(
	stream: ReadableStream<Uint8Array>,
	parser: MuseExecStreamParser,
	onEvent: ((event: MuseExecStreamEvent) => void) | undefined,
): Promise<number> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let lines = 0;
	const handle = (line: string): void => {
		lines++;
		const event = parser.pushLine(line);
		if (event) onEvent?.(event);
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				handle(line);
			}
			// Never buffer a line past the cap: an overlong line is corrupt
			// stdout, and the run fails instead of silently dropping it.
			if (buffer.length > MUSE_MAX_LINE_CHARS) {
				throw new ToolError(`Muse exec emitted a stdout line over ${MUSE_MAX_LINE_CHARS} characters.`);
			}
		}
	} finally {
		reader.releaseLock();
	}
	buffer += decoder.decode();
	if (buffer.length > 0) handle(buffer);
	return lines;
}

/** Human-facing failure text from exit status, stderr, and the parsed stream. */
export function describeMuseExecFailure(exitCode: number, stderr: string, outcome: MuseExecOutcome): string {
	const lines: string[] = [];
	if (exitCode === 2) lines.push("Muse exec rejected the invocation (exit 2; usage error).");
	else if (exitCode === 1) lines.push("Muse runtime failed to start (exit 1).");
	else if (exitCode !== 0) lines.push(`Muse exec exited with status ${exitCode}.`);
	else if (outcome.status === "incomplete") {
		lines.push("Muse exec ended without a run.terminal.* record (exit 0).");
	} else {
		lines.push(`Muse exec reported terminal "${outcome.terminal ?? "unknown"}".`);
	}
	if (outcome.usage) {
		const usage = outcome.usage;
		lines.push(
			`Usage: ${usage.calls} call(s) (${usage.completedCalls} completed, ${usage.failedCalls} failed, ${usage.cancelledCalls} cancelled).`,
		);
	}
	if (outcome.reason) lines.push(`Reason: ${outcome.reason}`);
	if (stderr.trim()) lines.push(`stderr:\n${stderr.trim()}`);
	return lines.join("\n");
}

/** Create the per-run prompt file in a temp directory outside the workspace. */
export async function prepareMusePrompt(
	workspace: string,
	prompt: string,
): Promise<{ tempDir: string; promptFile: string }> {
	const tempDir = await fs.mkdtemp(path.join(resolveMuseTempRoot(workspace), "omp-muse-"));
	const promptFile = path.join(tempDir, "prompt.md");
	try {
		await fs.writeFile(promptFile, prompt, { mode: 0o600, encoding: "utf8" });
	} catch (error) {
		await removeWithRetries(tempDir).catch(() => {});
		throw error;
	}
	return { tempDir, promptFile };
}

/**
 * Run one `muse exec` turn. Throws {@link ToolAbortError} on caller
 * cancellation and {@link ToolError} on spawn failure, non-completed terminal,
 * or exit 0 without a terminal record. A successful result carries the terminal
 * answer, sanitized usage, and task activity counts (which never decide status).
 */
export async function runMuseExec(options: MuseExecRunOptions): Promise<MuseExecRunResult> {
	if (options.signal?.aborted) throw new ToolAbortError(undefined, { cause: options.signal.reason });
	if (!path.isAbsolute(options.workspace)) {
		throw new ToolError(`Muse workspace must be absolute: ${options.workspace}`);
	}
	const startedAt = performance.now();
	const timeoutMs = options.timeoutMs ?? MUSE_DEFAULT_TIMEOUT_MS;
	const { tempDir, promptFile } = await prepareMusePrompt(options.workspace, options.prompt);
	const spawn = options.spawn ?? defaultSpawn;
	const parser = new MuseExecStreamParser();
	let child: MuseExecChild | undefined;
	let timedOut = false;
	let timer: NodeJS.Timeout | undefined;
	let escalationTimer: NodeJS.Timeout | undefined;
	let drainTimer: NodeJS.Timeout | undefined;
	const onAbort = (): void => {
		child?.kill("SIGTERM");
		escalationTimer = setTimeout(() => child?.kill("SIGKILL"), MUSE_ABORT_KILL_GRACE_MS);
		escalationTimer.unref?.();
	};
	try {
		const invocation = buildMuseExecInvocation({
			workspace: options.workspace,
			bin: options.bin,
			promptFile,
			tempDir,
			maxModelSteps: options.maxModelSteps,
			maxToolOutputBytes: options.maxToolOutputBytes,
			provider: options.provider,
		});
		try {
			child = spawn(invocation.command, {
				cwd: invocation.cwd,
				env: invocation.env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			throw new ToolError(
				`Could not start the Muse Code client (${options.bin ?? MUSE_BIN}). Install it, ensure it is on PATH, or set muse.path.`,
				{ cause: error },
			);
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		// Recheck after registering: an abort that landed between the spawn and
		// the listener would otherwise leave the client running to its deadline.
		if (options.signal?.aborted) onAbort();
		timer = setTimeout(() => {
			timedOut = true;
			child?.kill("SIGKILL");
		}, timeoutMs);
		timer.unref?.();

		const stdoutTask = child.stdout ? consumeStdout(child.stdout, parser, options.onEvent) : Promise.resolve(0);
		const stderrTask = child.stderr ? consumeStderr(child.stderr) : Promise.resolve("");
		// A surviving grandchild can hold the pipes open after the client exits.
		// Bound the drain instead of waiting on a pipe nobody will close.
		const drainDeadline = Promise.withResolvers<never>();
		drainTimer = setTimeout(() => {
			timedOut = true;
			drainDeadline.reject(new ToolError(`Muse exec timed out after ${Math.round(timeoutMs / 1000)}s.`));
		}, timeoutMs + MUSE_PIPE_DRAIN_GRACE_MS);
		drainTimer.unref?.();
		const output = Promise.all([child.exited, stdoutTask, stderrTask]);
		void output.catch(() => {});
		const [exitCode, stdoutLines, stderrText] = await Promise.race([output, drainDeadline.promise]);
		const outcome = parser.finish();
		if (options.signal?.aborted) throw new ToolAbortError(undefined, { cause: options.signal.reason });
		if (timedOut) {
			throw new ToolError(`Muse exec timed out after ${Math.round(timeoutMs / 1000)}s.`);
		}
		if (exitCode !== 0 || outcome.status !== "completed") {
			throw new ToolError(describeMuseExecFailure(exitCode, stderrText, outcome));
		}
		return {
			outcome,
			exitCode,
			elapsedMs: Math.round(performance.now() - startedAt),
			stderr: stderrText,
			stdoutLines,
		};
	} catch (error) {
		if (options.signal?.aborted) throw new ToolAbortError(undefined, { cause: options.signal.reason });
		if (timedOut) throw new ToolError(`Muse exec timed out after ${Math.round(timeoutMs / 1000)}s.`);
		if (error instanceof ToolError || error instanceof ToolAbortError) throw error;
		const message = error instanceof Error ? sanitizeMuseText(error.message, 2000).text : String(error);
		throw new ToolError(`Muse exec failed: ${message}`, { cause: error });
	} finally {
		clearTimeout(timer);
		clearTimeout(escalationTimer);
		clearTimeout(drainTimer);
		options.signal?.removeEventListener("abort", onAbort);
		if (child) {
			// Best-effort: the client may leave the runtime host alive after an
			// abort, and exited has already settled on the normal path.
			try {
				child.kill("SIGKILL");
			} catch {}
		}
		await removeWithRetries(tempDir).catch(() => {});
	}
}
