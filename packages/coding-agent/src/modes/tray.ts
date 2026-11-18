/**
 * The tray: on a native host whose `hello` advertises `tray`, a row of live
 * cards over the composer, one per running subagent and background job, in
 * place of the HUD pill. The status row above it is its header (caption and
 * counts). Tern owns selection, order, paging and motion; this module owns the
 * data, the words, and which card is looked at closer.
 *
 * {@link buildTrayItems} turns plain inputs into flat item faces; the
 * describers turn faces into nodes; {@link Tray} keeps what the faces need to
 * remember (when an agent last acted, dismissed cards, the peek, the focus
 * counter) and memoises each card's node by its face, so an unchanged card is
 * the same node reference and the reconciler skips it.
 */
import type { TspProps, TspTrayStatus } from "@oh-my-pi/pi-wire";
import type { Component } from "@oh-my-pi/pi-tui";
import { compact, keyed, keyNames, node, span, stableKey } from "@oh-my-pi/pi-tui/native/describe";
import { sameItems, sameProps } from "@oh-my-pi/pi-tui/native/memo";
import type { NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { modelChip } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import { type AgentRecordLike, MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import {
	previewLine,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenToolArgumentPaths,
	TRUNCATE_LENGTHS,
} from "@oh-my-pi/pi-tui/render/render-utils";
import {
	describeJobWidget,
	describeJobWidgetMiniSpark,
	type JobWidgetView,
	jobWidgetGlance,
	jobWidgetGlanceSpans,
} from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { formatCount, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManagerApi } from "../async";
import { agentRunOf } from "../async/job-control";
import type { IrcBusApi } from "../irc/bus";
import type { AsyncJobSnapshot } from "../session/agent-session-types";

/** Card tone per state: accent running, success done, error failed, muted queued and stopped. */
type TrayTone = "accent" | "success" | "error" | "muted";

/** A running call earns an elapsed marker in the closer look once it outlasts this (as the ANSI live preview's). */
const TRAY_CALL_ELAPSED_MIN_MS = 5000;

/** Operations the closer look lists, ending with the call the agent is inside. */
const TRAY_TAIL_LIMIT = 5;

/** Finished agents the done card names before `+N`. */
const TRAY_DONE_NAMES = 3;

/** Cards above which the header carries the per-state counts. */
const TRAY_COUNTS_MIN_CARDS = 4;

/** Output lines a job card shows, and its closer look with and without a widget. */
const TRAY_OUT_LINES = 2;
const TRAY_PEEK_OUT_LINES = 3;
const TRAY_PEEK_OUT_LINES_BARE = 4;

/** Fields every card face has. Faces are flat, so {@link sameProps} decides whether a card re-describes. */
interface TrayCardFace {
	/** `agent:<id>`, `job:<id>` or `done`: the card's identity, hashed into its node key. */
	readonly key: string;
	readonly ref: string;
	readonly name: string;
	readonly status: TspTrayStatus;
	readonly aria: string;
}

/** A subagent's card. */
export interface TrayAgentItem extends TrayCardFace {
	readonly item: "agent";
	/** Epoch ms of its latest tool call start, or of the moment it settled. */
	readonly acted: number;
	readonly unread: number;
	/** The call's tool name; empty when the line is plain text. */
	readonly tool: string;
	readonly text: string;
	readonly model: string;
	readonly stats: string;
	/** Epoch ms its run clock counts from. */
	readonly start: number;
	/** Its run's length, once settled. */
	readonly duration: number | undefined;
}

/** A background job's card. */
export interface TrayJobItem extends TrayCardFace {
	readonly item: "job";
	readonly start: number;
	readonly duration: number | undefined;
	/** Its live widget, when it draws one (compared by reference: a refresh swaps the view). */
	readonly view: JobWidgetView | undefined;
	/** Its last output lines, newline-joined, at most {@link TRAY_PEEK_OUT_LINES_BARE}. */
	readonly output: string;
	/** Its command, when it says more than the name. */
	readonly command: string;
}

/** The card standing for finished agents that have no card of their own. */
export interface TrayDoneItem extends TrayCardFace {
	readonly item: "done";
	readonly count: number;
	/** Up to {@link TRAY_DONE_NAMES} names, then `+N`. */
	readonly names: string;
	/** Every name, newest first, for the closer look. */
	readonly allNames: string;
}

export type TrayItem = TrayAgentItem | TrayJobItem | TrayDoneItem;

/** What the tray is built from; plain data and lookups, so it builds without a live session. */
export interface TrayInput {
	/** The observer registry's sessions, in its order. */
	readonly sessions: readonly ObservableSession[];
	/** The agent registry's refs, in its order. */
	readonly refs: readonly AgentRecordLike[];
	/** Messages waiting for agent `id`. */
	unread(id: string): number;
	/** The newest background job running agent `id`. */
	agentJob(id: string): AsyncJob | undefined;
	/** The session's background jobs that run no agent. */
	readonly jobs: readonly AsyncJob[];
	/** Whether a settled job's result reached its owner. */
	consumed(jobId: string): boolean;
	/** A running job's live widget. */
	widget(job: AsyncJob): JobWidgetView | undefined;
	/** False under `display.pinnedAgents: off`: no agent cards, no done card. */
	readonly showAgents: boolean;
	readonly now: number;
}

/** Where {@link collectTrayInput} reads the tray's data. */
export interface TraySources {
	readonly observers: { getSessions(): ObservableSession[] };
	readonly refs: readonly AgentRecordLike[];
	/** The root job manager. */
	readonly manager: AsyncJobManagerApi | undefined;
	/** The main session's job snapshot (its own jobs). */
	snapshot(): AsyncJobSnapshot | null;
	readonly irc: IrcBusApi | undefined;
	readonly showAgents: boolean;
}

/** The tray's input from the live registries and the main session's jobs. */
export function collectTrayInput(sources: TraySources): TrayInput {
	const { manager, irc } = sources;
	const agentJobs = new Map<string, AsyncJob>();
	for (const job of manager?.getAllJobs() ?? []) {
		const agent = agentRunOf(job);
		const known = agent === undefined ? undefined : agentJobs.get(agent);
		if (agent !== undefined && (!known || known.startTime <= job.startTime)) agentJobs.set(agent, job);
	}
	const jobs: AsyncJob[] = [];
	const snapshot = manager ? sources.snapshot() : null;
	for (const entry of [...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])]) {
		const job = entry.agentId === undefined ? manager?.getJob(entry.id) : undefined;
		if (job) jobs.push(job);
	}
	return {
		sessions: sources.observers.getSessions(),
		refs: sources.refs,
		unread: id => irc?.unreadCount(id) ?? 0,
		agentJob: id => agentJobs.get(id),
		jobs,
		consumed: id => manager?.isJobResultConsumed(id) ?? false,
		widget: job => manager?.widgets?.view(job),
		showAgents: sources.showAgents,
		now: Date.now(),
	};
}

