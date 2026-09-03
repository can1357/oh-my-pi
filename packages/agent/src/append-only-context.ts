/**
 * Append-only context mode — stabilizes the byte prefix sent to the LLM
 * across turns so provider prefix caches (DeepSeek, Anthropic, etc.)
 * hit at the maximum possible rate.
 *
 * Two mechanisms:
 *
 * 1. **StablePrefix** — system prompt + tool specs are computed once
 *    and frozen. Subsequent turns reuse the exact same byte sequence
 *    unless `invalidate()` is called (e.g. after MCP reconnect).
 *
 * 2. **AppendOnlyLog** — messages only grow; prior turns are never
 *    re-serialized. Combined with a stable prefix, only the user's new
 *    message delta is a cache miss each turn.
 */

import type { Context, Message, Tool } from "@oh-my-pi/pi-ai";
import { normalizeTools } from "./agent-loop";
import { messageEstimateVersion } from "./compaction/message-cache";
import type { AgentContext, AgentMessage } from "./types";

// ---------------------------------------------------------------------------
// StablePrefix (formerly ImmutablePrefix)
// ---------------------------------------------------------------------------

/** Frozen system prompt + tool spec snapshot. */
export interface StablePrefixSnapshot {
	systemPrompt: string[];
	tools: Tool[];
	fingerprint: string;
}

/** Options threaded through `build()` so the snapshot reflects loop-time settings. */
export interface BuildOptions {
	/** Inject the `i` intent field into tool schemas (must match agent-loop's normalizeTools). */
	intentTracing: boolean;
	/** Strip tool descriptions from the provider-bound specs (must match normalizeTools). */
	pruneToolDescriptions?: boolean;
}

/**
 * A frozen prefix (system prompt + tools) that produces stable byte
 * sequences across `build()` calls.
 *
 * The first `build()` snapshots the live state. Subsequent calls reuse
 * the cached copy until `invalidate()` is called or the live state's
 * fingerprint changes.
 */
export class StablePrefix {
	#snapshot: StablePrefixSnapshot | null = null;
	#version = 0;

	get fingerprint(): string {
		return this.#snapshot?.fingerprint ?? "<unbuilt>";
	}
	get version(): number {
		return this.#version;
	}
	get built(): boolean {
		return this.#snapshot !== null;
	}

	/**
	 * Build or rebuild from live context.
	 * Returns `true` if the prefix actually changed (cache miss imminent).
	 */
	build(context: AgentContext, options: BuildOptions): boolean {
		const snapshot = takeSnapshot(context, options);
		if (this.#snapshot && this.#snapshot.fingerprint === snapshot.fingerprint) {
			return false;
		}
		this.#snapshot = snapshot;
		this.#version++;
		return true;
	}

	/** Force rebuild on the next `build()` call. */
	invalidate(): void {
		this.#snapshot = null;
	}

	/**
	 * Returns the cached prefix.
	 * @throws if `build()` was never called.
	 */
	toContext(): { systemPrompt: string[]; tools: Tool[] } {
		const s = this.#snapshot;
		if (!s) throw new Error("StablePrefix.toContext() called before build()");
		return { systemPrompt: s.systemPrompt, tools: s.tools };
	}
}

// ---------------------------------------------------------------------------
// AppendOnlyLog
// ---------------------------------------------------------------------------

/**
 * Append-only message log at the `Message[]` (provider-level) layer.
 *
 * The only mutation path is `replaceTail()`, reserved for compaction.
 * Every other operation is append-only.
 */
export class AppendOnlyLog {
	#entries: Message[] = [];

	get length(): number {
		return this.#entries.length;
	}

	append(message: any): void {
		this.#entries.push(message);
	}

	extend(messages: any[]): void {
		for (const m of messages) this.#entries.push(m);
	}

	/** Replace the last entry — only legal for compaction. */
	replaceTail(replacement: any): void {
		const idx = this.#entries.length - 1;
		if (idx >= 0) this.#entries[idx] = replacement;
	}

	/** Returns a shallow copy of all entries. */
	toMessages(): Message[] {
		return this.#entries.slice();
	}

	/** Direct readonly access for in-place inspection. */
	entries(): readonly Message[] {
		return this.#entries;
	}

