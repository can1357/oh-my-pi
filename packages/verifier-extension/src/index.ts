import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type Api,
	type AssistantMessage,
	completeSimple,
	Effort,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type TSchema,
} from "@pk-nerdsaver-ai/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@pk-nerdsaver-ai/pi-coding-agent";

const VERIFIER_TOOL_NAME = "llm_as_verifier";
const ORCHESTRATOR_TOOL_NAME = "subagent_orchestrator_plan";
const DEFAULT_GROUND_TRUTH_NOTE =
	"Prefer concrete evidence, observed outputs, tests, and explicit artifacts over polished narration or self-reported success.";
const GRANULARITY = 20;
const LETTERS = Array.from({ length: GRANULARITY }, (_value, index) => String.fromCharCode(65 + index));
const VALID_TOKENS: Record<string, number> = Object.fromEntries(
	LETTERS.flatMap((letter, index) => [
		[letter, GRANULARITY - index],
		[letter.toLowerCase(), GRANULARITY - index],
	]),
);
const DEFAULT_SUBAGENT_MODEL_SPEC = "pi/task";
const DEFAULT_GEMINI_PYTHON_MODEL_SPEC = "9router:gemini-3-5-flash-medium-round-robin";

const resolveUserPath = (cwd: string, value: string): string =>
	path.resolve(cwd, value.startsWith("@") ? value.slice(1) : value);
const normalizeKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

export const truncate = (text: string, maxChars: number): { text: string; truncated: boolean } => {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: `${text.slice(0, Math.max(0, maxChars - 18))}\n... (truncated)`, truncated: true };
};

interface CandidateInput {
	id: string;
	path?: string;
	content?: string;
	summary?: string;
	evidencePaths?: string[];
	evidenceText?: string;
}

interface CriterionInput {
	id?: string;
	name: string;
	description: string;
}

interface ModelWeightInput {
	model: string;
	weight: number;
}

export type OrchestratorComplexity = "single-step" | "multi-step" | "open-ended";
export type OrchestratorRisk = "low" | "med" | "high";
export type OrchestratorEvidenceNeed = "current-context" | "tool-retrieval" | "multi-source";
export type OrchestratorDecomposability = "independent" | "sequential" | "not-decomposable";
export type OrchestratorDataSensitivity = "public" | "internal" | "confidential" | "unknown";
export type OrchestratorCostTier = "low" | "med" | "high";
export type OrchestratorSpecialistRole = "specialist" | "generalist" | "verifier";
export type OrchestratorRouting = "direct" | "single" | "parallel" | "recursive";
export type OrchestratorMode = "fast" | "deep";
export type OrchestratorVerificationTier = "V0" | "V1" | "V2" | "V3";

export interface OrchestratorSpecialistInput {
	name: string;
	scope: string;
	costTier: OrchestratorCostTier;
	role?: OrchestratorSpecialistRole;
	modelFamily?: string;
	capabilities?: string[];
	trustScore?: number;
}

export interface OrchestratorPlanParams {
	request: string;
	complexity?: OrchestratorComplexity;
	risk?: OrchestratorRisk;
	evidenceNeed?: OrchestratorEvidenceNeed;
	decomposability?: OrchestratorDecomposability;
	dataSensitivity?: OrchestratorDataSensitivity;
	specialists?: OrchestratorSpecialistInput[];
	recursiveAllowed?: boolean;
}

export interface OrchestratorRoutePlan {
	mode: OrchestratorMode;
	routing: OrchestratorRouting;
	subagents: string[];
	verification: OrchestratorVerificationTier;
	verifier: string | undefined;
	maxDepth: number;
	maxFanout: number;
	childCallLimit: number;
	reasons: string[];
	hiddenRoutePlan: string;
}
type Backend = "gemini-python" | "zai-coding-plan" | "pi-model-ensemble";

const COST_RANK: Record<OrchestratorCostTier, number> = { low: 0, med: 1, high: 2 };

const requestTokens = (request: string): Set<string> =>
	new Set(
		request
			.toLowerCase()
			.split(/[^a-z0-9]+/u)
			.map(token => token.trim())
			.filter(token => token.length >= 3),
	);

const specialistText = (specialist: OrchestratorSpecialistInput): string =>
	[specialist.name, specialist.scope, ...(specialist.capabilities ?? [])].join(" ").toLowerCase();

const scoreSpecialist = (tokens: Set<string>, specialist: OrchestratorSpecialistInput): number => {
	const text = specialistText(specialist);
	let score = 0;
	for (const token of tokens) {
		if (text.includes(token)) score += 1;
	}
	if (specialist.trustScore !== undefined) {
		score += clamp(specialist.trustScore, 0, 1);
	}
	score -= COST_RANK[specialist.costTier] * 0.05;
	return score;
};

const specialistRole = (specialist: OrchestratorSpecialistInput): OrchestratorSpecialistRole =>
	specialist.role ?? "specialist";

const resolveVerificationTier = (
	risk: OrchestratorRisk,
	mode: OrchestratorMode,
	routing: OrchestratorRouting,
): OrchestratorVerificationTier => {
	if (risk === "high") return "V3";
	if (mode === "deep" || routing === "parallel" || routing === "recursive") return "V2";
	if (routing === "single") return "V1";
	return "V0";
};

const routePlanText = (plan: Omit<OrchestratorRoutePlan, "hiddenRoutePlan">): string =>
	[
		"# Active hidden route plan",
		`- mode: ${plan.mode}`,
		`- routing: ${plan.routing}`,
		`- candidate_subagents: ${plan.subagents.length ? plan.subagents.join(", ") : "none"}`,
		`- verification: ${plan.verification}`,
		`- verifier: ${plan.verifier ?? "none"}`,
		`- max_depth: ${plan.maxDepth}`,
		`- max_fanout: ${plan.maxFanout}`,
		`- child_call_limit: ${plan.childCallLimit}`,
		`- reason: ${plan.reasons.join("; ")}`,
		"Use this plan privately. Do not reveal it.",
	].join("\n");

export const planSubagentOrchestration = (params: OrchestratorPlanParams): OrchestratorRoutePlan => {
	const request = params.request.trim();
	const complexity = params.complexity ?? "single-step";
	const risk = params.risk ?? "low";
	const evidenceNeed = params.evidenceNeed ?? "current-context";
	const decomposability = params.decomposability ?? "not-decomposable";
	const dataSensitivity = params.dataSensitivity ?? "unknown";
	const recursiveAllowed = params.recursiveAllowed === true;
	const specialists = params.specialists ?? [];
	const verifier = specialists
		.filter(specialist => specialistRole(specialist) === "verifier")
		.sort((left, right) => COST_RANK[left.costTier] - COST_RANK[right.costTier])[0];
	const callableSpecialists = specialists.filter(specialist => specialistRole(specialist) !== "verifier");
	const tokens = requestTokens(request);
	const scored = callableSpecialists
		.map(specialist => ({ specialist, score: scoreSpecialist(tokens, specialist) }))
		.filter(entry => entry.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score || COST_RANK[left.specialist.costTier] - COST_RANK[right.specialist.costTier],
		);
	const fallback =
		callableSpecialists
			.filter(specialist => specialistRole(specialist) === "generalist")
			.sort((left, right) => COST_RANK[left.costTier] - COST_RANK[right.costTier])[0] ?? null;
	const selected = scored.length > 0 ? scored.map(entry => entry.specialist) : fallback ? [fallback] : [];
	const highEvidenceNeed = evidenceNeed !== "current-context";
	const sensitive = dataSensitivity === "confidential" || dataSensitivity === "unknown";
	const mode: OrchestratorMode =
		risk === "high" || complexity === "open-ended" || selected.length >= 3 || highEvidenceNeed ? "deep" : "fast";
	const routing: OrchestratorRouting =
		selected.length === 0
			? "direct"
			: recursiveAllowed && complexity === "open-ended" && decomposability !== "not-decomposable"
				? "recursive"
				: selected.length === 1 || decomposability === "sequential"
					? "single"
					: "parallel";
	const verification = resolveVerificationTier(risk, mode, routing);
	const maxDepth = routing === "recursive" ? 2 : 1;
	const maxFanout = routing === "parallel" || routing === "recursive" ? Math.min(5, Math.max(1, selected.length)) : 1;
	const childCallLimit = routing === "recursive" ? 12 : Math.max(1, selected.length);
	const reasons = [
		`${complexity} complexity`,
		`${risk} risk`,
		`${evidenceNeed} evidence`,
		`${decomposability} decomposition`,
		sensitive ? "treat data as confidential" : `${dataSensitivity} data`,
		selected.length ? `${selected.length} matched subagent(s)` : "no specialist match",
	];
	const planWithoutText = {
		mode,
		routing,
		subagents: selected.map(specialist => specialist.name),
		verification,
		verifier: verifier?.name,
		maxDepth,
		maxFanout,
		childCallLimit,
		reasons,
	};
	return {
		...planWithoutText,
		hiddenRoutePlan: routePlanText(planWithoutText),
	};
};

