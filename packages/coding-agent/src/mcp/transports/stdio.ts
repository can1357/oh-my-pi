/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, readJsonl } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { hostHasInheritableConsole } from "../../eval/py/spawn-options";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import {
	createMCPJsonRpcError,
	MCP_ERROR_MESSAGE_MAX_CHARS,
	MCPTransportError,
	nonRetryableMCPTransportError,
	normalizeMCPTransportError,
	redactCredentials,
	redactDiagnosticText,
	stripTrailingFetchAdvice,
	trailingFetchAdvice,
} from "../errors";
import { RequestIdAllocator } from "../request-id";
import { routeProgressNotification, withProgressToken } from "../progress";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";
import { isThenable } from "../../utils/ipc";

/** Subprocess argv and platform-derived spawn flags for an MCP stdio server. */
export interface StdioSpawnCommand {
	cmd: string[];
	/**
	 * Hide the Windows console window for the direct child.
	 *
	 * Windows uses this only when the OMP host has no console to share. When
	 * the host is running inside a terminal, `windowsHide: true` maps to
	 * `CREATE_NO_WINDOW`, which strips that inheritable console from hidden
	 * `cmd.exe` / PowerShell wrapper chains. Their console grandchildren then
	 * allocate fresh visible conhost windows during startup or reconnects
	 * (#3567).
	 */
	windowsHide?: boolean;
	/**
	 * Run the subprocess in its own session when the platform can safely do so.
	 *
	 * Linux/other POSIX: `true`. Detach → `setsid`, so the MCP process tree has
	 * no controlling terminal and terminal job-control signals (Ctrl+Z SIGTSTP,
	 * background-read SIGTTIN) cannot stop stdio servers such as
	 * `chrome-devtools-mcp` and leave our read loop blocked on silent pipes.
	 *
	 * macOS: `false`. LaunchServices/TCC attributes Apple Events automation to
	 * the responsible terminal process only while the child stays in the
	 * inherited session; detaching via `setsid` prevents the permission prompt
	 * for servers such as `xcrun mcpbridge` (#4987).
	 *
	 * Windows: `false`. There is no SIGTSTP/SIGTTIN to escape, and Windows
	 * wrapper chains must stay in the OMP console session so nested console
	 * grandchildren keep stdout routed through our pipe (#3544).
	 */
	detached: boolean;
	/**
	 * Pass argv to `Bun.spawn` verbatim (Windows only), suppressing the
	 * default libuv backslash-quoting.
	 *
	 * Set when `cmd` already holds a `cmd.exe /d /e:ON /v:OFF /c "<line>"`
	 * command line escaped for `cmd.exe`'s parser (see `buildCmdExeArgv`).
	 * libuv's quoting targets `CommandLineToArgvW`, not `cmd.exe`, so letting
	 * it re-quote a batch launch would corrupt arguments and re-open the
	 * `%VAR%` / quote-injection holes the escaping closes (BatBadBut,
	 * CVE-2024-24576).
	 */
	windowsVerbatimArguments?: boolean;
}

/** Inputs used to resolve platform-specific stdio spawn behavior. */
export interface ResolveStdioSpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	hostHasInheritableConsole?: boolean;
	platform?: NodeJS.Platform;
	signal?: AbortSignal;
}

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

function getCaseInsensitiveEnv(env: Record<string, string | undefined>, name: string): string | undefined {
	const direct = env[name];
	if (direct !== undefined) return direct;
	const normalized = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === normalized) return value;
	}
	return undefined;
}

function getWindowsPathExt(env: Record<string, string | undefined>): string[] {
	const raw = getCaseInsensitiveEnv(env, "PATHEXT");
	if (!raw) return DEFAULT_WINDOWS_PATHEXT;
	const extensions: string[] = [];
	for (const part of raw.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		extensions.push(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
	}
	return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATHEXT;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function hasPathSegment(command: string): boolean {
	return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}

function hasExecutableExtension(command: string, extensions: string[]): boolean {
	const ext = path.extname(command).toLowerCase();
	if (!ext) return false;
	return extensions.some(candidate => candidate.toLowerCase() === ext);
}

async function resolveWindowsCommandPath(
	command: string,
	cwd: string,
	env: Record<string, string | undefined>,
	signal?: AbortSignal,
): Promise<string | null> {
	const extensions = getWindowsPathExt(env);
	const hasExt = hasExecutableExtension(command, extensions);
	const candidates = hasExt ? [command] : extensions.map(ext => `${command}${ext}`);

	if (hasPathSegment(command)) {
		for (const candidate of candidates) {
			signal?.throwIfAborted();
			const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
			if (await fileExists(resolved)) return resolved;
		}
		return hasExt ? command : null;
	}

	// Match cmd.exe's lookup order for an unqualified name: current directory
	// first, then PATH. Skipping cwd would launch a global shim instead of a
	// project-local one with the same name.
	const searchDirs = [cwd];
	const pathValue = getCaseInsensitiveEnv(env, "PATH");
	if (pathValue) {
		for (const dir of pathValue.split(";")) {
			if (dir) searchDirs.push(dir);
		}
	}
	for (const dir of searchDirs) {
		for (const candidate of candidates) {
			signal?.throwIfAborted();
			const resolved = path.join(dir, candidate);
			if (await fileExists(resolved)) return resolved;
		}
	}
	return hasExt ? command : null;
}

function resolveWindowsShimPath(value: string, shimDir: string): string | null {
	const match = /^%dp0%[\\/]*(.*)$/i.exec(value);
	if (!match) return null;
	const suffix = match[1];
	if (!suffix) return shimDir;
	return path.join(shimDir, ...suffix.split(/[\\/]+/).filter(Boolean));
}

async function resolveWindowsNpmShimCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	windowsHide: boolean,
): Promise<StdioSpawnCommand | null> {
	if (!isWindowsBatchCommand(command)) return null;
	if (!hasPathSegment(command)) return null;
	const commandPath = path.resolve(cwd, command);
	const commandName = path
		.basename(commandPath)
		.replace(/\.cmd$/i, "")
		.toLowerCase();
	if (commandName === "npx") return null;

	let content: string;
	try {
		content = await Bun.file(commandPath).text();
	} catch {
		return null;
	}

	// cmd-shim emits the same invocation line for every interpreter; only
	// bypass cmd.exe when the shim's fallback interpreter is actually node.
	// The IF EXIST branch assigns a %dp0%-prefixed value, so requiring a
	// non-%-leading SET value picks the bare PATH-fallback program name.
	const prog = /SET\s+"_prog=([^%"][^"]*)"/i.exec(content)?.[1];
	if (
		!prog ||
		path
			.basename(prog)
			.replace(/\.exe$/i, "")
			.toLowerCase() !== "node"
	)
		return null;

	const rawTarget = /"%_prog%"\s+"([^"]+)"\s+%\*/i.exec(content)?.[1];
	if (!rawTarget) return null;

	const target = resolveWindowsShimPath(rawTarget, path.dirname(commandPath));
	if (!target) return null;

	const siblingNode = path.join(path.dirname(commandPath), "node.exe");
	const nodeCommand = (await fileExists(siblingNode)) ? siblingNode : "node";
	return {
		cmd: [nodeCommand, target, ...args],
		windowsHide,
		detached: false,
	};
}