	/** Drop entries past index `count`, keeping the first `count` byte-stable.
	 * Used by {@link AppendOnlyContextManager.syncMessages} to preserve the
	 * already-on-the-wire prefix when a later message diverges. */
	truncate(count: number): void {
		if (count < 0) count = 0;
		if (count >= this.#entries.length) return;
		this.#entries.length = count;
	}

	clear(): void {
		this.#entries = [];
	}
}

// ---------------------------------------------------------------------------
// AppendOnlyContextManager
// ---------------------------------------------------------------------------

/**
 * Manages a stable prefix + append-only log for the agent loop.
 *
 * Call `build(context)` each turn to get a `Context` with stable
 * `systemPrompt` and `tools` and append-only messages. Call
 * `syncMessages(normalizedMessages)` after `convertToLlm` each
 * turn to keep the log in sync.
 *
 * Example:
 * ```
 * const mgr = new AppendOnlyContextManager();
 * const ctx = mgr.build(context);  // first call snapshots prefix
 * mgr.syncMessages(normalized);    // grow the log
 * ctx = mgr.build(context);        // subsequent calls use cache
 * ```
 */
export class AppendOnlyContextManager {
	readonly prefix = new StablePrefix();
	readonly log = new AppendOnlyLog();
	/** How many normalized messages were synced into the log as of the last sync. */
	#lastSyncCount = 0;
	/**
	 * Per-message digests of the synced log. Lets a deep or tail rewrite
	 * (per-turn pruning, image strip, transformContext re-render) preserve
	 * the byte-stable prefix instead of re-sending the entire conversation
	 * — keeps the provider's prompt-cache hit rate up to the divergence
	 * point on every subsequent turn.
	 */
	#messageDigests: number[] = [];
	/**
	 * Digests memoized by message object identity, validated by the message's
	 * estimate version ({@link messageEstimateVersion}). Synced message objects
	 * are stable between calls: converted fragments are cached per session
	 * message identity and handed back unchanged on every call, so an unchanged
	 * history re-hits this memo instead of re-serializing every previously-
	 * synced message on each LLM call.
	 *
	 * Owner-side rewrites (prune/shake/strip-images) mutate messages IN PLACE
	 * under stable identity — for assistant pass-through fragments the log
	 * aliases the very object being mutated — so a bare identity memo would
	 * serve pre-mutation bytes forever. Those owners MUST call
	 * `invalidateMessageCache`, which bumps the symbol-keyed version tag
	 * this memo validates before every hit; a version mismatch recomputes from
	 * actual bytes and the sync diverges exactly as if a fresh object had
	 * arrived. Mutating a synced message without that bump violates the
	 * cache-coherence contract shared with the tokenizer and convert caches
	 * (see `compaction/message-cache.ts`) and is unsupported.
	 */
	#digestMemo = new WeakMap<object, { version: number; digest: number }>();

	build(context: AgentContext, options: BuildOptions): Context {
		this.prefix.build(context, options);
		const { systemPrompt, tools } = this.prefix.toContext();
		return { systemPrompt, messages: this.log.toMessages(), tools };
	}

	/**
	 * Sync normalized (provider-level) messages into the append-only log.
	 *
	 * Three cases:
	 *
	 * 1. **Append**: same prefix, new tail → push the new entries.
	 * 2. **Compaction**: shorter array → clear the log and replay.
	 * 3. **In-place rewrite** (per-turn pruning, transformContext re-render,
	 *    image strip, etc.): find the longest byte-stable prefix between
	 *    the previously-synced messages and the new ones, drop the log
	 *    down to that prefix, then append the diverged tail. Earlier
	 *    revisions cleared the whole log on any digest change, which on
	 *    llama.cpp / local backends forced a full ~40k-token re-prefill
	 *    every turn that an extension, prune pass, or steering re-wrap
	 *    rewrote a single message (#3406). Preserving the stable prefix
	 *    lets the provider's KV cache stay warm up to the divergence
	 *    point — the model only re-prefills from the changed message on.
	 */
	syncMessages(normalizedMessages: any[]): void {
		// Compaction (array shrunk) — every previously-synced message is gone,
		// so the log can't carry any byte-stable bytes forward.
		if (normalizedMessages.length < this.#lastSyncCount) {
			this.log.clear();
			this.#lastSyncCount = 0;
			this.#messageDigests = [];
		}

		// In-place rewrite: trim the log down to the longest byte-stable prefix
		// that both the previous sync and the new messages share. Bound it by
		// the current log length because `log.clear()` is public; direct clears
		// (advisor reset) can leave the sync cursor ahead of the physical log.
		// Anything past that point will be re-appended below with the new bytes.
		if (this.#lastSyncCount > 0) {
			const stableCount = Math.min(this.#longestStablePrefix(normalizedMessages), this.log.length);
			if (stableCount < this.#lastSyncCount) {
				this.log.truncate(stableCount);
				this.#lastSyncCount = stableCount;
				this.#messageDigests.length = stableCount;
			}
		}

		// Append the diverged tail (or the full delta on a normal turn).
		for (let i = this.#lastSyncCount; i < normalizedMessages.length; i++) {
			const msg = normalizedMessages[i];
			this.log.append(msg);
			this.#messageDigests.push(this.#messageDigest(msg));
		}
		this.#lastSyncCount = normalizedMessages.length;
	}

	/** Reset prefix + log for a model/provider switch while mode stays active. */
	invalidateForModelChange(): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
	}