/** What the tray remembers about one agent between builds. */
interface AgentMemory {
	live: boolean;
	start: number;
	acted: number;
	duration: number | undefined;
}

/** State {@link buildTrayItems} carries between builds. */
export class TrayMemory {
	/** Card keys the user dismissed. */
	readonly dismissed = new Set<string>();
	readonly agents = new Map<string, AgentMemory>();
}

/** The card state an agent's observer session and registry ref add up to; undefined when it gets no card of that kind. */
function agentStatus(
	session: ObservableSession | undefined,
	ref: AgentRecordLike | undefined,
): TspTrayStatus | undefined {
	const pending = session?.status === "active" && session.progress?.status === "pending";
	// The registry also hears agents a message woke or revived, which the observer never sees start.
	if (ref?.kind === "sub" && ref.status === "running") return pending ? "queued" : "running";
	switch (session?.status) {
		case "active":
			return pending ? "queued" : "running";
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "aborted":
			return "stopped";
		default:
			return undefined;
	}
}

function toneOf(status: TspTrayStatus): TrayTone {
	switch (status) {
		case "running":
			return "accent";
		case "done":
			return "success";
		case "failed":
			return "error";
		default:
			return "muted";
	}
}

/** One line of model-written or tool text, sanitised for a card. */
function line(value: string, width: number = TRUNCATE_LENGTHS.CONTENT): string {
	return previewLine(shortenEmbeddedPaths(replaceTabs(sanitizeText(value))), width);
}

/** The first non-blank line of `value`. */
function firstLine(value: string): string {
	return value.split("\n").find(part => part.trim().length > 0) ?? "";
}

/** A call's detail as the ANSI live preview words it: its own intent, else its arguments, paths shortened. */
function callDetail(intent: string | undefined, args: string | undefined, argsKey: string | undefined): string {
	if (intent) return previewLine(shortenEmbeddedPaths(replaceTabs(intent)), TRUNCATE_LENGTHS.CONTENT);
	if (args) return previewLine(shortenToolArgumentPaths(replaceTabs(args), argsKey), TRUNCATE_LENGTHS.CONTENT);
	return "";
}

/** What a running agent is doing: its current call, else its last one, else a word. */
function runningDoing(
	progress: AgentProgress | undefined,
	activity: string | undefined,
): { tool: string; text: string } {
	const current = progress?.currentTool;
	if (current) {
		return {
			tool: line(current, TRUNCATE_LENGTHS.SHORT),
			text: callDetail(progress.currentToolIntent, progress.currentToolArgs, progress.currentToolArgsKey),
		};
	}
	const recent = progress?.recentTools[0];
	if (recent)
		return {
			tool: line(recent.tool, TRUNCATE_LENGTHS.SHORT),
			text: callDetail(recent.intent, recent.args, recent.argsKey),
		};
	return { tool: "", text: activity ? line(activity) : "Thinking" };
}

function agentDoing(
	status: TspTrayStatus,
	session: ObservableSession | undefined,
	ref: AgentRecordLike | undefined,
	job: AsyncJob | undefined,
): { tool: string; text: string } {
	const progress = session?.progress;
	switch (status) {
		case "queued":
			return { tool: "", text: "Queued" };
		case "running":
			// A revived agent's observer snapshot is its previous run's; the registry's gist is current.
			return runningDoing(session?.status === "active" ? progress : undefined, ref?.activity);
		case "done": {
			const description = session?.description ?? progress?.description ?? progress?.assignment ?? "Done";
			return { tool: "", text: line(firstLine(description)) };
		}
		case "failed": {
			const error = job?.errorText ?? progress?.retryFailure?.errorMessage ?? "Failed";
			return { tool: "", text: line(firstLine(error)) };
		}
		default:
			return { tool: "", text: "Stopped" };
	}
}