interface EvidenceBlock {
	label: string;
	content: string;
	source: string;
	truncated: boolean;
}

interface NormalizedCandidate {
	id: string;
	summary: string;
	content: string;
	source: string;
	truncated: boolean;
	evidence: Array<{ label: string; content: string }>;
	evidenceSources: EvidenceBlock[];
}

interface ResolvedPiModel {
	spec: string;
	provider: string;
	id: string;
	display: string;
	model: Model<Api>;
}

interface ResolvedModelWeight {
	model: string;
	weight: number;
}

export interface CompareRepetition {
	rep: number;
	order: "original" | "swapped";
	model: string;
	weight: number;
	score_a: number;
	score_b: number;
	canonical_score_a: number;
	canonical_score_b: number;
	source_a: "text" | "fallback" | "mock";
	source_b: "text" | "fallback" | "mock";
	response_excerpt: string;
}

export interface AuditRepetition {
	rep: number;
	model: string;
	weight: number;
	score: number;
	source: "text" | "fallback" | "mock";
	response_excerpt: string;
}

interface VerifierConfig {
	mode: "compare" | "audit";
	backend: Backend;
	task: string;
	context: string;
	groundTruthNote: string;
	criteria: Array<{ id: string; name: string; description: string }>;
	candidates: NormalizedCandidate[];
	nVerifications: number;
	granularity: number;
	mock: boolean;
	models: ResolvedPiModel[];
	modelWeights: ResolvedModelWeight[];
}

const MODEL_ALIASES: Record<string, { provider: string; id: string }> = {
	[normalizeKey("gpt-5.4")]: { provider: "openai", id: "gpt-5.4" },
	[normalizeKey("openai:gpt-5.4")]: { provider: "openai", id: "gpt-5.4" },
	[normalizeKey("gpt-5.5")]: { provider: "openai", id: "gpt-5.5" },
	[normalizeKey("openai:gpt-5.5")]: { provider: "openai", id: "gpt-5.5" },
	[normalizeKey("codex:gpt-5.5")]: { provider: "openai", id: "gpt-5.5" },
	[normalizeKey("gpt-5-codex")]: { provider: "openai", id: "gpt-5-codex" },
	[normalizeKey("openai:gpt-5-codex")]: { provider: "openai", id: "gpt-5-codex" },
	[normalizeKey("kimi-for-coding")]: { provider: "kimi", id: "kimi-for-coding" },
	[normalizeKey("kimi:kimi-for-coding")]: { provider: "kimi", id: "kimi-for-coding" },
	[normalizeKey("kimi-k2")]: { provider: "kimi", id: "kimi-for-coding" },
	[normalizeKey("kimi:kimi-k2")]: { provider: "kimi", id: "kimi-for-coding" },
	[normalizeKey("gemini")]: { provider: "google", id: "gemini-2.5-flash" },
	[normalizeKey("gemini-2.5-flash")]: { provider: "google", id: "gemini-2.5-flash" },
	[normalizeKey("google:gemini-2.5-flash")]: { provider: "google", id: "gemini-2.5-flash" },
	[normalizeKey("minimax-m2.7-highspeed")]: { provider: "minimax", id: "MiniMax-M2.7-highspeed" },
	[normalizeKey("minimax:MiniMax-M2.7-highspeed")]: { provider: "minimax", id: "MiniMax-M2.7-highspeed" },
	[normalizeKey("minimax-m3")]: { provider: "minimax.io", id: "minimax-m3" },
	[normalizeKey("minimax.io:minimax-m3")]: { provider: "minimax.io", id: "minimax-m3" },
	[normalizeKey("minimax:minimax-m3")]: { provider: "minimax.io", id: "minimax-m3" },
	[normalizeKey("glm-5.1")]: { provider: "zai", id: "glm-5.1" },
	[normalizeKey("zai:glm-5.1")]: { provider: "zai", id: "glm-5.1" },
};

const SUCCESS_HINTS = [
	"pass",
	"passed",
	"success",
	"succeeded",
	"fixed",
	"verified",
	"green",
	"expected output",
	"report generated",
];
const ERROR_HINTS = [
	"error",
	"failed",
	"failure",
	"traceback",
	"exception",
	"command not found",
	"no such file",
	"segmentation fault",
	"not created",
];
const PARTIAL_HINTS = ["partial", "some tests", "not verified", "uncertain", "partial progress"];

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
const normalizedFromRaw = (rawValue: number): number => (rawValue - 1) / (GRANULARITY - 1);
const rawFromNormalized = (score: number): number => 1 + clamp(score, 0, 1) * (GRANULARITY - 1);
const letterFromNormalized = (score: number): string =>
	LETTERS[clamp(Math.round(GRANULARITY - rawFromNormalized(score)), 0, GRANULARITY - 1)];
const average = (values: number[]): number =>
	values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export const weightedMean = <T>(items: T[], getValue: (item: T) => number, getWeight: (item: T) => number): number => {
	const totalWeight = items.reduce((sum, item) => sum + Math.max(0, getWeight(item)), 0);
	if (totalWeight <= 0) return items.length ? average(items.map(getValue)) : 0;
	return items.reduce((sum, item) => sum + getValue(item) * Math.max(0, getWeight(item)), 0) / totalWeight;
};

export const weightedStdDev = <T>(
	items: T[],
	getValue: (item: T) => number,
	getWeight: (item: T) => number,
	mean?: number,
): number => {
	if (!items.length) return 0;
	const resolvedMean = mean ?? weightedMean(items, getValue, getWeight);
	const totalWeight = items.reduce((sum, item) => sum + Math.max(0, getWeight(item)), 0);
	if (totalWeight <= 0) {
		const simpleMean = average(items.map(getValue));
		const variance = average(items.map(item => (getValue(item) - simpleMean) ** 2));
		return Math.sqrt(variance);
	}
	const variance =
		items.reduce((sum, item) => sum + Math.max(0, getWeight(item)) * (getValue(item) - resolvedMean) ** 2, 0) /
		totalWeight;
	return Math.sqrt(variance);
};

const heuristicScore = (text: string): number => {
	const lowered = text.toLowerCase();
	const success = SUCCESS_HINTS.reduce((sum, token) => sum + lowered.split(token).length - 1, 0);
	const errors = ERROR_HINTS.reduce((sum, token) => sum + lowered.split(token).length - 1, 0);
	const partial = PARTIAL_HINTS.reduce((sum, token) => sum + lowered.split(token).length - 1, 0);
	return clamp(0.55 + 0.06 * success - 0.08 * errors - 0.03 * partial, 0.05, 0.95);
};

export const extractTextSource = async (
	cwd: string,
	label: string,
	input: { path?: string; content?: string },
	maxChars: number,
): Promise<{ text: string; source: string; truncated: boolean }> => {
	if (input.path) {
		const absolutePath = resolveUserPath(cwd, input.path);
		const file = Bun.file(absolutePath);
		const size = file.size;
		if (size > maxChars) {
			throw new Error(`${label} file is too large: ${absolutePath} (${size} bytes > ${maxChars} max).`);
		}
		const content = await file.text();
		if (content.includes("\0")) {
			throw new Error(`${label} file appears to be binary: ${absolutePath}`);
		}
		const clipped = truncate(content, maxChars);
		return { text: clipped.text, source: absolutePath, truncated: clipped.truncated };
	}

	if (typeof input.content === "string" && input.content.trim()) {
		const clipped = truncate(input.content.trim(), maxChars);
		return { text: clipped.text, source: `${label}:inline`, truncated: clipped.truncated };
	}

	throw new Error(`${label} requires either path or content.`);
};

export const readEvidenceBlocks = async (
	cwd: string,
	paths: string[] | undefined,
	maxChars: number,
): Promise<EvidenceBlock[]> => {
	if (!paths?.length) return [];
	const blocks: EvidenceBlock[] = [];
	for (const rawPath of paths) {
		const absolutePath = resolveUserPath(cwd, rawPath);
		const file = Bun.file(absolutePath);
		const size = file.size;
		if (size > maxChars) {
			throw new Error(`Evidence file is too large: ${absolutePath} (${size} bytes > ${maxChars} max).`);
		}
		const content = await file.text();
		if (content.includes("\0")) {
			throw new Error(`Evidence file appears to be binary: ${absolutePath}`);
		}
		const clipped = truncate(content, maxChars);
		blocks.push({
			label: path.basename(absolutePath),
			content: clipped.text,
			source: absolutePath,
			truncated: clipped.truncated,
		});
	}
	return blocks;
};

