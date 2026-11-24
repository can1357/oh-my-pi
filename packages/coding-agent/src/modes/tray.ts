/**
 * The tray: on a native host whose `hello` advertises `tray`, a row of live
 * cards over the composer, one per running subagent and background job, in
 * place of the HUD pill. The status row above it is its header (its caption
 * while the main agent is idle). Tern owns selection, order, paging and motion; this module owns the
 * data, the words, and which card is looked at closer.
 *
 * {@link buildTrayItems} turns plain inputs into flat item faces; the
 * describers turn faces into nodes; {@link Tray} keeps what the faces need to
 * remember (when an agent last acted, dismissed cards, the peek, the focus
 * counter) and memoises each card's node by its face, so an unchanged card is
 * the same node reference and the reconciler skips it.
 */
import { type TspTrayMain, type TspTrayStatus, toolIntentLabel } from "@oh-my-pi/pi-wire";
import { hubModel } from "../ui/overlays/pickers/agent-hub-model";
import type {
	TrayAgentDetail,
	TrayAgentItem,
	TrayDoneEntry,
	TrayDoneItem,
	TrayEvent,
	TrayItem,
	TrayJobItem,
	TrayModel,
} from "../ui/dock";
import { formatCost } from "./view-model/overlays/agent-hub-renderer";
import { type AgentRecordLike, MAIN_AGENT_ID } from "../registry/agent-hub-types";
import { stripInlineMarkdown } from "../plan-mode/plan-toc";
import type { ObservableSession } from "../task/session-observer-registry";
import { previewLine, shortenEmbeddedPaths, shortenToolArgumentPaths, TRUNCATE_LENGTHS } from "../utils/render-utils";
import { replaceTabs } from "../utils/text-width";
import { jobWidgetGlance } from "../ui/tools/jobs/widget";
import { type JobWidgetView } from "../tools/details/job-widget";
import { jobDisplayLabel } from "../async/job-label";
import { type AgentProgress, isWaitingOnOwnWork } from "../task/task-details";
import { formatCount, formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManagerApi } from "../async";
import { agentRunOf } from "../async/job-control";
import type { IrcBusApi } from "../irc/bus";
import type { AsyncJobSnapshot } from "../session/agent-session-types";

/** A running call earns an elapsed marker in the closer look once it outlasts this (as the ANSI live preview's). */
const TRAY_CALL_ELAPSED_MIN_MS = 5000;

/** Operations the closer look lists, ending with the call the agent is inside. */
const TRAY_TAIL_LIMIT = 5;

/** Finished agents the done card names before `+N`. */
const TRAY_DONE_NAMES = 3;

/** Finished agents the done card's closer look lists before `+N earlier`. */
const TRAY_DONE_LIST_LIMIT = 50;

/** Finished agents a quiet tray shows as cards of their own; the done card stands for the rest. */
const TRAY_QUIET_CARD_LIMIT = 48;

/** Output lines a job card shows, and its closer look with and without a widget. */
const TRAY_OUT_LINES = 2;
const TRAY_PEEK_OUT_LINES_BARE = 4;

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
	/** Whether focusing agent `ref` can show its transcript (a live session, or one on disk to revive). */
	canOpen(ref: AgentRecordLike): boolean;
	/**
	 * Whether agent `id` is being opened for viewing: reviving it to show its
	 * transcript passes its registry status through `running` without it doing
	 * any work, which the tray must not read as running.
	 */
	reviving(id: string): boolean;
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
	/** False where agent transcripts cannot be focused at all (a collab guest). */
	readonly canFocus: boolean;
	/** Agents being opened for viewing (see {@link TrayInput.reviving}). */
	readonly reviving: ReadonlySet<string>;
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
		// Focusing revives through the lifecycle: a live session, or a transcript on disk. Advisors are
		// read-only transcripts that focusing never opens.
		canOpen: ref => sources.canFocus && ref.kind === "sub" && (ref.session !== null || ref.sessionFile !== null),
		reviving: id => sources.reviving.has(id),
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
	/** The done card's last entries and their signature, so an unchanged list keeps its array. */
	doneEntries: { key: string; entries: readonly TrayDoneEntry[] } | undefined;
	/**
	 * Each agent's place, pinned the first time the tray sees it: its creation
	 * time (spawn order; an agent restored from disk by when it was made), then
	 * the order it was seen in. Nothing that happens to an agent later moves it.
	 */
	readonly places = new Map<string, { at: number; seq: number }>();
	#seq = 0;
	/**
	 * How each finished agent ended, as first seen settled: reopening a killed
	 * agent to view it registers it `parked`, which must not turn its stopped
	 * dot into a done one. Forgotten when it runs again.
	 */
	readonly settled = new Map<string, "done" | "failed" | "stopped">();

	/** Agent `id`'s pinned place (see {@link places}), pinning it at `at` on first sight. */
	place(id: string, at: number): { at: number; seq: number } {
		let place = this.places.get(id);
		if (!place) {
			place = { at, seq: this.#seq++ };
			this.places.set(id, place);
		}
		return place;
	}
}

