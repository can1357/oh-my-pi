/*
 * The state fitting and token estimation in this file are adapted from
 * tamaratran/fast-jev-compaction at e3f262a7f4d42bd8dd32ced30d26176f7cb545b0.
 *
 * MIT License
 *
 * Copyright (c) 2025
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { AgentMessage, AgentToolCall } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_PRUNE_CONFIG } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import {
	isArtifactRecoveryToolResult,
	isProtectedToolResult,
} from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { Tokenizer } from "@oh-my-pi/pi-agent-core/tokenizer";
import { type Judge, type NoulQuestion, TYPESAFE_PROVIDER, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { usesTypeSafeJudge } from "../judgment";
import keepCallQuestionTemplate from "../prompts/compaction/jev-keep-call.md" with { type: "text" };
import keepResultQuestionTemplate from "../prompts/compaction/jev-keep-result.md" with { type: "text" };
import stateContextTemplate from "../prompts/compaction/jev-state-context.md" with { type: "text" };
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "./session-entries";

export interface JevCandidate {
	id: string;
	callEntry: SessionMessageEntry;
	resultEntry: SessionMessageEntry;
	call: AgentToolCall;
	result: ToolResultMessage;
	callIndex: number;
	resultIndex: number;
}

export interface JevDecision {
	id: string;
	action: "keep" | "truncate_result" | "drop_pair";
}

export interface CollectJevCandidatesOptions {
	/** Active session branch, in journal order. */
	entries: readonly SessionEntry[];
	/** Every journal entry, used only to detect conversation forks off the active branch. */
	allEntries: readonly SessionEntry[];
	/** Current projected model context. Native blocks are matched by object identity. */
	messages: readonly AgentMessage[];
	tokenizer: Tokenizer;
	/** Recent tool-output window. Defaults to the ordinary prune policy. */
	protectTokens?: number;
	/** Additional protection supplied by the active-plan owner. */
	isProtected?: (result: ToolResultMessage, call: AgentToolCall) => boolean;
}

interface NativePair {
	callEntry: SessionMessageEntry;
	resultEntry: SessionMessageEntry;
	call: AgentToolCall;
	result: ToolResultMessage;
	callEntryIndex: number;
	resultEntryIndex: number;
	callIndex: number;
	resultIndex: number;
}

interface ScoringToolCall {
	id: string;
	tool: string;
	input: Record<string, unknown>;
	callIndex: number;
	resultIndex: number;
	resultChars: number;
	isError: boolean;
}

type MessageNarrative = { role: "user" | "assistant"; text: string };

/** Shape-preserving provider-bound transform for the minimal values Jev may serialize. */
export type JevScoringValueTransform = <T extends Record<string, unknown>>(value: T) => T;

type HistoryToolCall = {
	id: string;
	tool: string;
	input: string;
	result: string;
};

type HistoryEntry = {
	i: number;
	role: "user" | "assistant";
	text: string;
	tool_calls?: HistoryToolCall[] | string[];
};

export type JevCompactionState = {
	context: string;
	goal: string;
	history: HistoryEntry[];
};

export interface FittedJevState {
	state: JevCompactionState;
	tokens: number;
	stage: string;
}

const PRESERVE_RECENT_MESSAGES = 6;
const MAX_STATE_TOKENS = 25_000;
const MAX_REQUEST_TOKENS = 30_000;
const KEEP_THRESHOLD = 0.5;
const REQUEST_OVERHEAD_TOKENS = 20;
const MAX_CONCURRENT_BATCHES = 2;

/** Successive caps on the serialized tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;
const STATE_CONTEXT = stateContextTemplate.trim();

/**
 * Returns why the booster cannot run. Missing configured credentials takes
 * precedence over an LLM-only judgment setting so the UI gives one stable fix.
 */
export function getJevBoosterUnavailableReason(settings: Settings, registry?: ModelRegistry): string | undefined {
	if (!registry?.authStorage.hasAuth(TYPESAFE_PROVIDER)) {
		return "Connect TypeSafe with /login typesafe to enable";
	}
	if (!usesTypeSafeJudge(settings, registry)) {
		return "Set Judgment Provider to Auto or TypeSafe to enable";
	}
	return undefined;
}

function isConversationEntry(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
		case "custom_message":
		case "branch_summary":
		case "compaction":
		case "reset_boundary":
			return true;
		default:
			return false;
	}
}

