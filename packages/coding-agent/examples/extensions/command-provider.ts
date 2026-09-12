/**
 * Command-Backed Provider Extension
 *
 * Registers a provider whose transport is a local command instead of an HTTP
 * endpoint: one child process per request, JSONL on stdout, assistant text
 * streamed back into OMP. The preset below runs `muse exec --json`, which is
 * how a Muse Code plan can be used from OMP — the CLI authenticates with its
 * own subscription, while the same model reached through a Meta API key bills
 * per token even for an account that already pays for a plan. Any local CLI or
 * stdio service that emits incremental JSONL works the same way.
 *
 * Features:
 * - maps OMP thinking levels onto the command's own effort flag
 * - hands the prompt to the child through its prompt-file flag, so prompt size
 *   is bounded by the filesystem instead of the OS command line (32767
 *   characters on Windows) and prompt text never appears in a process listing;
 *   `promptTransport: "argv"` covers commands that only take a positional
 *   prompt
 * - seeds the child conversation with the retained context when a session id
 *   is new to this process, so switching models or forking a session does not
 *   drop the transcript, then sends only the new turn
 * - spawns one child per request and streams its output as canonical assistant
 *   events, with `options.signal`, `options.cwd`, and `options.sessionId`
 *   forwarded. The canonical `AssistantMessageEventStream` settles `result()`
 *   with the error message for a terminal failure rather than rejecting, which
 *   is what the agent loop reads back after observing the error event
 * - builds the child environment from an allowlist: platform basics, proxy/TLS
 *   settings, XDG locations, and the child's own MUSE_* switches. OMP's
 *   provider keys are never inherited, so the child authenticates the way it
 *   normally does on this machine (for Muse: its own login/session)
 * - gives every provider its own API id: custom APIs live in one global
 *   registry keyed by id, so a shared default would let a second command
 *   provider take over the first one's requests
 * - keeps a hung command from wedging a turn (timeout), turns a non-zero exit
 *   into an error event, and kills the child when the request is aborted
 * - refuses unusable Windows batch shims: the Muse installer ships `muse.cmd`
 *   next to `muse-bin-<version>.exe`, and cmd.exe re-parses anything handed to
 *   the shim, so the versioned executable named by `.muse-version` is used
 *
 * Usage:
 * 1. Copy this file to ~/.omp/agent/extensions/, or load it with
 *    `omp --extension packages/coding-agent/examples/extensions/command-provider.ts`
 * 2. Select `muse-exec/muse-exec` with /model
 * 3. Override the preset without editing it: MUSE_EXEC_COMMAND,
 *    MUSE_EXEC_ARGS (a JSON string array, or whitespace-separated),
 *    MUSE_OMP_PROVIDER, MUSE_OMP_MODEL
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Context, Effort, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Prefix for the API id a command provider registers under. */
export const COMMAND_PROVIDER_API = "command-subprocess-api";

/**
 * Custom API ids are global: `registerCustomApi()` keeps one stream handler per
 * id, so two command providers sharing an id would run the second provider's
 * command for the first provider's models.
 */
export function commandProviderApiId(providerName: string): Api {
	return `${COMMAND_PROVIDER_API}:${providerName}` as Api;
}