/** Whether the registry says `ref` is a subagent at work (not merely being revived to be viewed). */
function registryRunning(input: TrayInput, ref: AgentRecordLike | undefined): boolean {
	return ref?.kind === "sub" && ref.status === "running" && !input.reviving(ref.id);
}

/** The card state an agent's observer session and registry ref add up to; undefined when it gets no card of that kind. */
function agentStatus(session: ObservableSession | undefined, running: boolean): TspTrayStatus | undefined {
	const pending = session?.status === "active" && session.progress?.status === "pending";
	// The registry also hears agents a message woke or revived, which the observer never sees start.
	if (running) return pending ? "queued" : "running";
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

/** One line of model-written or tool text, sanitised for a card. */
function line(value: string, width: number = TRUNCATE_LENGTHS.CONTENT): string {
	return previewLine(shortenEmbeddedPaths(replaceTabs(sanitizeText(value))), width);
}

/** The first non-blank line of `value`. */
function firstLine(value: string): string {
	return value.split("\n").find(part => part.trim().length > 0) ?? "";
}

/** A code fence's opening or closing line. */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
/** A thematic break (`---`, `***`, `___`). */
const RULE_LINE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/**
 * The first line of model-written markdown that says something, as plain
 * text: fences and rules skipped, quote, heading and list markers dropped,
 * inline markup stripped. Empty when no line has text.
 */
function plainLine(lines: readonly string[]): string {
	for (const raw of lines) {
		if (FENCE_LINE.test(raw) || RULE_LINE.test(raw)) continue;
		const text = raw
			.trim()
			.replace(/^(>\s?)+/, "")
			.replace(/^#{1,6}(\s+|$)/, "")
			.replace(/^([-*+]|\d+[.)])(\s+|$)/, "")
			.replace(/^\[[ xX]\](\s+|$)/, "");
		const plain = stripInlineMarkdown(text, { keepIntrawordUnderscores: true });
		if (plain) return line(plain);
	}
	return "";
}

/**
 * What a finished agent last said: its newest output line (the observer keeps
 * them newest first), else, for one restored from disk, its saved summary
 * (while an agent runs the registry's `activity` is its latest gist, not a
 * summary), else what it was asked to do.
 */
function outcomeLine(session: ObservableSession | undefined, ref: AgentRecordLike | undefined): string {
	const progress = session?.progress;
	const said = progress?.recentOutput.length
		? plainLine(progress.recentOutput)
		: session
			? ""
			: plainLine(ref?.activity?.split("\n") ?? []);
	if (said) return said;
	const asked = session?.description ?? progress?.description ?? progress?.assignment;
	return asked ? plainLine(asked.split("\n")) : "";
}

/** A call's detail as the ANSI live preview words it: its own intent, else its arguments, paths shortened. */
function callDetail(intent: string | undefined, args: string | undefined, argsKey: string | undefined): string {
	if (intent) return previewLine(shortenEmbeddedPaths(replaceTabs(toolIntentLabel(intent))), TRUNCATE_LENGTHS.CONTENT);
	if (args) return previewLine(shortenToolArgumentPaths(replaceTabs(args), argsKey), TRUNCATE_LENGTHS.CONTENT);
	return "";
}

/**
 * What a running agent is doing: the call it runs, else what its model is producing (a call it is
 * writing, the newest line of its prose, its reasoning), else its last call, else a word.
 */
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
	const streaming = progress?.streaming;
	if (streaming?.kind === "call") {
		return {
			tool: line(streaming.tool, TRUNCATE_LENGTHS.SHORT),
			text: callDetail(streaming.intent, streaming.args, streaming.argsKey),
		};
	}
	if (streaming?.kind === "thinking") return { tool: "", text: "Thinking" };
	if (streaming?.kind === "text") {
		const said = plainLine(progress?.recentOutput ?? []);
		if (said) return { tool: "", text: said };
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
		case "done":
			return { tool: "", text: outcomeLine(session, ref) || "Done" };
		case "failed": {
			const error = job?.errorText ?? progress?.retryFailure?.errorMessage ?? "Failed";
			return { tool: "", text: line(firstLine(error)) };
		}
		default:
			return { tool: "", text: "Stopped" };
	}
}

