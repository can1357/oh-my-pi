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
import type { RenderResultOptions, ToolRenderer } from "./renderer";

/** Default collapsed shell output preview height. */
export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

const BACKGROUND_NOTICE_SUFFIX =
	"; its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it (no `sleep`, `ps`, `pgrep`, `top`, `pidwait`, log tailing): every poll is a wasted turn. Do other work, or end your reply and wait to be woken.";

/**
 * LLM-facing footer appended when a tool call becomes a background job.
 * The optional label keeps parallel jobs attributable in completion order.
 */
export function formatBackgroundNotice(jobId: string, label?: string): string {
	return `Backgrounded as job ${jobId}${label ? ` (${label})` : ""}${BACKGROUND_NOTICE_SUFFIX}`;
}

/** Finds the exact trailing background notice for `jobId`, including an optional label. */
export function findBackgroundNotice(text: string, jobId: string): string | undefined {
	const prefix = `Backgrounded as job ${jobId}`;
	const start = text.lastIndexOf(prefix);
	if (start === -1) return undefined;
	const lineEnd = text.indexOf("\n", start);
	const line = text.slice(start, lineEnd === -1 ? text.length : lineEnd);
	const hasExpectedBoundary = line.startsWith(`${prefix};`) || line.startsWith(`${prefix} (`);
	return hasExpectedBoundary && line.endsWith(BACKGROUND_NOTICE_SUFFIX) ? line : undefined;
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
		/** Live output monitor delivery attached at start; absent when unmonitored. */
		progress?: "wake" | "ambient";
		/** Reason live output monitoring stopped; progress is absent once stopped. */
		monitorStopped?: string;
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

function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const envStart = partialJson.search(/"env"\s*:\s*\{/u);
	if (envStart === -1) return undefined;
	const objectStart = partialJson.indexOf("{", envStart);
	if (objectStart === -1) return undefined;
	const envBody = partialJson.slice(objectStart + 1);
	const env: Record<string, string> = {};
	const matcher = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu;
	for (const match of envBody.matchAll(matcher)) {
		env[match[1]!] = unescapePartialJsonString(match[2]!);
	}
	return Object.keys(env).length > 0 ? env : undefined;
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

/**
 * Strip the background notice this result was tagged with. The notice carries
 * the job label, so it is located in the text instead of reconstructed from the
 * id alone.
 */
function stripBackgroundNotice(text: string, async: BashToolDetails["async"] | undefined): string {
	if (async?.state !== "running") return text;
	const notice = findBackgroundNotice(text, async.jobId);
	return notice === undefined ? text : stripTrailingNotice(text, notice);
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
			const cmdLines = formatBashCommandLines(renderArgs, uiTheme);
			return framedToolCard(uiTheme, () => {
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
			const cmdLines = args ? formatBashCommandLines(renderArgs, uiTheme) : undefined;
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
					const withoutBackground = stripBackgroundNotice(rawOutput, details?.async);
					const strippedOutput = stripOutputNotice(withoutBackground, details?.meta);
					const withoutExit =
						details?.exitCode === undefined
							? strippedOutput
							: stripTrailingNotice(strippedOutput, formatExitCodeNotice(details.exitCode));
					const withoutWall =
						details?.wallTimeMs === undefined
							? withoutExit
							: stripTrailingNotice(withoutExit, formatWallTimeNotice(details.wallTimeMs));
					const rawOutputArtifact = stripRawOutputArtifactNotice(withoutWall);
					const output = rawOutputArtifact.text;
					const displayOutput = output.trimEnd();
					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					// Build truncation warning
					const timeoutDisabled = details?.timeoutDisabled === true || renderContext?.timeout === 0;
					const timeoutSeconds = timeoutDisabled ? undefined : (details?.timeoutSeconds ?? renderContext?.timeout);
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
						if (service.progress) statsParts.push(`Progress: ${service.progress}`);
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
					if (rawOutputArtifact.artifactId) {
						statsParts.push(`Artifact: ${rawOutputArtifact.artifactId}`);
					}
					if (isError && typeof details?.exitCode === "number") {
						statsParts.push(`Exit: ${details.exitCode}`);
					}
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
								content: capPreviewLines(cmdLines ?? [], uiTheme, { expanded }),
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