/** Efforts offered for command-backed models, least to most intensive. */
export const COMMAND_PROVIDER_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Muse `--reasoning-effort` accepts the OMP effort vocabulary 1:1 (plus none/ultra). */
const MUSE_REASONING_EFFORTS: ReadonlySet<string> = new Set([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);

/**
 * Resolve the Muse reasoning effort for one request. The OMP thinking level
 * maps 1:1 onto `muse exec --reasoning-effort`; requests without a level run
 * at max, and thinking-off utility calls run at none.
 */
export function resolveReasoningEffort(options?: SimpleStreamOptions): string {
	if (options?.disableReasoning) return "none";
	const effort = options?.reasoning as string | undefined;
	if (effort && MUSE_REASONING_EFFORTS.has(effort)) return effort;
	return "max";
}

/** Child sessions this process has already seeded, oldest first. */
const seededSessions = new Set<string>();
const SEEDED_SESSION_LIMIT = 64;

/**
 * Mark a child session as seeded. Returns true when the id had not been seen
 * yet, which is exactly when the child has no conversation to continue.
 */
export function markSessionSeeded(sessionId: string): boolean {
	if (seededSessions.has(sessionId)) return false;
	seededSessions.add(sessionId);
	if (seededSessions.size > SEEDED_SESSION_LIMIT) {
		const oldest = seededSessions.values().next().value;
		if (oldest !== undefined) seededSessions.delete(oldest);
	}
	return true;
}

export interface CommandProviderConfig {
	providerName: string;
	/** API id override. Defaults to {@link commandProviderApiId}; keep it unique per provider. */
	api?: Api;
	modelId: string;
	modelName?: string;
	/** Command to run. Resolved against PATH; Windows batch shims are replaced by the executable they launch. */
	command?: string;
	commandArgs?: readonly string[];
	/** Build the arguments after `command`, excluding the prompt. */
	buildArgs?: (input: {
		sessionId: string;
		cwd: string;
		prompt: string;
		promptPath: string;
		model: Model<Api>;
		effort: string;
	}) => readonly string[];
	/**
	 * How the prompt reaches the child. `prompt-file` (default) writes it to a
	 * temp file and appends {@link CommandProviderConfig.promptFileArgs}; `argv`
	 * appends the prompt itself as the last argument.
	 */
	promptTransport?: "prompt-file" | "argv";
	/** Arguments that hand the temp prompt file to the command. Default `--prompt-file <path>`. */
	promptFileArgs?: (promptPath: string) => readonly string[];
	/** Resolve the real executable a Windows batch shim launches; returning undefined reports the shim as unusable. */
	shimExecutable?: (shimPath: string) => Promise<string | undefined>;
	/** Extract a text delta from one decoded JSONL record. */
	extractText?: (record: unknown, state: { emittedText: string }) => string | undefined;
	/** Extract a readable terminal failure from one decoded JSONL record. */
	extractError?: (record: unknown) => string | undefined;
	/** Convert OMP context into the prompt for one incremental turn. */
	formatPrompt?: (context: Context) => string;
	/** Serialize the retained context sent to a child session that has no history yet. */
	formatSeed?: (context: Context) => string;
	/** Seed a new child session with the retained context instead of only the new turn. Default true. */
	seedContextOnNewSession?: boolean;
	/** Resolve the child working directory. Defaults to OMP's request cwd or process.cwd(). */
	cwd?: string | ((options: SimpleStreamOptions | undefined) => string | undefined);
	/** Extra child environment values; `undefined` removes an allowlisted key. */
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

interface JsonRecord {
	payload?: { kind?: string; text?: string; reason?: string; terminal?: string };
}

function textFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (typeof block !== "object" || block === null) return "";
			const value = block as { type?: string; text?: unknown; thinking?: unknown };
			if (value.type === "text" && typeof value.text === "string") return value.text;
			if (value.type === "thinking" && typeof value.thinking === "string") return value.thinking;
			return "";
		})
		.filter(Boolean)
		.join("");
}

/** Default context policy: Muse keeps the conversation; send only the new user turn. */
export function latestUserPrompt(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role === "user") {
			const prompt = textFromMessageContent(message.content).trim();
			if (prompt) return prompt;
		}
	}
	throw new Error("The command provider received a context without a user prompt.");
}

/** Default seed for a child session with no history: system prompt plus every retained turn. */
export function formatContextSeed(context: Context): string {
	const sections = (context.systemPrompt ?? []).map(prompt => `[system]\n${prompt}`);
	for (const message of context.messages) {
		const text = textFromMessageContent(message.content).trim();
		if (text) sections.push(`[${message.role}]\n${text}`);
	}
	return sections.join("\n\n");
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function buildMessage(model: Model<Api>, text: string, startedAt: number): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: startedAt,
	};
}

