import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import {
	computeCompactionBoundaries,
	computeContextBreakdown,
	type CompactionBoundaries,
	type ContextBreakdown,
	type ContextSavingsEstimate,
	type SnapcompactArchiveUsage,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { ScopeLike } from "../config/registry";
import type { AgentSession } from "./agent-session";
import { resolveSpeculationMethod } from "./compaction-methods";
import { estimateInlineSavings } from "./snapcompact-inline";
import { archiveFrameTokens } from "./snapcompact-archive-budget";
import { resolveSpeculationLeadTokens } from "./speculation-lead";

import { cfgSkillful } from "./settings";
import {
	cfgCompaction,
	cfgSnapcompactShape,
	cfgSnapcompactSystemPrompt,
	cfgSnapcompactToolResults,
} from "./context-settings";

/** Resolve session policy before handing pure boundary arithmetic to the UI. */
export function getSessionCompactionBoundaries(
	settings: ScopeLike,
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	const configured = cfgCompaction.get(settings);
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

/** Frames of the snapcompact archive in `messages`, priced by the tokenizer the compaction trigger counts with; undefined without frames. */
function snapcompactArchiveUsage(
	messages: readonly AgentMessage[],
	tokenizer: Tokenizer,
): SnapcompactArchiveUsage | undefined {
	const images: ImageContent[] = [];
	for (const message of messages) {
		if (message.role !== "compactionSummary") continue;
		for (const block of message.blocks ?? message.images ?? []) {
			if (block.type === "image") images.push(block);
		}
	}
	return images.length > 0 ? { frames: images.length, tokens: archiveFrameTokens(tokenizer, images) } : undefined;
}

/** Read host settings and optionally run the provider's inline-image planner. */
export function computeSessionContextBreakdown(
	session: AgentSession,
	options?: { snapcompactSavings?: boolean },
): ContextBreakdown {
	let snapcompactSavings: ContextSavingsEstimate | undefined;
	if (options?.snapcompactSavings) {
		const renderSystemPrompt = cfgSnapcompactSystemPrompt.get(session.settings);
		const renderToolResults = cfgSnapcompactToolResults.get(session.settings);
		if (renderSystemPrompt !== "none" || renderToolResults) {
			snapcompactSavings = estimateInlineSavings({
				options: { renderSystemPrompt, renderToolResults, shape: cfgSnapcompactShape.get(session.settings) },
				model: session.model,
				systemPrompt: session.systemPrompt ?? [],
				messages: session.messages ?? [],
			});
		}
	}
	return computeContextBreakdown(session, {
		compaction: cfgCompaction.get(session.settings),
		sourceRevision: session.settings.revision,
		skillful: cfgSkillful.get(session.settings),
		snapcompact: snapcompactSavings,
		snapcompactArchive: snapcompactArchiveUsage(session.messages ?? [], session.agent.tokenizer),
	});
}