async function runPython(pi: ExtensionAPI, scriptPath: string, args: string[], signal?: AbortSignal) {
	const attempts: Array<{ command: string; args: string[] }> = [
		{ command: "python", args: [scriptPath, ...args] },
		{ command: "py", args: ["-3", scriptPath, ...args] },
	];

	const outerTimeoutMs = 90000;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), outerTimeoutMs);
	if (signal) {
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		let lastError = "";
		for (const attempt of attempts) {
			const result = await pi.exec(attempt.command, attempt.args, { signal: controller.signal, timeout: 600000 });
			if (result.code === 0) return result;
			lastError = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		}
		throw new Error(lastError || "Failed to execute Python runner. Ensure python or py -3 is available.");
	} finally {
		clearTimeout(timeoutId);
		controller.abort();
	}
}

const formatEvidenceBlocks = (evidence: Array<{ label: string; content: string }>): string => {
	if (!evidence.length) return "";
	return ["Evidence:", ...evidence.map(item => `- ${item.label}:\n${item.content}`)].join("\n");
};

const formatCandidate = (candidate: NormalizedCandidate, label: string): string => {
	const parts = [`## ${label} — ${candidate.id}`];
	if (candidate.summary) parts.push(`Summary:\n${candidate.summary}`);
	parts.push(`Content:\n${candidate.content}`);
	const evidenceBlock = formatEvidenceBlocks(candidate.evidence);
	if (evidenceBlock) parts.push(evidenceBlock);
	return parts.join("\n\n");
};

const createComparePrompt = (
	config: VerifierConfig,
	candidateA: NormalizedCandidate,
	candidateB: NormalizedCandidate,
	criterion: { id: string; name: string; description: string },
): string => {
	const parts = [
		"You are an expert verifier choosing between two candidate solutions.",
		config.groundTruthNote,
		`Task:\n${config.task}`,
	];
	if (config.context) parts.push(`Shared context:\n${config.context}`);
	parts.push(
		formatCandidate(candidateA, "Candidate A"),
		formatCandidate(candidateB, "Candidate B"),
		`Criterion: ${criterion.name}\n${criterion.description}`,
		[
			"Rate each candidate on a 20-point scale using letters A through T:",
			"  A = clearly and completely best / strongest",
			"  B-D = very strong with only minor concerns",
			"  E-G = above average, mostly correct with some issues",
			"  H-J = mixed, leans positive",
			"  K-M = mixed, leans negative",
			"  N-P = below average, significant issues remain",
			"  Q-S = weak with only partial value",
			"  T = clearly and completely weakest / failed",
		].join("\n"),
		"Evaluate BOTH candidates only on the named criterion. Ignore unrelated aspects.",
		EVIDENCE_INSTRUCTION,
		"<evidence_A>1. ... 2. ... 3. ...</evidence_A>",
		"<evidence_B>1. ... 2. ... 3. ...</evidence_B>",
		"Then output final scores exactly in this format:",
		"<score_A>LETTER_A_TO_T</score_A>",
		"<score_B>LETTER_A_TO_T</score_B>",
	);
	return parts.join("\n\n");
};

const createAuditPrompt = (
	config: VerifierConfig,
	candidate: NormalizedCandidate,
	criterion: { id: string; name: string; description: string },
): string => {
	const parts = [
		"You are an expert verifier scoring a single candidate solution.",
		config.groundTruthNote,
		`Task:\n${config.task}`,
	];
	if (config.context) parts.push(`Shared context:\n${config.context}`);
	parts.push(
		formatCandidate(candidate, "Candidate"),
		`Criterion: ${criterion.name}\n${criterion.description}`,
		[
			"Rate the candidate on a 20-point scale using letters A through T:",
			"  A = clearly and completely best / strongest",
			"  B-D = very strong with only minor concerns",
			"  E-G = above average, mostly correct with some issues",
			"  H-J = mixed, leans positive",
			"  K-M = mixed, leans negative",
			"  N-P = below average, significant issues remain",
			"  Q-S = weak with only partial value",
			"  T = clearly and completely weakest / failed",
		].join("\n"),
		"Evaluate the candidate only on the named criterion.",
		EVIDENCE_INSTRUCTION,
		"<evidence>1. ... 2. ... 3. ...</evidence>",
		"Then output the final score exactly in this format:",
		"<score>LETTER_A_TO_T</score>",
	);
	return parts.join("\n\n");
};

const extractTextFromAssistantMessage = (message: AssistantMessage): string => {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((item): item is TextContent => item?.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n")
		.trim();
};

export const extractTaggedScore = (
	text: string,
	tag: string,
): { score: number; source: "text" | "fallback" | "mock" } => {
	const tagName = tag.replace(/[<>]/g, "");
	const match = text.match(new RegExp(`<${tagName}>\\s*([A-Ta-t])\\s*</${tagName}>`));
	if (!match) return { score: 0.5, source: text.includes("Mock verifier response") ? "mock" : "fallback" };
	const raw = VALID_TOKENS[match[1]];
	if (!raw) return { score: 0.5, source: text.includes("Mock verifier response") ? "mock" : "fallback" };
	return { score: normalizedFromRaw(raw), source: text.includes("Mock verifier response") ? "mock" : "text" };
};

const buildMockCompareText = (
	prompt: string,
	candidateA: NormalizedCandidate,
	candidateB: NormalizedCandidate,
): string => {
	const scoreA = heuristicScore(`${candidateA.summary}\n${candidateA.content}`);
	const scoreB = heuristicScore(`${candidateB.summary}\n${candidateB.content}`);
	return [
		"Mock verifier response.",
		`Prompt excerpt: ${truncate(prompt, 120).text}`,
		`<score_A>${letterFromNormalized(scoreA)}</score_A>`,
		`<score_B>${letterFromNormalized(scoreB)}</score_B>`,
	].join("\n");
};

const buildMockAuditText = (prompt: string, candidate: NormalizedCandidate): string => {
	const score = heuristicScore(`${candidate.summary}\n${candidate.content}`);
	return [
		"Mock verifier response.",
		`Prompt excerpt: ${truncate(prompt, 120).text}`,
		`<score>${letterFromNormalized(score)}</score>`,
	].join("\n");
};

const resolveVerifierModel = (ctx: ExtensionContext, spec: string): ResolvedPiModel => {
	if (spec === DEFAULT_SUBAGENT_MODEL_SPEC) {
		const model = ctx.models.resolve(DEFAULT_SUBAGENT_MODEL_SPEC);
		if (!model) {
			throw new Error("Configured subagent model 'pi/task' could not be resolved.");
		}
		return {
			spec,
			provider: model.provider,
			id: model.id,
			display: `${model.provider}:${model.id}`,
			model,
		};
	}
	const alias = MODEL_ALIASES[normalizeKey(spec)];
	if (alias) {
		const model = ctx.modelRegistry.find(alias.provider, alias.id);
		if (!model) {
			throw new Error(
				`Configured alias '${spec}' resolved to ${alias.provider}:${alias.id}, but that model was not found in Pi's model registry.`,
			);
		}
		return {
			spec,
			provider: alias.provider,
			id: alias.id,
			display: `${alias.provider}:${alias.id}`,
			model,
		};
	}

	const colonIndex = spec.indexOf(":");
	if (colonIndex > 0) {
		const provider = spec.slice(0, colonIndex).trim();
		const id = spec.slice(colonIndex + 1).trim();
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) {
			throw new Error(`Model not found: ${provider}:${id}`);
		}
		return { spec, provider, id, display: `${provider}:${id}`, model };
	}

	const normalizedSpec = normalizeKey(spec);
	const matches = ctx.modelRegistry.getAll().filter(model => {
		const keys = [
			normalizeKey(model.id ?? ""),
			normalizeKey(model.name ?? ""),
			normalizeKey(`${model.provider}:${model.id}`),
			normalizeKey(`${model.provider}/${model.id}`),
		];
		return keys.includes(normalizedSpec);
	});

	if (!matches.length) {
		throw new Error(`Could not resolve model spec '${spec}'. Use provider:id form like openai:gpt-5.4.`);
	}

	const preferredProviders = [
		"openai",
		"openai-codex",
		"kimi",
		"minimax.io",
		"minimax",
		"google",
		"zai",
		"github-copilot",
	];
	matches.sort((left, right) => {
		const leftRank = preferredProviders.indexOf(left.provider);
		const rightRank = preferredProviders.indexOf(right.provider);
		return (leftRank === -1 ? 999 : leftRank) - (rightRank === -1 ? 999 : rightRank);
	});

	const winner = matches[0];
	return {
		spec,
		provider: winner.provider,
		id: winner.id,
		display: `${winner.provider}:${winner.id}`,
		model: winner,
	};
};

