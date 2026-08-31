import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import description from "../prompts/tools/assignment-complete.md" with { type: "text" };

const assignmentCompleteSchema = type({}).describe("complete the active Assignment");

/** Explicit semantic boundary for an Assignment Session; the universal gate owns execution. */
export class AssignmentCompleteTool implements AgentTool<typeof assignmentCompleteSchema> {
	readonly name = "assignment_complete";
	readonly approval = "write" as const;
	readonly label = "Complete Assignment";
	readonly summary = "Complete the Assignment and revoke mutation authority";
	readonly description = description;
	readonly parameters = assignmentCompleteSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	async execute(): Promise<AgentToolResult> {
		throw new Error("Assignment completion requires the authenticated Assignment capability runtime");
	}
}
