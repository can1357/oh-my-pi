/**
 * `/restart` keeps the subagents it would otherwise lose. A subagent runs inside the
 * omp process, so the relaunch stops every one that is mid-task; parked and idle ones
 * are revived on demand from their transcripts anyway.
 *
 * Before the teardown, {@link recordRestartSubagents} writes one `restart_subagents`
 * entry into the root session's own file: each running subagent of this session, its
 * parent, the tool calls it is in, the background jobs it owns that die with the
 * process, the queued messages and job results it has not read, and why it cannot be
 * resumed when it cannot. The teardown then stops them as a shutdown does: the
 * transcript stays on disk, nothing is tombstoned.
 *
 * After the relaunch resumed the session, {@link resumeRestartedSubagents} consumes
 * that entry once (`restart_subagents_resumed`) and gives every interrupted subagent
 * one more monitored turn as a background job of its parent, under the subagent's id:
 * the lifecycle reviver rebuilds it from its transcript, it gets one note saying the
 * process restarted and what was interrupted, and its result reaches the parent as the
 * ordinary `async-result` of a job with the id its first run's job had. Parents go
 * first, so a lane revives before its arms and receives their results.
 */
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { AsyncJobError } from "../async";
import type { AsyncJobManager } from "../async/job-manager";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import { collectPendingToolCalls, summarizeToolArguments } from "../session/exit-diagnostics";
import type { SessionEntry } from "../session/session-entries";
import { extractSessionInit, SessionManager } from "../session/session-manager";
import { loadSessionFile } from "../session/session-loader";
import type { EventBus } from "../utils/event-bus";
import { runSubagentFollowUpTurn } from "./executor";
import { persistedAgentDefinition } from "./persisted-revive";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";

export const RESTART_SUBAGENTS_CUSTOM_TYPE = "restart_subagents";
export const RESTART_SUBAGENTS_RESUMED_CUSTOM_TYPE = "restart_subagents_resumed";

/** Longest queued message or unread job result carried into a note, in characters. */
const CARRIED_TEXT_MAX_CHARS = 4_000;

/** A tool call the restart stopped, as the note names it. */
export interface RestartInterruptedToolCall {
	toolName: string;
	command?: string;
	path?: string;
	intent?: string;
}

/** One subagent that was running when `/restart` began. */
export interface RestartSubagent {
	id: string;
	parentId?: string;
	/** Tool calls that were running when the restart stopped its turn. */
	interruptedToolCalls: RestartInterruptedToolCall[];
	/** Its own background jobs, other than its subagents, which end with the process. */
	lostJobs: { id: string; type: string; label: string }[];
	/** Messages queued for it that its stopped turn never read. */
	pendingMessages: string[];
	/** Results of its jobs that finished but that it has not read. */
	unreadResults: { id: string; text: string }[];
	/** Why it cannot be resumed; absent when it can. */
	notResumable?: string;
}

/** The `restart_subagents` entry. */
export interface RestartSubagentsData {
	restartId: string;
	recordedAt: string;
	subagents: RestartSubagent[];
}

