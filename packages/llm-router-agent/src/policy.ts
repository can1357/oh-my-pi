import { scoreLearnedPolicy } from "./learned.js";
import type {
	CandidateScore,
	ModelCapability,
	ModelProfile,
	ObjectiveWeights,
	PolicyRule,
	RequestInput,
	RouteDecision,
	RouterConfig,
	RouterFeatureVector,
	ValidationPlan,
} from "./types.js";

export function decideRoute(input: RequestInput, features: RouterFeatureVector, config: RouterConfig): RouteDecision {
	const requestId = makeRequestId();
	const enabledModels = Object.values(config.models).filter(model => model.enabled !== false);
	if (enabledModels.length === 0) {
		throw new Error("RouterConfig must define at least one enabled model profile.");
	}

	const hardRejected = rejectIncompatibleModels(enabledModels, features, input);
	const activeCandidates = enabledModels.filter(model => !hardRejected.has(model.id));
	const candidates = activeCandidates.length > 0 ? activeCandidates : enabledModels;
	const ruleMatches = findMatchingRules(config.rules, features);
	const forcedRule = ruleMatches.find(rule => rule.route.force);
	const learnedScores = scoreLearnedPolicy(
		config.learned,
		features,
		candidates.map(model => model.id),
	);
	const learnedByModel = new Map(learnedScores.map(item => [item.modelId, item.score]));
	const candidateScores = scoreCandidates(candidates, features, config.objectives, learnedByModel, ruleMatches, input);

	for (const [modelId, rejectionReason] of hardRejected.entries()) {
		const model = enabledModels.find(item => item.id === modelId);
		if (!model) continue;
		candidateScores.push({
			modelId: model.id,
			selector: model.selector,
			score: Number.NEGATIVE_INFINITY,
			normalized: { quality: model.quality, latency: 0, cost: 0, safety: model.safety, fit: 0, learned: 0 },
			reasons: [],
			rejected: true,
			rejectionReason,
		});
	}

	let selected = chooseCandidate(candidateScores, forcedRule);
	if (!selected) {
		selected = candidateScores.filter(c => !c.rejected).sort((a, b) => b.score - a.score)[0] ?? candidateScores[0];
	}
	if (!selected) throw new Error("No candidate model could be scored.");

	const selectedProfile =
		config.models[selected.modelId] ?? enabledModels.find(model => model.id === selected?.modelId);
	if (!selectedProfile) throw new Error(`Selected profile ${selected.modelId} not found.`);

	const fallbackChain = buildFallbackChain(selectedProfile, candidateScores, config, ruleMatches);
	let fallbackSelectors = fallbackChain
		.map(id => config.models[id])
		.filter((model): model is ModelProfile => Boolean(model))
		.flatMap(model => [model.selector, ...(model.fallbackSelectors ?? [])])
		.filter(uniqueString);
	// Keep 9router as the execution router: when the primary route runs through a
	// 9router lane (e.g. the route-predictor / local-fast role), restrict the
	// emitted fallbacks to 9router lanes plus the terminal `pi/smol` safety net so
	// execution never silently escapes the 9router gateway.
	if (selectedProfile.selector.startsWith("9router/")) {
		fallbackSelectors = fallbackSelectors.filter(
			selector => selector.startsWith("9router/") || selector === "pi/smol",
		);
	}

	const sortedScores = candidateScores.sort((a, b) => {
		if (a.rejected && !b.rejected) return 1;
		if (!a.rejected && b.rejected) return -1;
		return b.score - a.score;
	});
	const confidence = estimateConfidence(sortedScores, selected.modelId, Boolean(forcedRule));
	const validationPlan = buildValidationPlan(input, features, config);
	const reasons = (selected.reasons.length > 0 ? selected.reasons : ["highest weighted objective score"]).filter(
		uniqueString,
	);

	const decision: RouteDecision = {
		requestId,
		selectedModel: selectedProfile.id,
		selector: selectedProfile.selector,
		confidence,
		objectiveWeights: config.objectives,
		taskType: features.taskType,
		features,
		fallbackChain,
		fallbackSelectors,
		validationPlan,
		reasons,
		scores: sortedScores,
		ruleMatches: ruleMatches.map(rule => rule.name),
		createdAt: new Date().toISOString(),
	};
	if (selectedProfile.provider !== undefined) decision.provider = selectedProfile.provider;
	if (selectedProfile.modelId !== undefined) decision.modelId = selectedProfile.modelId;
	return decision;
}

