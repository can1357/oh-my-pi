/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Shell calls (`bash`, and shell-like tools built with {@link shellPresenter}):
 * one run box with the command line (`cd <dir> && NAME="…" command`), the
 * output's tail and a foot with the state and run time.
 *
 * Terminal look: `bash` (`src/ui/styles/tools/bash.ts`), fed by {@link BashTerm}.
 */
import { INTENT_FIELD, toolIntentLabel } from "@oh-my-pi/pi-wire";
import { sanitizeText, spillUrl } from "@oh-my-pi/pi-utils";
import type { JSXNode, UiEvent } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { ShellVizPresentation } from "@oh-my-pi/pi-wire";
import type { OutputMeta } from "../../tools/output-meta-format";
import { stripOutputNotice, stripTrailingNotice } from "../../tools/output-meta-format";
import { resultText } from "./default";
import type { ToolHead, ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";
import { registerToolPresenter } from "./registry";
import { type ToolCommandDispatch, ToolCommandNode, type ToolCommandResolver } from "./tool-command";
import {
	displayWorkdir,
	formatMinimized,
	outputNotices,
	RUN_BOX_TONE,
	RunBox,
	RunFoot,
	RunInput,
	RUN_INPUT_PREVIEW_LINES,
	RunOutput,
	type RunState,
	shellLineText,
	stripRawOutputNotice,
} from "./run";

/** Shell result details the presenter reads. */
export interface BashDetails {
	readonly meta?: OutputMeta;
	readonly timeoutSeconds?: number;
	readonly requestedTimeoutSeconds?: number;
	readonly timeoutDisabled?: boolean;
	readonly wallTimeMs?: number;
	readonly wallTimeNoticeEmitted?: boolean;
	readonly exitCode?: number;
	readonly timedOut?: boolean;
	readonly cwd?: string;
	readonly cdSeparator?: ";";
	readonly toolCommands?: readonly ToolCommandDispatch[];
	readonly service?: {
		readonly name: string;
		readonly state: string;
		readonly ready: boolean;
		readonly timedOut: boolean;
		readonly pid?: number;
	};
	readonly async?: { readonly state: "running" | "completed" | "failed" | "cancelled"; readonly jobId: string };
}

/** The transcript's shell viewport context (`state.renderContext`). */
export interface BashRenderContext {
	readonly output?: string;
	readonly isFullOutput?: boolean;
	readonly expanded?: boolean;
	readonly previewLines?: number;
	/** The call's timeout in seconds (0 disables it). */
	readonly timeout?: number;
	/** Host lookup of mounted tools behind the run's tool commands. */
	readonly resolveToolCommandMounted?: ToolCommandResolver;
}

/** Characters that make a command line more than one simple command (outside single quotes). */
const COMPOUND_CHARS = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "\n"]);

/** Whether `command` is one simple invocation of `tool`: no pipes, lists, redirections or substitutions. */
function isSoleInvocation(command: string | undefined, tool: string): boolean {
	const line = command?.trim();
	if (!line || (line !== tool && !line.startsWith(`${tool} `) && !line.startsWith(`${tool}\t`))) return false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			else if (ch === "$" || ch === "`") return false;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (COMPOUND_CHARS.has(ch)) return false;
	}
	return true;
}

/** A footer fact of the terminal look: an icon (symbol key) and text, dim unless `color`. */
export interface BashStat {
	readonly icon?: string;
	readonly text: string;
	readonly color?: string;
}

/** Terminal-only facts of a shell call (`term`). */
export interface BashTerm {
	readonly look: "bash";
	/** `cd <dir> && NAME="…"`: the dim part ahead of the command on the first line. */
	readonly prefix: string;
	/** A status line in the frame's top edge (`⢿ Shell`); bash draws none. */
	readonly header: boolean;
	/** The model's intent, after the header title. */
	readonly intent?: string;
	/** Result phase (the output section shows, even empty). */
	readonly result?: boolean;
	/** Settled outcome for the frame tint and header glyph. */
	readonly outcome?: "running" | "success" | "error" | "warning";
	/** Footer facts after the live clock. */
	readonly stats?: readonly BashStat[];
	/** The footer leads with the live run clock (`⏱ 4s`). */
	readonly liveClock?: boolean;
	/** The bracketed truncation warning under the output. */
	readonly warning?: string;
	/** Collapsed output rows (visual). */
	readonly previewLines?: number;
	/** The whole call was one tool command, whose card stands for the output. */
	readonly sole?: boolean;
}