function defaultMuseText(record: unknown, state: { emittedText: string }): string | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const payload = (record as JsonRecord).payload;
	if (payload?.kind === "run_output_delta" && typeof payload.text === "string") return payload.text;
	if (payload?.kind === "run_terminal" && state.emittedText.length === 0 && typeof payload.text === "string") {
		return payload.text;
	}
	return undefined;
}

function defaultMuseError(record: unknown): string | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const payload = (record as JsonRecord).payload;
	if (payload?.kind !== "run_terminal" || payload.terminal === "completed") return undefined;
	return payload.reason || `Muse run terminated with status ${payload.terminal || "unknown"}.`;
}

/** Read a stdout stream line by line; the child's JSONL framing is part of its protocol. */
function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
	return (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) onLine(line);
		}
		buffer += decoder.decode();
		if (buffer.trim()) onLine(buffer);
	})();
}

/**
 * The only parent environment the child command may inherit. The child gets
 * platform basics (so it can spawn helpers, resolve its own config, and write
 * temp files) plus proxy/TLS settings; every other parent variable - model API
 * keys, Cloudflare tokens, 1Password sessions, CI variables - stays inside the
 * OMP process. Secrets must be opted in through `config.env`, never inherited.
 */
const INHERITED_ENVIRONMENT_KEYS = [
	// POSIX runtime
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	// Windows runtime
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
	"SystemDrive",
	"SystemRoot",
	"windir",
	"ComSpec",
	"PATHEXT",
	"PSModulePath",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"COMMONPROGRAMFILES",
	"USERNAME",
	"USERDOMAIN",
	"HOMEDRIVE",
	"HOMEPATH",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"NUMBER_OF_PROCESSORS",
	"SESSIONNAME",
	// Network and TLS, for headless runs behind a proxy or a private CA
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	// XDG locations, so the child finds its own config, state, and cache
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

/** The child's own MUSE_* switches are the one prefix that passes through. */
const INHERITED_ENVIRONMENT_PREFIX = "MUSE_";

export function childEnvironment(overrides: Record<string, string | undefined> | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of INHERITED_ENVIRONMENT_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key.startsWith(INHERITED_ENVIRONMENT_PREFIX)) env[key] = value;
	}
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

/** Windows batch shims re-parse arguments through cmd.exe and cannot take the prompt. */
const BATCH_SHIM_SUFFIXES = [".cmd", ".bat"];

/**
 * Muse installs `muse.cmd` next to `muse-bin-<version>.exe` and records the
 * active version in `.muse-version`, so the shim's own target is resolvable
 * without running cmd.exe.
 */
export async function museShimExecutable(shimPath: string): Promise<string | undefined> {
	const directory = path.dirname(shimPath);
	const version = await Bun.file(path.join(directory, ".muse-version"))
		.text()
		.catch(() => "");
	const trimmed = version.trim();
	if (!trimmed) return undefined;
	const executable = path.join(directory, `muse-bin-${trimmed}.exe`);
	return (await Bun.file(executable).exists()) ? executable : undefined;
}

/**
 * Resolve a command against PATH. A Windows batch shim is never returned: it
 * cannot receive the prompt safely, so the executable it launches is used
 * instead, and an unresolvable shim is reported rather than spawned.
 */
export async function resolveCommandPath(
	command: string,
	environment: Record<string, string | undefined>,
	shimExecutable: (shimPath: string) => Promise<string | undefined> = museShimExecutable,
): Promise<string> {
	const resolved = Bun.which(command, { PATH: environment.PATH ?? process.env.PATH });
	if (!resolved) {
		throw new Error(`Command provider cannot find "${command}" on PATH; set the command explicitly.`);
	}
	if (!BATCH_SHIM_SUFFIXES.some(suffix => resolved.toLowerCase().endsWith(suffix))) return resolved;
	const executable = await shimExecutable(resolved);
	if (executable) return executable;
	throw new Error(
		`"${command}" resolves to the Windows batch shim ${resolved}, which cannot receive the prompt; point the command at the executable it launches.`,
	);
}

