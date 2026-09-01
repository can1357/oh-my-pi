import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { CapturedHttpErrorResponse } from "../utils/http-inspector";

/**
 * Fallback marker: the server rejected the `chat_template_kwargs.reasoning_effort`
 * spelling itself (strict kwargs whitelists — Ninfer-style servers), not the
 * effort value. Apply strips the kwarg and hoists the value onto the top-level
 * `reasoning_effort` field when that spelling is absent.
 * @internal
 */
export const STRIP_TEMPLATE_KWARG_REASONING_EFFORT = Symbol("strip-template-kwarg-reasoning-effort");

/** @internal */
export type OpenAIReasoningEffortFallback = string | null | typeof STRIP_TEMPLATE_KWARG_REASONING_EFFORT;

/** @internal */
export interface OpenAIReasoningEffortFallbackState {
	reasoningEffortFallbacks: Map<string, OpenAIReasoningEffortFallback>;
}

const ENABLED_REASONING_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const KNOWN_REASONING_VALUE: Readonly<Record<string, true>> = {
	none: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};
const REASONING_VALUE_RANK: Readonly<Record<string, number>> = {
	minimal: 0,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	max: 5,
};

/** @internal */
export function createOpenAIReasoningEffortFallbackState(): OpenAIReasoningEffortFallbackState {
	return { reasoningEffortFallbacks: new Map() };
}

/** @internal */
export function clearOpenAIReasoningEffortFallbackState(state: OpenAIReasoningEffortFallbackState): void {
	state.reasoningEffortFallbacks.clear();
}

/** @internal */
export function getOpenAIReasoningEffortFallback(
	state: OpenAIReasoningEffortFallbackState | undefined,
	key: string,
): OpenAIReasoningEffortFallback | undefined {
	return state?.reasoningEffortFallbacks.get(key);
}

/** @internal */
export function rememberOpenAIReasoningEffortFallback(
	state: OpenAIReasoningEffortFallbackState | undefined,
	key: string,
	fallback: OpenAIReasoningEffortFallback,
): void {
	state?.reasoningEffortFallbacks.set(key, fallback);
}

