import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import compactDescription from "../prompts/tools/compact.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const compactSchema = type({
	"instructions?": type("string").describe("optional focus for the summary (what context to preserve)"),
});

type CompactParams = typeof compactSchema.infer;

export interface CompactToolDetails {
	/** Marks the turn's tool results so the session compacts at turn settle. */
	requested: true;
	/** Optional focus instructions forwarded to the compaction summary. */
	instructions?: string;
	meta?: OutputMeta;
}

/**
 * Compaction restructures the whole session, so it only runs for a genuine
 * top-level agent. Depth alone is not enough: a `/tan` background clone is a
 * subagent that carries `parentTaskPrefix` while leaving `taskDepth` at 0, so
 * this mirrors the SDK's `agentKind === "main"` — a session is top-level only
 * when it has no parent-task identity AND zero depth.
 *
 * An advisor tool session is a third disqualifying case the depth/prefix checks
 * alone miss: it is built by spreading the primary top-level session, so it
 * inherits `taskDepth: 0` and no `parentTaskPrefix`. But it runs its own Agent
 * (`getAgentId: () => "advisor"`) and never runs the primary session's
 * turn-settle marker consumer, so a compact tool there returns "scheduled"
 * while no compaction ever runs. Reuse the SDK's own primary/advisor
 * discriminator — the advisor session's `getAgentId` — to reject it.
 */
function isTopLevelSession(session: ToolSession): boolean {
	if (session.getAgentId?.() === "advisor") return false;
	if (session.parentTaskPrefix) return false;
	const depth = session.taskDepth;
	return depth === undefined || depth === 0;
}

/**
 * Model-callable context compaction. The tool itself only *signals* intent:
 * `execute` returns a result carrying `requested: true`, and the AgentSession's
 * `onTurnEnd` hook runs the actual `compact()` once the turn settles. That
 * deferral is the whole point — `AgentSession.compact()` aborts the current
 * agent operation first, so compacting synchronously from `execute` would abort
 * the very turn that called the tool. At turn settle the abort is a no-op
 * because the turn is already done. Mirrors the checkpoint/rewind signal-then-
 * apply split.
 */
export class CompactTool implements AgentTool<typeof compactSchema, CompactToolDetails> {
	readonly name = "compact";
	readonly approval = "read" as const;
	readonly label = "Compact Context";
	readonly summary = "Compact your own conversation context at a clean breakpoint";
	readonly description: string;
	readonly parameters = compactSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly intent = (): string => "compacting context";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(compactDescription);
	}

	static createIf(session: ToolSession): CompactTool | null {
		// Opt-in: the self-compact tool ships default-off, gated on `compact.enabled`.
		if (!session.settings.get("compact.enabled")) return null;
		// Subagents hand their result back to the parent and are discarded; there
		// is no long-lived context worth compacting, and compaction would rewrite
		// the transcript the parent collects. Top-level sessions only.
		if (!isTopLevelSession(session)) return null;
		return new CompactTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CompactParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CompactToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CompactToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Compaction is not available in subagents.");
		}
		const instructions = params.instructions?.trim() || undefined;
		return toolResult<CompactToolDetails>({ requested: true, instructions })
			.text("Compaction scheduled — it runs when this turn settles. This does not interrupt the current turn.")
			.done();
	}
}