/** How a shell-like tool's args map to a command line. */
export interface ShellConfig<TArgs> {
	readonly title: (args: TArgs | undefined) => string;
	readonly command: (args: TArgs | undefined) => string | undefined;
	readonly cwd?: (args: TArgs | undefined) => string | undefined;
	readonly env?: (args: TArgs | undefined) => Record<string, unknown> | undefined;
	/** Draw the status line in the frame's top edge. */
	readonly header: boolean;
}

/** Collapsed output rows of a shell result. */
const DEFAULT_PREVIEW_LINES = 10;

function escapeEnvValue(value: unknown): string {
	return sanitizeText(String(value))
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

function unescapeJsonFragment(value: string): string {
	try {
		return JSON.parse(`"${value.replace(/\\$/, "")}"`) as string;
	} catch {
		return value.replace(/\\(.)/g, "$1");
	}
}

/** Env assignments readable from a still-streaming args buffer. */
function partialEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const start = partialJson.search(/"env"\s*:\s*\{/u);
	if (start === -1) return undefined;
	const open = partialJson.indexOf("{", start);
	let depth = 0;
	let inString = false;
	let end = partialJson.length;
	for (let i = open; i < partialJson.length; i++) {
		const ch = partialJson[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) {
			end = i;
			break;
		}
	}
	let env: Record<string, string> | undefined;
	const body = partialJson.slice(open + 1, end);
	for (const match of body.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu))
		(env ??= {})[match[1]!] = unescapeJsonFragment(match[2]!);
	return env;
}

function envAssignments(env: Record<string, unknown> | undefined): string {
	if (!env) return "";
	return Object.keys(env)
		.sort((a, b) => a.localeCompare(b))
		.map(key => `${shellLineText(key)}="${escapeEnvValue(env[key])}"`)
		.join(" ");
}

interface CommandLine {
	/** `cd … && ENV=…` ("" when neither). */
	readonly prefix: string;
	readonly command: string;
	/** The whole line, as the node carries it. */
	readonly text: string;
}

function commandLine(
	command: string | undefined,
	cwd: string | undefined,
	env: Record<string, unknown> | undefined,
	separator?: ";",
): CommandLine {
	const dir = displayWorkdir(cwd);
	const parts: string[] = [];
	if (dir) parts.push(`cd ${shellLineText(dir)}${separator ?? " &&"}`);
	const assignments = envAssignments(env);
	if (assignments) parts.push(assignments);
	const body = replaceTabs(sanitizeText(command || "…"));
	const prefix = parts.join(" ");
	return { prefix, command: body, text: prefix ? `${prefix} ${body}` : body };
}

function argsRecord(args: unknown): Record<string, unknown> | undefined {
	return args !== null && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
}

/** The model's intent line (`i` arg). */
function callIntent(args: unknown): string | undefined {
	const value = argsRecord(args)?.[INTENT_FIELD];
	// The brief label (`Listing files` of `Listing files: Which files changed?`).
	return typeof value === "string" ? toolIntentLabel(value).replace(/\s+/g, " ").trim() || undefined : undefined;
}

/** Output with the LLM-facing notices (background, exit, wall time, artifact, truncation) removed. */
function stripNotices(raw: string, details: BashDetails | undefined): { text: string; artifactId?: string } {
	const job = details?.async;
	let text =
		job?.state === "running"
			? stripTrailingNotice(raw, line => {
					const prefix = `Backgrounded as job ${job.jobId}`;
					return line.startsWith(prefix) && (line[prefix.length] === ";" || line[prefix.length] === " ");
				})
			: raw;
	text = stripOutputNotice(text, details?.meta);
	if (details?.exitCode !== undefined)
		text = stripTrailingNotice(text, `Command exited with code ${details.exitCode}`);
	if (details?.wallTimeMs !== undefined && details.wallTimeNoticeEmitted !== false)
		text = stripTrailingNotice(text, `Wall time: ${(details.wallTimeMs / 1000).toFixed(2)} seconds`);
	return stripRawOutputNotice(text);
}