/** Latest active-path index with another branch that eventually carries conversation content. */
function latestConversationForkIndex(entries: readonly SessionEntry[], allEntries: readonly SessionEntry[]): number {
	const children = new Map<string, SessionEntry[]>();
	for (const entry of allEntries) {
		if (entry.parentId === null) continue;
		const bucket = children.get(entry.parentId);
		if (bucket) bucket.push(entry);
		else children.set(entry.parentId, [entry]);
	}

	const subtreeHasConversation = (root: SessionEntry): boolean => {
		const pending = [root];
		const seen = new Set<string>();
		while (pending.length > 0) {
			const entry = pending.pop()!;
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			if (isConversationEntry(entry)) return true;
			pending.push(...(children.get(entry.id) ?? []));
		}
		return false;
	};

	let latest = -1;
	for (let index = 0; index < entries.length; index++) {
		const activeChildId = entries[index + 1]?.id;
		const hasConversationSibling = (children.get(entries[index]!.id) ?? []).some(
			child => child.id !== activeChildId && subtreeHasConversation(child),
		);
		if (hasConversationSibling) latest = index;
	}
	return latest;
}

function activeMaterializedStart(entries: readonly SessionEntry[]): number {
	let resetIndex = -1;
	let compactionIndex = -1;
	let compaction: CompactionEntry | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.type === "reset_boundary") resetIndex = index;
		if (entry.type === "compaction") {
			compactionIndex = index;
			compaction = entry;
		}
	}
	if (!compaction || compactionIndex < resetIndex) return resetIndex + 1;

	let start = resetIndex + 1;
	const firstKeptIndex = entries.findIndex(
		(entry, index) => index < compactionIndex && entry.id === compaction.firstKeptEntryId,
	);
	if (firstKeptIndex >= 0) start = Math.max(start, firstKeptIndex);
	if (compaction.providerReplayThroughEntryId) {
		const replayThroughIndex = entries.findIndex(
			(entry, index) => index < compactionIndex && entry.id === compaction.providerReplayThroughEntryId,
		);
		if (replayThroughIndex >= 0) start = Math.max(start, replayThroughIndex + 1);
	}
	return start;
}

function activeNativeReferences(messages: readonly AgentMessage[]): {
	calls: Map<AgentToolCall, number>;
	results: Map<ToolResultMessage, number>;
} {
	const calls = new Map<AgentToolCall, number>();
	const results = new Map<ToolResultMessage, number>();
	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.set(block, index);
			}
		} else if (message.role === "toolResult") {
			results.set(message, index);
		}
	});
	return { calls, results };
}

function textualResultChars(result: ToolResultMessage): number | undefined {
	if (result.providerMetadata !== undefined) return undefined;
	let chars = 0;
	for (const block of result.content) {
		if (block.type !== "text") return undefined;
		chars += block.text.length;
	}
	return chars;
}

function collectNativePairs(
	entries: readonly SessionEntry[],
	messages: readonly AgentMessage[],
	startIndex: number,
): NativePair[] {
	const active = activeNativeReferences(messages);
	const callsById = new Map<
		string,
		Array<Omit<NativePair, "resultEntry" | "result" | "resultEntryIndex" | "resultIndex">>
	>();
	const resultsById = new Map<
		string,
		Array<{
			resultEntry: SessionMessageEntry;
			result: ToolResultMessage;
			resultEntryIndex: number;
			resultIndex: number;
		}>
	>();

	for (let entryIndex = startIndex; entryIndex < entries.length; entryIndex++) {
		const entry = entries[entryIndex]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const messageIndex = active.calls.get(block);
				if (messageIndex === undefined) continue;
				const bucket = callsById.get(block.id) ?? [];
				bucket.push({
					callEntry: entry,
					call: block,
					callEntryIndex: entryIndex,
					callIndex: messageIndex,
				});
				callsById.set(block.id, bucket);
			}
		} else if (message.role === "toolResult") {
			const messageIndex = active.results.get(message);
			if (messageIndex === undefined) continue;
			const bucket = resultsById.get(message.toolCallId) ?? [];
			bucket.push({ resultEntry: entry, result: message, resultEntryIndex: entryIndex, resultIndex: messageIndex });
			resultsById.set(message.toolCallId, bucket);
		}
	}

	const pairs: NativePair[] = [];
	for (const callOccurrences of callsById.values()) {
		if (callOccurrences.length !== 1) continue;
		const call = callOccurrences[0]!;
		const resultOccurrences = resultsById.get(call.call.id);
		if (resultOccurrences?.length !== 1) continue;
		const result = resultOccurrences[0]!;
		if (result.resultEntryIndex <= call.callEntryIndex || result.resultIndex <= call.callIndex) continue;
		if (result.result.toolName !== call.call.name) continue;
		pairs.push({ ...call, ...result });
	}
	pairs.sort((left, right) => left.callIndex - right.callIndex || left.resultIndex - right.resultIndex);
	return pairs;
}

