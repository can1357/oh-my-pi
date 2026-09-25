import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	computeCompactionBoundaries,
	computeContextBreakdown,
	type CompactionBoundaries,
	type ContextBreakdown,
	type ContextSavingsEstimate,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { Settings } from "../config/settings";
import type { AgentSession } from "./agent-session";
import { resolveSpeculationMethod } from "./compaction-methods";
import { estimateInlineSavings } from "./snapcompact-inline";
import { resolveSpeculationLeadTokens } from "./speculation-lead";

/** Resolve session policy before handing pure boundary arithmetic to the UI. */
export function getSessionCompactionBoundaries(
	settings: Pick<Settings, "getGroup">,
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	const configured = settings.getGroup("compaction");
	const compaction: CompactionSettings = configured;
	if (!compaction.enabled || compaction.strategy === "off") return null;
	const threshold = resolveThresholdTokens(contextWindow, compaction);
	if (!(threshold > 0) || threshold > contextWindow) return null;
	const speculates = configured.asyncEnabled !== false && resolveSpeculationMethod(model, configured) !== undefined;
	return computeCompactionBoundaries(
		compaction,
		contextWindow,
		speculates ? resolveSpeculationLeadTokens(threshold) : undefined,
	);
}

/** Read host settings and optionally run the provider's inline-image planner. */
export function computeSessionContextBreakdown(
	session: AgentSession,
	options?: { snapcompactSavings?: boolean },
): ContextBreakdown {
	let snapcompact: ContextSavingsEstimate | undefined;
	if (options?.snapcompactSavings) {
		const renderSystemPrompt = session.settings.get("snapcompact.systemPrompt");
		const renderToolResults = session.settings.get("snapcompact.toolResults");
		if (renderSystemPrompt !== "none" || renderToolResults) {
			snapcompact = estimateInlineSavings({
				options: { renderSystemPrompt, renderToolResults, shape: session.settings.get("snapcompact.shape") },
				model: session.model,
				systemPrompt: session.systemPrompt ?? [],
				messages: session.messages ?? [],
			});
		}
	}
	return computeContextBreakdown(session, {
		compaction: session.settings.getGroup("compaction"),
		sourceRevision: session.settings.revision,
		skillful: session.settings.get("skillful"),
		snapcompact,
	});
}
