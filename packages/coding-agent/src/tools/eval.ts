import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolSpeculationPolicy,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, ToolExample } from "@oh-my-pi/pi-ai";
import { formatBackgroundNotice } from "@oh-my-pi/pi-tui/tools/bash";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS, raceJobSettlement, resolveAutoBackgroundWaitMs } from "../async";
import { jsBackend, pythonBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../eval/bridge-timeout";
import { IdleTimeout } from "../eval/idle-timeout";
import { type EvalPreludeDefinition, getEnabledEvalPreludes } from "../eval/preludes";
import { prepareEvalSource } from "../eval/input";
import type { BackendProbeOptions } from "../eval/probe";
import { defaultEvalSessionId } from "../eval/session-id";
import { EvalShadowCellSession } from "../eval/speculation/cell-session";
import { runWithEvalShadowCell } from "../eval/speculation/runtime-context";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import evalAgentsTopic from "../prompts/tools/eval-agents.md" with { type: "text" };
import evalJudgeTopic from "../prompts/tools/eval-judge.md" with { type: "text" };
import evalHelpersTopic from "../prompts/tools/eval-helpers.md" with { type: "text" };
import evalCodeModeDescription from "../prompts/tools/eval-code-mode.md" with { type: "text" };
import {
	DEFAULT_MAX_BYTES,
	OutputSink,
	type OutputSummary,
	TailBuffer,
	truncateHeadBytes,
} from "@oh-my-pi/pi-tui/tools/streaming-output";
import { sessionDelegationBias } from "../task/prompt-policy";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { canSpawnAtDepth } from "../task/types";
import { webpExclusionForModel } from "@oh-my-pi/pi-tui/chat/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { type EvalBackendsAllowance, resolveEvalBackends } from "./eval-backends";
import { generateCodeModeDeclarations } from "@oh-my-pi/pi-tui/tools/eval-format/code-mode-declarations";
import { upsertStatusEvent } from "@oh-my-pi/pi-tui/tools/eval";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { hasWaitTool } from "./wait";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

/** Language tokens the eval tool accepts, in stable display order. */
export type EvalLanguageToken = "py" | "js";
const EVAL_LANGUAGE_ORDER: readonly EvalLanguageToken[] = ["py", "js"];
const EVAL_LANGUAGE_RUNTIME: Record<EvalLanguageToken, string> = {
	py: '"py": IPython',
	js: '"js": Bun',
};
const EVAL_LANGUAGE_NAME: Record<EvalLanguageToken, string> = {
	py: "Python",
	js: "JavaScript",
};

/** Join names as an English "or" list: ["A"]→"A", ["A","B"]→"A or B", 3+→"A, B, or C". */
function joinWithOr(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} or ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function describeLanguageField(langs: readonly EvalLanguageToken[]): string {
	return langs.map(lang => EVAL_LANGUAGE_RUNTIME[lang]).join("; ");
}

/** One-line discovery summary listing the runtimes available this session. */
function summarizeEvalLanguages(langs: readonly EvalLanguageToken[]): string {
	const names = langs.map(lang => EVAL_LANGUAGE_NAME[lang]);
	const list = names.length > 0 ? joinWithOr(names) : "Python or JavaScript";
	return `Execute ${list} in persistent kernels; load scripts or install packages`;
}

/** Resolved-allowance → enabled language tokens, preserving display order. */
function enabledEvalLanguages(backends: EvalBackendsAllowance): EvalLanguageToken[] {
	const allowed: Record<EvalLanguageToken, boolean> = {
		py: backends.python,
		js: backends.js,
	};
	return EVAL_LANGUAGE_ORDER.filter(lang => allowed[lang]);
}

const evalCellCommonFields = {
	code: type("string").describe("Code or standalone % command; top-level await works."),
	"title?": type("string").describe("Short transcript label."),
	"timeout?": type("number").describe("Cell deadline in seconds; 0 disables it."),
	"reset?": type("boolean").describe("Wipe only this kernel."),
};

/**
 * Per-call input: a single cell. State persists within a language across
 * separate eval calls and across tool calls, so each call is one logical step
 * and later calls reuse what earlier ones defined. This static schema carries
 * the full language union for typing; {@link buildEvalSchema} narrows the wire
 * copy per session so disabled backends are never advertised to the model.
 */
export const evalSchema = type({
	language: type("'py' | 'js'").describe(describeLanguageField(EVAL_LANGUAGE_ORDER)),
	...evalCellCommonFields,
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
		...evalCellCommonFields,
	});
	return schema;
}

