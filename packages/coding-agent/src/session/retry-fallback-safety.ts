import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Effort, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { modelSupportsEffortCeiling } from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { formatRetryFallbackSelector, type RetryFallbackSelector } from "./retry-fallback-chains";

const IMMUTABLE_ANTHROPIC_THINKING_ERROR_PATTERN =
	/messages\.\d+\.content\.\d+.*\b(?:thinking|redacted_thinking)\b.*\blatest assistant message cannot be modified\b/is;
const USAGE_PREFLIGHT_BLOCKED_PREFIX = "Usage preflight blocked:";

export interface RetryFallbackSafetyHost {
	settings: Settings;
	modelRegistry: ModelRegistry;
	model(): Model | undefined;
	thinkingLevel(): ThinkingLevel | undefined;
	thinkingLevelCeiling(): Effort | undefined;
	sessionId(): string;
	textOutputCommitted(): boolean;
	contextFitsModel(model: Model, excludedMessage?: AssistantMessage): boolean;
	retryFallbackChainKeys(currentSelector: string): readonly string[];
	findRetryFallbackCandidates(
		role: string,
		currentSelector: string,
		options?: { wrapAround?: boolean },
	): readonly RetryFallbackSelector[];
	isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean;
	latestAssistantMessage(excluding?: AssistantMessage): AssistantMessage | undefined;
	/** Additional owner-specific native replay compatibility. False skips this candidate, not the chain. */
	isNativeReplayCompatible?(candidate: Model, latestAssistant: AssistantMessage | undefined): boolean;
	/** Captured owner generation/model must still own the recovery attempt. */
	isCurrent(): boolean;
}

export interface SafeRetryFallbackCandidate {
	role: string;
	selector: RetryFallbackSelector;
	model: Model;
	apiKey: string;
}

export interface SafeRetryFallbackCandidateOptions {
	excludeProvider?: string;
	preserveFailedTurn?: boolean;
	wrapAround?: boolean;
	signal?: AbortSignal;
}

/** Output that makes replaying the failed request unsafe. Thinking-only output remains replay-safe. */
export function hasReplayUnsafeOutput(message: AssistantMessage, textOutputCommitted: boolean): boolean {
	return message.content.some(
		block =>
			block.type === "toolCall" ||
			block.type === "image" ||
			block.type === "anthropicServerTool" ||
			(block.type === "text" && textOutputCommitted && block.text.trim().length > 0),
	);
}

/** Classify against the active model API, matching retry recovery when test/provider metadata is generic. */
export function classifyRetryFallbackMessage(message: AssistantMessage, activeModel: Model | undefined): number {
	if (!activeModel || message.api === activeModel.api) return AIError.classifyMessage(message);
	const id = AIError.classifyMessage({
		api: activeModel.api,
		errorId: message.errorId,
		errorMessage: message.errorMessage,
		errorStatus: message.errorStatus,
	});
	message.errorId = id;
	return id;
}

/** Exact pre-context-recovery opportunity for configured fallback chains. */
export function isHardErrorFallbackEligible(host: RetryFallbackSafetyHost, message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	if (message.errorMessage?.startsWith(USAGE_PREFLIGHT_BLOCKED_PREFIX) === true) return false;
	const model = host.model();
	if (!model) return false;
	const immutableAnthropicThinkingError =
		model.api === "anthropic-messages" &&
		(message.errorStatus === 400 || message.errorId === 400 || message.errorMessage?.startsWith("400 ") === true) &&
		IMMUTABLE_ANTHROPIC_THINKING_ERROR_PATTERN.test(message.errorMessage ?? "");
	if (immutableAnthropicThinkingError) return false;
	const retrySettings = host.settings.getGroup("retry");
	if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
	const stopType = message.stopDetails?.type;
	if (stopType === "refusal" || stopType === "sensitive") return false;
	const id = classifyRetryFallbackMessage(message, model);
	if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
	const contextWindow = model.contextWindow ?? 0;
	const textAmbiguousOverflow = AIError.isTextAmbiguousContextOverflow(id, message, contextWindow);
	if (!textAmbiguousOverflow && AIError.isContextOverflow(message, contextWindow)) return false;
	if (hasReplayUnsafeOutput(message, host.textOutputCommitted())) return false;
	const currentSelector = formatRetryFallbackSelector(model, host.thinkingLevel());
	return host
		.retryFallbackChainKeys(currentSelector)
		.some(role => host.findRetryFallbackCandidates(role, currentSelector).length > 0);
}

/** Signed Anthropic thinking is byte/model-bound within the same provider. */
export function isRetryFallbackCandidateReplayCompatible(
	candidate: Model,
	latestAssistant: AssistantMessage | undefined,
): boolean {
	return !(
		candidate.api === "anthropic-messages" &&
		latestAssistant?.api === "anthropic-messages" &&
		latestAssistant.provider === candidate.provider &&
		latestAssistant.model !== candidate.id &&
		latestAssistant.content.some(
			block =>
				(block.type === "thinking" && Boolean(block.thinkingSignature?.trim())) || block.type === "redactedThinking",
		)
	);
}

/** Walk configured candidates while preserving every replay, effort, fit, auth, and ownership veto. */
export async function findSafeRetryFallbackCandidate(
	host: RetryFallbackSafetyHost,
	currentSelector: string,
	failedMessage: AssistantMessage,
	options: SafeRetryFallbackCandidateOptions = {},
): Promise<SafeRetryFallbackCandidate | undefined> {
	const ceiling = host.thinkingLevelCeiling();
	const latestAssistant = options.preserveFailedTurn
		? failedMessage
		: host.latestAssistantMessage(failedMessage);
	for (const role of host.retryFallbackChainKeys(currentSelector)) {
		for (const selector of host.findRetryFallbackCandidates(role, currentSelector, options)) {
			if (options.signal?.aborted || !host.isCurrent()) return undefined;
			if (host.isRetryFallbackSelectorSuppressed(selector)) continue;
			const resolved = resolveModelOverride([selector.raw], host.modelRegistry, host.settings);
			const candidate = resolved.model ?? host.modelRegistry.find(selector.provider, selector.id);
			if (!candidate || options.excludeProvider === candidate.provider) continue;
			if (!isRetryFallbackCandidateReplayCompatible(candidate, latestAssistant)) continue;
			if (host.isNativeReplayCompatible?.(candidate, latestAssistant) === false) continue;
			if (ceiling !== undefined && !modelSupportsEffortCeiling(candidate, ceiling)) continue;
			if (!host.contextFitsModel(candidate, options.preserveFailedTurn ? undefined : failedMessage)) continue;
			let apiKey: string | undefined;
			try {
				apiKey = await host.modelRegistry.getApiKey(candidate, host.sessionId(), { signal: options.signal });
			} catch (error) {
				if (options.signal?.aborted || !host.isCurrent()) return undefined;
				throw error;
			}
			if (options.signal?.aborted || !host.isCurrent()) return undefined;
			if (!apiKey) continue;
			return { role, selector, model: candidate, apiKey };
		}
	}
	return undefined;
}