/**
 * `sonnet-5.5 · low`: what a queued or running agent with a live session runs on now, as its
 * composer names it (a `/switch` shows at once), else the model that produced its work. Settled
 * cards name {@link servedModel}.
 */
function agentModel(session: ObservableSession | undefined, ref: AgentRecordLike | undefined): string {
	const model = ref?.session?.model;
	if (model) {
		const level = model.thinking ? ref?.session?.thinkingLevel : undefined;
		const shown = level !== undefined && level !== "off" && level !== "inherit" ? level : undefined;
		const text = sanitizeText(model.id);
		return line(shown ? `${text} · ${shown}` : text, TRUNCATE_LENGTHS.TITLE);
	}
	return servedModel(session, ref);
}

/** `sonnet-5.5 · low`: the model that produced the agent's work, whatever its session points at now. */
function servedModel(session: ObservableSession | undefined, ref: AgentRecordLike | undefined): string {
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
	const chip = record && hubModel(record, session);
	if (!chip) return "";
	// The level it ran at, not the one its session holds now (the chip's fallback for a selector without one).
	const served = session?.progress?.resolvedThinkingLevel;
	const level = served ? (served !== "off" && served !== "inherit" ? served : undefined) : chip.level;
	return line(level ? `${chip.text} · ${level}` : chip.text, TRUNCATE_LENGTHS.TITLE);
}

/** `22%` (context fill) when known, else `12K tok`; empty when neither is. */
function agentStats(progress: AgentProgress | undefined): string {
	if (!progress) return "";
	const { contextTokens, contextWindow, tokens } = progress;
	if (contextTokens !== undefined && contextWindow) return `${Math.round((contextTokens / contextWindow) * 100)}%`;
	return tokens > 0 ? `${formatNumber(tokens)} tok` : "";
}

/**
 * What a card calls agent `id`: its id, the unique name the agent was spawned
 * under (the registry's display name is its type, shared by every agent of
 * that type).
 */
function agentTitle(id: string): string {
	return line(id, TRUNCATE_LENGTHS.TITLE);
}

/** The agent's type when it says more than its name: the registry's display name, else what spawned it. */
function agentType(
	id: string,
	session: ObservableSession | undefined,
	ref: AgentRecordLike | undefined,
	title: string,
): string {
	const declared = ref && ref.displayName !== id ? ref.displayName : undefined;
	const type = declared ?? session?.progress?.agent ?? session?.agent ?? ref?.history?.agent;
	if (!type) return "";
	const shown = line(type, TRUNCATE_LENGTHS.SHORT);
	return shown === title ? "" : shown;
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
	const status = agentStatus(session, registryRunning(input, ref));
	if (!status) return undefined;
	const key = `agent:${id}`;
	const remembered = rememberAgent(memory, id, status, session, input.now);
	const job = input.agentJob(id);
	if (status === "queued" || status === "running") {
		memory.dismissed.delete(key);
		memory.settled.delete(id);
	} else if (memory.dismissed.has(key) || agentResultReached(job, input.consumed)) {
		return undefined;
	}
	const name = agentTitle(id);
	const type = agentType(id, session, ref, name);
	const doing = agentDoing(status, session, ref, job);
	const tools = session?.progress?.toolCount;
	// A revived agent's observer snapshot is its previous run's: only a live session says what it is in now.
	const waiting = status === "running" && session?.status === "active" && isWaitingOnOwnWork(session.progress);
	const aria = [
		name,
		type,
		waiting ? "waiting" : status,
		`${doing.tool ? `${doing.tool} · ` : ""}${doing.text}`,
		tools !== undefined ? formatCount("tool", tools) : "",
	];
	return {
		item: "agent",
		key,
		ref: id,
		name,
		status,
		aria: aria.filter(Boolean).join(", "),
		acted: remembered.acted,
		waiting,
		unread: input.unread(id),
		tool: doing.tool,
		text: doing.text,
		type,
		model: isLive(status) ? agentModel(session, ref) : servedModel(session, ref),
		tools,
		stats: agentStats(session?.progress),
		start: remembered.start,
		duration: remembered.duration,
		openable: ref !== undefined && input.canOpen(ref),
		look: agentHasLook(session, doing.text),
	};
}

/**
 * Whether an agent's closer look adds to its card: a task line other than
 * what the card says, or operations to list.
 */