function clip(text: string): string {
	return text.length > CARRIED_TEXT_MAX_CHARS ? `${text.slice(0, CARRIED_TEXT_MAX_CHARS)}…` : text;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part =>
			part && typeof part === "object" && Reflect.get(part, "type") === "text"
				? String(Reflect.get(part, "text"))
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/** Text of a queued message: an IRC record carries its body in `details.message`. */
function queuedMessageText(message: AgentMessage): string {
	if (message.role === "custom") {
		const details = message.details && typeof message.details === "object" ? message.details : undefined;
		const body = details ? Reflect.get(details, "message") : undefined;
		const from = details ? Reflect.get(details, "from") : undefined;
		const text = typeof body === "string" ? body : contentText(message.content);
		return typeof from === "string" && text ? `From ${from}: ${text}` : text;
	}
	if (message.role === "user" || message.role === "developer") return contentText(message.content);
	return "";
}

function describeRunningSubagent(
	ref: AgentRef,
	session: AgentSession,
	manager: AsyncJobManager | undefined,
): RestartSubagent {
	const interruptedToolCalls = collectPendingToolCalls(session.sessionManager.getBranch()).map(call => ({
		toolName: call.toolName,
		...summarizeToolArguments(call.args),
		...(call.intent ? { intent: call.intent } : {}),
	}));
	const owned = manager?.getAllJobs({ ownerId: ref.id }) ?? [];
	const lostJobs = owned
		// A running task job is a subagent of its own; it is recorded and resumed itself.
		.filter(job => job.status === "running" && !(job.type === "task" && job.agentId))
		.map(job => ({ id: job.id, type: job.type, label: job.label }));
	const unreadResults = owned
		.filter(job => job.status !== "running" && !manager?.isJobResultConsumed(job.id))
		.flatMap(job => {
			const text = job.resultText ?? job.errorText;
			return text ? [{ id: job.id, text: clip(text) }] : [];
		});
	const pendingMessages = [...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue()]
		.map(queuedMessageText)
		.filter(Boolean)
		.map(clip);
	return {
		id: ref.id,
		...(ref.parentId ? { parentId: ref.parentId } : {}),
		interruptedToolCalls,
		lostJobs,
		pendingMessages,
		unreadResults,
		...(extractSessionInit(session.sessionManager.getEntries())?.isolated === true
			? { notResumable: "it ran in an isolated workspace, and an isolated run is never revived" }
			: {}),
	};
}

/**
 * Write the `restart_subagents` entry for every subagent of `session` that is running
 * now, and flush it. Call before the restart's teardown stops them. Writes nothing and
 * returns undefined when the session is not on disk (the relaunch starts fresh) or no
 * subagent runs. Throws when the entry cannot be written: the restart must not go on.
 */
export function recordRestartSubagents(session: AgentSession): RestartSubagentsData | undefined {
	const sessionManager = session.sessionManager;
	const rootFile = sessionManager.getSessionFile();
	if (!rootFile || !sessionManager.isSessionOnDisk()) return undefined;
	const manager = session.asyncJobManager;
	const subagents: RestartSubagent[] = [];
	for (const ref of AgentRegistry.global().list()) {
		if (ref.kind !== "sub" || ref.status !== "running" || !ref.session || !ref.sessionFile) continue;
		if (!sessionFileBelongsToRoot(ref.sessionFile, rootFile)) continue;
		subagents.push(describeRunningSubagent(ref, ref.session, manager));
	}
	if (subagents.length === 0) return undefined;
	const data: RestartSubagentsData = {
		restartId: `${Date.now().toString(36)}-${process.pid}`,
		recordedAt: new Date().toISOString(),
		subagents,
	};
	sessionManager.appendCustomEntry(RESTART_SUBAGENTS_CUSTOM_TYPE, data);
	sessionManager.flushSync();
	logger.info("Recorded running subagents for restart", { ids: subagents.map(sub => sub.id) });
	return data;
}

function readRestartData(entry: SessionEntry): RestartSubagentsData | undefined {
	if (entry.type !== "custom" || entry.customType !== RESTART_SUBAGENTS_CUSTOM_TYPE) return undefined;
	const data = entry.data as Partial<RestartSubagentsData> | undefined;
	if (!data || typeof data.restartId !== "string" || !Array.isArray(data.subagents)) return undefined;
	return data as RestartSubagentsData;
}

/** The branch's last `restart_subagents` entry, unless a later entry consumed it. */
export function pendingRestartSubagents(entries: readonly SessionEntry[]): RestartSubagentsData | undefined {
	const consumed = new Set<string>();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom") continue;
		if (entry.customType === RESTART_SUBAGENTS_RESUMED_CUSTOM_TYPE) {
			const restartId = (entry.data as { restartId?: unknown } | undefined)?.restartId;
			if (typeof restartId === "string") consumed.add(restartId);
			continue;
		}
		const data = readRestartData(entry);
		if (data) return consumed.has(data.restartId) ? undefined : data;
	}
	return undefined;
}

/**
 * Whether a subagent's transcript shows the turn the restart stopped, rather than one
 * that finished in the moment between the record and the teardown: its last message is
 * a stopped (`aborted`) assistant turn, unanswered input, unanswered tool calls, or a
 * tool result the model never answered other than an accepted `yield`.
 */
export function transcriptWasInterrupted(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			if (message.stopReason === "aborted") return true;
			return message.content.some(part => part.type === "toolCall");
		}
		if (message.role === "toolResult") return !(message.toolName === "yield" && !message.isError);
		return true;
	}
	return false;
}