export type EvalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EvalToolDetails | undefined;
};

export type EvalProxyExecutor = (params: EvalToolParams, signal?: AbortSignal) => Promise<EvalToolResult>;

/** Shared cap for each structured `display()` preview returned by eval. */
const MAX_DISPLAY_TEXT_BYTES = 8000;
const DISPLAY_ELISION_RESERVE_BYTES = 64;
/** Minimum spacing between live eval updates; bursts coalesce to one trailing snapshot. */
const LIVE_UPDATE_INTERVAL_MS = 50;

interface FormattedDisplayJson {
	fullText: string;
	previewText: string;
	detailsValue: unknown;
	/** Full value must be mirrored to the output artifact; `detailsValue` holds only a preview. */
	spillFullValue: boolean;
}

/**
 * Format one structured `display()` value for the model text and the tool
 * `details`. The model-visible preview is always capped at
 * {@link MAX_DISPLAY_TEXT_BYTES}. When the value exceeds that cap, the full
 * value is retained in `details` only if `canSpill` is false (no persistence,
 * so nothing to bloat); otherwise `details` keeps a bounded metadata object and
 * the caller mirrors the full value to the session output artifact.
 */
function formatDisplayJson(value: unknown, canSpill: boolean): FormattedDisplayJson {
	let fullText: string;
	try {
		fullText = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		fullText = String(value);
	}
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= MAX_DISPLAY_TEXT_BYTES) {
		return { fullText, previewText: fullText, detailsValue: value, spillFullValue: false };
	}

	const head = truncateHeadBytes(fullText, MAX_DISPLAY_TEXT_BYTES - DISPLAY_ELISION_RESERVE_BYTES);
	const previewText = `${head.text}\n[…${fullText.length - head.text.length}ch elided…]`;
	// Without an artifact to mirror into, keep the full value in details: there
	// is no session JSONL to bloat, and discarding it would strand large
	// displays from SDK consumers that read `details.jsonOutputs`.
	if (!canSpill) {
		return { fullText, previewText, detailsValue: value, spillFullValue: false };
	}
	return {
		fullText,
		previewText,
		detailsValue: {
			preview: previewText,
			truncated: true,
			totalBytes,
		},
		spillFullValue: true,
	};
}

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
	/**
	 * Parent spawn policy (`getSessionSpawns`). `true`/omitted means unrestricted,
	 * `false`/`""` hides `agent()`, and a comma list or name array drives the
	 * advertised default.
	 */
	spawns?: boolean | string | string[] | "*" | null;
	/** Advertise auto-backgrounding of long-running cells in the tool prompt. */
	autoBackgroundEnabled?: boolean;
	/** Advertise `@tool` / `tool(fn)` and the `tools` spawn option (`eval.tools.enabled`). */
	evalTools?: boolean;
	/** Push `workpool()` as the default for independent items (model delegation bias `eager`). Default: true. */
	eagerDelegation?: boolean;
	/** Point blocked callers at the `wait` tool; false when the session lacks it (subagents). Default: true. */
	waitTool?: boolean;
	/** Enabled preludes; each becomes an `xd://eval/<name>` doc topic. */
	preludes?: readonly Pick<EvalPreludeDefinition, "name" | "documentation">[];
	/**
	 * Inline every doc topic instead of linking `xd://eval/<topic>`. Required
	 * when the session cannot `read` (the only transport for topic docs).
	 */
	inlineTopics?: boolean;
	/** Whether missing runtimes and environments may be provisioned automatically. */
	autoProvision?: boolean;
}

