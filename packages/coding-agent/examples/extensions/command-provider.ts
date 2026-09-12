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
 * - spawns one child per request and streams its output as canonical assistant
 *   events, with `options.signal`, `options.cwd`, and `options.sessionId`
 *   forwarded so cancellation, the working directory, and one child
 *   conversation per stable session id all behave
 * - builds the child environment from an allowlist: platform basics, proxy/TLS
 *   settings, XDG locations, and the child's own MUSE_* switches. OMP's
 *   provider keys are never inherited, so the child authenticates the way it
 *   normally does on this machine (for Muse: its own login/session)
 * - converts a hung command into a timeout and a non-zero exit into a stream
 *   error instead of an empty success
 *
 * Usage:
 * 1. Copy this file to ~/.omp/agent/extensions/, or load it with
 *    `omp --extension packages/coding-agent/examples/extensions/command-provider.ts`
 * 2. Select `muse-exec/muse-exec` with /model
 * 3. Override the preset without editing it: MUSE_EXEC_COMMAND,
 *    MUSE_EXEC_ARGS, MUSE_OMP_PROVIDER, MUSE_OMP_MODEL
 *
 * On Windows the Muse installer only puts `muse.cmd` on PATH, and Bun refuses
 * to hand prompt text to a batch shim (cmd.exe would re-parse quotes, `&`, and
 * `<`). Point MUSE_EXEC_COMMAND at the versioned `muse-bin-<version>.exe` the
 * shim itself selects.
 */
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Effort,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const COMMAND_PROVIDER_API = "command-subprocess-api" as Api;

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

export interface CommandProviderConfig {
	providerName: string;
	api?: Api;
	modelId: string;
	modelName?: string;
	command?: string;
	commandArgs?: readonly string[];
	/** Build the command arguments after the configured prefix. */
	buildArgs?: (input: {
		sessionId: string;
		cwd: string;
		prompt: string;
		model: Model<Api>;
		effort: string;
	}) => readonly string[];
	/** Extract a text delta from one decoded JSONL record. */
	extractText?: (record: unknown, state: { emittedText: string }) => string | undefined;
	/** Extract a readable terminal failure from one decoded JSONL record. */
	extractError?: (record: unknown) => string | undefined;
	/** Convert OMP context into the prompt accepted by the command. */
	formatPrompt?: (context: Context) => string;
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

/**
 * Small host-independent implementation of OMP's structural stream contract.
 * Keeping this runtime-free lets the same file load from a user extension
 * directory in a compiled `omp` binary, where host packages are injected for
 * types but are not necessarily resolvable as npm dependencies.
 */
class LocalAssistantMessageEventStream {
	private queue: AssistantMessageEvent[] = [];
	private waiters: Array<{
		resolve: (result: IteratorResult<AssistantMessageEvent>) => void;
		reject: (error: unknown) => void;
	}> = [];
	private finished = false;
	private failure: unknown;
	private readonly final: Promise<AssistantMessage>;
	private resolveFinal!: (message: AssistantMessage) => void;
	private rejectFinal!: (error: unknown) => void;

	constructor() {
		this.final = new Promise<AssistantMessage>((resolve, reject) => {
			this.resolveFinal = resolve;
			this.rejectFinal = reject;
		});
		this.final.catch(() => {});
	}

	push(event: AssistantMessageEvent): void {
		if (this.finished) return;
		if (event.type === "done") {
			this.finished = true;
			this.resolveFinal(event.message);
		} else if (event.type === "error") {
			this.finished = true;
			this.rejectFinal(event.error);
		}
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value: event, done: false });
		else this.queue.push(event);
		if (this.finished) {
			while (this.waiters.length) this.waiters.shift()!.resolve({ value: undefined as never, done: true });
		}
	}

	fail(error: unknown): void {
		if (this.finished) return;
		this.finished = true;
		this.failure = error;
		this.rejectFinal(error);
		while (this.waiters.length) this.waiters.shift()!.reject(error);
	}

	end(): void {
		if (this.finished) return;
		this.fail(new Error("Command provider ended without a final assistant message."));
	}

	result(): Promise<AssistantMessage> {
		return this.final;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		while (true) {
			if (this.queue.length) {
				yield this.queue.shift()!;
				continue;
			}
			if (this.failure) throw this.failure;
			if (this.finished) return;
			const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) =>
				this.waiters.push({ resolve, reject }),
			);
			if (next.done) return;
			yield next.value;
		}
	}
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

