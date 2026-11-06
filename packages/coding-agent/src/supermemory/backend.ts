/**
 * Supermemory memory backend.
 *
 * First-turn recall (profile + search) and windowed auto-retention on top of the
 * AgentSession event stream. The runtime state is owned by the AgentSession; live
 * `supermemory.*` edits re-apply the whole backend (no `applySettings` hook), which
 * rebuilds the state, memory tools, and prompt.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { memoryToolRefs } from "../memory-backend/tool-names";
import type { MemoryBackend, MemoryBackendSearchResult, MemoryBackendStartOptions } from "../memory-backend/types";
import supermemoryInstructions from "../prompts/system/supermemory-instructions.md" with { type: "text" };
import { SupermemoryClient } from "./client";
import { isSupermemoryConfigured, loadSupermemoryConfig, resolveSupermemoryContainerTag } from "./config";
import { SupermemorySessionState } from "./state";

const NOT_INITIALISED = "Supermemory backend is not initialised for this session.";

export const supermemoryBackend: MemoryBackend = {
	id: "supermemory",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		const { session, settings } = options;
		const config = loadSupermemoryConfig(settings);
		if (!isSupermemoryConfigured(config)) {
			if (options.taskDepth === 0) {
				logger.warn(
					"Supermemory: memory.backend=supermemory but the API key or base URL is missing or rejected; backend inert.",
				);
			}
			return;
		}
		try {
			// Subagents get their own state for the recall/retain tools, but never
			// auto-recall or auto-retain: that stays with the top-level session.
			const state = new SupermemorySessionState({
				session,
				client: new SupermemoryClient(config.baseUrl, config.apiKey),
				config,
				containerTag: resolveSupermemoryContainerTag(session.sessionManager.getCwd(), config.scoping),
				automatic: options.taskDepth === 0,
			});
			await session.setSupermemorySessionState(state)?.dispose();
			state.attachSessionListeners();
		} catch (error) {
			logger.warn("Supermemory: backend startup failed; memory backend inert.", { error: String(error) });
		}
	},

	async buildDeveloperInstructions(_agentDir, _cwd, settings, session): Promise<string | undefined> {
		if (!isSupermemoryConfigured(loadSupermemoryConfig(settings))) return undefined;
		const parts = [
			prompt.render(supermemoryInstructions, { toolRefs: memoryToolRefs(session?.getXdevToolEntries()) }),
		];
		const snippet = session?.getSupermemorySessionState()?.lastRecallSnippet;
		if (snippet) parts.push(snippet);
		return parts.join("\n\n");
	},

	async beforeAgentStartPrompt(session, promptText, signal) {
		const state = session.getSupermemorySessionState();
		const preparation = await state?.beforeAgentStartPrompt(promptText, signal);
		if (!state || !preparation) return undefined;
		return {
			context: preparation.context,
			commit: () => session.getSupermemorySessionState() === state && preparation.commit(),
		};
	},

	async clear(_agentDir, _cwd, session): Promise<void> {
		// Supermemory memory is server-side: land pending writes and drop the cached recall,
		// keeping the state (and its tools) alive. Delete server-side memories from the console.
		const state = session?.getSupermemorySessionState();
		if (state) {
			await state.flush();
			state.lastRecallSnippet = undefined;
		}
		logger.warn(
			"Supermemory memory is server-side; only the local recall cache was cleared. " +
				"Delete memories from the Supermemory console to wipe server-side state.",
		);
	},

	async enqueue(_agentDir, _cwd, session): Promise<void> {
		const state = session?.getSupermemorySessionState();
		if (state?.automatic) await state.forceRetainCurrentSession();
	},

	async status({ session }) {
		const state = session?.getSupermemorySessionState();
		if (!state) {
			return { backend: "supermemory", active: false, writable: false, searchable: false, message: NOT_INITIALISED };
		}
		return {
			backend: "supermemory",
			active: true,
			writable: true,
			searchable: true,
			scope: state.containerTag,
			lastRecall: state.lastRecallSnippet !== undefined,
		};
	},

	async search({ session }, query, options): Promise<MemoryBackendSearchResult> {
		const state = session?.getSupermemorySessionState();
		if (!state) return { backend: "supermemory", query, count: 0, items: [], message: NOT_INITIALISED };
		try {
			const results = await state.search(query, options?.limit, options?.signal);
			return {
				backend: "supermemory",
				query,
				count: results.length,
				items: results.map(item => ({
					id: item.id,
					content: item.content,
					timestamp: item.updatedAt,
					score: item.similarity,
				})),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("Supermemory: search failed", { error: message });
			return { backend: "supermemory", query, count: 0, items: [], message };
		}
	},

	async save({ session }, input) {
		const state = session?.getSupermemorySessionState();
		if (!state) return { backend: "supermemory", stored: 0, message: NOT_INITIALISED };
		try {
			const document = await state.save(input.content, {
				source: input.source ?? "omp",
				...(input.context ? { context: input.context } : {}),
			});
			return { backend: "supermemory", stored: 1, ids: [document.id], queued: document.status === "queued" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("Supermemory: save failed", { error: message });
			return { backend: "supermemory", stored: 0, message };
		}
	},
};
