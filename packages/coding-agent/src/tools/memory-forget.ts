import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { mnemonBackend } from "../mnemon/backend";
import forgetDescription from "../prompts/tools/forget.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryForgetSchema = type({
	id: type("string").describe("insight UUID to soft-delete"),
});

export type MemoryForgetParams = typeof memoryForgetSchema.infer;

export class MemoryForgetTool implements AgentTool<typeof memoryForgetSchema> {
	readonly name = "forget";
	readonly approval = "write" as const;
	readonly label = "Forget";
	readonly description = forgetDescription;
	readonly parameters = memoryForgetSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Soft-delete a native Mnemon memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryForgetTool | null {
		if (session.settings.get("memory.backend") !== "mnemon") return null;
		return new MemoryForgetTool(session);
	}

	async execute(_id: string, params: MemoryForgetParams): Promise<AgentToolResult> {
		const result = await mnemonBackend.forget?.(
			{
				agentDir: this.session.settings.getAgentDir(),
				cwd: this.session.settings.getCwd(),
				session: this.session as never,
			},
			params.id,
		);
		if (result?.status !== "deleted") {
			return {
				content: [{ type: "text", text: result?.message ?? "Forget rejected." }],
				details: result ?? { status: "rejected" },
				useless: true,
			};
		}
		return {
			content: [{ type: "text", text: `forgot ${result.id}` }],
			details: result,
		};
	}
}