function protectedRecentResults(
	messages: readonly AgentMessage[],
	tokenizer: Tokenizer,
	protectTokens: number,
): Set<ToolResultMessage> {
	const protectedResults = new Set<ToolResultMessage>();
	let accumulated = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "toolResult") continue;
		if (accumulated < protectTokens) protectedResults.add(message);
		accumulated += tokenizer.countMessage(message);
	}
	return protectedResults;
}

/**
 * Collects only complete, unique, chronological native pairs which are both
 * present in the active projected context and safe to rewrite on this branch.
 */
export function collectJevCandidates(options: CollectJevCandidatesOptions): JevCandidate[] {
	const rewriteAnchorIndex = options.messages.findIndex(message => message.role === "user");
	if (rewriteAnchorIndex < 0) return [];

	const startIndex = activeMaterializedStart(options.entries);
	const forkIndex = latestConversationForkIndex(options.entries, options.allEntries);
	const recentResults = protectedRecentResults(
		options.messages,
		options.tokenizer,
		options.protectTokens ?? DEFAULT_PRUNE_CONFIG.protectTokens,
	);
	const pairs = collectNativePairs(options.entries, options.messages, startIndex);
	const candidates: JevCandidate[] = [];

	for (const pair of pairs) {
		if (pair.callIndex === 0 || pair.resultIndex === 0) continue;
		if (pair.callIndex <= rewriteAnchorIndex || pair.resultIndex <= rewriteAnchorIndex) continue;
		if (
			pair.callIndex >= options.messages.length - PRESERVE_RECENT_MESSAGES ||
			pair.resultIndex >= options.messages.length - PRESERVE_RECENT_MESSAGES
		) {
			continue;
		}
		if (pair.callEntryIndex <= forkIndex || pair.resultEntryIndex <= forkIndex) continue;
		if (pair.call.contextOmitted === true || pair.result.contextOmitted === true) continue;
		if (pair.result.prunedAt !== undefined) continue;
		if (
			pair.call.providerMetadata !== undefined ||
			(pair.callEntry.message.role === "assistant" && pair.callEntry.message.providerPayload !== undefined)
		) {
			continue;
		}
		if (textualResultChars(pair.result) === undefined) continue;
		if (recentResults.has(pair.result)) continue;
		if (
			isProtectedToolResult(pair.result, pair.call, [
				...DEFAULT_PRUNE_CONFIG.protectedTools,
				isArtifactRecoveryToolResult,
			]) ||
			options.isProtected?.(pair.result, pair.call) === true
		) {
			continue;
		}
		candidates.push({
			id: `t${candidates.length + 1}`,
			callEntry: pair.callEntry,
			resultEntry: pair.resultEntry,
			call: pair.call,
			result: pair.result,
			callIndex: pair.callIndex,
			resultIndex: pair.resultIndex,
		});
	}
	return candidates;
}

/**
 * Estimates tokens without a tokenizer. A word costs one token per six
 * letters, a digit half a token, and any other symbol nine tenths. This is the
 * upstream Jev estimator, calibrated to conservatively fit JSON-heavy states.
 */
export function estimateJevTokens(text: string): number {
	let tokens = 0;
	for (const [piece] of text.matchAll(TOKEN_PIECES)) {
		const first = piece.charCodeAt(0);
		if (first >= 48 && first <= 57) tokens += piece.length / 2;
		else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
			tokens += 1 + Math.floor((piece.length - 1) / 6);
		} else tokens += 0.9;
	}
	return Math.ceil(tokens);
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
	if (text.length <= head + tail + 40) return text;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

function isPinnedMessage(index: number, total: number): boolean {
	return index === 0 || index >= total - PRESERVE_RECENT_MESSAGES;
}

function inputText(input: Record<string, unknown>, limit: number): string {
	let json = "";
	try {
		json = JSON.stringify(input);
	} catch {
		json = "[unserializable input]";
	}
	return truncate(json, limit);
}

function resultNote(call: ScoringToolCall): string {
	return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;
}

