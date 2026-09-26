import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { isDakeraConfigured, loadDakeraConfig } from "../dakera/config";
import { runDakeraReflect } from "../dakera/reflect";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { ensureBankExists } from "../hindsight/bank";
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryReflectSchema = type({
	query: type("string").describe("question to answer"),
	"context?": type("string").describe("optional context"),
});

export type MemoryReflectParams = typeof memoryReflectSchema.infer;

/** Recall query for a reflection: the question plus any caller-supplied context. */
function recallQuery(params: MemoryReflectParams): string {
	return params.context?.trim()
		? `${params.query.trim()}\n\nAdditional context:\n${params.context.trim()}`
		: params.query;
}

export class MemoryReflectTool implements AgentTool<typeof memoryReflectSchema> {
	readonly name = "reflect";
	readonly approval = "read" as const;
	readonly label = "Reflect";
	readonly description = reflectDescription;
	readonly parameters = memoryReflectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Synthesize an answer from long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryReflectTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi" && backend !== "dakera") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		if (backend === "dakera" && !isDakeraConfigured(loadDakeraConfig(session.settings))) return null;
		return new MemoryReflectTool(session);
	}

	async execute(_id: string, params: MemoryReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = cfgMemoryBackend.get(this.session.settings);
			if (backend === "dakera") {
				const state = this.session.getDakeraSessionState?.();
				if (!state) {
					throw new Error("Dakera backend is not initialised for this session.");
				}
				const modelRegistry = this.session.modelRegistry;
				if (!modelRegistry) {
					throw new Error("Dakera reflect has no model registry for this session.");
				}

				// Dakera synthesizes nothing server-side, so the answer is composed
				// here from the recalled memories (see dakera/reflect.ts).
				const hits = await state.recallHits(recallQuery(params), signal);
				const text = await runDakeraReflect({
					config: state.config,
					hits,
					settings: this.session.settings,
					modelRegistry,
					sessionId: state.sessionId,
					query: params.query,
					context: params.context,
					signal,
				});
				return { content: [{ type: "text", text }], details: {} };
			}

			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}

				try {
					const results = await state.recallResultsScoped(recallQuery(params));
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant information found to reflect on." }],
							details: {},
						};
					}
					const summary = state.formatContextScoped(results);
					return {
						content: [{ type: "text", text: `Based on recalled memories:\n\n${summary}` }],
						details: {},
					};
				} catch (err) {
					logger.warn("reflect failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				await ensureBankExists(state.client, state.bankId, state.config, state.banksSet);
				const response = await state.client.reflect(state.bankId, params.query, {
					context: params.context,
					budget: state.config.recallBudget,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const text = response.text?.trim() || "No relevant information found to reflect on.";
				return {
					content: [{ type: "text", text }],
					details: {},
				};
			} catch (err) {
				logger.warn("reflect failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