/** `sonnet-5.5 · low`: the model that produced the agent's work and its thinking level. */
function agentModel(session: ObservableSession | undefined, ref: AgentRecordLike | undefined): string {
	// An agent only the observer knows gets a stand-in ref, so its badge resolves the same way.
	const record: AgentRecordLike | undefined =
		ref ??
		(session && {
			id: session.id,
			displayName: session.id,
			kind: "sub",
			status: "running",
			session: null,
			sessionFile: session.sessionFile ?? null,
			createdAt: session.lastUpdate,
			lastActivity: session.lastUpdate,
		});
	const chip = record && modelChip(record, session);
	if (!chip) return "";
	const configured = session?.progress?.resolvedThinkingLevel;
	const level =
		chip.level ?? (configured && configured !== "off" && configured !== "inherit" ? configured : undefined);
	return line(level ? `${chip.text} · ${level}` : chip.text, TRUNCATE_LENGTHS.TITLE);
}

/** `38 tools · 22%`: tool count, then context fill when known, else tokens. */
function agentStats(progress: AgentProgress | undefined): string {
	if (!progress) return "";
	const tools = formatCount("tool", progress.toolCount);
	const { contextTokens, contextWindow, tokens } = progress;
	if (contextTokens !== undefined && contextWindow)
		return `${tools} · ${Math.round((contextTokens / contextWindow) * 100)}%`;
	return tokens > 0 ? `${tools} · ${formatNumber(tokens)} tok` : tools;
}

/** When the agent's current run started: its last progress frame's age, else its start event. */
function runStart(session: ObservableSession | undefined, now: number): number {
	if (session?.status !== "active") return now;
	if (session.progressAt !== undefined && session.progress) return session.progressAt - session.progress.durationMs;
	return session.lastUpdate;
}

/**
 * Remember agent `id` in `status`: its run clock, and `acted`, which moves
 * only when a later tool call starts or the agent settles.
 */
function rememberAgent(
	memory: TrayMemory,
	id: string,
	status: TspTrayStatus,
	session: ObservableSession | undefined,
	now: number,
): AgentMemory {
	const live = status === "queued" || status === "running";
	const progress = session?.progress;
	let entry = memory.agents.get(id);
	if (!entry) {
		const start = live ? runStart(session, now) : (session?.progressAt ?? now) - (progress?.durationMs ?? 0);
		const settledAt = session?.lastUpdate ?? now;
		entry = {
			live,
			start,
			acted: live ? (progress?.currentToolStartMs ?? start) : settledAt,
			duration: live ? undefined : (progress?.durationMs ?? Math.max(0, settledAt - start)),
		};
		memory.agents.set(id, entry);
	} else if (live && !entry.live) {
		entry.live = true;
		entry.start = runStart(session, now);
		entry.duration = undefined;
	} else if (!live && entry.live) {
		const settledAt = session?.status === "active" ? now : (session?.lastUpdate ?? now);
		entry.live = false;
		entry.acted = Math.max(entry.acted, settledAt);
		entry.duration = progress?.durationMs ?? Math.max(0, settledAt - entry.start);
	}
	const callStart = live ? progress?.currentToolStartMs : undefined;
	if (callStart !== undefined && callStart > entry.acted) entry.acted = callStart;
	return entry;
}

/** Whether a settled agent's outcome reached its parent: its job's result was consumed, or no background job ran it. */
function agentResultReached(job: AsyncJob | undefined, consumed: (jobId: string) => boolean): boolean {
	if (!job) return true;
	if (job.status === "running") return false;
	// A cancelled job delivers nothing: there is no result left to wait for.
	return job.status === "cancelled" || consumed(job.id);
}

function agentItem(
	input: TrayInput,
	memory: TrayMemory,
	id: string,
	session: ObservableSession | undefined,
	ref: AgentRecordLike | undefined,
): TrayAgentItem | undefined {
	const status = agentStatus(session, ref);
	if (!status) return undefined;
	const key = `agent:${id}`;
	const remembered = rememberAgent(memory, id, status, session, input.now);
	const job = input.agentJob(id);
	if (status === "queued" || status === "running") {
		memory.dismissed.delete(key);
	} else if (memory.dismissed.has(key) || agentResultReached(job, input.consumed)) {
		return undefined;
	}
	const name = line(ref?.displayName ?? id, TRUNCATE_LENGTHS.TITLE);
	const doing = agentDoing(status, session, ref, job);
	return {
		item: "agent",
		key,
		ref: id,
		name,
		status,
		aria: `${name}, ${status}, ${doing.tool ? `${doing.tool} · ` : ""}${doing.text}`,
		acted: remembered.acted,
		unread: input.unread(id),
		tool: doing.tool,
		text: doing.text,
		model: agentModel(session, ref),
		stats: agentStats(session?.progress),
		start: remembered.start,
		duration: remembered.duration,
	};
}

function jobStatus(job: AsyncJob): TspTrayStatus {
	switch (job.status) {
		case "running":
			return job.queued ? "queued" : "running";
		case "completed":
			return "done";
		case "failed":
			return "failed";
		default:
			return "stopped";
	}
}

/** A job's last `count` non-blank output lines, sanitised; a failed job's error stands in for missing output. */
function jobOutput(job: AsyncJob, count: number): string {
	const source = job.progressText || (job.status === "failed" ? job.errorText : job.resultText) || job.errorText || "";
	const lines: string[] = [];
	for (const raw of sanitizeText(source).split("\n")) {
		if (raw.trim()) lines.push(previewLine(replaceTabs(raw), TRUNCATE_LENGTHS.LINE));
	}
	return lines.slice(-count).join("\n");
}

