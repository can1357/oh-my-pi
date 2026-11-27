/**
 * OSC 7577 Program Resume Protocol reporting
 * (https://www.superlogical.com/rex/docs/build/program-resume).
 *
 * When the host terminal supplies `OSC7577_TOKEN`, omp captures it in memory
 * and removes it from `process.env` so child processes (tools, subagents,
 * shells, MCP/LSP servers) never inherit it. As the session starts, persists
 * to disk, switches, forks, or changes working directory, omp reports its
 * exact `--restore` command and working directory authenticated with SHA-256.
 *
 * Per protocol:
 * - User-initiated quit (`shutdown()`) sends `clear=1` so the exited session
 *   is not brought back on the next terminal restart.
 * - `/restart` does NOT send `clear=1` and forwards the captured token only to
 *   the replacement omp process on the same PTY.
 * - SIGHUP, SIGTERM, terminal loss, and crashes do NOT send `clear=1`.
 * - Resuming from a stop (`SIGCONT`) re-emits a fresh report with the current
 *   timestamp.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import { writeTerminalSequence } from "@oh-my-pi/pi-tui/driver/session";
import { getActiveProfile, isTerminalHeadless } from "@oh-my-pi/pi-utils";
import { restartArgv } from "../cli/flag-tables";
import { resolveRestartCmd } from "../subprocess/worker-client";

/** Environment variable carrying the per-terminal OSC 7577 token. */
export const OSC_7577_TOKEN_ENV = "OSC7577_TOKEN";

const OSC_7577 = "\x1b]7577;";
const ST = "\x1b\\";
/** Protocol minimum sequence length limit (`OSC` through `ST`). */
const MAX_SEQUENCE_BYTES = 2048;
/** Protocol minimum `argv` element count limit. */
const MAX_ARGV_ELEMENTS = 64;
/** Token grammar: 22 to 64 characters of `[A-Za-z0-9_-]`. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
/** Whether `text` contains a control character forbidden by OSC 7577 (U+0000–U+001F, U+007F, U+0080–U+009F). */
function hasControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/** Live session metadata read when emitting OSC 7577 resume reports. */
export interface ProgramResumeSource {
	/** Resolved session file path when materialized on disk (`isSessionOnDisk()`), else undefined. */
	sessionFile(): string | undefined;
	/** Current session working directory. */
	cwd(): string;
	/** Optional override for process.argv.slice(2), for tests. */
	launchArgs?(): string[];
	/** Optional override for the base executable command, for tests. */
	baseCmd?(): string[];
	/** Optional clock override returning Unix seconds, for tests. */
	nowSeconds?(): number;
}

const runtime: {
	/** Captured per-terminal token, never left in `process.env`. */
	token: string | undefined;
	/** Live source queried to build the current resume command. */
	source: ProgramResumeSource | undefined;
	/** Semantic key of the last report written (argv + cwd), for dedup. */
	reportedKey: string | undefined;
	/** True once a report has been emitted and not yet cleared. */
	active: boolean;
	/** Latched at teardown so late callbacks cannot write into the parent shell. */
	disposed: boolean;
} = {
	token: undefined,
	source: undefined,
	reportedKey: undefined,
	active: false,
	disposed: false,
};

/**
 * Capture `OSC7577_TOKEN` from `process.env` into memory and immediately delete
 * it from `process.env` so no child process inherits it. Safe to call multiple
 * times; a newly set env value replaces any previously captured token.
 */
export function captureProgramResumeToken(): string | undefined {
	const raw = process.env[OSC_7577_TOKEN_ENV];
	if (raw !== undefined) {
		try {
			delete process.env[OSC_7577_TOKEN_ENV];
		} catch {}
		runtime.token = TOKEN_PATTERN.test(raw) ? raw : undefined;
	}
	return runtime.token;
}

/**
 * Returns the captured OSC 7577 token solely so an in-place `/restart` can
 * pass it to the replacement omp process sharing the same PTY.
 */
export function getProgramResumeToken(): string | undefined {
	return runtime.token;
}

/**
 * Build the argv to relaunch/resume omp with its current flags, active profile,
 * and optional on-disk `sessionFile` (`--restore`). Shared by `/restart` and
 * OSC 7577 reporting.
 */
export function buildResumeArgv(
	sessionFile: string | undefined,
	options?: { launchArgs?: string[]; baseCmd?: string[] },
): string[] {
	const activeProfile = getActiveProfile();
	const cmd = [
		...(options?.baseCmd ?? resolveRestartCmd()),
		...restartArgv(
			options?.launchArgs ?? process.argv.slice(2),
			sessionFile ? path.resolve(sessionFile) : undefined,
			activeProfile ? { "--profile": true } : undefined,
		),
	];
	if (activeProfile) cmd.push("--profile", activeProfile);
	return cmd;
}

