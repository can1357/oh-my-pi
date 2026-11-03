/**
 * `/restart` keeps the subagents it would otherwise lose. A subagent runs inside the
 * omp process, so the relaunch stops every one that is mid-task; parked and idle ones
 * are revived on demand from their transcripts anyway.
 *
 * Before the teardown, {@link recordRestartSubagents} writes one `restart_subagents`
 * entry into the root session's own file: each running subagent of this session, its
 * parent, the tool calls it is in, the background jobs it owns that die with the
 * process, and the queued messages and job results it has not read. The teardown then
 * stops them as a shutdown does: the transcript stays on disk, nothing is tombstoned.
 *
 * After the relaunch resumed the session, {@link resumeRestartedSubagents} consumes
 * that entry once (`restart_subagents_resumed`) and gives every interrupted subagent
 * one more monitored turn as a background job of its parent, under the subagent's id:
 * the lifecycle reviver rebuilds it from its transcript, it gets one note saying the
 * process restarted and what was interrupted, and its result reaches the parent as the
 * ordinary `async-result` of a job with the id its first run's job had. Parents go
 * first, so a lane revives before its arms and receives their results. A subagent that
 * cannot go on (isolated, killed, finished in the meantime, its job refused) is
 * reported with the reason, never dropped silently.
 */
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { AsyncJobError } from "../async";
import type { AsyncJobManagerApi } from "../async/job-manager";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import { type AgentSessionHandle, isLocalAgentSession } from "../session/agent-session-handle";
import { summarizeToolArguments } from "../session/exit-diagnostics";
import type { SessionEntry } from "../session/session-entries";
import { type PersistedSessionInit, SessionManager } from "../session/session-manager";
import { loadSessionFile } from "../session/session-loader";
import type { EventBus } from "../utils/event-bus";
import { runSubagentFollowUpTurn } from "./executor";
import { persistedAgentDefinition } from "./persisted-revive";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";

export const RESTART_SUBAGENTS_CUSTOM_TYPE = "restart_subagents";
export const RESTART_SUBAGENTS_RESUMED_CUSTOM_TYPE = "restart_subagents_resumed";

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
}