function agentHasLook(session: ObservableSession | undefined, text: string): boolean {
	const detail = trayAgentDetail(session, 0);
	return detail.tail.length > 0 || (detail.task !== "" && detail.task !== text);
}

/** How a finished agent ended, by its observer session and its registry ref, as first seen (see {@link TrayMemory.settled}). */
function finishedStatus(
	memory: TrayMemory,
	id: string,
	session: ObservableSession | undefined,
	ref: AgentRecordLike | undefined,
	job: AsyncJob | undefined,
): "done" | "failed" | "stopped" {
	const known = memory.settled.get(id);
	if (known) return known;
	const status =
		session?.status === "failed" || job?.status === "failed"
			? "failed"
			: session?.status === "aborted" || ref?.status === "aborted"
				? "stopped"
				: "done";
	memory.settled.set(id, status);
	return status;
}

/**
 * A finished agent's own card in a quiet tray, settled: its run from the
 * observer, else from the registry's saved history, leaving out what neither
 * knows. `acted` is its last activity, so a host orders these as the agent
 * registry does.
 */
function finishedAgentItem(
	input: TrayInput,
	memory: TrayMemory,
	id: string,
	session: ObservableSession | undefined,
	ref: AgentRecordLike | undefined,
): TrayAgentItem {
	const job = input.agentJob(id);
	const status = finishedStatus(memory, id, session, ref, job);
	const name = agentTitle(id);
	const type = agentType(id, session, ref, name);
	const text = status === "failed" ? agentDoing(status, session, ref, job).text : outcomeLine(session, ref);
	const progress = session?.progress;
	const metrics = ref?.history?.metrics;
	const duration = progress?.durationMs || metrics?.durationMs || undefined;
	const tools = progress?.toolCount || metrics?.tools || undefined;
	const contextTokens = progress?.contextTokens ?? metrics?.contextTokens;
	const contextWindow = progress?.contextWindow ?? metrics?.contextWindow;
	const tokens = progress?.tokens || metrics?.tokens || 0;
	const cost = progress?.cost || metrics?.cost || 0;
	const stats = [
		contextTokens !== undefined && contextWindow
			? `${Math.round((contextTokens / contextWindow) * 100)}%`
			: tokens > 0
				? `${formatNumber(tokens)} tok`
				: "",
		cost > 0 ? formatCost(cost) : "",
	]
		.filter(Boolean)
		.join(" · ");
	const aria = [name, type, status, text, tools !== undefined ? formatCount("tool", tools) : ""];
	const acted = ref?.lastActivity ?? session?.lastUpdate ?? 0;
	return {
		item: "agent",
		key: `agent:${id}`,
		ref: id,
		name,
		status,
		aria: aria.filter(Boolean).join(", "),
		acted,
		waiting: false,
		unread: input.unread(id),
		tool: "",
		text,
		type,
		model: servedModel(session, ref),
		tools,
		stats,
		start: acted - (duration ?? 0),
		duration,
		openable: ref !== undefined && input.canOpen(ref),
		look: agentHasLook(session, text),
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
	const name = line(jobDisplayLabel(job), TRUNCATE_LENGTHS.TITLE);
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
		// The closer look adds the full widget, more output lines than the card's two, or the command.
		look: view !== undefined || output.split("\n").length > TRAY_OUT_LINES || (command !== "" && command !== name),
	};
}

/** A finished agent as the done card's closer look lists it, from its registry ref and observer session. */
function doneEntry(
	input: TrayInput,
	memory: TrayMemory,
	ref: AgentRecordLike,
	session: ObservableSession | undefined,
): TrayDoneEntry {
	const status = finishedStatus(memory, ref.id, session, ref, input.agentJob(ref.id));
	const progress = session?.progress;
	const metrics = ref.history?.metrics;
	const duration = progress?.durationMs || metrics?.durationMs || 0;
	const tools = progress?.toolCount || metrics?.tools || 0;
	const cost = progress?.cost || metrics?.cost || 0;
	const meta = [
		servedModel(session, ref),
		duration > 0 ? formatDuration(duration) : "",
		tools > 0 ? formatCount("tool", tools) : "",
		cost > 0 ? formatCost(cost) : "",
	]
		.filter(Boolean)
		.join(" · ");
	return {
		id: ref.id,
		name: agentTitle(ref.id),
		status,
		meta,
		line: outcomeLine(session, ref),
		openable: input.canOpen(ref),
	};
}

