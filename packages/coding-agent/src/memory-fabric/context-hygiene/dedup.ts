/**
 * Adaptive Context Hygiene — exact deduplication (ACF CH2).
 *
 * Removes *byte-identical* duplicate context items **before** any semantic or
 * lossy transform runs (ADAPTIVE_CONTEXT_FIDELITY_PLAN.md rule #3, §5 gate
 * order: reject → exact dedup → classify → …). This step is deliberately the
 * least clever transform in the pipeline: it only collapses items whose content
 * is identical character-for-character.
 *
 * Why this is safe for F0/F1 truth (plan §3, rules #1 and #13):
 *   - The surviving *canonical* item is byte-identical to every copy it absorbs,
 *     so no information — not one byte of a security warning, exit code, or
 *     verified decision — is ever lost. Dedup is *information-preserving*.
 *   - Provenance is never dropped: the origin id + source of every removed copy
 *     is merged onto the canonical (rule #1, "never change provenance").
 *   - Order is stable and first-wins, so nothing authoritative is reordered out
 *     of prominence (anti-burial friendly; plan §5).
 *   - Any error fails *open*: the original list is returned untouched (rule #4).
 *
 * This module is additive, injectable, and disabled by default — it is not
 * wired into memory-fabric/index.ts. Callers invoke it explicitly.
 */

import type { ContextItem, ItemProvenance } from "./types";

export const DEDUPER_NAME = "acf-exact-deduper";
export const DEDUPER_VERSION = "ch2-1";

/** Token estimate consistent with output-distillation (OD1): ceil(len / 4). */
function estimateTokens(length: number): number {
	return Math.ceil(length / 4);
}

/** A single duplicate that was merged into a canonical item. */
export interface MergedDuplicate {
	/** Origin id of the removed duplicate (retained provenance). */
	originId: string;
	/** Source of the removed duplicate, when known. */
	source?: string;
	/** Position of the removed duplicate in the original input list. */
	index: number;
}

/** Record of one dropped duplicate, returned for auditability. */
export interface RemovedRecord extends MergedDuplicate {
	/** Id of the canonical item this duplicate was merged into. */
	canonicalId: string;
}

/** A kept item, extended with a record of any duplicates it absorbed. */
export interface DedupedContextItem extends ContextItem {
	provenance: Partial<ItemProvenance> & {
		/** Duplicates merged into this canonical (empty when it absorbed none). */
		duplicatesMerged?: MergedDuplicate[];
		/** Deduper identity + timestamp, only stamped when duplicates merged. */
		deduper?: string;
		deduperVersion?: string;
		dedupedAt?: string;
	};
}

/** Deterministic before/after telemetry for the dedup step (rule #4). */
export interface DedupTelemetry {
	deduper: string;
	deduperVersion: string;
	inputCount: number;
	outputCount: number;
	removedCount: number;
	bytesBefore: number;
	bytesAfter: number;
	approxTokensBefore: number;
	approxTokensAfter: number;
	dedupedAt: string;
	/** True when the step caught an error and returned the input unchanged. */
	failedOpen: boolean;
}

export interface DedupResult {
	/** Kept items in original order (canonicals + protected + non-duplicates). */
	items: DedupedContextItem[];
	/** Duplicates removed, in input order. */
	removed: RemovedRecord[];
	telemetry: DedupTelemetry;
}