function rejectIncompatibleModels(
	models: ModelProfile[],
	features: RouterFeatureVector,
	input: RequestInput,
): Map<string, string> {
	const rejected = new Map<string, string>();
	for (const model of models) {
		if (features.totalTokenEstimate > model.contextWindow) {
			rejected.set(
				model.id,
				`estimated tokens ${features.totalTokenEstimate} exceed context window ${model.contextWindow}`,
			);
			continue;
		}
		if (features.hasMultimodalInput && !hasCapability(model, "vision")) {
			const hasOnlyNonVisual = (input.attachments ?? []).some(a => a.kind === "image" || a.kind === "video");
			if (hasOnlyNonVisual) {
				rejected.set(model.id, "multimodal visual input requires a vision-capable model");
				continue;
			}
		}
		if (features.hasToolNeed && input.metadata?.requiresTools === true && !hasCapability(model, "tools")) {
			rejected.set(model.id, "request requires tools but model profile lacks tools capability");
		}
	}
	return rejected;
}

function scoreCandidates(
	models: ModelProfile[],
	features: RouterFeatureVector,
	weights: ObjectiveWeights,
	learnedByModel: Map<string, number>,
	ruleMatches: PolicyRule[],
	input: RequestInput,
): CandidateScore[] {
	const maxLatency = Math.max(...models.map(model => model.latencyMsP95), 1);
	const maxCost = Math.max(...models.map(model => model.costPerMillionTokens), 0.0001);
	return models.map(model => {
		const normalizedLatency = 1 - model.latencyMsP95 / maxLatency;
		const normalizedCost = 1 - model.costPerMillionTokens / maxCost;
		const fit = taskFit(model, features, input);
		const learned = learnedByModel.get(model.id) ?? 0;
		const ruleBoost = ruleMatches.some(
			rule => rule.route.model === model.id || rule.route.fallback?.includes(model.id),
		)
			? 0.12
			: 0;
		const score =
			weights.quality * model.quality +
			weights.latency * normalizedLatency +
			weights.cost * normalizedCost +
			weights.safety * model.safety +
			0.24 * fit +
			ruleBoost +
			learned;
		const reasons = explainCandidate(model, features, input, fit, learned, ruleMatches);
		return {
			modelId: model.id,
			selector: model.selector,
			score: round(score, 6),
			normalized: {
				quality: round(model.quality, 4),
				latency: round(normalizedLatency, 4),
				cost: round(normalizedCost, 4),
				safety: round(model.safety, 4),
				fit: round(fit, 4),
				learned: round(learned, 4),
			},
			reasons,
		} satisfies CandidateScore;
	});
}

function taskFit(model: ModelProfile, features: RouterFeatureVector, input: RequestInput): number {
	let fit = 0.25;
	if (features.taskType === "coding" && hasCapability(model, "code")) fit += 0.28;
	if (features.hasJsonRequirement && hasCapability(model, "json")) fit += 0.2;
	if (features.hasToolNeed && hasCapability(model, "tools")) fit += 0.14;
	if (features.hasRetrievalNeed && hasCapability(model, "tools")) fit += 0.08;
	if (features.hasLongContextNeed && hasCapability(model, "long-context")) fit += 0.24;
	if (features.reasoningComplexity > 0.55 && hasCapability(model, "reasoning")) fit += 0.22;
	if (features.safetySensitivity > 0.35 && hasCapability(model, "safe")) fit += 0.28;
	if (features.userPreference === "speed" && hasCapability(model, "fast")) fit += 0.22;
	if (features.userPreference === "cost" && hasCapability(model, "cheap")) fit += 0.22;
	if (features.userPreference === "quality" && model.quality >= 0.85) fit += 0.18;
	if (features.userPreference === "safety" && model.safety >= 0.9) fit += 0.22;
	if (features.latencyBudgetMs !== undefined && model.latencyMsP95 <= features.latencyBudgetMs) fit += 0.1;
	if (features.costBudgetUsd !== undefined) {
		const estimatedCost = (features.totalTokenEstimate / 1_000_000) * model.costPerMillionTokens;
		if (estimatedCost <= features.costBudgetUsd) fit += 0.1;
	}
	if (features.hasMultimodalInput && hasCapability(model, "vision")) fit += 0.22;
	if (input.metadata?.critical === true && model.quality >= 0.85) fit += 0.1;
	return Math.max(0, Math.min(1, fit));
}