function bulletList(items: string[]): string {
	return items.map(item => `  - ${item}`).join("\n");
}

function describeToolCall(call: RestartInterruptedToolCall): string {
	const detail = call.command ? ` \`${call.command}\`` : call.path ? ` \`${call.path}\`` : "";
	return `${call.toolName}${detail}${call.intent ? ` (${call.intent})` : ""}`;
}

/** The one note a resumed subagent receives. Exported for a focused test. */
export function buildRestartNote(args: {
	subagent: RestartSubagent;
	resumedChildren: string[];
	notResumedChildren: { id: string; reason: string }[];
	missingTools: string[];
}): string {
	const { subagent } = args;
	const lines = [
		"System note: the omp process was restarted (`/restart`) while you were working. This is a new process; your conversation above is intact. Go on with your task from where the transcript stops.",
	];
	if (subagent.interruptedToolCalls.length > 0) {
		lines.push(
			`The restart stopped these tool calls while they ran; their results above hold the output they produced before they stopped. Run a step again if you need its outcome:\n${bulletList(subagent.interruptedToolCalls.map(describeToolCall))}`,
		);
	} else {
		lines.push("The restart stopped your turn between tool calls; no tool call was running.");
	}
	if (subagent.lostJobs.length > 0) {
		lines.push(
			`These background jobs of yours ended with the old process and are not running now:\n${bulletList(subagent.lostJobs.map(job => `${job.id} (${job.type}: ${job.label})`))}`,
		);
	}
	if (args.resumedChildren.length > 0) {
		lines.push(
			`Your subagents ${args.resumedChildren.join(", ")} were stopped too and are going on with their tasks; their results reach you as before (\`wait\` for them).`,
		);
	}
	if (args.notResumedChildren.length > 0) {
		lines.push(
			`These subagents of yours could not be resumed; their transcripts stay readable at history://<id>:\n${bulletList(args.notResumedChildren.map(child => `${child.id}: ${child.reason}`))}`,
		);
	}
	if (subagent.pendingMessages.length > 0) {
		lines.push(
			`These messages reached you before the restart and you had not read them:\n${bulletList(subagent.pendingMessages)}`,
		);
	}
	if (subagent.unreadResults.length > 0) {
		lines.push(
			`These results of your jobs arrived before the restart and you had not read them:\n${bulletList(subagent.unreadResults.map(result => `${result.id}: ${result.text}`))}`,
		);
	}
	if (args.missingTools.length > 0) {
		lines.push(
			`These tools you were given are not available in the new process (a tool defined in your parent's eval kernel or by a closure does not survive a restart): ${args.missingTools.join(", ")}.`,
		);
	}
	return lines.join("\n\n");
}

/** Where resumed subagents' lifecycle and progress frames go, as a live run's do. */
export interface RestartResumeOptions {
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

/** What the relaunch did with the subagents `/restart` recorded. */
export interface RestartResumeOutcome {
	/** Ids going on with their tasks, parents before their children. */
	resumed: string[];
	/** Ids that are not resumed, with the reason. */
	notResumed: { id: string; reason: string }[];
}

function depthOf(id: string, byId: ReadonlyMap<string, RestartSubagent>): number {
	let depth = 0;
	const seen = new Set<string>();
	let parentId = byId.get(id)?.parentId;
	while (parentId && byId.has(parentId) && !seen.has(parentId)) {
		seen.add(parentId);
		depth++;
		parentId = byId.get(parentId)?.parentId;
	}
	return depth;
}

/**
 * Resume the subagents the last `/restart` of `session` recorded (see the module
 * docs). Does nothing when the session's branch holds no unconsumed record.
 */
export async function resumeRestartedSubagents(
	session: AgentSession,
	options: RestartResumeOptions = {},
): Promise<RestartResumeOutcome> {
	const outcome: RestartResumeOutcome = { resumed: [], notResumed: [] };
	const sessionFile = session.sessionManager.getSessionFile();
	if (!sessionFile) return outcome;
	const record = pendingRestartSubagents(session.sessionManager.getBranch());
	if (!record) return outcome;
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, sessionFile);
	const transcriptOf = (id: string): string | undefined => {
		const file = registry.get(id)?.sessionFile;
		return file && sessionFileBelongsToRoot(file, sessionFile) ? file : undefined;
	};
	// A record whose subagents have no transcript here came with copied entries (a
	// fork of the restarted session): its subagents belong to the source session.
	if (!record.subagents.some(sub => transcriptOf(sub.id))) return outcome;
	// Consume before anything runs: a resumed subagent that the next restart stops is
	// recorded again by that restart, never resumed twice from this record.
	session.sessionManager.appendCustomEntry(RESTART_SUBAGENTS_RESUMED_CUSTOM_TYPE, { restartId: record.restartId });
	const manager = session.asyncJobManager;
	const byId = new Map(record.subagents.map(sub => [sub.id, sub]));
	const order = [...record.subagents].sort((a, b) => depthOf(a.id, byId) - depthOf(b.id, byId));
	if (!manager) {
		for (const sub of order) {
			outcome.notResumed.push({
				id: sub.id,
				reason: "background jobs are off (`async.enabled`), so no result could reach its parent",
			});
		}
		return outcome;
	}

