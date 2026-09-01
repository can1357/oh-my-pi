import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import checkpointDescription from "../prompts/tools/checkpoint.md" with { type: "text" };
import rewindDescription from "../prompts/tools/rewind.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

export interface CheckpointState {
	/** Number of in-memory messages at checkpoint (AFTER checkpoint tool result is appended) */
	checkpointMessageCount: number;
	/** Session entry ID at checkpoint (for session tree branching) */
	checkpointEntryId: string | null;
	/** Timestamp */
	startedAt: string;
}

export interface CompletedRewindState {
	/** Report retained after a successful rewind. */
	report: string;
	/** Timestamp for the checkpoint that was rewound. */
	startedAt: string;
	/** Timestamp when the rewind completed. */
	rewoundAt: string;
}

const checkpointSchema = type({
	goal: type("string").describe("investigation goal"),
});

type CheckpointParams = typeof checkpointSchema.infer;

const rewindSchema = type({
	report: type("string").describe("investigation findings"),
});

type RewindParams = typeof rewindSchema.infer;

export interface CheckpointToolDetails {
	goal: string;
	startedAt: string;
	meta?: OutputMeta;
}

export interface RewindToolDetails {
	report: string;
	rewound: boolean;
	meta?: OutputMeta;
}

export class CheckpointTool implements AgentTool<typeof checkpointSchema, CheckpointToolDetails> {
	readonly name = "checkpoint";
	readonly approval = "read" as const;
	readonly label = "Checkpoint";
	readonly summary = "Create a git-based checkpoint to save and restore session state";
	readonly description: string;
	readonly parameters = checkpointSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<CheckpointParams>) => (args.goal ? `checkpointing: ${args.goal}` : "checkpointing");

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(checkpointDescription);
	}

	static createIf(session: ToolSession): CheckpointTool | null {
		return new CheckpointTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CheckpointToolDetails>> {
		if (this.session.getCheckpointState?.()) {
			throw new ToolError("Checkpoint already active.");
		}
		const startedAt = new Date().toISOString();
		return toolResult<CheckpointToolDetails>({ goal: params.goal, startedAt })
			.text([`Checkpoint: ${params.goal}`, "Finish exploration and formulate findings."].join("\n"))
			.done();
	}
}

export class RewindTool implements AgentTool<typeof rewindSchema, RewindToolDetails> {
	readonly name = "rewind";
	readonly approval = "read" as const;
	readonly label = "Rewind";
	readonly summary = "Rewind to a previously created checkpoint";
	readonly description: string;
	readonly parameters = rewindSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (): string => "rewinding";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(rewindDescription);
	}

	static createIf(session: ToolSession): RewindTool | null {
		return new RewindTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RewindParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RewindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RewindToolDetails>> {
		if (!this.session.getCheckpointState?.()) {
			if (this.session.getLastCompletedRewind?.()) {
				throw new ToolError(
					"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
				);
			}
			throw new ToolError("No active checkpoint. Create a checkpoint before calling rewind.");
		}
		const report = params.report.trim();
		if (report.length === 0) {
			throw new ToolError("Report cannot be empty.");
		}
		return toolResult<RewindToolDetails>({ report, rewound: true })
			.text(["Rewind requested.", "Report captured for context replacement."].join("\n"))
			.done();
	}
}