function runState(
	details: BashDetails | undefined,
	isError: boolean,
	isPartial: boolean,
	cancelled: boolean,
): RunState {
	if (cancelled) return "cancelled";
	if (details?.async?.state === "running") return "background";
	if (isPartial) return "running";
	if (details?.timedOut === true) return "timed-out";
	if (isError || (details?.exitCode !== undefined && details.exitCode !== 0)) return "failed";
	return "done";
}

/** Glyph key for a service's free-form lifecycle state. */
function serviceStateIcon(state: string): string {
	const value = state.toLowerCase();
	if (/(fail|error|crash|dead)/.test(value)) return "status.error";
	if (/(stop|exit|cancel|kill)/.test(value)) return "status.aborted";
	if (/(start|pending|wait|init|restart)/.test(value)) return "status.pending";
	if (/(run|ready|up|alive|active)/.test(value)) return "status.success";
	return "status.info";
}

/** `1.5s`, `30.0s`, `5m`, as the footer shows durations. */
function shortDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < 1000) return `${Math.floor(ms)}ms`;
	if (ms < 60_000) {
		const tenths = Math.round(ms / 100);
		return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : "1m";
	}
	if (ms < 3_600_000) {
		const mins = Math.floor(ms / 60_000);
		const secs = Math.floor((ms % 60_000) / 1000);
		return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	}
	const hours = Math.floor(ms / 3_600_000);
	const mins = Math.floor((ms % 3_600_000) / 60_000);
	return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

/** The footer facts of a settled or streaming result. */
function footerStats(
	details: BashDetails | undefined,
	contextTimeout: number | undefined,
	artifactId: string | undefined,
	isError: boolean,
): BashStat[] {
	const stats: BashStat[] = [];
	if (details?.async?.state === "running") stats.push({ icon: "icon.job", text: details.async.jobId });
	const service = details?.service;
	if (service) {
		stats.push({ icon: "icon.server", text: service.name });
		stats.push({ icon: serviceStateIcon(service.state), text: service.state });
		stats.push(
			service.ready
				? { icon: "status.success", text: "ready" }
				: service.timedOut
					? { icon: "status.warning", text: "ready timed out" }
					: { icon: "status.error", text: "not ready" },
		);
		if (service.pid !== undefined) stats.push({ text: `#${service.pid}` });
	}
	const timeoutDisabled = details?.timeoutDisabled === true || contextTimeout === 0;
	const timeoutSeconds = timeoutDisabled ? undefined : (details?.timeoutSeconds ?? contextTimeout);
	let timeoutLabel: string | undefined;
	if (timeoutDisabled) timeoutLabel = "disabled";
	else if (typeof timeoutSeconds === "number") {
		timeoutLabel = shortDuration(timeoutSeconds * 1000);
		const requested = details?.requestedTimeoutSeconds;
		if (requested !== undefined && requested !== timeoutSeconds)
			timeoutLabel += ` (requested ${shortDuration(requested * 1000)} clamped)`;
	}
	if (details?.wallTimeMs !== undefined) {
		const elapsed = shortDuration(details.wallTimeMs);
		stats.push({ icon: "icon.time", text: timeoutLabel === undefined ? elapsed : `${elapsed}/${timeoutLabel}` });
	} else if (timeoutDisabled) stats.push({ icon: "status.disabled", text: "disabled" });
	else if (timeoutLabel !== undefined) stats.push({ icon: "status.pending", text: timeoutLabel });
	if (artifactId) stats.push({ icon: "icon.output", text: spillUrl(artifactId) });
	const minimized = details?.meta?.minimized;
	if (minimized) stats.push({ icon: "icon.minimize", text: formatMinimized(minimized) });
	if (isError && typeof details?.exitCode === "number") {
		const failed = details.exitCode !== 0;
		stats.push({
			icon: failed ? "status.error" : "status.success",
			text: String(details.exitCode),
			color: failed ? "error" : "success",
		});
	}
	return stats;
}

