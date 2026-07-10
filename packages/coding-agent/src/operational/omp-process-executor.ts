/**
 * Headless OMP worker executor: runs durable jobs by spawning the current CLI
 * in `launch --print` mode (or `--resume` on checkpoint retry).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import { isCompiledBinary } from "@pk-nerdsaver-ai/pi-utils/env";
import contextPrompt from "../prompts/operational/context.md" with { type: "text" };
import resumePrompt from "../prompts/operational/resume.md" with { type: "text" };
import type { JobExecutor, JobExecutorContext } from "./runner";
import type { JsonObject, JsonValue } from "./types";

export const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;
export type OmpApprovalMode = (typeof APPROVAL_MODES)[number];
export type OmpProcessJobPayload = JsonObject & {
	readonly prompt: string;
	readonly cwd: string;
	readonly model?: string;
	readonly approvalMode?: OmpApprovalMode;
	readonly sessionDir?: string;
};

export interface OmpSessionCheckpoint {
	readonly sessionFile: string;
}

export interface ResolveOmpSelfCommandOptions {
	readonly isCompiled?: boolean;
	readonly execPath?: string;
	readonly entryPath?: string;
}

export interface OmpProcessExecutorOptions {
	/** Full base argv for the OMP CLI (executable + optional script path). */
	readonly command?: readonly string[];
	readonly resolveCommand?: () => readonly string[];
	readonly maxOutputBytes?: number;
	readonly heartbeatIntervalMs?: number;
	readonly maxRuntimeMs?: number;
	readonly killGraceMs?: number;
	readonly createSessionDir?: (jobId: string) => string;
	readonly discoverSessionFile?: (sessionDir: string) => Promise<string | null>;
	readonly spawn?: typeof Bun.spawn;
	readonly getOperationalContext?: (job: JobExecutorContext["job"]) => string | Promise<string>;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const KNOWN_PAYLOAD_KEYS = new Set(["prompt", "cwd", "model", "approvalMode", "sessionDir"]);

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApprovalMode(value: unknown): value is OmpApprovalMode {
	return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export function parseOmpProcessJobPayload(value: JsonValue): OmpProcessJobPayload {
	if (!isRecord(value)) {
		throw new Error("omp job payload must be an object");
	}
	for (const key of Object.keys(value)) {
		if (!KNOWN_PAYLOAD_KEYS.has(key)) {
			throw new Error(`omp job payload has unknown field: ${key}`);
		}
	}

	const prompt = value.prompt;
	if (typeof prompt !== "string" || !prompt.trim()) {
		throw new Error("omp job payload.prompt must be a non-empty string");
	}
	const cwd = value.cwd;
	if (typeof cwd !== "string" || !cwd.trim()) {
		throw new Error("omp job payload.cwd must be a non-empty string");
	}

	let model: string | undefined;
	if (value.model !== undefined) {
		if (typeof value.model !== "string" || !value.model.trim()) {
			throw new Error("omp job payload.model must be a non-empty string when provided");
		}
		model = value.model.trim();
	}

	let approvalMode: OmpApprovalMode | undefined;
	if (value.approvalMode !== undefined) {
		if (!isApprovalMode(value.approvalMode)) {
			throw new Error("omp job payload.approvalMode must be always-ask|write|yolo");
		}
		approvalMode = value.approvalMode;
	}

	let sessionDir: string | undefined;
	if (value.sessionDir !== undefined) {
		if (typeof value.sessionDir !== "string" || !value.sessionDir.trim()) {
			throw new Error("omp job payload.sessionDir must be a non-empty string when provided");
		}
		sessionDir = value.sessionDir.trim();
	}

	return {
		prompt: prompt.trim(),
		cwd: path.resolve(cwd.trim()),
		...(model ? { model } : {}),
		...(approvalMode ? { approvalMode } : {}),
		...(sessionDir ? { sessionDir: path.resolve(sessionDir) } : {}),
	};
}

export function parseOmpSessionCheckpoint(value: JsonValue | null): OmpSessionCheckpoint | null {
	if (value === null || value === undefined) return null;
	if (!isRecord(value)) return null;
	const sessionFile = value.sessionFile;
	if (typeof sessionFile !== "string" || !sessionFile.trim()) return null;
	return { sessionFile: path.resolve(sessionFile.trim()) };
}

/**
 * Resolve argv prefix for re-entering the current OMP CLI.
 * Compiled binaries are invoked as `[execPath, ...]`; bun-script runs use
 * `[execPath, entryPath, ...]`.
 */
export function resolveOmpSelfCommand(options: ResolveOmpSelfCommandOptions = {}): string[] {
	const execPath = options.execPath ?? process.execPath;
	const compiled = options.isCompiled ?? isCompiledBinary();
	if (compiled) return [execPath];
	const entryPath = options.entryPath ?? Bun.main;
	if (!entryPath || entryPath === execPath) return [execPath];
	return [execPath, entryPath];
}

export function defaultOperationalSessionDir(jobId: string): string {
	return path.join(getAgentDir(), "operational", "sessions", jobId);
}

export async function discoverNewestSessionJsonl(sessionDir: string): Promise<string | null> {
	let entries: string[];
	try {
		entries = await fs.readdir(sessionDir);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}

	let newest: { fullPath: string; mtimeMs: number } | null = null;
	for (const name of entries) {
		if (!name.endsWith(".jsonl") || name.includes(".bak")) continue;
		const fullPath = path.join(sessionDir, name);
		try {
			const st = await fs.stat(fullPath);
			if (!st.isFile()) continue;
			if (!newest || st.mtimeMs > newest.mtimeMs) {
				newest = { fullPath, mtimeMs: st.mtimeMs };
			}
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
	}
	return newest?.fullPath ?? null;
}

export interface BuildOmpLaunchArgvInput {
	readonly command: readonly string[];
	readonly payload: OmpProcessJobPayload;
	readonly sessionDir: string;
	readonly resumeSessionFile?: string;
	readonly resumePromptText?: string;
	readonly promptText?: string;
}

export function buildOmpLaunchArgv(input: BuildOmpLaunchArgvInput): string[] {
	const argv = [...input.command, "launch", "--print", "--cwd", input.payload.cwd, "--session-dir", input.sessionDir];
	if (input.payload.approvalMode) {
		argv.push("--approval-mode", input.payload.approvalMode);
	}
	if (input.payload.model) {
		argv.push("--model", input.payload.model);
	}
	const promptText = input.promptText ?? input.payload.prompt;
	if (input.resumeSessionFile) {
		argv.push("--resume", input.resumeSessionFile);
		argv.push("--", input.resumePromptText ?? resumePrompt.trim());
	} else {
		argv.push("--", promptText);
	}
	return argv;
}

function isEnoent(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

async function readBounded(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	signal: AbortSignal,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
	if (!stream) return { text: "", truncated: false, bytes: 0 };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let truncated = false;
	const onAbort = (): void => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			if (bytes >= maxBytes) {
				truncated = true;
				await reader.cancel();
				break;
			}
			const remaining = maxBytes - bytes;
			if (value.byteLength > remaining) {
				chunks.push(value.slice(0, remaining));
				bytes += remaining;
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			bytes += value.byteLength;
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
	return {
		text: Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8"),
		truncated,
		bytes,
	};
}

export function createOmpProcessExecutor(options: OmpProcessExecutorOptions = {}): JobExecutor {
	const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
	const heartbeatIntervalMs = Math.max(1, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
	const maxRuntimeMs = Math.max(1, options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
	const killGraceMs = Math.max(1, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
	const spawn = options.spawn ?? Bun.spawn;
	const createSessionDir = options.createSessionDir ?? defaultOperationalSessionDir;
	const discoverSessionFile = options.discoverSessionFile ?? discoverNewestSessionJsonl;

	return async (ctx: JobExecutorContext): Promise<JsonValue> => {
		const payload = parseOmpProcessJobPayload(ctx.job.payload);
		const checkpoint = parseOmpSessionCheckpoint(ctx.checkpoint);
		const expectedSessionDir = createSessionDir(ctx.job.id);
		if (payload.sessionDir && path.resolve(payload.sessionDir) !== path.resolve(expectedSessionDir)) {
			throw new Error("omp job payload.sessionDir must match the job-owned session directory");
		}
		const sessionDir = expectedSessionDir;
		await fs.mkdir(sessionDir, { recursive: true });
		if (checkpoint?.sessionFile) {
			const relative = path.relative(sessionDir, checkpoint.sessionFile);
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
				throw new Error("omp checkpoint sessionFile must belong to the job-owned session directory");
			}
			const checkpointStat = await fs.stat(checkpoint.sessionFile).catch(error => {
				if (isEnoent(error)) return null;
				throw error;
			});
			if (!checkpointStat?.isFile()) throw new Error("omp checkpoint sessionFile does not exist");
		}

		const command = options.command
			? [...options.command]
			: options.resolveCommand
				? [...options.resolveCommand()]
				: resolveOmpSelfCommand();

		const operationalContext = (await options.getOperationalContext?.(ctx.job))?.trim();
		const renderedContext = operationalContext
			? prompt.render(contextPrompt, { context: operationalContext }).trim()
			: "";
		const promptText = renderedContext ? `${payload.prompt}\n\n${renderedContext}` : payload.prompt;
		const resumePromptText = renderedContext ? `${resumePrompt.trim()}\n\n${renderedContext}` : resumePrompt.trim();
		const argv = buildOmpLaunchArgv({
			command,
			payload,
			sessionDir,
			resumeSessionFile: checkpoint?.sessionFile,
			promptText,
			resumePromptText,
		});

		const proc = spawn({
			cmd: argv,
			cwd: payload.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: Bun.env,
		});

		const executionAbort = new AbortController();
		let timedOut = false;
		let forceKillTimer: NodeJS.Timeout | undefined;
		const forceExit = Promise.withResolvers<number>();
		const killProcess = (): void => {
			try {
				proc.kill();
			} catch {
				// Process may already have exited.
			}
			forceKillTimer ??= setTimeout(() => {
				try {
					proc.kill(9);
				} catch {
					// Process may already have exited.
				}
				const error = new Error(timedOut ? "omp process exceeded its runtime limit" : "omp process did not stop");
				error.name = timedOut ? "TimeoutError" : "AbortError";
				forceExit.reject(error);
			}, killGraceMs);
			forceKillTimer.unref?.();
		};

		const onAbort = (): void => {
			executionAbort.abort();
			killProcess();
		};
		if (ctx.signal.aborted) onAbort();
		else ctx.signal.addEventListener("abort", onAbort, { once: true });
		const runtimeTimer = setTimeout(() => {
			timedOut = true;
			executionAbort.abort();
			killProcess();
		}, maxRuntimeMs);
		runtimeTimer.unref?.();

		const heartbeatTimer = setInterval(() => {
			if (!ctx.heartbeat()) onAbort();
		}, heartbeatIntervalMs);
		if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

		let sessionFile: string | null = checkpoint?.sessionFile ?? null;
		const discoveryTimer = setInterval(
			() => {
				void discoverSessionFile(sessionDir)
					.then(found => {
						if (!found) return;
						sessionFile = found;
						ctx.checkpointWrite({ sessionFile: found });
					})
					.catch(() => {
						// Discovery is best-effort while the process is running.
					});
			},
			Math.min(heartbeatIntervalMs, 2_000),
		);
		if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();

		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				readBounded(proc.stdout, maxOutputBytes, executionAbort.signal),
				readBounded(proc.stderr, maxOutputBytes, executionAbort.signal),
				Promise.race([proc.exited, forceExit.promise]),
			]);

			const found = (await discoverSessionFile(sessionDir)) ?? sessionFile;
			if (found) {
				sessionFile = found;
				ctx.checkpointWrite({ sessionFile: found });
			}

			const result: JsonObject = {
				exitCode,
				sessionDir,
				...(sessionFile ? { sessionFile } : {}),
				stdoutBytes: stdout.bytes,
				stderrBytes: stderr.bytes,
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				stdout: stdout.text,
				stderr: stderr.text,
				resumed: Boolean(checkpoint?.sessionFile),
			};

			if (timedOut) {
				const error = new Error("omp process exceeded its runtime limit");
				error.name = "TimeoutError";
				throw error;
			}
			if (ctx.signal.aborted) {
				const error = new Error("omp process aborted");
				error.name = "AbortError";
				throw error;
			}

			if (exitCode !== 0) {
				throw new Error(`omp process exited with code ${exitCode}`);
			}

			return result;
		} finally {
			clearInterval(heartbeatTimer);
			clearInterval(discoveryTimer);
			clearTimeout(runtimeTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			ctx.signal.removeEventListener("abort", onAbort);
		}
	};
}
