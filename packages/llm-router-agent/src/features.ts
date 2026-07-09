import { readStepContextMetadata } from "./step-context.js";
import type { Preference, RequestInput, RouterFeatureVector, StepContextMetadata, TaskType } from "./types.js";

const TASK_TYPES: TaskType[] = [
	"chat",
	"classification",
	"coding",
	"translation",
	"summarization",
	"extraction",
	"reasoning",
	"retrieval",
	"planning",
	"multimodal",
	"safety",
	"unknown",
];


const URL_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|ai|dev|gov|edu)\b/i;
const CODE_FENCE_RE = /```|~~~|<code>|<\/code>/i;
const JSON_HINT_RE = /\b(json|schema|structured output|valid object|strict format|parseable|pydantic|zod)\b/i;
const STRUCTURED_DATA_RE = /\{[\s\S]*?:[\s\S]*?\}|\[[\s\S]*?\]|\b(csv|yaml|xml|sql|table|spreadsheet)\b/i;
const TOOL_HINT_RE =
	/\b(search|browse|web|open file|read file|write file|run|execute|terminal|shell|database|api|call tool|fetch)\b/i;
const RETRIEVAL_HINT_RE =
	/\b(cite|citation|source|latest|current|today|news|find|look up|research|verify|url|link|document|pdf)\b/i;
const TRANSLATION_RE = /\b(translate|translation|localize|transcreation|traducir|traduire|übersetzen|翻译|翻譯)\b/i;
const SUMMARIZE_RE = /\b(summarize|summary|tl;dr|brief|condense|recap|abstract|key points|takeaways)\b/i;
const CLASSIFY_RE = /\b(classify|classification|categorize|label|sentiment|intent|topic|tag this)\b/i;
const EXTRACTION_RE = /\b(extract|parse|pull out|fields|entities|invoice|receipt|normalize|convert to json|csv)\b/i;
const CODING_RE =
	/\b(code|coding|program|debug|bug|stack trace|typescript|javascript|python|rust|go|java|sql|regex|function|class|unit test|compile|refactor|patch|diff|github|repo)\b/i;
const PLANNING_RE =
	/\b(plan|roadmap|strategy|architecture|design|proposal|milestone|implementation|project plan|workflow)\b/i;
const REASONING_RE =
	/\b(reason|prove|derive|analyze|solve|optimize|trade[- ]?off|diagnose|root cause|evaluate|compare|multi[- ]?step)\b/i;
const AMBIGUITY_RE =
	/\b(maybe|not sure|unclear|roughly|approximately|guess|could be|might|ambiguous|help me decide)\b/i;
const SAFETY_RE =
	/\b(medical|doctor|diagnosis|legal|lawyer|lawsuit|contract risk|financial advice|investment|tax|password|secret|credential|token|exploit|malware|phishing|weapon|self-harm|suicide|harmful|illegal|bypass|jailbreak|pii|ssn|social security|credit card)\b/i;

export function estimateTokens(text: string): number {
	if (!text) return 0;
	const cjkChars = (text.match(/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) ?? []).length;
	const asciiChars = Math.max(0, text.length - cjkChars);
	return Math.max(1, Math.ceil(asciiChars / 4 + cjkChars * 0.8));
}

export function extractFeatures(input: RequestInput): RouterFeatureVector {
	const message = input.message ?? "";
	const combined = [input.system, message, ...(input.tags ?? [])].filter(Boolean).join("\n");
	const lower = combined.toLowerCase();
	const approxInputTokens = estimateTokens(combined) + estimateAttachmentTokens(input);
	const approxOutputTokens = estimateOutputTokens(input, approxInputTokens);
	const hasCode = CODE_FENCE_RE.test(combined) || CODING_RE.test(combined) || looksLikeCode(combined);
	const hasUrl = URL_RE.test(combined);
	const hasJsonRequirement =
		JSON_HINT_RE.test(combined) || input.expectedOutput?.format === "json" || Boolean(input.expectedOutput?.schema);
	const hasStructuredData = STRUCTURED_DATA_RE.test(combined) || hasJsonRequirement;
	const hasRetrievalNeed = RETRIEVAL_HINT_RE.test(combined) || hasUrl;
	const hasToolNeed = TOOL_HINT_RE.test(combined) || hasRetrievalNeed;
	const hasMultimodalInput = Boolean(
		input.attachments?.some(a => ["image", "audio", "video", "pdf", "slides", "spreadsheet"].includes(a.kind ?? "")),
	);
	const hasLongContextNeed = approxInputTokens > 48_000 || (input.attachments?.length ?? 0) >= 8;
	const reasoningComplexity = clamp01(
		0.12 +
			(hasCode ? 0.15 : 0) +
			(REASONING_RE.test(combined) ? 0.22 : 0) +
			(PLANNING_RE.test(combined) ? 0.18 : 0) +
			(hasLongContextNeed ? 0.25 : 0) +
			Math.min(0.28, approxInputTokens / 160_000) +
			countMatches(lower, [
				"step",
				"constraints",
				"tradeoff",
				"edge case",
				"evaluate",
				"prove",
				"debug",
				"architecture",
			]) *
				0.035,
	);
	const ambiguity = clamp01(
		(AMBIGUITY_RE.test(combined) ? 0.2 : 0) +
			(message.trim().endsWith("?") && message.length < 80 ? 0.15 : 0) +
			(countQuestionMarks(message) > 2 ? 0.2 : 0) +
			(lower.includes("or") ? 0.06 : 0),
	);
	const safetySensitivity = clamp01(
		(SAFETY_RE.test(combined) ? 0.45 : 0) +
			(lower.includes("personal data") || lower.includes("private") ? 0.18 : 0) +
			(lower.includes("production") || lower.includes("customer") ? 0.08 : 0) +
			((input.tags ?? []).some(t => /safety|legal|medical|finance|security/i.test(t)) ? 0.28 : 0),
	);
	const taskScores = scoreTasks(combined, {
		hasCode,
		hasUrl,
		hasJsonRequirement,
		hasRetrievalNeed,
		hasMultimodalInput,
		safetySensitivity,
		reasoningComplexity,
	});
	const taskType = selectTaskType(taskScores);
	const runtimePressure = estimateRuntimePressure(input.runtime);
	const stepContext = readStepContextMetadata(input.metadata);
	const signals = collectSignals({
		taskType,
		approxInputTokens,
		hasCode,
		hasUrl,
		hasJsonRequirement,
		hasToolNeed,
		hasRetrievalNeed,
		hasMultimodalInput,
		hasLongContextNeed,
		reasoningComplexity,
		ambiguity,
		safetySensitivity,
		runtimePressure,
		stepContext,
	});

	const result: RouterFeatureVector = {
		taskType,
		taskScores,
		approxInputTokens,
		approxOutputTokens,
		totalTokenEstimate: approxInputTokens + approxOutputTokens,
		language: detectLanguage(combined),
		hasCode,
		hasUrl,
		hasJsonRequirement,
		hasStructuredData,
		hasToolNeed,
		hasRetrievalNeed,
		hasMultimodalInput,
		hasLongContextNeed,
		reasoningComplexity,
		ambiguity,
		safetySensitivity,
		userTier: input.user?.tier ?? "unknown",
		userPreference: input.user?.preference ?? "balanced",
		runtimePressure,
		tags: input.tags ?? [],
		signals,
	};
	if (input.runtime?.latencyBudgetMs !== undefined || input.expectedOutput?.maxLatencyMs !== undefined) {
		result.latencyBudgetMs = input.expectedOutput?.maxLatencyMs ?? input.runtime?.latencyBudgetMs;
	}
	if (input.runtime?.costBudgetUsd !== undefined || input.expectedOutput?.maxCostUsd !== undefined) {
		result.costBudgetUsd = input.expectedOutput?.maxCostUsd ?? input.runtime?.costBudgetUsd;
	}
	if (stepContext.stepKind !== undefined) result.stepKind = stepContext.stepKind;
	if (stepContext.stepRisk !== undefined) result.stepRisk = stepContext.stepRisk;
	if (stepContext.stepIndex !== undefined) result.stepIndex = stepContext.stepIndex;
	if (stepContext.agentRole !== undefined) result.agentRole = stepContext.agentRole;
	if (stepContext.irreversible !== undefined) result.irreversible = stepContext.irreversible;
	if (stepContext.recentFailures !== undefined) result.recentFailures = stepContext.recentFailures;
	if (stepContext.lastVerifier !== undefined) {
		result.lastVerifier = stepContext.lastVerifier;
		result.lastVerifierFailed = stepContext.lastVerifier === "fail";
	}
	if (stepContext.escalationCount !== undefined) result.escalationCount = stepContext.escalationCount;
	if (stepContext.estimatedCacheHit !== undefined) result.estimatedCacheHit = stepContext.estimatedCacheHit;
	if (stepContext.providerAffinity !== undefined) result.providerAffinity = stepContext.providerAffinity;
	if (stepContext.remainingTokens !== undefined) result.remainingTokens = stepContext.remainingTokens;
	return result;
}

function estimateAttachmentTokens(input: RequestInput): number {
	return (input.attachments ?? []).reduce((sum, attachment) => {
		if (attachment.tokenEstimate !== undefined) return sum + attachment.tokenEstimate;
		switch (attachment.kind) {
			case "image":
				return sum + 1_200;
			case "pdf":
				return sum + 6_000;
			case "spreadsheet":
				return sum + 4_000;
			case "slides":
				return sum + 5_000;
			case "audio":
				return sum + 3_000;
			case "video":
				return sum + 8_000;
			case "text":
				return sum + 1_000;
			default:
				return sum + 500;
		}
	}, 0);
}

function estimateOutputTokens(input: RequestInput, inputTokens: number): number {
	const message = input.message.toLowerCase();
	if (input.expectedOutput?.format === "json" || JSON_HINT_RE.test(message)) return 1_000;
	if (SUMMARIZE_RE.test(message)) return Math.min(2_500, Math.max(400, Math.ceil(inputTokens * 0.12)));
	if (CODING_RE.test(message)) return 2_500;
	if (PLANNING_RE.test(message)) return 2_000;
	return 900;
}

function scoreTasks(
	text: string,
	signal: {
		hasCode: boolean;
		hasUrl: boolean;
		hasJsonRequirement: boolean;
		hasRetrievalNeed: boolean;
		hasMultimodalInput: boolean;
		safetySensitivity: number;
		reasoningComplexity: number;
	},
): Record<TaskType, number> {
	const scores = Object.fromEntries(TASK_TYPES.map(t => [t, 0])) as Record<TaskType, number>;
	scores.chat = 0.25;
	scores.translation += TRANSLATION_RE.test(text) ? 0.78 : 0;
	scores.summarization += SUMMARIZE_RE.test(text) ? 0.78 : 0;
	scores.classification += CLASSIFY_RE.test(text) ? 0.72 : 0;
	scores.extraction += EXTRACTION_RE.test(text) ? 0.65 : 0;
	scores.coding += signal.hasCode ? 0.9 : 0;
	scores.planning += PLANNING_RE.test(text) ? 0.66 : 0;
	scores.reasoning += REASONING_RE.test(text) || signal.reasoningComplexity > 0.5 ? 0.58 : 0;
	scores.retrieval += signal.hasRetrievalNeed || signal.hasUrl ? 0.58 : 0;
	scores.multimodal += signal.hasMultimodalInput ? 0.9 : 0;
	scores.safety += signal.safetySensitivity > 0.35 ? 0.9 : 0;
	if (signal.hasJsonRequirement) scores.extraction += 0.22;
	if (signal.reasoningComplexity > 0.6) scores.reasoning += 0.18;
	if (signal.safetySensitivity > 0.6) scores.safety += 0.2;
	scores.unknown = 0.05;
	for (const key of TASK_TYPES) scores[key] = clamp01(scores[key]);
	return scores;
}

function selectTaskType(scores: Record<TaskType, number>): TaskType {
	const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]) as [TaskType, number][];
	const [task, score] = sorted[0] ?? ["unknown", 0];
	return score < 0.28 ? "chat" : task;
}

function looksLikeCode(text: string): boolean {
	const lines = text.split(/\r?\n/);
	const codeish = lines.filter(
		line =>
			/^\s*(import|export|const|let|var|function|class|def|from |SELECT |UPDATE |INSERT |CREATE |pub |fn |package |using |#include)\b/.test(
				line,
			) ||
			/[{};]\s*$/.test(line) ||
			/=>|==={0,1}|!=|:=|\breturn\b/.test(line),
	);
	return codeish.length >= 2;
}

function detectLanguage(text: string): string {
	if (!text.trim()) return "unknown";
	const cjk = (text.match(/[\u3400-\u9FFF]/g) ?? []).length;
	if (cjk > Math.max(4, text.length * 0.08)) return "zh";
	const ja = (text.match(/[\u3040-\u30FF]/g) ?? []).length;
	if (ja > 4) return "ja";
	const ko = (text.match(/[\uAC00-\uD7AF]/g) ?? []).length;
	if (ko > 4) return "ko";
	if (/\b(el|la|los|las|una|para|con|traducir)\b/i.test(text)) return "es-or-romance";
	if (/\b(le|la|les|des|avec|traduire)\b/i.test(text)) return "fr-or-romance";
	return "en-or-unknown";
}

function estimateRuntimePressure(runtime = {} as NonNullable<RequestInput["runtime"]>): number {
	const queue = Math.min(0.45, (runtime.queueDepth ?? 0) / 50);
	const degraded = (runtime.degradedModels?.length ?? 0) > 0 ? 0.18 : 0;
	const rateLimited = (runtime.rateLimitedProviders?.length ?? 0) > 0 ? 0.18 : 0;
	const downProviders = Object.values(runtime.providerHealth ?? {}).filter(v => v === "down").length * 0.12;
	return clamp01(queue + degraded + rateLimited + downProviders);
}

function collectSignals(input: {
	taskType: TaskType;
	approxInputTokens: number;
	hasCode: boolean;
	hasUrl: boolean;
	hasJsonRequirement: boolean;
	hasToolNeed: boolean;
	hasRetrievalNeed: boolean;
	hasMultimodalInput: boolean;
	hasLongContextNeed: boolean;
	reasoningComplexity: number;
	ambiguity: number;
	safetySensitivity: number;
	runtimePressure: number;
	stepContext: Partial<StepContextMetadata>;
}): string[] {
	const signals: string[] = [`task:${input.taskType}`];
	if (input.approxInputTokens > 12_000) signals.push("large-input");
	if (input.hasCode) signals.push("code");
	if (input.hasUrl) signals.push("url");
	if (input.hasJsonRequirement) signals.push("json-required");
	if (input.hasToolNeed) signals.push("tool-needed");
	if (input.hasRetrievalNeed) signals.push("retrieval-needed");
	if (input.hasMultimodalInput) signals.push("multimodal");
	if (input.hasLongContextNeed) signals.push("long-context");
	if (input.reasoningComplexity > 0.55) signals.push("complex-reasoning");
	if (input.ambiguity > 0.25) signals.push("ambiguous");
	if (input.safetySensitivity > 0.35) signals.push("safety-sensitive");
	if (input.runtimePressure > 0.25) signals.push("runtime-pressure");
	if (input.stepContext.stepKind !== undefined) signals.push(`step:${input.stepContext.stepKind}`);
	if (input.stepContext.stepRisk !== undefined) signals.push(`risk:${input.stepContext.stepRisk}`);
	if (input.stepContext.irreversible === true) signals.push("irreversible-step");
	if ((input.stepContext.recentFailures ?? 0) > 0) signals.push("recent-failures");
	if (input.stepContext.lastVerifier === "fail") signals.push("verifier-failed");
	if ((input.stepContext.escalationCount ?? 0) > 0) signals.push("escalated");
	if (input.stepContext.estimatedCacheHit === true) signals.push("cache-hit");
	if (input.stepContext.estimatedCacheHit === false) signals.push("cache-miss");
	return signals;
}

function countMatches(text: string, needles: string[]): number {
	return needles.reduce((count, needle) => count + (text.includes(needle) ? 1 : 0), 0);
}

function countQuestionMarks(text: string): number {
	return (text.match(/\?/g) ?? []).length;
}


function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

export function preferenceFromString(value: unknown): Preference {
	if (value === "speed" || value === "quality" || value === "cost" || value === "safety" || value === "balanced")
		return value;
	return "balanced";
}
