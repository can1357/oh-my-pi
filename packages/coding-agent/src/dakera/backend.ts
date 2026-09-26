/**
 * Dakera memory backend.
 *
 * Remote, self-hosted memory over plain HTTP. Isolation is the `agent_id`
 * (Dakera has no bank), so a session's scope derives from settings plus the
 * working directory — which also means a subagent in the same project resolves
 * to the same agent id without any parent-state plumbing.
 *
 * Auto-recall runs on the first turn of a transcript; auto-retain runs on
 * `agent_end` every N user turns. Both live in `DakeraSessionState`.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { flattenAgentMessages } from "../hindsight/transcript";
import { redactMemoryTextFields } from "../memory-backend/redact";
import type {
	MemoryBackend,
	MemoryBackendSaveResult,
	MemoryBackendSearchItem,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
	MemoryPromptPreparation,
} from "../memory-backend/types";
import instructions from "../prompts/memories/dakera-instructions.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { computeAgentScope } from "./bank";
import {
	type DakeraApi,
	type DakeraRecallHit,
	collectMemoryIds,
	createDakeraClient,
	formatDakeraTimestamp,
	recallHitRank,
} from "./client";
import { type DakeraConfig, isDakeraConfigured, loadDakeraConfig } from "./config";
import { DakeraSessionState, getDakeraSessionState, setDakeraSessionState } from "./state";

/**
 * Page size used when listing an agent's memories for `/memory clear` and
 * `/memory stats`. The server's own default page size is undocumented, so every
 * listing asks explicitly and renders a count of exactly that length as a floor
 * rather than a total.
 */
const MEMORY_LIST_LIMIT = 1000;
/**
 * Anti-runaway budget for `clear()`: how many rows it will hand to `forget`
 * before giving up. A store that drains normally never reaches it — an empty
 * listing ends the loop first, and a listing pinned by undeletable rows still
 * makes progress on the rows behind them. The budget exists only for a server
 * that mints fresh ids on every listing, which would otherwise loop forever.
 */
const CLEAR_MAX_ROWS = 100_000;
/** Reason reported when clear() ends on the budget above rather than on a stop condition. */
const BUDGET_STOPPED = `the ${CLEAR_MAX_ROWS.toLocaleString("en-US")}-row anti-runaway budget was reached`;

const NOT_INITIALISED = "Dakera backend is not initialised for this session.";

interface DakeraTarget {
	config: DakeraConfig;
	client: DakeraApi;
	agentId: string;
	retainTags?: string[];
	recallTags?: string[];
}

/** Resolve what `settings` plus `cwd` point at, or `undefined` when unconfigured. */
async function resolveDakeraTarget(settings: Settings, cwd: string): Promise<DakeraTarget | undefined> {
	const config = loadDakeraConfig(settings);
	if (!isDakeraConfigured(config)) return undefined;
	return { config, client: createDakeraClient(config), ...(await computeAgentScope(config, cwd)) };
}

/**
 * Dakera target for a session. A live state wins so a settings edit cannot
 * silently move writes to a different agent id mid-session; without one,
 * settings plus cwd resolve the scope `start()` would have installed.
 */
async function resolveTarget(session: AgentSession | undefined): Promise<DakeraTarget | undefined> {
	const state = session ? getDakeraSessionState(session) : undefined;
	if (state) {
		return {
			config: state.config,
			client: state.client,
			agentId: state.agentId,
			retainTags: state.retainTags,
			recallTags: state.recallTags,
		};
	}
	return session ? await resolveDakeraTarget(session.settings, session.sessionManager.getCwd()) : undefined;
}

function searchItems(hits: DakeraRecallHit[]): MemoryBackendSearchItem[] {
	return hits.map(hit => ({
		id: hit.memory.id,
		content: hit.memory.content,
		source: hit.memory.memory_type,
		timestamp: formatDakeraTimestamp(hit.memory.created_at),
		score: recallHitRank(hit),
	}));
}

function inactiveStatus(): MemoryBackendStatus {
	return { backend: "dakera", active: false, writable: false, searchable: false, message: NOT_INITIALISED };
}

function listCount(count: number): string {
	return count >= MEMORY_LIST_LIMIT ? `${count}+ (listing capped at ${MEMORY_LIST_LIMIT})` : String(count);
}

