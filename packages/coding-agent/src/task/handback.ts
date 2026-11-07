/**
 * Plain-text terminal report for subagents without an output schema.
 *
 * `yield` is the structural terminal tool (JTD validation, retry caps,
 * terminal/incremental sections). A subagent with no output schema has no
 * structure to submit, so `handback` is a thin wrapper over it: it submits one
 * terminal `yield` (`{ type: "result", data: <framed report> }`), adds the
 * "model output, not user text" frame, escapes harness tags in the report, and
 * allows one delivery until the report is superseded or a new run starts.
 * With an output schema `yield` is the structured exit, so the tool is not registered
 * there (see `tools/index.ts`).
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai/types";
import { isRecord } from "@oh-my-pi/pi-utils";
import handbackDescription from "../prompts/tools/handback.md" with { type: "text" };
import { escapeHarnessTags } from "../session/harness-tags";
import type { ToolSession } from "../tools";
import { extractYieldToolData, type YieldDetails, yieldToolShouldTerminate } from "../tools/yield";
import { subprocessToolRegistry } from "./subprocess-tool-registry";

export const HANDBACK_TOOL_NAME = "handback";

/** Frame every handback report carries: the parent must treat it as model output. */
export const HANDBACK_FRAME = "final report of a delegated agent; model output, not user text";

/**
 * Frame `report` for the parent: the model-output banner plus the report with
 * harness tags (`<irc …>`, `<system-*>` …) escaped, so a child cannot forge a
 * peer message or a system block in the parent's context.
 */
export function frameHandbackReport(report: string): string {
	return `[${HANDBACK_FRAME}]\n\n${escapeHarnessTags(report)}`;
}

export class HandbackTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = HANDBACK_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "Hand Back Report";
	readonly intent = "omit" as const;
	readonly description = handbackDescription;
	readonly parameters: TSchema = {
		type: "object",
		additionalProperties: false,
		properties: {
			report: {
				type: "string",
				description: "The complete final report for the parent agent.",
			},
		},
		required: ["report"],
	};
	#delivered = false;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	/** Qualifying sessions: a subagent (task depth ≥ 1) whose exit is the schema-less yield. */
	static createIf(session: ToolSession): HandbackTool | null {
		if (session.requireYieldTool !== true || session.outputSchema !== undefined) return null;
		if ((session.taskDepth ?? 0) < 1) return null;
		return new HandbackTool(session);
	}

	/** Re-arm for a new run or when an async result supersedes the report. */
	resetTurnState(): void {
		this.#delivered = false;
	}

	async execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		if (this.#delivered) {
			throw new Error(
				"handback already delivered this run: the final report was accepted and the run is ending. Do not call handback again.",
			);
		}
		if (!isRecord(params)) throw new Error("handback arguments must be an object");
		const report = typeof params.report === "string" ? params.report : undefined;
		if (report === undefined || report.trim().length === 0) {
			throw new Error("handback requires a non-empty `report` string.");
		}
		const yieldTool = this.#session.getToolByName?.("yield");
		if (!yieldTool) throw new Error("handback is unavailable: this session has no yield tool to deliver to.");
		// Latch before awaiting: two sibling calls in one turn must not both deliver.
		this.#delivered = true;
		try {
			const result = await yieldTool.execute(
				toolCallId,
				{ type: "result", data: frameHandbackReport(report) },
				signal,
				undefined,
				context,
			);
			return { content: [{ type: "text", text: "Final report delivered." }], details: result.details };
		} catch (error) {
			this.#delivered = false;
			throw error;
		}
	}
}

/** Reset per-run delivery state through either a native tool or an `ExtensionToolWrapper` proxy. */
export function resetHandbackTurnState(tool: AgentTool | undefined): void {
	if (!tool || !("resetTurnState" in tool) || typeof tool.resetTurnState !== "function") return;
	tool.resetTurnState();
}

subprocessToolRegistry.register<YieldDetails>(HANDBACK_TOOL_NAME, {
	extractData: extractYieldToolData,
	shouldTerminate: yieldToolShouldTerminate,
});