function isValidProgram(arg0: string): boolean {
	if (!arg0 || hasControlChar(arg0)) return false;
	if (path.isAbsolute(arg0)) return true;
	const hasSep = process.platform === "win32" ? /[/\\:]/.test(arg0) : arg0.includes("/");
	return !hasSep && !arg0.startsWith("-") && arg0 !== "." && arg0 !== "..";
}

function signBody(body: string, token: string): string {
	const mac = crypto.createHash("sha256").update(`${body}:${token}`).digest("hex");
	return `${OSC_7577}${body}:mac=${mac}${ST}`;
}

/**
 * Format an OSC 7577 set report for `argv` and `cwd` authenticated with `token`.
 * Returns `undefined` when the command violates protocol constraints (invalid
 * `argv[0]`, control characters, relative `cwd`, >64 args, or >2048 bytes).
 */
export function formatResumeReport(
	argv: readonly string[],
	cwd: string,
	token: string,
	options?: { pid?: number; time?: number },
): string | undefined {
	const pid = options?.pid ?? process.pid;
	const time = options?.time ?? runtime.source?.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
	if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(time) || time <= 0) return undefined;
	if (argv.length === 0 || argv.length > MAX_ARGV_ELEMENTS) return undefined;
	if (!isValidProgram(argv[0])) return undefined;
	for (const arg of argv) {
		if (hasControlChar(arg)) return undefined;
	}
	if (!cwd || !path.isAbsolute(cwd) || hasControlChar(cwd)) return undefined;

	const encodedArgv = argv.map(a => (a.length > 0 ? Buffer.from(a, "utf8").toString("base64") : "")).join(",");
	const encodedCwd = Buffer.from(cwd, "utf8").toString("base64");
	const body = `pid=${pid}:time=${time}:argv=${encodedArgv}:cwd=${encodedCwd}`;
	const seq = signBody(body, token);
	if (Buffer.byteLength(seq, "utf8") > MAX_SEQUENCE_BYTES) return undefined;
	return seq;
}

/** Format an OSC 7577 `clear=1` report authenticated with `token`. */
export function formatResumeClear(token: string, options?: { pid?: number; time?: number }): string | undefined {
	const pid = options?.pid ?? process.pid;
	const time = options?.time ?? runtime.source?.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
	if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(time) || time <= 0) return undefined;
	return signBody(`pid=${pid}:time=${time}:clear=1`, token);
}

function writeClearNow(): void {
	if (!runtime.active || !runtime.token) return;
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	const seq = formatResumeClear(runtime.token);
	runtime.active = false;
	runtime.reportedKey = undefined;
	if (seq) writeTerminalSequence(seq);
}

/**
 * Initialize OSC 7577 reporting for an interactive session and emit the
 * initial resume report if a token was supplied by the terminal.
 */
export function initProgramResume(source: ProgramResumeSource): void {
	captureProgramResumeToken();
	runtime.source = source;
	runtime.disposed = false;
	runtime.reportedKey = undefined;
	reportProgramResume();
}

/**
 * Report the current resume command and working directory via OSC 7577 when
 * they changed since the last report. If the command can no longer be
 * represented within protocol rules, sends `clear=1` so no stale record stays.
 */
export function reportProgramResume(): void {
	if (runtime.disposed || !runtime.token || !runtime.source) return;
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	const sessionFile = runtime.source.sessionFile();
	const cwd = path.resolve(runtime.source.cwd());
	const argv = buildResumeArgv(sessionFile, {
		launchArgs: runtime.source.launchArgs?.(),
		baseCmd: runtime.source.baseCmd?.(),
	});
	const key = JSON.stringify({ argv, cwd });
	if (key === runtime.reportedKey) return;

	const seq = formatResumeReport(argv, cwd, runtime.token);
	if (!seq) {
		// Protocol: when the new command cannot be reported, clear any earlier record.
		writeClearNow();
		return;
	}
	writeTerminalSequence(seq);
	runtime.reportedKey = key;
	runtime.active = true;
}

/**
 * Re-send a fresh OSC 7577 report with the current timestamp after resuming
 * from a stop (`SIGCONT`) or regaining the terminal.
 */
export function resendProgramResume(): void {
	runtime.reportedKey = undefined;
	reportProgramResume();
}

/**
 * Remove the terminal's OSC 7577 record on user-initiated exit (`shutdown()`),
 * and latch reporting off so no late callback writes into the parent shell.
 *
 * MUST NOT be called on SIGHUP, SIGTERM, terminal loss, or `/restart`.
 */
export function clearProgramResume(): void {
	writeClearNow();
	runtime.disposed = true;
	runtime.source = undefined;
}

/**
 * Latch reporting off without clearing the terminal's record (used during
 * `/restart` and non-user teardown so the record survives terminal loss).
 */
export function disposeProgramResume(): void {
	runtime.disposed = true;
	runtime.source = undefined;
}

/** Reset module state for unit tests. */
export function resetProgramResumeForTests(): void {
	runtime.token = undefined;
	runtime.source = undefined;
	runtime.reportedKey = undefined;
	runtime.active = false;
	runtime.disposed = false;
}