function evalTemplateContext(options: EvalToolDescriptionOptions) {
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	return {
		py: options.py ?? true,
		js: options.js ?? true,
		evalTools: options.evalTools ?? true,
		eagerDelegation: options.eagerDelegation ?? true,
		waitTool: options.waitTool ?? true,
		autoBackgroundEnabled: options.autoBackgroundEnabled ?? false,
		spawns: spawnPolicy.enabled,
		spawnDefaultAgent: spawnPolicy.defaultAgent,
		spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
		autoProvision: options.autoProvision ?? true,
	};
}

/**
 * On-demand eval docs (`topic → markdown`) served at `xd://eval/<topic>`:
 * `judge` (including completion), `helpers`, `agents` (when spawning is allowed),
 * and one per enabled prelude.
 */
export function getEvalDocTopics(options: EvalToolDescriptionOptions = {}): Record<string, string> {
	const context = evalTemplateContext(options);
	const topics: Record<string, string> = {
		judge: prompt.render(evalJudgeTopic, context),
		helpers: prompt.render(evalHelpersTopic, context),
	};
	if (context.spawns) topics.agents = prompt.render(evalAgentsTopic, context);
	for (const prelude of options.preludes ?? []) {
		const doc = prelude.documentation.trim();
		if (doc) topics[prelude.name] = doc;
	}
	return topics;
}