function jobItem(input: TrayInput, memory: TrayMemory, job: AsyncJob): TrayJobItem | undefined {
	const key = `job:${job.id}`;
	if (job.status !== "running") {
		if (memory.dismissed.has(key) || job.status === "cancelled" || input.consumed(job.id)) return undefined;
	}
	const status = jobStatus(job);
	const name = line(job.intent ?? job.label, TRUNCATE_LENGTHS.TITLE);
	const view = job.status === "running" ? input.widget(job) : undefined;
	const output = jobOutput(job, TRAY_PEEK_OUT_LINES_BARE);
	const command = job.process ? line(job.process.command, TRUNCATE_LENGTHS.LINE) : "";
	const glance = view && jobWidgetGlance(view);
	const lastLine = output.slice(output.lastIndexOf("\n") + 1);
	const summary = glance?.text ?? (view?.stage ? line(view.stage) : lastLine);
	return {
		item: "job",
		key,
		ref: job.id,
		name,
		status,
		aria: summary ? `${name}, ${status}, ${summary}` : `${name}, ${status}`,
		start: job.startTime,
		duration: job.endTime !== undefined ? Math.max(0, job.endTime - job.startTime) : undefined,
		view,
		output,
		command: command === name ? "" : command,
	};
}

/** Finished agents without a card of their own, newest first. */
function doneItem(input: TrayInput, carded: ReadonlySet<string>): TrayDoneItem | undefined {
	const done = input.refs
		.filter(ref => ref.id !== MAIN_AGENT_ID && ref.kind !== "main" && ref.status !== "running" && !carded.has(ref.id))
		.sort((a, b) => b.lastActivity - a.lastActivity)
		.map(ref => line(ref.displayName, TRUNCATE_LENGTHS.TITLE));
	if (done.length === 0) return undefined;
	const shown = done.slice(0, TRAY_DONE_NAMES).join(", ");
	const names = done.length > TRAY_DONE_NAMES ? `${shown} +${done.length - TRAY_DONE_NAMES}` : shown;
	const name = `${done.length} done`;
	return {
		item: "done",
		key: "done",
		ref: "done",
		name,
		status: "done",
		aria: `${name}, finished and delivered, ${names}`,
		count: done.length,
		names,
		allNames: done.join(", "),
	};
}

/**
 * The tray's cards in wire order: agents in the observer registry's order
 * (then running agents only the agent registry knows), the done card, then
 * the session's background jobs by start time.
 */
export function buildTrayItems(input: TrayInput, memory: TrayMemory): TrayItem[] {
	const items: TrayItem[] = [];
	const seen = new Set<string>();
	if (input.showAgents) {
		const refs = new Map<string, AgentRecordLike>();
		for (const ref of input.refs) refs.set(ref.id, ref);
		const carded = new Set<string>();
		const add = (id: string, session: ObservableSession | undefined): void => {
			seen.add(id);
			const item = agentItem(input, memory, id, session, refs.get(id));
			if (!item) return;
			items.push(item);
			carded.add(id);
		};
		for (const session of input.sessions) if (session.kind === "subagent") add(session.id, session);
		for (const ref of input.refs) {
			if (!seen.has(ref.id) && ref.kind === "sub" && ref.status === "running") add(ref.id, undefined);
		}
		const done = doneItem(input, carded);
		if (done) items.push(done);
	}
	for (const id of memory.agents.keys()) if (!seen.has(id)) memory.agents.delete(id);
	const jobs = input.jobs.filter(job => !job.foreground && job.agentId === undefined);
	jobs.sort((a, b) => a.startTime - b.startTime);
	for (const job of jobs) {
		const item = jobItem(input, memory, job);
		if (item) items.push(item);
	}
	return items;
}

/** Whether two builds show the same cards, in the same order, with the same faces. */
function sameFaces(a: readonly TrayItem[], b: readonly TrayItem[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!sameProps<TrayItem>(a[i], b[i]!)) return false;
	return true;
}

// =============================================================================
// Describers
// =============================================================================

function isLive(status: TspTrayStatus): boolean {
	return status === "queued" || status === "running";
}

function describeDot(status: TspTrayStatus): NativeNode {
	const tone = toneOf(status);
	return node(
		"text",
		{
			role: "omp.tray.dot",
			spans: [span("●", tone, status === "running" ? { fx: "pulse" } : undefined)],
			wrap: "none",
		},
		undefined,
		"dot",
	);
}

function describeName(name: string): NativeNode {
	return node(
		"text",
		{ role: "omp.tray.name", text: name, wrap: "none", truncate: "end", grow: 1 },
		undefined,
		"name",
	);
}

/** The item's clock: running from `start`, or frozen at `duration` once settled. */
function describeTime(start: number, duration: number | undefined, now: number): NativeNode {
	const age = Math.max(0, Math.round(duration ?? now - start));
	return node(
		"elapsed",
		duration === undefined
			? { role: "omp.tray.time", age, format: "short" }
			: { role: "omp.tray.time", age, stopped: age, format: "short" },
		undefined,
		"time",
	);
}

