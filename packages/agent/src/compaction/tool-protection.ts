import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { parseSpillUrl } from "@oh-my-pi/pi-utils";
import type { AgentMessage, AgentToolCall } from "../types";
import { compactionKeptStart } from "./compaction";
import type { SessionEntry } from "./entries";

export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

const SKILL_INTERNAL_URL_PREFIX = "skill://";

/** Map tool-call ids to their calls across `entries[start, end)` (later calls win). */
export function collectToolCallsById(
	entries: readonly SessionEntry[],
	start = 0,
	end = entries.length,
): Map<string, AgentToolCall> {
	const toolCalls = new Map<string, AgentToolCall>();
	for (let i = start; i < end; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") toolCalls.set(block.id, block);
		}
	}
	return toolCalls;
}

/**
 * Tool calls of a summarized-away prefix `entries[0, length)` by call id: the
 * assistant entry holding each call, and in `resolved` the calls lookups have
 * read from those entries, arguments included. Built at history `revision`
 * for the prefix before `boundary` (`entries[length]`).
 */
interface PrefixToolCalls {
	readonly revision: number;
	readonly length: number;
	readonly boundary: SessionEntry;
	readonly entryById: Map<string, SessionEntry>;
	readonly resolved: Map<string, AgentToolCall>;
}

function indexPrefixToolCalls(entries: readonly SessionEntry[], length: number, revision: number): PrefixToolCalls {
	const entryById = new Map<string, SessionEntry>();
	for (let i = 0; i < length; i++) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") entryById.set(block.id, entry);
		}
	}
	return { revision, length, boundary: entries[length], entryById, resolved: new Map() };
}

/**
 * The tool calls before a compaction boundary, kept across prune and shake
 * passes by the owner of the history: one cache per session, passed as
 * `prefixToolCalls`. It holds the calls of one prefix, so a pass at another
 * boundary, branch, or root replaces them rather than adding more. The owner
 * calls {@link clear} when it lets go of that history (another conversation
 * replaces it, or the session releases it), since the cache would otherwise
 * keep those entries until its next pass.
 *
 * `entries` is a branch path, so the boundary entry fixes the prefix before
 * it. The cache serves a pass only while the boundary entry and its index are
 * the ones it indexed and `revision()` returns the value it was built at. The
 * owner MUST change that value whenever it mutates or replaces an entry in
 * place; appends need no change, since they never land before the boundary.
 */
export class PrefixToolCallCache {
	readonly #revision: () => number;
	#index: PrefixToolCalls | undefined;

	constructor(revision: () => number) {
		this.#revision = revision;
	}

	/**
	 * The call `id` among `entries[0, length)`, the prefix before the boundary
	 * `entries[length]`. Walks that prefix again whenever the boundary entry, its
	 * index, or `revision()` differs from the held index's, as after any in-place
	 * rewrite the owner reports, even one that edited only entries after the
	 * boundary, and after {@link clear}; otherwise it reads only the assistant
	 * entry holding a call not resolved yet.
	 */
	get(entries: readonly SessionEntry[], length: number, id: string): AgentToolCall | undefined {
		const revision = this.#revision();
		let index = this.#index;
		if (!index || index.revision !== revision || index.length !== length || index.boundary !== entries[length]) {
			index = indexPrefixToolCalls(entries, length, revision);
			this.#index = index;
		}
		const resolved = index.resolved.get(id);
		if (resolved !== undefined) return resolved;
		const entry = index.entryById.get(id);
		if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
		const call = entry.message.content.findLast(
			(block): block is AgentToolCall => block.type === "toolCall" && block.id === id,
		);
		if (call !== undefined) index.resolved.set(id, call);
		return call;
	}

	/** Drop the held prefix index and every entry and call it references; the next lookup indexes again. */
	clear(): void {
		this.#index = undefined;
	}
}