/** Finished agents (not Main, not at work) that have no card of their own, in their pinned places. */
function finishedRefs(input: TrayInput, memory: TrayMemory, carded: ReadonlySet<string>): AgentRecordLike[] {
	return input.refs
		.filter(
			ref => ref.id !== MAIN_AGENT_ID && ref.kind !== "main" && !registryRunning(input, ref) && !carded.has(ref.id),
		)
		.sort((a, b) => byPlace(memory.place(a.id, a.createdAt), memory.place(b.id, b.createdAt)));
}

/** Pinned places in order: creation time, then first sight. */
function byPlace(a: { at: number; seq: number }, b: { at: number; seq: number }): number {
	return a.at - b.at || a.seq - b.seq;
}

/**
 * The card standing for finished agents `done` (in their places; its closer
 * look lists the newest first): every finished agent while anything runs,
 * only those before a quiet tray's own cards (`more`) while nothing does.
 */
function doneItem(
	input: TrayInput,
	memory: TrayMemory,
	done: readonly AgentRecordLike[],
	sessions: ReadonlyMap<string, ObservableSession>,
	more: boolean,
): TrayDoneItem | undefined {
	if (done.length === 0) {
		memory.doneEntries = undefined;
		return undefined;
	}
	const newest = done.toReversed();
	const entries = newest
		.slice(0, TRAY_DONE_LIST_LIMIT)
		.map(ref => doneEntry(input, memory, ref, sessions.get(ref.id)));
	const key = JSON.stringify(entries);
	if (memory.doneEntries?.key !== key) memory.doneEntries = { key, entries };
	const names = newest.map(ref => agentTitle(ref.id));
	const shown = names.slice(0, TRAY_DONE_NAMES).join(", ");
	const summary = names.length > TRAY_DONE_NAMES ? `${shown} +${names.length - TRAY_DONE_NAMES}` : shown;
	const name = more ? `${done.length} more done` : `${done.length} done`;
	return {
		item: "done",
		key: "done",
		ref: "done",
		name,
		status: "done",
		aria: `${name}, finished and delivered, ${summary}`,
		count: done.length,
		names: summary,
		entries: memory.doneEntries.entries,
		look: true,
	};
}

/** One build of the tray. */
export interface TrayBuild {
	readonly items: TrayItem[];
	/**
	 * It holds only finished work: nothing queued, running, or failed and still
	 * waiting to be delivered or dismissed. A host keeps a quiet tray out of
	 * sight until the user asks for it.
	 */
	readonly quiet: boolean;
}

/**
 * The tray's cards in wire order: agents, then the session's background jobs
 * by start time, then the done card. Every card keeps its place for its life:
 * agents stand in their pinned places (see {@link TrayMemory.places}), never
 * by activity, so a new card only appends after the last of its kind. While
 * anything is live the done card stands for every finished agent without a
 * card. While nothing is (quiet) finished agents are not grouped: the newest
 * {@link TRAY_QUIET_CARD_LIMIT} each get a settled card, and the done card
 * stands only for the earlier ones and dismissed ones. A card keeps its key
 * across the switch.
 */
