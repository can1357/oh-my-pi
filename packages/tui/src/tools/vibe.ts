import type { Component } from "../tui";
import { Text } from "../components/text";
import { describeShimmer, shimmerEnabled, shimmerText } from "../theme/shimmer";
import type { TspCardStatus, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { compact, elapsed, node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorView, noteText, resultText, toolHead } from "./native-view";
import type { Theme } from "../theme/theme";
import { oneLineLabel } from "./task";
import { renderStatusLine } from "../render/index";
import {
	Ellipsis,
	formatBadge,
	formatDuration,
	formatStatusIcon,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
	truncateToWidth,
} from "../render/render-utils";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
/** Operation represented by a worker-session tool result. */
export type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

/** Details payload shared by every vibe tool for TUI rendering. */
export interface VibeToolDetails {
	op: VibeOp;
	/** Live TV-wall snapshot of the owner's worker sessions at (or during) the call. */
	screens: VibeScreenSnapshot[];
	/** Sessions the director killed, left off `screens`; shown as a count. */
	hiddenKilled?: string[];
	spawned?: { id: string; cli: VibeCli; jobId: string };
	send?: VibeSendOutcome;
	wait?: {
		settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled" }>;
		stillRunning: string[];
		timedOut: boolean;
		/** True on interim progress emissions while the wait is still blocking. */
		waiting?: boolean;
	};
	killed?: VibeKillOutcome;
}
/** Worker session lifecycle as shown to the director. */
export type VibeSessionState = "starting" | "running" | "idle" | "dead";

/**
 * Live per-session "screen" for rich rendering: what the worker is doing right
 * now (tool trace, current tool, streamed text tail) plus roster metadata.
 * Every string is already one-line sanitized.
 */
export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	/** Terminated by the director (`vibe_kill`) or mode teardown; unset for workers that died on their own. */
	killed?: boolean;
	model?: string;
	turns: number;
	queued: number;
	/** Start of the in-flight turn, when running. */
	turnStartedAt?: number;
	/** Gist of the message that started the in-flight turn. */
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	/** Completed tool calls of the in-flight turn, oldest first (tail). */
	trace: string[];
	/** Latest streamed worker text lines, oldest first. */
	outputTail: string[];
	lastActivity?: string;
	lastActivityAt: number;
}

/** Worker identity and job handle returned by a spawn. */
export interface VibeSpawnOutcome {
	id: string;
	jobId: string;
}