const resolveVerifierModels = (ctx: ExtensionContext, specs: string[]): ResolvedPiModel[] => {
	if (!specs.length) {
		throw new Error("At least one verifier model must be configured.");
	}
	return specs.map(spec => resolveVerifierModel(ctx, spec));
};

const modelForPythonRunner = (model: ResolvedPiModel): string =>
	model.provider === "google" || model.provider === "openai" || model.provider === "openai-codex"
		? model.id
		: `${model.provider}/${model.id}`;

const resolveModelWeights = (
	resolvedModels: ResolvedPiModel[],
	weightInputs: ModelWeightInput[] | undefined,
): ResolvedModelWeight[] => {
	const defaults = new Map(resolvedModels.map(model => [model.display, 1]));
	for (const entry of weightInputs ?? []) {
		const matched = resolvedModels.find(
			model =>
				model.display === entry.model ||
				model.spec === entry.model ||
				normalizeKey(model.display) === normalizeKey(entry.model),
		);
		if (!matched) {
			continue;
		}
		defaults.set(matched.display, Math.max(0, entry.weight));
	}
	return resolvedModels.map(model => ({ model: model.display, weight: defaults.get(model.display) ?? 1 }));
};

export const chooseWinner = (
	scoreA: number,
	scoreB: number,
	tieThreshold = 0.05,
): "candidate_a" | "candidate_b" | "tie" => {
	if (Math.abs(scoreA - scoreB) < tieThreshold) return "tie";
	return scoreA > scoreB ? "candidate_a" : "candidate_b";
};

const EVIDENCE_INSTRUCTION =
	"Before assigning any score, list exactly 3 evidence observations. Each observation must quote or paraphrase a concrete fact from the candidate, evidence, logs, tests, or task requirements. Do not count style, fluency, or confidence as evidence unless the criterion is explicitly about style. After the 3 observations, output the final score tag exactly as requested.";

interface CompareBreakdown {
	score_a: number;
	score_b: number;
	margin: number;
	disagreement: number;
	confidence: number;
	swap_consistency: number;
	model_breakdown: Array<{
		model: string;
		weight: number;
		repetitions: number;
		score_a: number;
		score_b: number;
		margin: number;
	}>;
}

interface AuditBreakdown {
	score: number;
	disagreement: number;
	confidence: number;
	vote_margin: number;
	model_breakdown: Array<{
		model: string;
		weight: number;
		repetitions: number;
		score: number;
		confidence: number;
	}>;
}

export const buildCompareBreakdown = (repetitions: CompareRepetition[]): CompareBreakdown => {
	const scoreA = weightedMean(
		repetitions,
		item => item.canonical_score_a,
		item => item.weight,
	);
	const scoreB = weightedMean(
		repetitions,
		item => item.canonical_score_b,
		item => item.weight,
	);
	const meanDiff = weightedMean(
		repetitions,
		item => item.canonical_score_a - item.canonical_score_b,
		item => item.weight,
	);
	const disagreement = clamp(
		weightedStdDev(
			repetitions,
			item => item.canonical_score_a - item.canonical_score_b,
			item => item.weight,
			meanDiff,
		),
		0,
		1,
	);
	const confidence = clamp(Math.abs(meanDiff) * (1 - disagreement), 0, 1);

	// Swap-consistency expects repetitions in (original, swapped) pairs.
	// Each pair must contain exactly one "original" and one "swapped" entry.
	if (repetitions.length % 2 !== 0) {
		throw new Error("Swap-consistency invariant violated: expected an even number of repetitions.");
	}

	let swapDiffSum = 0;
	let swapPairCount = 0;
	for (let index = 0; index + 1 < repetitions.length; index += 2) {
		const left = repetitions[index];
		const right = repetitions[index + 1];
		if (left.order === right.order) {
			throw new Error(
				`Swap-consistency invariant violated: adjacent repetitions at indices ${index} and ${index + 1} both have order "${left.order}".`,
			);
		}
		const leftMargin = left.canonical_score_a - left.canonical_score_b;
		const rightMargin = right.canonical_score_a - right.canonical_score_b;
		swapDiffSum += Math.abs(leftMargin - rightMargin);
		swapPairCount += 1;
	}
	const meanSwapDiff = swapPairCount > 0 ? swapDiffSum / swapPairCount : 0;
	const swapConsistency = 1 - clamp(meanSwapDiff, 0, 1);

	const grouped = new Map<string, CompareRepetition[]>();
	for (const repetition of repetitions) {
		const bucket = grouped.get(repetition.model) ?? [];
		bucket.push(repetition);
		grouped.set(repetition.model, bucket);
	}
	const modelBreakdown = Array.from(grouped.entries()).map(([model, items]) => ({
		model,
		weight: items[0]?.weight ?? 1,
		repetitions: items.length,
		score_a: weightedMean(
			items,
			item => item.canonical_score_a,
			item => item.weight,
		),
		score_b: weightedMean(
			items,
			item => item.canonical_score_b,
			item => item.weight,
		),
		margin: weightedMean(
			items,
			item => item.canonical_score_a - item.canonical_score_b,
			item => item.weight,
		),
	}));
	return {
		score_a: scoreA,
		score_b: scoreB,
		margin: scoreA - scoreB,
		disagreement,
		confidence,
		swap_consistency: swapConsistency,
		model_breakdown: modelBreakdown,
	};
};

const buildAuditBreakdown = (repetitions: AuditRepetition[]): AuditBreakdown => {
	const score = weightedMean(
		repetitions,
		item => item.score,
		item => item.weight,
	);
	const meanDelta = weightedMean(
		repetitions,
		item => item.score - 0.5,
		item => item.weight,
	);
	const disagreement = clamp(
		weightedStdDev(
			repetitions,
			item => item.score,
			item => item.weight,
			score,
		) * 2,
		0,
		1,
	);
	const confidence = clamp(Math.abs(meanDelta) * 2 * (1 - disagreement), 0, 1);

	let positive = 0;
	let negative = 0;
	for (const repetition of repetitions) {
		if (repetition.score >= 0.7) positive += 1;
		else if (repetition.score <= 0.3) negative += 1;
	}
	const nonAbstain = positive + negative;
	const voteMargin = nonAbstain > 0 ? Math.max(positive, negative) / nonAbstain : 0;

	const grouped = new Map<string, AuditRepetition[]>();
	for (const repetition of repetitions) {
		const bucket = grouped.get(repetition.model) ?? [];
		bucket.push(repetition);
		grouped.set(repetition.model, bucket);
	}
	const modelBreakdown = Array.from(grouped.entries()).map(([model, items]) => ({
		model,
		weight: items[0]?.weight ?? 1,
		repetitions: items.length,
		score: weightedMean(
			items,
			item => item.score,
			item => item.weight,
		),
		confidence: clamp(
			Math.abs(
				weightedMean(
					items,
					item => item.score - 0.5,
					item => item.weight,
				),
			) *
				2 *
				(1 -
					clamp(
						weightedStdDev(
							items,
							item => item.score,
							item => item.weight,
						) * 2,
						0,
						1,
					)),
			0,
			1,
		),
	}));
	return {
		score,
		disagreement,
		confidence,
		vote_margin: voteMargin,
		model_breakdown: modelBreakdown,
	};
};

