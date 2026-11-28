/**
 * Unified Mention Engine: coordinates Tier 0 sync sources, prefix-narrowing
 * continuity, parallel abortable Tier 1/2 async fan-out with 16ms coalesced
 * partial updates, Intent Arbitration, and completion application.
 */
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { AUTO_THINKING } from "../../thinking/levels";
import { subsequenceMatch } from "../tokens";
import { arbitrateMentions, type ArbitratedMentions } from "./arbiter";
import { parseMentionQuery } from "./parse";
import { AgentsMentionSource, type AgentsMentionHost } from "./sources/agents";
import { FilesMentionSource } from "./sources/files";
import { ForgeMentionSource } from "./sources/forge";
import { McpMentionSource } from "./sources/mcp";
import { ModelsMentionSource, type ModelsMentionHost } from "./sources/models";
import { SessionsMentionSource } from "./sources/sessions";
import { SshMentionSource } from "./sources/ssh";
import { VcsMentionSource } from "./sources/vcs";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionCategoryId,
	type MentionItem,
	type MentionPaletteView,
	type MentionQuery,
	type MentionSource,
	type MentionSourceMeta,
	type MentionSourceResult,
} from "./types";

const COALESCE_MS = 16;

export interface UnifiedMentionSnapshot {
	readonly items: readonly MentionItem[];
	readonly prefix: string;
	readonly mention: MentionPaletteView;
	readonly query: MentionQuery;
	readonly hasAsyncPending: boolean;
}

export interface UnifiedMentionEngineOptions {
	readonly getBasePath: () => string;
	readonly getCurrentSessionId?: () => string | undefined;
	readonly models?: ModelsMentionHost;
	readonly agents?: AgentsMentionHost;
	readonly recentFiles?: () => readonly string[];
	/** Custom sources for testing; overrides default built-in sources when supplied. */
	readonly sources?: readonly MentionSource[];
}

/**
 * Coordinates all mention categories behind `@`, `^`, and `#<N>`.
 *
 * Frame 0 is always synchronous (<2ms). Slow async sources (deep `fuzzyFind`,
 * cold git snapshot, gated `gh` search) stream updates via `onPartial` without
 * blocking fast categories or flickering blank frames on prefix extensions.
 */
export class UnifiedMentionEngine {
	readonly #sources: readonly MentionSource[];
	readonly #sourceMetas: readonly MentionSourceMeta[];
	readonly #modelsSource?: ModelsMentionSource;
	readonly #filesSource?: FilesMentionSource;
	#lastPrefix?: string;
	#lastResults?: ReadonlyMap<MentionCategoryId, MentionSourceResult>;

