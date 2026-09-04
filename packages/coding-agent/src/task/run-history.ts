/**
 * Cross-session runtime history per subagent type, backing the HUD's
 * progress bar from the first spawn of a session.
 *
 * Persisted in agent.db's `subagent_runs` table (see {@link AgentStorage}).
 * {@link recordSubagentRun} is called once per finished run; the HUD reads
 * {@link getSubagentDurationHistory} synchronously per frame. In-session peers
 * still win when present (same batch, same load); this is the fallback for a
 * batch whose first agent has not finished yet.
 *
 * Until {@link loadSubagentRunHistory} resolves, runs stay in memory only —
 * headless paths and tests that never initialize the store never open agent.db.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../session/agent-storage";

/** Newest-first samples kept per agent type; older runs drift out of the median. */
const HISTORY_PER_AGENT = 20;

let history: Record<string, number[]> = {};
let storage: AgentStorage | undefined;
let loadPromise: Promise<void> | undefined;

function pushSample(target: Record<string, number[]>, agent: string, durationMs: number): void {
	const samples = (target[agent] ??= []);
	samples.unshift(durationMs);
	if (samples.length > HISTORY_PER_AGENT) samples.length = HISTORY_PER_AGENT;
}

/** Load persisted run durations once per process; concurrent calls share one read. */
export function loadSubagentRunHistory(): Promise<void> {
	loadPromise ??= (async () => {
		try {
			const opened = await AgentStorage.open();
			const persisted = opened.listRecentSubagentRuns();
			for (const agent in persisted) persisted[agent] = persisted[agent]!.slice(0, HISTORY_PER_AGENT);
			// Runs that finished while the load was in flight are newer than anything persisted.
			for (const agent in history) {
				for (let i = history[agent]!.length - 1; i >= 0; i--) pushSample(persisted, agent, history[agent]![i]!);
			}
			history = persisted;
			storage = opened;
		} catch (err) {
			logger.warn("Failed to load subagent run history", { error: String(err) });
		}
	})();
	return loadPromise;
}

/** Newest-first durations of finished runs for an agent type; empty when none are known. */
export function getSubagentDurationHistory(agent: string): readonly number[] {
	return history[agent] ?? [];
}

/** Record a finished run (completed only — aborted/failed runs are not a runtime sample). */
export function recordSubagentRun(agent: string, durationMs: number, requests: number): void {
	if (!(durationMs > 0)) return;
	pushSample(history, agent, durationMs);
	storage?.recordSubagentRun(agent, durationMs, requests);
}

/** Test-only: reset in-memory history state. */
export function __resetSubagentRunHistoryForTests(): void {
	history = {};
	storage = undefined;
	loadPromise = undefined;
}