export function buildTrayItems(input: TrayInput, memory: TrayMemory): TrayBuild {
	const agents: TrayAgentItem[] = [];
	const jobs: TrayItem[] = [];
	const seen = new Set<string>();
	const carded = new Set<string>();
	const refs = new Map<string, AgentRecordLike>();
	const sessions = new Map<string, ObservableSession>();
	const place = (id: string): { at: number; seq: number } =>
		memory.place(id, refs.get(id)?.createdAt ?? sessions.get(id)?.lastUpdate ?? input.now);
	if (input.showAgents) {
		for (const ref of input.refs) refs.set(ref.id, ref);
		for (const session of input.sessions) if (session.kind === "subagent") sessions.set(session.id, session);
		// Pin newcomers in a fixed sequence (the observer's order, then the registry's), so ties keep it.
		for (const id of sessions.keys()) place(id);
		for (const ref of input.refs) place(ref.id);
		const add = (id: string, session: ObservableSession | undefined): void => {
			seen.add(id);
			const item = agentItem(input, memory, id, session, refs.get(id));
			if (!item) return;
			agents.push(item);
			carded.add(id);
		};
		for (const session of sessions.values()) add(session.id, session);
		for (const ref of input.refs) if (!seen.has(ref.id) && registryRunning(input, ref)) add(ref.id, undefined);
		agents.sort((a, b) => byPlace(place(a.ref), place(b.ref)));
	} else {
		memory.doneEntries = undefined;
	}
	for (const id of memory.agents.keys()) if (!seen.has(id)) memory.agents.delete(id);
	const running = input.jobs.filter(job => !job.foreground && job.agentId === undefined);
	running.sort((a, b) => a.startTime - b.startTime);
	for (const job of running) {
		const item = jobItem(input, memory, job);
		if (item) jobs.push(item);
	}
	const quiet = ![...agents, ...jobs].some(item => isLive(item.status) || item.status === "failed");
	if (!input.showAgents) return { items: jobs, quiet };
	if (!quiet) {
		const done = doneItem(input, memory, finishedRefs(input, memory, carded), sessions, false);
		return { items: [...agents, ...jobs, ...(done ? [done] : [])], quiet };
	}
	// Quiet: every finished agent, carded or not, in its place; the newest get cards of their own,
	// the earlier and the dismissed ones go to the done card.
	const finished = [
		...agents.map(item => ({ id: item.ref, ref: refs.get(item.ref) })),
		...finishedRefs(input, memory, carded).map(ref => ({ id: ref.id, ref })),
	].sort((a, b) => byPlace(place(a.id), place(b.id)));
	const shown = finished.filter(agent => !memory.dismissed.has(`agent:${agent.id}`));
	const own = new Set(shown.slice(-TRAY_QUIET_CARD_LIMIT).map(agent => agent.id));
	const cards: TrayItem[] = [];
	const rest: AgentRecordLike[] = [];
	for (const agent of finished) {
		if (own.has(agent.id)) cards.push(finishedAgentItem(input, memory, agent.id, sessions.get(agent.id), agent.ref));
		else if (agent.ref) rest.push(agent.ref);
	}
	const done = doneItem(input, memory, rest, sessions, true);
	return { items: [...cards, ...jobs, ...(done ? [done] : [])], quiet };
}

/** Whether two builds show the same cards, in the same order, with the same faces (flat, compared field by field). */
function sameFaces(a: readonly TrayItem[], b: readonly TrayItem[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as unknown as Record<string, unknown>;
		const y = b[i] as unknown as Record<string, unknown>;
		const keys = Object.keys(x);
		if (keys.length !== Object.keys(y).length || keys.some(key => x[key] !== y[key])) return false;
	}
	return true;
}

function isLive(status: TspTrayStatus): boolean {
	return status === "queued" || status === "running";
}

