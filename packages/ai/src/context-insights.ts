/**
 * Shared context timeline model used by the coding agent and the stats
 * dashboard. Pure data folding over journal entry shapes: no Node APIs, no
 * clock reads, and no prompt/message bodies in the output.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import type { ContextSnapshot } from "./types";
import type {
	ContextAgentUsage,
	ContextCategoryTokens,
	ContextEvent,
	ContextFileActivity,
	ContextNamedTokens,
	ContextSnapshotDetails,
	ContextStep,
	ContextStepDetails,
	ContextStepUsage,
	ContextTimeline,
	ContextTimelineLimits,
} from "./context-insights-types";

export type * from "./context-insights-types";

export interface ContextUsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	contextTokens?: number;
	total?: number;
	cost?: { total?: number };
}

export interface ContextJournalMessage {
	role?: string;
	timestamp?: number;
	model?: string;
	provider?: string;
	usage?: ContextUsageLike;
	contextSnapshot?: ContextSnapshot;
	/** Assistant content blocks; only toolCall blocks are read. */
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	/** Tool result details; file activity reads only known fields. */
	details?: unknown;
	isError?: boolean;
	prunedAt?: number;
}

export interface ContextJournalEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	/** Active leaf captured at append time; null clears it, undefined selects this entry. */
	activeLeafId?: string | null;
	timestamp?: string;
	message?: ContextJournalMessage;
	model?: string;
	role?: string;
	resolvedModelIsFallback?: boolean;
	thinkingLevel?: string | null;
	configured?: string | null;
	serviceTier?: unknown;
	summary?: string;
	tokensBefore?: number;
	tokensAfter?: number;
	method?: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
	injectedRules?: string[];
	mode?: string;
	data?: Record<string, unknown>;
}

export const DEFAULT_CONTEXT_LIMITS: Readonly<ContextTimelineLimits> = {
	maxSteps: 1000,
	maxEvents: 200,
	maxFiles: 500,
	maxBrowserEntries: 500,
	maxToolSchemas: 200,
	maxSkills: 200,
	maxSystemParts: 20,
};

export interface ContextTimelineInput {
	sessionId: string;
	file?: string;
	cwd?: string;
	source: "live" | "journal";
	entries: readonly ContextJournalEntry[];
	limits?: Partial<ContextTimelineLimits>;
	/** Adapter-provided resolver for file-tool paths; must be deterministic and side-effect free. */
	normalizePath?: (path: string) => string;
	agents?: ContextAgentUsage[];
}

interface PendingToolCall {
	id: string;
	name: string;
	path?: string;
	/** Multi-target tools (ast_edit) resolve every requested file. */
	paths?: string[];
	resolved: boolean;
	owner?: PendingStep;
	/** Call-side write contribution, used to migrate counts to resolvedPath without double counting. */
	writeLines?: number;
	writeBytes?: number;
}

interface PendingStep {
	entryId: string;
	order: number;
	timestamp: number;
	step: ContextStep;
	categories?: ContextCategoryTokens;
	fullDetails?: ContextSnapshotDetails;
	filePaths: Set<string>;
}

const SEARCH_TOOLS = new Set(["glob", "grep", "find", "ast_grep", "lsp"]);

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number {
	const n = finite(value);
	return n === undefined ? 0 : Math.max(0, Math.floor(n));
}

function optionalNonNegativeInt(value: unknown): number | undefined {
	const n = finite(value);
	return n === undefined ? undefined : Math.max(0, Math.floor(n));
}