function compactCall(call: ScoringToolCall): string {
	const input = Object.entries(call.input)
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : inputText({ [key]: value }, 200);
			return `${key}=${text.replace(/\s+/g, " ")}`;
		})
		.join(" ");
	return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${call.isError ? "error" : "ok"} ${call.resultChars}ch`;
}

function messageText(message: AgentMessage): MessageNarrative | undefined {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join("");
			return { role: "user", text };
		}
		case "assistant":
			return {
				role: "assistant",
				text: message.content
					.filter(block => block.type === "text" || block.type === "thinking")
					.map(block => (block.type === "text" ? block.text : block.thinking))
					.join("\n"),
			};
		case "custom":
		case "hookMessage": {
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join("");
			return { role: "user", text };
		}
		case "branchSummary":
		case "compactionSummary":
			return { role: "user", text: message.summary };
		default:
			return undefined;
	}
}

function scoringCalls(messages: readonly AgentMessage[], candidates: readonly JevCandidate[]): ScoringToolCall[] {
	const candidateIds = new Map<AgentToolCall, string>();
	for (const candidate of candidates) candidateIds.set(candidate.call, candidate.id);
	const results = new Map<string, Array<{ message: ToolResultMessage; index: number }>>();
	messages.forEach((message, index) => {
		if (message.role !== "toolResult") return;
		const bucket = results.get(message.toolCallId) ?? [];
		bucket.push({ message, index });
		results.set(message.toolCallId, bucket);
	});

	const calls: ScoringToolCall[] = [];
	let pinnedId = 0;
	messages.forEach((message, callIndex) => {
		if (message.role !== "assistant") return;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const matches = results.get(block.id);
			if (matches?.length !== 1) continue;
			const { message: result, index: resultIndex } = matches[0]!;
			if (resultIndex <= callIndex || result.toolName !== block.name) continue;
			const resultChars = textualResultChars(result);
			if (resultChars === undefined) continue;
			calls.push({
				id: candidateIds.get(block) ?? `p${++pinnedId}`,
				tool: block.name,
				input: block.arguments,
				callIndex,
				resultIndex,
				resultChars,
				isError: result.isError,
			});
		}
	});
	return calls;
}

function callsByMessage(calls: readonly ScoringToolCall[]): Map<number, ScoringToolCall[]> {
	const byMessage = new Map<number, ScoringToolCall[]>();
	for (const call of calls) {
		const list = byMessage.get(call.callIndex) ?? [];
		list.push(call);
		byMessage.set(call.callIndex, list);
	}
	return byMessage;
}

function historyEntries(
	narratives: readonly (MessageNarrative | undefined)[],
	calls: readonly ScoringToolCall[],
	inputChars: number,
): HistoryEntry[] {
	const byMessage = callsByMessage(calls);
	const entries: HistoryEntry[] = [];
	narratives.forEach((narrative, index) => {
		const toolCalls = (byMessage.get(index) ?? []).map(call => ({
			id: call.id,
			tool: call.tool,
			input: inputText(call.input, inputChars),
			result: resultNote(call),
		}));
		const text = narrative?.text ?? "";
		if (text.trim().length === 0 && toolCalls.length === 0) return;
		const entry: HistoryEntry = { i: index, role: narrative?.role ?? "assistant", text };
		if (toolCalls.length > 0) entry.tool_calls = toolCalls;
		entries.push(entry);
	});
	return entries;
}

function goalFromMessages(
	messages: readonly AgentMessage[],
	narratives: readonly (MessageNarrative | undefined)[],
): string {
	return messages
		.map((message, index) => ({ message, narrative: narratives[index] }))
		.filter(
			item => item.message.role === "user" && item.narrative !== undefined && item.narrative.text.trim().length > 0,
		)
		.slice(-3)
		.map(item => truncate(item.narrative!.text, 500))
		.join("\n");
}

function mergeCallRuns(history: readonly HistoryEntry[], pinned: (entry: HistoryEntry) => boolean): HistoryEntry[] {
	const merged: HistoryEntry[] = [];
	for (const entry of history) {
		const previous = merged[merged.length - 1];
		const foldable = (candidate: HistoryEntry): boolean =>
			!pinned(candidate) && candidate.text.length === 0 && typeof candidate.tool_calls?.[0] === "string";
		if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
			previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])];
			continue;
		}
		merged.push({ ...entry });
	}
	return merged;
}

/**
 * Full staged upstream fit: input caps, text abridging, old-text collapse,
 * compact call lines, omission of old dialogue-only messages, then run folding.
 */
export function fitJevState(
	messages: readonly AgentMessage[],
	candidates: readonly JevCandidate[],
	maxStateTokens = MAX_STATE_TOKENS,
	transformValues?: JevScoringValueTransform,
): FittedJevState {
	let calls = scoringCalls(messages, candidates);
	let narratives = messages.map(message => messageText(message));
	if (transformValues) {
		const values = {
			narrativeTexts: narratives.map(narrative => narrative?.text ?? null),
			inputs: calls.map(call => call.input),
		};
		const transformed = transformValues(values);
		if (transformed !== values) {
			narratives = narratives.map((narrative, index) => {
				if (!narrative) return undefined;
				const text = transformed.narrativeTexts[index];
				return typeof text === "string" ? { ...narrative, text } : narrative;
			});
			calls = calls.map((call, index) => ({
				...call,
				input: transformed.inputs[index] ?? call.input,
			}));
		}
	}
	const goal = goalFromMessages(messages, narratives);
	const stateOf = (history: HistoryEntry[]): JevCompactionState => ({
		context: STATE_CONTEXT,
		goal,
		history,
	});
	const entryTokens = (entry: HistoryEntry): number => estimateJevTokens(JSON.stringify(entry)) + 1;
	const baseTokens = estimateJevTokens(JSON.stringify(stateOf([])));
	const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedJevState => ({
		state: stateOf(history),
		tokens,
		stage,
	});

	let history: HistoryEntry[] = [];
	let perEntry: number[] = [];
	let tokens = 0;
	const rebuild = (inputChars: number): void => {
		history = historyEntries(narratives, calls, inputChars);
		perEntry = history.map(entryTokens);
		tokens = baseTokens + perEntry.reduce((sum, count) => sum + count, 0);
	};
	const fits = (): boolean => tokens <= maxStateTokens;
	const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
		const entry = history[index];
		if (!entry) return;
		change(entry);
		const now = entryTokens(entry);
		tokens += now - (perEntry[index] ?? 0);
		perEntry[index] = now;
	};

	rebuild(INPUT_CHARS[0]);
	if (fits()) return fitted(history, tokens, "full");
	for (const limit of INPUT_CHARS.slice(1)) {
		rebuild(limit);
		if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
	}

	const pinned = (entry: HistoryEntry): boolean => isPinnedMessage(entry.i, messages.length);
	const indices = history.map((_, index) => index);
	const order = [
		...indices.filter(index => !pinned(history[index]!)),
		...indices.filter(index => pinned(history[index]!)),
	];

	for (const index of order) {
		const entry = history[index]!;
		if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
		shrink(index, candidate => {
			candidate.text = abridge(candidate.text, TEXT_HEAD, TEXT_TAIL);
		});
		if (fits()) return fitted(history, tokens, "texts abridged");
	}

	for (const index of order) {
		const entry = history[index]!;
		if (pinned(entry) || entry.text.length === 0) continue;
		const original = narratives[entry.i]?.text.length ?? entry.text.length;
		shrink(index, candidate => {
			candidate.text = `[… ${original} chars omitted …]`;
		});
		if (fits()) return fitted(history, tokens, "old messages collapsed");
	}

	const byMessage = callsByMessage(calls);
	for (const index of order) {
		const entry = history[index]!;
		const own = byMessage.get(entry.i);
		if (pinned(entry) || !own) continue;
		shrink(index, candidate => {
			candidate.tool_calls = own.map(compactCall);
		});
		if (fits()) return fitted(history, tokens, "old calls compacted");
	}

	const left = new Set<number>();
	for (const index of order) {
		const entry = history[index]!;
		if (pinned(entry) || entry.tool_calls) continue;
		left.add(index);
		tokens -= perEntry[index] ?? 0;
		if (fits()) {
			return fitted(
				history.filter((_, historyIndex) => !left.has(historyIndex)),
				tokens,
				"old messages left out",
			);
		}
	}

	history = mergeCallRuns(
		history.filter((_, index) => !left.has(index)),
		pinned,
	);
	perEntry = history.map(entryTokens);
	tokens = baseTokens + perEntry.reduce((sum, count) => sum + count, 0);
	if (fits()) return fitted(history, tokens, "old calls merged");

	throw new Error(`history too large for Jev (~${tokens} tokens after truncation, limit ${maxStateTokens})`);
}

function questionsFor(candidate: JevCandidate): Record<string, NoulQuestion> {
	return {
		[`call_${candidate.id}`]: {
			type: "noul",
			instructions: prompt.render(keepCallQuestionTemplate, {
				id: candidate.id,
				tool: candidate.call.name,
			}),
		},
		[`result_${candidate.id}`]: {
			type: "noul",
			instructions: prompt.render(keepResultQuestionTemplate, {
				id: candidate.id,
				tool: candidate.call.name,
				resultChars: textualResultChars(candidate.result) ?? 0,
			}),
		},
	};
}

function batchCandidates(candidates: readonly JevCandidate[], stateTokens: number): JevCandidate[][] {
	const budget = MAX_REQUEST_TOKENS - stateTokens - REQUEST_OVERHEAD_TOKENS;
	const batches: JevCandidate[][] = [];
	let current: JevCandidate[] = [];
	let currentTokens = 0;
	for (const candidate of candidates) {
		const tokens = estimateJevTokens(JSON.stringify(questionsFor(candidate)));
		if (current.length > 0 && currentTokens + tokens > budget) {
			batches.push(current);
			current = [];
			currentTokens = 0;
		}
		if (current.length === 0 && tokens > budget) {
			throw new Error(`state leaves no room for questions (~${stateTokens} of ${MAX_REQUEST_TOKENS} tokens)`);
		}
		current.push(candidate);
		currentTokens += tokens;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function readProbability(answer: unknown, questionId: string): number {
	if (typeof answer !== "object" || answer === null) {
		throw new Error(`Invalid Jev answer for ${questionId}`);
	}
	const typed = answer as { type?: unknown; noul?: unknown };
	if (
		typed.type !== "noul" ||
		typeof typed.noul !== "number" ||
		!Number.isFinite(typed.noul) ||
		typed.noul < 0 ||
		typed.noul > 1
	) {
		throw new Error(`Invalid Jev answer for ${questionId}`);
	}
	return typed.noul;
}

interface CandidateAnswer {
	id: string;
	keepCall: number;
	keepResult: number;
}

async function scoreBatch(
	state: JevCompactionState,
	batch: readonly JevCandidate[],
	judge: Judge,
	signal: AbortSignal,
): Promise<CandidateAnswer[]> {
	const questions = Object.assign({}, ...batch.map(questionsFor)) as Record<string, NoulQuestion>;
	const result = await judge.judge({ state, questions }, { signal });
	return batch.map(candidate => ({
		id: candidate.id,
		keepCall: readProbability(result.answers[`call_${candidate.id}`], `call_${candidate.id}`),
		keepResult: readProbability(result.answers[`result_${candidate.id}`], `result_${candidate.id}`),
	}));
}

async function scoreBatches(
	state: JevCompactionState,
	batches: readonly JevCandidate[][],
	judge: Judge,
	signal: AbortSignal,
): Promise<CandidateAnswer[]> {
	const results: CandidateAnswer[] = [];
	let next = 0;
	let failed = false;
	const worker = async (): Promise<void> => {
		while (!failed) {
			const index = next++;
			if (index >= batches.length) return;
			signal.throwIfAborted();
			try {
				results.push(...(await scoreBatch(state, batches[index]!, judge, signal)));
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	const workers = Array.from({ length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) }, () => worker());
	const settled = await Promise.allSettled(workers);
	const failure = settled.find(result => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
	return results;
}

/**
 * Scores one immutable candidate set. Any malformed or missing probability
 * rejects the entire proposal; no partial decisions are returned.
 */
export async function scoreJevCandidates(
	messages: readonly AgentMessage[],
	candidates: readonly JevCandidate[],
	judge: Judge,
	signal: AbortSignal,
	transformValues?: JevScoringValueTransform,
): Promise<JevDecision[]> {
	if (candidates.length === 0) return [];
	signal.throwIfAborted();
	const fitted = fitJevState(messages, candidates, MAX_STATE_TOKENS, transformValues);
	const batches = batchCandidates(candidates, fitted.tokens);
	const answers = await scoreBatches(fitted.state, batches, judge, signal);
	if (answers.length !== candidates.length) throw new Error("Jev returned an incomplete proposal");
	const byId = new Map(answers.map(answer => [answer.id, answer]));
	return candidates.map(candidate => {
		const answer = byId.get(candidate.id);
		if (!answer) throw new Error(`Jev returned no decision for ${candidate.id}`);
		const action: JevDecision["action"] =
			answer.keepResult >= KEEP_THRESHOLD
				? "keep"
				: answer.keepCall >= KEEP_THRESHOLD
					? "truncate_result"
					: "drop_pair";
		return { id: candidate.id, action };
	});
}