function cardProps(item: TrayItem): TspProps<"col"> {
	return {
		role: "omp.tray.card",
		item: item.item,
		ref: item.ref,
		status: item.status,
		tone: toneOf(item.status),
		...(item.item === "agent" ? { acted: item.acted } : {}),
		aria: item.aria,
	};
}

/** An agent's card: name and clock, what it is doing, its model and progress. */
export function describeTrayAgentCard(item: TrayAgentItem, now: number): NativeNode {
	const head = node(
		"row",
		{ role: "omp.tray.head", gap: "xs", align: "center" },
		compact([
			describeDot(item.status),
			describeName(item.name),
			item.unread > 0 &&
				node("badge", { role: "omp.tray.unread", text: String(item.unread), tone: "warning" }, undefined, "unread"),
			describeTime(item.start, item.duration, now),
		]),
		"head",
	);
	const doing = node(
		"text",
		{
			role: "omp.tray.doing",
			spans: item.tool ? [span(item.tool, "dim"), span(" · ", "dim"), span(item.text)] : [span(item.text)],
			wrap: "none",
			truncate: "end",
			...(item.status === "failed" ? { tone: "error" as const } : {}),
		},
		undefined,
		"doing",
	);
	const meta = node(
		"row",
		{ role: "omp.tray.meta", gap: "sm", align: "center" },
		compact([
			item.model !== "" &&
				node(
					"text",
					{ role: "omp.tray.model", text: item.model, wrap: "none", truncate: "end", grow: 1, shrink: 1 },
					undefined,
					"model",
				),
			item.stats !== "" &&
				node("text", { role: "omp.tray.stats", text: item.stats, wrap: "none" }, undefined, "stats"),
		]),
		"meta",
	);
	return node("col", cardProps(item), [head, doing, meta], stableKey(item.key));
}

/** A job's glance row: its widget's glance, mini spark and stage; undefined when the widget shows none. */
function describeJobGlance(view: JobWidgetView): NativeNode | undefined {
	const glance = jobWidgetGlance(view);
	const spark = describeJobWidgetMiniSpark(view);
	const stage = view.stage ? line(view.stage) : "";
	if (!glance && !spark && !stage) return undefined;
	return node(
		"row",
		{ role: "omp.tray.glance", gap: "xs", align: "center" },
		compact([
			glance &&
				node(
					"text",
					{
						role: "omp.hud.glance",
						spans: jobWidgetGlanceSpans({ text: glance.text, ...(glance.trend ? { trend: glance.trend } : {}) }),
						wrap: "none",
					},
					undefined,
					"glance",
				),
			spark && keyed(spark, "spark"),
			stage !== "" &&
				node("text", { role: "omp.tray.stage", text: stage, wrap: "none", truncate: "end" }, undefined, "stage"),
		]),
		"glance",
	);
}

function describeOut(item: TrayJobItem, lines: number): NativeNode {
	const parts = item.output ? item.output.split("\n") : [];
	return node(
		"text",
		{
			role: "omp.tray.out",
			text: parts.slice(-lines).join("\n"),
			wrap: "none",
			...(item.status === "failed" ? { tone: "error" as const } : {}),
		},
		undefined,
		"out",
	);
}

/** A job's card: its name, id and clock over its widget's glance, else its last output lines. */
export function describeTrayJobCard(item: TrayJobItem, now: number): NativeNode {
	const head = node(
		"row",
		{ role: "omp.tray.head", gap: "xs", align: "center" },
		[
			describeDot(item.status),
			describeName(item.name),
			node("text", { role: "omp.tray.id", text: item.ref, wrap: "none" }, undefined, "id"),
			describeTime(item.start, item.duration, now),
		],
		"head",
	);
	const body = (item.view && describeJobGlance(item.view)) ?? describeOut(item, TRAY_OUT_LINES);
	return node("col", cardProps(item), [head, body], stableKey(item.key));
}

/** The done card: how many finished agents, and a few of their names. */
export function describeTrayDoneCard(item: TrayDoneItem): NativeNode {
	const head = node(
		"row",
		{ role: "omp.tray.head", gap: "xs", align: "center" },
		[describeDot("done"), describeName(item.name)],
		"head",
	);
	const doing = node(
		"text",
		{ role: "omp.tray.doing", spans: [span(item.names)], wrap: "none", truncate: "end" },
		undefined,
		"doing",
	);
	return node("col", cardProps(item), [head, doing], stableKey(item.key));
}

export function describeTrayCard(item: TrayItem, now: number): NativeNode {
	switch (item.item) {
		case "agent":
			return describeTrayAgentCard(item, now);
		case "job":
			return describeTrayJobCard(item, now);
		default:
			return describeTrayDoneCard(item);
	}
}

/** One operation in an agent's closer look. */
export interface TrayEvent {
	readonly tool: string;
	readonly text: string;
	readonly state: "ok" | "err" | "run";
	/** A running call's age, once it outlasts {@link TRAY_CALL_ELAPSED_MIN_MS}. */
	readonly age: number | undefined;
}

/** What an agent's closer look adds to its card. */
export interface TrayAgentDetail {
	readonly task: string;
	/** Oldest first, ending with the call the agent is inside. */
	readonly tail: readonly TrayEvent[];
}