function abortProcess(processHandle: Bun.Subprocess<"pipe", "pipe", "pipe">): void {
	try {
		processHandle.kill();
	} catch {
		// The process may have exited between the abort and kill calls.
	}
}

/** Parse `MUSE_EXEC_ARGS`: a JSON string array, otherwise whitespace-separated. */
export function parseCommandArgs(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed: unknown = JSON.parse(trimmed);
		if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
			throw new Error("Command arguments must be a JSON array of strings.");
		}
		return parsed;
	}
	return trimmed.split(/\s+/);
}

/** Write the prompt to a temp file the child reads by path. */
async function writePromptFile(prompt: string): Promise<string> {
	const file = path.join(os.tmpdir(), `omp-command-prompt-${crypto.randomUUID()}.txt`);
	await Bun.write(file, prompt);
	return file;
}

export interface DefaultCommandArgsInput {
	sessionId: string;
	cwd: string;
	prompt: string;
	effort: string;
	transport?: "prompt-file" | "argv";
	promptPath?: string;
	promptFileArgs?: (promptPath: string) => readonly string[];
	commandArgs?: readonly string[];
}

/** Default `muse exec` argument layout, with the resolved reasoning effort pinned. */
export function buildDefaultArgs(input: DefaultCommandArgsInput): string[] {
	const transport = input.transport ?? "prompt-file";
	const promptArgs =
		transport === "argv"
			? [input.prompt]
			: (input.promptFileArgs ?? ((promptPath: string) => ["--prompt-file", promptPath]))(input.promptPath ?? "");
	return [
		"exec",
		"--json",
		"--session-id",
		input.sessionId,
		"--workspace",
		input.cwd,
		"--reasoning-effort",
		input.effort,
		...promptArgs,
		...(input.commandArgs ?? []),
	];
}

export function createCommandStreamSimple(config: CommandProviderConfig) {
	const command = config.command ?? "muse";
	const transport = config.promptTransport ?? "prompt-file";
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = new AssistantMessageEventStream();
		const startedAt = Date.now();
		const partial = buildMessage(model, "", startedAt);
		stream.push({ type: "start", partial });

		void (async () => {
			let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
			let promptPath: string | undefined;
			let emittedText = "";
			let textStarted = false;
			let terminalError: string | undefined;
			let malformedOutput: string | undefined;
			const state = {
				get emittedText() {
					return emittedText;
				},
			};
			const extractText = config.extractText ?? defaultMuseText;
			const extractError = config.extractError ?? defaultMuseError;
			const timeoutMs = config.timeoutMs ?? 15 * 60 * 1000;
			const abortHandler = () => {
				if (child) abortProcess(child);
			};

			try {
				if (options?.signal?.aborted) throw new Error("Command provider request was aborted.");
				const configuredCwd = typeof config.cwd === "function" ? config.cwd(options) : config.cwd;
				const workingDirectory = options?.cwd ?? configuredCwd ?? process.cwd();
				const sessionId = options?.sessionId ?? crypto.randomUUID();
				const seed =
					(config.seedContextOnNewSession ?? true) && markSessionSeeded(sessionId)
						? (config.formatSeed ?? formatContextSeed)(context)
						: undefined;
				const prompt = seed ?? (config.formatPrompt ?? latestUserPrompt)(context);
				const effort = resolveReasoningEffort(options);
				const environment = childEnvironment(config.env);
				const executable = await resolveCommandPath(
					command,
					environment,
					config.shimExecutable ?? museShimExecutable,
				);
				if (transport === "prompt-file") promptPath = await writePromptFile(prompt);
				const args = config.buildArgs
					? [
							...config.buildArgs({
								sessionId,
								cwd: workingDirectory,
								prompt,
								promptPath: promptPath ?? "",
								model,
								effort,
							}),
						]
					: buildDefaultArgs({
							sessionId,
							cwd: workingDirectory,
							prompt,
							effort,
							transport,
							promptPath,
							promptFileArgs: config.promptFileArgs,
							commandArgs: config.commandArgs,
						});

				child = Bun.spawn([executable, ...args], {
					cwd: workingDirectory,
					env: environment,
					stdout: "pipe",
					stderr: "pipe",
				});
				options?.signal?.addEventListener("abort", abortHandler, { once: true });

				const stderrPromise = new Response(child.stderr).text();
				const stdoutPromise = readLines(child.stdout, line => {
					let record: unknown;
					try {
						record = JSON.parse(line);
					} catch {
						malformedOutput ??= line.slice(0, 500);
						return;
					}
					terminalError ??= extractError(record);
					const delta = extractText(record, state);
					if (!delta) return;
					if (!textStarted) {
						textStarted = true;
						partial.content = [{ type: "text", text: "" }];
						stream.push({ type: "text_start", contentIndex: 0, partial });
					}
					emittedText += delta;
					partial.content = [{ type: "text", text: emittedText }];
					stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
				});

				const timeout = Promise.withResolvers<number>();
				const timeoutHandle: Bun.Timer = setTimeout(
					() => timeout.reject(new Error(`Command timed out after ${timeoutMs} ms.`)),
					timeoutMs,
				);
				try {
					const exitCode = await Promise.race([child.exited, timeout.promise]);
					await stdoutPromise;
					const stderr = (await stderrPromise).trim();
					if (options?.signal?.aborted) throw new Error("Command provider request was aborted.");
					if (exitCode !== 0) {
						throw new Error(
							terminalError || stderr || malformedOutput || `${command} exited with code ${exitCode}.`,
						);
					}
					if (terminalError) throw new Error(terminalError);
					if (textStarted) {
						partial.content = [{ type: "text", text: emittedText }];
						stream.push({ type: "text_end", contentIndex: 0, content: emittedText, partial });
					}
					stream.push({ type: "done", reason: "stop", message: partial });
				} finally {
					clearTimeout(timeoutHandle);
				}
			} catch (error) {
				if (child) abortProcess(child);
				const message = error instanceof Error ? error.message : String(error);
				const errorMessage = { ...partial, stopReason: "error" as const, errorMessage: message };
				stream.push({ type: "error", reason: "error", error: errorMessage });
			} finally {
				options?.signal?.removeEventListener("abort", abortHandler);
				if (promptPath) await fs.promises.rm(promptPath, { force: true }).catch(() => {});
			}
		})();
		return stream;
	};
}