function findMatchingRules(rules: PolicyRule[], features: RouterFeatureVector): PolicyRule[] {
	return rules
		.filter(rule => rule.enabled !== false && matchesRule(rule, features))
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

function matchesRule(rule: PolicyRule, features: RouterFeatureVector): boolean {
	const when = rule.when;
	if (when.taskType !== undefined && !matchesOneOrMany(when.taskType, features.taskType)) return false;
	if (when.minTokens !== undefined && features.totalTokenEstimate < when.minTokens) return false;
	if (when.maxTokens !== undefined && features.totalTokenEstimate > when.maxTokens) return false;
	if (when.hasCode !== undefined && features.hasCode !== when.hasCode) return false;
	if (when.hasJsonRequirement !== undefined && features.hasJsonRequirement !== when.hasJsonRequirement) return false;
	if (when.hasRetrievalNeed !== undefined && features.hasRetrievalNeed !== when.hasRetrievalNeed) return false;
	if (when.hasMultimodalInput !== undefined && features.hasMultimodalInput !== when.hasMultimodalInput) return false;
	if (when.minReasoningComplexity !== undefined && features.reasoningComplexity < when.minReasoningComplexity)
		return false;
	if (when.maxReasoningComplexity !== undefined && features.reasoningComplexity > when.maxReasoningComplexity)
		return false;
	if (when.minSafetySensitivity !== undefined && features.safetySensitivity < when.minSafetySensitivity) return false;
	if (when.userTier !== undefined && !matchesOneOrMany(when.userTier, features.userTier)) return false;
	if (when.preference !== undefined && !matchesOneOrMany(when.preference, features.userPreference)) return false;
	if (when.tag !== undefined) {
		const wanted = Array.isArray(when.tag) ? when.tag : [when.tag];
		if (!wanted.some(tag => features.tags.includes(tag))) return false;
	}
	if (when.stepKind !== undefined) {
		if (features.stepKind === undefined || !matchesOneOrMany(when.stepKind, features.stepKind)) return false;
	}
	if (when.stepRisk !== undefined) {
		if (features.stepRisk === undefined || !matchesOneOrMany(when.stepRisk, features.stepRisk)) return false;
	}
	if (when.irreversible !== undefined && features.irreversible !== when.irreversible) return false;
	if (when.minRecentFailures !== undefined && (features.recentFailures ?? 0) < when.minRecentFailures) return false;
	if (when.lastVerifier !== undefined) {
		if (features.lastVerifier === undefined || !matchesOneOrMany(when.lastVerifier, features.lastVerifier)) return false;
	}
	if (when.minEscalationCount !== undefined && (features.escalationCount ?? 0) < when.minEscalationCount) return false;
	if (when.estimatedCacheHit !== undefined && features.estimatedCacheHit !== when.estimatedCacheHit) return false;
	return true;
}

function chooseCandidate(scores: CandidateScore[], forcedRule: PolicyRule | undefined): CandidateScore | undefined {
	const viable = scores.filter(score => !score.rejected);
	if (forcedRule) {
		const forced = viable.find(score => score.modelId === forcedRule.route.model);
		if (forced) {
			forced.reasons.unshift(forcedRule.route.reason ?? `forced by rule ${forcedRule.name}`);
			return forced;
		}
	}
	return viable.sort((a, b) => b.score - a.score)[0];
}

function buildFallbackChain(
	selected: ModelProfile,
	scores: CandidateScore[],
	config: RouterConfig,
	rules: PolicyRule[],
): string[] {
	const configured = rules.flatMap(rule => (rule.route.model === selected.id ? (rule.route.fallback ?? []) : []));
	const scoreBased = scores
		.filter(score => !score.rejected && score.modelId !== selected.id)
		.sort((a, b) => b.score - a.score)
		.map(score => score.modelId);
	return [selected.id, ...configured, ...scoreBased].filter(uniqueString).filter(id => Boolean(config.models[id]));
}

function buildValidationPlan(input: RequestInput, features: RouterFeatureVector, config: RouterConfig): ValidationPlan {
	const requirements: ValidationPlan["requirements"] = [{ type: "non_empty" }];
	if (features.hasJsonRequirement || input.expectedOutput?.format === "json") {
		requirements.push({ type: "json", schema: input.expectedOutput?.schema });
		if (input.expectedOutput?.schema?.required?.length) {
			requirements.push({ type: "required_fields", fields: input.expectedOutput.schema.required });
		}
	}
	if (features.safetySensitivity > 0.35) requirements.push({ type: "no_unsafe_content" });
	const maxAttempts = Math.max(0, config.validation?.maxRepairAttempts ?? 1);
	const onFailure: ValidationPlan["onFailure"] =
		features.safetySensitivity > 0.6 ? "escalate" : features.hasJsonRequirement ? "repair" : "retry-same";
	return { requirements, onFailure, maxAttempts };
}

function explainCandidate(
	model: ModelProfile,
	features: RouterFeatureVector,
	input: RequestInput,
	fit: number,
	learned: number,
	rules: PolicyRule[],
): string[] {
	const reasons: string[] = [];
	const matchingRules = rules.filter(rule => rule.route.model === model.id || rule.route.fallback?.includes(model.id));
	for (const rule of matchingRules) reasons.push(rule.route.reason ?? `matched rule ${rule.name}`);
	if (features.taskType === "coding" && hasCapability(model, "code")) reasons.push("code-capable");
	if (features.hasJsonRequirement && hasCapability(model, "json")) reasons.push("json-capable");
	if (features.reasoningComplexity > 0.55 && hasCapability(model, "reasoning")) reasons.push("reasoning-capable");
	if (features.hasLongContextNeed && hasCapability(model, "long-context")) reasons.push("long-context-capable");
	if (features.safetySensitivity > 0.35 && hasCapability(model, "safe")) reasons.push("safety-capable");
	if (features.userPreference === "speed" && hasCapability(model, "fast")) reasons.push("speed preference");
	if (features.userPreference === "cost" && hasCapability(model, "cheap")) reasons.push("cost preference");
	if (input.metadata?.critical === true && model.quality >= 0.85) reasons.push("critical request quality gate");
	if (fit >= 0.7) reasons.push("strong task fit");
	if (learned !== 0) reasons.push(`learned policy delta ${round(learned, 3)}`);
	return reasons.filter(uniqueString);
}

function estimateConfidence(scores: CandidateScore[], selectedModelId: string, forced: boolean): number {
	if (forced) return 0.94;
	const viable = scores.filter(score => !score.rejected).sort((a, b) => b.score - a.score);
	const selectedIndex = viable.findIndex(score => score.modelId === selectedModelId);
	if (selectedIndex < 0) return 0.25;
	const top = viable[selectedIndex]?.score ?? 0;
	const next = viable.find(score => score.modelId !== selectedModelId)?.score ?? top - 0.2;
	const gap = Math.max(0, top - next);
	return round(Math.max(0.35, Math.min(0.98, 0.52 + gap * 1.8)), 4);
}

function hasCapability(model: ModelProfile, capability: ModelCapability): boolean {
	return model.capabilities.includes(capability);
}

function matchesOneOrMany<T extends string>(expected: T | T[], actual: T): boolean {
	return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

function uniqueString(value: string, index: number, array: string[]): boolean {
	return value.length > 0 && array.indexOf(value) === index;
}

function round(value: number, places: number): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

function makeRequestId(): string {
	const rand = Math.random().toString(36).slice(2, 9);
	return `rt_${Date.now().toString(36)}_${rand}`;
}