/** An agent's task and last operations, from its observer session. */
export function trayAgentDetail(session: ObservableSession | undefined, now: number): TrayAgentDetail {
	const progress = session?.progress;
	const task = line(
		firstLine(session?.description ?? progress?.description ?? progress?.assignment ?? progress?.task ?? ""),
	);
	if (!progress) return { task, tail: [] };
	const current = session?.status === "active" ? progress.currentTool : undefined;
	const past = progress.recentTools.slice(0, current ? TRAY_TAIL_LIMIT - 1 : TRAY_TAIL_LIMIT).reverse();
	const tail: TrayEvent[] = past.map(call => ({
		tool: line(call.tool, TRUNCATE_LENGTHS.SHORT),
		text: callDetail(call.intent, call.args, call.argsKey),
		state: call.isError ? "err" : "ok",
		age: undefined,
	}));
	if (current) {
		const age = progress.currentToolStartMs === undefined ? 0 : now - progress.currentToolStartMs;
		tail.push({
			tool: line(current, TRUNCATE_LENGTHS.SHORT),
			text: callDetail(progress.currentToolIntent, progress.currentToolArgs, progress.currentToolArgsKey),
			state: "run",
			age: age > TRAY_CALL_ELAPSED_MIN_MS ? age : undefined,
		});
	}
	return { task, tail };
}

/** Whether two agent details read the same (a running call's age counts only as present or not). */
function sameDetail(a: TrayAgentDetail | undefined, b: TrayAgentDetail | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.task !== b.task || a.tail.length !== b.tail.length) return false;
	for (let i = 0; i < a.tail.length; i++) {
		const x = a.tail[i]!;
		const y = b.tail[i]!;
		if (
			x.tool !== y.tool ||
			x.text !== y.text ||
			x.state !== y.state ||
			(x.age === undefined) !== (y.age === undefined)
		)
			return false;
	}
	return true;
}

function button(key: string, text: string, act: string, extra: Record<string, unknown> = {}): NativeNode {
	return node("button", { text, size: "sm", actions: { click: act }, ...extra }, undefined, key);
}

/** The closer look's actions: Open, Stop or Cancel while live, Dismiss once settled, and close. */
function peekButtons(item: TrayItem): NativeNode[] {
	const buttons = [button("open", "Open", `tray.open=${item.ref}`, { keys: keyNames("enter") })];
	if (item.item !== "done") {
		if (isLive(item.status)) {
			buttons.push(
				button("stop", item.item === "agent" ? "Stop" : "Cancel", `tray.stop=${item.ref}`, { tone: "error" }),
			);
		} else {
			buttons.push(button("dismiss", "Dismiss", `tray.dismiss=${item.ref}`));
		}
	}
	buttons.push(button("close", "", "tray.peek=", { icon: "x", aria: "Close", title: "Close" }));
	return buttons;
}

function peekMeta(item: TrayItem): string {
	switch (item.item) {
		case "agent":
			return [item.model, item.stats].filter(Boolean).join(" · ");
		case "job":
			return item.command;
		default:
			return "";
	}
}

function describeEvent(event: TrayEvent, index: number): NativeNode {
	return node(
		"row",
		{ role: "omp.tray.ev", state: event.state, gap: "xs", align: "center" },
		compact([
			node("text", { role: "omp.tray.ev.tool", text: event.tool, wrap: "none" }, undefined, "tool"),
			node(
				"text",
				{ role: "omp.tray.ev.text", text: event.text, wrap: "none", truncate: "end", grow: 1 },
				undefined,
				"text",
			),
			event.age !== undefined &&
				node("elapsed", { role: "omp.tray.time", age: Math.round(event.age), format: "short" }, undefined, "time"),
		]),
		String(index),
	);
}

/** The closer look at one card (read-only): its head and actions, then what it is doing in more depth. */
export function describeTrayPeek(item: TrayItem, detail: TrayAgentDetail | undefined, now: number): NativeNode {
	const meta = peekMeta(item);
	const head = node(
		"row",
		{ role: "omp.tray.peek.head", gap: "xs", align: "center" },
		compact<NativeNode>([
			describeDot(item.status),
			// The meta takes the free space, so the clock and the buttons sit at the end.
			node(
				"text",
				{ role: "omp.tray.name", text: item.name, wrap: "none", truncate: "end", shrink: 1 },
				undefined,
				"name",
			),
			meta !== "" &&
				node(
					"text",
					{ role: "omp.tray.peek.meta", text: meta, wrap: "none", truncate: "end", grow: 1, shrink: 1 },
					undefined,
					"meta",
				),
			item.item !== "done" && describeTime(item.start, item.duration, now),
			...peekButtons(item),
		]),
		"head",
	);
	const body: NativeNode[] = [];
	if (item.item === "agent") {
		if (detail?.task) {
			body.push(
				node(
					"text",
					{ role: "omp.tray.peek.task", text: detail.task, wrap: "none", truncate: "end" },
					undefined,
					"task",
				),
			);
		}
		if (detail && detail.tail.length > 0) {
			body.push(node("col", { role: "omp.tray.tail" }, detail.tail.map(describeEvent), "tail"));
		}
	} else if (item.item === "job") {
		if (item.view) body.push(keyed(describeJobWidget(item.view), "widget"));
		if (item.output) body.push(describeOut(item, item.view ? TRAY_PEEK_OUT_LINES : TRAY_PEEK_OUT_LINES_BARE));
	} else {
		body.push(
			node(
				"text",
				{ role: "omp.tray.peek.task", text: item.allNames, wrap: "none", truncate: "end" },
				undefined,
				"task",
			),
		);
	}
	return node("col", { role: "omp.tray.peek", ref: item.ref }, [head, ...body], "peek");
}

