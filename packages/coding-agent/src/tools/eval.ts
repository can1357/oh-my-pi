import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent, ToolExample } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { jsBackend, juliaBackend, pythonBackend, rubyBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../eval/bridge-timeout";
import { IdleTimeout } from "../eval/idle-timeout";
import { defaultEvalSessionId } from "../eval/session-id";
import type {
	EvalCancellationCause,
	EvalCellResult,
	EvalDisplayOutput,
	EvalLanguage,
	EvalStatusEvent,
	EvalToolDetails,
} from "../eval/types";
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary, TailBuffer } from "../session/streaming-output";
import { webpExclusionForModel } from "../utils/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { resolveEvalBackends } from "./eval-backends";
import { upsertStatusEvent } from "./eval-render";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export { EVAL_DEFAULT_PREVIEW_LINES, evalToolRenderer } from "./eval-render";

/** Wire language ids: py/js are always advertised; rb/jl appear once their backends are enabled. */
type EvalWireLanguage = "py" | "js" | "rb" | "jl";

const WIRE_LANGUAGE_ORDER: readonly EvalWireLanguage[] = ["py", "js", "rb", "jl"];

const LANGUAGE_DESCRIPTION_PARTS: Record<EvalWireLanguage, string> = {
	py: '"py" for the IPython kernel',
	js: '"js" for the persistent JS VM',
	rb: '"rb" for the persistent Ruby kernel',
	jl: '"jl" for the persistent Julia kernel',
};

const BASE_CODE_DESCRIPTION = "code to run in this eval call, verbatim. Use top-level await freely.";
const REPL_CODE_DESCRIPTION =
	"code to run in this eval call, verbatim. Top-level `await` is available in py/js; rb/jl auto-display the last expression like a REPL.";

/**
 * Build the flat single-call schema for the advertised language set. State
 * persists within a language across tool calls; rb/jl stay out of the wire
 * schema (byte-identical to the pre-feature py/js one) until enabled.
 */
function buildEvalSchema(languages: readonly EvalWireLanguage[]) {
	const hasReplBackends = languages.includes("rb") || languages.includes("jl");
	const languageUnion = languages.map(language => `'${language}'`).join(" | ") as "'py' | 'js'";
	return type({
		language: type(languageUnion).describe(
			`runtime: ${languages.map(language => LANGUAGE_DESCRIPTION_PARTS[language]).join(", ")}`,
		),
		code: type("string").describe(hasReplBackends ? REPL_CODE_DESCRIPTION : BASE_CODE_DESCRIPTION),
		"title?": type("string").describe('short label shown in transcript (e.g. "imports", "load config")'),
		"timeout?": type("number").describe("per-cell timeout in seconds"),
		"reset?": type("boolean").describe(
			"wipe this cell's language kernel before running. Other languages are untouched.",
		),
	});
}

export const evalSchema = buildEvalSchema(["py", "js"]);
type EvalSchemaType = typeof evalSchema;

// Memoized per advertised-language set: the schema is stable for a given
// backend allowance, and tool consumers may read `parameters` per render.
const evalSchemaCache = new Map<string, EvalSchemaType>([["py,js", evalSchema]]);

function evalSchemaForLanguages(languages: readonly EvalWireLanguage[]): EvalSchemaType {
	const key = languages.join(",");
	let schema = evalSchemaCache.get(key);
	if (!schema) {
		schema = buildEvalSchema(languages);
		evalSchemaCache.set(key, schema);
	}
	return schema;
}

function advertisedLanguages(session: ToolSession | null): EvalWireLanguage[] {
	const backends = session ? resolveEvalBackends(session) : undefined;
	return WIRE_LANGUAGE_ORDER.filter(language => {
		if (language === "rb") return backends?.ruby === true;
		if (language === "jl") return backends?.julia === true;
		return true;
	});
}

export type EvalCellInput = { language: "py" | "js" | "rb" | "jl" } & Omit<typeof evalSchema.infer, "language">;
export type EvalToolParams = EvalCellInput;

export type EvalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EvalToolDetails | undefined;
};

export type EvalProxyExecutor = (params: EvalToolParams, signal?: AbortSignal) => Promise<EvalToolResult>;