/** The `restart_subagents` entry. */
export interface RestartSubagentsData {
	restartId: string;
	/** The session that recorded it; a fork copies the entry under another id. */
	sessionId: string;
	recordedAt: string;
	subagents: RestartSubagent[];
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
	session: AgentSessionHandle,
	manager: AsyncJobManagerApi | undefined,
): RestartSubagent {
	// The calls the loop dispatched and has not finished; their results do not exist yet.
	const pending = session.agent.state.pendingToolCalls;
	const interruptedToolCalls = session.messages.flatMap(message =>
		message.role === "assistant"
			? message.content.flatMap(part => {
					if (part.type !== "toolCall" || !pending.has(part.id)) return [];
					const intent = part.arguments && typeof part.arguments === "object" ? part.arguments.i : undefined;
					return [
						{
							toolName: part.name,
							...summarizeToolArguments(part.arguments),
							...(typeof intent === "string" && intent ? { intent } : {}),
						},
					];
				})
			: [],
	);
	const owned = manager?.getAllJobs({ ownerId: ref.id }) ?? [];
	const lostJobs = owned
		// A running task job is a subagent of its own; it is recorded and resumed itself.
		.filter(job => job.status === "running" && !(job.type === "task" && job.agentId))
		.map(job => ({ id: job.id, type: job.type, label: job.label }));
	const unreadResults = owned
		.filter(job => job.status !== "running" && !manager?.isJobResultConsumed(job.id))
		.flatMap(job => {
			const text = job.resultText ?? job.errorText;
			return text ? [{ id: job.id, text }] : [];
		});
	// The queues are readable only on a session homed on this thread, which every in-process subagent is.
	const pendingMessages = isLocalAgentSession(session)
		? [...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue()]
				.map(queuedMessageText)
				.filter(Boolean)
		: [];
	return {
		id: ref.id,
		...(ref.parentId ? { parentId: ref.parentId } : {}),
		interruptedToolCalls,
		lostJobs,
		pendingMessages,
		unreadResults,
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
		sessionId: sessionManager.getSessionId(),
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

/**
 * Every `restart_subagents` entry on the branch that no later entry consumed, oldest
 * first: a startup that stopped before consuming one leaves it for the next.
 */
export function pendingRestartSubagents(entries: readonly SessionEntry[]): RestartSubagentsData[] {
	const consumed = new Set<string>();
	const pending: RestartSubagentsData[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom") continue;
		if (entry.customType === RESTART_SUBAGENTS_RESUMED_CUSTOM_TYPE) {
			const restartId = (entry.data as { restartId?: unknown } | undefined)?.restartId;
			if (typeof restartId === "string") consumed.add(restartId);
			continue;
		}
		const data = readRestartData(entry);
		if (data && !consumed.has(data.restartId)) pending.unshift(data);
	}
	return pending;
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
 * Resume the subagents the `/restart`s of `session` recorded (see the module docs).
 * Does nothing when the session's branch holds no unconsumed record of its own.
 */
export async function resumeRestartedSubagents(
	session: AgentSession,
	options: RestartResumeOptions = {},
): Promise<RestartResumeOutcome> {
	const outcome: RestartResumeOutcome = { resumed: [], notResumed: [] };
	const sessionFile = session.sessionManager.getSessionFile();
	if (!sessionFile) return outcome;
	// A fork copies the entries under a new session id; its subagents belong to the source.
	const records = pendingRestartSubagents(session.sessionManager.getBranch()).filter(
		record => record.sessionId === session.sessionManager.getSessionId(),
	);
	if (records.length === 0) return outcome;
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, sessionFile);
	const transcriptOf = (id: string): string | undefined => {
		const file = registry.get(id)?.sessionFile;
		return file && sessionFileBelongsToRoot(file, sessionFile) ? file : undefined;
	};
	// Consume before anything runs: a resumed subagent that the next restart stops is
	// recorded again by that restart, never resumed twice from these records.
	for (const record of records) {
		session.sessionManager.appendCustomEntry(RESTART_SUBAGENTS_RESUMED_CUSTOM_TYPE, { restartId: record.restartId });
	}
	// A later record describes a subagent's later stop.
	const byId = new Map(records.flatMap(record => record.subagents).map(sub => [sub.id, sub]));
	const subagents = [...byId.values()];
	const manager = session.asyncJobManager;
	const order = [...subagents].sort((a, b) => depthOf(a.id, byId) - depthOf(b.id, byId));
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
		let reason: string | undefined;
		if (!ref || !file || ref.kind !== "sub") reason = "its transcript was not found under this session";
		else if (ref.status === "aborted") reason = "it was killed";
		else if (manager.getJob(sub.id)?.status === "running") reason = "it is already running again";
		if (!reason && file) {
			const loaded = await loadSessionFile(file);
			const entries = (loaded?.entries ?? []).filter((entry): entry is SessionEntry => entry.type !== "session");
			if (!transcriptWasInterrupted(entries)) reason = "it finished before the restart stopped it";
		}
		if (reason) outcome.notResumed.push({ id: sub.id, reason });
		else if (ref) plans.push({ sub, ref });
	}
	const contracts: { sub: RestartSubagent; ref: AgentRef; init: PersistedSessionInit }[] = [];
	for (const { sub, ref } of plans) {
		const init = (await SessionManager.peekSessionInit(ref.sessionFile!))?.init;
		if (!init) outcome.notResumed.push({ id: sub.id, reason: "its transcript has no session contract" });
		else if (init.isolated)
			outcome.notResumed.push({
				id: sub.id,
				reason: "it ran in an isolated workspace, and an isolated run is never revived",
			});
		else contracts.push({ sub, ref, init });
	}
	// Register without awaiting in between, so every outcome is settled before any
	// job body reads it for its note.
	for (const { sub, ref, init } of contracts) {
		const sessionFileOfRef = ref.sessionFile!;
		const structured = init.tools.includes("yield");
		try {
			manager.register(
				"task",
				sub.id,
				async ({ signal }) => {
					const live = await AgentLifecycleManager.global().ensureLive(sub.id);
					// A revived subagent is homed on this thread; a remote handle exposes no tool list.
					const available = isLocalAgentSession(live)
						? new Set([...live.getAllToolNames(), ...live.getMountedXdevToolNames()])
						: undefined;
					const missingTools = available ? init.tools.filter(name => !available.has(name)) : [];
					const children = subagents.filter(child => child.parentId === sub.id);
					const result = await runSubagentFollowUpTurn({
						id: sub.id,
						agent: persistedAgentDefinition(ref.displayName, init),
						message: buildRestartNote({
							subagent: sub,
							resumedChildren: children
								.filter(child => outcome.resumed.includes(child.id))
								.map(child => child.id),
							notResumedChildren: outcome.notResumed.filter(entry =>
								children.some(child => child.id === entry.id),
							),
							missingTools,
						}),
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
					// The result is delivered to the parent's session, which must be live and
					// fully revived by then: a parent subagent that finished before the restart
					// is parked, and one being resumed may still be reviving. `ensureLive`
					// revives the first and joins the second's revival.
					const parent = ref.parentId ? AgentRegistry.global().get(ref.parentId) : undefined;
					if (parent?.kind === "sub") {
						try {
							await AgentLifecycleManager.global().ensureLive(parent.id);
						} catch (error) {
							logger.warn("Could not revive the parent of a resumed subagent; its result waits in the job", {
								id: sub.id,
								parentId: parent.id,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
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
		} catch (error) {
			// The background job limit, for one: the transcript stays revivable by a message.
			outcome.notResumed.push({
				id: sub.id,
				reason: `its job could not start (${error instanceof Error ? error.message : String(error)}); send it a message to revive it`,
			});
		}
	}
	if (outcome.resumed.length > 0 || outcome.notResumed.length > 0) {
		logger.info("Resumed subagents after restart", { resumed: outcome.resumed, notResumed: outcome.notResumed });
	}
	return outcome;
}
