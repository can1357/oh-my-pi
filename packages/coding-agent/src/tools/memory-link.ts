import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { mnemonBackend } from "../mnemon/backend";
import linkDescription from "../prompts/tools/link.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryLinkSchema = type({
	id1: type("string").describe("source insight UUID; for supersedes this is the new memory"),
	id2: type("string").describe("target insight UUID; for supersedes this is the old memory"),
	type: type("'causal' | 'semantic' | 'temporal' | 'entity' | 'supersedes'").describe("edge type"),
	weight: type("number").describe("edge weight 0-1; use 1 for supersedes"),
});

export type MemoryLinkParams = typeof memoryLinkSchema.infer;

export class MemoryLinkTool implements AgentTool<typeof memoryLinkSchema> {
	readonly name = "link";
	readonly approval = "write" as const;
	readonly label = "Link";
	readonly description = linkDescription;
	readonly parameters = memoryLinkSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Link two native Mnemon memories with a typed edge";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryLinkTool | null {
		if (session.settings.get("memory.backend") !== "mnemon") return null;
		return new MemoryLinkTool(session);
	}

	async execute(_id: string, params: MemoryLinkParams): Promise<AgentToolResult> {
		const result = await mnemonBackend.link?.(
			{
				agentDir: this.session.settings.getAgentDir(),
				cwd: this.session.settings.getCwd(),
				session: this.session as never,
			},
			params,
		);
		if (result?.status !== "linked") {
			return {
				content: [{ type: "text", text: result?.message ?? "Link rejected." }],
				details: result ?? { status: "rejected" },
				useless: true,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: `linked ${result.id1} → ${result.id2} (${result.type}, ${result.weight})`,
				},
			],
			details: result,
		};
	}
}
