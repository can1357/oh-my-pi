import type { Component } from "../tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { highlightCode, type Theme } from "../theme/theme";
import { renderStatusLine } from "../render/status-line";
import { framedToolCard, type ToolCardSnapshot } from "../render/tool-card";
import { formatOutputPaneLines } from "../render/output-pane";
import {
	capPreviewLines,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatToolWorkingDirectory,
	previewWindowRows,
	replaceTabs,
} from "../render/render-utils";
import {
	formatStyledTruncationWarning,
	type OutputMeta,
	stripOutputNotice,
	stripRawOutputArtifactNotice,
	stripTrailingNotice,
} from "./output-meta";
import type {
	NativeToolHead,
	NativeToolView,
	RenderResultContextOptions,
	RenderResultOptions,
	ToolRenderer,
} from "./renderer";
import { ansi, compact, keyed } from "../native/describe";
import type { NativeChild } from "../native/node";
import { footnoteText, resultText } from "./native-view";

/** Default collapsed shell output preview height. */
export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

/**
 * LLM-facing footer appended when a tool call becomes a background job. It states the job's kill
 * deadline (`timeoutSec`, `undefined` when disabled) so the model knows the job will die at it before
 * it waits on the result. The deadline counts the job's whole run time, not time left from now: an
 * auto-backgrounded call has already spent its foreground wait.
 */
export function formatBackgroundNotice(jobId: string, timeoutSec: number | undefined): string {
	const deadline =
		timeoutSec === undefined
			? " (no deadline)"
			: ` (killed once it has run ${timeoutSec}s in total; \`timeout: 0\` disables the deadline)`;
	return `Backgrounded as job ${jobId}${deadline}; its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it (no \`sleep\`, \`ps\`, \`pgrep\`, \`top\`, \`pidwait\`, log tailing): every poll is a wasted turn. Do other work, or end your reply and wait to be woken.`;
}

/**
 * Whether `line` is `formatBackgroundNotice(jobId, …)` for any deadline, including the deadline-less
 * `Backgrounded as job <id>; …` form persisted in older transcripts.
 */
function isBackgroundNotice(line: string, jobId: string): boolean {
	const prefix = `Backgrounded as job ${jobId}`;
	return line.startsWith(prefix) && (line[prefix.length] === ";" || line[prefix.length] === " ");
}

/** Shell execution metadata used by transcript rendering. */
export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled?: boolean;
	wallTimeMs?: number;
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode?: number;
	/** True when the command was killed by its timeout deadline (not a failure). */
	timedOut?: boolean;
	/** Live ACP update only; completed results refer to released terminals. */
	terminalId?: string;
	service?: {
		name: string;
		state: string;
		ready: boolean;
		timedOut: boolean;
		pid?: number;
	};
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}