	const plans: { sub: RestartSubagent; ref: AgentRef }[] = [];
	for (const sub of order) {
		const ref = registry.get(sub.id);
		const file = transcriptOf(sub.id);
		let reason: string | undefined = sub.notResumable;
		if (!reason && (!ref || !file || ref.kind !== "sub")) reason = "its transcript was not found under this session";
		else if (!reason && ref?.status === "aborted") reason = "it was killed";
		else if (!reason && manager.getJob(sub.id)?.status === "running") reason = "it is already running again";
		if (!reason && file) {
			const loaded = await loadSessionFile(file);
			const entries = (loaded?.entries ?? []).filter((entry): entry is SessionEntry => entry.type !== "session");
			if (!transcriptWasInterrupted(entries)) reason = "it finished before the restart stopped it";
		}
		if (reason) outcome.notResumed.push({ id: sub.id, reason });
		else if (ref) plans.push({ sub, ref });
	}
	const notResumedById = new Map(outcome.notResumed.map(entry => [entry.id, entry.reason]));

	for (const { sub, ref } of plans) {
		const sessionFileOfRef = ref.sessionFile!;
		const peek = await SessionManager.peekSessionInit(sessionFileOfRef);
		const init = peek?.init;
		if (!init) {
			outcome.notResumed.push({ id: sub.id, reason: "its transcript has no session contract" });
			continue;
		}
		const children = record.subagents.filter(child => child.parentId === sub.id);
		const resumedChildren = children.filter(child => !notResumedById.has(child.id)).map(child => child.id);
		const notResumedChildren = children.flatMap(child => {
			const reason = notResumedById.get(child.id);
			return reason ? [{ id: child.id, reason }] : [];
		});
		const structured = init.tools.includes("yield");
		manager.register(
			"task",
			sub.id,
			async ({ signal }) => {
				const live = await AgentLifecycleManager.global().ensureLive(sub.id);
				const available = new Set([...live.getAllToolNames(), ...live.getMountedXdevToolNames()]);
				const missingTools = init.tools.filter(name => !available.has(name));
				const result = await runSubagentFollowUpTurn({
					id: sub.id,
					agent: persistedAgentDefinition(ref.displayName, init),
					message: buildRestartNote({ subagent: sub, resumedChildren, notResumedChildren, missingTools }),
					structured,
					workPoolYieldItems: init.workPoolYieldItems,
					outputSchema: init.outputSchema,
					outputSchemaMode: init.outputSchemaMode,
					signal,
					eventBus: options.eventBus,
					subagentEventBus: options.subagentEventBus,
					artifactsDir: path.dirname(sessionFileOfRef),
					maxRuntimeMs: cfgTaskMaxRuntimeMs.get(session.settings),
				});
				const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
				const structuredOutput = result.structuredOutput;
				if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
					throw new AsyncJobError(text, structuredOutput);
				}
				return structuredOutput ? { text, structured: structuredOutput } : text;
			},
			{ id: sub.id, agentId: sub.id, ownerId: ref.parentId },
		);
		outcome.resumed.push(sub.id);
	}
	if (outcome.resumed.length > 0 || outcome.notResumed.length > 0) {
		logger.info("Resumed subagents after restart", { resumed: outcome.resumed, notResumed: outcome.notResumed });
	}
	return outcome;
}