/** Model-facing eval description: core kernel surface plus one pointer per doc topic. */
export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const preludes: { name: string; summary: string }[] = [];
	for (const prelude of options.preludes ?? []) {
		const doc = prelude.documentation.trim();
		if (doc) preludes.push({ name: prelude.name, summary: doc.split("\n", 1)[0]! });
	}
	return prompt.render(evalDescription, {
		...evalTemplateContext(options),
		preludes,
		inlineTopics: options.inlineTopics ? Object.values(getEvalDocTopics(options)).join("\n\n") : undefined,
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
	displayCode: string;
	environmentChange?: boolean;
	filename?: string;
	packages?: string[];
	environment?: "managed" | "project";
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

	if (language === "python") {
		if (!allowPy) throw new ToolError("Python backend is disabled (PI_PY=0 or eval.py = false).");
		const available = await pythonBackend.isAvailable(session, probeOpts);
		throwIfAborted(probeOpts?.signal);
		if (!available) {
			throw new ToolError(
				allowJs
					? 'Python backend is unavailable in this session. Pass language: "js" or install the python kernel.'
					: 'Python backend is unavailable in this session. Install the python kernel to use language: "py".',
			);
		}
		return { backend: pythonBackend };
	}
	if (!allowJs) throw new ToolError("JavaScript backend is disabled (PI_JS=0 or eval.js = false).");
	return { backend: jsBackend };
}
function formatEvalInputLanguage(value: string): string {
	if (value === "py" || value === "python") return "python";
	if (value === "js" || value === "javascript") return "javascript";
	return value;
}

export class EvalTool implements AgentTool<typeof evalSchema> {
	readonly name = "eval";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = isRecord(args) ? args : {};
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
		const base = getEvalToolDescription(this.#descriptionOptions());
		return this.#codeModeDescription(base) ?? base;
	}

	docTopics(): Record<string, string> {
		return getEvalDocTopics(this.#descriptionOptions());
	}

	/** Live session state feeding both the description and its `xd://eval/<topic>` docs. */
	#descriptionOptions(): EvalToolDescriptionOptions {
		const session = this.session;
		if (!session) return {};
		const backends = resolveEvalBackends(session);
		const depthAllowsSpawning = canSpawnAtDepth(
			session.settings.get("task.maxRecursionDepth") ?? 2,
			session.taskDepth ?? 0,
		);
		return {
			py: backends.python,
			js: backends.js,
			spawns: depthAllowsSpawning ? (session.getSessionSpawns?.() ?? "*") : false,
			autoBackgroundEnabled: session.settings.get("eval.autoBackground.enabled"),
			evalTools: session.settings.get("eval.tools.enabled"),
			eagerDelegation: sessionDelegationBias(session) === "eager",
			waitTool: hasWaitTool(session),
			preludes: getEnabledEvalPreludes(session.getEvalPreludes?.() ?? []),
			inlineTopics: session.isToolActive?.("read") === false,
			autoProvision: session.settings.get("eval.autoProvision"),
		};
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
		const preludeDeclarations = getEnabledEvalPreludes(session.getEvalPreludes?.() ?? [])
			.map(definition => definition.codeModeDeclarations?.trim())
			.filter((declaration): declaration is string => Boolean(declaration))
			.join("\n\n");
		return prompt.render(evalCodeModeDescription, { baseDescription, declarations, preludeDeclarations });
	}
	/** Only syntax not obvious from the field schema; filtered by enabled language. */
	static readonly #examples: readonly ToolExample<typeof evalSchema.infer>[] = [
		{
			caption: "Load a script with spaces without echoing its source",
			call: { language: "py", code: '%load "scripts/my setup.py"' },
		},
	];
	get examples(): readonly ToolExample<typeof evalSchema.infer>[] {
		const langs = new Set(this.#enabledLanguages());
		return EvalTool.#examples.filter(ex => "call" in ex && langs.has(ex.call.language));
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

	readonly speculation: ToolSpeculationPolicy = {
		stream: {
			open: async context => {
				if (!this.session) return undefined;
				if (this.session.settings.get("eval.autoBackground.enabled")) return undefined;
				const parentToolCallId = context.parentToolCallId;
				const cell = new EvalShadowCellSession({
					coordinator: context.coordinator,
					parentToolCallId,
					session: this.session,
					cwd: this.session.cwd,
					sessionId: this.session.getEvalSessionId?.() ?? defaultEvalSessionId(this.session),
					kernelOwnerId: this.session.getEvalKernelOwnerId?.() ?? undefined,
					onDiscard: () => {
						if (this.#shadowCells.get(parentToolCallId) === cell) this.#shadowCells.delete(parentToolCallId);
					},
				});
				this.#shadowCells.set(parentToolCallId, cell);
				return cell;
			},
		},
	};
	readonly #proxyExecutor?: EvalProxyExecutor;

	#paramsKey?: string;
	#cachedParams?: typeof evalSchema;
	readonly #shadowCells = new Map<string, EvalShadowCellSession>();
	readonly #environmentModes: Partial<Record<EvalLanguage, "managed" | "project">> = {};

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

	async execute(
		_toolCallId: string,
		params: typeof evalSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		const shadowCell = this.#shadowCells.get(_toolCallId);
		this.#shadowCells.delete(_toolCallId);
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Eval tool requires a session when not using proxy executor");
		}
		const session = this.session;
		const excludeWebP = webpExclusionForModel(session.getActiveModel?.());

		const cellLanguage: EvalLanguage = params.language === "py" ? "python" : "js";
		// Bound backend discovery by the eval cell's own timeout and abort signal:
		// the cell IdleTimeout is armed only later in #runCells, so a hung runtime
		// probe would otherwise wedge the whole turn (issue #9466).
		const cellTimeoutMs =
			params.timeout === 0
				? 0
				: clampTimeout("eval", params.timeout, session.settings.get("tools.maxTimeout")) * 1000;
		const resolved = await resolveBackend(session, cellLanguage, { signal, timeoutMs: cellTimeoutMs });
		const source = await prepareEvalSource(params, session, signal);
		if (shadowCell && (source.filename || source.packages?.length || source.environment)) {
			await shadowCell.discard("file-backed or environment-changing eval requires authoritative execution");
		}
		const cells: ResolvedEvalCell[] = [
			{
				index: 0,
				title: params.title,
				...source,
				displayCode: params.code,
				environmentChange: source.environment !== undefined,
				environment:
					source.environment ?? (this.#environmentModes[cellLanguage] === "project" ? "project" : undefined),
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
		const run = async (
			runSignal: AbortSignal | undefined,
			emitUpdate: ((text: string, details: EvalToolDetails) => void) | undefined,
		): Promise<AgentToolResult<EvalToolDetails | undefined>> => {
			// Re-check the retained namespace against the streamed planning snapshot:
			// timers, background work, or concurrent session users may have changed
			// it after the speculative children started. On mismatch the children
			// were projected from stale state, so discard the session and run the
			// cell without it (claims then miss and execution is ordinary).
			let activeShadowCell = shadowCell;
			const snapshotToken = shadowCell?.snapshotToken;
			if (shadowCell && snapshotToken) {
				const tokenIsPython = snapshotToken.language === "py";
				let current = tokenIsPython === (cellLanguage === "python");
				if (current) {
					current = await shadowCell.verifySnapshotCurrent().catch(() => false);
				}
				if (!current) {
					await shadowCell.discard("retained eval state changed after shadow planning").catch(() => undefined);
					activeShadowCell = undefined;
				}
			}
			const execution = runWithEvalShadowCell(activeShadowCell, () =>
				this.#runCells({
					session,
					cells,
					languages,
					notice,
					excludeWebP,
					signal: runSignal,
					sessionAbortController,
					emitUpdate,
				}),
			);
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
					const finalText =
						(result.content.find(block => block.type === "text")?.text ?? "") +
						formatOutputNotice(result.details?.meta);
					latestText = finalText;
					latestDetails = result.details;
					// Hand the full result (images included) to the foreground waiter
					// before deciding the job's terminal state.
					completion.resolve({ kind: "completed", result });
					if (result.isError === true) {
						// A failed, cancelled, or timed-out cell is a completed execution
						// that errored. Re-enter the failure path so the job manager
						// records it as failed and delivers the error text.
						throw new ToolError(finalText || "Eval cell failed");
					}
					await reportProgress(finalText, {
						...result.details,
						async: { state: "completed", jobId, type: "eval" },
					});
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, {
						...latestDetails,
						async: { state: "failed", jobId, type: "eval" },
					});
					throw error;
				}
			},
			{ ownerId: session.getAgentId?.() ?? undefined, foreground: !startBackgrounded },
		);

		if (startBackgrounded) {
			return this.#buildBackgroundStartResult(jobId, cells, languages, notice, latestText, latestDetails);
		}
		// The job was registered as foreground-backed: hidden from listings and
		// delivery-suppressed until backgroundJob() promotes it, so a cell
		// finishing within the wait never surfaces as a background job.
		const waitResult = await raceJobSettlement(
			completion.promise,
			autoBackgroundWaitMs,
			signal,
			ctx?.toolCall?.steeringSignal,
		);
		if (waitResult.kind === "completed") {
			autoBgManager.releaseForegroundJob(jobId);
			return waitResult.result;
		}
		if (waitResult.kind === "failed") {
			autoBgManager.releaseForegroundJob(jobId);
			throw waitResult.error;
		}
		if (waitResult.kind === "aborted") {
			autoBgManager.cancel(jobId);
			autoBgManager.releaseForegroundJob(jobId);
			throw new ToolAbortError(latestText || "Eval cell aborted");
		}
		forwardUpdates = false;
		autoBgManager.backgroundJob(jobId);
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
				code: cell.displayCode,
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
	}): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		const { session, cells, languages, notice, excludeWebP, signal, sessionAbortController, emitUpdate } = options;
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		let updateTimer: NodeJS.Timeout | undefined;
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
			const jsonOutputs: unknown[] = [];
			const images: ImageContent[] = [];
			const statusEvents: EvalStatusEvent[] = [];
			// Oversized displays land in `jsonOutputs` as bounded previews and stream
			// their full value to the output artifact. Until the artifact write is
			// confirmed (see `commitDisplaySpills`), the full value is kept here so a
			// silently failed spill can restore it instead of stranding it.
			const spilledDisplays: Array<{ index: number; fullValue: unknown }> = [];
			const commitDisplaySpills = (summary: OutputSummary | undefined): void => {
				if (spilledDisplays.length === 0) return;
				// Artifact persistence confirmed: keep the bounded preview. Otherwise
				// restore the full value so `details` never points at an artifact that
				// was never (fully) written.
				if (summary?.artifactId !== undefined) {
					spilledDisplays.length = 0;
					return;
				}
				for (const spill of spilledDisplays) {
					jsonOutputs[spill.index] = spill.fullValue;
				}
				spilledDisplays.length = 0;
			};

			const cellResults: EvalCellResult[] = cells.map(cell => ({
				index: cell.index,
				title: cell.title,
				code: cell.displayCode,
				language: cell.resolved.backend.id,
				output: "",
				status: "pending",
			}));
			const cellOutputs: string[] = [];
			// The cell currently inside backend.execute(). Streamed stdout is
			// appended to its rendered `output` live so a long-running cell (e.g. a
			// sleep loop) shows progress instead of nothing until it returns. A
			// dedicated per-cell tail buffer keeps attribution correct and avoids
			// double-counting against the aggregate `tailBuffer`; on completion the
			// authoritative `cellResult.output` (below) overwrites this live tail.
			let activeLiveCell: { result: EvalCellResult; buf: TailBuffer } | undefined;

			const appendTail = (text: string) => {
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

			// Stdout chunks and status events can arrive hundreds of times per
			// second; each emitted update rebuilds details and re-renders the card.
			// Coalesce to one trailing update per interval — the snapshot is taken
			// at flush time, so the newest state wins.
			const flushUpdate = () => {
				if (!updateTimer) return;
				clearTimeout(updateTimer);
				updateTimer = undefined;
				emitUpdate?.(tailBuffer.text(), buildUpdateDetails());
			};
			const pushUpdate = () => {
				if (!emitUpdate || updateTimer) return;
				updateTimer = setTimeout(flushUpdate, LIVE_UPDATE_INTERVAL_MS);
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
				onChunk: chunk => {
					appendTail(chunk);
					if (activeLiveCell) {
						activeLiveCell.buf.append(chunk);
						activeLiveCell.result.output = activeLiveCell.buf.text();
					}
					pushUpdate();
				},
			});
			const sessionId = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);

			for (let i = 0; i < cells.length; i++) {
				const cell = cells[i];
				const backend = cell.resolved.backend;
				// The per-cell `timeout` is a budget on the cell runtime's *own*
				// work. Host-side waits on `agent()`/`completion()` handles suspend
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
						filename: cell.filename,
						packages: cell.packages,
						environment: cell.environment,
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
							upsertStatusEvent(cellResult.statusEvents, {
								...event,
								resolvedThinkingLevel: parseConfiguredThinkingLevel(
									typeof event.resolvedThinkingLevel === "string" ? event.resolvedThinkingLevel : undefined,
								),
							});
							pushUpdate();
						},
					});
				} finally {
					idle?.dispose();
					// Publish the cell's last live state before its final output replaces it.
					flushUpdate();
					activeLiveCell = undefined;
				}
				const durationMs = Date.now() - startTime;

				const cellStatusEvents: EvalStatusEvent[] = [];
				const cellDisplayTexts: string[] = [];
				const cellImageNotes: string[] = [];
				let cellHasMarkdown = false;
				for (const output of result.displayOutputs) {
					if (output.type === "json") {
						const formatted = formatDisplayJson(output.data, artifactPath !== undefined);
						const label = `display[${cellDisplayTexts.length + 1}]:\n`;
						jsonOutputs.push(formatted.detailsValue);
						cellDisplayTexts.push(`${label}${formatted.previewText}`);
						if (formatted.spillFullValue) {
							spilledDisplays.push({ index: jsonOutputs.length - 1, fullValue: output.data });
							outputSink.push(`${label}${formatted.fullText}\n`, {
								inline: `${label}${formatted.previewText}\n`,
								emitInline: false,
							});
						}
					}
					if (output.type === "image") {
						const resized = await resizeImage(
							{
								type: "image",
								data: output.data,
								mimeType: output.mimeType,
							},
							{ excludeWebP },
						);
						const image: ImageContent = {
							type: "image",
							data: resized.data,
							mimeType: resized.mimeType,
						};
						images.push(image);
						const dimensionNote = formatDimensionNote(resized);
						if (dimensionNote) {
							cellImageNotes.push(`display image ${cellImageNotes.length + 1}: ${dimensionNote}`);
						}
					}
					if (output.type === "status") {
						const event: EvalStatusEvent = {
							...output.event,
							resolvedThinkingLevel: parseConfiguredThinkingLevel(
								typeof output.event.resolvedThinkingLevel === "string"
									? output.event.resolvedThinkingLevel
									: undefined,
							),
						};
						upsertStatusEvent(statusEvents, event);
						upsertStatusEvent(cellStatusEvents, event);
					}
					if (output.type === "markdown") {
						cellHasMarkdown = true;
					}
				}

				const runtimeOutput = result.output.trim();
				const stdoutTrimmed =
					cell.environmentChange && result.exitCode === 0
						? `${runtimeOutput ? `${runtimeOutput}\n` : ""}Eval environment: ${cell.environment}.`
						: runtimeOutput;
				const imageText = cellImageNotes.join("\n");
				const displayText = cellDisplayTexts.join("\n\n");
				const visibleDisplayText =
					displayText && imageText ? `${displayText}\n\n${imageText}` : displayText || imageText;
				const cellOutput =
					stdoutTrimmed && visibleDisplayText
						? `${stdoutTrimmed}\n\n${visibleDisplayText}`
						: stdoutTrimmed || visibleDisplayText;
				cellResult.output = cellOutput;
				cellResult.exitCode = result.exitCode;
				cellResult.durationMs = durationMs;
				cellResult.statusEvents = cellStatusEvents.length > 0 ? cellStatusEvents : undefined;
				cellResult.hasMarkdown = cellHasMarkdown || undefined;

				if (cellOutput) {
					cellOutputs.push(cellOutput);
					appendTail(cellOutput);
				}

				if (result.cancelled) {
					cellResult.status = "error";
					pushUpdate();
					const errorMsg = result.output || "Command aborted";
					const combinedOutput = cellOutputs.join("\n\n");
					const outputText = combinedOutput || errorMsg;

					const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
					commitDisplaySpills(summaryForMeta);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: cellResults,
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};
					if (notice) details.notice = notice;

					return toolResult(details)
						.content([{ type: "text", text: outputText }, ...images])
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.error()
						.done();
				}

				if (result.exitCode !== 0 && result.exitCode !== undefined) {
					cellResult.status = "error";
					pushUpdate();
					const combinedOutput = cellOutputs.join("\n\n");
					const outputText = combinedOutput
						? `${combinedOutput}\n\nCommand exited with code ${result.exitCode}`
						: `Command exited with code ${result.exitCode}`;

					const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
					commitDisplaySpills(summaryForMeta);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: cellResults,
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};
					if (notice) details.notice = notice;

					return toolResult(details)
						.content([{ type: "text", text: outputText }, ...images])
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.error()
						.done();
				}

				if (cell.environmentChange && cell.environment) {
					this.#environmentModes[backend.id] = cell.environment;
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
			commitDisplaySpills(summaryForMeta);

			const details: EvalToolDetails = {
				language: languages[0],
				languages,
				cells: cellResults,
				jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
				statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
			};
			if (notice) details.notice = notice;

			return toolResult(details)
				.content([{ type: "text", text: outputText }, ...images])
				.truncationFromSummary(summaryForMeta, { direction: "tail" })
				.done();
		} finally {
			clearTimeout(updateTimer);
			if (!outputDumped) {
				try {
					await finalizeOutput();
				} catch {}
			}
		}
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
		artifactError: rawSummary.artifactError,
		columnDroppedBytes: rawSummary.columnDroppedBytes,
		columnTruncatedLines: rawSummary.columnTruncatedLines,
		columnMax: rawSummary.columnMax,
	};
}