/** Cap per `display()` value sent back to the model. */
const MAX_DISPLAY_TEXT_BYTES = 8000;

function formatDisplayJsonForText(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	if (text.length > MAX_DISPLAY_TEXT_BYTES) {
		text = `${text.slice(0, MAX_DISPLAY_TEXT_BYTES)}\n[…${text.length - MAX_DISPLAY_TEXT_BYTES}ch elided…]`;
	}
	return text;
}

/**
 * Format display() JSON values into text the model can see. Images are surfaced
 * separately as ImageContent so the model can actually inspect them; this helper
 * intentionally does not touch images.
 */
function formatDisplayOutputsForText(outputs: EvalDisplayOutput[]): string {
	const chunks: string[] = [];
	let displayIndex = 0;
	for (const output of outputs) {
		if (output.type !== "json") continue;
		displayIndex++;
		chunks.push(`display[${displayIndex}]:\n${formatDisplayJsonForText(output.data)}`);
	}
	return chunks.join("\n\n");
}

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
	/** Ruby backend advertisement; opt-in, default false (mirrors eval.rb). */
	rb?: boolean;
	/** Julia backend advertisement; opt-in, default false (mirrors eval.jl). */
	jl?: boolean;
	/**
	 * Whether `agent()` is allowed in this session. Driven by the parent's
	 * spawn policy (`getSessionSpawns`). Defaults to `true` for backward
	 * compatibility — when the session forbids spawning, the prelude doc
	 * omits the `agent()` entry so the model does not promise itself a
	 * helper that will only ever throw "spawns disabled".
	 */
	spawns?: boolean;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	const rb = options.rb ?? false;
	const jl = options.jl ?? false;
	const spawns = options.spawns ?? true;
	return prompt.render(evalDescription, { py, js, rb, jl, spawns });
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

function uniqueEvalLanguages(cells: ResolvedEvalCell[]): EvalLanguage[] {
	return [...new Set(cells.map(cell => cell.resolved.backend.id))];
}

function detailsNotice(cells: ResolvedEvalCell[]): string | undefined {
	const notices = [
		...new Set(cells.map(cell => cell.resolved.notice).filter((notice): notice is string => Boolean(notice))),
	];
	return notices.length > 0 ? notices.join(" ") : undefined;
}

function timeoutSecondsFromMs(timeoutMs: number): number {
	return clampTimeout("eval", timeoutMs / 1000);
}

/** Format the terminal cancellation fact surfaced in tool text and typed details. */
export function formatEvalCancellationMessage(cause: EvalCancellationCause, effectiveTimeoutSeconds: number): string {
	const unit = effectiveTimeoutSeconds === 1 ? "second" : "seconds";
	if (cause === "idle_watchdog_timeout") {
		return `Eval cell cancelled by idle watchdog timeout after ${effectiveTimeoutSeconds} ${unit}.`;
	}
	return `Eval cell cancelled by abort (effective timeout: ${effectiveTimeoutSeconds} ${unit}).`;
}

async function resolveBackend(session: ToolSession, language: EvalLanguage): Promise<ResolvedBackend> {
	const backends = resolveEvalBackends(session);

	if (language === "python") {
		if (!backends.python) throw new ToolError("Python backend is disabled (PI_PY=0 or eval.py = false).");
		if (!(await pythonBackend.isAvailable(session))) {
			throw new ToolError(
				'Python backend is unavailable in this session. Pass language: "js" or install the python kernel.',
			);
		}
		return { backend: pythonBackend };
	}
	if (language === "ruby") {
		if (!backends.ruby) throw new ToolError("Ruby backend is disabled (PI_RB=0 or eval.rb = false).");
		if (!(await rubyBackend.isAvailable(session))) {
			throw new ToolError(
				'Ruby backend is unavailable in this session. Pass language: "js" or install a ruby interpreter (see the ruby.interpreter setting).',
			);
		}
		return { backend: rubyBackend };
	}
	if (language === "julia") {
		if (!backends.julia) throw new ToolError("Julia backend is disabled (PI_JL=0 or eval.jl = false).");
		if (!(await juliaBackend.isAvailable(session))) {
			throw new ToolError(
				'Julia backend is unavailable in this session. Pass language: "js" or install a julia interpreter (see the julia.interpreter setting).',
			);
		}
		return { backend: juliaBackend };
	}
	if (!backends.js) throw new ToolError("JavaScript backend is disabled (PI_JS=0 or eval.js = false).");
	return { backend: jsBackend };
}