/** Launcher suffixes Windows accepts but Bun's PATH lookup for a bare name does not try. */
const WINDOWS_LAUNCHER_SUFFIXES = [".exe", ".cmd", ".bat", ".com"];

/**
 * Resolve a bare command name against PATH on Windows. `Bun.spawn(["muse", …])`
 * only matches the exact name on PATH and never tries PATHEXT, so a launcher
 * shipped as `muse.cmd` (the Muse installer) stays invisible to the spawn.
 * Anything already carrying a path separator or an extension is left alone.
 */
export function resolveCommandPath(command: string, environment: Record<string, string>): string {
	if (process.platform !== "win32") return command;
	if (/[\\/]/.test(command) || extname(command)) return command;
	const searchPath = environment.PATH ?? environment.Path ?? "";
	for (const entry of searchPath.split(";")) {
		if (!entry) continue;
		const base = entry.replace(/[\\/]+$/, "");
		for (const suffix of WINDOWS_LAUNCHER_SUFFIXES) {
			const candidate = join(base, `${command}${suffix}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return command;
}

function abortProcess(processHandle: Bun.Subprocess<"pipe", "pipe", "pipe">): void {
	try {
		processHandle.kill();
	} catch {
		// The process may have exited between the abort and kill calls.
	}
}

export interface DefaultCommandArgsInput {
	sessionId: string;
	cwd: string;
	prompt: string;
	effort: string;
	commandArgs?: readonly string[];
}

/** Default `muse exec` argument layout, with the resolved reasoning effort pinned. */
export function buildDefaultArgs(input: DefaultCommandArgsInput): string[] {
	return [
		"exec",
		"--json",
		"--session-id",
		input.sessionId,
		"--workspace",
		input.cwd,
		"--reasoning-effort",
		input.effort,
		...(input.commandArgs ?? []),
		input.prompt,
	];
}

export function createCommandStreamSimple(config: CommandProviderConfig) {
	const command = config.command ?? "muse";
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream;
		const startedAt = Date.now();
		const partial = buildMessage(model, "", startedAt);
		stream.push({ type: "start", partial });

		void (async () => {
			let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
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
				const cwd = typeof config.cwd === "function" ? config.cwd(options) : config.cwd;
				const workingDirectory = options?.cwd ?? cwd ?? process.cwd();
				const prompt = (config.formatPrompt ?? latestUserPrompt)(context);
				const sessionId = options?.sessionId ?? crypto.randomUUID();
				const effort = resolveReasoningEffort(options);
				const args = config.buildArgs
					? [...config.buildArgs({ sessionId, cwd: workingDirectory, prompt, model, effort })]
					: buildDefaultArgs({
							sessionId,
							cwd: workingDirectory,
							prompt,
							effort,
							commandArgs: config.commandArgs,
						});

				const environment = childEnvironment(config.env);
				child = Bun.spawn([resolveCommandPath(command, environment), ...args], {
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

				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				try {
					const timeout = new Promise<number>((_, reject) => {
						timeoutHandle = setTimeout(
							() => reject(new Error(`Command timed out after ${timeoutMs} ms.`)),
							timeoutMs,
						);
					});
					const exitCode = await Promise.race([child.exited, timeout]);
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
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
			} catch (error) {
				if (child) abortProcess(child);
				const message = error instanceof Error ? error.message : String(error);
				const errorMessage = { ...partial, stopReason: "error" as const, errorMessage: message };
				stream.push({ type: "error", reason: "error", error: errorMessage });
			} finally {
				options?.signal?.removeEventListener("abort", abortHandler);
			}
		})();
		return stream;
	};
}

export function registerCommandProvider(pi: ExtensionAPI, config: CommandProviderConfig): void {
	const api = config.api ?? COMMAND_PROVIDER_API;
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
		// Resolve the launcher through PATH; on Windows this also finds
		// `muse.cmd`, which `Bun.spawn(["muse", …])` alone would miss.
		command: process.env.MUSE_EXEC_COMMAND ?? resolveCommandPath("muse", childEnvironment(undefined)),
		commandArgs: process.env.MUSE_EXEC_ARGS ? process.env.MUSE_EXEC_ARGS.split(" ") : [],
		// Keep this a Muse session: Muse owns the inner read/write/bash/web loop.
		// OMP receives only the final text stream. The child environment is
		// allowlisted, so OMP's PAYG keys cannot leak in; META_API_KEY is pinned
		// absent as a second guard.
		env: { META_API_KEY: undefined },
	});
}