const callPiModelPrompt = async (
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	resolvedModel: ResolvedPiModel,
	prompt: string,
): Promise<string> => {
	const sessionId = ctx.sessionManager.getSessionId();
	const apiKey = ctx.modelRegistry.resolver(resolvedModel.model, sessionId);

	const options: SimpleStreamOptions = {
		apiKey,
		signal,
		maxTokens: 2048,
		temperature: 0.7,
	};
	if (resolvedModel.model.reasoning) {
		options.reasoning = Effort.High;
	}

	const response = await completeSimple(
		resolvedModel.model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	return extractTextFromAssistantMessage(response);
};

type CompareRunResult = {
	mode: "compare";
	winner: {
		id: string;
		wins: number;
		mean_pair_score: number;
		mean_pair_confidence: number;
		summary: string;
	} | null;
	ranking: Array<{
		id: string;
		wins: number;
		mean_pair_score: number;
		mean_pair_confidence: number;
		summary: string;
	}>;
	pairwise: PairwiseResult[];
	estimated_calls: number;
};

export const selectOverallWinner = <T extends { wins: number; mean_pair_score: number }>(ranking: T[]): T | null => {
	if (ranking.length === 0) return null;
	if (ranking.length === 1) return ranking[0];
	return ranking[0].wins === ranking[1].wins && ranking[0].mean_pair_score === ranking[1].mean_pair_score
		? null
		: ranking[0];
};

type AuditRunResult = {
	mode: "audit";
	candidate: { id: string; summary: string };
	overall_score: number;
	overall_confidence: number;
	overall_vote_margin: number;
	criteria: Array<{
		criterion: { id: string; name: string; description: string };
		score: number;
		disagreement: number;
		confidence: number;
		vote_margin: number;
		model_breakdown: Array<{
			model: string;
			weight: number;
			repetitions: number;
			score: number;
			confidence: number;
		}>;
		repetitions: AuditRepetition[];
	}>;
	estimated_calls: number;
};

interface PairwiseResult {
	candidate_a: string;
	candidate_b: string;
	score_a: number;
	score_b: number;
	margin: number;
	confidence: number;
	disagreement: number;
	vote_margin: number;
	winner: string;
	calibrated_score_a?: number | null;
	calibrated_score_b?: number | null;
	calibrated_margin?: number | null;
	model_breakdown: Array<{
		model: string;
		weight: number;
		repetitions: number;
		score_a: number;
		score_b: number;
		confidence: number;
	}>;
	criteria: Array<{
		criterion: { id: string; name: string; description: string };
		score_a: number;
		score_b: number;
		margin: number;
		disagreement: number;
		confidence: number;
		swap_consistency: number;
		repetitions: CompareRepetition[];
	}>;
}

const runPiCompare = async (
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	config: VerifierConfig,
): Promise<CompareRunResult> => {
	const wins = new Map<string, number>(config.candidates.map(candidate => [candidate.id, 0]));
	const pairTotals = new Map<string, number[]>(config.candidates.map(candidate => [candidate.id, []]));
	const pairConfidences = new Map<string, number[]>(config.candidates.map(candidate => [candidate.id, []]));
	const pairwise: PairwiseResult[] = [];
	let estimatedCalls = 0;

	for (let left = 0; left < config.candidates.length; left += 1) {
		for (let right = left + 1; right < config.candidates.length; right += 1) {
			const candidateA = config.candidates[left];
			const candidateB = config.candidates[right];
			const criteriaResults: Array<{
				criterion: { id: string; name: string; description: string };
				score_a: number;
				score_b: number;
				margin: number;
				disagreement: number;
				confidence: number;
				swap_consistency: number;
				model_breakdown: Array<{
					model: string;
					weight: number;
					repetitions: number;
					score_a: number;
					score_b: number;
					margin: number;
				}>;
				repetitions: CompareRepetition[];
			}> = [];
			const votes = new Map<string, number>([
				[candidateA.id, 0],
				[candidateB.id, 0],
			]);

			for (const criterion of config.criteria) {
				const repetitions: CompareRepetition[] = [];
				for (let rep = 0; rep < config.nVerifications; rep += 1) {
					const orderEntries: Array<{
						order: "original" | "swapped";
						first: NormalizedCandidate;
						second: NormalizedCandidate;
					}> = [
						{ order: "original", first: candidateA, second: candidateB },
						{ order: "swapped", first: candidateB, second: candidateA },
					];
					for (const entry of orderEntries) {
						estimatedCalls += 1;
						const selectedModel =
							config.models[(rep * 2 + (entry.order === "swapped" ? 1 : 0)) % config.models.length];
						const weight = config.modelWeights.find(w => w.model === selectedModel.display)?.weight ?? 1;
						const prompt = createComparePrompt(config, entry.first, entry.second, criterion);
						const text = config.mock
							? buildMockCompareText(prompt, entry.first, entry.second)
							: await callPiModelPrompt(ctx, signal, selectedModel, prompt);
						const scoreA = extractTaggedScore(text, "<score_A>");
						const scoreB = extractTaggedScore(text, "<score_B>");
						const isSwapped = entry.order === "swapped";
						repetitions.push({
							rep: rep + 1,
							order: entry.order,
							model: selectedModel.display,
							weight,
							score_a: scoreA.score,
							score_b: scoreB.score,
							canonical_score_a: isSwapped ? scoreB.score : scoreA.score,
							canonical_score_b: isSwapped ? scoreA.score : scoreB.score,
							source_a: scoreA.source,
							source_b: scoreB.source,
							response_excerpt: truncate(text, 500).text,
						});
					}
				}

				const breakdown = buildCompareBreakdown(repetitions);
				criteriaResults.push({
					criterion,
					...breakdown,
					repetitions,
				});
			}

			const scoreA = average(criteriaResults.map(result => result.score_a));
			const scoreB = average(criteriaResults.map(result => result.score_b));
			const confidence = average(criteriaResults.map(result => result.confidence));
			const disagreement = average(criteriaResults.map(result => result.disagreement));
			const modelBreakdown = Array.from(
				criteriaResults
					.flatMap(result => result.repetitions)
					.reduce((map, repetition) => {
						const bucket = map.get(repetition.model) ?? [];
						bucket.push(repetition);
						map.set(repetition.model, bucket);
						return map;
					}, new Map<string, CompareRepetition[]>()),
			).map(([model, repetitions]) => ({
				model,
				weight: repetitions[0]?.weight ?? 1,
				repetitions: repetitions.length,
				score_a: weightedMean(
					repetitions,
					item => item.canonical_score_a,
					item => item.weight,
				),
				score_b: weightedMean(
					repetitions,
					item => item.canonical_score_b,
					item => item.weight,
				),
				confidence: buildCompareBreakdown(repetitions).confidence,
			}));

			for (const result of criteriaResults) {
				for (const repetition of result.repetitions) {
					if (repetition.canonical_score_a > repetition.canonical_score_b) {
						votes.set(candidateA.id, (votes.get(candidateA.id) ?? 0) + 1);
					} else if (repetition.canonical_score_b > repetition.canonical_score_a) {
						votes.set(candidateB.id, (votes.get(candidateB.id) ?? 0) + 1);
					} else {
						votes.set(candidateA.id, (votes.get(candidateA.id) ?? 0) + 0.5);
						votes.set(candidateB.id, (votes.get(candidateB.id) ?? 0) + 0.5);
					}
				}
			}
			const totalVotes = (votes.get(candidateA.id) ?? 0) + (votes.get(candidateB.id) ?? 0);
			const voteMargin =
				totalVotes > 0 ? Math.max(votes.get(candidateA.id) ?? 0, votes.get(candidateB.id) ?? 0) / totalVotes : 0;

			// Only declare a pairwise winner when the vote margin is decisive (>= 0.7).
			// The 0.05 tie threshold applies to the averaged criterion scores, not raw votes.
			const candidateWinner = voteMargin >= 0.7 ? chooseWinner(scoreA, scoreB, 0.05) : "tie";
			let winner: string;
			if (candidateWinner === "candidate_a") {
				wins.set(candidateA.id, (wins.get(candidateA.id) ?? 0) + 1);
				winner = candidateA.id;
			} else if (candidateWinner === "candidate_b") {
				wins.set(candidateB.id, (wins.get(candidateB.id) ?? 0) + 1);
				winner = candidateB.id;
			} else {
				wins.set(candidateA.id, (wins.get(candidateA.id) ?? 0) + 0.5);
				wins.set(candidateB.id, (wins.get(candidateB.id) ?? 0) + 0.5);
				winner = "tie";
			}

			pairTotals.get(candidateA.id)?.push(scoreA);
			pairTotals.get(candidateB.id)?.push(scoreB);
			pairConfidences.get(candidateA.id)?.push(confidence);
			pairConfidences.get(candidateB.id)?.push(confidence);
			pairwise.push({
				candidate_a: candidateA.id,
				candidate_b: candidateB.id,
				score_a: scoreA,
				score_b: scoreB,
				margin: scoreA - scoreB,
				confidence,
				disagreement,
				vote_margin: voteMargin,
				winner,
				model_breakdown: modelBreakdown,
				criteria: criteriaResults,
			});
		}
	}

	const ranking = config.candidates
		.map(candidate => {
			const pairScores = pairTotals.get(candidate.id) ?? [];
			const confidences = pairConfidences.get(candidate.id) ?? [];
			return {
				id: candidate.id,
				// mean_pair_score is the average of this candidate's pairwise criterion-score averages.
				// It is not a canonical absolute score; reordering candidates can shift it.
				mean_pair_score: pairScores.length ? average(pairScores) : 0.5,
				wins: wins.get(candidate.id) ?? 0,
				mean_pair_confidence: confidences.length ? average(confidences) : 0,
				summary: candidate.summary,
			};
		})
		.sort(
			(a, b) =>
				b.wins - a.wins ||
				b.mean_pair_score - a.mean_pair_score ||
				b.mean_pair_confidence - a.mean_pair_confidence ||
				a.id.localeCompare(b.id),
		);

	return {
		mode: "compare",
		winner: selectOverallWinner(ranking),
		ranking,
		pairwise,
		estimated_calls: estimatedCalls,
	};
};

const runPiAudit = async (
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	config: VerifierConfig,
): Promise<AuditRunResult> => {
	const candidate = config.candidates[0];
	let estimatedCalls = 0;
	const criteriaResults: Array<{
		criterion: { id: string; name: string; description: string };
		score: number;
		disagreement: number;
		confidence: number;
		vote_margin: number;
		model_breakdown: Array<{
			model: string;
			weight: number;
			repetitions: number;
			score: number;
			confidence: number;
		}>;
		repetitions: AuditRepetition[];
	}> = [];

	for (const criterion of config.criteria) {
		const repetitions: AuditRepetition[] = [];
		for (let rep = 0; rep < config.nVerifications; rep += 1) {
			estimatedCalls += 1;
			const selectedModel = config.models[rep % config.models.length];
			const weight = config.modelWeights.find(w => w.model === selectedModel.display)?.weight ?? 1;
			const prompt = createAuditPrompt(config, candidate, criterion);
			const text = config.mock
				? buildMockAuditText(prompt, candidate)
				: await callPiModelPrompt(ctx, signal, selectedModel, prompt);
			const score = extractTaggedScore(text, "<score>");
			repetitions.push({
				rep: rep + 1,
				model: selectedModel.display,
				weight,
				score: score.score,
				source: score.source,
				response_excerpt: truncate(text, 500).text,
			});
		}
		criteriaResults.push({
			criterion,
			...buildAuditBreakdown(repetitions),
			repetitions,
		});
	}

	return {
		mode: "audit",
		candidate: { id: candidate.id, summary: candidate.summary },
		overall_score: average(criteriaResults.map(result => result.score)),
		overall_confidence: average(criteriaResults.map(result => result.confidence)),
		overall_vote_margin: average(criteriaResults.map(result => result.vote_margin ?? 0)),
		criteria: criteriaResults,
		estimated_calls: estimatedCalls,
	};
};

export const buildSummaryLines = (
	mode: "compare" | "audit",
	backend: string,
	models: ResolvedPiModel[],
	weights: ResolvedModelWeight[],
	result: CompareRunResult | AuditRunResult,
	mock: boolean,
	savedOutputPath?: string,
): string[] => {
	const lines = [`Backend: ${backend}`, `Models: ${models.map(model => model.display).join(" -> ")}`];
	if (weights.some(entry => entry.weight !== 1)) {
		lines.push(`Weights: ${weights.map(entry => `${entry.model}=${entry.weight}`).join(", ")}`);
	}
	if (mode === "compare") {
		const compareRes = result as CompareRunResult;
		const ranking = compareRes.ranking;
		const winner = compareRes.winner?.id ?? "tie";
		const confidence = Number(compareRes.winner?.mean_pair_confidence ?? 0).toFixed(3);
		lines.push(`Winner: ${winner}`);
		lines.push(`Winner confidence: ${confidence}`);
		const pairwise = compareRes.pairwise;
		if (pairwise.length) {
			const meanSwapConsistency = average(
				pairwise.map(entry =>
					average(
						entry.criteria.length
							? entry.criteria.map(criterion => Number(criterion.swap_consistency ?? 0))
							: [0],
					),
				),
			);
			lines.push(`Swap consistency: ${meanSwapConsistency.toFixed(3)}`);
		}
		const calibratedPairs = pairwise.filter(
			p =>
				p.calibrated_score_a !== undefined &&
				p.calibrated_score_a !== null &&
				p.calibrated_score_b !== undefined &&
				p.calibrated_score_b !== null,
		);
		if (calibratedPairs.length > 0) {
			for (const pair of calibratedPairs) {
				const marginStr =
					(pair.calibrated_margin ?? 0) >= 0
						? `+${(pair.calibrated_margin ?? 0).toFixed(3)}`
						: (pair.calibrated_margin ?? 0).toFixed(3);
				lines.push(
					`Calibrated pairwise (${pair.candidate_a} vs ${pair.candidate_b}): ${pair.candidate_a}=${pair.calibrated_score_a?.toFixed(3)}, ${pair.candidate_b}=${pair.calibrated_score_b?.toFixed(3)} (margin ${marginStr})`,
				);
			}
		}
		if (ranking.length) {
			lines.push(
				"Ranking: " +
					ranking
						.map(
							(item, index: number) =>
								`${index + 1}) ${item.id} (wins ${Number(item.wins ?? 0).toFixed(1)}, mean ${Number(item.mean_pair_score ?? 0).toFixed(3)}, confidence ${Number(item.mean_pair_confidence ?? 0).toFixed(3)})`,
						)
						.join("; "),
			);
		}
	} else {
		const auditRes = result as AuditRunResult;
		lines.push(`Candidate: ${auditRes.candidate?.id ?? "unknown"}`);
		lines.push(`Overall score: ${Number(auditRes.overall_score ?? 0).toFixed(3)}`);
		lines.push(`Overall confidence: ${Number(auditRes.overall_confidence ?? 0).toFixed(3)}`);
	}
	lines.push(`Estimated model calls: ${result.estimated_calls ?? 0}`);
	if (mock) lines.push("Mode: mock smoke test");
	if (savedOutputPath) lines.push(`Saved JSON: ${savedOutputPath}`);
	return lines;
};

interface VerifierRequestParams {
	backend?: Backend;
	mode?: "compare" | "audit";
	task: string;
	context?: string;
	groundTruthNote?: string;
	candidates: CandidateInput[];
	criteria: CriterionInput[];
	evidencePaths?: string[];
	nVerifications?: number;
	granularity?: number;
	model?: string;
	models?: string[];
	modelWeights?: ModelWeightInput[];
	calibrationPath?: string;
	outputPath?: string;
	maxCandidateChars?: number;
	maxEvidenceChars?: number;
	mock?: boolean;
}

export function isVerifierRequestParams(value: unknown): value is VerifierRequestParams {
	if (!value || typeof value !== "object") return false;
	if (!("task" in value) || typeof value.task !== "string") return false;
	const candidates = "candidates" in value ? value.candidates : undefined;
	if (!Array.isArray(candidates) || candidates.length === 0) return false;
	const criteria = "criteria" in value ? value.criteria : undefined;
	if (!Array.isArray(criteria) || criteria.length === 0) return false;
	for (const item of candidates) {
		if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") return false;
	}
	for (const item of criteria) {
		if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") return false;
	}
	return true;
}

export const runVerifierRequest = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: VerifierRequestParams,
	signal?: AbortSignal,
) => {
	const cwd = ctx.cwd;
	const backend = (params.backend ?? "pi-model-ensemble") as Backend;
	if (params.calibrationPath?.trim() && backend !== "gemini-python") {
		throw new Error("calibrationPath is only supported for backend gemini-python");
	}
	const mode = params.mode ?? (params.candidates.length === 1 ? "audit" : "compare");
	if (mode === "compare" && params.candidates.length < 2) {
		throw new Error("compare mode requires at least two candidates");
	}
	if (mode === "audit" && params.candidates.length !== 1) {
		throw new Error("audit mode requires exactly one candidate");
	}

	const maxCandidateChars = params.maxCandidateChars ?? 12000;
	const maxEvidenceChars = params.maxEvidenceChars ?? 6000;
	const sharedEvidence = await readEvidenceBlocks(cwd, params.evidencePaths, maxEvidenceChars);
	const sharedContextParts: string[] = [];
	if (params.context?.trim()) sharedContextParts.push(params.context.trim());
	if (sharedEvidence.length) {
		sharedContextParts.push(
			`Shared evidence:\n${sharedEvidence.map(item => `[${item.label}]\n${item.content}`).join("\n\n")}`,
		);
	}

	const candidates = await Promise.all(
		params.candidates.map(async (candidate, index) => {
			const base = await extractTextSource(
				cwd,
				`candidate ${candidate.id || index + 1}`,
				candidate,
				maxCandidateChars,
			);
			const evidenceBlocks = await readEvidenceBlocks(cwd, candidate.evidencePaths, maxEvidenceChars);
			if (candidate.evidenceText?.trim()) {
				const clipped = truncate(candidate.evidenceText.trim(), maxEvidenceChars);
				evidenceBlocks.push({
					label: `${candidate.id}-inline-evidence`,
					content: clipped.text,
					source: `${candidate.id}:inline-evidence`,
					truncated: clipped.truncated,
				});
			}

			return {
				id: candidate.id,
				summary: candidate.summary?.trim() || "",
				content: base.text,
				source: base.source,
				truncated: base.truncated,
				evidence: evidenceBlocks.map(item => ({ label: item.label, content: item.content })),
				evidenceSources: evidenceBlocks,
			} satisfies NormalizedCandidate;
		}),
	);

	const requestedModelSpecs =
		backend === "pi-model-ensemble"
			? (params.models ?? [params.model ?? DEFAULT_SUBAGENT_MODEL_SPEC])
			: [params.model ?? (backend === "zai-coding-plan" ? "zai:glm-5.1" : DEFAULT_GEMINI_PYTHON_MODEL_SPEC)];
	const resolvedModels = resolveVerifierModels(ctx, requestedModelSpecs);
	const resolvedWeights = resolveModelWeights(resolvedModels, params.modelWeights);

	const config: VerifierConfig = {
		mode,
		backend,
		task: params.task,
		context: sharedContextParts.join("\n\n"),
		groundTruthNote: params.groundTruthNote?.trim() || DEFAULT_GROUND_TRUTH_NOTE,
		criteria: params.criteria.map(criterion => ({
			id:
				criterion.id?.trim() ||
				criterion.name
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "") ||
				"criterion",
			name: criterion.name,
			description: criterion.description,
		})),
		candidates,
		nVerifications:
			params.nVerifications ?? (backend === "pi-model-ensemble" ? Math.max(5, resolvedModels.length) : 5),
		granularity: params.granularity ?? 20,
		mock: params.mock ?? false,
		models: resolvedModels,
		modelWeights: resolvedWeights,
	};
	const primaryModel = config.models[0];
	if (!primaryModel) {
		throw new Error("At least one verifier model must be resolved.");
	}

	let parsed: {
		ok: boolean;
		config: {
			mode: "compare" | "audit";
			backend: Backend;
			models: string[];
			modelWeights: ResolvedModelWeight[];
			granularity: number;
			n_verifications: number;
			criteria: Array<{ id: string; name: string }>;
			candidate_ids: string[];
			mock: boolean;
		};
		result: CompareRunResult | AuditRunResult;
		error?: string;
	};

	if (backend === "gemini-python") {
		const extensionRoot = path.join(import.meta.dir, "..");
		const skillScriptPath = path.join(extensionRoot, "skills", "llm-as-verifier", "scripts", "lav_runner.py");
		const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lav-"));
		const inputPath = path.join(tempDir, "input.json");
		const outputTempPath = path.join(tempDir, "output.json");
		try {
			const runnerInput = {
				mode: config.mode,
				task: config.task,
				context: config.context,
				criteria: config.criteria,
				candidates: config.candidates.map(candidate => ({
					id: candidate.id,
					summary: candidate.summary,
					content: candidate.content,
					evidence: candidate.evidence,
				})),
				n_verifications: config.nVerifications,
				granularity: config.granularity,
				model: modelForPythonRunner(primaryModel),
				mock: config.mock,
				ground_truth_note: config.groundTruthNote,
				calibration_path: params.calibrationPath,
			};
			await Bun.write(inputPath, JSON.stringify(runnerInput, null, 2));
			await runPython(
				pi,
				skillScriptPath,
				["--input", inputPath, "--output", outputTempPath, ...(config.mock ? ["--mock"] : [])],
				signal,
			);
			const content = await Bun.file(outputTempPath).text();
			parsed = JSON.parse(content) as typeof parsed;
		} finally {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
		if (!parsed?.ok) {
			throw new Error(parsed?.error || "Verifier runner failed");
		}
	} else {
		const result =
			mode === "compare" ? await runPiCompare(ctx, signal, config) : await runPiAudit(ctx, signal, config);
		parsed = {
			ok: true,
			config: {
				mode: config.mode,
				backend: config.backend,
				models: config.models.map(model => model.display),
				modelWeights: config.modelWeights,
				granularity: config.granularity,
				n_verifications: config.nVerifications,
				criteria: config.criteria.map(criterion => ({ id: criterion.id, name: criterion.name })),
				candidate_ids: config.candidates.map(candidate => candidate.id),
				mock: config.mock,
			},
			result,
		};
	}

	let savedOutputPath: string | undefined;
	if (params.outputPath) {
		savedOutputPath = resolveUserPath(cwd, params.outputPath);
		await Bun.write(savedOutputPath, JSON.stringify(parsed, null, 2));
	}

	const candidateNotes = candidates.map(candidate => ({
		id: candidate.id,
		source: candidate.source,
		truncated: candidate.truncated,
		evidenceSources: candidate.evidenceSources.map(item => ({
			label: item.label,
			source: item.source,
			truncated: item.truncated,
		})),
	}));

	const summaryLines = buildSummaryLines(
		config.mode,
		config.backend,
		config.models,
		config.modelWeights,
		parsed.result,
		config.mock,
		savedOutputPath,
	);

	return {
		backend: config.backend,
		mode: config.mode,
		parsed,
		savedOutputPath,
		candidateNotes,
		resolvedModels: config.models.map(model => ({
			spec: model.spec,
			provider: model.provider,
			id: model.id,
			display: model.display,
		})),
		resolvedModelWeights: config.modelWeights,
		sharedEvidenceSources: sharedEvidence.map(item => ({
			label: item.label,
			source: item.source,
			truncated: item.truncated,
		})),
		summaryLines,
	};
};