/** `3 agents, 1 job in the background`: what the idle status row says while the tray has cards. */
export function trayCaption(items: readonly TrayItem[]): string {
	let liveAgents = 0;
	let liveJobs = 0;
	let settledAgents = 0;
	let settledJobs = 0;
	let done: TrayDoneItem | undefined;
	for (const item of items) {
		if (item.item === "done") done = item;
		else if (item.item === "agent") isLive(item.status) ? liveAgents++ : settledAgents++;
		else isLive(item.status) ? liveJobs++ : settledJobs++;
	}
	const parts = (agents: number, jobs: number): string =>
		[agents > 0 && formatCount("agent", agents), jobs > 0 && formatCount("job", jobs)].filter(Boolean).join(", ");
	if (liveAgents + liveJobs > 0) return `${parts(liveAgents, liveJobs)} in the background`;
	if (settledAgents + settledJobs > 0) return `${parts(settledAgents, settledJobs)} finished`;
	return done ? `${formatCount("agent", done.count)} done` : "";
}

/** Card counts per state for the header; undefined while the tray holds at most four cards and none failed. */
export function trayCounts(items: readonly TrayItem[]): { failed: number; running: number; done: number } | undefined {
	let failed = 0;
	let running = 0;
	let done = 0;
	for (const item of items) {
		if (item.status === "failed") failed++;
		else if (item.status === "running") running++;
		else if (item.status === "done") done += item.item === "done" ? item.count : 1;
	}
	if (items.length <= TRAY_COUNTS_MIN_CARDS && failed === 0) return undefined;
	return { failed, running, done };
}

function describeCounts(counts: { failed: number; running: number; done: number }): NativeNode {
	const chips: NativeNode[] = [];
	for (const status of ["failed", "running", "done"] as const) {
		const count = counts[status];
		if (count === 0) continue;
		chips.push(
			node(
				"text",
				{
					role: "omp.tray.count",
					status,
					text: `${count} ${status}`,
					tone: status === "failed" ? "error" : "muted",
					wrap: "none",
				},
				undefined,
				status,
			),
		);
	}
	return node("row", { role: "omp.tray.counts", gap: "xs", align: "center" }, chips, "counts");
}

// =============================================================================
// The tray
// =============================================================================

/** What the tray needs from the session it shows. */
export interface TrayHost {
	/** What the tray is built from now. */
	input(): TrayInput;
	/** Focus agent `id`'s session, as the hub's Open transcript does. */
	focusAgent(id: string): void;
	showAgentHub(): void;
	showJobsSheet(): void;
	/** Stop agent `id` for good, as cancelling its task job does. */
	stopAgent(id: string): void;
	cancelJob(id: string): void;
	requestRender(): void;
}

/** The header parts the status row carries on a tray host. */
export interface TrayHeader {
	/** In place of the status rows while the main agent is idle and the tray has cards. */
	readonly caption: NativeNode | undefined;
	/** Before the todo while the tray holds more than four cards or a failed one. */
	readonly counts: NativeNode | undefined;
}

const NO_HEADER: TrayHeader = { caption: undefined, counts: undefined };

/**
 * The tray's state and its dock component (native-only: it renders no rows,
 * and the composer docks it only on a host advertising `tray`).
 */
export class Tray implements Component {
	readonly #host: TrayHost;
	readonly #memory = new TrayMemory();
	#items: readonly TrayItem[] = [];
	/** Whether {@link #items} were built since the tray last described itself. */
	#fresh = false;
	/** True while the terminal advertises `tray`; everything else here idles until then. */
	#onHost = false;
	#focus = 0;
	#peekRef: string | undefined;
	#peekDetail: TrayAgentDetail | undefined;
	#peekTimer: NodeJS.Timeout | undefined;
	readonly #cards = new Map<string, { face: TrayItem; node: NativeNode }>();
	#peekNode: { face: TrayItem; detail: TrayAgentDetail | undefined; node: NativeNode } | undefined;
	#root: { children: readonly NativeChild[]; focus: number; peek: string | undefined; node: NativeNode } | undefined;
	#caption: { text: string; node: NativeNode } | undefined;
	#counts: { key: string; node: NativeNode } | undefined;

	constructor(host: TrayHost) {
		this.#host = host;
	}

	/** Whether the last native frame came from a terminal advertising `tray`. */
	get onHost(): boolean {
		return this.#onHost;
	}