function escapeBashEnvValueForDisplay(value: unknown): string {
	return String(value)
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

function formatBashEnvAssignments(env: Record<string, unknown> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}="${escapeBashEnvValueForDisplay(value)}"`)
		.join(" ");
}

function unescapePartialJsonString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== "\\") {
			output += char;
			continue;
		}
		const next = value[index + 1];
		if (!next) {
			output += "\\";
			break;
		}
		index += 1;
		switch (next) {
			case '"':
				output += '"';
				break;
			case "\\":
				output += "\\";
				break;
			case "/":
				output += "/";
				break;
			case "b":
				output += "\b";
				break;
			case "f":
				output += "\f";
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "u": {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
					output += String.fromCharCode(Number.parseInt(hex, 16));
					index += 4;
				} else {
					output += "\\u";
				}
				break;
			}
			default:
				output += next;
		}
	}
	return output;
}

// One-slot memo: every render path over one streamed args object (call
// preview, result header, repaint) asks for the same buffer.
let lastPartialEnvJson: string | undefined;
let lastPartialEnv: Readonly<Record<string, string>> | undefined;

function extractPartialBashEnv(partialJson: string | undefined): Readonly<Record<string, string>> | undefined {
	if (!partialJson) return undefined;
	if (partialJson === lastPartialEnvJson) return lastPartialEnv;
	let env: Record<string, string> | undefined;
	const envStart = partialJson.search(/"env"\s*:\s*\{/u);
	const objectStart = envStart === -1 ? -1 : partialJson.indexOf("{", envStart);
	if (objectStart !== -1) {
		// Scan only the env object: stop at its closing brace (outside strings)
		// so the keys that follow it are not read as env assignments.
		let objectEnd = partialJson.length;
		let depth = 0;
		for (let i = objectStart + 1; i < partialJson.length; i++) {
			const ch = partialJson.charCodeAt(i);
			if (ch === 0x22) {
				// Skip the string body, honoring escapes; an unterminated string runs to the end.
				for (i++; i < partialJson.length; i++) {
					const inner = partialJson.charCodeAt(i);
					if (inner === 0x5c) i++;
					else if (inner === 0x22) break;
				}
			} else if (ch === 0x7b || ch === 0x5b) {
				depth++;
			} else if (ch === 0x7d || ch === 0x5d) {
				if (depth === 0) {
					objectEnd = i;
					break;
				}
				depth--;
			}
		}
		const envBody = partialJson.slice(objectStart + 1, objectEnd);
		const matcher = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu;
		for (const match of envBody.matchAll(matcher)) {
			env ??= {};
			env[match[1]!] = unescapePartialJsonString(match[2]!);
		}
	}
	lastPartialEnvJson = partialJson;
	lastPartialEnv = env ? Object.freeze(env) : undefined;
	return lastPartialEnv;
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

/** Formats the model-facing command duration notice. */
export function formatWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

/** Formats the model-facing command exit status notice. */
export function formatExitCodeNotice(exitCode: number): string {
	return `Command exited with code ${exitCode}`;
}

/** Shell arguments used to build a command preview. */
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, unknown>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

/** Mutable transcript viewport state for shell output. */
export interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
	timeout?: number;
}

/** Caller-supplied shell labels and argument projections. */
export interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, unknown> | undefined;
	showHeader?: boolean;
}

function getPartialJson<TArgs>(args: TArgs | undefined): string | undefined {
	if (!args || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = (args as { __partialJson?: unknown }).__partialJson;
	return typeof value === "string" ? value : undefined;
}

/** Combines parsed and partially streamed environment assignments. */
export function getBashEnvForDisplay(args: BashRenderArgs): Record<string, unknown> | undefined {
	// The parsed args don't always mirror the exact current stream prefix, so recover
	// env from the raw JSON buffer to surface `NAME="..." cmd` in the preview as it
	// streams rather than only once the args object finishes.
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

/**
 * Returns the bash command formatted for the result body: the dim `$ cd … &&`
 * prefix joined with syntax-highlighted command lines. The prefix is applied
 * only to the first line so multi-line commands display cleanly — terminals
 * reset SGR state at line boundaries, which made the previous single-string
 * `theme.fg("dim", ...)` form render only the first line as dim.
 */
export function formatBashCommandLines(args: BashRenderArgs, uiTheme: Theme): string[] {
	const command = replaceTabs(args.command || "…");
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const envAssignments = formatBashEnvAssignments(getBashEnvForDisplay(args));
	const prefixParts = ["$"];
	if (displayWorkdir) prefixParts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) prefixParts.push(envAssignments);
	const prefix = uiTheme.fg("dim", `${prefixParts.join(" ")} `);
	const highlightedLines = highlightCode(command, "bash");
	if (highlightedLines.length === 0) return [prefix.trimEnd()];
	return highlightedLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

/**
 * Plain (unstyled) command line for native views: `cd <dir> && NAME="…" <command>`,
 * built from the same decoded display args (incl. streamed `__partialJson` env) as the ANSI path.
 */
export function formatBashCommandText(args: BashRenderArgs): string {
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, getProjectDir());
	const envAssignments = formatBashEnvAssignments(getBashEnvForDisplay(args));
	const parts: string[] = [];
	if (displayWorkdir) parts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) parts.push(envAssignments);
	parts.push(args.command || "…");
	return parts.join(" ");
}

/** Bash output with the LLM-facing notices (background, exit, wall time, artifact, truncation) removed. */
function stripBashNotices(
	rawOutput: string,
	details: BashToolDetails | undefined,
): { text: string; artifactId?: string } {
	const job = details?.async;
	let withoutBackground = rawOutput;
	if (job?.state === "running") {
		// The background-start notice is trailed by the `Command:` / `Working directory:`
		// identity lines, so keep stripping while the tail still matches.
		const isBackgroundTrailer = (line: string): boolean =>
			isBackgroundNotice(line, job.jobId) || line.startsWith("Command: ") || line.startsWith("Working directory: ");
		let previous = "";
		while (previous !== withoutBackground) {
			previous = withoutBackground;
			withoutBackground = stripTrailingNotice(withoutBackground, isBackgroundTrailer);
		}
	}
	const strippedOutput = stripOutputNotice(withoutBackground, details?.meta);
	const withoutExit =
		details?.exitCode === undefined
			? strippedOutput
			: stripTrailingNotice(strippedOutput, formatExitCodeNotice(details.exitCode));
	const withoutWall =
		details?.wallTimeMs === undefined
			? withoutExit
			: stripTrailingNotice(withoutExit, formatWallTimeNotice(details.wallTimeMs));
	return stripRawOutputArtifactNotice(withoutWall);
}
/** `Wall: 1.20s`, `Timeout: 30s`, … metadata parts shown under bash output. */
function bashStatsParts(
	details: BashToolDetails | undefined,
	contextTimeout: number | undefined,
	artifactId: string | undefined,
	isError: boolean,
): string[] {
	const timeoutDisabled = details?.timeoutDisabled === true || contextTimeout === 0;
	const timeoutSeconds = timeoutDisabled ? undefined : (details?.timeoutSeconds ?? contextTimeout);
	const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;
	const wallTimeMs = details?.wallTimeMs;
	const statsParts: string[] = [];
	if (details?.async?.state === "running") {
		statsParts.push(`Backgrounded: ${details.async.jobId}`);
	}
	if (details?.service) {
		const service = details.service;
		statsParts.push(`Service: ${service.name}`, `State: ${service.state}`);
		statsParts.push(`Ready: ${service.ready ? "yes" : service.timedOut ? "timed out" : "no"}`);
		if (service.pid !== undefined) statsParts.push(`PID: ${service.pid}`);
	}
	if (wallTimeMs !== undefined) {
		statsParts.push(`Wall: ${formatWallTimeSeconds(wallTimeMs)}s`);
	}
	if (timeoutDisabled) {
		statsParts.push("Timeout: disabled");
	}
	if (typeof timeoutSeconds === "number") {
		statsParts.push(
			requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds !== timeoutSeconds
				? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
				: `Timeout: ${timeoutSeconds}s`,
		);
	}
	if (artifactId) {
		statsParts.push(`Artifact: ${artifactId}`);
	}
	if (isError && typeof details?.exitCode === "number") {
		statsParts.push(`Exit: ${details.exitCode}`);
	}
	return statsParts;
}

/**
 * Native head facts of a shell call: title, the command once (`cd`/env
 * prefix included), a `background` badge for a backgrounded job, the
 * `exit N` chip and a `timed out` note only when the deadline hit.
 */
function shellToolHead(
	title: string,
	command: string,
	details: BashToolDetails | undefined,
	settled: boolean,
): NativeToolHead {
	const exit = settled && details?.exitCode !== undefined && details.exitCode !== 0 ? details.exitCode : undefined;
	return {
		title,
		target: command,
		targetKind: "command",
		lang: "bash",
		badges:
			details?.async?.state === "running"
				? [{ text: "background", title: `Backgrounded as job ${details.async.jobId}` }]
				: undefined,
		exit,
		note: settled && details?.timedOut === true ? "timed out" : undefined,
	};
}

/** The quiet final line's facts under shell output: service state and the full-output artifact. */
function shellFootParts(details: BashToolDetails | undefined, artifactId: string | undefined): string[] {
	const parts: string[] = [];
	const service = details?.service;
	if (service) {
		parts.push(`Service ${service.name}`, service.state);
		parts.push(service.ready ? "ready" : service.timedOut ? "ready timed out" : "not ready");
		if (service.pid !== undefined) parts.push(`PID ${service.pid}`);
	}
	if (artifactId) parts.push(`Artifact ${artifactId}`);
	return parts;
}

function toBashRenderArgs<TArgs>(args: TArgs | undefined, config: ShellRendererConfig<TArgs>): BashRenderArgs {
	return {
		command: config.resolveCommand?.(args),
		cwd: config.resolveCwd?.(args),
		env: config.resolveEnv?.(args),
		__partialJson: getPartialJson(args),
	};
}

/** Builds a shell transcript renderer with caller-supplied command labels. */
export function createShellRenderer<TArgs>(config: ShellRendererConfig<TArgs>) {
	return {
		renderCall(args: TArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const renderArgs = toBashRenderArgs(args, config);
			// Highlighting the whole (possibly still-streaming) command is the
			// expensive part: defer it to the first paint, once per component,
			// so a rebuild that is replaced before painting never pays for it.
			let cmdLines: string[] | undefined;
			return framedToolCard(uiTheme, () => {
				cmdLines ??= formatBashCommandLines(renderArgs, uiTheme);
				const header =
					config.showHeader === false
						? undefined
						: renderStatusLine(
								{
									icon: options.spinnerFrame !== undefined ? "running" : "pending",
									spinnerFrame: options.spinnerFrame,
									title: config.resolveTitle(args, options),
								},
								uiTheme,
							);
				return {
					header,
					phase: options.spinnerFrame !== undefined ? "running" : "pending",
					sections: [{ content: capPreviewLines(cmdLines, uiTheme, { expanded: options.expanded }) }],
				};
			});
		},

		renderResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: BashToolDetails;
				isError?: boolean;
			},
			options: RenderResultOptions & { renderContext?: BashRenderContext },
			uiTheme: Theme,
			args?: TArgs,
		): Component {
			const renderArgs = toBashRenderArgs(args, config);
			let cmdLines: string[] | undefined;
			const isError = result.isError === true;
			const isPartial = options.isPartial === true;
			const success = !isPartial && !isError;
			const details = result.details;
			const isTimeout = details?.timedOut === true;
			const header =
				config.showHeader === false
					? undefined
					: renderStatusLine(
							success
								? {
										iconOverride: uiTheme.styledSymbol("tool.bash", "accent"),
										title: config.resolveTitle(args, options),
									}
								: {
										icon: isPartial ? "pending" : isTimeout ? "warning" : "error",
										title: config.resolveTitle(args, options),
									},
							uiTheme,
						);
			// Per-instance cache for the expensive inner lines computation. Mirrors
			// the eval-renderer pattern (`eval-render.ts:709-752`): without this,
			// every TUI repaint (one per keystroke when a long transcript is on
			// screen) re-runs `split` / `replaceTabs` / visual capping over the
			// whole stored output for every bash row in scrollback. With a
			// 50KB-tail bash result times hundreds of rows, that re-rendering is
			// what pinned the main thread in issue #2081 and made keystrokes feel
			// like the CPU was at 100%. The cache holds the ToolCard snapshot (not
			// the final framed rows) so the fast path preserves array identity.
			// The cache key includes every render input that materially affects
			// the produced lines.
			let cachedWidth: number | undefined;
			let cachedPreviewLines: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedRawOutput: string | undefined;
			let cachedIsPartial: boolean | undefined;
			let cachedPreviewWindow: number | undefined;
			let cachedSnapshot: ToolCardSnapshot | undefined;

			return framedToolCard(
				uiTheme,
				({ width, contentWidth }) => {
					// REACTIVE: read mutable options at render time
					const { renderContext } = options;
					const expanded = renderContext?.expanded ?? options.expanded;
					const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;

					// Get output from context (preferred) or fall back to result content.
					// Strip the LLM-facing notice appended by wrappedExecute so we don't
					// double-print it alongside the styled warning line below.
					const rawOutput = renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "";

					const isPartial = options.isPartial === true;
					const previewWindow = previewWindowRows();

					if (
						cachedSnapshot !== undefined &&
						cachedWidth === width &&
						cachedPreviewLines === previewLines &&
						cachedExpanded === expanded &&
						cachedRawOutput === rawOutput &&
						cachedIsPartial === isPartial &&
						cachedPreviewWindow === previewWindow
					) {
						return cachedSnapshot;
					}
					const rawOutputArtifact = stripBashNotices(rawOutput, details);
					const output = rawOutputArtifact.text;
					const displayOutput = output.trimEnd();
					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					const statsParts = bashStatsParts(
						details,
						renderContext?.timeout,
						rawOutputArtifact.artifactId,
						isError,
					);
					const timeoutLine =
						statsParts.length > 0
							? uiTheme.fg(
									"dim",
									`${uiTheme.format.bracketLeft}${statsParts.join(" | ")}${uiTheme.format.bracketRight}`,
								)
							: undefined;
					let warningLine: string | undefined;
					if (details?.meta?.artifactError || (details?.meta?.truncation && !showingFullOutput)) {
						warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
					}

					// Cap the collapsed/streaming output to a viewport-sized tail and
					// measure it at the box's INNER width. Otherwise a growing tail
					// window scrolls its (mutating) rows above the live-region window
					// and the engine re-commits a fresh snapshot every frame —
					// spraying duplicate expand banners into native scrollback (the
					// box never overflows the viewport now). Sixel payload rows stay
					// unstyled and uncapped via uncapSixel.
					const hasOutput = displayOutput.trim().length > 0;
					const formatted = formatOutputPaneLines(
						{
							lines: hasOutput ? displayOutput.split("\n") : [],
							expanded,
							collapsedMaxLines: Math.min(previewLines, previewWindow),
							edge: "tail",
							visual: true,
							width: contentWidth,
							styleLine: line => uiTheme.fg("toolOutput", replaceTabs(line)),
							uncapSixel: true,
						},
						uiTheme,
					);
					const outputLines: string[] = [...formatted.lines];
					if (timeoutLine) outputLines.push(timeoutLine);
					if (warningLine) outputLines.push(warningLine);

					const snapshot: ToolCardSnapshot = {
						header,
						phase: isPartial ? "partial" : isError ? (isTimeout ? "warning" : "error") : "success",
						sections: [
							{
								// Viewport-sized tail window in every state — streaming and final
								// render identically; only ctrl+o uncaps.
								content: capPreviewLines(
									args ? (cmdLines ??= formatBashCommandLines(renderArgs, uiTheme)) : [],
									uiTheme,
									{ expanded },
								),
							},
							{ label: uiTheme.fg("toolTitle", "Output"), content: outputLines },
						],
					};

					cachedWidth = width;
					cachedPreviewLines = previewLines;
					cachedExpanded = expanded;
					cachedRawOutput = rawOutput;
					cachedIsPartial = isPartial;
					cachedPreviewWindow = previewWindow;
					cachedSnapshot = snapshot;
					return snapshot;
				},
				{
					onInvalidate: () => {
						cachedSnapshot = undefined;
						cachedWidth = undefined;
						cachedPreviewLines = undefined;
						cachedExpanded = undefined;
						cachedRawOutput = undefined;
						cachedIsPartial = undefined;
						cachedPreviewWindow = undefined;
					},
				},
			);
		},
		describeCall(args: TArgs, options: RenderResultOptions): NativeToolView {
			const command = formatBashCommandText(toBashRenderArgs(args, config));
			// The command shows once, in the head; the body is only the output.
			return {
				tool: shellToolHead(config.resolveTitle(args, options), command, undefined, false),
				preview: { tail: BASH_DEFAULT_PREVIEW_LINES },
			};
		},

		describeResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: BashToolDetails;
				isError?: boolean;
			},
			options: RenderResultContextOptions & { renderContext?: BashRenderContext },
			args?: TArgs,
		): NativeToolView {
			const details = result.details;
			const renderContext = options.renderContext;
			const isError = result.isError === true;
			const isPartial = options.isPartial === true;
			const rawOutput = renderContext?.output ?? resultText(result);
			const stripped = stripBashNotices(rawOutput, details);
			const output = stripped.text.trimEnd();
			const expanded = renderContext?.expanded ?? options.expanded;
			const showingFullOutput = expanded && renderContext?.isFullOutput === true;
			const command = formatBashCommandText(toBashRenderArgs(args, config));
			const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;
			// Wall time is the head timer, the timeout a note only when hit, the exit a head chip:
			// what is left (service state, artifact, truncation) is one quiet final line.
			const meta = details?.meta;
			const body: NativeChild[] = compact([
				output.trim().length > 0 &&
					keyed(ansi(output, { follow: isPartial, role: "omp.tool.bash.output" }), "output"),
				footnoteText(shellFootParts(details, stripped.artifactId), {
					...meta,
					truncation: showingFullOutput ? undefined : meta?.truncation,
				}),
			]);
			return {
				tool: shellToolHead(config.resolveTitle(args, options), command, details, !isPartial),
				body,
				tone: !isPartial && isError && details?.timedOut === true ? "warning" : undefined,
				preview: { tail: previewLines },
			};
		},
		mergeCallAndResult: true,
		inline: true,
	} satisfies ToolRenderer<TArgs, BashToolDetails>;
}

/** Renders bash command previews and output. */
export const bashToolRenderer = createShellRenderer<BashRenderArgs>({
	resolveTitle: args => (args?.name ? `Bash · ${String(args.name)}` : "Bash"),
	resolveCommand: args => args?.command,
	resolveCwd: args => args?.cwd,
	resolveEnv: args => args?.env,
	showHeader: false,
});