	/** Reset the sync cursor AND clear the log. */
	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
	}

	appendMessage(message: any): void {
		this.log.append(message);
	}

	replaceTailMessage(message: any): void {
		this.log.replaceTail(message);
	}

	invalidate(): void {
		this.prefix.invalidate();
	}

	reset(context: AgentContext, options: BuildOptions): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
		this.prefix.build(context, options);
	}

	/** Index of the first message whose serialized bytes differ from the
	 * previously-synced log; equals `min(lastSyncCount, normalizedMessages.length)`
	 * when nothing diverged. */
	#longestStablePrefix(normalizedMessages: readonly unknown[]): number {
		const bound = Math.min(this.#lastSyncCount, normalizedMessages.length);
		for (let i = 0; i < bound; i++) {
			if (this.#messageDigest(normalizedMessages[i]) !== this.#messageDigests[i]) {
				return i;
			}
		}
		return bound;
	}

	/** Deterministic digest over every field the provider may serialize — role,
	 * content, provider-native replay payloads, tool calls (both `toolCalls` and
	 * OpenAI-wire `tool_calls`), tool-result ids/names/error flags (both internal
	 * camelCase and wire snake_case), and assistant `id` — so an in-place rewrite
	 * of *any* of these fields is visible to {@link #longestStablePrefix}. */
	#messageDigest(msg: unknown): number {
		if (!msg || typeof msg !== "object") return 0;
		const m = msg as Record<string, unknown>;
		const version = messageEstimateVersion(msg as AgentMessage);
		const cached = this.#digestMemo.get(m);
		if (cached !== undefined && cached.version === version) return cached.digest;
		const payload = JSON.stringify({
			r: m.role ?? null,
			c: m.content ?? null,
			pp: m.providerPayload ?? null,
			tc: m.toolCalls ?? m.tool_calls ?? null,
			tcid: m.toolCallId ?? m.tool_call_id ?? null,
			tn: m.toolName ?? m.name ?? null,
			err: m.isError ?? null,
			id: m.id ?? null,
		});
		let hash = 0;
		for (let j = 0; j < payload.length; j++) {
			hash = ((hash << 5) - hash + payload.charCodeAt(j)) | 0;
		}
		const hash32 = hash >>> 0;
		this.#digestMemo.set(m, { version, digest: hash32 });
		return hash32;
	}
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function takeSnapshot(context: AgentContext, options: BuildOptions): StablePrefixSnapshot {
	const systemPrompt = [...context.systemPrompt];
	const tools =
		normalizeTools(context.tools, {
			injectIntent: options.intentTracing,
			pruneDescriptions: options.pruneToolDescriptions,
		}) ?? [];
	return {
		systemPrompt,
		tools,
		fingerprint: computeFingerprint(systemPrompt, tools, options),
	};
}

function computeFingerprint(systemPrompt: string[], tools: Tool[], options: BuildOptions): string {
	const payload = JSON.stringify({
		s: systemPrompt,
		t: tools.map(t => ({
			n: t.name,
			d: t.description,
			p: t.parameters,
			s: t.strict,
			cf: t.customFormat,
			cw: t.customWireName,
		})),
		i: options.intentTracing,
		pd: options.pruneToolDescriptions,
	});
	let hash = 0;
	for (let i = 0; i < payload.length; i++) {
		hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}