export interface DedupOptions {
	/**
	 * When true, two items are duplicates only if BOTH content and source match.
	 * Default false — content-only byte identity (a duplicate is a duplicate
	 * regardless of which lane surfaced it).
	 */
	scopeBySource?: boolean;
	/**
	 * Items for which this returns true are always retained (never removed as a
	 * duplicate). They may still act as a canonical so later non-protected
	 * identical items collapse into them. Default: protect no-compression zones
	 * (plan rule #15) so a marked-immutable item is never dropped.
	 */
	isProtected?: (item: ContextItem) => boolean;
	/**
	 * When true (default), items whose content is empty or whitespace-only are
	 * always retained and never treated as duplicates of one another — empty
	 * content carries meaning only through provenance, so collapsing empties
	 * would silently merge distinct items.
	 */
	skipEmpty?: boolean;
	/** Custom key extractor. Overrides scopeBySource when provided. */
	keyOf?: (item: ContextItem) => string;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

function defaultIsProtected(item: ContextItem): boolean {
	return item.noCompression === true;
}

function contentKey(item: ContextItem, scopeBySource: boolean): string {
	// NUL separator can't appear in normal text sources, so it is a safe joiner.
	return scopeBySource ? `${item.source ?? ""}\u0000${item.content}` : item.content;
}

function isEmptyContent(content: string): boolean {
	return content.trim().length === 0;
}

function byteLength(items: { content: string }[]): number {
	let total = 0;
	for (const it of items) total += it.content.length;
	return total;
}

/**
 * Remove byte-identical duplicate items, stable and first-wins.
 *
 * Guarantees:
 *   - Only exact (character-for-character) duplicates are removed.
 *   - The first occurrence is always kept as the canonical; later exact copies
 *     are dropped and their provenance merged onto the canonical.
 *   - Protected items (default: no-compression zones) are never dropped.
 *   - Fail-open: on any internal error the original list is returned unchanged.
 */
export function exactDedup(items: ContextItem[], options: DedupOptions = {}): DedupResult {
	const now = options.now ?? (() => new Date());
	const dedupedAt = now().toISOString();
	const inputCount = items.length;
	const bytesBefore = byteLength(items);

	try {
		const scopeBySource = options.scopeBySource ?? false;
		const skipEmpty = options.skipEmpty ?? true;
		const isProtected = options.isProtected ?? defaultIsProtected;
		const keyOf = options.keyOf ?? ((item: ContextItem) => contentKey(item, scopeBySource));

		// Map from dedup key -> index of the canonical item within `kept`.
		const canonicalByKey = new Map<string, number>();
		const kept: DedupedContextItem[] = [];
		const removed: RemovedRecord[] = [];

		for (let index = 0; index < items.length; index++) {
			const item = items[index];

			// Always retain empties (when skipEmpty) and protected items; they are
			// never removed as duplicates and never used as a shared canonical key.
			const alwaysKeep = (skipEmpty && isEmptyContent(item.content)) || isProtected(item);

			if (alwaysKeep) {
				kept.push(toDeduped(item));
				continue;
			}

			const key = keyOf(item);
			const canonicalIdx = canonicalByKey.get(key);

			if (canonicalIdx === undefined) {
				// First time we've seen this content: it becomes the canonical.
				canonicalByKey.set(key, kept.length);
				kept.push(toDeduped(item));
				continue;
			}

			// Exact duplicate: drop it and merge its provenance onto the canonical.
			const canonical = kept[canonicalIdx];
			const merged: MergedDuplicate = {
				originId: item.provenance?.originId ?? item.id,
				source: item.source ?? item.provenance?.source,
				index,
			};
			appendMerge(canonical, merged, dedupedAt);
			removed.push({ ...merged, canonicalId: canonical.id });
		}

		const bytesAfter = byteLength(kept);
		return {
			items: kept,
			removed,
			telemetry: {
				deduper: DEDUPER_NAME,
				deduperVersion: DEDUPER_VERSION,
				inputCount,
				outputCount: kept.length,
				removedCount: removed.length,
				bytesBefore,
				bytesAfter,
				approxTokensBefore: estimateTokens(bytesBefore),
				approxTokensAfter: estimateTokens(bytesAfter),
				dedupedAt,
				failedOpen: false,
			},
		};
	} catch {
		// Fail open (rule #4): emit the safe original, unchanged.
		const passthrough = items.map(toDeduped);
		return {
			items: passthrough,
			removed: [],
			telemetry: {
				deduper: DEDUPER_NAME,
				deduperVersion: DEDUPER_VERSION,
				inputCount,
				outputCount: passthrough.length,
				removedCount: 0,
				bytesBefore,
				bytesAfter: bytesBefore,
				approxTokensBefore: estimateTokens(bytesBefore),
				approxTokensAfter: estimateTokens(bytesBefore),
				dedupedAt,
				failedOpen: true,
			},
		};
	}
}

/** Shallow-clone an item into a DedupedContextItem without mutating input. */
function toDeduped(item: ContextItem): DedupedContextItem {
	const provenance: DedupedContextItem["provenance"] = { ...(item.provenance ?? {}) };
	if (provenance.originId === undefined) provenance.originId = item.id;
	if (provenance.source === undefined && item.source !== undefined) provenance.source = item.source;
	return { ...item, provenance };
}

/** Record a merged duplicate on the canonical (non-mutating on the original). */
function appendMerge(canonical: DedupedContextItem, merged: MergedDuplicate, dedupedAt: string): void {
	const list = canonical.provenance.duplicatesMerged ?? [];
	list.push(merged);
	canonical.provenance.duplicatesMerged = list;
	canonical.provenance.deduper = DEDUPER_NAME;
	canonical.provenance.deduperVersion = DEDUPER_VERSION;
	canonical.provenance.dedupedAt = dedupedAt;
}
