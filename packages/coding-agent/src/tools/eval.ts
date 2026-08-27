import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolPresentationAdapter,
} from "@oh-my-pi/pi-agent-core";
import type {
	ToolDisplayItem,
	ToolDisplayOutput,
	ToolFactBody,
	ToolOutcome,
	ToolPresentationProducer,
} from "@oh-my-pi/pi-agent-core/presentation";
import { mintToolOutcome, nonZeroExitCode, presentationProducerOf } from "@oh-my-pi/pi-agent-core/presentation";
import type { ImageContent, ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
	formatBackgroundNotice,
	raceJobSettlement,
	resolveAutoBackgroundWaitMs,
} from "../async";
import { jsBackend, juliaBackend, pythonBackend, rubyBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../eval/bridge-timeout";
import { IdleTimeout } from "../eval/idle-timeout";
import type { BackendProbeOptions } from "../eval/probe";
import { defaultEvalSessionId } from "../eval/session-id";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalTermination, EvalToolDetails } from "../eval/types";
import { normalizeDisplayJson } from "../presentation/display-json";
import {
	outputSegmentSeparator,
	renderDisplayOutput,
	renderNoticeTrail,
	renderToolOutputSegments,
	type ToolOutputSegment,
} from "../presentation/projections";
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import evalCodeModeDescription from "../prompts/tools/eval-code-mode.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary, TailBuffer } from "../session/streaming-output";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { webpExclusionForModel } from "../utils/image-loading";
import { resizeImage } from "../utils/image-resize";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { type EvalBackendsAllowance, resolveEvalBackends } from "./eval-backends";
import { generateCodeModeDeclarations } from "./eval-format/code-mode-declarations";
import { upsertStatusEvent } from "./eval-render";
import type { OutputMeta } from "./output-meta";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export { EVAL_DEFAULT_PREVIEW_LINES, evalToolRenderer } from "./eval-render";

/** Language tokens the eval tool accepts, in stable display order. */
export type EvalLanguageToken = "py" | "js" | "rb" | "jl";
const EVAL_LANGUAGE_ORDER: readonly EvalLanguageToken[] = ["py", "js", "rb", "jl"];
const EVAL_LANGUAGE_RUNTIME: Record<EvalLanguageToken, string> = {
	py: '"py" for the IPython kernel',
	js: '"js" for the persistent JS VM',
	rb: '"rb" for the persistent Ruby kernel',
	jl: '"jl" for the persistent Julia kernel',
};
const EVAL_LANGUAGE_NAME: Record<EvalLanguageToken, string> = {
	py: "Python",
	js: "JavaScript",
	rb: "Ruby",
	jl: "Julia",
};

/** Join names as an English "or" list: ["A"]→"A", ["A","B"]→"A or B", 3+→"A, B, or C". */
function joinWithOr(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} or ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function describeLanguageField(langs: readonly EvalLanguageToken[]): string {
	return `runtime: ${langs.map(lang => EVAL_LANGUAGE_RUNTIME[lang]).join(", ")}`;
}

function describeCodeField(langs: readonly EvalLanguageToken[]): string {
	const replLangs = langs.filter(lang => lang === "rb" || lang === "jl");
	// No persistent REPL backends → keep the original py/js phrasing verbatim so the
	// default (rb/jl off) wire schema stays byte-identical to the pre-feature one.
	if (replLangs.length === 0) return "code to run in this eval call, verbatim. Use top-level await freely.";
	const awaitLangs = langs.filter(lang => lang === "py" || lang === "js");
	const clauses: string[] = [];
	if (awaitLangs.length > 0) clauses.push(`Top-level \`await\` is available in ${awaitLangs.join("/")}`);
	clauses.push(`${replLangs.join("/")} auto-display the last expression like a REPL`);
	return `code to run in this eval call, verbatim. ${clauses.join("; ")}.`;
}

/** One-line discovery summary listing the runtimes available this session. */
function summarizeEvalLanguages(langs: readonly EvalLanguageToken[]): string {
	const names = langs.map(lang => EVAL_LANGUAGE_NAME[lang]);
	const list = names.length > 0 ? joinWithOr(names) : "Python or JavaScript";
	// "in-process" matches the historical py/js summary; persistent kernels (rb/jl) switch wording.
	const backend = langs.some(lang => lang === "rb" || lang === "jl") ? "a persistent" : "an in-process";
	return `Execute ${list} code in ${backend} eval backend`;
}

/** Resolved-allowance → enabled language tokens, preserving display order. */
function enabledEvalLanguages(backends: EvalBackendsAllowance): EvalLanguageToken[] {
	const allowed: Record<EvalLanguageToken, boolean> = {
		py: backends.python,
		js: backends.js,
		rb: backends.ruby,
		jl: backends.julia,
	};
	return EVAL_LANGUAGE_ORDER.filter(lang => allowed[lang]);
}

const evalCellCommonFields = {
	"title?": type("string").describe('short label shown in transcript (e.g. "imports", "load config")'),
	"timeout?": type("number").describe("timeout for this eval call in seconds; 0 disables the cell timeout"),
	"reset?": type("boolean").describe("wipe this language's kernel before running. Other languages are untouched."),
};

/**
 * Per-call input: a single cell. State persists within a language across
 * separate eval calls and across tool calls, so each call is one logical step
 * and later calls reuse what earlier ones defined. This static schema carries
 * the full language union for typing; {@link buildEvalSchema} narrows the wire
 * copy per session so disabled backends are never advertised to the model.
 */