/** The run box's quiet foot facts. */
function footFacts(details: BashDetails | undefined, artifactId: string | undefined): string[] {
	const facts: string[] = [];
	if (details?.async?.state === "running") facts.push(`Job ${details.async.jobId}`);
	const service = details?.service;
	if (service) {
		facts.push(`Service ${service.name}`, service.state);
		facts.push(service.ready ? "ready" : service.timedOut ? "ready timed out" : "not ready");
		if (service.pid !== undefined) facts.push(`PID ${service.pid}`);
	}
	if (artifactId) facts.push(`Artifact ${artifactId}`);
	if (details?.meta?.minimized) facts.push(`Minimized ${formatMinimized(details.meta.minimized)}`);
	return facts;
}

function shellHead(
	title: string,
	command: string,
	intent: string | undefined,
	details: BashDetails | undefined,
	settled: boolean,
): ToolHead {
	const exit = settled && details?.exitCode !== undefined && details.exitCode !== 0 ? details.exitCode : undefined;
	return {
		title,
		...(intent ? { target: intent, targetKind: "text" as const } : {}),
		command,
		...(exit !== undefined ? { exit } : {}),
		...(settled && details?.timedOut === true ? { note: "timed out" } : {}),
	};
}

/** The shell engine's presentation the transcript threads in (`bash` with shell visualization). */
interface ShellContext {
	readonly shellPresentation?: ShellVizPresentation;
	readonly shellReplayEpoch?: number;
	readonly shellStep?: { readonly focus: readonly string[] };
	/** Takes the `shell` node's events (its view toggle and menu: layers, split, inspect). */
	readonly shellEvent?: (event: UiEvent) => void;
}

/** The command as the shell engine presents it (Tern draws it; the terminal look reads the same rows). */
function ShellInput(props: {
	readonly context: ShellContext;
	readonly presentation: ShellVizPresentation;
	readonly liveOrigin: boolean;
	readonly stream?: boolean;
	readonly cwd?: string;
}): JSXNode {
	const step = props.context.shellStep;
	const onEvent = props.context.shellEvent;
	return (
		<shell
			key="input"
			role="omp.tool.bash.command"
			presentation={props.presentation}
			lang="bash"
			replayEpoch={props.context.shellReplayEpoch}
			liveOrigin={props.liveOrigin}
			stream={props.stream}
			cwd={props.cwd}
			preview={{ lines: RUN_INPUT_PREVIEW_LINES }}
			steps={step ? true : undefined}
			focus={step?.focus}
			{...(onEvent
				? {
						onAction: (_act: string, event: UiEvent) => onEvent(event),
						onSelect: (_item: string, event: UiEvent) => onEvent(event),
						onChange: onEvent,
					}
				: {})}
		/>
	);
}

