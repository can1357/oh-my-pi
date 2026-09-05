/**
 * Deterministic context intelligence for OMP Ultra.
 *
 * This module ranks the Agent's existing in-memory messages. It never performs
 * repository I/O and never asks an LLM to select context. The runtime applies
 * the result as a non-destructive model-visible projection before conversion.
 */

import type { AgentMessage } from "./types";
import type { TaskComplexity } from "./task-router";

export type ContextCandidateType =
	| "file"
	| "symbol"
	| "code"
	| "test"
	| "diagnostic"
	| "tool_result"
	| "repository_fact"
	| "configuration"
	| "previous_failure"
	| "architectural_decision"
	| "message";

export interface ContextCandidate {
	id: string;
	source: string;
	location?: string;
	content: string;
	type: ContextCandidateType;
	relevance: number;
	confidence: number;
	freshness: number;
	dependencyDistance: number;
	taskRelation: number;
	tokenCost: number;
	priority: number;
	stale: boolean;
	duplicateOf?: string;
}

export interface ContextBudgetOptions {
	budgetTokens?: number;
	contextWindowTokens?: number;
	complexity: TaskComplexity;
	recentMessageCount?: number;
}

export interface ContextIntelligenceTelemetry {
	complexity: TaskComplexity;
	candidateCount: number;
	selectedContextCount: number;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
	contextBudget: number;
	deduplicatedCandidates: number;
	discardedCandidates: number;
	staleCandidates: number;
	topRankedSources: string[];
	assemblyLatencyMs: number;
	budgetRespected: boolean;
}

export interface ContextAssemblyResult {
	messages: AgentMessage[];
	candidates: ContextCandidate[];
	telemetry: ContextIntelligenceTelemetry;
}

export interface TokenCounter {
	countMessage(message: AgentMessage): number;
}