function timestampOf(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function sanitizeCategories(value: unknown): ContextCategoryTokens | undefined {
	if (!isRecord(value)) return undefined;
	return {
		systemPrompt: nonNegativeInt(value.systemPrompt),
		systemTools: nonNegativeInt(value.systemTools),
		systemContext: nonNegativeInt(value.systemContext),
		skills: nonNegativeInt(value.skills),
		messages: nonNegativeInt(value.messages),
	};
}

function sumCategories(categories: ContextCategoryTokens): number {
	return (
		categories.systemPrompt +
		categories.systemTools +
		categories.systemContext +
		categories.skills +
		categories.messages
	);
}

function promptTokensFromUsage(usage: ContextUsageLike | undefined): number {
	if (!usage) return 0;
	const contextTokens = finite(usage.contextTokens);
	if (contextTokens !== undefined) return Math.max(0, Math.floor(contextTokens));
	return Math.max(
		0,
		Math.floor(nonNegativeInt(usage.input) + nonNegativeInt(usage.cacheRead) + nonNegativeInt(usage.cacheWrite)),
	);
}

function sanitizeUsage(usage: ContextUsageLike | undefined): ContextStepUsage | undefined {
	if (!usage) return undefined;
	const input = nonNegativeInt(usage.input);
	const output = nonNegativeInt(usage.output);
	const cacheRead = nonNegativeInt(usage.cacheRead);
	const cacheWrite = nonNegativeInt(usage.cacheWrite);
	const total = Math.max(nonNegativeInt(usage.total), input + output + cacheRead + cacheWrite);
	const costTotal = finite(usage.cost?.total);
	return { input, output, cacheRead, cacheWrite, total, ...(costTotal !== undefined ? { costTotal } : {}) };
}

function sanitizeNamedTokens(value: unknown): ContextNamedTokens[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: ContextNamedTokens[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) continue;
		out.push({ name: item.name, tokens: nonNegativeInt(item.tokens) });
	}
	return out;
}

function sanitizeParts(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map(nonNegativeInt);
}

function projectDetails(details: ContextSnapshotDetails): ContextStepDetails | undefined {
	const categories = sanitizeCategories(details.categories);
	if (!categories) return undefined;
	const toolSchemas = sanitizeNamedTokens(details.toolSchemas);
	const skills = sanitizeNamedTokens(details.skills);
	const systemPromptParts = sanitizeParts(details.systemPromptParts);
	const omittedToolSchemas = optionalNonNegativeInt(details.omittedToolSchemas);
	const omittedSkills = optionalNonNegativeInt(details.omittedSkills);
	const systemPromptPartsOmitted = optionalNonNegativeInt(details.systemPromptPartsOmitted);
	return {
		contextWindow: nonNegativeInt(details.contextWindow),
		categories,
		...(toolSchemas ? { toolSchemas } : {}),
		...(omittedToolSchemas !== undefined ? { omittedToolSchemas } : {}),
		...(skills ? { skills } : {}),
		...(omittedSkills !== undefined ? { omittedSkills } : {}),
		...(systemPromptParts ? { systemPromptParts } : {}),
		...(systemPromptPartsOmitted !== undefined ? { systemPromptPartsOmitted } : {}),
		messageCount: nonNegativeInt(details.messageCount),
		pendingMessageTokens: nonNegativeInt(details.pendingMessageTokens),
	};
}

function lineCount(value: unknown): number {
	if (typeof value !== "string" || value.length === 0) return 0;
	const lines = value.split("\n");
	return value.endsWith("\n") ? Math.max(0, lines.length - 1) : lines.length;
}

function byteLength(value: unknown): number {
	if (typeof value !== "string" || value.length === 0) return 0;
	return new TextEncoder().encode(value).length;
}