	constructor(options: UnifiedMentionEngineOptions) {
		if (options.sources) {
			this.#sources = options.sources;
			this.#sourceMetas = options.sources.map(s => ({ id: s.id, label: s.label }));
			return;
		}
		const vcsSource = new VcsMentionSource(options.getBasePath);
		const filesSource = new FilesMentionSource({
			getBasePath: options.getBasePath,
			dirtyFiles: () => vcsSource.dirtyFiles(),
			recentFiles: options.recentFiles,
		});
		const agentsSource = new AgentsMentionSource(options.agents);
		const sessionsSource = new SessionsMentionSource({
			getCwd: options.getBasePath,
			getCurrentSessionId: options.getCurrentSessionId,
		});
		const forgeSource = new ForgeMentionSource(options.getBasePath);
		const sources: MentionSource[] = [filesSource];
		if (options.models) {
			this.#modelsSource = new ModelsMentionSource(options.models);
			sources.push(this.#modelsSource);
		}
		sources.push(
			agentsSource,
			sessionsSource,
			vcsSource,
			forgeSource,
			new McpMentionSource(),
			new SshMentionSource({ getCwd: options.getBasePath }),
		);
		this.#filesSource = filesSource;
		this.#sources = sources;
		this.#sourceMetas = sources.map(s => ({ id: s.id, label: s.label }));
	}

	/** Pre-warm background caches (cwd dir listing, VCS snapshot, GitHub index). */
	warm(): void {
		for (const source of this.#sources) source.warm?.();
	}

	/**
	 * Parse the live mention token before the caret using live provider/dir hints. `lock` holds an
	 * `@` token its syntax leaves open to one category (the Files scope, which has no token).
	 */
	parse(textBeforeCursor: string, lock?: MentionCategoryId): MentionQuery | null {
		const query = parseMentionQuery(textBeforeCursor, {
			isKnownProvider: this.#modelsSource ? head => this.#modelsSource!.hasProviderPrefix(head) : undefined,
			isKnownDir: this.#filesSource ? head => this.#filesSource!.isKnownDirSync(head) : undefined,
		});
		if (!query || !lock || query.trigger !== "@" || query.syntaxLock) return query;
		return { ...query, syntaxLock: lock };
	}

	/** Run Tier 0 / warm-cache query synchronously for 0ms frame-0 painting. */
	querySync(
		lines: readonly string[],
		cursorLine: number,
		cursorCol: number,
		lock?: MentionCategoryId,
	): UnifiedMentionSnapshot | null {
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const query = this.parse(textBeforeCursor, lock);
		if (!query) return null;
		const { results, hasAsyncPending } = this.#collectSyncResults(query);
		const arbitrated = arbitrateMentions(query, [...results.values()], this.#sourceMetas);
		this.#rememberPrefix(query.prefix, results);
		return {
			items: arbitrated.items,
			prefix: query.prefix,
			mention: arbitrated.palette,
			query,
			hasAsyncPending,
		};
	}

	/**
	 * Run sync + parallel abortable async refinement across unsuppressed sources,
	 * coalescing incoming updates into 16ms batches via `onPartial`.
	 */
	async queryAsync(
		lines: readonly string[],
		cursorLine: number,
		cursorCol: number,
		signal: AbortSignal | undefined,
		onPartial?: (snapshot: UnifiedMentionSnapshot) => void,
		lock?: MentionCategoryId,
	): Promise<UnifiedMentionSnapshot | null> {
		if (signal?.aborted) return null;
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const query = this.parse(textBeforeCursor, lock);
		if (!query) return null;

		const { results, asyncSources } = this.#collectSyncResults(query);
		this.#rememberPrefix(query.prefix, results);

		const emit = (pendingCount: number): UnifiedMentionSnapshot => {
			const arbitrated: ArbitratedMentions = arbitrateMentions(query, [...results.values()], this.#sourceMetas);
			return {
				items: arbitrated.items,
				prefix: query.prefix,
				mention: arbitrated.palette,
				query,
				hasAsyncPending: pendingCount > 0,
			};
		};

		if (asyncSources.length === 0) {
			return emit(0);
		}

		// Emit frame 0 immediately if sync sources already have rows or are loading.
		const initial = emit(asyncSources.length);
		if (initial.items.length > 0 || initial.mention.loading) {
			onPartial?.(initial);
		}

		const localController = new AbortController();
		const onAbort = () => localController.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		let pending = asyncSources.length;
		let flushTimer: NodeJS.Timeout | undefined;
		let dirty = false;

		const flushPartial = () => {
			clearTimeout(flushTimer);
			flushTimer = undefined;
			if (!dirty || localController.signal.aborted) return;
			dirty = false;
			this.#rememberPrefix(query.prefix, results);
			onPartial?.(emit(pending));
		};

		const scheduleFlush = () => {
			dirty = true;
			if (flushTimer === undefined) {
				flushTimer = setTimeout(flushPartial, COALESCE_MS);
			}
		};

		try {
			await Promise.all(
				asyncSources.map(async source => {
					try {
						const final = await source.queryAsync!(query, localController.signal, partial => {
							if (localController.signal.aborted) return;
							results.set(source.id, partial);
							scheduleFlush();
						});
						if (localController.signal.aborted) return;
						if (final) {
							results.set(source.id, final);
							scheduleFlush();
						} else {
							// Clear loading flag if async pass returned no change.
							const prev = results.get(source.id);
							if (prev?.loading) {
								results.set(source.id, { ...prev, loading: false });
								scheduleFlush();
							}
						}
					} catch {
						const prev = results.get(source.id);
						if (prev?.loading) {
							results.set(source.id, { ...prev, loading: false });
							scheduleFlush();
						}
					} finally {
						pending--;
					}
				}),
			);
		} finally {
			clearTimeout(flushTimer);
			signal?.removeEventListener("abort", onAbort);
		}

		if (signal?.aborted) return null;
		this.#rememberPrefix(query.prefix, results);
		return emit(0);
	}

	/** Apply a chosen mention item (with optional thinking-effort override for model rows). */
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: MentionItem,
		prefix: string,
		effortOverride?: Effort | "auto",
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const afterCursor = currentLine.slice(cursorCol);
		const liveQuery = this.parse(textBeforeCursor);
		const livePrefix = liveQuery?.prefix ?? prefix;
		const prefixStart = Math.max(0, cursorCol - livePrefix.length);

		let insertText = item.insertText;
		if (item.modelEffort && effortOverride !== undefined) {
			insertText =
				effortOverride === AUTO_THINKING
					? `^${item.modelEffort.selector}`
					: `^${item.modelEffort.selector}:${effortOverride}`;
		}
		const suffix = item.appendSpace === false || item.isDirectory || item.isNamespaceShortcut ? "" : " ";
		const replacement = `${insertText}${suffix}`;
		const newLines = [...lines];
		newLines[cursorLine] = `${currentLine.slice(0, prefixStart)}${replacement}${afterCursor}`;
		return {
			lines: newLines,
			cursorLine,
			cursorCol: prefixStart + replacement.length,
		};
	}

	#collectSyncResults(query: MentionQuery): {
		results: Map<MentionCategoryId, MentionSourceResult>;
		asyncSources: MentionSource[];
		hasAsyncPending: boolean;
	} {
		const results = new Map<MentionCategoryId, MentionSourceResult>();
		const asyncSources: MentionSource[] = [];
		const explicitLock = query.syntaxLock;
		const canNarrowPrevious =
			this.#lastPrefix !== undefined &&
			this.#lastResults !== undefined &&
			query.prefix.length > this.#lastPrefix.length &&
			query.prefix.startsWith(this.#lastPrefix);

		for (const source of this.#sources) {
			let res: MentionSourceResult;
			try {
				res = source.querySync(query);
			} catch {
				res = { category: source.id, items: [], bestTier: MATCH_TIER.None, total: 0, available: false };
			}

			// Prefix-narrowing continuity: if sync returned empty while async is loading
			// (e.g. deep file from fuzzyFind), filter previous snapshot's hits synchronously
			// so keystrokes never flash a blank frame.
			if (canNarrowPrevious && res.loading && res.items.length === 0) {
				const prev = this.#lastResults!.get(source.id);
				if (prev && prev.items.length > 0) {
					const qLower = query.query.toLowerCase();
					const narrowed = prev.items.filter(
						item =>
							subsequenceMatch(qLower, item.label.toLowerCase()) ||
							subsequenceMatch(qLower, (item.description ?? "").toLowerCase()),
					);
					if (narrowed.length > 0) {
						res = {
							...res,
							items: narrowed,
							bestTier: narrowed.reduce<MatchTier>((b, i) => (i.tier < b ? i.tier : b), MATCH_TIER.None),
							total: narrowed.length,
						};
					}
				}
			}

			const suppressed = explicitLock !== undefined && explicitLock !== source.id;
			if (suppressed && res.loading) {
				res = { ...res, loading: false };
			}
			results.set(source.id, res);

			if (!suppressed && source.queryAsync && (res.available || explicitLock === source.id)) {
				// Only launch async work when the source actually needs it (loading or explicitly scoped).
				if (res.loading || source.id === "files" || source.id === "models" || explicitLock === source.id) {
					asyncSources.push(source);
				}
			}
		}

		return { results, asyncSources, hasAsyncPending: asyncSources.length > 0 };
	}

	#rememberPrefix(prefix: string, results: ReadonlyMap<MentionCategoryId, MentionSourceResult>): void {
		this.#lastPrefix = prefix;
		this.#lastResults = new Map(results);
	}
}