export const evalSchema = type({
	language: type("'py' | 'js' | 'rb' | 'jl'").describe(describeLanguageField(EVAL_LANGUAGE_ORDER)),
	...evalCellCommonFields,
	code: type("string").describe(describeCodeField(EVAL_LANGUAGE_ORDER)),
});
export type EvalToolParams = typeof evalSchema.infer;
export type EvalCellInput = EvalToolParams;

/**
 * Build a session-scoped copy of the eval schema whose `language` enum and field
 * descriptions advertise only the runtimes enabled for this session. Disabled
 * backends never reach the model: the wire schema, BM25 discovery corpus, and
 * tool description stay in lockstep with {@link resolveEvalBackends}. The static
 * {@link evalSchema} (full union) remains the type-level source of truth.
 */
function buildEvalSchema(langs: readonly EvalLanguageToken[]): typeof evalSchema {
	const schema = type({
		language: type.enumerated(...langs).describe(describeLanguageField(langs)),
		code: type("string").describe(describeCodeField(langs)),
		...evalCellCommonFields,
	});
	return schema as unknown as typeof evalSchema;
}

export type EvalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EvalToolDetails | undefined;
};

export type EvalProxyExecutor = (params: EvalToolParams, signal?: AbortSignal) => Promise<EvalToolResult>;

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
	rb?: boolean;
	jl?: boolean;
	/**
	 * Parent spawn policy (`getSessionSpawns`). `true`/omitted means unrestricted,
	 * `false`/`""` hides `agent()`, and a comma list drives the advertised default.
	 */
	spawns?: boolean | string | null;
	/** Advertise auto-backgrounding of long-running cells in the tool prompt. */
	autoBackgroundEnabled?: boolean;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	const rb = options.rb ?? false;
	const jl = options.jl ?? false;
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	return prompt.render(evalDescription, {
		py,
		js,
		rb,
		jl,
		autoBackgroundEnabled: options.autoBackgroundEnabled ?? false,
		spawns: spawnPolicy.enabled,
		spawnDefaultAgent: spawnPolicy.defaultAgent,
		spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
	});
}

export interface EvalToolOptions {
	proxyExecutor?: EvalProxyExecutor;
}

interface ResolvedBackend {
	backend: ExecutorBackend;
	notice?: string;
}

interface ResolvedEvalCell {
	index: number;
	title?: string;
	code: string;
	timeoutMs: number;
	reset: boolean;
	resolved: ResolvedBackend;
}

/** Settlement handed from a managed eval job to its foreground waiter. */
type ManagedEvalJobCompletion =
	| { kind: "completed"; result: AgentToolResult<EvalToolDetails | undefined> }
	| { kind: "failed"; error: unknown };

function uniqueEvalLanguages(cells: ResolvedEvalCell[]): EvalLanguage[] {
	return [...new Set(cells.map(cell => cell.resolved.backend.id))];
}

function detailsNotice(cells: ResolvedEvalCell[]): string | undefined {
	const notices = [
		...new Set(cells.map(cell => cell.resolved.notice).filter((notice): notice is string => Boolean(notice))),
	];
	return notices.length > 0 ? notices.join(" ") : undefined;
}

async function resolveBackend(
	session: ToolSession,
	language: EvalLanguage,
	probeOpts?: BackendProbeOptions,
): Promise<ResolvedBackend> {
	const backends = resolveEvalBackends(session);
	const allowPy = backends.python;
	const allowJs = backends.js;
	const allowRb = backends.ruby;
	const allowJl = backends.julia;

	if (language === "python") {
		if (!allowPy) throw new ToolError("Python backend is disabled (PI_PY=0 or eval.py = false).");
		const available = await pythonBackend.isAvailable(session, probeOpts);
		throwIfAborted(probeOpts?.signal);
		if (!available) {
			const alternatives = [allowJs ? '"js"' : null, allowRb ? '"rb"' : null, allowJl ? '"jl"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `Python backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install the python kernel.`
					: 'Python backend is unavailable in this session. Install the python kernel to use language: "py".',
			);
		}
		return { backend: pythonBackend };
	}
	if (language === "ruby") {
		if (!allowRb) throw new ToolError("Ruby backend is disabled (PI_RB=0 or eval.rb = false).");
		const available = await rubyBackend.isAvailable(session, probeOpts);
		throwIfAborted(probeOpts?.signal);
		if (!available) {
			const alternatives = [allowJs ? '"js"' : null, allowPy ? '"py"' : null, allowJl ? '"jl"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `Ruby backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install Ruby.`
					: 'Ruby backend is unavailable in this session. Install Ruby to use language: "rb".',
			);
		}
		return { backend: rubyBackend };
	}
	if (language === "julia") {
		if (!allowJl) throw new ToolError("Julia backend is disabled (PI_JL=0 or eval.jl = false).");
		const available = await juliaBackend.isAvailable(session, probeOpts);
		throwIfAborted(probeOpts?.signal);
		if (!available) {
			const alternatives = [allowJs ? '"js"' : null, allowPy ? '"py"' : null, allowRb ? '"rb"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `Julia backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install Julia.`
					: 'Julia backend is unavailable in this session. Install Julia to use language: "jl".',
			);
		}
		return { backend: juliaBackend };
	}
	if (!allowJs) throw new ToolError("JavaScript backend is disabled (PI_JS=0 or eval.js = false).");
	return { backend: jsBackend };
}

/**
 * Derive the authoritative {@link ToolOutcome} from an eval result while its
 * `EvalToolDetails` are still known. Mirrors {@link bashOutcome} but switches
 * on the discriminated {@link EvalTermination} union, not text or optional
 * booleans: the termination kind is the sole source of classification.
 *
 * - `timed_out` carries the configured timeout — never a fabricated `0`.
 * - `interrupted` is a user/system abort, not a defect.
 * - A nonzero exit is a process failure.
 * - Anything else with `isError` is a tool-reported failure.
 */
