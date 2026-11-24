/**
 * `omp --restore`: a session goes on with what its last process left unfinished when
 * it ended ({@link restoreSession}): the turn it was in
 * ({@link AgentSession.restoreInterruptedTurn}) and the subagents it was running.
 *
 * Every persisted subagent transcript under the session ({@link collectSubSessions})
 * that its process left mid-turn ({@link hasRestorableTurn}), was not killed (no
 * tombstone) and can be revived (a `session_init` contract, not isolated) runs one
 * more monitored turn as a background job of its parent: the lifecycle reviver
 * rebuilds it from its transcript, {@link runSubagentFollowUpTurn} goes on with the
 * cut-off turn and drives it to `yield` (then through the steps a stepped run had not
 * sent yet). The native task's durable proof and regression contract authorizes
 * completion; a successful worker exit alone never does. Live parent checks are
 * re-registered by the stop hooks before the interrupted parent turn continues.
 * The parent receives the verified result as the ordinary `async-result` of the
 * original job, so a parent waiting on that job finds it again.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { AsyncJobError } from "../async";
import { settledParkedOutcomes } from "../launch/parked-outcomes";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { hasRestorableTurn } from "../session/exit-diagnostics";
import { extractSessionInit } from "../session/session-manager";
import { collectSubSessions } from "../session/sub-sessions";
import type { EventBus } from "../utils/event-bus";
import { runRestoredAtaskTask } from "./atask-restore";
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "./executor";
import { persistedAgentDefinition, persistedAgentName } from "./persisted-revive";
import { readStepProgress } from "./steps";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";

/** Where restored subagents' lifecycle and progress frames go, as a live run's do. */
export interface RestoreOptions {
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

/** What `omp --restore` went on with. */
export interface RestoreOutcome {
	/** The session's own interrupted turn goes on. */
	turn: boolean;
	/** Ids of the subagents that go on with theirs, parents before their children. */
	subagents: string[];
}

/**
 * Has `session` go on with what its last process left unfinished: its subagents'
 * interrupted turns, each as a background job of its parent (registered first, so
 * a resumed turn waiting on such a job finds it), then its own interrupted turn.
 */
export async function restoreSession(session: AgentSession, options: RestoreOptions = {}): Promise<RestoreOutcome> {
	const subagents = await restoreSubagents(session, options);
	await fillParkedToolCalls(session);
	await session.recheckNativeTaskHooks?.();
	const turn = await session.restoreInterruptedTurn();
	return { turn, subagents };
}

/**
 * Answers the session's parked tool calls whose detached job has settled, so the turn they cut
 * short can go on. A broker that cannot be reached leaves every call parked rather than failing
 * the restore: the calls stay answerable on the next start.
 */
async function fillParkedToolCalls(session: AgentSession): Promise<void> {
	const parked = session.parkedToolCalls();
	if (parked.length === 0) return;
	try {
		session.fillParkedToolCalls(await settledParkedOutcomes(session.sessionManager.getCwd(), parked));
	} catch (error) {
		logger.warn("Parked tool calls left parked: daemon broker unavailable", { error: String(error) });
	}
}

/**
 * Has every subagent of `session` that its last process left mid-turn go on with that
 * turn (see the module docs). Nothing is restored for a session without a file, or
 * without background jobs (the `async.enabled` setting off), which could not deliver
 * the results.
 */
async function restoreSubagents(session: AgentSession, options: RestoreOptions): Promise<string[]> {
	const sessionFile = session.sessionManager.getSessionFile();
	const manager = session.asyncJobManager;
	if (!sessionFile || !manager) return [];
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, sessionFile);
	const subSessions = await collectSubSessions(sessionFile, {
		onUnreadable: key => logger.warn("Subagent transcript unreadable; not restored", { key }),
	});
	// Parents first: a child's result is delivered to its parent's session.
	const keys = Object.keys(subSessions).sort((a, b) => a.split("/").length - b.split("/").length);
	const restored: string[] = [];
	for (const key of keys) {
		const sub = subSessions[key]!;
		if (sub.aborted || !hasRestorableTurn(sub.entries)) continue;
		const id = sub.agentId;
		if (manager.getJob(id)) continue;
		const ref = registry.get(id);
		const init = extractSessionInit(sub.entries);
		if (!ref?.sessionFile || ref.kind !== "sub" || !init || init.isolated) {
			logger.debug("Interrupted subagent cannot be revived; not restored", { id });
			continue;
		}
		const sessionFileOfRef = ref.sessionFile;
		const agentName = persistedAgentName(ref.displayName, init);
		const steps = readStepProgress(sub.entries);
		manager.register(
			"task",
			id,
			async ({ signal }) => {
				const sessionId = session.sessionManager.getSessionId?.();
				if (!sessionId) throw new Error(`Atask verification parent session unavailable for restored worker ${id}`);
				const result = await runRestoredAtaskTask(
					{ sessionId, nativeId: id, signal },
					async (_assignment, _workspace, _taskId, workerSignal) => {
						const result = await runSubagentFollowUpTurn({
							id,
							agent: persistedAgentDefinition(ref.displayName, init),
							message: init.task,
							restore: true,
							steps,
							workPoolYieldItems: init.workPoolYieldItems,
							outputSchema: init.outputSchema,
							outputSchemaMode: init.outputSchemaMode,
							signal: workerSignal,
							eventBus: options.eventBus,
							subagentEventBus: options.subagentEventBus,
							artifactsDir: path.dirname(sessionFileOfRef),
							maxRuntimeMs: cfgTaskMaxRuntimeMs.get(session.settings),
							...softRequestBudgetFor(agentName, session.settings),
						});
						if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
							throw new AsyncJobError(
								formatTaskResultSummary(result, { totalDurationMs: result.durationMs }),
								result.structuredOutput,
							);
						}
						return result;
					},
				);
				if (!result) return "Restored task proof and regression verified without resuming the worker";
				const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
				return result.structuredOutput ? { text, structured: result.structuredOutput } : text;
			},
			{ id, agentId: id, ownerId: ref.parentId },
		);
		restored.push(id);
	}
	if (restored.length > 0) logger.info("Restored interrupted subagents", { ids: restored });
	return restored;
}
