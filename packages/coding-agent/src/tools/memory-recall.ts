import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRecallSchema = type({
	query: type("string").describe("natural language search query"),
});

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	readonly description = recallDescription;
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = this.session.settings.get("memory.backend");
			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}
				try {
					const results = await state.recallResultsScoped(params.query);
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant memories found." }],
							details: {},
							useless: true,
						};
					}
					const formatted = state.formatScopedRecallWithIds(results);
					return {
						content: [
							{
								type: "text",
								text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
							},
						],
						details: {},
					};
				} catch (err) {
					logger.warn("recall failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				const response = await state.client.recall(state.bankId, params.query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
						useless: true,
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