export default function verifierExtension(pi: ExtensionAPI): void {
	pi.setLabel("LLM as Verifier");

	const typebox = pi.typebox;

	pi.registerTool({
		name: ORCHESTRATOR_TOOL_NAME,
		label: "Subagent Orchestrator Plan",
		description:
			"Compute a deterministic Oh My Pi subagent route plan from request complexity, risk, evidence needs, and a specialist pool.",
		parameters: typebox.Type.Object({
			request: typebox.Type.String({ description: "User request or subproblem to route." }),
			complexity: typebox.Type.Optional(
				typebox.Type.Union([
					typebox.Type.Literal("single-step"),
					typebox.Type.Literal("multi-step"),
					typebox.Type.Literal("open-ended"),
				]),
			),
			risk: typebox.Type.Optional(
				typebox.Type.Union([
					typebox.Type.Literal("low"),
					typebox.Type.Literal("med"),
					typebox.Type.Literal("high"),
				]),
			),
			evidenceNeed: typebox.Type.Optional(
				typebox.Type.Union([
					typebox.Type.Literal("current-context"),
					typebox.Type.Literal("tool-retrieval"),
					typebox.Type.Literal("multi-source"),
				]),
			),
			decomposability: typebox.Type.Optional(
				typebox.Type.Union([
					typebox.Type.Literal("independent"),
					typebox.Type.Literal("sequential"),
					typebox.Type.Literal("not-decomposable"),
				]),
			),
			dataSensitivity: typebox.Type.Optional(
				typebox.Type.Union([
					typebox.Type.Literal("public"),
					typebox.Type.Literal("internal"),
					typebox.Type.Literal("confidential"),
					typebox.Type.Literal("unknown"),
				]),
			),
			recursiveAllowed: typebox.Type.Optional(typebox.Type.Boolean()),
			specialists: typebox.Type.Optional(
				typebox.Type.Array(
					typebox.Type.Object({
						name: typebox.Type.String({ description: "Stable subagent name." }),
						scope: typebox.Type.String({ description: "Owned domain or trained scope." }),
						costTier: typebox.Type.Union([
							typebox.Type.Literal("low"),
							typebox.Type.Literal("med"),
							typebox.Type.Literal("high"),
						]),
						role: typebox.Type.Optional(
							typebox.Type.Union([
								typebox.Type.Literal("specialist"),
								typebox.Type.Literal("generalist"),
								typebox.Type.Literal("verifier"),
							]),
						),
						modelFamily: typebox.Type.Optional(typebox.Type.String()),
						capabilities: typebox.Type.Optional(typebox.Type.Array(typebox.Type.String())),
						trustScore: typebox.Type.Optional(typebox.Type.Number({ minimum: 0, maximum: 1 })),
					}),
					{ maxItems: 20 },
				),
			),
		}) as TSchema,
		async execute(_toolCallId, params) {
			const plan = planSubagentOrchestration(params as OrchestratorPlanParams);
			return {
				content: [
					{
						type: "text",
						text: [
							`mode=${plan.mode}`,
							`routing=${plan.routing}`,
							`subagents=${plan.subagents.length ? plan.subagents.join(", ") : "none"}`,
							`verification=${plan.verification}`,
							`verifier=${plan.verifier ?? "none"}`,
							`limits=depth ${plan.maxDepth}, fanout ${plan.maxFanout}, child calls ${plan.childCallLimit}`,
						].join("\n"),
					},
				],
				details: plan,
			};
		},
	});

	pi.registerTool({
		name: VERIFIER_TOOL_NAME,
		label: "LLM as Verifier",
		description:
			"Compare or audit candidate artifacts with repeated, criteria-decomposed LLM verification inspired by the llm-as-verifier paper.",
		parameters: typebox.Type.Object({
			backend: typebox.Type.Optional(
				typebox.Type.Union(
					[
						typebox.Type.Literal("gemini-python"),
						typebox.Type.Literal("zai-coding-plan"),
						typebox.Type.Literal("pi-model-ensemble"),
					],
					{
						description:
							"Execution backend. Defaults to pi-model-ensemble with the settings-backed pi/task subagent model.",
					},
				),
			),
			mode: typebox.Type.Optional(
				typebox.Type.Union([typebox.Type.Literal("compare"), typebox.Type.Literal("audit")]),
			),
			task: typebox.Type.String({
				description: "Task, requirement, or question the verifier should judge against.",
			}),
			context: typebox.Type.Optional(
				typebox.Type.String({ description: "Shared background context or evidence summary." }),
			),
			groundTruthNote: typebox.Type.Optional(
				typebox.Type.String({
					description:
						"Instruction to the verifier about what kinds of evidence to prefer (e.g. test output over narration).",
				}),
			),
			candidates: typebox.Type.Array(
				typebox.Type.Object({
					id: typebox.Type.String({ description: "Stable candidate identifier." }),
					path: typebox.Type.Optional(
						typebox.Type.String({ description: "Relative or absolute path to a text file for this candidate." }),
					),
					content: typebox.Type.Optional(
						typebox.Type.String({ description: "Inline candidate content when no file path is used." }),
					),
					summary: typebox.Type.Optional(
						typebox.Type.String({ description: "Short candidate summary, e.g. patch strategy or model name." }),
					),
					evidencePaths: typebox.Type.Optional(
						typebox.Type.Array(
							typebox.Type.String({ description: "Text files containing candidate-specific evidence." }),
						),
					),
					evidenceText: typebox.Type.Optional(
						typebox.Type.String({ description: "Inline candidate-specific evidence." }),
					),
				}),
				{ minItems: 1, maxItems: 6 },
			),
			criteria: typebox.Type.Array(
				typebox.Type.Object({
					id: typebox.Type.Optional(typebox.Type.String()),
					name: typebox.Type.String(),
					description: typebox.Type.String(),
				}),
				{ minItems: 1, maxItems: 6 },
			),
			evidencePaths: typebox.Type.Optional(
				typebox.Type.Array(typebox.Type.String({ description: "Shared evidence files for all candidates." })),
			),
			nVerifications: typebox.Type.Optional(typebox.Type.Integer({ minimum: 1, maximum: 9 })),
			granularity: typebox.Type.Optional(typebox.Type.Integer({ minimum: 20, maximum: 20 })),
			model: typebox.Type.Optional(
				typebox.Type.String({
					description:
						"Single verifier model. Defaults to zai:glm-5.1 for zai-coding-plan and the settings-backed pi/task subagent model for gemini-python.",
				}),
			),
			models: typebox.Type.Optional(
				typebox.Type.Array(
					typebox.Type.String({
						description:
							"Verifier model specs for pi-model-ensemble, using provider:id or known aliases like kimi-for-coding, kimi-k2, minimax-m3, minimax-m2.7-highspeed, gpt-5.5, or gpt-5-codex.",
					}),
					{ minItems: 1, maxItems: 9 },
				),
			),
			modelWeights: typebox.Type.Optional(
				typebox.Type.Array(
					typebox.Type.Object({
						model: typebox.Type.String({ description: "Model spec or display name to weight." }),
						weight: typebox.Type.Number({
							minimum: 0,
							description: "Relative weight for that model in aggregation.",
						}),
					}),
					{ minItems: 1, maxItems: 9 },
				),
			),
			calibrationPath: typebox.Type.Optional(
				typebox.Type.String({
					description:
						"Optional path to a fitted verifier_calibration.json registry for gemini-python only. Calibrated scores apply only when model, nVerifications, default or explicit ground-truth note, criteria digest, and scorer id match the fit.",
				}),
			),
			outputPath: typebox.Type.Optional(
				typebox.Type.String({ description: "Optional path to save the full JSON result." }),
			),
			maxCandidateChars: typebox.Type.Optional(typebox.Type.Integer({ minimum: 1000, maximum: 40000 })),
			maxEvidenceChars: typebox.Type.Optional(typebox.Type.Integer({ minimum: 500, maximum: 20000 })),
			mock: typebox.Type.Optional(
				typebox.Type.Boolean({ description: "Use deterministic mock scoring for smoke tests only." }),
			),
		}) as TSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const typedParams = params as VerifierRequestParams;
			const run = await runVerifierRequest(pi, ctx, typedParams, signal);
			return {
				content: [{ type: "text", text: run.summaryLines.join("\n") }],
				details: {
					...run.parsed,
					savedOutputPath: run.savedOutputPath,
					candidateNotes: run.candidateNotes,
					resolvedModels: run.resolvedModels,
					resolvedModelWeights: run.resolvedModelWeights,
					sharedEvidenceSources: run.sharedEvidenceSources,
				},
			};
		},
	});

	pi.registerCommand("lav-smoke", {
		description: "Run the bundled llm-as-verifier Python example in deterministic mock mode",
		handler: async (_args, ctx) => {
			const extensionRoot = path.join(import.meta.dir, "..");
			const scriptPath = path.join(extensionRoot, "skills", "llm-as-verifier", "scripts", "lav_runner.py");
			const examplePath = path.join(
				extensionRoot,
				"skills",
				"llm-as-verifier",
				"examples",
				"code-patch-selection.json",
			);
			const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lav-smoke-"));
			const outputPath = path.join(tempDir, "result.json");
			try {
				const result = await runPython(pi, scriptPath, ["--input", examplePath, "--output", outputPath, "--mock"]);
				const file = Bun.file(outputPath);
				const content = await file.text();
				const parsed = JSON.parse(content) as { result?: { winner?: { id?: string } } };
				const winner = parsed.result?.winner?.id ?? "tie";
				const message = `LLM-as-Verifier smoke test complete. Winner: ${winner}. Output: ${outputPath}`;
				if (ctx.hasUI) ctx.ui.notify(message, "info");
				else pi.logger.info(message);
				if (result.stderr?.trim() && ctx.hasUI) ctx.ui.notify(result.stderr.trim(), "info");
			} finally {
				// Keep temp output for inspection when smoke command is used.
			}
		},
	});
	pi.registerCommand("lav-ensemble-smoke", {
		description: "Run the bundled weighted ensemble example in deterministic mock mode",
		handler: async (_args, ctx) => {
			const extensionRoot = path.join(import.meta.dir, "..");
			const examplePath = path.join(
				extensionRoot,
				"skills",
				"llm-as-verifier",
				"examples",
				"weighted-ensemble-selection.json",
			);
			const file = Bun.file(examplePath);
			const content = await file.text();
			const parsedExample = JSON.parse(content);
			if (!isVerifierRequestParams(parsedExample)) {
				throw new Error(`Invalid example file: ${examplePath}`);
			}
			const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lav-ensemble-smoke-"));
			const outputPath = path.join(tempDir, "result.json");
			const run = await runVerifierRequest(pi, ctx, {
				...parsedExample,
				mock: true,
				outputPath,
			});
			const result = run.parsed?.result;
			const winner = result && "winner" in result && result.winner ? result.winner.id : "tie";
			const weightSummary = run.resolvedModelWeights.map(entry => `${entry.model}=${entry.weight}`).join(", ");
			const message = `LLM-as-Verifier ensemble smoke test complete. Winner: ${winner}. Weights: ${weightSummary}. Output: ${run.savedOutputPath}`;
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else pi.logger.info(message);
		},
	});
}