function isWindowsBatchCommand(command: string): boolean {
	return WINDOWS_BATCH_EXTENSIONS.has(path.extname(command).toLowerCase());
}

function resolveComSpec(env: Record<string, string | undefined>): string {
	const comspec = getCaseInsensitiveEnv(env, "COMSPEC");
	return comspec && comspec.length > 0 ? comspec : "cmd.exe";
}

// Argument bytes cmd.exe delivers unchanged without quoting. Anything outside
// this set (spaces, quotes, `%`, shell metacharacters, non-ASCII) forces the
// quoted+escaped path below. Mirrors the fuzz-tested allow-list from Zig's
// BatBadBut mitigation.
const CMD_SAFE_ARG = /^[A-Za-z0-9#$*+\-./:?@\\_]+$/;

/**
 * Escape the interior of a `cmd.exe`-quoted token: neutralize `%VAR%` expansion
 * and double any backslash run that precedes a quote (including the caller's
 * closing quote) so `CommandLineToArgvW` delivers the backslashes literally.
 *
 * `cmd.exe` re-parses the whole `/c` string and expands `%…%` *before* the
 * batch shim's own argv split runs, so both the command path and every argument
 * must pass through this. Percent → `%%cd:~,%` (which expands to nothing,
 * leaving a literal `%`) and `"` → `""` are the documented BatBadBut mitigation
 * (CVE-2024-24576). The caller supplies the surrounding double quotes.
 *
 * @see https://flatt.tech/research/posts/batbadbut-you-cant-securely-execute-commands-on-windows/
 */
function escapeCmdQuotedInterior(value: string): string {
	let out = "";
	let backslashes = 0;
	for (const ch of value) {
		if (ch === "\\") {
			backslashes += 1;
			out += ch;
		} else if (ch === '"') {
			out += "\\".repeat(backslashes);
			out += '""';
			backslashes = 0;
		} else if (ch === "%") {
			out += "%%cd:~,%";
			backslashes = 0;
		} else {
			backslashes = 0;
			out += ch;
		}
	}
	// Double the trailing backslash run so it stays literal before the closing
	// quote the caller appends.
	out += "\\".repeat(backslashes);
	return out;
}

/** Reject bytes that cannot round-trip through `cmd.exe`'s `/c` command line. */
function assertCmdBatchToken(value: string, kind: "command" | "argument"): void {
	// NUL/LF act as an end-of-command marker and CR is stripped, so any of them
	// would silently truncate or corrupt the launch.
	if (/[\0\r\n]/.test(value)) {
		throw new Error(`Windows batch MCP ${kind} cannot contain NUL, CR, or LF characters`);
	}
}

/**
 * Escape one argument for `cmd.exe`'s command-line pre-parse so a `.cmd`/`.bat`
 * shim receives it verbatim. Quotes only when the argument is empty, ends in a
 * backslash, or holds a byte outside {@link CMD_SAFE_ARG}; the quoted body is
 * escaped by {@link escapeCmdQuotedInterior}.
 *
 * @throws when the argument contains NUL, CR, or LF (see {@link assertCmdBatchToken}).
 */
function escapeCmdBatchArg(arg: string): string {
	assertCmdBatchToken(arg, "argument");
	const needsQuotes = arg.length === 0 || arg.endsWith("\\") || !CMD_SAFE_ARG.test(arg);
	// An unquoted arg is pure allow-list bytes (no `%`, `"`, or trailing `\`), so
	// it needs no interior escaping.
	return needsQuotes ? `"${escapeCmdQuotedInterior(arg)}"` : arg;
}

/**
 * Build the `cmd.exe` argv for a Windows `.cmd`/`.bat` (or unresolved bare)
 * MCP command.
 *
 * The trailing element is a single `/c` string wrapped in an outer quote pair
 * that `cmd.exe` strips (its opening-quote rule). The command token is always
 * quoted and, like every argument, escaped so a `%` in the resolved path (e.g.
 * `C:\work\%TOKEN%\server.cmd`) is not expanded before the shim launches.
 * `/e:ON` keeps command extensions on (required for the `%%cd:~,%` trick) and
 * `/v:OFF` disables delayed expansion. The result MUST be spawned with
 * `windowsVerbatimArguments` so libuv passes it through unmodified.
 */
function buildCmdExeArgv(comspec: string, command: string, args: readonly string[]): string[] {
	assertCmdBatchToken(command, "command");
	let line = `""${escapeCmdQuotedInterior(command)}"`;
	for (const arg of args) line += ` ${escapeCmdBatchArg(arg)}`;
	line += '"';
	return [comspec, "/d", "/e:ON", "/v:OFF", "/c", line];
}

/**
 * Resolve the subprocess argv used to launch an MCP stdio server.
 *
 * On Windows, our PATH/PATHEXT walk may return `null` for a bare command
 * (e.g. `npx`) — `Bun.env.PATH` empty under a restricted parent process,
 * UNC/network mounts that reject `fs.access`, locked-down shells. The
 * legacy fallback handed `Bun.spawn` the bare name, but `CreateProcess`
 * only appends `.exe` for extensionless names — `.cmd`/`.bat` are never
 * tried, so `npx` (which exists only as `npx.cmd` on Windows) crashes the
 * subprocess immediately. When the resolver can't pin the command down,
 * route through `cmd.exe` so Windows's own PATHEXT lookup runs.
 */
export async function resolveStdioSpawnCommand(
	config: MCPStdioServerConfig,
	options: ResolveStdioSpawnOptions,
): Promise<StdioSpawnCommand> {
	const args = config.args ?? [];
	if (options.platform !== "win32") return { cmd: [config.command, ...args], detached: options.platform !== "darwin" };

	const windowsHide = options.hostHasInheritableConsole === undefined ? true : !options.hostHasInheritableConsole;
	const resolved = await resolveWindowsCommandPath(config.command, options.cwd, options.env, options.signal);
	const resolvedCommand = resolved ?? config.command;
	const npmShimCommand = await resolveWindowsNpmShimCommand(resolvedCommand, args, options.cwd, windowsHide);
	if (npmShimCommand) return npmShimCommand;

	// Direct-spawn only when we resolved to a concrete file AND its extension
	// is not a batch script. Everything else (resolved .cmd/.bat, or an
	// unresolved extensionless command) goes through cmd.exe so PATHEXT runs.
	// Windows stdio servers stay attached so wrapper grandchildren inherit the
	// same console session. Only hide the child when OMP itself has no console
	// to share; CREATE_NO_WINDOW breaks console inheritance for nested wrappers.
	const detached = false;
	// A path-qualified command with no file behind it (bare or with a PATHEXT extension) can only fail
	// inside cmd.exe, whose "not recognized" stderr surfaces as an opaque early stdout EOF. Spawn it
	// directly so the launch fails with ENOENT naming the missing path, as it does on POSIX.
	if (
		resolved === null &&
		hasPathSegment(config.command) &&
		!(await fileExists(path.resolve(options.cwd, config.command)))
	) {
		return { cmd: [config.command, ...args], windowsHide, detached };
	}
	const needsCmdExe = resolved === null || isWindowsBatchCommand(resolvedCommand);
	if (!needsCmdExe) return { cmd: [resolvedCommand, ...args], windowsHide, detached };

	return {
		cmd: buildCmdExeArgv(resolveComSpec(options.env), resolvedCommand, args),
		windowsHide,
		detached,
		windowsVerbatimArguments: true,
	};
}

/** Minimal write surface of `Subprocess.stdin` we need for framed sends. */
interface FrameSink {
	write(chunk: string): unknown;
	flush(): unknown;
}

/**
 * Write a newline-delimited JSON-RPC frame to the subprocess's stdin sink,
 * swallowing both synchronous throws and asynchronous rejections so the caller
 * can decide how to react.
 *
 * Bun's `FileSink.write()`/`flush()` can fail two ways once the read end of the
 * pipe has been closed by a subprocess that exited between read-loop ticks:
 *   - a synchronous throw (most reliably observed on Windows), and
 *   - a *rejected Promise* returned from `write()`/`flush()`, i.e. the EPIPE is
 *     surfaced asynchronously (note the `processTicksAndRejections` frame in the
 *     stack traces on #1710 and the follow-up report).
 *
 * A sibling `async` method's `try/catch` only catches the synchronous case; an
 * un-awaited rejected Promise escapes as a fatal unhandled rejection. So we both
 * catch the throw and neutralize any returned promise's rejection.
 *
 * Returns `true` when the frame was accepted synchronously, `false` when the
 * sink threw — callers signal transport closure on `false`. An asynchronous
 * failure cannot be reflected in the return value; it is neutralized here and
 * the dead transport is detected by the read loop / request timeout instead.
 */
export function writeFrame(stdin: FrameSink, frame: string): boolean {
	try {
		const wrote = stdin.write(frame);
		if (isThenable(wrote)) wrote.then(undefined, () => {});
		const flushed = stdin.flush();
		if (isThenable(flushed)) flushed.then(undefined, () => {});
		return true;
	} catch {
		return false;
	}
}

/** Grace window to observe a cooperative exit after SIGTERM before escalating to SIGKILL. */
const TERM_GRACE_MS = 1000;
/** Grace window to observe SIGKILL taking effect before `close()` gives up and returns. */
const KILL_GRACE_MS = 500;
/**
 * The longest the transport waits for a subprocess to go away: `close()` gives
 * it {@link TERM_GRACE_MS} after SIGTERM and {@link KILL_GRACE_MS} after SIGKILL,
 * then returns whether or not it exited. When stdout ends, or a write finds the
 * pipe closed, the server is going away; from the first of those signs the
 * transport waits for its exit code and the rest of its stderr until one
 * deadline this far away, however many signs follow. Reporting why a server
 * died then never holds the transport open longer than closing it would, and a
 * request deadline cannot cut the wait short. This is the close bound, not a
 * request deadline: a request may have none (`timeout: 0`), while the close path
 * must always end.
 */
const CLOSE_DEADLINE_MS = TERM_GRACE_MS + KILL_GRACE_MS;
/** Longest stderr word the exit report shows; a longer one is never kept, only noted as omitted. */
const STDERR_WORD_MAX_CHARS = 256;
/** Characters of redacted stderr kept for the exit report. */
const STDERR_TAIL_CHARS = 16 * 1024;
/** Characters of trailing fetch hints kept when the buffer is cut: more than a report shows. */
const STDERR_HINT_KEEP_CHARS = 4 * 1024;
/** Words before the current one that redaction sees, enough for `Authorization: Bearer` and `api_key =`. */
const STDERR_CONTEXT_WORDS = 6;
/** End of each context word redaction sees: a label ends the word before its value. */
const STDERR_CONTEXT_WORD_CHARS = 64;

/**
 * The subset of `Subprocess` that termination needs. Decoupled from the
 * `Subprocess<In, Out, Err>` stdio generics — a connection's pipes are
 * irrelevant to signaling — so tests can exercise it against a plain
 * `Bun.spawn(cmd, { stdio: "ignore" })` child without fighting the generics.
 */
interface KillableSubprocess {
	readonly pid: number;
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Race `promise` against a timer. Resolves `true` once `promise` settles
 * within `timeoutMs`, `false` if the timer wins first. Resolving OR rejecting
 * both count as settled: for `Subprocess.exited` this mirrors `waitForExit()`
 * in `lsp/client.ts`, which treats the same ambiguity (Bun documents
 * `Subprocess.exited` as resolve-only, but a settle either way means there is
 * nothing left to wait on).
 *
 * The timer is always cleared before returning — win or lose — so a promise
 * that settles promptly never leaves a dangling `timeoutMs` timer holding the
 * event loop open behind it.
 */
async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	const { promise: timedOut, resolve: resolveTimedOut } = Promise.withResolvers<false>();
	const timer = setTimeout(() => resolveTimedOut(false), timeoutMs);
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			timedOut,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The last non-empty lines of `text`, at most `maxChars` characters in all.
 * A single last line longer than that keeps its end from the start of a word,
 * marked with `…`: cutting inside a word could leave a fragment that
 * {@link redactDiagnosticText} reads differently when the error is built.
 */
function lastLines(text: string, maxChars: number): string {
	const lines = text
		.split(/\r\n|\r|\n/)
		.map(line => line.trimEnd())
		.filter(line => line.trim().length > 0);
	let kept = "";
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		const joined = kept ? `${line}\n${kept}` : line;
		if (joined.length > maxChars) {
			if (kept) return kept;
			const from = line.length - (maxChars - 1);
			const wordStart = line.slice(from - 1).search(/\s\S/);
			return `…${line.slice(wordStart === -1 ? from : from + wordStart)}`;
		}
		kept = joined;
	}
	return kept;
}

/**
 * The end of a subprocess's stderr, kept in bounded memory for its exit report.
 *
 * Stderr can hold credentials, and {@link redactCredentials} finds a value
 * from its label (`api_key=`, `Bearer`), so nothing may be cut before
 * redaction has seen the label that precedes it. The tail therefore redacts
 * stderr as it arrives, one whole word at a time, and keeps only redacted
 * text, which can then be cut anywhere:
 *
 * - A whitespace run becomes one space, or one newline if it holds a line
 *   break (`\n` or `\r`). Redaction reads any whitespace run between a label
 *   and its value alike, so this hides nothing it would find, and it bounds
 *   the distance between them.
 * - Each word is redacted together with the words before it (the end of each,
 *   since a label ends the word before its value), with the real redactor.
 * - A word longer than {@link STDERR_WORD_MAX_CHARS} is never shown, only
 *   noted; its end still serves as context for the next word.
 */
class StderrTail {
	readonly #decoder = new TextDecoder();
	/** Redacted stderr, trimmed from the start to about {@link STDERR_TAIL_CHARS}. */
	#redacted = "";
	/** The words before the current one, each with the separator before it; see {@link STDERR_CONTEXT_WORDS}. */
	#context: string[] = [];
	/** Separator before the word being written: `""` at the start, else `" "` or `"\n"`. */
	#separator = "";
	/** Whether whitespace has been seen since the last word. */
	#inSpace = false;
	/** The word being written, while it is at most {@link STDERR_WORD_MAX_CHARS} long; then its end. */
	#word = "";
	#wordLength = 0;

	/** Add a chunk of stderr; a character split across chunks is decoded whole. */
	push(chunk: Uint8Array): void {
		this.#append(this.#decoder.decode(chunk, { stream: true }));
	}

	/** Stderr ended: an incomplete character still in the decoder becomes U+FFFD. */
	end(): void {
		this.#append(this.#decoder.decode());
		this.#finishWord();
	}

	/**
	 * The last lines of stderr with credential values redacted, at most
	 * `maxChars` characters; see {@link lastLines}.
	 */
	report(maxChars: number): string {
		const current = this.#wordLength > 0 ? this.#redactWord() : "";
		// Whole-text redaction again before choosing the tail: it also drops
		// runtime-only advice at the end (fetch's `verbose: true` hint, which may
		// end the word still being written), which the error removes anyway, so
		// the reason before it is not cut to make room.
		return lastLines(redactDiagnosticText(this.#redacted + current), maxChars);
	}

	#append(text: string): void {
		for (const [run] of text.matchAll(/\s+|\S+/g)) {
			if (/^\s/.test(run)) {
				this.#finishWord();
				if (!this.#inSpace) this.#separator = "";
				this.#inSpace = true;
				if (/[\r\n]/.test(run)) this.#separator = "\n";
				else if (this.#separator === "") this.#separator = " ";
				continue;
			}
			this.#inSpace = false;
			this.#wordLength += run.length;
			this.#word = (this.#word + run).slice(
				this.#wordLength <= STDERR_WORD_MAX_CHARS ? 0 : -STDERR_CONTEXT_WORD_CHARS,
			);
		}
	}

	/**
	 * The word being written as the report shows it, with the separator before
	 * it: redacted in the context of the words before it, or a note when too long.
	 */
	#redactWord(): string {
		const separator = this.#redacted === "" && this.#context.length === 0 ? "" : this.#separator;
		if (this.#wordLength > STDERR_WORD_MAX_CHARS) {
			return `${separator}[${this.#wordLength}-character word omitted]`;
		}
		const context = this.#context.join("");
		// Credentials only: the fetch hints go at report time, from the whole text.
		const before = redactCredentials(context);
		const after = redactCredentials(`${context}${separator}${this.#word}`);
		// The redactor rewrites only from a label onward and keeps the label, so
		// the context's own redaction is a prefix; anything else is redacted whole.
		return after.startsWith(before) ? after.slice(before.length) : `${separator}[redacted]`;
	}

	/**
	 * Cut the kept text back to about {@link STDERR_TAIL_CHARS}. Fetch hints at
	 * its end are kept apart from the text before them: the error drops trailing
	 * hints, so they must not push that text out of the buffer, and only the last
	 * {@link STDERR_HINT_KEEP_CHARS} of them are kept, whole, in case more text
	 * follows them.
	 */
	#trim(): void {
		const text = this.#redacted;
		const advice = trailingFetchAdvice(text);
		if (advice.start === text.length) {
			this.#redacted = text.slice(-STDERR_TAIL_CHARS);
			return;
		}
		const before = stripTrailingFetchAdvice(text);
		// Keep from the start of a complete hint: what follows it is then a run
		// of hints again, which the report removes whole.
		const keepFrom = advice.hints.find(start => text.length - start >= STDERR_HINT_KEEP_CHARS) ?? advice.start;
		const separator =
			keepFrom === advice.start ? text.slice(before.length, advice.start) : before.length > 0 ? "\n" : "";
		this.#redacted = before.slice(-STDERR_TAIL_CHARS) + separator + text.slice(keepFrom);
	}

	#finishWord(): void {
		if (this.#wordLength === 0) return;
		this.#redacted += this.#redactWord();
		if (this.#redacted.length > 2 * STDERR_TAIL_CHARS) this.#trim();
		const separator = this.#context.length === 0 ? "" : this.#separator;
		this.#context.push(`${separator}${this.#word.slice(-STDERR_CONTEXT_WORD_CHARS)}`);
		if (this.#context.length > STDERR_CONTEXT_WORDS) {
			this.#context.shift();
			// The oldest context word starts the context; drop its separator.
			this.#context[0] = this.#context[0]!.replace(/^\s/, "");
		}
		this.#word = "";
		this.#wordLength = 0;
		this.#separator = "";
		this.#inSpace = false;
	}
}

/** `true` when `error` is a Node errno exception carrying the given `code`. */
function isErrnoCode(error: unknown, code: string): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === code;
}

/**
 * Signal `signal` to `proc`. When `detached` is true on a POSIX platform,
 * targets the whole process group via the negative-pid convention
 * (`process.kill(-pid, signal)`) so a detached session leader's descendants —
 * not just the direct child — receive it too; a bare direct-child signal
 * never reaches grandchildren the child itself spawned.
 *
 * `ESRCH` from the group signal means the group is already gone — that is a
 * success (nothing left to signal), not a failure — so it does not fall
 * through. Any other group-signal failure (e.g. `EPERM`) falls back to
 * signaling the direct child as a last resort. Non-detached transports
 * (macOS, Windows, or POSIX where detach did not apply) always signal the
 * direct child only: a negative-pid signal outside a detached session could
 * hit an unrelated process group.
 */
function signalStdioProcess(
	proc: KillableSubprocess,
	detached: boolean,
	signal: NodeJS.Signals,
	platform: NodeJS.Platform,
): void {
	if (detached && platform !== "win32") {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch (error) {
			if (isErrnoCode(error, "ESRCH")) return;
			// Fall through to the direct-child signal below.
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// Already gone.
	}
}

/**
 * Terminate an MCP stdio subprocess: SIGTERM (process-group when `detached`
 * on POSIX, direct child otherwise), wait up to `termGraceMs` for a
 * cooperative exit, then escalate to SIGKILL — waiting up to `KILL_GRACE_MS`
 * more only when the leader itself hadn't already exited. A detached
 * leader's cooperative exit does not prove the whole process group is gone
 * (a grandchild can outlive it and ignore SIGTERM), so detached transports
 * always fire the group SIGKILL sweep, even after a clean SIGTERM exit.
 * Every step is a no-op-safe signal against an already-exited target, so
 * repeat calls (idempotent `close()`) never throw.
 *
 * Exported so tests can exercise group-signal escalation with an explicit
 * `detached`/`platform` pair: `StdioTransport.connect()` derives `detached`
 * from `resolveStdioSpawnCommand()`, which is tied to the host's real
 * `process.platform`, so a POSIX detached session cannot be reproduced
 * end-to-end through `connect()` on a non-Linux dev/CI host. `termGraceMs`
 * preserves the production grace by default while allowing those real
 * subprocess tests to cover the same transition without sleeping for a
 * production-length shutdown window.
 */
export async function terminateStdioProcess(
	proc: KillableSubprocess,
	detached: boolean,
	platform: NodeJS.Platform = process.platform,
	termGraceMs = TERM_GRACE_MS,
): Promise<void> {
	signalStdioProcess(proc, detached, "SIGTERM", platform);
	const exitedOnTerm = await settlesWithin(proc.exited, termGraceMs);
	// A non-detached transport has no process group beyond the leader itself:
	// once it exits, there is nothing left to signal. A detached transport's
	// leader exiting is NOT proof the group is empty — a grandchild it spawned
	// can still be alive and ignoring SIGTERM — so detached transports always
	// fall through to the group SIGKILL, even on a cooperative leader exit.
	if (exitedOnTerm && !detached) return;
	signalStdioProcess(proc, detached, "SIGKILL", platform);
	// Once the leader has already exited there is no further `exited` signal
	// to wait on for this call — the SIGKILL above is a fire-and-forget sweep
	// for any surviving group members — so only block on the grace window
	// when the leader itself is still the thing being escalated against.
	if (!exitedOnTerm) await settlesWithin(proc.exited, KILL_GRACE_MS);
}

/** A request written to a connection and not yet settled. */
interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	onProgress?: MCPRequestOptions["onProgress"];
}

/**
 * One spawned server process and all state that belongs to it. `connect()`
 * makes a new one each time, and every loop, report and close takes the
 * connection it was started for: nothing an old process does (its end of
 * output, its exit report, its stderr) can reach the requests or the report
 * of a connection opened after it.
 */
class StdioConnection {
	/** False once closed; its pending requests are then rejected and nothing is written to it. */
	open = true;
	/**
	 * True once stdout has ended. The close then rejects every pending request
	 * with the exit code and stderr within the close deadline, so a request
	 * deadline that expires meanwhile must not report a bare timeout.
	 */
	outputDone = false;
	/** Settles when the read loop stops reading stdout: end of output, a decode error, or close. */
	readonly outputEnded = Promise.withResolvers<void>();
	/**
	 * When the transport stops waiting to learn why the process went away
	 * (`performance.now()` time); set by the first sign of it, stdout ending or
	 * a failed write, so later signs share it. See {@link CLOSE_DEADLINE_MS}.
	 */
	closeDeadline: number | undefined;
	readonly pending = new Map<string | number, PendingRequest>();
	readonly stderr = new StderrTail();
	/** The stderr loop's reader; `close()` cancels it to end the loop's pending read. */
	stderrReader: { cancel(): Promise<void> } | undefined;
	stderrLoop: Promise<void> | undefined;
	readLoop: Promise<void> | undefined;

	constructor(
		readonly process: Subprocess<"pipe", "pipe", "pipe">,
		/**
		 * From `resolveStdioSpawnCommand()`'s `detached` flag. Gates process-group
		 * signaling in `close()`: only a process spawned into its own session may
		 * be signaled as a group.
		 */
		readonly detached: boolean,
	) {}

	/** Milliseconds left until the close deadline, which this call starts if no sign of the exit came before. */
	untilCloseDeadline(): number {
		this.closeDeadline ??= performance.now() + CLOSE_DEADLINE_MS;
		return Math.max(0, this.closeDeadline - performance.now());
	}
}

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
export class StdioTransport implements MCPTransport {
	/** The process spawned by the last `connect()`, until `close()`. */
	#connection: StdioConnection | null = null;
	readonly #requestIds = new RequestIdAllocator();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connection?.open ?? false;
	}

	get outputEnded(): boolean {
		return this.#connection?.outputDone ?? false;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (this.#connection?.open) return;

		const env = {
			...Bun.env,
			...this.config.env,
		};
		const cwd = this.config.cwd ?? getProjectDir();
		const spawnCommand = await resolveStdioSpawnCommand(this.config, {
			cwd,
			env,
			platform: process.platform,
			hostHasInheritableConsole: hostHasInheritableConsole(),
			signal,
		});
		// Resolution may outlast the connection deadline, especially on Windows PATHs.
		signal?.throwIfAborted();

		// Platform-derived session and console-window handling come from
		// `resolveStdioSpawnCommand`: Linux/other POSIX detach into their own
		// session to escape terminal job-control signals (SIGTSTP, SIGTTIN);
		// macOS stays attached so TCC can prompt for Apple Events automation;
		// Windows stays attached, and only hides the child when the host has no
		// console to share. See `StdioSpawnCommand`.
		// Keep this on Bun's argv-first overload. The eval JS kernel path that
		// triggers macOS Apple Events TCC prompts uses the same shape; the
		// one-object `{ cmd }` overload timed out before prompting for `mcpbridge`
		// even with `detached: false` (#5085).
		const child = Bun.spawn(spawnCommand.cmd, {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: spawnCommand.windowsHide,
			detached: spawnCommand.detached,
			windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
		});
		const connection = new StdioConnection(child, spawnCommand.detached);
		this.#connection = connection;

		// Keep the end of stderr before reading stdout: when stdout ends early,
		// the EOF error reports what the server printed there.
		connection.stderrLoop = this.#readStderr(connection);
		connection.readLoop = this.#readStdout(connection);
	}

	async #readStdout(connection: StdioConnection): Promise<void> {
		let closeError: MCPTransportError | undefined;
		try {
			for await (const line of readJsonl(connection.process.stdout)) {
				if (!connection.open) break;
				try {
					this.#handleMessage(connection, line as JsonRpcMessage);
				} catch {
					// Skip malformed message shapes; malformed JSON is handled by readJsonl.
				}
			}
		} catch (error) {
			closeError = normalizeMCPTransportError(error, {
				transport: "stdio",
				stage: error instanceof SyntaxError ? "decode" : "receive",
			});
			if (connection.open) {
				this.onError?.(closeError);
			}
		} finally {
			connection.outputDone = true;
			connection.outputEnded.resolve();
			if (connection.open && closeError === undefined) {
				closeError = await this.#endOfOutputError(connection);
			}
			this.#handleClose(connection, closeError);
		}
	}

	/**
	 * The error for stdout ending while connected. A server that exits before
	 * answering (a credential wrapper refusing a secret, a missing runtime)
	 * says why on stderr, and its exit code is rarely reaped yet when stdout
	 * ends, so wait for both, up to the close deadline, before reporting. The
	 * message budgets the summary first and gives stderr the rest, keeping its
	 * end, where the reason is.
	 */
	async #endOfOutputError(connection: StdioConnection): Promise<MCPTransportError> {
		const { process: child } = connection;
		await settlesWithin(Promise.allSettled([child.exited, connection.stderrLoop]), connection.untilCloseDeadline());
		const exitCode = child.exitCode;
		const summary =
			exitCode === null
				? "MCP subprocess closed stdout before responding"
				: `MCP subprocess exited with code ${exitCode} before responding`;
		const reason = connection.stderr.report(MCP_ERROR_MESSAGE_MAX_CHARS - summary.length - ": ".length);
		return new MCPTransportError({
			transport: "stdio",
			stage: "receive",
			failure: "eof",
			message: reason ? `${summary}: ${reason}` : summary,
			retryable: false,
			code: exitCode ?? undefined,
		});
	}

	async #readStderr(connection: StdioConnection): Promise<void> {
		const reader = connection.process.stderr.getReader();
		connection.stderrReader = reader;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				// Servers log to stderr, so it is no error by itself (the MCP spec
				// lets clients capture or ignore it); only its end is kept.
				connection.stderr.push(value);
			}
		} catch {
			// A read error ends stderr like its end of file.
		} finally {
			connection.stderr.end();
			reader.releaseLock();
		}
	}

	#handleMessage(connection: StdioConnection, message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(connection, m);
			return;
		}
		// Server-to-client request: has both method and id
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(connection, message as JsonRpcRequest);
			return;
		}

		// Response to our request: has id
		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const pending = connection.pending.get(response.id);
			if (pending) {
				if (response.error) {
					pending.reject(createMCPJsonRpcError("stdio", response.error));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		// Notification: has method but no id
		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			routeProgressNotification(
				notification.method,
				notification.params,
				token => connection.pending.get(token)?.onProgress,
			);
			this.onNotification?.(notification.method, notification.params);
		}
	}

	async #handleServerRequest(connection: StdioConnection, request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				this.#sendResponse(connection, request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			this.#sendResponse(connection, request.id, result);
		} catch (error) {
			this.#sendResponse(connection, request.id, undefined, toJsonRpcError(error));
		}
	}

	#sendResponse(connection: StdioConnection, id: string | number, result?: unknown, error?: JsonRpcError): void {
		if (!connection.open) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		// Silent on failure — a dead subprocess has no use for the response,
		// and the read loop will close the transport on EOF.
		writeFrame(connection.process.stdin, `${JSON.stringify(response)}\n`);
	}

	#handleClose(connection: StdioConnection, error?: MCPTransportError): void {
		if (!connection.open) return;
		connection.open = false;

		const closeError = error
			? nonRetryableMCPTransportError(error)
			: new MCPTransportError({
					transport: "stdio",
					stage: "receive",
					failure: "closed",
					message: "Transport closed",
					retryable: false,
				});
		// request() records and writes each frame synchronously. A request whose
		// write failed stays pending for a bounded wait to learn why (`failFromSend`
		// in request()); when the close comes first, the subprocess is gone and must
		// not be relaunched to replay it, so every remaining request gets the
		// non-retryable close error.
		for (const pending of connection.pending.values()) {
			pending.reject(closeError);
		}

		this.onClose?.();
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		const connection = this.#connection;
		if (!connection?.open) {
			throw new MCPTransportError({
				transport: "stdio",
				stage: "connect",
				failure: "closed",
				message: "Transport not connected",
				retryable: true,
			});
		}

		const id = this.#requestIds.next(this.config.requestIdFormat);
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: options?.onProgress ? withProgressToken(params, id) : (params ?? {}),
		};

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const signal = options?.signal;

		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const stdin = connection.process.stdin;
		const message = `${JSON.stringify(request)}\n`;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		let sent = false;

		const settle = (error?: Error, value?: unknown): boolean => {
			if (settled) return false;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			connection.pending.delete(id);
			if (error) reject(error);
			else resolve(value as T);
			return true;
		};

		const sendCancellation = (reason: string) => {
			if (!sent || method === "initialize" || !connection.open) return;
			writeFrame(
				stdin,
				`${JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, reason },
				})}\n`,
			);
		};

		// An abort is the caller giving up on the request, not a deadline: it settles
		// the request at once, even while the transport is still collecting the exit
		// report that would otherwise reject it.
		const onAbort = () => {
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			if (settle(reason)) sendCancellation("Request cancelled by the client");
		};

		connection.pending.set(id, {
			onProgress: options?.onProgress,
			resolve: (value: unknown) => {
				settle(undefined, value);
			},
			reject: (error: Error) => {
				settle(error);
			},
		});

		if (isMCPTimeoutEnabled(timeout)) {
			timer = setTimeout(() => {
				// Stdout already ended: the close is about to reject this request with the
				// server's exit code and stderr, which say more than a timeout would.
				if (connection.outputDone) return;
				if (
					settle(
						new MCPTransportError({
							transport: "stdio",
							stage: "receive",
							failure: "timeout",
							message: `Request timeout after ${timeout}ms`,
							retryable: false,
						}),
					)
				) {
					sendCancellation(`Request timed out after ${timeout}ms`);
				}
			}, timeout);
		}

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const failFromSend = (error: unknown) => {
			if (settled) return;
			const normalized = normalizeMCPTransportError(error, { transport: "stdio", stage: "send" });
			const sendError = sent ? nonRetryableMCPTransportError(normalized) : normalized;
			// A write fails when the subprocess has closed its stdin, usually by exiting.
			// If its stdout ends too, the read loop closes the transport and rejects this
			// request with the exit code and stderr, which say why; the bare write error
			// is reported only when stdout stays open past the close deadline, which the
			// failed write starts unless an earlier sign of the exit did. That wait
			// replaces the request deadline, so a deadline cannot preempt the diagnosis.
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			void settlesWithin(connection.outputEnded.promise, connection.untilCloseDeadline()).then(ended => {
				if (!ended) settle(sendError);
			});
		};
		try {
			// Never `await` write/flush. Bun's FileSink returns a pending Promise
			// once the OS pipe buffer fills (default ~64 KB on POSIX), and a
			// subprocess that stops draining stdin will park those awaits forever.
			// Awaiting here would keep the async fn stuck above `return promise`,
			// past the timeout timer and the abort handler, orphaning the deferred
			// rejection and hanging the caller (#3945). Route sync throws (Windows
			// EPIPE) and async rejections (POSIX EPIPE on processTicksAndRejections)
			// into `failFromSend()` while leaving the returned promise free to settle
			// from the response, timer, abort signal, or read-loop transport-close.
			const wrote = stdin.write(message);
			sent = true;
			if (isThenable(wrote)) wrote.then(undefined, failFromSend);
			const flushed = stdin.flush();
			if (isThenable(flushed)) flushed.then(undefined, failFromSend);
		} catch (error) {
			failFromSend(error);
		}

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		const connection = this.#connection;
		if (!connection?.open) {
			throw new MCPTransportError({
				transport: "stdio",
				stage: "connect",
				failure: "closed",
				message: "Transport not connected",
				retryable: true,
			});
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		// Bun's FileSink can throw EPIPE synchronously on Windows when the
		// subprocess has exited between the last read-loop tick and this
		// write (e.g. an MCP server that dies after returning `initialize`
		// but before `notifications/initialized` is delivered). Tear the
		// transport down so any wired `onClose` (and reconnect machinery)
		// engages, then surface the failure to the caller so a write that
		// dropped on the floor is never silently treated as delivered —
		// `initializeConnection()` runs before the manager installs its
		// `onClose` handler, so a swallowed failure there would yield a
		// "connected" handle wrapping a dead transport. See #1710.
		if (!writeFrame(connection.process.stdin, `${JSON.stringify(notification)}\n`)) {
			const error = new MCPTransportError({
				transport: "stdio",
				stage: "send",
				failure: "eof",
				message: `Transport closed while sending notification "${method}"`,
				retryable: true,
			});
			this.#handleClose(connection, error);
			throw error;
		}
	}

	async close(): Promise<void> {
		// `close()` is the authoritative resource teardown. `#handleClose()`
		// may have already run (read-loop EOF, or a notify() write failure
		// that surfaces the dead transport to the caller) — but the subprocess
		// and its pipes are still held in that path, so we MUST keep cleaning
		// up regardless. Take the connection and clear the field before any
		// `await`, so a concurrent/repeat `close()` finds nothing left to do.
		const connection = this.#connection;
		if (!connection) return;
		this.#connection = null;
		this.#handleClose(connection);

		// 1. Cooperative EOF first: a well-behaved server sees stdin close
		// and can exit on its own before any signal is sent. Guarded — the
		// sink can throw if the pipe is already closed/dead (e.g. the child
		// already exited and the read loop got there first).
		try {
			connection.process.stdin.end();
		} catch {
			// Already closed/dead.
		}

		// 2-3. Group-aware SIGTERM (when this transport actually spawned
		// detached), bounded wait, then escalate to SIGKILL. See
		// `terminateStdioProcess` for the exact signaling/escalation rules.
		await terminateStdioProcess(connection.process, connection.detached);

		// 4. Stop reading stderr: a descendant can hold the pipe open long after
		// the server is gone, and nothing reads this connection's report now.
		// Cancelling ends the stderr loop's pending read.
		connection.stderrReader?.cancel().catch(() => {});
		connection.stderrLoop?.catch(() => {});
		// Do not block/await the read loop as it can hang indefinitely in some environments
		connection.readLoop?.catch(() => {});
	}
}

/**
 * Create and connect a stdio transport.
 */
export async function createStdioTransport(
	config: MCPStdioServerConfig,
	signal?: AbortSignal,
): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	try {
		await transport.connect(signal);
		return transport;
	} catch (error) {
		throw normalizeMCPTransportError(error, { transport: "stdio", stage: "connect" });
	}
}