/** A presenter for a shell-like tool. */
export function shellPresenter<TArgs>(config: ShellConfig<TArgs>): ToolPresenter<TArgs, BashDetails> {
	const line = (args: TArgs | undefined, details?: BashDetails): CommandLine => {
		const partial = argsRecord(args)?.__partialJson;
		const streamedEnv = partialEnv(typeof partial === "string" ? partial : undefined);
		const env = config.env?.(args);
		return commandLine(
			config.command(args),
			details?.cwd ?? config.cwd?.(args),
			streamedEnv && env ? { ...streamedEnv, ...env } : (env ?? streamedEnv),
			details?.cwd !== undefined ? details.cdSeparator : undefined,
		);
	};
	return {
		merge: true,
		inline: true,
		call(args, state): ToolView {
			const cmd = line(args);
			const started = state.executionStarted;
			const shell = state.renderContext as ShellContext | undefined;
			const presentation = shell?.shellPresentation;
			return {
				head: shellHead(config.title(args), cmd.text, callIntent(args), undefined, false),
				body: (
					<RunBox nodeKey="run">
						{presentation ? (
							<ShellInput
								context={shell!}
								presentation={presentation}
								liveOrigin={state.executionStarted}
								stream={!state.argsComplete && state.cancelled !== true}
							/>
						) : (
							<RunInput source={cmd.text} role="omp.tool.bash.command" lang="bash" wrap />
						)}
						{started && <RunFoot state={state.cancelled ? "cancelled" : "running"} elapsedMs={state.elapsedMs} />}
					</RunBox>
				),
				preview: "children",
				inline: true,
				term: {
					look: "bash",
					prefix: cmd.prefix,
					header: config.header,
					...(callIntent(args) ? { intent: callIntent(args) } : {}),
				} satisfies BashTerm,
			};
		},
		result(result: ToolResult<BashDetails>, state: ToolViewState, args?: TArgs): ToolView {
			const details = result.details;
			const context = state.renderContext as BashRenderContext | undefined;
			const isError = result.isError === true;
			const isPartial = state.isPartial;
			const raw = context?.output ?? resultText(result);
			const stripped = stripNotices(raw, details);
			const output = stripped.text.trimEnd();
			const expanded = context?.expanded ?? state.expanded;
			const showingFull = expanded && context?.isFullOutput === true;
			const cmd = line(args);
			const previewLines = context?.previewLines ?? DEFAULT_PREVIEW_LINES;
			const shell = state.renderContext as ShellContext | undefined;
			const presentation = shell?.shellPresentation;
			const runStateValue = runState(details, isError, isPartial, state.cancelled === true);
			const elapsedMs = isPartial
				? state.elapsedMs
				: runStateValue === "background"
					? undefined
					: (details?.wallTimeMs ?? state.elapsedMs);
			const meta = details?.meta;
			const dispatches = details?.toolCommands ?? [];
			const only = dispatches.length === 1 ? dispatches[0] : undefined;
			const sole = only?.mode === "execute" && isSoleInvocation(config.command(args), only.tool);
			const commandNodes = dispatches.map((dispatch, index) => {
				const running = isPartial && index === dispatches.length - 1;
				const nested: ToolViewState = {
					expanded,
					isPartial: running,
					argsComplete: true,
					executionStarted: true,
					...(state.cancelled ? { cancelled: true } : {}),
				};
				return (
					<ToolCommandNode
						nodeKey={`tool-command-${index}`}
						input={{ dispatch, ...(sole ? { output } : {}), resolveMounted: context?.resolveToolCommandMounted }}
						state={nested}
					/>
				);
			});
			const body: JSXNode = (
				<RunBox nodeKey="run" tone={RUN_BOX_TONE[runStateValue]}>
					{presentation ? (
						<ShellInput
							context={shell!}
							presentation={presentation}
							liveOrigin={state.executionStarted}
							cwd={displayWorkdir(config.cwd?.(args))}
						/>
					) : (
						<RunInput source={cmd.text} role="omp.tool.bash.command" lang="bash" wrap />
					)}
					{commandNodes}
					{!sole && output.trim().length > 0 && (
						<RunOutput output={output} role="omp.tool.bash.output" previewLines={previewLines} />
					)}
					<RunFoot
						state={runStateValue}
						exitCode={details?.exitCode}
						elapsedMs={elapsedMs}
						facts={footFacts(details, stripped.artifactId)}
						meta={meta ? { ...meta, truncation: showingFull ? undefined : meta.truncation } : undefined}
					/>
				</RunBox>
			);
			const timedOut = details?.timedOut === true;
			const warning = outputNotices(
				meta ? { ...meta, truncation: showingFull ? undefined : meta.truncation } : undefined,
			).join(". ");
			return {
				head: shellHead(config.title(args), cmd.text, callIntent(args), details, !isPartial),
				body,
				...(runStateValue === "timed-out" ? { tone: "warning" as const } : {}),
				preview: "children",
				inline: true,
				term: {
					look: "bash",
					prefix: cmd.prefix,
					header: config.header,
					...(callIntent(args) ? { intent: callIntent(args) } : {}),
					result: true,
					outcome: isPartial ? "running" : isError ? (timedOut ? "warning" : "error") : "success",
					stats: footerStats(details, context?.timeout, stripped.artifactId, isError),
					liveClock: isPartial && details?.wallTimeMs === undefined,
					...(warning ? { warning } : {}),
					previewLines,
					...(sole ? { sole } : {}),
				} satisfies BashTerm,
			};
		},
	};
}

/** Shell args of the `bash` tool. */
export interface BashArgs {
	readonly command?: string;
	readonly cwd?: string;
	readonly env?: Record<string, unknown>;
	readonly timeout?: number;
	readonly name?: string;
}

export const bashPresenter = shellPresenter<BashArgs>({
	title: args => (args?.name ? `Bash · ${String(args.name)}` : "Bash"),
	command: args => args?.command,
	cwd: args => args?.cwd,
	env: args => args?.env,
	header: false,
});

registerToolPresenter("bash", bashPresenter);