/**
 * Resolve the array index of the compaction boundary (`keepBoundaryId`, the
 * `firstKeptEntryId` of the latest compaction). Entries before this index are
 * summarized away by that compaction and never sent, so the prune and shake
 * passes neither walk nor mutate them. Returns 0 when there is no boundary (no
 * compaction → whole branch is sent) or the id is absent from `entries`.
 *
 * A compaction that kept no entry (`firstKeptEntryId: ""`, as an Anthropic
 * native compaction that summarizes everything leaves) puts the boundary
 * where the context starts for the latest compaction on `entries`
 * ({@link compactionKeptStart}): the entry after its
 * `providerReplayThroughEntryId` when turns were appended while it ran, else
 * that compaction. Reading `""` as no boundary would walk, and read the
 * bodies of, the whole branch on every pass.
 */
export function resolveBoundaryIndex(entries: readonly SessionEntry[], keepBoundaryId: string | undefined): number {
	if (keepBoundaryId === undefined) return 0;
	if (keepBoundaryId === "") {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "compaction") return compactionKeptStart(entries, entry, i);
		}
		return 0;
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].id === keepBoundaryId) return i;
	}
	return 0;
}

/**
 * Tool-call lookup for results in the sent region `entries[start, end)`.
 * Calls there are indexed eagerly; the summarized-away prefix is indexed only
 * on the first miss, in `prefix` (see {@link PrefixToolCallCache}), so lookups
 * match a whole-branch scan while a session's passes walk history the
 * boundary already excludes only when that cache cannot serve them. Without a
 * session's cache, this pass indexes the prefix for itself.
 */
export class SentToolCalls {
	readonly #entries: readonly SessionEntry[];
	readonly #start: number;
	readonly #sent: Map<string, AgentToolCall>;
	#prefix: PrefixToolCallCache | undefined;

	constructor(entries: readonly SessionEntry[], start: number, prefix?: PrefixToolCallCache) {
		this.#entries = entries;
		this.#start = start;
		this.#sent = collectToolCallsById(entries, start);
		this.#prefix = prefix;
	}

	get(id: string): AgentToolCall | undefined {
		const call = this.#sent.get(id);
		if (call !== undefined || this.#start === 0) return call;
		// A pass's entries stay put while it runs, so its own cache needs no revision.
		this.#prefix ??= new PrefixToolCallCache(() => 0);
		return this.#prefix.get(this.#entries, this.#start, id);
	}
}

/** Return the tool-result message carried by a session entry, if any. */
export function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

/**
 * Extract the `path` argument from a paired `read` tool call, when the result
 * is a `read` result carrying a string path. Returns `undefined` otherwise.
 * Shared primitive for read-targeted protection matchers (skills, plans, …).
 */
export function getReadToolPath({ toolResult, toolCall }: ProtectedToolContext): string | undefined {
	if (toolResult.toolName !== "read" || toolCall?.name !== "read") return undefined;
	const path = (toolCall.arguments as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

export function isSkillReadToolResult(context: ProtectedToolContext): boolean {
	return getReadToolPath(context)?.startsWith(SKILL_INTERNAL_URL_PREFIX) ?? false;
}

/** Whether `path` reads a session spill (`local://N.log`, with or without a selector). */
function isSpillPath(path: string | undefined): boolean {
	return path !== undefined && parseSpillUrl(path) !== undefined;
}

/** Recovery reads of session spills — eliding one only mints another spill and can repeat indefinitely. */
export function isArtifactRecoveryToolResult(context: ProtectedToolContext): boolean {
	if (isSpillPath(getReadToolPath(context))) return true;
	const meta = (context.toolResult.details as { meta?: { source?: { type?: string; value?: string } } } | undefined)
		?.meta;
	return meta?.source?.type === "internal" && isSpillPath(meta.source.value);
}

export function isProtectedToolResult(
	toolResult: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	matchers: readonly ProtectedToolMatcher[],
): boolean {
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (toolResult.toolName === matcher) return true;
			continue;
		}
		if (matcher({ toolResult, toolCall })) return true;
	}
	return false;
}