export const dakeraBackend: MemoryBackend = {
	id: "dakera",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		const { session, settings, taskDepth } = options;
		const sessionId = session.sessionId;
		if (!sessionId) return;

		try {
			const config = loadDakeraConfig(settings);
			if (!isDakeraConfigured(config)) {
				logger.warn("Dakera: memory.backend=dakera but dakera.apiUrl is unset; backend inert.");
				return;
			}

			const scope = await computeAgentScope(config, session.sessionManager.getCwd());
			const state = new DakeraSessionState({
				sessionId,
				client: createDakeraClient(config),
				agentId: scope.agentId,
				retainTags: scope.retainTags,
				recallTags: scope.recallTags,
				config,
				session,
				// A subagent shares the parent's agent id (same cwd, same scheme) but
				// runs its own turn loop: recalling or retaining its internal
				// exploration would duplicate the parent's memory and pollute the agent.
				autonomous: taskDepth === 0,
			});

			const previous = setDakeraSessionState(session, state);
			if (previous && previous !== state) {
				await previous.awaitPending();
				previous.dispose();
			}
			state.attachSessionListeners();
		} catch (error) {
			// Contract: a memory backend must never break the agent loop.
			logger.warn("Dakera: backend startup failed; memory backend inert.", { error: String(error) });
		}
	},

	async buildDeveloperInstructions(_agentDir, settings, session): Promise<string | undefined> {
		const config = loadDakeraConfig(settings);
		if (!isDakeraConfigured(config)) return undefined;

		const recall = session ? getDakeraSessionState(session)?.lastRecallSnippet : undefined;
		return recall ? `${instructions}\n\n${recall}` : instructions;
	},

	async beforeAgentStartPrompt(
		session: AgentSession,
		promptText: string,
	): Promise<MemoryPromptPreparation | undefined> {
		const state = getDakeraSessionState(session);
		if (!state) return undefined;

		const preparation = await state.beforeAgentStartPrompt(promptText);
		if (!preparation) return undefined;
		return {
			context: preparation.context,
			commit: () => getDakeraSessionState(session) === state && preparation.commit(),
		};
	},

	async clear(_agentDir, _cwd, session): Promise<void> {
		const target = await resolveTarget(session);
		if (!target) return;
		const state = session ? getDakeraSessionState(session) : undefined;
		const { client, agentId } = target;

		// Dakera holds the only copy, so this really is a wipe — unlike Hindsight,
		// where the server-side bank outlives any local cache we can clear.
		// listMemories has no offset/cursor (verified against the official SDK),
		// so the wipe is drain-style: forget a page, list again, stop when the
		// listing comes back empty. Progress is counted in *newly attempted ids*,
		// never in page size: a listing that stays at the cap because the server
		// refills it still holds deletable rows, and stopping on "the page did not
		// shrink" (the previous check) abandoned a wipe after a single row the API
		// could not address. Forgetting is server-confirmed by the listing itself —
		// `deleted_count` includes derived rows, so it is never a tally.
		const attempted = new Set<string>();
		let stopped: string | undefined;
		/** Rows left, when a stop condition already saw the authoritative page. */
		let remaining: number | undefined;
		for (;;) {
			const memories = await client.listMemories(agentId, { limit: MEMORY_LIST_LIMIT });
			if (memories.length === 0) {
				remaining = 0;
				break;
			}
			const ids = collectMemoryIds(memories).filter(id => !attempted.has(id));
			if (ids.length === 0) {
				// Nothing new is addressable: either rows came back after being
				// forgotten, or the listing carries no ids at all (an older server).
				// Either way another pass cannot change the answer.
				stopped = attempted.size === 0 ? "the listing carried no memory ids" : "forgotten rows keep coming back";
				remaining = memories.length;
				break;
			}
			if (attempted.size + ids.length > CLEAR_MAX_ROWS) break;
			for (const id of ids) attempted.add(id);
			await client.forget(agentId, ids);
		}
		// A budget stop says nothing about the store: re-list to find out whether
		// the wipe actually finished.
		const left = remaining ?? (await client.listMemories(agentId, { limit: MEMORY_LIST_LIMIT })).length;
		if (left > 0) {
			logger.warn(
				`Dakera: agent ${agentId} clear stopped with ${listCount(left)} rows left after ` +
					`${attempted.size} forgotten (${stopped ?? BUDGET_STOPPED}).`,
			);
		} else if (attempted.size === 0) {
			logger.warn(`Dakera: agent ${agentId} had no memories to clear.`);
		}
		state?.resetConversationTracking();
	},

	async enqueue(_agentDir, _cwd, session): Promise<void> {
		const state = session ? getDakeraSessionState(session) : undefined;
		if (!state) return;
		await state.forceRetainCurrentSession();
	},

	async save({ session }, input): Promise<MemoryBackendSaveResult> {
		const target = await resolveTarget(session);
		if (!target) return { backend: "dakera", stored: 0, message: NOT_INITIALISED };

		const content = input.content.trim();
		if (!content) return { backend: "dakera", stored: 0, message: "Nothing to store: memory content is empty." };

		const memory = await target.client.store(
			target.agentId,
			redactMemoryTextFields({
				content,
				memoryType: "semantic",
				importance: input.importance ?? target.config.retainImportance,
				tags: target.retainTags,
				metadata: input.context || input.source ? { context: input.context, source: input.source } : undefined,
				sessionId: session?.sessionId ?? undefined,
			}),
		);
		// Dakera has no queue: the row is stored by the time this returns, but a
		// reply without an id is an answer we cannot address, so it is not a store.
		return {
			backend: "dakera",
			stored: memory.id ? 1 : 0,
			ids: memory.id ? [memory.id] : undefined,
			message: memory.id ? "Stored in Dakera." : "Dakera stored the memory but returned no id.",
		};
	},

	async status({ session }): Promise<MemoryBackendStatus> {
		const target = await resolveTarget(session);
		if (!target) return inactiveStatus();

		try {
			const memories = await target.client.listMemories(target.agentId, { limit: MEMORY_LIST_LIMIT });
			return {
				backend: "dakera",
				active: true,
				writable: true,
				searchable: true,
				scope: target.agentId,
				message: `${listCount(memories.length)} memories at ${target.config.apiUrl}`,
			};
		} catch (error) {
			return {
				backend: "dakera",
				active: true,
				writable: false,
				searchable: false,
				scope: target.agentId,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},

	async search({ session }, query, options) {
		const target = await resolveTarget(session);
		if (!target) return { backend: "dakera", query, count: 0, items: [], message: NOT_INITIALISED };

		try {
			const hits = await target.client.recall(target.agentId, query, {
				topK: options?.limit ?? target.config.recallTopK,
				minImportance: target.config.recallMinImportance,
				rerank: target.config.recallRerank,
				tags: target.recallTags,
				signal: options?.signal,
			});
			const ranked = [...hits].sort((a, b) => recallHitRank(b) - recallHitRank(a));
			return { backend: "dakera", query, count: ranked.length, items: searchItems(ranked) };
		} catch (error) {
			return {
				backend: "dakera",
				query,
				count: 0,
				items: [],
				message: `Dakera search failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	},

	async stats(_agentDir, _cwd, session): Promise<string | undefined> {
		const target = await resolveTarget(session);
		if (!target) return undefined;

		const memories = await target.client.listMemories(target.agentId, { limit: MEMORY_LIST_LIMIT });
		const byType = new Map<string, number>();
		for (const memory of memories) {
			const type = memory.memory_type ?? "unknown";
			byType.set(type, (byType.get(type) ?? 0) + 1);
		}

		const lines = [
			"# Dakera Memory Stats",
			"",
			`- Agent: \`${target.agentId}\``,
			`- Server: ${target.config.apiUrl}`,
			`- Memories: ${listCount(memories.length)}`,
			`- Retain: ${target.config.retainMode} every ${target.config.retainEveryNTurns} user turns`,
			"",
			"## By type",
		];
		for (const [type, count] of [...byType].sort(([a], [b]) => a.localeCompare(b))) {
			lines.push(`- ${type}: ${count}`);
		}
		return lines.join("\n");
	},

	async preCompactionContext(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined> {
		if (!isDakeraConfigured(loadDakeraConfig(settings))) return undefined;

		const state = session ? getDakeraSessionState(session) : undefined;
		if (!state) return undefined;

		return await state.recallForCompaction(flattenAgentMessages(messages));
	},
};