export function registerCommandProvider(pi: ExtensionAPI, config: CommandProviderConfig): void {
	const api = config.api ?? commandProviderApiId(config.providerName);
	const reasoning = config.reasoning ?? true;
	pi.registerProvider(config.providerName, {
		baseUrl: "https://command-provider.invalid/",
		api,
		apiKey: "command-provider-does-not-use-an-api-key",
		streamSimple: createCommandStreamSimple({ ...config, api }),
		models: [
			{
				id: config.modelId,
				name: config.modelName ?? config.modelId,
				reasoning,
				...(reasoning
					? {
							thinking: {
								mode: "effort",
								efforts: [...COMMAND_PROVIDER_EFFORTS] as Effort[],
								defaultLevel: "max" as Effort,
							},
						}
					: {}),
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: config.contextWindow ?? 200_000,
				maxTokens: config.maxTokens ?? 32_000,
			},
		],
	});
}

export default function museExecProvider(pi: ExtensionAPI): void {
	registerCommandProvider(pi, {
		providerName: process.env.MUSE_OMP_PROVIDER ?? "muse-exec",
		modelId: process.env.MUSE_OMP_MODEL ?? "muse-exec",
		modelName: "Muse Code via muse exec",
		command: process.env.MUSE_EXEC_COMMAND ?? "muse",
		commandArgs: process.env.MUSE_EXEC_ARGS ? parseCommandArgs(process.env.MUSE_EXEC_ARGS) : [],
		// Keep this a Muse session: Muse owns the inner read/write/bash/web loop.
		// OMP receives only the final text stream. The child environment is
		// allowlisted, so OMP's PAYG keys cannot leak in; META_API_KEY is pinned
		// absent as a second guard.
		env: { META_API_KEY: undefined },
	});
}
