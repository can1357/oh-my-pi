import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { mnemonBackend } from "../mnemon/backend";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRetainSchema = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
		"category?": type("'preference' | 'decision' | 'insight' | 'fact' | 'context'").describe(
			"mnemon category; ignored by other backends",
		),
		"importance?": type("number").describe("mnemon importance 1-5; ignored by other backends"),
		"entities?": type("string").describe("comma-separated entities; ignored by other backends"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;
export class MemoryRetainTool implements AgentTool<typeof memoryRetainSchema> {
	readonly name = "retain";
	readonly approval = "read" as const;
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = memoryRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi" && backend !== "mnemon") return null;
		return new MemoryRetainTool(session);
	}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult> {
		const backend = this.session.settings.get("memory.backend");
		if (backend === "mnemon") {
			const context = {
				agentDir: this.session.settings.getAgentDir(),
				cwd: this.session.settings.getCwd(),
				session: this.session as never,
			};
			const ids: string[] = [];
			const lines: string[] = [];
			let stored = 0;
			for (const item of params.items) {
				const result = await mnemonBackend.save?.(context, {
					content: item.content,
					context: item.context,
					source: "coding-agent-retain",
					importance: item.importance,
					category: item.category,
					entities: item.entities,
				});

				if (!result || result.stored <= 0) {
					if (result?.message) lines.push(result.message);
					continue;
				}
				stored += result.stored;
				const id = result.ids?.[0];
				if (id) ids.push(id);
				const candidateLines = (result.candidates ?? []).slice(0, 6).map(candidate => {
					const score =
						candidate.score === undefined
							? ""
							: candidate.kind === "semantic"
								? ` sim=${candidate.score.toFixed(2)}`
								: ` hop=${candidate.score}`;
					const preview = candidate.content ? ` ${candidate.content}` : "";
					return `  - ${candidate.kind}${score} ${candidate.id}${preview}`;
				});
				lines.push(
					id
						? `${result.message ?? "added"} ${id}${candidateLines.length > 0 ? `\nCandidates (link if a real relationship exists):\n${candidateLines.join("\n")}` : ""}`
						: `${result.message ?? "added"}`,
				);
			}
			const noun = stored === 1 ? "memory" : "memories";
			const body = [`${stored} ${noun} stored.`, ...lines].filter(Boolean).join("\n");
			return {
				content: [{ type: "text", text: body }],
				details: { count: stored, ids },
			};
		}

		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}

			for (const item of params.items) {
				state.rememberScoped(item.content, {
					source: "coding-agent-retain",
					importance: 0.75,
					metadata: {
						session_id: state.sessionId,
						cwd: state.session.sessionManager.getCwd(),
						context: item.context ?? null,
						tool: "retain",
					},
					scope: "bank",
					extract: true,
					extractEntities: true,
					veracity: "tool",
					memoryType: "fact",
				});
			}

			const count = params.items.length;
			const noun = count === 1 ? "memory" : "memories";
			return {
				content: [{ type: "text", text: `${count} ${noun} stored.` }],
				details: { count },
			};
		}

		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}

		for (const item of params.items) {
			state.enqueueRetain(item.content, item.context);
		}

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}