/** @internal */
export function createOpenAIReasoningEffortFallbackKey(
	endpoint: "chat-completions" | "responses" | "azure-responses",
	baseUrl: string | undefined,
	wireModelId: string | undefined,
): string {
	return `${endpoint}:${baseUrl ?? ""}:${wireModelId ?? ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal */
export function readOpenAIReasoningEffort(params: unknown): string | undefined {
	if (!isRecord(params)) return undefined;
	if (typeof params.reasoning_effort === "string") return params.reasoning_effort;
	const reasoning = params.reasoning;
	if (isRecord(reasoning) && typeof reasoning.effort === "string") return reasoning.effort;
	return readTemplateKwargReasoningEffort(params);
}

function readTemplateKwargReasoningEffort(params: Record<string, unknown>): string | undefined {
	const kwargs = params.chat_template_kwargs;
	return isRecord(kwargs) && typeof kwargs.reasoning_effort === "string" ? kwargs.reasoning_effort : undefined;
}

/** Remove `chat_template_kwargs.reasoning_effort`, dropping the kwargs object when it becomes empty. */
function deleteTemplateKwargReasoningEffort(kwargs: Record<string, unknown>, parent: Record<string, unknown>): void {
	delete kwargs.reasoning_effort;
	for (const key in kwargs) {
		void key;
		return;
	}
	delete parent.chat_template_kwargs;
}

function deleteReasoningEffort(reasoning: Record<string, unknown>, parent: Record<string, unknown>): boolean {
	if (typeof reasoning.effort !== "string") return false;
	delete reasoning.effort;
	for (const key in reasoning) {
		if (key !== "effort") return true;
	}
	delete parent.reasoning;
	return true;
}

/** @internal */
export function applyOpenAIReasoningEffortFallback(params: unknown, fallback: OpenAIReasoningEffortFallback): boolean {
	if (!isRecord(params)) return false;
	if (fallback === STRIP_TEMPLATE_KWARG_REASONING_EFFORT) {
		const kwargs = params.chat_template_kwargs;
		if (!isRecord(kwargs) || typeof kwargs.reasoning_effort !== "string") return false;
		const effort = kwargs.reasoning_effort;
		deleteTemplateKwargReasoningEffort(kwargs, params);
		// The `qwen-chat-template` dialect rides kwargs alone; keep the effort
		// selection alive on the standard OpenAI field (Ninfer-style servers
		// accept it, vLLM-style renderers ignore it).
		if (typeof params.reasoning_effort !== "string") params.reasoning_effort = effort;
		return true;
	}
	let changed = false;
	if (typeof params.reasoning_effort === "string") {
		if (fallback === null) {
			delete params.reasoning_effort;
		} else {
			params.reasoning_effort = fallback;
		}
		changed = true;
	}
	const reasoning = params.reasoning;
	if (isRecord(reasoning) && typeof reasoning.effort === "string") {
		if (fallback === null) {
			changed = deleteReasoningEffort(reasoning, params) || changed;
		} else {
			reasoning.effort = fallback;
			changed = true;
		}
	}
	// Keep the Qwen template kwarg twin in lockstep — a value remap or drop
	// must not leave a stale effort for kwargs-reading renderers.
	const kwargs = params.chat_template_kwargs;
	if (isRecord(kwargs) && typeof kwargs.reasoning_effort === "string") {
		if (fallback === null) {
			deleteTemplateKwargReasoningEffort(kwargs, params);
		} else {
			kwargs.reasoning_effort = fallback;
		}
		changed = true;
	}
	return changed;
}

function capturedStringField(
	captured: CapturedHttpErrorResponse | undefined,
	field: "code" | "message" | "param" | "type",
) {
	const body = isRecord(captured?.bodyJson) ? captured.bodyJson : undefined;
	const error = isRecord(body?.error) ? body.error : undefined;
	if (typeof error?.[field] === "string") return error[field];
	return typeof body?.[field] === "string" ? body[field] : undefined;
}

function collectMessageParts(error: unknown, captured: CapturedHttpErrorResponse | undefined): string {
	const parts = [
		error instanceof Error ? error.message : undefined,
		capturedStringField(captured, "message"),
		capturedStringField(captured, "param"),
		capturedStringField(captured, "code"),
		capturedStringField(captured, "type"),
		captured?.bodyText,
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	return parts.join("\n");
}

/**
 * Text that identifies a 400 as being about the reasoning-effort field.
 * OpenAI-compatible gateways (cliproxy, …) never name the field — they reject
 * the value alone with `level "none" not supported, valid levels: low, …` — so
 * the allowed-level phrasing counts as a mention too.
 */
const REASONING_EFFORT_FIELD_PATTERN = /reasoning[_. ]effort|reasoning value|(?:valid|supported|allowed) levels?/i;

function mentionsReasoningEffort(error: unknown, captured: CapturedHttpErrorResponse | undefined): boolean {
	const param = capturedStringField(captured, "param");
	const code = capturedStringField(captured, "code");
	const type = capturedStringField(captured, "type");
	const message = collectMessageParts(error, captured);
	return (
		REASONING_EFFORT_FIELD_PATTERN.test(param ?? "") ||
		REASONING_EFFORT_FIELD_PATTERN.test(code ?? "") ||
		REASONING_EFFORT_FIELD_PATTERN.test(type ?? "") ||
		REASONING_EFFORT_FIELD_PATTERN.test(message)
	);
}

function isInvalidReasoningEffortError(
	error: unknown,
	captured: CapturedHttpErrorResponse | undefined,
	currentEffort: string,
): boolean {
	const status = extractHttpStatusFromError(error) ?? captured?.status;
	if (status !== 400 && status !== 422) return false;
	if (!mentionsReasoningEffort(error, captured)) return false;
	const message = collectMessageParts(error, captured);
	if (/reasoning[_ ]content/i.test(message) && !REASONING_EFFORT_FIELD_PATTERN.test(message)) return false;
	if (/invalid[^\n]*(?:reasoning[_. ]effort|reasoning value)/i.test(message)) return true;
	if (
		/(?:reasoning[_. ]effort|reasoning value)[^\n]*(?:invalid|unsupported|not supported|not permitted|must be|expected|unknown|unexpected|unrecognized)/i.test(
			message,
		)
	) {
		return true;
	}
	if (
		/(?:unsupported|not supported|not permitted|unknown|unexpected|unrecognized|extra)[^\n]*(?:reasoning[_. ]effort|reasoning value)/i.test(
			message,
		)
	) {
		return true;
	}
	// Gateways put the rejected value first (`level "none" not supported`), the
	// official API puts the verdict first (`Unsupported value: 'none'`).
	const quoted = `["'\`]${escapeRegExp(currentEffort)}["'\`]`;
	return (
		new RegExp(`(?:invalid|unsupported|not supported)[^\\n]*${quoted}`, "i").test(message) ||
		new RegExp(`${quoted}[^\\n]*(?:invalid|unsupported|not supported)`, "i").test(message)
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseKnownReasoningValues(text: string): Set<string> {
	const values = new Set<string>();
	const quotedPattern = /["'`](none|minimal|low|medium|high|xhigh|max)["'`]/gi;
	let quotedMatch = quotedPattern.exec(text);
	while (quotedMatch !== null) {
		values.add(quotedMatch[1]!.toLowerCase());
		quotedMatch = quotedPattern.exec(text);
	}
	const allowedMatch =
		/(?:must be|one of|allowed values?|supported values?(?: are)?|expected|(?:valid|supported|allowed) levels?(?: are)?)[^.\n]+/i.exec(
			text,
		);
	if (allowedMatch) {
		const allowedText = allowedMatch[0]!;
		const barePattern = /\b(none|minimal|low|medium|high|xhigh|max)\b/gi;
		let bareMatch = barePattern.exec(allowedText);
		while (bareMatch !== null) {
			values.add(bareMatch[1]!.toLowerCase());
			bareMatch = barePattern.exec(allowedText);
		}
	}
	return values;
}

function parseAllowedReasoningValues(message: string, currentEffort: string): Set<string> | undefined {
	const values = parseKnownReasoningValues(message);
	const hasAllowedCue =
		/must be|one of|allowed values?|supported values?|expected|(?:valid|supported|allowed) levels?/i.test(message);
	values.delete(currentEffort.toLowerCase());
	if (!hasAllowedCue && values.size === 0) return undefined;
	return values;
}

function orderedEnabledAllowedValues(allowed: Set<string>): string[] {
	return ENABLED_REASONING_VALUES.filter(value => allowed.has(value));
}

function lowestEnabledAllowedValue(allowed: Set<string>): string | undefined {
	for (const value of ENABLED_REASONING_VALUES) {
		if (allowed.has(value)) return value;
	}
	return undefined;
}

function nearestEnabledReasoningFallback(currentEffort: string, allowed: Set<string>): string | undefined {
	const current = currentEffort.toLowerCase();
	const allowedEnabled = orderedEnabledAllowedValues(allowed);
	if (allowedEnabled.length === 0) return undefined;
	if (current === "minimal" && allowedEnabled.includes("low")) return "low";
	if (current === "xhigh" && allowedEnabled.includes("max")) return "max";
	if (current === "xhigh" && allowedEnabled.includes("high")) return "high";
	if (current === "max" && allowedEnabled.includes("xhigh")) return "xhigh";
	const currentRank = REASONING_VALUE_RANK[current];
	if (currentRank === undefined) return undefined;
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	let bestRank = Number.NEGATIVE_INFINITY;
	for (const candidate of allowedEnabled) {
		if (candidate === current) continue;
		const candidateRank = REASONING_VALUE_RANK[candidate];
		if (candidateRank === undefined) continue;
		const distance = Math.abs(candidateRank - currentRank);
		if (distance < bestDistance || (distance === bestDistance && candidateRank > bestRank)) {
			best = candidate;
			bestDistance = distance;
			bestRank = candidateRank;
		}
	}
	return best;
}

/**
 * Text that identifies a rejection of the kwargs spelling itself: the server
 * names `chat_template_kwargs` together with `reasoning_effort` (Ninfer-style
 * strict kwargs whitelists: `chat_template_kwargs.reasoning_effort is not
 * supported`).
 */
const TEMPLATE_KWARG_EFFORT_PATTERN =
	/chat_template_kwargs[^\n]{0,120}reasoning[_. ]effort|reasoning[_. ]effort[^\n]{0,120}chat_template_kwargs/i;
const FIELD_REJECTION_PATTERN =
	/invalid|unsupported|not supported|not permitted|unknown|unexpected|unrecognized|rejected|extra input/i;

function resolveStripTemplateKwargFallback(
	error: unknown,
	captured: CapturedHttpErrorResponse | undefined,
	params: unknown,
): typeof STRIP_TEMPLATE_KWARG_REASONING_EFFORT | undefined {
	if (!isRecord(params)) return undefined;
	const effort = readTemplateKwargReasoningEffort(params);
	if (effort === undefined) return undefined;
	const status = extractHttpStatusFromError(error) ?? captured?.status;
	if (status !== 400 && status !== 422) return undefined;
	const message = collectMessageParts(error, captured);
	if (!TEMPLATE_KWARG_EFFORT_PATTERN.test(message) || !FIELD_REJECTION_PATTERN.test(message)) return undefined;
	// A value-level rejection listing allowed levels wants the value remapped
	// (in every spelling) by the ordinary flow, not the kwarg stripped.
	if (parseAllowedReasoningValues(message, effort) !== undefined) return undefined;
	return STRIP_TEMPLATE_KWARG_REASONING_EFFORT;
}

/** @internal */
export function resolveOpenAIReasoningEffortFallback(
	error: unknown,
	captured: CapturedHttpErrorResponse | undefined,
	params: unknown,
	options?: { explicitDisable?: boolean },
): OpenAIReasoningEffortFallback | undefined {
	const strip = resolveStripTemplateKwargFallback(error, captured, params);
	if (strip !== undefined) return strip;
	const currentEffort = readOpenAIReasoningEffort(params);
	if (!currentEffort || !KNOWN_REASONING_VALUE[currentEffort.toLowerCase()]) return undefined;
	if (!isInvalidReasoningEffortError(error, captured, currentEffort)) return undefined;
	const message = collectMessageParts(error, captured);
	const allowed = parseAllowedReasoningValues(message, currentEffort);
	const normalizedCurrent = currentEffort.toLowerCase();
	if (allowed === undefined) return null;
	if (options?.explicitDisable) {
		if (normalizedCurrent !== "none" && allowed.has("none")) return "none";
		const fallback = lowestEnabledAllowedValue(allowed);
		return fallback && fallback !== normalizedCurrent ? fallback : null;
	}
	if (normalizedCurrent === "none") return null;
	return nearestEnabledReasoningFallback(normalizedCurrent, allowed) ?? null;
}