export class EvalTool implements AgentTool<typeof evalSchema> {
	readonly name = "eval";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = (args ?? {}) as Partial<EvalCellInput>;
		if (typeof params.language !== "string" && typeof params.code !== "string") return [];
		const language = typeof params.language === "string" ? params.language : "(missing)";
		const code = typeof params.code === "string" ? params.code : "";
		return [`Language: ${language}`, `Code:\n${truncateForPrompt(code)}`];
	};
	/** Backend list reflects the enabled set: rb/jl stay out of the summary until opted in. */
	get summary(): string {
		const backends = this.session ? resolveEvalBackends(this.session) : undefined;
		const names = ["Python", "JavaScript"];
		if (backends?.ruby) names.push("Ruby");
		if (backends?.julia) names.push("Julia");
		if (names.length === 2) return "Execute Python or JavaScript code in an in-process eval backend";
		return `Execute ${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]} code in a persistent eval backend`;
	}
	readonly loadMode = "essential";
	readonly label = "Eval";
	get description(): string {
		if (!this.session) return getEvalToolDescription();
		const backends = resolveEvalBackends(this.session);
		const sessionSpawns = this.session.getSessionSpawns?.() ?? "*";
		const spawnsAllowed = sessionSpawns !== "" && sessionSpawns !== null;
		return getEvalToolDescription({
			py: backends.python,
			js: backends.js,
			rb: backends.ruby,
			jl: backends.julia,
			spawns: spawnsAllowed,
		});
	}
	/** Examples advertise only enabled backends (a disabled rb/jl example would teach a throwing call). */
	get examples(): readonly ToolExample<EvalToolParams>[] {
		const backends = this.session ? resolveEvalBackends(this.session) : undefined;
		const examples: ToolExample<EvalToolParams>[] = [
			{
				call: {
					language: "py",
					title: "imports",
					timeout: 10,
					code: "import json\nfrom pathlib import Path",
				},
			},
			{
				call: {
					language: "py",
					title: "load config",
					code: "data = json.loads(read('package.json'))\ndisplay(data)",
				},
			},
			{
				call: {
					language: "py",
					title: "inspect",
					code: "print(sorted(data.keys()))",
				},
			},
		];
		if (backends?.ruby) {
			examples.push(
				{
					call: {
						language: "rb",
						title: "load config",
						code: "data = JSON.parse(read('package.json'))\ndata.keys",
					},
				},
				{
					call: {
						language: "rb",
						title: "peek output",
						code: 'output("job-1", limit: 2)',
					},
				},
			);
		}
		return examples;
	}
	get parameters(): EvalSchemaType {
		return evalSchemaForLanguages(advertisedLanguages(this.session));
	}
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly intent = (args: Partial<EvalToolParams>): string | undefined => {
		if (!args || typeof args !== "object") return "evaluating";
		const title = typeof args.title === "string" ? args.title : undefined;
		const language = typeof args.language === "string" ? args.language : undefined;
		if (!title && !language) return "evaluating";
		return title || `running ${language}`;
	};

	readonly #proxyExecutor?: EvalProxyExecutor;

	constructor(
		private readonly session: ToolSession | null,
		options?: EvalToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
	}

	async execute(
		_toolCallId: string,
		params: EvalToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Eval tool requires a session when not using proxy executor");
		}
		const session = this.session;
		const excludeWebP = webpExclusionForModel(session.getActiveModel?.());

		// Flat single-cell call; the execution core still speaks cell lists so a
		// future batch shape (and the legacy transcripts that carry one) keep working.
		const cellInputs: EvalCellInput[] = [params];
		const cells: ResolvedEvalCell[] = [];
		for (let i = 0; i < cellInputs.length; i++) {
			const cell = cellInputs[i];
			const language: EvalLanguage =
				cell.language === "py"
					? "python"
					: cell.language === "rb"
						? "ruby"
						: cell.language === "jl"
							? "julia"
							: "js";
			const resolved = await resolveBackend(session, language);
			cells.push({
				index: i,
				title: cell.title,
				code: cell.code,
				timeoutMs: (cell.timeout ?? TOOL_TIMEOUTS.eval.default) * 1000,
				reset: cell.reset ?? false,
				resolved,
			});
		}
		const languages = uniqueEvalLanguages(cells);
		const notice = detailsNotice(cells);
		const sessionAbortController = new AbortController();
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			outputSummary = await outputSink.dump();
			outputDumped = true;
			return outputSummary;
		};

		const execution = (async (): Promise<AgentToolResult<EvalToolDetails | undefined>> => {
			try {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				session.assertEvalExecutionAllowed?.();

				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);
				const jsonOutputs: unknown[] = [];
				const images: ImageContent[] = [];
				const statusEvents: EvalStatusEvent[] = [];

				const cellResults: EvalCellResult[] = cells.map(cell => ({
					index: cell.index,
					title: cell.title,
					code: cell.code,
					language: cell.resolved.backend.id,
					output: "",
					status: "pending",
				}));
				const cellOutputs: string[] = [];

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

				const pushUpdate = () => {
					if (!onUpdate) return;
					const tailText = tailBuffer.text();
					onUpdate({
						content: [{ type: "text", text: tailText }],
						details: buildUpdateDetails(),
					});
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
						pushUpdate();
					},
				});
				const sessionId = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);

				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const backend = cell.resolved.backend;
					// The per-cell `timeout` is a budget on the cell runtime's *own*
					// work. Host-side `agent()`/`parallel()`/`completion()` bridge calls suspend
					// that budget entirely and restart a fresh timeout window when control
					// returns to Python/JS. Compute, stdout, `log()`/`phase()`, and
					// ordinary tool calls all count against the budget. The watchdog drives
					// `combinedSignal`; we pass no wall-clock deadline downstream so the
					// backends never arm a competing fixed timer.
					const idleTimeoutMs = timeoutSecondsFromMs(cell.timeoutMs) * 1000;
					const idle = new IdleTimeout(idleTimeoutMs);
					const combinedSignal = signal
						? AbortSignal.any([signal, idle.signal, sessionAbortController.signal])
						: AbortSignal.any([idle.signal, sessionAbortController.signal]);

					const cellResult = cellResults[i];
					cellResult.status = "running";
					cellResult.output = "";
					cellResult.statusEvents = undefined;
					cellResult.exitCode = undefined;
					cellResult.durationMs = undefined;
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
								// Live bridge: stdout streamed by a still-running cell lands in
								// the running cell's rendered output *before* execute() returns,
								// so long-running cells show progress in the eval card instead
								// of dumping everything at once on completion/interrupt.
								// Completion overwrites with the authoritative full output below.
								cellResult.output = (cellResult.output ?? "") + chunk;
								pushUpdate();
							},
							onStatus: event => {
								if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
									idle.pause();
									return;
								}
								if (event.op === EVAL_TIMEOUT_RESUME_OP) {
									idle.resume();
									return;
								}
								cellResult.statusEvents ??= [];
								upsertStatusEvent(cellResult.statusEvents, event);
								pushUpdate();
							},
						});
					} finally {
						idle.dispose();
					}
					const durationMs = Date.now() - startTime;

					const cellStatusEvents: EvalStatusEvent[] = [];
					const cellDisplayOutputs: EvalDisplayOutput[] = [];
					const cellImageNotes: string[] = [];
					let cellHasMarkdown = false;
					for (const output of result.displayOutputs) {
						if (output.type === "json") {
							jsonOutputs.push(output.data);
							cellDisplayOutputs.push(output);
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
							cellDisplayOutputs.push({
								type: "image",
								data: image.data,
								mimeType: image.mimeType,
							});
							const dimensionNote = formatDimensionNote(resized);
							if (dimensionNote) {
								cellImageNotes.push(`display image ${cellImageNotes.length + 1}: ${dimensionNote}`);
							}
						}
						if (output.type === "status") {
							upsertStatusEvent(statusEvents, output.event);
							upsertStatusEvent(cellStatusEvents, output.event);
						}
						if (output.type === "markdown") {
							cellHasMarkdown = true;
						}
					}

					const stdoutTrimmed = result.output.trim();
					const imageText = cellImageNotes.join("\n");
					const displayText = formatDisplayOutputsForText(cellDisplayOutputs);
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

					let combinedCellOutput = "";
					if (cells.length > 1) {
						const cellHeader = `[${i + 1}/${cells.length}]`;
						const cellTitle = cell.title ? ` ${cell.title}` : "";
						if (cellOutput) {
							combinedCellOutput = `${cellHeader}${cellTitle}\n${cellOutput}`;
						} else {
							combinedCellOutput = `${cellHeader}${cellTitle} (ok)`;
						}
						cellOutputs.push(combinedCellOutput);
					} else if (cellOutput) {
						combinedCellOutput = cellOutput;
						cellOutputs.push(combinedCellOutput);
					}

					if (combinedCellOutput) {
						const prefix = cellOutputs.length > 1 ? "\n\n" : "";
						appendTail(`${prefix}${combinedCellOutput}`);
					}

					if (result.cancelled) {
						const effectiveTimeoutMs = result.effectiveTimeoutMs ?? idleTimeoutMs;
						const effectiveTimeoutSeconds = timeoutSecondsFromMs(effectiveTimeoutMs);
						const cancellationCause: EvalCancellationCause =
							result.cancellationCause ??
							(result.timedOut === true || idle.signal.aborted ? "idle_watchdog_timeout" : "abort");
						const timedOut = result.timedOut ?? cancellationCause === "idle_watchdog_timeout";
						const cancellationMessage = formatEvalCancellationMessage(cancellationCause, effectiveTimeoutSeconds);
						cellResult.status = "error";
						cellResult.output = cellOutput ? `${cellOutput}\n\n${cancellationMessage}` : cancellationMessage;
						cellResult.cancellationCause = cancellationCause;
						cellResult.effectiveTimeoutSeconds = effectiveTimeoutSeconds;
						cellResult.timedOut = timedOut;
						pushUpdate();
						const combinedOutput = cellOutputs.join("\n\n");
						const outputText =
							cells.length > 1
								? `${combinedOutput}\n\nCell ${i + 1} cancelled: ${cancellationMessage}`
								: combinedOutput
									? `${combinedOutput}\n\n${cancellationMessage}`
									: cancellationMessage;

						const summaryForMeta = await summarizeFinal(outputText, finalizeOutput);
						const details: EvalToolDetails = {
							language: languages[0],
							languages,
							cells: cellResults,
							jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
							statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
							isError: true,
							cancellationCause,
							effectiveTimeoutSeconds,
							timedOut,
						};
						if (notice) details.notice = notice;

						return toolResult(details)
							.content([{ type: "text", text: outputText }, ...images])
							.truncationFromSummary(summaryForMeta, { direction: "tail" })
							.done();
					}

					if (result.exitCode !== 0 && result.exitCode !== undefined) {
						cellResult.status = "error";
						if (result.processError) {
							cellResult.processError = result.processError;
						}
						pushUpdate();
						const combinedOutput = cellOutputs.join("\n\n");
						const outputText =
							cells.length > 1
								? `${combinedOutput}\n\nCell ${i + 1} failed (exit code ${result.exitCode}). Earlier cells succeeded—their state persists. Fix only cell ${i + 1}.`
								: combinedOutput
									? `${combinedOutput}\n\nCommand exited with code ${result.exitCode}`
									: `Command exited with code ${result.exitCode}`;

						const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
						const details: EvalToolDetails = {
							language: languages[0],
							languages,
							cells: cellResults,
							jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
							statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
							isError: true,
						};
						if (result.processError) details.processError = result.processError;
						if (notice) details.notice = notice;

						return toolResult(details)
							.content([{ type: "text", text: outputText }, ...images])
							.truncationFromSummary(summaryForMeta, { direction: "tail" })
							.done();
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

				return toolResult(details)
					.content([{ type: "text", text: outputText }, ...images])
					.truncationFromSummary(summaryForMeta, { direction: "tail" })
					.done();
			} finally {
				if (!outputDumped) {
					try {
						await finalizeOutput();
					} catch {}
				}
			}
		})();

		return await (session.trackEvalExecution?.(execution, sessionAbortController) ?? execution);
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
	};
}