/** Delivery mode and optional turn job for a worker message. */
export interface VibeSendOutcome {
	id: string;
	/**
	 * - `turn`: a new background turn was started (`jobId` set).
	 * - `steered`: worker was mid-turn and streaming; delivered as steering.
	 * - `queued`: worker was mid-turn but not steerable; drained into the next turn.
	 */
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

/** Worker shutdown outcome including any cancelled turn. */
export interface VibeKillOutcome {
	id: string;
	/** True when an in-flight turn job was cancelled along the way. */
	cancelledTurn: boolean;
}

/** Settled and still-running worker turns observed by a wait. */
export interface VibeWaitOutcome {
	/** Watched sessions whose snapshotted turn settled during (or before) the wait.
	 * May overlap `stillRunning` when a queued follow-up turn already started. */
	settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled"; resultText: string }>;
	/** Watched sessions with a turn in flight when the wait returned. */
	stillRunning: string[];
	timedOut: boolean;
}
/** The two worker CLI flavors the director drives. */
export type VibeCli = "fast" | "good";
// =============================================================================
// TUI Renderer — mini composer (spawn/send) + TV wall (wait/list)
// =============================================================================

const COMPOSER_LINE_MAX = 96;
const TV_LINE_MAX = 110;
const TV_TRACE_COLLAPSED = 2;
const TV_TRACE_EXPANDED = 6;
const TV_OUTPUT_COLLAPSED = 1;
const TV_OUTPUT_EXPANDED = 3;
const CURSOR_GLYPH = "▌";

function stateToIcon(state: VibeSessionState): ToolUIStatus {
	switch (state) {
		case "running":
			return "running";
		case "starting":
			return "pending";
		case "idle":
			return "done";
		case "dead":
			return "aborted";
	}
}

function stateToColor(state: VibeSessionState): ToolUIColor {
	switch (state) {
		case "running":
			return "accent";
		case "starting":
			return "accent";
		case "idle":
			return "success";
		case "dead":
			return "muted";
	}
}

interface VibeRenderArgs {
	cli?: VibeCli;
	prompt?: string;
	name?: string;
	session?: string;
	message?: string;
	sessions?: string[];
}

/** One-line, escape-stripped fragment for embedding in a frame row. */
function frameText(text: string, max: number): string {
	return oneLineLabel(replaceTabs(text), max);
}

/**
 * Draw a left-railed mini terminal:
 * ```
 * ╭─ <header>
 * │ <body…>
 * ╰─ <footer>
 * ```
 */
function miniFrame(uiTheme: Theme, header: string, body: string[], footer?: string): string[] {
	const box = uiTheme.boxRound;
	const rail = (glyph: string) => uiTheme.fg("dim", glyph);
	const lines = [`${rail(`${box.topLeft}${box.horizontal}`)} ${header}`];
	for (const row of body) {
		lines.push(`${rail(box.vertical)} ${row}`);
	}
	lines.push(
		footer ? `${rail(`${box.bottomLeft}${box.horizontal}`)} ${footer}` : rail(`${box.bottomLeft}${box.horizontal}`),
	);
	return lines;
}

/** The `>` composer rows of the mini CLI: the director's message being typed in. */
function composerRows(uiTheme: Theme, message: string, options: { cursor: boolean; expanded: boolean }): string[] {
	const promptGlyph = uiTheme.fg("accent", ">");
	const rawLines = message.split(/\r?\n/).filter(line => line.trim().length > 0);
	const maxRows = options.expanded ? 6 : 2;
	const visible = rawLines.slice(0, maxRows).map(line => frameText(line, COMPOSER_LINE_MAX));
	if (visible.length === 0) visible.push("");
	if (rawLines.length > maxRows) {
		visible[visible.length - 1] = `${visible[visible.length - 1]} …`;
	} else if (options.cursor) {
		visible[visible.length - 1] = `${visible[visible.length - 1]}${uiTheme.fg("accent", CURSOR_GLYPH)}`;
	}
	return visible.map((line, index) =>
		index === 0 ? `${promptGlyph} ${uiTheme.fg("toolOutput", line)}` : `  ${uiTheme.fg("toolOutput", line)}`,
	);
}

/** Render one worker "TV": header + live tool calls + streamed text tail. */
function tvScreen(
	uiTheme: Theme,
	screen: VibeScreenSnapshot,
	options: RenderResultOptions,
	settledStatus?: "completed" | "failed" | "cancelled",
): string[] {
	const live = screen.state === "running" || screen.state === "starting";
	const spinnerFrame = live ? options.spinnerFrame : undefined;
	const icon = formatStatusIcon(
		settledStatus === "failed" ? "error" : settledStatus === "cancelled" ? "aborted" : stateToIcon(screen.state),
		uiTheme,
		spinnerFrame,
	);
	const badge = formatBadge(screen.cli, stateToColor(screen.state), uiTheme);
	const idText =
		live && options.spinnerFrame !== undefined && shimmerEnabled()
			? shimmerText(screen.id, uiTheme)
			: uiTheme.fg(live ? "accent" : "toolOutput", screen.id);
	const headParts = [icon, badge, idText, uiTheme.fg("dim", settledStatus ?? screen.state)];
	const turnsLabel = `${screen.turns}t${screen.queued > 0 ? `+${screen.queued}q` : ""}`;
	headParts.push(uiTheme.fg("muted", turnsLabel));
	if (screen.turnStartedAt !== undefined) {
		headParts.push(uiTheme.fg("dim", formatDuration(Date.now() - screen.turnStartedAt)));
	}
	if (screen.model) headParts.push(uiTheme.fg("muted", frameText(screen.model, 40)));

	const body: string[] = [];
	const hook = uiTheme.tree.hook;
	if (live) {
		if (screen.turnMessage) {
			body.push(`${uiTheme.fg("accent", ">")} ${uiTheme.fg("dim", frameText(screen.turnMessage, TV_LINE_MAX))}`);
		}
		const traceCap = options.expanded ? TV_TRACE_EXPANDED : TV_TRACE_COLLAPSED;
		for (const line of screen.trace.slice(-traceCap)) {
			body.push(`${uiTheme.fg("dim", hook)} ${uiTheme.fg("dim", frameText(line, TV_LINE_MAX))}`);
		}
		if (screen.currentTool) {
			const detail = screen.lastIntent ?? screen.currentToolArgs;
			const label = `${screen.currentTool}${detail ? `: ${detail}` : ""}`;
			const painted =
				options.spinnerFrame !== undefined && shimmerEnabled()
					? shimmerText(frameText(label, TV_LINE_MAX), uiTheme)
					: uiTheme.fg("muted", frameText(label, TV_LINE_MAX));
			body.push(`${uiTheme.fg("accent", hook)} ${painted}`);
		} else if (screen.lastIntent) {
			body.push(`${uiTheme.fg("accent", hook)} ${uiTheme.fg("muted", frameText(screen.lastIntent, TV_LINE_MAX))}`);
		}
		const outputCap = options.expanded ? TV_OUTPUT_EXPANDED : TV_OUTPUT_COLLAPSED;
		for (const line of screen.outputTail.slice(-outputCap)) {
			if (line.trim().length === 0) continue;
			body.push(`  ${uiTheme.fg("muted", frameText(line, TV_LINE_MAX))}`);
		}
	} else if (screen.lastActivity) {
		body.push(`${uiTheme.fg("dim", hook)} ${uiTheme.fg("muted", frameText(screen.lastActivity, TV_LINE_MAX))}`);
	}
	const footer = settledStatus
		? uiTheme.fg(
				settledStatus === "completed" ? "success" : settledStatus === "failed" ? "error" : "warning",
				`turn ${settledStatus} — result delivered`,
			)
		: undefined;
	return miniFrame(uiTheme, headParts.join(" "), body, footer);
}

/**
 * Width-aware component over prebuilt lines, or — given a builder — lines
 * recomputed on every paint. Spinner ticks repaint the tool block WITHOUT
 * re-invoking renderCall/renderResult, so time-based content (shimmer sweep,
 * spinner glyph, cursor blink, elapsed turn duration) must be produced inside
 * a builder that reads the shared mutable `options` at paint time; prebuilt
 * arrays are for static frames only.
 */
function linesComponent(lines: string[] | (() => string[])): Component {
	return {
		render(width: number): readonly string[] {
			const rows = typeof lines === "function" ? lines() : lines;
			return rows.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		invalidate() {},
	};
}

function describeCall(op: VibeOp, args: VibeRenderArgs | undefined): string {
	switch (op) {
		case "spawn":
			return `spawn ${args?.cli ?? "?"}${args?.name ? ` · ${frameText(args.name, 40)}` : ""}`;
		case "send":
			return `send → ${args?.session ? frameText(args.session, 40) : "?"}`;
		case "wait":
			return args?.sessions?.length
				? `wait on ${frameText(args.sessions.join(", "), 60)}`
				: "wait on running sessions";
		case "kill":
			return `kill ${args?.session ? frameText(args.session, 40) : "?"}`;
		case "list":
			return "sessions";
	}
}

// =============================================================================
// Native (TSP) Description — the terminal clocks spinners, shimmer and timers
// =============================================================================

/** Untruncated head detail for a vibe call (native twin of the ANSI call label). */
function vibeNativeLabel(op: VibeOp, args: VibeRenderArgs | undefined): string {
	switch (op) {
		case "spawn":
			return `spawn ${args?.cli ?? "?"}${args?.name ? ` · ${args.name}` : ""}`;
		case "send":
			return `send → ${args?.session ?? "?"}`;
		case "wait":
			return args?.sessions?.length ? `wait on ${args.sessions.join(", ")}` : "wait on running sessions";
		case "kill":
			return `kill ${args?.session ?? "?"}`;
		case "list":
			return "sessions";
	}
}

/** The director's composed message as `>`-prefixed wrapped text, or undefined when empty. */
function vibeComposer(message: string): NativeNode | undefined {
	const trimmed = plainText(message).trim();
	if (!trimmed) return undefined;
	return text([span("> ", "accent"), span(trimmed, "toolOutput")], { wrap: "word", role: "omp.vibe.composer" });
}

function vibeScreenStatus(
	screen: VibeScreenSnapshot,
	settled: "completed" | "failed" | "cancelled" | undefined,
): [TspCardStatus, TspTone] {
	if (settled === "failed") return ["error", "error"];
	if (settled === "cancelled") return ["cancelled", "warning"];
	if (settled === "completed") return ["done", "success"];
	switch (screen.state) {
		case "running":
			return ["running", "accent"];
		case "starting":
			return ["pending", "accent"];
		case "idle":
			return ["done", "success"];
		case "dead":
			return ["cancelled", "muted"];
	}
}

/** One worker "TV" as a nested card: identity head, roster meta, live trace, output tail. */
function describeVibeScreen(
	screen: VibeScreenSnapshot,
	settled: "completed" | "failed" | "cancelled" | undefined,
	nowMs: number,
): NativeNode {
	const live = screen.state === "running" || screen.state === "starting";
	const [status, tone] = vibeScreenStatus(screen, settled);
	const head: TspSpan[] = [
		live && shimmerEnabled()
			? span(screen.id, "accent", { fx: "shimmer" })
			: span(screen.id, live ? "accent" : "toolOutput"),
		span(` ${settled ?? screen.state}`, "dim"),
		span(` ${screen.turns}t${screen.queued > 0 ? `+${screen.queued}q` : ""}`, "muted"),
	];
	if (screen.model) head.push(span(` ${plainText(screen.model)}`, "muted"));
	const body: NativeChild[] = [
		row(
			compact([
				node("badge", { text: screen.cli, tone }),
				screen.turnStartedAt !== undefined ? elapsed(nowMs - screen.turnStartedAt, !live) : undefined,
			]),
			{ gap: "sm" },
		),
	];
	if (live) {
		if (screen.turnMessage) {
			body.push(text([span("> ", "accent"), span(plainText(screen.turnMessage), "dim")], { truncate: "end" }));
		}
		for (const line of screen.trace.slice(-TV_TRACE_EXPANDED)) {
			body.push(text([span(plainText(line), "dim")], { truncate: "end" }));
		}
		const detail = screen.lastIntent ?? screen.currentToolArgs;
		if (screen.currentTool) {
			body.push(describeShimmer([{ text: plainText(`${screen.currentTool}${detail ? `: ${detail}` : ""}`) }]));
		} else if (screen.lastIntent) {
			body.push(text([span(plainText(screen.lastIntent), "muted")], { truncate: "end" }));
		}
		for (const line of screen.outputTail.slice(-TV_OUTPUT_EXPANDED)) {
			if (line.trim().length > 0) body.push(text([span(plainText(line), "muted")], { truncate: "end" }));
		}
	} else if (screen.lastActivity) {
		body.push(text([span(plainText(screen.lastActivity), "muted")], { truncate: "end" }));
	}
	if (settled) {
		body.push(
			text([
				span(
					`turn ${settled} — result delivered`,
					settled === "completed" ? "success" : settled === "failed" ? "error" : "warning",
				),
			]),
		);
	}
	return node(
		"card",
		{
			role: "omp.vibe.screen",
			status,
			tone,
			head,
			collapsible: true,
			preview: { lines: 1 + TV_TRACE_COLLAPSED + TV_OUTPUT_COLLAPSED + 1 },
			inset: true,
		},
		body,
		screen.id,
	);
}

function describeVibeResult(
	op: VibeOp,
	result: ToolRenderResult<VibeToolDetails>,
	args: VibeRenderArgs | undefined,
): NativeToolView {
	const details = result.details;
	const label = vibeNativeLabel(op, args);
	if (result.isError) return { ...errorView("Vibe", resultText(result) || "vibe failed", label), inline: true };
	if (!details) {
		const fallback = resultText(result).trim();
		return { head: toolHead("Vibe", label), inline: true, body: fallback ? [noteText(fallback)] : [] };
	}

	if (op === "spawn" || op === "send") {
		const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
		const head: TspSpan[] =
			op === "spawn"
				? [
						...toolHead("Vibe", "spawn"),
						span(" "),
						span(details.spawned?.cli ?? args?.cli ?? "?", "accent strong"),
						span(" "),
						span(plainText(details.spawned?.id ?? args?.name ?? ""), "accent"),
					]
				: [...toolHead("Vibe", "send →"), span(" "), span(plainText(args?.session ?? "?"), "accent")];
		const ack: TspSpan =
			op === "spawn"
				? span(`turn started${details.spawned ? ` (job ${details.spawned.jobId})` : ""}`, "success")
				: details.send?.mode === "steered"
					? span("steered into the running turn", "success")
					: details.send?.mode === "queued"
						? span("mid-turn — queued as the next turn", "warning")
						: span(`turn started${details.send?.jobId ? ` (job ${details.send.jobId})` : ""}`, "success");
		return {
			head,
			inline: true,
			tone: details.send?.mode === "queued" ? "warning" : undefined,
			body: compact([vibeComposer(message), text([ack], { wrap: "word" })]),
			preview: { lines: 3 },
		};
	}

	if (op === "kill") {
		const note = details.killed?.cancelledTurn ? "in-flight turn cancelled" : undefined;
		return { head: toolHead("Vibe", `kill ${details.killed?.id ?? args?.session ?? "?"}`, note), inline: true };
	}

	const screens = details.screens;
	const hiddenKilled = details.hiddenKilled?.length ?? 0;
	const killedMeta = hiddenKilled > 0 ? span(` · ${hiddenKilled} killed hidden`, "dim") : undefined;
	if (screens.length === 0) {
		const gist = hiddenKilled > 0 ? "no live sessions" : resultText(result).trim() || "no sessions";
		const head = toolHead("Vibe", op, gist);
		if (killedMeta) head.push(killedMeta);
		return { head, tone: "warning", inline: true };
	}
	const settledById = new Map(details.wait?.settled.map(entry => [entry.id, entry.status] as const) ?? []);
	const running = screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
	const title =
		op === "wait"
			? details.wait?.waiting === true
				? "wait — watching the wall"
				: "wait"
			: `sessions (${screens.length})`;
	const head: TspSpan[] = toolHead("Vibe", title);
	if (running > 0) head.push(span(` · ${running} on air`, "accent"));
	if (settledById.size > 0) head.push(span(` · ${settledById.size} settled`, "success"));
	if (details.wait?.timedOut) head.push(span(" · timed out", "warning"));
	if (killedMeta) head.push(killedMeta);
	const nowMs = Date.now();
	return {
		head,
		inline: true,
		tone: details.wait?.timedOut ? "warning" : undefined,
		body: screens.map(screen => describeVibeScreen(screen, settledById.get(screen.id), nowMs)),
		preview: "auto",
	};
}

/** Build the shared vibe renderer for one tool name. */
export function createVibeToolRenderer(op: VibeOp) {
	const composerOp = op === "spawn" || op === "send";
	const callMemo = new OwnerMemo<NativeToolView | undefined>();
	const resultMemo = new OwnerMemo<NativeToolView | undefined>();
	return {
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: composerOp,
		animatedPartialResult: op === "wait",

		renderCall(args: VibeRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const title = uiTheme.fg("muted", `vibe ${describeCall(op, args)}`);
			if (composerOp) {
				const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
				return linesComponent(() => {
					const cursorOn = ((options.spinnerFrame ?? 0) & 1) === 0;
					return miniFrame(
						uiTheme,
						title,
						composerRows(uiTheme, message, { cursor: cursorOn, expanded: options.expanded }),
						uiTheme.fg("dim", op === "spawn" ? "booting CLI…" : "delivering…"),
					);
				});
			}
			return new Text(renderStatusLine({ icon: "pending", title: `vibe ${describeCall(op, args)}` }, uiTheme), 0, 0);
		},

		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: VibeToolDetails; isError?: boolean },
			options: RenderResultOptions,
			uiTheme: Theme,
			args?: VibeRenderArgs,
		): Component {
			const details = result.details;
			if (!details || result.isError) {
				const fallback = result.content.find(part => part.type === "text")?.text ?? "";
				const header = renderStatusLine(
					{ icon: result.isError ? "error" : "done", title: `vibe ${describeCall(op, args)}` },
					uiTheme,
				);
				const body = fallback
					? `\n  ${uiTheme.fg(result.isError ? "error" : "dim", frameText(fallback, TV_LINE_MAX))}`
					: "";
				return new Text(`${header}${body}`, 0, 0);
			}

			if (composerOp) {
				const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
				const target =
					op === "spawn"
						? `${uiTheme.fg("muted", "vibe spawn")} ${formatBadge(details.spawned?.cli ?? args?.cli ?? "?", "accent", uiTheme)} ${uiTheme.fg("accent", frameText(details.spawned?.id ?? args?.name ?? "", 40))}`
						: `${uiTheme.fg("muted", "vibe send →")} ${uiTheme.fg("accent", frameText(args?.session ?? "?", 40))}`;
				const ack =
					op === "spawn"
						? uiTheme.fg("success", `turn started${details.spawned ? ` (job ${details.spawned.jobId})` : ""}`)
						: details.send?.mode === "steered"
							? uiTheme.fg("success", "steered into the running turn")
							: details.send?.mode === "queued"
								? uiTheme.fg("warning", "mid-turn — queued as the next turn")
								: uiTheme.fg(
										"success",
										`turn started${details.send?.jobId ? ` (job ${details.send.jobId})` : ""}`,
									);
				const lines = miniFrame(
					uiTheme,
					target,
					composerRows(uiTheme, message, { cursor: false, expanded: options.expanded }),
					ack,
				);
				return linesComponent(lines);
			}

			if (op === "kill") {
				const killedNote = details.killed?.cancelledTurn ? " (in-flight turn cancelled)" : "";
				const header = renderStatusLine(
					{
						icon: "done",
						title: `vibe kill ${frameText(details.killed?.id ?? args?.session ?? "?", 40)}${killedNote}`,
					},
					uiTheme,
				);
				return new Text(header, 0, 0);
			}

			// wait/list: the TV wall. Director-killed sessions arrive pre-filtered
			// (see `hiddenKilled`) so a long-running director's wall stays legible.
			const screens = details.screens;
			const hiddenKilled = details.hiddenKilled?.length ?? 0;
			const killedMeta = hiddenKilled > 0 ? [uiTheme.fg("dim", `${hiddenKilled} killed hidden`)] : [];
			if (screens.length === 0) {
				const fallback = result.content.find(part => part.type === "text")?.text ?? "no sessions";
				const gist = hiddenKilled > 0 ? "no live sessions" : fallback;
				return new Text(
					renderStatusLine(
						{
							icon: "warning",
							title: `vibe ${op}`,
							meta: [uiTheme.fg("dim", frameText(gist, 60)), ...killedMeta],
						},
						uiTheme,
					),
					0,
					0,
				);
			}
			const waiting = details.wait?.waiting === true;
			const settledById = new Map(details.wait?.settled.map(entry => [entry.id, entry.status] as const) ?? []);
			return linesComponent(() => {
				const running = screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
				const meta: string[] = [];
				if (running > 0) meta.push(uiTheme.fg("accent", `${running} on air`));
				if (settledById.size > 0) meta.push(uiTheme.fg("success", `${settledById.size} settled`));
				if (details.wait?.timedOut) meta.push(uiTheme.fg("warning", "timed out"));
				meta.push(...killedMeta);
				const title =
					op === "wait"
						? waiting
							? "vibe wait — watching the wall"
							: "vibe wait"
						: `vibe sessions (${screens.length})`;
				const header = renderStatusLine(
					{
						icon: details.wait?.timedOut ? "warning" : running > 0 ? "info" : "done",
						spinnerFrame: running > 0 ? options.spinnerFrame : undefined,
						title,
						meta,
					},
					uiTheme,
				);
				const lines = [header];
				for (const screen of screens) {
					lines.push(...tvScreen(uiTheme, screen, options, settledById.get(screen.id)));
				}
				return lines;
			});
		},

		describeCall(args: VibeRenderArgs): NativeToolView | undefined {
			const message = op === "spawn" ? (args?.prompt ?? "") : op === "send" ? (args?.message ?? "") : "";
			return callMemo.get(args, [vibeNativeLabel(op, args), message], () => {
				const head = toolHead("Vibe", vibeNativeLabel(op, args));
				if (!composerOp) return { head, inline: true };
				return {
					head,
					inline: true,
					body: compact([
						vibeComposer(message),
						node("spinner", { label: [span(op === "spawn" ? "booting CLI…" : "delivering…", "dim")] }),
					]),
					preview: { lines: 3 },
				};
			});
		},

		describeResult(
			result: ToolRenderResult<VibeToolDetails>,
			_options: RenderResultOptions,
			args?: VibeRenderArgs,
		): NativeToolView | undefined {
			return resultMemo.get(result, [], () => describeVibeResult(op, result, args));
		},
	} satisfies ToolRenderer<VibeRenderArgs, VibeToolDetails>;
}
