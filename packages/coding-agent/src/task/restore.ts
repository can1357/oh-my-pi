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
 * cut-off turn and drives it to `yield`, and the parent receives the result as the
 * ordinary `async-result` of a job with the subagent's id, the id its first run's
 * job had, so a parent waiting on that job finds it again.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { AsyncJobError } from "../async";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { hasRestorableTurn } from "../session/exit-diagnostics";
import { extractSessionInit } from "../session/session-manager";
import { collectSubSessions } from "../session/sub-sessions";
import type { EventBus } from "../utils/event-bus";
import { runSubagentFollowUpTurn } from "./executor";
import { persistedAgentDefinition, persistedAgentName, resolveSpawner } from "./persisted-revive";
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
	const turn = await session.restoreInterruptedTurn();
	return { turn, subagents };
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
	const subSessions = await collectSubSessions(sessionFile, key => {
		logger.warn("Subagent transcript unreadable; not restored", { key });
	});
	// Parents first: a child's result is delivered to its parent's session.
	const keys = Object.keys(subSessions).sort((a, b) => a.split("/").length - b.split("/").length);
	const restored: string[] = [];
	for (const key of keys) {
		const sub = subSessions[key]!;
		if (sub.aborted || !hasRestorableTurn(sub.entries)) continue;
		const id = sub.agentId;
		const ref = registry.get(id);
		const init = extractSessionInit(sub.entries);
		if (!ref?.sessionFile || ref.kind !== "sub" || !init || init.isolated) {
			logger.debug("Interrupted subagent cannot be revived; not restored", { id });
			continue;
		}
		const sessionFileOfRef = ref.sessionFile;
		const structured = init.tools.includes("yield");
		manager.register(
			"task",
			id,
			async ({ signal }) => {
				// `subagent_stop` reports the persisted definition and the session that spawned this child.
				const spawner = await resolveSpawner(registry, session, ref, sub.header?.parentSession);
				const result = await runSubagentFollowUpTurn({
					id,
					agent: persistedAgentDefinition(ref.displayName, init),
					agentType: persistedAgentName(ref.displayName, init),
					parentSessionId: spawner.sessionId,
					parentSessionFile: spawner.sessionFile,
					message: init.task,
					restore: true,
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
			{ id, agentId: id, ownerId: ref.parentId },
		);
		restored.push(id);
	}
	if (restored.length > 0) logger.info("Restored interrupted subagents", { ids: restored });
	return restored;
}