export function evalOutcome(result: AgentToolResult<EvalToolDetails | undefined>): ToolOutcome {
	const details = result.details;
	const termination = details?.termination;
	if (termination !== undefined) {
		switch (termination.kind) {
			case "timed_out":
				return mintToolOutcome({
					kind: "failed",
					failure: { reason: "process", message: "Command timed out" },
					process: { kind: "timed_out", timeoutMs: termination.timeoutMs },
				});
			case "interrupted":
				return mintToolOutcome({ kind: "interrupted", reason: "Command aborted" });
			default: {
				const exhaustive: never = termination;
				throw new Error(`Unhandled eval termination: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	const cells = details?.cells;
	const lastCell = cells?.[cells.length - 1];
	const exitCode = lastCell?.exitCode;
	if (typeof exitCode === "number" && exitCode !== 0) {
		return mintToolOutcome({
			kind: "failed",
			failure: { reason: "process", message: `Command exited with code ${exitCode}` },
			process: { kind: "exited", code: nonZeroExitCode(exitCode) },
		});
	}
	if (result.isError === true) {
		return mintToolOutcome({ kind: "failed", failure: { reason: "tool_reported", message: "Command failed" } });
	}
	return mintToolOutcome({ kind: "succeeded", process: { kind: "exited", code: 0 } });
}
function formatEvalInputLanguage(value: string): string {
	if (value === "py" || value === "python") return "python";
	if (value === "js" || value === "javascript") return "javascript";
	if (value === "rb" || value === "ruby") return "ruby";
	if (value === "jl" || value === "julia") return "julia";
	return value;
}

export class EvalTool implements AgentTool<typeof evalSchema> {
	readonly name = "eval";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<EvalToolParams>;
		const language =
			typeof params.language === "string" ? formatEvalInputLanguage(params.language) : "javascript (default)";
		const code = typeof params.code === "string" ? params.code : "";
		return [`Language: ${language}`, `Code:\n${truncateForPrompt(code)}`];
	};
	get summary(): string {
		return summarizeEvalLanguages(this.#enabledLanguages());
	}

	supportsCodeModeTransport(): boolean {
		return this.#enabledLanguages().includes("js");
	}
	readonly loadMode = "essential";
	readonly label = "Eval";
	get description(): string {
		let base: string;
		if (!this.session) {
			base = getEvalToolDescription();
		} else {
			const backends = resolveEvalBackends(this.session);
			const sessionSpawns = this.session.getSessionSpawns?.() ?? "*";
			base = getEvalToolDescription({
				py: backends.python,
				js: backends.js,
				rb: backends.ruby,
				jl: backends.julia,
				spawns: sessionSpawns,
				autoBackgroundEnabled: this.session.settings.get("eval.autoBackground.enabled"),
			});
		}
		return this.#codeModeDescription(base) ?? base;
	}

	/**
	 * Codex Code Mode advertisement, pulled from the session's applied direct
	 * partition on every read so the declarations can never advertise a tool the
	 * model can already call directly (a plan-mode transport `write`), nor drift
	 * from the active model or tool registry.
	 */
	#codeModeDescription(baseDescription: string): string | undefined {
		const session = this.session;
		const directToolNames = session?.getCodeModeDirectToolNames?.();
		if (!session || !directToolNames) return undefined;
		const direct = new Set(directToolNames);
		const declarations = generateCodeModeDeclarations(
			(session.getEvalBridgeToolNames?.() ?? [...(session.toolRegistry?.keys() ?? [])]).flatMap(name => {
				if (direct.has(name)) return [];
				const tool = session.toolRegistry?.get(name);
				return tool ? [{ name, parameters: (tool as { parameters?: unknown }).parameters }] : [];
			}),
		);
		return prompt.render(evalCodeModeDescription, { baseDescription, declarations });
	}
	/** All reuse-chain examples; the `examples` getter filters by enabled languages. */
	private static readonly ALL_EXAMPLES: readonly ToolExample<typeof evalSchema.infer>[] = [
		{
			caption: "First call — set up once",
			call: {
				language: "py",
				title: "imports",
				code: "import json\nfrom pathlib import Path",
			},
		},
		{
			caption: "Second call — reuse, do NOT re-import",
			call: {
				language: "py",
				title: "load config",
				code: "data = json.loads(read('package.json'))\ndisplay(data)",
			},
		},
		{
			caption: "Third call — reuse the loaded config",
			call: {
				language: "py",
				title: "scan deps",
				code: "display(sorted(data['dependencies']))",
			},
		},
		{
			caption: "Ruby first call — set up once",
			call: {
				language: "rb",
				title: "setup",
				code: "require 'json'\npkg_path = 'package.json'",
			},
		},
		{
			caption: "Ruby second call — reuse, do NOT re-require",
			call: {
				language: "rb",
				title: "load config",
				code: "pkg = JSON.parse(read(pkg_path))\ndisplay(pkg.keys.sort)",
			},
		},
	];
	get examples(): readonly ToolExample<typeof evalSchema.infer>[] {
		const langs = new Set(this.#enabledLanguages());
		return EvalTool.ALL_EXAMPLES.filter(ex => "call" in ex && langs.has(ex.call.language as EvalLanguageToken));
	}
	get parameters(): typeof evalSchema {
		const langs = this.#enabledLanguages();
		if (langs.length === 0 || langs.length === EVAL_LANGUAGE_ORDER.length) return evalSchema;
		const key = langs.join(",");
		if (this.#paramsKey !== key) {
			this.#cachedParams = buildEvalSchema(langs);
			this.#paramsKey = key;
		}
		return this.#cachedParams ?? evalSchema;
	}
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly intent = (args: Partial<typeof evalSchema.infer>): string | undefined => {
		const title = typeof args.title === "string" ? args.title : undefined;
		const language = typeof args.language === "string" ? formatEvalInputLanguage(args.language) : "javascript";
		return title || `running ${language}`;
	};

	/**
	 * Opt-in to the typed presentation protocol for the local execution route.
	 *
	 * The proxy executor stays explicitly on `legacy_snapshot`: its early
	 * `execute()` return receives no producer handle, so ACP adapts its strict
	 * legacy result at the Phase-2 boundary. `selects` returns
	 * `true` for every local call — eval has a single route (no PTY/client-terminal
	 * split like bash), and every backend (py/js/rb/jl) publishes through the same
	 * `OutputSink` → `terminal_append` path.
	 *
	 * Images are discovered only at cell completion (inside `displayOutputs`), so
	 * protocol selection commits up front. The reducer handles the
	 * `meta_terminal → content` transition at settlement when an `attachment` event
	 * is present — no fallback is needed.
	 */
	readonly presentation: ToolPresentationAdapter<typeof evalSchema, EvalToolDetails | undefined> = {
		selects: () => !this.#proxyExecutor,
		start: (toolCallId, params) => ({
			toolCallId,
			toolName: this.name,
			// The cell title is a short label; the code itself is the source echo,
			// because eval's title is NOT the code the way bash's is.
			title: typeof params.title === "string" ? params.title : this.label,
			kind: "execute",
			// eval's source needs its own rendering surface: the title is a short
			// `[lang] label`, and the code has nowhere else to render on a terminal
			// frame. `sourceEcho` rides the first terminal payload.
			sourceEcho: typeof params.code === "string" ? params.code : undefined,
			...(typeof params.code === "string" ? { rawInput: { language: params.language, code: params.code } } : {}),
		}),
	};

	/**
	 * `wrappedExecute` (`tools/output-meta.ts`) calls this with only the fact
	 * bodies a call declared on `details.presentationFacts` (never the raw
	 * result), and only ever uses the returned string as a trail to append via
	 * `appendTrailingText` — never as a content replacement. Eval has a
	 * bespoke trail for a non-`middle` truncation fact and/or a
	 * `limit`/`"column"` fact (all of `execute()`'s `.truncationFromSummary()`
	 * sites are migrated onto `ToolResultBuilder#truncationFactFromSummary`);
	 * every other call returns `undefined` and falls through to the default
	 * `appendOutputNotice`.
	 */
	readonly modelContentProjection = (facts: readonly ToolFactBody[]): string | undefined => renderNoticeTrail(facts);

	readonly #proxyExecutor?: EvalProxyExecutor;

	#paramsKey?: string;
	#cachedParams?: typeof evalSchema;

	/**
	 * Languages enabled for this session, in display order. Detached tools (no
	 * session) fall back to the shipped defaults (py/js; rb/jl are opt-in).
	 */
	#enabledLanguages(): EvalLanguageToken[] {
		return this.session ? enabledEvalLanguages(resolveEvalBackends(this.session)) : ["py", "js"];
	}

	constructor(
		private readonly session: ToolSession | null,
		options?: EvalToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
	}

	async #executeCore(
		_toolCallId: string,
		params: typeof evalSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EvalToolDetails | undefined>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Eval tool requires a session when not using proxy executor");
		}
		// Extract the presentation producer only when the agent loop chose the
		// presentation protocol for this call. The proxy executor stays on
		// legacy_snapshot — its early return receives no producer handle.
		const presentation = presentationProducerOf(ctx?.toolCall?.progress);
		const session = this.session;
		const excludeWebP = webpExclusionForModel(session.getActiveModel?.());

		const cellLanguage: EvalLanguage =
			params.language === "py"
				? "python"
				: params.language === "rb"
					? "ruby"
					: params.language === "jl"
						? "julia"
						: "js";
		// Bound backend discovery by the eval cell's own timeout and abort signal:
		// the cell IdleTimeout is armed only later in #runCells, so a hung runtime
		// probe would otherwise wedge the whole turn (issue #9466).
		const cellTimeoutMs =
			params.timeout === 0
				? 0
				: clampTimeout("eval", params.timeout, session.settings.get("tools.maxTimeout")) * 1000;
		const resolved = await resolveBackend(session, cellLanguage, { signal, timeoutMs: cellTimeoutMs });
		const cells: ResolvedEvalCell[] = [
			{
				index: 0,
				title: params.title,
				code: params.code,
				timeoutMs: cellTimeoutMs,
				reset: params.reset ?? false,
				resolved,
			},
		];
		const languages = uniqueEvalLanguages(cells);
		const notice = detailsNotice(cells);
		const sessionAbortController = new AbortController();
		const emitToolUpdate = onUpdate
			? (text: string, details: EvalToolDetails): void => {
					onUpdate({ content: [{ type: "text", text }], details });
				}
			: undefined;
		// Presentation ownership for auto-backgrounding, mirroring bash's managed
		// route: the foreground call owns the producer only while it is waiting.
		// Backgrounding (threshold, steer, immediate) or aborting detaches the
		// scoped producer BEFORE the foreground returns and the agent loop
		// freezes it, so the continuing background cell can never write to a
		// settled call (a post-freeze fact/display/attachment throws and would
		// fail the whole job; late terminal chunks would be dropped).
		let foregroundPresentation = presentation;
		let cellsOutputSink: OutputSink | undefined;
		const stopForegroundDelivery = (): void => {
			cellsOutputSink?.detachPresentation();
			foregroundPresentation = undefined;
		};
		const run = (
			runSignal: AbortSignal | undefined,
			emitUpdate: ((text: string, details: EvalToolDetails) => void) | undefined,
		): Promise<AgentToolResult<EvalToolDetails | undefined>> => {
			const execution = this.#runCells({
				session,
				cells,
				languages,
				notice,
				excludeWebP,
				signal: runSignal,
				sessionAbortController,
				emitUpdate,
				presentation: foregroundPresentation,
				presentationActive: () => foregroundPresentation !== undefined,
				onOutputSink: sink => {
					cellsOutputSink = sink;
					// Job start can race the detach decision: a sink created after
					// stopForegroundDelivery() must not stay attached to a producer
					// the loop is about to freeze.
					if (foregroundPresentation === undefined) sink.detachPresentation();
				},
			});
			return session.trackEvalExecution?.(execution, sessionAbortController) ?? execution;
		};

		const autoBgManager = session.asyncJobManager;
		// At the running-job cap, fall through to direct foreground execution
		// instead of failing every eval call until a slot frees up.
		if (!session.settings.get("eval.autoBackground.enabled") || !autoBgManager || autoBgManager.atCapacity) {
			return await run(signal, emitToolUpdate);
		}

		const thresholdMs = Math.max(
			0,
			Math.floor(session.settings.get("eval.autoBackground.thresholdMs") ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS),
		);
		// The wait budget mirrors #runCells' clamped cell timeout. The cell budget
		// is runtime work (it pauses across agent()/tool bridge calls), so a cell
		// can legitimately outlive it in wall time — exactly the case
		// backgrounding exists for.
		const clampedCellTimeoutMs =
			cells[0].timeoutMs === 0
				? undefined
				: clampTimeout("eval", cells[0].timeoutMs / 1000, session.settings.get("tools.maxTimeout")) * 1000;
		const autoBackgroundWaitMs = resolveAutoBackgroundWaitMs(thresholdMs, clampedCellTimeoutMs);
		const startBackgrounded = autoBackgroundWaitMs === 0;

		const rawLabel = params.title?.trim() || params.code.trim().split("\n", 1)[0] || "eval cell";
		const label = rawLabel.length > 120 ? `${rawLabel.slice(0, 117)}...` : rawLabel;

		let latestText = "";
		let latestDetails: EvalToolDetails | undefined;
		let forwardUpdates = !startBackgrounded;
		const completion = Promise.withResolvers<ManagedEvalJobCompletion>();

		const jobId = autoBgManager.register(
			"eval",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				try {
					const result = await run(runSignal, (text, details) => {
						latestText = text;
						latestDetails = details;
						void reportProgress(text, { async: { state: "running", jobId, type: "eval" } });
						if (forwardUpdates) emitToolUpdate?.(text, details);
					});
					const finalText = result.content.find(block => block.type === "text")?.text ?? "";
					latestText = finalText;
					// Hand the full result (images included) to the foreground waiter
					// before deciding the job's terminal state.
					completion.resolve({ kind: "completed", result });
					if (result.isError === true) {
						// A failed, cancelled, or timed-out cell is a completed execution
						// that errored. Re-enter the failure path so the job manager
						// records it as failed and delivers the error text.
						throw new ToolError(finalText || "Eval cell failed");
					}
					await reportProgress(finalText, { async: { state: "completed", jobId, type: "eval" } });
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, { async: { state: "failed", jobId, type: "eval" } });
					throw error;
				}
			},
			{ ownerId: session.getAgentId?.() ?? undefined },
		);

		if (startBackgrounded) {
			stopForegroundDelivery();
			return this.#buildBackgroundStartResult(jobId, cells, languages, notice, latestText, latestDetails);
		}
		// Suppress the completion delivery up front so a job finishing while we
		// foreground-wait cannot also be injected by the delivery loop. Lifted
		// via resumeDeliveries() if we end up backgrounding after all.
		autoBgManager.acknowledgeDeliveries([jobId]);
		const waitResult = await raceJobSettlement(
			completion.promise,
			autoBackgroundWaitMs,
			signal,
			ctx?.toolCall?.steeringSignal,
		);
		if (waitResult.kind === "completed") {
			return waitResult.result;
		}
		if (waitResult.kind === "failed") {
			throw waitResult.error;
		}
		if (waitResult.kind === "aborted") {
			stopForegroundDelivery();
			autoBgManager.cancel(jobId);
			throw new ToolAbortError(latestText || "Eval cell aborted");
		}
		stopForegroundDelivery();
		forwardUpdates = false;
		autoBgManager.resumeDeliveries([jobId]);
		// "steer": a queued user/peer message arrived mid-wait — background the
		// cell (it keeps running) so the message injects promptly.
		const steerNotice =
			waitResult.kind === "steer"
				? "Backgrounded early to handle an incoming message; the cell keeps running."
				: undefined;
		return this.#buildBackgroundStartResult(jobId, cells, languages, notice, latestText, latestDetails, steerNotice);
	}

	/**
	 * Tool result returned when a cell converts into a background job: the live
	 * output tail plus the background notice, with details carrying the running
	 * cell snapshot and the async job marker the transcript renderer keys on.
	 */
	#buildBackgroundStartResult(
		jobId: string,
		cells: ResolvedEvalCell[],
		languages: EvalLanguage[],
		notice: string | undefined,
		previewText: string,
		latestDetails: EvalToolDetails | undefined,
		extraNotice?: string,
	): AgentToolResult<EvalToolDetails> {
		// latestDetails snapshots are per-update copies (buildUpdateDetails), so
		// tagging the async marker on cannot leak into later job progress.
		const details: EvalToolDetails = latestDetails ?? {
			language: languages[0],
			languages,
			cells: cells.map(cell => ({
				index: cell.index,
				title: cell.title,
				code: cell.code,
				language: cell.resolved.backend.id,
				output: previewText,
				status: "running" as const,
			})),
		};
		if (notice) details.notice ??= notice;
		details.async = { state: "running", jobId, type: "eval" };
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (extraNotice) {
			lines.push(extraNotice, "");
		}
		lines.push(formatBackgroundNotice(jobId));
		return { content: [{ type: "text", text: lines.join("\n") }], details };
	}

	/**
	 * Execute the resolved cells against their backends, streaming tail/detail
	 * updates through `emitUpdate`. Runs identically in the foreground path and
	 * inside a managed background job (which passes the job's own signal).
	 */
	async #runCells(options: {
		session: ToolSession;
		cells: ResolvedEvalCell[];
		languages: EvalLanguage[];
		notice: string | undefined;
		excludeWebP: boolean | undefined;
		signal: AbortSignal | undefined;
		sessionAbortController: AbortController;
		emitUpdate?: (text: string, details: EvalToolDetails) => void;
		presentation: ToolPresentationProducer | undefined;
		/** Re-check whether the caller still owns its presentation stream before any late write. */
		presentationActive?: () => boolean;
		/** Receives the live sink once it exists so a caller can detach presentation safely. */
		onOutputSink?: (sink: OutputSink) => void;
	}): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		const {
			session,
			cells,
			languages,
			notice,
			excludeWebP,
			signal,
			sessionAbortController,
			emitUpdate,
			presentation,
			presentationActive,
			onOutputSink,
		} = options;
		// The producer handle, revalidated on EVERY use: an auto-backgrounded
		// call detaches ownership when its foreground waiter returns, and any
		// write after the agent loop freezes the settled producer throws. The
		// construction-time `presentation` const alone cannot observe that.
		const livePresentation = (): ToolPresentationProducer | undefined =>
			presentation !== undefined && (presentationActive?.() ?? true) ? presentation : undefined;
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			outputSummary = await outputSink.dump();
			outputDumped = true;
			return outputSummary;
		};
		try {
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			session.assertEvalExecutionAllowed?.();

			const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);
			const jsonOutputs: Extract<ToolDisplayItem, { kind: "json" }>["value"][] = [];
			const images: ImageContent[] = [];
			const statusEvents: EvalStatusEvent[] = [];
			// Executor-synthesized notes (kernel timeout/kill, a stdin request) are
			// already composed into the model-facing `output` text by
			// `OutputSink.dump(notice)`; the presentation protocol declares each
			// one separately as its own `stop_annotation` fact below, from
			// `ExecutorBackendResult.annotation` directly.

			const cellResults: EvalCellResult[] = cells.map(cell => ({
				index: cell.index,
				title: cell.title,
				code: cell.code,
				language: cell.resolved.backend.id,
				output: "",
				status: "pending",
			}));
			const cellOutputs: string[] = [];
			// The cell currently inside backend.execute(). Streamed stdout is
			// appended to its rendered `output` live so a long-running cell (e.g. a
			// sleep loop) shows progress instead of nothing until it returns. A
			// dedicated per-cell tail buffer keeps attribution correct and avoids
			// double-counting against the aggregate `tailBuffer`. `tailBuffer` is
			// append-only (it backs a live progress stream, never replaced): at
			// completion below, only the parts of `cellOutput` never streamed via
			// `OutputSink.onChunk` (display/image notes) are appended — re-adding
			// the already-streamed stdout would duplicate it.
			let activeLiveCell: { result: EvalCellResult; buf: TailBuffer } | undefined;

			// Mirrors the `"\n\n"` join between entries of `cellOutputs` below
			// (the eventual authoritative `combinedOutput`) so the *streamed*
			// tail — the live ACP meta-terminal watches this cumulative text —
			// never diverges from what the final result actually contains. Set
			// right after a cell contributes non-empty output (see
			// `cellOutputs.push` below); consumed by the next contribution,
			// whichever cell that turns out to be, so a cell that itself
			// produces nothing doesn't insert a spurious blank gap.
			let awaitingCellSeparator = false;
			const appendTail = (text: string) => {
				if (!text) return;
				if (awaitingCellSeparator) {
					tailBuffer.append("\n\n");
					awaitingCellSeparator = false;
				}
				tailBuffer.append(text);
			};

			const buildUpdateDetails = (): EvalToolDetails => {
				const details: EvalToolDetails = {
					language: languages[0],
					languages,
					cells: cellResults.map(cell => ({
						...cell,
						statusEvents: cell.statusEvents ? [...cell.statusEvents] : undefined,
					})),
				};
				if (jsonOutputs.length > 0) {
					details.jsonOutputs = jsonOutputs;
				}
				if (images.length > 0) {
					details.images = images;
				}
				if (statusEvents.length > 0) {
					details.statusEvents = statusEvents;
				}
				if (notice) {
					details.notice = notice;
				}
				return details;
			};

			const pushUpdate = () => {
				if (livePresentation()) return;
				emitUpdate?.(tailBuffer.text(), buildUpdateDetails());
			};

			const sessionFile = session.getSessionFile?.() ?? undefined;
			const kernelOwnerId = session.getEvalKernelOwnerId?.() ?? undefined;
			const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.("eval")) ?? {};
			session.assertEvalExecutionAllowed?.();
			outputSink = new OutputSink({
				artifactPath,
				artifactId,
				headBytes: resolveOutputSinkHeadBytes(session.settings),
				maxColumns: resolveOutputMaxColumns(session.settings),
				...(livePresentation() === undefined ? {} : { presentation }),
				onChunk: chunk => {
					appendTail(chunk);
					if (activeLiveCell) {
						activeLiveCell.buf.append(chunk);
						activeLiveCell.result.output = activeLiveCell.buf.text();
					}
					pushUpdate();
				},
			});
			onOutputSink?.(outputSink);
			const sessionId = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);

			// Declare truncation and artifact facts from the result's OutputMeta on
			// the presentation protocol. These are "human"-audience facts: the
			// model-facing body carries the elision marker the sink wrote into the
			// retained bytes and nothing else. Called after each return path builds its
			// result so the meta is available.
			const publishEvalTruncationFacts = (meta: OutputMeta | undefined): void => {
				const producer = livePresentation();
				if (!producer || !meta) return;
				const truncation = meta.truncation;
				if (truncation) {
					producer.fact({
						kind: "truncation",
						meta: {
							direction: truncation.direction,
							totalBytes: truncation.totalBytes,
							retainedBytes: truncation.outputBytes,
							totalLines: truncation.totalLines,
							retainedLines: truncation.outputLines,
							...(truncation.elidedBytes === undefined ? {} : { elidedBytes: truncation.elidedBytes }),
							...(truncation.elidedLines === undefined ? {} : { elidedLines: truncation.elidedLines }),
						},
					});
					if (truncation.artifactId !== undefined) {
						producer.fact({ kind: "artifact", artifactId: truncation.artifactId });
					}
				}
				const columnTruncated = meta.limits?.columnTruncated;
				if (columnTruncated) {
					producer.fact({ kind: "limit", meta: { limit: "column", value: columnTruncated.maxColumn } });
				}
			};

			for (let i = 0; i < cells.length; i++) {
				const cell = cells[i];
				const backend = cell.resolved.backend;
				// The per-cell `timeout` is a budget on the cell runtime's *own*
				// work. Host-side `agent()`/`parallel()`/`completion()` bridge calls suspend
				// that budget entirely and restart a fresh timeout window when control
				// returns to the active backend runtime. Compute, stdout, `log()`/`phase()`, and
				// ordinary tool calls all count against the budget. The watchdog drives
				// `combinedSignal`; we pass no wall-clock deadline downstream so the
				// backends never arm a competing fixed timer.
				const idleTimeoutMs =
					cell.timeoutMs === 0
						? undefined
						: clampTimeout("eval", cell.timeoutMs / 1000, session.settings.get("tools.maxTimeout")) * 1000;
				const idle = idleTimeoutMs === undefined ? undefined : new IdleTimeout(idleTimeoutMs);
				const combinedSignal =
					signal && idle
						? AbortSignal.any([signal, idle.signal, sessionAbortController.signal])
						: signal
							? AbortSignal.any([signal, sessionAbortController.signal])
							: idle
								? AbortSignal.any([idle.signal, sessionAbortController.signal])
								: sessionAbortController.signal;

				const cellResult = cellResults[i];
				cellResult.status = "running";
				cellResult.output = "";
				cellResult.statusEvents = undefined;
				cellResult.exitCode = undefined;
				cellResult.durationMs = undefined;
				activeLiveCell = { result: cellResult, buf: new TailBuffer(DEFAULT_MAX_BYTES * 2) };
				pushUpdate();

				const startTime = Date.now();
				let result: ExecutorBackendResult;
				try {
					result = await backend.execute(cell.code, {
						cwd: session.cwd,
						sessionId,
						sessionFile: sessionFile ?? undefined,
						kernelOwnerId,
						signal: combinedSignal,
						session,
						idleTimeoutMs,
						reset: cell.reset,
						onChunk: chunk => {
							outputSink!.push(chunk);
						},
						onStatus: event => {
							if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
								idle?.pause();
								return;
							}
							if (event.op === EVAL_TIMEOUT_RESUME_OP) {
								idle?.resume();
								return;
							}
							cellResult.statusEvents ??= [];
							upsertStatusEvent(cellResult.statusEvents, event);
							pushUpdate();
						},
					});
				} finally {
					idle?.dispose();
					activeLiveCell = undefined;
				}
				const durationMs = Date.now() - startTime;
				// Declare the annotation as a structured fact on the presentation
				// protocol. `dump(notice)` bakes it into the model-facing text but
				// never streams it through `onChunk`, so the ACP terminal path
				// would otherwise lose the reason a cell stopped.
				if (result.annotation) livePresentation()?.fact({ kind: "stop_annotation", text: result.annotation });

				const cellStatusEvents: EvalStatusEvent[] = [];
				const cellDisplayItems: ToolDisplayItem[] = [];
				let cellHasMarkdown = false;
				for (const output of result.displayOutputs) {
					if (output.type === "json") {
						const item = normalizeDisplayJson(output.data);
						cellDisplayItems.push(item);
						if (item.kind === "json") jsonOutputs.push(item.value);
					}
					if (output.type === "image") {
						const resized = await resizeImage(
							{ type: "image", data: output.data, mimeType: output.mimeType },
							{ excludeWebP },
						);
						const image: ImageContent = { type: "image", data: resized.data, mimeType: resized.mimeType };
						images.push(image);
						livePresentation()?.attachment({ kind: "image", data: resized.data, mimeType: resized.mimeType });
						if (
							resized.wasResized &&
							resized.originalWidth !== undefined &&
							resized.originalHeight !== undefined &&
							resized.width !== undefined &&
							resized.height !== undefined
						) {
							cellDisplayItems.push({
								kind: "image_dimensions",
								originalWidth: resized.originalWidth,
								originalHeight: resized.originalHeight,
								width: resized.width,
								height: resized.height,
							});
						}
					}
					if (output.type === "status") {
						upsertStatusEvent(statusEvents, output.event);
						upsertStatusEvent(cellStatusEvents, output.event);
					}
					if (output.type === "markdown") cellHasMarkdown = true;
				}

				const display: ToolDisplayOutput | undefined =
					cellDisplayItems.length === 0 ? undefined : { kind: "sequence", items: cellDisplayItems };
				const visibleDisplayText = display === undefined ? "" : renderDisplayOutput(display);
				// The model-facing cell body retains Phase 0's normalization contract:
				// stdout is trimmed before it is composed with display values. The
				// presentation producer above still receives OutputSink's raw chunks.
				const modelProcessText = result.output.trim();
				const outputSegments: ToolOutputSegment[] = [];
				if (modelProcessText.length > 0) outputSegments.push({ kind: "process", text: modelProcessText });
				if (display !== undefined) outputSegments.push({ kind: "display", display });
				const cellOutput = renderToolOutputSegments(outputSegments);
				cellResult.output = cellOutput;
				cellResult.exitCode = result.exitCode;
				cellResult.durationMs = durationMs;
				cellResult.statusEvents = cellStatusEvents.length > 0 ? cellStatusEvents : undefined;
				cellResult.hasMarkdown = cellHasMarkdown || undefined;

				if (cellOutput) {
					cellOutputs.push(cellOutput);
					if (display !== undefined) {
						const displayProducer = livePresentation();
						displayProducer?.declareDisplay(display);
						if (!displayProducer) {
							appendTail(
								modelProcessText.length > 0
									? `${outputSegmentSeparator(modelProcessText)}${visibleDisplayText}`
									: visibleDisplayText,
							);
						}
					}
					awaitingCellSeparator = true;
				}

				if (result.termination !== undefined) {
					cellResult.status = "error";
					pushUpdate();
					const errorMsg = result.output || "Command aborted";
					const combinedOutput = cellOutputs.join("\n\n");
					const outputText = combinedOutput || errorMsg;

					const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: cellResults,
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
						termination: result.termination,
					};
					if (notice) details.notice = notice;

					const built = toolResult(details)
						.content([{ type: "text", text: outputText }, ...images])
						.truncationFactFromSummary(summaryForMeta, { direction: "tail" })
						.error()
						.done();
					publishEvalTruncationFacts(built.details?.meta);
					return built;
				}

				if (result.exitCode !== 0 && result.exitCode !== undefined) {
					cellResult.status = "error";
					pushUpdate();
					const combinedOutput = cellOutputs.join("\n\n");
					const exitNotice = `Command exited with code ${result.exitCode}`;
					const outputText = combinedOutput ? `${combinedOutput}\n\n${exitNotice}` : exitNotice;

					const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: cellResults,
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};
					if (notice) details.notice = notice;

					const built = toolResult(details)
						.content([{ type: "text", text: outputText }, ...images])
						.truncationFactFromSummary(summaryForMeta, { direction: "tail" })
						.error()
						.done();
					publishEvalTruncationFacts(built.details?.meta);
					return built;
				}

				cellResult.status = "complete";
				pushUpdate();
			}

			const combinedOutput = cellOutputs.join("\n\n");
			const hasImages = images.length > 0;
			const outputText =
				combinedOutput ||
				(hasImages
					? `(displayed ${images.length} image${images.length === 1 ? "" : "s"}; no text output)`
					: "(no output)");
			const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);

			const details: EvalToolDetails = {
				language: languages[0],
				languages,
				cells: cellResults,
				jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
				statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
			};
			if (notice) details.notice = notice;

			const built = toolResult(details)
				.content([{ type: "text", text: outputText }, ...images])
				.truncationFactFromSummary(summaryForMeta, { direction: "tail" })
				.done();
			publishEvalTruncationFacts(built.details?.meta);
			return built;
		} finally {
			if (!outputDumped) {
				try {
					await finalizeOutput();
				} catch {}
			}
		}
	}

	/**
	 * Public entry point: attaches the authoritative {@link ToolOutcome}
	 * to `#executeCore`'s result, including the proxy-executor
	 * early return -- the old adapter-based derivation applied `evalOutcome`
	 * unconditionally to every completed `execute()` call (it read
	 * `tool.presentation`, a class-level field, not whether `selects()`
	 * actually chose the presentation route for this particular call), so
	 * this preserves that exact scope.
	 */
	async execute(
		toolCallId: string,
		params: typeof evalSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EvalToolDetails | undefined>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		const result = await this.#executeCore(toolCallId, params, signal, onUpdate, ctx);
		return { ...result, outcome: evalOutcome(result) };
	}
}

async function summarizeFinal(
	combinedOutput: string,
	finalizeOutput: () => Promise<OutputSummary | undefined>,
): Promise<OutputSummary> {
	const rawSummary = (await finalizeOutput()) ?? {
		output: "",
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	};
	const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
	const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
	const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
	const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
	return {
		output: combinedOutput,
		truncated: rawSummary.truncated,
		totalLines: outputLines + missingLines,
		totalBytes: outputBytes + missingBytes,
		outputLines,
		outputBytes,
		artifactId: rawSummary.artifactId,
		columnDroppedBytes: rawSummary.columnDroppedBytes,
		columnTruncatedLines: rawSummary.columnTruncatedLines,
		columnMax: rawSummary.columnMax,
	};
}