/** An agent's task and last operations, from its observer session. */
export function trayAgentDetail(session: ObservableSession | undefined, now: number): TrayAgentDetail {
	const progress = session?.progress;
	const task = plainLine(
		(session?.description ?? progress?.description ?? progress?.assignment ?? progress?.task ?? "").split("\n"),
	);
	if (!progress) return { task, tail: [] };
	const active = session?.status === "active";
	const current = active ? progress.currentTool : undefined;
	// No call runs: the call the model is writing is the one it is inside.
	const writing = active && !current && progress.streaming?.kind === "call" ? progress.streaming : undefined;
	const past = progress.recentTools.slice(0, current || writing ? TRAY_TAIL_LIMIT - 1 : TRAY_TAIL_LIMIT).reverse();
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
	if (writing) {
		tail.push({
			tool: line(writing.tool, TRUNCATE_LENGTHS.SHORT),
			text: callDetail(writing.intent, writing.args, writing.argsKey),
			state: "run",
			age: undefined,
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

/** `3 agents, 1 job in the background`: what the idle status row says while the tray has cards. */
export function trayCaption(items: readonly TrayItem[]): string {
	let liveAgents = 0;
	let liveJobs = 0;
	let settledAgents = 0;
	let settledJobs = 0;
	for (const item of items) {
		if (item.item === "agent") isLive(item.status) ? liveAgents++ : settledAgents++;
		else if (item.item === "job") isLive(item.status) ? liveJobs++ : settledJobs++;
	}
	const parts = (agents: number, jobs: number): string =>
		[agents > 0 && formatCount("agent", agents), jobs > 0 && formatCount("job", jobs)].filter(Boolean).join(", ");
	// A quiet tray gets no caption, so settled cards stand beside a failure.
	if (liveAgents + liveJobs > 0) return `${parts(liveAgents, liveJobs)} in the background`;
	return `${parts(settledAgents, settledJobs)} finished`;
}

// =============================================================================
// The main agent
// =============================================================================

/** The main agent's state as the tray's host reads it (see {@link TrayMainActivity}). */
export type TrayMain = TspTrayMain;

/**
 * Calls that only block on agents or jobs: `wait` (on background jobs,
 * services or a peer's reply) and `vibe_wait` (on vibe worker sessions).
 * A `task` call blocks on its agents only while it runs one inline; see
 * {@link TrayMainActivity.state}.
 */
const WAITING_TOOLS: Readonly<Record<string, true>> = { wait: true, vibe_wait: true };

/** The session events {@link TrayMainActivity} follows. */
export type TrayMainEvent =
	| { readonly type: "agent_start" }
	| { readonly type: "agent_pause"; readonly yielded: boolean }
	| { readonly type: "agent_end" }
	| { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string }
	| { readonly type: "tool_execution_end"; readonly toolCallId: string };

/**
 * What the main agent is doing, for the tray: `idle` once it has yielded (no
 * turn runs, or the run waits only on outside work); `waiting` while every
 * call it executes only blocks on agents or jobs, and after such calls end
 * until it starts another call or yields (a `wait` returns at intervals, and
 * the model mostly waits again); `working` otherwise.
 */
export class TrayMainActivity {
	/** A model loop is running: from `agent_start` until it yields or the run ends. */
	#looping: boolean;
	/** Executing calls (from `tool_execution_start` to their end) by id: their tool names. */
	readonly #calls = new Map<string, string>();
	/** The last executing calls ended while it was waiting, and it has started nothing since. */
	#stillWaiting = false;
	/** The loop paused for the session's own continuation: the next `agent_start` resumes its state. */
	#resuming = false;

	constructor(looping: boolean) {
		this.#looping = looping;
	}

	/**
	 * Follow one session event; true when it can change {@link state}.
	 * `inlineTask` is {@link state}'s, read as the last calls end.
	 */
	handle(event: TrayMainEvent, runActive: boolean, inlineTask: (callId: string) => boolean): boolean {
		switch (event.type) {
			case "agent_start":
				this.#looping = true;
				// A new turn starts working; the session continuing its own loop keeps what it was.
				if (!this.#resuming) this.#stillWaiting = false;
				this.#resuming = false;
				return true;
			case "agent_pause":
				// A pause the session itself continues (a retry, a reminder) is still the turn's work.
				this.#looping = !event.yielded;
				this.#resuming = !event.yielded;
				if (event.yielded) this.#stillWaiting = false;
				this.#calls.clear();
				return true;
			case "agent_end":
				// A superseded end reaches subscribers after the next run opened: that run's `agent_start` decides.
				if (!runActive) {
					this.#looping = false;
					this.#stillWaiting = false;
					this.#resuming = false;
				}
				this.#calls.clear();
				return true;
			case "tool_execution_start":
				// Anything but another waiting call ends the wait.
				if (WAITING_TOOLS[event.toolName] !== true) this.#stillWaiting = false;
				this.#calls.set(event.toolCallId, event.toolName);
				return true;
			case "tool_execution_end": {
				if (!this.#calls.has(event.toolCallId)) return false;
				const waiting = this.state(inlineTask) === "waiting";
				this.#calls.delete(event.toolCallId);
				if (this.#calls.size === 0) this.#stillWaiting = waiting;
				return true;
			}
		}
	}

	/**
	 * The state now. `inlineTask(callId)` says whether `task` call `callId`
	 * runs one of its agents inline (the call returns only when that agent
	 * does); a `task` call that only spawns background agents is working.
	 */
	state(inlineTask: (callId: string) => boolean): TrayMain {
		if (!this.#looping) return "idle";
		if (this.#calls.size === 0) return this.#stillWaiting ? "waiting" : "working";
		for (const [id, tool] of this.#calls) {
			if (WAITING_TOOLS[tool] === true) continue;
			if (tool === "task" && inlineTask(id)) continue;
			return "working";
		}
		return "waiting";
	}
}

/** Whether `task` call `callId` runs an agent inline: an active observer session it spawned, not detached. */
export function runsInlineAgent(sessions: readonly ObservableSession[], callId: string): boolean {
	return sessions.some(
		session =>
			session.kind === "subagent" &&
			session.status === "active" &&
			session.detached !== true &&
			session.parentToolCallId === callId,
	);
}

// =============================================================================
// The tray feed
// =============================================================================

/** What the tray needs from the session it shows. */
export interface TrayHost {
	/** What the tray is built from now. */
	input(): TrayInput;
	/** The main agent's state now. */
	main(): TrayMain;
	/** Focus agent `id`'s session, as the hub's Open transcript does. */
	focusAgent(id: string): void;
	/** The jobs sheet, on job `selected` when it lists it. */
	showJobsSheet(selected?: string): void;
	/** Stop agent `id` for good, as cancelling its task job does. */
	stopAgent(id: string): void;
	cancelJob(id: string): void;
}

/**
 * Feeds the dock's {@link TrayModel} (native, on a host advertising `tray`):
 * rebuilds the cards from the registries, keeps the closer look's detail, the
 * main agent's state and the status row's caption, and handles the cards'
 * actions.
 */
export class TrayFeed {
	readonly #host: TrayHost;
	readonly #model: TrayModel;
	readonly #memory = new TrayMemory();
	#peekTimer: NodeJS.Timeout | undefined;

	constructor(host: TrayHost, model: TrayModel) {
		this.#host = host;
		this.#model = model;
		model.onAction = (act, ref) => this.#onAction(act, ref);
	}

	get items(): readonly TrayItem[] {
		return this.#model.items.peek();
	}

	/** Rebuild the cards and the closer look's detail; true when anything shown changed. */
	refresh(): boolean {
		const input = this.#host.input();
		const { items, quiet } = buildTrayItems(input, this.#memory);
		const model = this.#model;
		let changed = false;
		if (!sameFaces(model.items.peek(), items)) {
			model.items.set(items);
			changed = true;
		}
		if (model.quiet.peek() !== quiet) {
			model.quiet.set(quiet);
			changed = true;
		}
		// The closer look goes with its card, and once that card has nothing more to show.
		const ref = model.peek.peek();
		const peeked = ref === undefined ? undefined : items.find(item => item.ref === ref && item.look);
		if (!peeked && ref !== undefined) model.peek.set(undefined);
		const detail =
			peeked?.item === "agent"
				? trayAgentDetail(
						input.sessions.find(session => session.id === peeked.ref),
						input.now,
					)
				: undefined;
		if (!sameDetail(model.peekDetail.peek(), detail)) {
			model.peekDetail.set(detail);
			changed = true;
		}
		this.#armPeekTick(detail, input);
		return this.syncMain() || changed;
	}

	/** Follow the main agent's state (sent while the tray has cards); true when it changed. */
	syncMain(): boolean {
		const main = this.#model.items.peek().length > 0 ? this.#host.main() : undefined;
		if (this.#model.main.peek() === main) return false;
		this.#model.main.set(main);
		return true;
	}

	/** `3 agents, 1 job in the background`, while the tray has cards and is not quiet. */
	caption(): string | undefined {
		const items = this.#model.items.peek();
		if (items.length === 0 || this.#model.quiet.peek()) return undefined;
		return trayCaption(items);
	}

	dispose(): void {
		this.#clearPeekTimer();
		this.#model.onAction = undefined;
	}

	#onAction(act: string, ref: string): void {
		const item = ref ? this.items.find(candidate => candidate.ref === ref) : undefined;
		switch (act) {
			case "tray.peek":
				if (item && !item.look) return;
				this.#model.peek.set(item?.ref);
				this.refresh();
				return;
			case "tray.open": {
				// The done card opens nothing: its closer look lists the agents, and each row opens one.
				if (item?.item === "done") return;
				if (item?.item === "agent") {
					if (!item.openable) return;
					this.#model.peek.set(undefined);
					this.#host.focusAgent(item.ref);
				} else if (item?.item === "job") {
					this.#model.peek.set(undefined);
					this.#host.showJobsSheet(item.ref);
				} else if (ref && this.#doneEntry(ref)?.openable) {
					this.#model.peek.set(undefined);
					this.#host.focusAgent(ref);
				}
				return;
			}
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
			case "jobs.open":
				this.#host.showJobsSheet();
				return;
		}
	}

	#doneEntry(id: string): TrayDoneEntry | undefined {
		for (const item of this.items) if (item.item === "done") return item.entries.find(entry => entry.id === id);
		return undefined;
	}

	/** Refresh when the peeked agent's running call crosses the elapsed-marker threshold. */
	#armPeekTick(detail: TrayAgentDetail | undefined, input: TrayInput): void {
		this.#clearPeekTimer();
		const ref = this.#model.peek.peek();
		const running = detail?.tail.at(-1);
		if (running?.state !== "run" || running.age !== undefined || !ref) return;
		const startMs = input.sessions.find(session => session.id === ref)?.progress?.currentToolStartMs;
		if (startMs === undefined) return;
		this.#peekTimer = setTimeout(
			() => {
				this.#peekTimer = undefined;
				this.refresh();
			},
			Math.max(0, startMs + TRAY_CALL_ELAPSED_MIN_MS + 1 - input.now),
		);
		this.#peekTimer.unref?.();
	}

	#clearPeekTimer(): void {
		clearTimeout(this.#peekTimer);
		this.#peekTimer = undefined;
	}
}