function diffLineCounts(diff: unknown): { added: number; removed: number } {
	if (typeof diff !== "string" || diff.length === 0) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function clampLimit(value: unknown, fallback: number): number {
	const n = finite(value);
	if (n === undefined) return fallback;
	return Math.min(fallback, Math.max(0, Math.floor(n)));
}

function formatTier(value: unknown): string {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	return "changed";
}

function eventForEntry(entry: ContextJournalEntry, order: number): ContextEvent | undefined {
	const timestamp = timestampOf(entry.timestamp);
	const id = entry.id ?? `event-${order}`;
	switch (entry.type) {
		case "compaction": {
			const before = optionalNonNegativeInt(entry.tokensBefore);
			const after = optionalNonNegativeInt(entry.tokensAfter);
			return {
				id,
				timestamp,
				kind: "compact",
				label: `compact ${entry.method ?? "?"} ${before ?? "?"}→${after ?? "?"}`,
				...(before !== undefined ? { tokensBefore: before } : {}),
				...(after !== undefined ? { tokensAfter: after } : {}),
				...(entry.method !== undefined ? { source: entry.method } : {}),
			};
		}
		case "branch_summary":
			return { id, timestamp, kind: "branch", label: "branch summary" };
		case "custom_message":
			return {
				id,
				timestamp,
				kind: "inject",
				label: `inject ${entry.customType ?? "custom"}`,
				...(entry.customType !== undefined ? { source: entry.customType } : {}),
			};
		case "ttsr_injection": {
			const rules = Array.isArray(entry.injectedRules)
				? entry.injectedRules.filter(rule => typeof rule === "string")
				: [];
			return {
				id,
				timestamp,
				kind: "inject",
				label: rules.length > 0 ? `inject rules: ${rules.join(", ")}` : "inject rules",
				source: "ttsr",
			};
		}
		case "model_change":
			return {
				id,
				timestamp,
				kind: "switch",
				label: `model ${entry.model ?? "?"}${entry.role ? ` (${entry.role})` : ""}`,
				source: "model",
				...(entry.resolvedModelIsFallback ? { detail: "fallback" } : {}),
			};
		case "thinking_level_change":
			return {
				id,
				timestamp,
				kind: "switch",
				label: `thinking ${entry.configured ?? entry.thinkingLevel ?? "?"}`,
				source: "thinking",
			};
		case "service_tier_change":
			return {
				id,
				timestamp,
				kind: "switch",
				label: `service tier ${formatTier(entry.serviceTier)}`,
				source: "tier",
			};
		case "mode_change":
			return { id, timestamp, kind: "mode", label: `mode ${entry.mode ?? "?"}` };
		case "reset_boundary":
			return { id, timestamp, kind: "reset", label: "context reset" };
		default:
			return undefined;
	}
}

function resolveToolPath(
	args: Record<string, unknown>,
	normalizePath: ((path: string) => string) | undefined,
): string | undefined {
	const raw = args.path ?? args.file_path;
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return undefined;
	const normalized = normalizePath ? normalizePath(raw) : raw;
	if (normalized.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return undefined;
	return normalized;
}

function emptyActivity(path: string, timestamp: number): ContextFileActivity {
	return {
		path,
		reads: 0,
		writes: 0,
		edits: 0,
		searches: 0,
		linesRead: 0,
		linesAdded: 0,
		linesRemoved: 0,
		bytesRead: 0,
		bytesWritten: 0,
		lastTimestamp: timestamp,
	};
}

/** Fold ordered journal entries into the shared context timeline. */
export function foldContextTimeline(input: ContextTimelineInput): ContextTimeline {
	const maxSteps = clampLimit(input.limits?.maxSteps, DEFAULT_CONTEXT_LIMITS.maxSteps);
	const maxEvents = clampLimit(input.limits?.maxEvents, DEFAULT_CONTEXT_LIMITS.maxEvents);
	const maxFiles = clampLimit(input.limits?.maxFiles, DEFAULT_CONTEXT_LIMITS.maxFiles);
	const maxBrowserEntries = clampLimit(input.limits?.maxBrowserEntries, DEFAULT_CONTEXT_LIMITS.maxBrowserEntries);

	const steps: PendingStep[] = [];
	const events: Array<{ event: ContextEvent; order: number }> = [];
	const files = new Map<string, ContextFileActivity>();
	const pendingCalls = new Map<string, PendingToolCall>();
	const seen = new Set<string>();

	const activity = (path: string, timestamp: number): ContextFileActivity => {
		let entry = files.get(path);
		if (!entry) {
			entry = emptyActivity(path, timestamp);
			files.set(path, entry);
		}
		entry.lastTimestamp = Math.max(entry.lastTimestamp, timestamp);
		return entry;
	};

	for (const [order, entry] of input.entries.entries()) {
		if (!isRecord(entry) || typeof entry.type !== "string") continue;
		if (entry.id !== undefined) {
			if (typeof entry.id !== "string" || seen.has(entry.id)) continue;
			seen.add(entry.id);
		}
		const message = entry.message;
		if (message && typeof message.role === "string") {
			if (message.role === "assistant") {
				const stepTimestamp = timestampOf(message.timestamp ?? entry.timestamp);
				const snapshot = message.contextSnapshot;
				const promptTokens = snapshot
					? Math.max(
							0,
							nonNegativeInt(snapshot.promptTokens) - nonNegativeInt(snapshot.historyRewriteTokensRemoved),
						)
					: promptTokensFromUsage(message.usage);
				if (!snapshot && promptTokens <= 0) continue;

				const categories = snapshot?.details ? sanitizeCategories(snapshot.details.categories) : undefined;
				const details = categories && snapshot?.details ? snapshot.details : undefined;
				const step: ContextStep = {
					id: entry.id ?? `step-${order}`,
					index: steps.length,
					timestamp: stepTimestamp,
					...(typeof message.model === "string" ? { model: message.model } : {}),
					...(typeof message.provider === "string" ? { provider: message.provider } : {}),
					promptTokens,
					anchored: snapshot !== undefined,
					...(categories ? { composition: categories } : {}),
					...(categories ? { compositionEstimated: true } : {}),
					...(categories ? { unattributed: promptTokens - sumCategories(categories) } : {}),
					...(details ? { contextWindow: nonNegativeInt(details.contextWindow) } : {}),
					deltaKind: "first",
					...(sanitizeUsage(message.usage) ? { usage: sanitizeUsage(message.usage) } : {}),
					eventIds: [],
					filePaths: [],
				};
				const pending: PendingStep = {
					entryId: step.id,
					order,
					timestamp: stepTimestamp,
					step,
					...(categories ? { categories } : {}),
					...(details ? { fullDetails: details } : {}),
					filePaths: new Set<string>(),
				};

				for (const block of asArray(message.content)) {
					if (!isRecord(block) || block.type !== "toolCall") continue;
					const toolId = typeof block.id === "string" ? block.id : undefined;
					const toolName = typeof block.name === "string" ? block.name : undefined;
					if (!toolId || !toolName) continue;
					const args = isRecord(block.arguments) ? block.arguments : {};
					const isFileTool =
						toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "ast_edit";
					const isSearchTool = SEARCH_TOOLS.has(toolName);
					if (!isFileTool && !isSearchTool) continue;
					const astPaths =
						toolName === "ast_edit" && Array.isArray(args.paths)
							? [
									...new Set(
										args.paths
											.filter((value): value is string => typeof value === "string" && value.length > 0)
											.map(value => resolveToolPath({ path: value }, input.normalizePath))
											.filter((value): value is string => value !== undefined),
									),
								]
							: [];
					const rawPath = astPaths[0] ?? args.path ?? args.file_path;
					const hasRawPath = typeof rawPath === "string" && rawPath.length > 0;
					const path = astPaths[0] ?? resolveToolPath(args, input.normalizePath);
					if (!path && !(isSearchTool && !hasRawPath)) continue;
					const call: PendingToolCall = {
						id: toolId,
						name: toolName,
						...(path ? { path } : {}),
						...(astPaths.length > 0 ? { paths: astPaths } : {}),
						resolved: false,
						owner: pending,
					};
					pendingCalls.set(toolId, call);
					const activityPath = path ?? "(search)";
					const file = activity(activityPath, stepTimestamp);
					if (toolName === "read") file.reads++;
					else if (toolName === "write") {
						const lines = lineCount(args.content);
						const bytes = byteLength(args.content);
						call.writeLines = lines;
						call.writeBytes = bytes;
						file.writes++;
						file.linesAdded += lines;
						file.bytesWritten += bytes;
					} else if (toolName === "edit") file.edits++;
					else if (toolName === "ast_edit") {
						const targets = astPaths.length > 0 ? astPaths : [activityPath];
						for (const target of targets) activity(target, stepTimestamp).edits++;
					} else if (isSearchTool) file.searches++;
					for (const target of astPaths.length > 0 ? astPaths : [activityPath]) pending.filePaths.add(target);
				}
				steps.push(pending);
				continue;
			}

			if (message.role === "toolResult") {
				const toolId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
				const prunedAt = finite(message.prunedAt);
				if (prunedAt !== undefined) {
					events.push({
						event: {
							id: entry.id ?? `prune-${order}`,
							timestamp: timestampOf(message.timestamp ?? entry.timestamp),
							kind: "prune",
							label: `prune ${message.toolName ?? "tool"}`,
							...(toolId ? { detail: toolId } : {}),
							inferred: true,
						},
						order,
					});
				}
				if (!toolId) continue;
				const call = pendingCalls.get(toolId);
				if (!call?.path) continue;
				const resultDetails = isRecord(message.details) ? message.details : undefined;
				const file = activity(call.path, timestampOf(message.timestamp ?? entry.timestamp));
				if (call.name === "read") {
					const lines = finite(
						resultDetails?.summary && isRecord(resultDetails.summary) ? resultDetails.summary.lines : undefined,
					);
					const totalLines = finite(resultDetails?.totalLines);
					const displayLines = isRecord(resultDetails?.displayContent)
						? lineCount(resultDetails.displayContent.text)
						: 0;
					file.linesRead += nonNegativeInt(lines ?? totalLines ?? displayLines);
					file.bytesRead += nonNegativeInt(resultDetails?.fileSize);
				} else if (call.name === "write") {
					const rawResolved = resultDetails?.resolvedPath;
					const resolved =
						typeof rawResolved === "string"
							? resolveToolPath({ path: rawResolved }, input.normalizePath)
							: undefined;
					if (resolved && resolved !== call.path) {
						const previousPath = call.path;
						const resultTimestamp = timestampOf(message.timestamp ?? entry.timestamp);
						file.writes = Math.max(0, file.writes - 1);
						file.linesAdded = Math.max(0, file.linesAdded - (call.writeLines ?? 0));
						file.bytesWritten = Math.max(0, file.bytesWritten - (call.writeBytes ?? 0));
						if (
							file.reads === 0 &&
							file.writes === 0 &&
							file.edits === 0 &&
							file.searches === 0 &&
							file.linesRead === 0 &&
							file.linesAdded === 0 &&
							file.linesRemoved === 0 &&
							file.bytesRead === 0 &&
							file.bytesWritten === 0
						) {
							files.delete(previousPath);
						}
						const target = activity(resolved, resultTimestamp);
						target.writes++;
						target.linesAdded += call.writeLines ?? 0;
						target.bytesWritten += call.writeBytes ?? 0;
						call.path = resolved;
						if (call.owner) {
							const otherUsesPrevious = [...pendingCalls.values()].some(
								other => other !== call && other.owner === call.owner && other.path === previousPath,
							);
							if (!otherUsesPrevious) call.owner.filePaths.delete(previousPath);
							call.owner.filePaths.add(resolved);
						}
					}
				} else if (call.name === "ast_edit") {
					const named = [
						...asArray(resultDetails?.files),
						...asArray(resultDetails?.fileReplacements).map(item =>
							isRecord(item) && typeof item.path === "string" ? item.path : undefined,
						),
					];
					const actual = new Set<string>();
					for (const raw of named) {
						if (typeof raw !== "string") continue;
						const resolved = resolveToolPath({ path: raw }, input.normalizePath);
						if (resolved) actual.add(resolved);
					}
					if (actual.size > 0 && call.paths) {
						// Drop provisional directories/globs and duplicate spellings once the
						// result names the concrete files that were actually rewritten.
						for (const requested of call.paths) {
							if (actual.has(requested)) continue;
							const provisional = files.get(requested);
							if (provisional) {
								provisional.edits = Math.max(0, provisional.edits - 1);
								const empty =
									provisional.reads === 0 &&
									provisional.writes === 0 &&
									provisional.edits === 0 &&
									provisional.searches === 0 &&
									provisional.linesRead === 0 &&
									provisional.linesAdded === 0 &&
									provisional.linesRemoved === 0 &&
									provisional.bytesRead === 0 &&
									provisional.bytesWritten === 0;
								if (empty) files.delete(requested);
							}
							const owner = call.owner;
							const stillOwned = [...pendingCalls.values()].some(
								other =>
									other !== call &&
									other.owner === owner &&
									!other.resolved &&
									(other.path === requested || other.paths?.includes(requested)),
							);
							if (!stillOwned) owner?.filePaths.delete(requested);
						}
					}
					for (const target of actual) {
						if (!call.paths?.includes(target)) {
							activity(target, timestampOf(message.timestamp ?? entry.timestamp)).edits++;
							call.owner?.filePaths.add(target);
						}
					}
					// The result has reconciled this call's selectors; earlier calls
					// processing the same selector must not treat this call as still using it.
					if (actual.size > 0) call.paths = undefined;
				} else if (call.name === "edit") {
					const perFile = asArray(resultDetails?.perFileResults);
					if (perFile.length > 0) {
						for (const item of perFile) {
							if (!isRecord(item)) continue;
							const rawPath = typeof item.path === "string" ? item.path : undefined;
							const itemPath = rawPath
								? (resolveToolPath({ path: rawPath }, input.normalizePath) ?? call.path)
								: call.path;
							const counts = diffLineCounts(item.diff);
							const itemFile = activity(itemPath, timestampOf(message.timestamp ?? entry.timestamp));
							itemFile.linesAdded += counts.added;
							itemFile.linesRemoved += counts.removed;
						}
					} else {
						const counts = diffLineCounts(resultDetails?.diff);
						file.linesAdded += counts.added;
						file.linesRemoved += counts.removed;
					}
				}
				call.resolved = true;
			}
		}

		const event = eventForEntry(entry, order);
		if (event) events.push({ event, order });
	}

	for (let index = 0; index < steps.length; index++) {
		const current = steps[index]!;
		if (index > 0) {
			const previous = steps[index - 1]!;
			current.step.deltaTokens = current.step.promptTokens - previous.step.promptTokens;
			const between = events.filter(item => item.order > previous.order && item.order < current.order);
			if (between.some(item => item.event.kind === "reset")) current.step.deltaKind = "reset";
			else if (between.some(item => item.event.kind === "compact")) current.step.deltaKind = "compaction";
			else if (between.some(item => item.event.kind === "switch" && item.event.source === "model")) {
				current.step.deltaKind = "model-switch";
			} else current.step.deltaKind = current.step.deltaTokens >= 0 ? "grow" : "shrink";
		}
		current.step.filePaths = [...current.filePaths].sort();
	}

	for (const item of events) {
		const next = steps.find(step => step.order > item.order);
		if (next) item.event.stepIndex = next.step.index;
	}

	const omittedSteps = Math.max(0, steps.length - maxSteps);
	const returned = maxSteps === 0 ? [] : steps.slice(-maxSteps);
	let detailsOmittedSteps = 0;
	let usedBrowserEntries = 0;
	for (let index = returned.length - 1; index >= 0; index--) {
		const pending = returned[index]!;
		const details = pending.fullDetails ? projectDetails(pending.fullDetails) : undefined;
		if (!details) continue;
		if (maxBrowserEntries === 0) {
			detailsOmittedSteps++;
			continue;
		}
		const entries =
			(details.toolSchemas?.length ?? 0) + (details.skills?.length ?? 0) + (details.systemPromptParts?.length ?? 0);
		if (usedBrowserEntries + entries > maxBrowserEntries) {
			detailsOmittedSteps++;
			continue;
		}
		usedBrowserEntries += entries;
		pending.step.details = details;
	}

	const omittedEvents = Math.max(0, events.length - maxEvents);
	const keptEvents = (maxEvents === 0 ? [] : events.slice(-maxEvents)).map(item => item.event);
	for (const event of keptEvents) {
		if (event.stepIndex === undefined) continue;
		const step = returned.find(item => item.step.index === event.stepIndex);
		if (step) step.step.eventIds.push(event.id);
	}

	const allFiles = [...files.values()];
	allFiles.sort((a, b) => {
		const aScore = a.reads + a.writes + a.edits + a.searches;
		const bScore = b.reads + b.writes + b.edits + b.searches;
		return bScore - aScore || b.lastTimestamp - a.lastTimestamp || a.path.localeCompare(b.path);
	});
	const omittedFiles = Math.max(0, allFiles.length - maxFiles);
	const keptFiles = allFiles.slice(0, maxFiles);

	const returnedSteps = returned.map(pending => pending.step);
	const lastStep = returnedSteps.at(-1);
	const peakTokens = returnedSteps.reduce((peak, step) => Math.max(peak, step.promptTokens), 0);
	const costTotal = steps.reduce((sum, pending) => sum + (pending.step.usage?.costTotal ?? 0), 0);
	const peakTokensTotal = steps.reduce((peak, pending) => Math.max(peak, pending.step.promptTokens), 0);
	const legacySteps = returnedSteps.filter(step => step.composition === undefined).length;
	const incompleteFileCalls = [...pendingCalls.values()].filter(call => call.path && !call.resolved).length;
	const sourceDetailsTruncated = returned.some(
		pending =>
			(pending.fullDetails?.omittedToolSchemas ?? 0) > 0 ||
			(pending.fullDetails?.omittedSkills ?? 0) > 0 ||
			(pending.fullDetails?.systemPromptPartsOmitted ?? 0) > 0,
	);

	return {
		schemaVersion: 1,
		sessionId: input.sessionId,
		...(input.file !== undefined ? { file: input.file } : {}),
		...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
		source: input.source,
		steps: returnedSteps,
		omittedSteps,
		detailsOmittedSteps,
		...(lastStep?.composition ? { composition: lastStep.composition } : {}),
		...(lastStep?.contextWindow !== undefined ? { contextWindow: lastStep.contextWindow } : {}),
		peakTokens,
		costTotal,
		peakTokensTotal,
		events: keptEvents,
		omittedEvents,
		files: keptFiles,
		omittedFiles,
		incompleteFileCalls,
		agents: input.agents ?? [],
		legacySteps,
		truncated:
			omittedSteps > 0 || detailsOmittedSteps > 0 || omittedEvents > 0 || omittedFiles > 0 || sourceDetailsTruncated,
	};
}