const FILE_RE = /(?:^|[\s"'`(])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|sql|css|scss|less|md|json|yaml|yml|toml|ini|cfg|sh|ps1))(?![\w.-])/gi;
const SIMPLE_FILE_RE = /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|sql|css|scss|less|md|json|yaml|yml|toml|ini|cfg|sh|ps1)\b/gi;
const SYMBOL_RE = /`([A-Za-z_$][\w$]*(?:\([^`]*\))?)`|\b([A-Z][A-Za-z0-9_$]{2,})\b|\b([a-z_$][A-Za-z0-9_$]{2,})\(\)/g;
const ERROR_RE = /\b(error|failed|failure|exception|traceback|stack trace|typecheck|compile|lint|crash|assertion|expected .* received)\b/i;
const TEST_RE = /\b(test|tests|spec|specs|coverage)\b/i;
const CONFIG_RE = /(^|[./_-])(config|settings?|env|package\.json|tsconfig|vite|webpack|rollup|cargo|pyproject|gradle|pom)([./_-]|$)/i;
const ARCH_RE = /\b(architecture|design|boundary|interface|contract|persistence|authentication|authorization|data layer|service layer|dependency)\b/i;
const STOPWORDS = new Set([
	"the", "and", "for", "with", "this", "that", "from", "into", "then", "when", "where", "what", "how",
	"fix", "add", "change", "update", "make", "please", "current", "should", "would", "could", "want",
]);

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (!block || typeof block !== "object") return "";
			const value = block as { type?: string; text?: unknown; thinking?: unknown; data?: unknown; block?: unknown };
			if (value.type === "text") return String(value.text ?? "");
			if (value.type === "thinking") return String(value.thinking ?? "");
			if (value.type === "redactedThinking") return "[redacted thinking]";
			if (value.type === "image") return "[image]";
			if (value.data !== undefined) return String(value.data);
			return value.block === undefined ? "" : String(value.block);
		})
		.join(" ");
}

function messageText(message: AgentMessage): string {
	const value = message as unknown as Record<string, unknown>;
	const content = textOfContent(value.content);
	const toolCalls = Array.isArray(value.toolCalls)
		? value.toolCalls.map(call => {
			if (!call || typeof call !== "object") return "";
			const item = call as Record<string, unknown>;
			return `${String(item.name ?? "")} ${JSON.stringify(item.arguments ?? {})}`;
		}).join(" ")
		: "";
	return `${content} ${toolCalls}`.trim();
}

function normalizeTerm(term: string): string {
	return term.toLowerCase().replace(/[^a-z0-9_$./-]+/g, "");
}

function taskTerms(task: string): string[] {
	return [...new Set(task
		.toLowerCase()
		.replace(/[^a-z0-9_$./-]+/g, " ")
		.split(/\s+/)
		.filter(term => term.length >= 3 && !STOPWORDS.has(term)))];
}

function extractMentions(task: string): { files: string[]; symbols: string[] } {
	const files = new Set<string>();
	for (const match of task.matchAll(FILE_RE)) files.add(match[1]);
	for (const match of task.matchAll(SIMPLE_FILE_RE)) files.add(match[0]);
	const symbols = new Set<string>();
	for (const match of task.matchAll(SYMBOL_RE)) symbols.add(match[1] ?? match[2] ?? match[3]);
	return { files: [...files], symbols: [...symbols] };
}

function pathOf(message: AgentMessage): string | undefined {
	const value = message as unknown as Record<string, unknown>;
	for (const key of ["path", "filePath", "file", "source", "location"]) {
		const candidate = value[key];
		if (typeof candidate === "string" && /[\\/]/.test(candidate)) return candidate;
	}
	return extractMentions(messageText(message)).files[0];
}

function toolNameOf(message: AgentMessage): string | undefined {
	const value = message as unknown as Record<string, unknown>;
	return typeof value.toolName === "string" ? value.toolName : undefined;
}

function isToolResult(message: AgentMessage): boolean {
	return message.role === "toolResult";
}

function isFailure(message: AgentMessage): boolean {
	const value = message as unknown as Record<string, unknown>;
	return value.isError === true || ERROR_RE.test(messageText(message));
}

function isTest(message: AgentMessage): boolean {
	const location = pathOf(message) ?? "";
	return TEST_RE.test(toolNameOf(message) ?? "") || /(?:^|[._/\\-])(test|spec)(?:[._/\\-]|$)/i.test(location) || TEST_RE.test(messageText(message));
}

function isConfig(message: AgentMessage): boolean {
	return CONFIG_RE.test(pathOf(message) ?? "") || CONFIG_RE.test(toolNameOf(message) ?? "");
}

function isArchitecture(message: AgentMessage): boolean {
	return ARCH_RE.test(messageText(message)) || (isConfig(message) && ARCH_RE.test(pathOf(message) ?? ""));
}

function timestampOf(message: AgentMessage, index: number, total: number): number {
	const timestamp = (message as { timestamp?: unknown }).timestamp;
	if (typeof timestamp === "number" && timestamp > 0) return Math.min(1, timestamp / Math.max(Date.now(), timestamp));
	return total <= 1 ? 1 : index / (total - 1);
}

function overlapScore(taskTokens: readonly string[], text: string): number {
	if (taskTokens.length === 0) return 0;
	const lower = text.toLowerCase();
	const haystack = new Set(text.split(/\s+/).map(normalizeTerm).filter(Boolean));
	let hits = 0;
	for (const token of taskTokens) {
		if (haystack.has(token)) hits++;
		else if (lower.includes(token)) hits += 0.5;
	}
	return Math.min(1, hits / Math.min(taskTokens.length, 8));
}

function directScore(candidateText: string, location: string | undefined, mentions: { files: string[]; symbols: string[] }): number {
	const lower = candidateText.toLowerCase();
	let score = 0;
	for (const file of mentions.files) {
		if (location?.toLowerCase() === file.toLowerCase()) score = Math.max(score, 1);
		else if (location && location.toLowerCase().endsWith(file.toLowerCase())) score = Math.max(score, 0.94);
		else if (lower.includes(file.toLowerCase())) score = Math.max(score, 0.84);
	}
	for (const symbol of mentions.symbols) {
		if (lower.includes(symbol.toLowerCase())) score = Math.max(score, 0.9);
	}
	return score;
}

function dependencyDistance(location: string | undefined, mentions: { files: string[] }): number {
	if (!location) return 4;
	const normalized = location.replace(/\\/g, "/").toLowerCase();
	for (const file of mentions.files) {
		const target = file.replace(/\\/g, "/").toLowerCase();
		if (normalized === target || normalized.endsWith(`/${target}`)) return 0;
		if (normalized.endsWith(target.replace(/\.[^.]+$/, ""))) return 1;
		const targetDir = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
		if (targetDir && normalized.includes(`/${targetDir}/`)) return 2;
	}
	return 3;
}

function candidateType(message: AgentMessage, location: string | undefined): ContextCandidateType {
	if (isFailure(message)) return isToolResult(message) ? "previous_failure" : "diagnostic";
	if (isTest(message)) return "test";
	if (isConfig(message)) return "configuration";
	if (isArchitecture(message)) return "architectural_decision";
	if (isToolResult(message)) return "tool_result";
	if (location) return "file";
	return "message";
}

function defaultBudget(complexity: TaskComplexity, contextWindowTokens: number | undefined): number {
	const ratios: Record<TaskComplexity, number> = { SIMPLE: 0.12, NORMAL: 0.2, COMPLEX: 0.32, VERY_COMPLEX: 0.46 };
	if (contextWindowTokens !== undefined && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
		return Math.max(2048, Math.floor(contextWindowTokens * ratios[complexity]));
	}
	return complexity === "SIMPLE" ? 4096 : complexity === "NORMAL" ? 8192 : complexity === "COMPLEX" ? 16384 : 24576;
}

function cloneWithContent(message: AgentMessage, content: unknown): AgentMessage {
	return { ...(message as object), content } as AgentMessage;
}

function compactText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.ceil(maxChars * 0.62);
	const tail = Math.max(0, maxChars - head);
	return `${text.slice(0, head)}\n...[Context Intelligence truncated middle]...\n${tail > 0 ? text.slice(-tail) : ""}`;
}

function compactContent(message: AgentMessage, maxChars: number): AgentMessage {
	const text = compactText(textOfContent((message as unknown as { content?: unknown }).content), maxChars);
	const suffix = isFailure(message) ? "\n[Failure evidence preserved]" : "";
	return cloneWithContent(message, [{ type: "text", text: `${text}${suffix}` }]);
}

function isChangedDuplicate(previous: ContextCandidate, current: ContextCandidate): boolean {
	return Boolean(previous.location && current.location && previous.location.toLowerCase() === current.location.toLowerCase() && previous.content !== current.content);
}

function rankCandidate(candidate: ContextCandidate): number {
	return (
		candidate.relevance * 4.2 +
		candidate.taskRelation * 3.1 +
		candidate.confidence * 1.6 +
		candidate.freshness * 1.8 +
		Math.max(0, 3 - candidate.dependencyDistance) * 1.2 -
		Math.min(2, candidate.tokenCost / 12000)
	);
}

export function rankContextCandidates(task: string, messages: readonly AgentMessage[], tokenizer: TokenCounter): ContextCandidate[] {
	const mentions = extractMentions(task);
	const terms = taskTerms(task);
	const candidates: ContextCandidate[] = [];
	const last = Math.max(0, messages.length - 1);

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const content = messageText(message);
		if (!content && !pathOf(message)) continue;
		const location = pathOf(message);
		const direct = directScore(content, location, mentions);
		const semantic = overlapScore(terms, `${location ?? ""} ${content}`);
		const freshness = timestampOf(message, index, messages.length);
		const recentBoost = last === 0 ? 1 : index / last;
		const dependency = dependencyDistance(location, mentions);
		const relation = Math.max(direct, semantic);
		const type = candidateType(message, location);
		const failureBoost = isFailure(message) ? 0.25 : 0;
		const testBoost = isTest(message) ? 0.12 : 0;
		const activeBoost = index >= Math.max(0, messages.length - 6) ? 0.15 * recentBoost : 0;
		const confidence = Math.min(1, 0.52 + direct * 0.3 + semantic * 0.18);
		const candidate: ContextCandidate = {
			id: `m${index}`,
			source: toolNameOf(message) ?? String(message.role),
			location,
			content,
			type,
			relevance: Math.min(1, direct + semantic * 0.45 + failureBoost + testBoost + activeBoost),
			confidence,
			freshness,
			dependencyDistance: dependency,
			taskRelation: relation,
			tokenCost: tokenizer.countMessage(message),
			priority: 0,
			stale: false,
		};
		candidate.priority = rankCandidate(candidate);
		candidates.push(candidate);
	}

	const newestByKey = new Map<string, ContextCandidate>();
	for (const candidate of candidates) {
		const key = candidate.location ? `loc:${candidate.location.toLowerCase()}` : `content:${fingerprintFromCandidate(candidate)}`;
		const previous = newestByKey.get(key);
		if (!previous) {
			newestByKey.set(key, candidate);
			continue;
		}
		if (candidate.content === previous.content) {
			candidate.duplicateOf = previous.id;
			candidate.priority = -1;
			continue;
		}
		if (isChangedDuplicate(previous, candidate)) {
			previous.stale = true;
			candidate.priority += 1.6;
			newestByKey.set(key, candidate);
		}
	}

	const contentOwner = new Map<string, ContextCandidate>();
	for (const candidate of candidates) {
		const key = `${candidate.type}|${candidate.content.replace(/\s+/g, " ").trim()}`;
		const previous = contentOwner.get(key);
		if (!previous) contentOwner.set(key, candidate);
		else if (candidate.priority >= 0) {
			candidate.duplicateOf = previous.id;
			candidate.priority = -1;
		}
	}

	return candidates.sort((a, b) => b.priority - a.priority);
}

function fingerprintFromCandidate(candidate: ContextCandidate): string {
	return `${candidate.source}|${candidate.type}|${candidate.content.replace(/\s+/g, " ").trim()}`;
}

function budgetedToolResultTokens(messages: readonly AgentMessage[], tokenizer: TokenCounter): number {
	let total = 0;
	for (const message of messages) if (isToolResult(message)) total += tokenizer.countMessage(message);
	return total;
}

/**
 * Assemble a model-visible context projection. Persisted history is never mutated.
 * Tool calls/results remain paired; low-value historical result content is compacted
 * in a cloned message while failures, active context, and high-value evidence survive.
 */
export function assembleContext(
	task: string,
	messages: readonly AgentMessage[],
	tokenizer: TokenCounter,
	options: ContextBudgetOptions,
): ContextAssemblyResult {
	const started = performance.now();
	const budget = Math.max(512, Math.floor(options.budgetTokens ?? defaultBudget(options.complexity, options.contextWindowTokens)));
	const recentCount = Math.max(3, options.recentMessageCount ?? (options.complexity === "SIMPLE" ? 4 : options.complexity === "NORMAL" ? 6 : options.complexity === "COMPLEX" ? 10 : 14));
	const original = [...messages];
	const candidates = rankContextCandidates(task, original, tokenizer);
	const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
	const result = original.map(message => ({ ...(message as object) } as AgentMessage));
	let deduplicatedCandidates = 0;
	let staleCandidates = 0;
	let discardedCandidates = 0;

	for (const candidate of candidates) {
		if (candidate.duplicateOf) {
			deduplicatedCandidates++;
			const message = result[Number(candidate.id.slice(1))];
			if (message && isToolResult(message)) result[Number(candidate.id.slice(1))] = compactContent(message, 240);
		}
		if (candidate.stale) {
			staleCandidates++;
			const message = result[Number(candidate.id.slice(1))];
			if (message && isToolResult(message)) result[Number(candidate.id.slice(1))] = compactContent(message, 360);
		}
	}

	let managedTokens = budgetedToolResultTokens(result, tokenizer);
	if (managedTokens > budget) {
		const toolCandidates = candidates
			.filter(candidate => byId.has(candidate.id) && candidate.tokenCost > 0 && candidate.priority >= 0)
			.filter(candidate => !candidate.duplicateOf)
			.sort((a, b) => a.priority - b.priority);

		for (const candidate of toolCandidates) {
			if (managedTokens <= budget) break;
			const index = Number(candidate.id.slice(1));
			if (index < messages.length - recentCount) {
				const message = result[index];
				if (!message || !isToolResult(message)) continue;
				const currentTokens = tokenizer.countMessage(message);
				const keepChars = isFailure(message) ? 3600 : candidate.priority > 5 ? 2400 : 1200;
				const compacted = compactContent(message, keepChars);
				const nextTokens = tokenizer.countMessage(compacted);
				result[index] = compacted;
				managedTokens -= Math.max(0, currentTokens - nextTokens);
				if (nextTokens < currentTokens) discardedCandidates++;
			}
		}
	}

	if (managedTokens > budget) {
		for (let i = 0; i < result.length && managedTokens > budget; i++) {
			const message = result[i];
			if (!message || !isToolResult(message) || i >= result.length - recentCount) continue;
			const currentTokens = tokenizer.countMessage(message);
			const keepChars = isFailure(message) ? 1400 : 480;
			const compacted = compactContent(message, keepChars);
			const nextTokens = tokenizer.countMessage(compacted);
			result[i] = compacted;
			managedTokens -= Math.max(0, currentTokens - nextTokens);
			if (nextTokens < currentTokens) discardedCandidates++;
		}
	}

	const estimatedTokensBefore = budgetedToolResultTokens(original, tokenizer);
	const estimatedTokensAfter = budgetedToolResultTokens(result, tokenizer);
	const selectedContextCount = candidates.filter(candidate => candidate.priority >= 0 && !candidate.duplicateOf && !candidate.stale).length;
	const telemetry: ContextIntelligenceTelemetry = {
		complexity: options.complexity,
		candidateCount: candidates.length,
		selectedContextCount,
		estimatedTokensBefore,
		estimatedTokensAfter,
		contextBudget: budget,
		deduplicatedCandidates,
		discardedCandidates,
		staleCandidates,
		topRankedSources: candidates.filter(candidate => candidate.priority >= 0).slice(0, 8).map(candidate => candidate.location ?? candidate.source),
		assemblyLatencyMs: performance.now() - started,
		budgetRespected: estimatedTokensAfter <= budget || estimatedTokensBefore === 0,
	};
	return { messages: result, candidates, telemetry };
}

export function contextBudgetForComplexity(complexity: TaskComplexity, contextWindowTokens?: number): number {
	return defaultBudget(complexity, contextWindowTokens);
}
