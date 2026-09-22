import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { mnemonBackend } from "../mnemon/backend";
import relatedDescription from "../prompts/tools/related.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRelatedSchema = type({
	id: type("string").describe("insight UUID to walk from"),
	"type?": type("'causal' | 'semantic' | 'temporal' | 'entity' | 'supersedes'").describe("optional edge filter"),
	"depth?": type("number").describe("max hops, 1-4, default 2"),
});

export type MemoryRelatedParams = typeof memoryRelatedSchema.infer;

export class MemoryRelatedTool implements AgentTool<typeof memoryRelatedSchema> {
	readonly name = "related";
	readonly approval = "read" as const;
	readonly label = "Related";
	readonly description = relatedDescription;
	readonly parameters = memoryRelatedSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Walk typed neighbors of a native Mnemon memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRelatedTool | null {
		if (session.settings.get("memory.backend") !== "mnemon") return null;
		return new MemoryRelatedTool(session);
	}

	async execute(_id: string, params: MemoryRelatedParams): Promise<AgentToolResult> {
		const result = await mnemonBackend.related?.(
			{
				agentDir: this.session.settings.getAgentDir(),
				cwd: this.session.settings.getCwd(),
				session: this.session as never,
			},
			params,
		);
		if (!result || result.count === 0) {
			return {
				content: [{ type: "text", text: result?.message || "No related memories found." }],
				details: result ?? { count: 0 },
				useless: true,
			};
		}
		const formatted = result.items
			.map(item => {
				const meta = [
					item.category,
					item.importance !== undefined ? `imp ${item.importance}` : undefined,
					item.via,
					item.depth !== undefined ? `hop ${item.depth}` : undefined,
				]
					.filter(Boolean)
					.join(", ");
				return `- (${meta || "related"}) ${item.id}: ${item.content}`;
			})
			.join("\n");
		return {
			content: [
				{
					type: "text",
					text: `Found ${result.count} related ${result.count === 1 ? "memory" : "memories"}:\n\n${formatted}`,
				},
			],
			details: { count: result.count, id: result.id },
		};
	}
}