	/** Follow the terminal: called with `cx.feature("tray")` on every native frame. */
	setOnHost(onHost: boolean): void {
		if (this.#onHost === onHost) return;
		this.#onHost = onHost;
		if (!onHost) this.#clearPeekTimer();
	}

	get items(): readonly TrayItem[] {
		return this.#items;
	}

	/** Rebuild the cards; true when a card, their order or the closer look changed since the last build. */
	refresh(): boolean {
		const input = this.#host.input();
		const items = buildTrayItems(input, this.#memory);
		let changed = !sameFaces(this.#items, items);
		this.#items = items;
		this.#fresh = true;
		const peeked = this.#peekRef === undefined ? undefined : items.find(item => item.ref === this.#peekRef);
		if (!peeked) this.#peekRef = undefined;
		const detail =
			peeked?.item === "agent"
				? trayAgentDetail(
						input.sessions.find(session => session.id === peeked.ref),
						input.now,
					)
				: undefined;
		if (!sameDetail(this.#peekDetail, detail)) changed = true;
		this.#peekDetail = detail;
		this.#armPeekTick(detail, input);
		return changed;
	}

	/** The status row's tray parts; `idle` when the main agent shows no status rows. */
	header(idle: boolean): TrayHeader {
		if (!this.#onHost) return NO_HEADER;
		this.refresh();
		const items = this.#items;
		if (items.length === 0) return NO_HEADER;
		let caption: NativeNode | undefined;
		if (idle) {
			const text = trayCaption(items);
			if (this.#caption?.text !== text) {
				this.#caption = {
					text,
					node: node(
						"text",
						{ role: "omp.tray.caption", text, wrap: "none", truncate: "end" },
						undefined,
						"caption",
					),
				};
			}
			caption = this.#caption.node;
		}
		const counts = trayCounts(items);
		let countsNode: NativeNode | undefined;
		if (counts) {
			const key = `${counts.failed}:${counts.running}:${counts.done}`;
			if (this.#counts?.key !== key) this.#counts = { key, node: describeCounts(counts) };
			countsNode = this.#counts.node;
		}
		return { caption, counts: countsNode };
	}

	/** Ask the terminal to move keyboard focus into the tray; false when it shows no cards. */
	focus(): boolean {
		if (!this.#onHost || this.#items.length === 0) return false;
		this.#focus++;
		this.#host.requestRender();
		return true;
	}

	render(): readonly string[] {
		return [];
	}

	describe(): NativeNode {
		if (!this.#fresh) this.refresh();
		this.#fresh = false;
		const now = Date.now();
		const children: NativeChild[] = [];
		const live = new Set<string>();
		for (const item of this.#items) {
			live.add(item.key);
			const cached = this.#cards.get(item.key);
			if (cached && sameProps<TrayItem>(cached.face, item)) {
				children.push(cached.node);
				continue;
			}
			const described = describeTrayCard(item, now);
			this.#cards.set(item.key, { face: item, node: described });
			children.push(described);
		}
		for (const key of this.#cards.keys()) if (!live.has(key)) this.#cards.delete(key);
		const peeked = this.#peekRef === undefined ? undefined : this.#items.find(item => item.ref === this.#peekRef);
		if (peeked) {
			let memo = this.#peekNode;
			if (!memo || !sameProps<TrayItem>(memo.face, peeked) || !sameDetail(memo.detail, this.#peekDetail)) {
				memo = { face: peeked, detail: this.#peekDetail, node: describeTrayPeek(peeked, this.#peekDetail, now) };
				this.#peekNode = memo;
			}
			children.push(memo.node);
		} else {
			this.#peekNode = undefined;
		}
		const root = this.#root;
		const peek = peeked?.ref;
		if (root && root.focus === this.#focus && root.peek === peek && sameItems(root.children, children))
			return root.node;
		const described = node(
			"col",
			{
				role: "omp.tray",
				...(children.length === 0 ? { hidden: true } : {}),
				...(this.#focus > 0 ? { focus: this.#focus } : {}),
				...(peek !== undefined ? { peek } : {}),
			},
			children,
		);
		this.#root = { children, focus: this.#focus, peek, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		const ref = event.value ?? "";
		const item = ref ? this.#items.find(candidate => candidate.ref === ref) : undefined;
		switch (event.act) {
			case "tray.peek":
				this.#peekRef = item?.ref;
				this.refresh();
				return;
			case "tray.open":
				this.#peekRef = undefined;
				if (item?.item === "agent") this.#host.focusAgent(item.ref);
				else if (item?.item === "job") this.#host.showJobsSheet();
				else if (item?.item === "done") this.#host.showAgentHub();
				return;
			case "tray.stop":
				if (!item || !isLive(item.status)) return;
				if (item.item === "agent") this.#host.stopAgent(item.ref);
				else if (item.item === "job") this.#host.cancelJob(item.ref);
				return;
			case "tray.dismiss":
				if (!item || item.item === "done" || isLive(item.status)) return;
				this.#memory.dismissed.add(item.key);
				this.refresh();
				return;
			case "agents.open":
				this.#host.showAgentHub();
				return;
			case "jobs.open":
				this.#host.showJobsSheet();
				return;
		}
	}

	dispose(): void {
		this.#clearPeekTimer();
	}

	/** Repaint when the peeked agent's running call crosses the elapsed-marker threshold. */
	#armPeekTick(detail: TrayAgentDetail | undefined, input: TrayInput): void {
		this.#clearPeekTimer();
		const running = detail?.tail.at(-1);
		if (running?.state !== "run" || running.age !== undefined || !this.#peekRef) return;
		const startMs = input.sessions.find(session => session.id === this.#peekRef)?.progress?.currentToolStartMs;
		if (startMs === undefined) return;
		const delay = Math.max(0, startMs + TRAY_CALL_ELAPSED_MIN_MS + 1 - input.now);
		this.#peekTimer = setTimeout(() => {
			this.#peekTimer = undefined;
			if (this.#onHost) this.#host.requestRender();
		}, delay);
		this.#peekTimer.unref?.();
	}

	#clearPeekTimer(): void {
		if (!this.#peekTimer) return;
		clearTimeout(this.#peekTimer);
		this.#peekTimer = undefined;
	}
}
