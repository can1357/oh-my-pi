/**
 * Session-facing TypeSafe skill suggestion.
 *
 * Uses {@link TypeSafeJudge} directly — never {@link resolveJudge}, which
 * falls back to tiny/smol on failure. A late or LLM-generated inject is worse
 * than none (pi-fabric: no auto-retry). Fail-open: missing key, timeout,
 * HTTP error, or a gate miss skip the inject and the turn continues.
 */
import { TYPESAFE_PROVIDER, TypeSafeJudge } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import { shouldRunSkillSuggestion } from "./policy";
import { type SkillSuggestion, skillRelevanceBlock, suggestSkill } from "./suggest";

export const SKILL_SUGGESTION_TIMEOUT_MS = 2500;
export { shouldRunSkillSuggestion, type SkillSuggestionMode } from "./policy";

export interface AppliedSkillSuggestion {
	block: string;
	suggestion: SkillSuggestion;
	elapsedMs: number;
}

export { systemPromptAlreadyHasSkillRelevance } from "./suggest";

export async function applySkillSuggestion(input: {
	prompt: string;
	skills: readonly Skill[];
	settings: Settings;
	registry: ModelRegistry;
	sessionId?: string;
	signal?: AbortSignal;
}): Promise<AppliedSkillSuggestion | null> {
	if (!shouldRunSkillSuggestion(input.settings, input.registry)) return null;

	const timeout = AbortSignal.timeout(SKILL_SUGGESTION_TIMEOUT_MS);
	const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
	const started = Date.now();
	try {
		const judge = new TypeSafeJudge({
			apiKey: input.registry.authStorage.resolver(TYPESAFE_PROVIDER, { sessionId: input.sessionId }),
			timeoutMs: SKILL_SUGGESTION_TIMEOUT_MS,
		});
		const suggestion = await suggestSkill({
			prompt: input.prompt,
			skills: input.skills,
			judge,
			signal,
		});
		if (!suggestion) return null;
		const elapsedMs = Date.now() - started;
		logger.debug("skills.suggestion", {
			name: suggestion.name,
			gate: suggestion.gate,
			probability: suggestion.probability,
			elapsedMs,
			model: suggestion.model,
		});
		return { block: skillRelevanceBlock(suggestion.name), suggestion, elapsedMs };
	} catch (error) {
		if (signal.aborted) {
			logger.debug("skills.suggestion: aborted or timed out; skipping inject");
			return null;
		}
		logger.debug("skills.suggestion: TypeSafe failed; skipping inject", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
