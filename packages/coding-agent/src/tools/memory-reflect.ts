import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { ensureBankExists } from "../hindsight/bank";
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryReflectSchema = type({
	query: type("string").describe("question to answer"),
	"context?": type("string").describe("optional context"),
});

export type MemoryReflectParams = typeof memoryReflectSchema.infer;

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
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		return new MemoryReflectTool(session);
	}

	async execute(_id: string, params: MemoryReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = this.session.settings.get("memory.backend");
			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}

				try {
					const query = params.context?.trim()
						? `${params.query.trim()}\n\nAdditional context:\n${params.context.trim()}`
						: params.query;
					const results = await state.recallResultsScoped(query);
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
				// Snapshot routing before the first await so a live primary rebuild
				// cannot send this call to a bank that was never ensured.
				const client = state.client;
				const bankId = state.bankId;
				const config = state.config;
				const banksSet = state.banksSet;
				const recallTags = state.recallTags;
				const recallTagsMatch = state.recallTagsMatch;
				await ensureBankExists(client, bankId, config, banksSet);
				const response = await client.reflect(bankId, params.query, {
					context: params.context,
					budget: config.recallBudget,
					tags: recallTags,
					tagsMatch: recallTagsMatch,
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
