import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	computeCompactionBoundaries,
	computeContextBreakdown,
	type CompactionBoundaries,
	type ContextBreakdown,
	type ContextSavingsEstimate,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import { logger } from "@oh-my-pi/pi-utils";
import type { ScopeLike } from "../config/registry";
import type { AgentSession } from "./agent-session";
import { resolveSpeculationMethod } from "./compaction-methods";
import { estimateInlineSavings } from "./snapcompact-inline";
import { resolveModelCompactionSettings } from "./model-compaction-threshold";
import { resolveSpeculationLeadTokens } from "./speculation-lead";

import { cfgSkillful } from "./settings";
import { cfgSnapcompactShape, cfgSnapcompactSystemPrompt, cfgSnapcompactToolResults } from "./context-settings";

/** Resolve session policy before handing pure boundary arithmetic to the UI. */
export function getSessionCompactionBoundaries(
	settings: ScopeLike,
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	const configured = resolveModelCompactionSettings(settings, model);
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
		const renderSystemPrompt = cfgSnapcompactSystemPrompt.get(session.settings);
		const renderToolResults = cfgSnapcompactToolResults.get(session.settings);
		if (renderSystemPrompt !== "none" || renderToolResults) {
			try {
				snapcompact = estimateInlineSavings({
					options: { renderSystemPrompt, renderToolResults, shape: cfgSnapcompactShape.get(session.settings) },
					model: session.model,
					systemPrompt: session.systemPrompt ?? [],
					messages: session.messages ?? [],
				});
			} catch (err) {
				// Savings are advisory, and a malformed prompt section must not sink the
				// whole breakdown (issue #9331).
				logger.warn("snapcompact savings estimate failed", { error: err });
			}
		}
	}
	return computeContextBreakdown(session, {
		compaction: resolveModelCompactionSettings(session.settings, session.model),
		sourceRevision: session.settings.revision,
		skillful: cfgSkillful.get(session.settings),
		snapcompact,
	});
}
