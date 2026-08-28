/**
 * Progressive Context Packets
 *
 * Tiered (L0-L4) memory injection: an initial packet loads the cheapest,
 * most continuity-critical tiers, and bounded expansion steps add deeper
 * tiers on demand. Pure and deterministic: retrieval is performed by the
 * caller (the tiered-retrieval broker), and these functions only compose,
 * deduplicate, and budget the results.
 *
 * Fixes over the original private-fabric engine:
 *  - Packet scope is carried on the descriptor, so expansions retrieve
 *    under the SAME project scope as the initial packet (the original
 *    expanded with an empty projectId - a cross-project leakage risk).
 *  - Deduplication uses memory IDs AND content hashes (the original built
 *    hash sets but never consulted them).
 *  - Representation is selected per item against the remaining budget
 *    (the original returned a deduplicated set of representation kinds
 *    whose length did not match the item list).
 *  - Tier placement comes from the lane adapters via
 *    RetrievedMemoryCandidate.tier (the original re-inferred tiers with an
 *    ordering bug that made its L2 procedure branch unreachable).
 */

import type { ContextExpansionRequest } from "./adaptive-fidelity/types";
import type { ContextTier, MemoryScope, RetrievedMemoryCandidate } from "./tiered-retrieval-types";

/** How much of an item's text is injected. */
export type PacketRepresentation = "compact" | "standard" | "expanded";

/** One memory item composed into a packet. */
export interface PacketItem {
	memoryId: string;
	tier: ContextTier;
	type: string;
	/** The representation chosen for this item under the current budget. */
	representation: PacketRepresentation;
	/** The rendered text of the chosen representation. */
	text: string;
	/** Token estimate of the chosen representation. */
	tokenEstimate: number;
	/** All three renderings, so a later pass may up- or down-grade. */
	texts: Record<PacketRepresentation, string>;
	tokenEstimates: Record<PacketRepresentation, number>;
	confidence: number;
	relevance: number;
	freshness: number;
	verification: string;
	contentHash: string;
	sourceReferences: string[];
}

/** A composed context packet with its expansion state. */
export interface PacketDescriptor {
	packetId: string;
	turnId: string;
	createdAt: string;
	/** Scope the packet was composed under. Expansions MUST reuse it. */
	scope: MemoryScope;
	allocatedTokens: number;
	usedTokens: number;
	remainingTokens: number;
	tiersLoaded: ContextTier[];
	items: PacketItem[];
	expansionsApplied: ContextExpansionRequest[];
	maxExpansions: number;
	stepTokens: number;
}

/** Tunables for packet composition. */
export interface ProgressivePacketConfig {
	/** Budget share of the initial (L0+L1) packet. Default 2500. */
	initialAllocationTokens: number;
	/** Maximum expansion steps per packet. Default 4. */
	maxExpansions: number;
	/** Token grant per expansion step. Default 4000. */
	stepTokens: number;
	/** Expansions smaller than this are not worth a retrieval. Default 200. */
	minExpansionTokens: number;
}

export const DEFAULT_PROGRESSIVE_PACKET_CONFIG: ProgressivePacketConfig = {
	initialAllocationTokens: 2500,
	maxExpansions: 4,
	stepTokens: 4000,
	minExpansionTokens: 200,
};

/** Tiers loaded by the initial packet. */
export const INITIAL_PACKET_TIERS: readonly ContextTier[] = ["L0", "L1"];

/** Identifiers for a new packet. Injectable so tests are deterministic. */
export interface PacketIds {
	packetId: string;
	turnId: string;
}

let packetCounter = 0;

/** Deterministic fallback ID source (monotonic counter, no randomness). */
function nextPacketIds(now: Date): PacketIds {
	packetCounter += 1;
	return {
		packetId: `pkt_${now.getTime()}_${packetCounter}`,
		turnId: `turn_${now.getTime()}_${packetCounter}`,
	};
}

/** Rough token estimate for rendered text (~4 characters per token). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** One-line rendering: id, verification marker, first 80 characters. */
export function renderCompact(candidate: RetrievedMemoryCandidate): string {
	const marker = candidate.verification === "user-confirmed" ? "[user-confirmed] " : "";
	return `${candidate.memoryId} ${marker}${candidate.content.slice(0, 80)}`.trim();
}

/** Standard rendering: header with real verification/status, truncated body. */
export function renderStandard(candidate: RetrievedMemoryCandidate): string {
	const lines = [
		`${candidate.memoryId} [${candidate.verification}, ${candidate.status}]`,
		`Type: ${candidate.type}`,
		`Content: ${candidate.content.slice(0, 200)}`,
		candidate.supersededBy ? `Superseded by: ${candidate.supersededBy}` : "",
	].filter(Boolean);
	return lines.join("\n");
}

/** Expanded rendering: full content plus provenance. */
export function renderExpanded(candidate: RetrievedMemoryCandidate): string {
	const lines = [
		`${candidate.memoryId} [${candidate.verification}, ${candidate.status}]`,
		`Type: ${candidate.type}`,
		`Content: ${candidate.content}`,
		candidate.supersededBy ? `Superseded by: ${candidate.supersededBy}` : "",
		candidate.sourceReferences.length ? `Sources: ${candidate.sourceReferences.join(", ")}` : "",
		`Confidence: ${candidate.confidence.toFixed(2)}  Importance: ${candidate.importance.toFixed(2)}`,
	].filter(Boolean);
	return lines.join("\n");
}

/**
 * Choose the richest representation that fits the remaining budget.
 * Expanded text must not consume more than half of what remains, so one
 * verbose record cannot crowd out the rest of the tier. Returns null when
 * not even the compact form fits.
 */
export function selectRepresentation(
	tokenEstimates: Record<PacketRepresentation, number>,
	remainingTokens: number,
): PacketRepresentation | null {
	if (tokenEstimates.expanded <= remainingTokens * 0.5) return "expanded";
	if (tokenEstimates.standard <= remainingTokens) return "standard";
	if (tokenEstimates.compact <= remainingTokens) return "compact";
	return null;
}

/** Ranking used when the budget cannot hold every candidate. */
function byRelevanceDesc(a: RetrievedMemoryCandidate, b: RetrievedMemoryCandidate): number {
	const scoreA = a.finalScore ?? a.fusedScore ?? a.confidence;
	const scoreB = b.finalScore ?? b.fusedScore ?? b.confidence;
	if (scoreA !== scoreB) return scoreB - scoreA;
	return a.memoryId.localeCompare(b.memoryId);
}

/** Inputs for composing packet items from retrieval candidates. */
export interface ComposePacketItemsOptions {
	/** Only candidates in these tiers are admitted. Empty means no filter. */
	tiers: readonly ContextTier[];
	tokenBudget: number;
	/** Memory IDs already loaded into the packet. */
	excludeMemoryIds?: ReadonlySet<string>;
	/** Content hashes already loaded into the packet. */
	excludeContentHashes?: ReadonlySet<string>;
}

/**
 * Compose packet items from candidates: filter by tier, deduplicate by
 * memory ID and content hash, rank by relevance, and greedily fill the
 * token budget choosing a per-item representation.
 */
export function composePacketItems(
	candidates: readonly RetrievedMemoryCandidate[],
	options: ComposePacketItemsOptions,
): PacketItem[] {
	const seenIds = new Set(options.excludeMemoryIds ?? []);
	const seenHashes = new Set(options.excludeContentHashes ?? []);
	const items: PacketItem[] = [];
	let used = 0;

	const admitted = candidates
		.filter(c => options.tiers.length === 0 || options.tiers.includes(c.tier))
		.slice()
		.sort(byRelevanceDesc);

	for (const candidate of admitted) {
		if (used >= options.tokenBudget) break;
		if (seenIds.has(candidate.memoryId)) continue;
		if (candidate.contentHash !== "" && seenHashes.has(candidate.contentHash)) continue;

		const texts: Record<PacketRepresentation, string> = {
			compact: renderCompact(candidate),
			standard: renderStandard(candidate),
			expanded: renderExpanded(candidate),
		};
		const tokenEstimates: Record<PacketRepresentation, number> = {
			compact: estimateTokens(texts.compact),
			standard: estimateTokens(texts.standard),
			expanded: estimateTokens(texts.expanded),
		};

		const representation = selectRepresentation(tokenEstimates, options.tokenBudget - used);
		if (representation === null) continue;

		items.push({
			memoryId: candidate.memoryId,
			tier: candidate.tier,
			type: candidate.type,
			representation,
			text: texts[representation],
			tokenEstimate: tokenEstimates[representation],
			texts,
			tokenEstimates,
			confidence: candidate.confidence,
			relevance: candidate.finalScore ?? candidate.fusedScore ?? candidate.confidence,
			freshness: candidate.freshness,
			verification: candidate.verification,
			contentHash: candidate.contentHash,
			sourceReferences: [...candidate.sourceReferences],
		});
		seenIds.add(candidate.memoryId);
		if (candidate.contentHash !== "") seenHashes.add(candidate.contentHash);
		used += tokenEstimates[representation];
	}

	return items;
}

/** Inputs for creating the initial packet. */
export interface CreateInitialPacketOptions {
	scope: MemoryScope;
	allocatedTokens: number;
	config?: Partial<ProgressivePacketConfig>;
	ids?: PacketIds;
	now?: () => Date;
}

/**
 * Compose the initial packet (L0 + L1) from already-retrieved candidates.
 * The initial allocation is capped by both the config and the total budget.
 */
export function createInitialPacket(
	candidates: readonly RetrievedMemoryCandidate[],
	options: CreateInitialPacketOptions,
): PacketDescriptor {
	const config = { ...DEFAULT_PROGRESSIVE_PACKET_CONFIG, ...options.config };
	const now = options.now ?? (() => new Date());
	const createdAt = now();
	const ids = options.ids ?? nextPacketIds(createdAt);

	const initialAllocation = Math.min(config.initialAllocationTokens, options.allocatedTokens);
	const items = composePacketItems(candidates, {
		tiers: INITIAL_PACKET_TIERS,
		tokenBudget: initialAllocation,
	});
	const usedTokens = items.reduce((sum, item) => sum + item.tokenEstimate, 0);

	return {
		packetId: ids.packetId,
		turnId: ids.turnId,
		createdAt: createdAt.toISOString(),
		scope: options.scope,
		allocatedTokens: options.allocatedTokens,
		usedTokens,
		remainingTokens: Math.max(0, options.allocatedTokens - usedTokens),
		tiersLoaded: [...INITIAL_PACKET_TIERS],
		items,
		expansionsApplied: [],
		maxExpansions: config.maxExpansions,
		stepTokens: config.stepTokens,
	};
}

/**
 * Expand a packet with additional tiers from already-retrieved candidates.
 *
 * The caller must retrieve `candidates` under `packet.scope` (never a fresh
 * or empty scope). Returns null when expansion is exhausted, the budget is
 * spent, the step is too small to be useful, or nothing new was admitted.
 */
export function expandPacket(
	packet: PacketDescriptor,
	request: ContextExpansionRequest,
	candidates: readonly RetrievedMemoryCandidate[],
	config?: Partial<ProgressivePacketConfig>,
): PacketDescriptor | null {
	const effective = { ...DEFAULT_PROGRESSIVE_PACKET_CONFIG, ...config };
	if (packet.expansionsApplied.length >= packet.maxExpansions) return null;
	if (packet.remainingTokens <= 0) return null;

	const maxTokens = Math.min(request.maximumAdditionalTokens, packet.remainingTokens, packet.stepTokens);
	if (maxTokens < effective.minExpansionTokens) return null;

	const loadedIds = new Set(packet.items.map(item => item.memoryId));
	const loadedHashes = new Set(packet.items.map(item => item.contentHash).filter(hash => hash !== ""));

	const newItems = composePacketItems(candidates, {
		tiers: request.requestedTiers,
		tokenBudget: maxTokens,
		excludeMemoryIds: loadedIds,
		excludeContentHashes: loadedHashes,
	});
	if (newItems.length === 0) return null;

	const addedTokens = newItems.reduce((sum, item) => sum + item.tokenEstimate, 0);
	const usedTokens = packet.usedTokens + addedTokens;

	return {
		...packet,
		usedTokens,
		remainingTokens: Math.max(0, packet.allocatedTokens - usedTokens),
		tiersLoaded: [...new Set([...packet.tiersLoaded, ...request.requestedTiers])],
		items: [...packet.items, ...newItems],
		expansionsApplied: [...packet.expansionsApplied, request],
	};
}

/** A short deterministic one-line summary (for logs/telemetry). */
export function summarizePacket(packet: PacketDescriptor): string {
	const tiers = packet.tiersLoaded.join(",");
	return (
		`packet ${packet.packetId}: items=${packet.items.length} tiers=[${tiers}] ` +
		`used=${packet.usedTokens}/${packet.allocatedTokens} expansions=${packet.expansionsApplied.length}`
	);
}

/** Memory precision: relevant injected / total injected. */
export interface MemoryPrecision {
	relevantInjected: number;
	totalInjected: number;
	precision: number;
}

export function computeMemoryPrecision(relevantInjected: number, totalInjected: number): MemoryPrecision {
	return {
		relevantInjected,
		totalInjected,
		precision: totalInjected > 0 ? relevantInjected / totalInjected : 0,
	};
}

/** Memory recall: relevant injected / total relevant available. */
export interface MemoryRecall {
	relevantInjected: number;
	totalRelevantAvailable: number;
	recall: number;
}

export function computeMemoryRecall(relevantInjected: number, totalRelevantAvailable: number): MemoryRecall {
	return {
		relevantInjected,
		totalRelevantAvailable,
		recall: totalRelevantAvailable > 0 ? relevantInjected / totalRelevantAvailable : 0,
	};
}

/** Context utilization: used tokens / allocated tokens (clamped to 1). */
export interface ContextUtilization {
	usedTokens: number;
	allocatedTokens: number;
	utilization: number;
}

export function computeContextUtilization(usedTokens: number, allocatedTokens: number): ContextUtilization {
	return {
		usedTokens,
		allocatedTokens,
		utilization: allocatedTokens > 0 ? Math.min(1, usedTokens / allocatedTokens) : 0,
	};
}

/** Token utilization: memory tokens / (memory + non-memory tokens). */
export interface TokenUtilization {
	memoryTokens: number;
	nonMemoryTokens: number;
	tokenUtilization: number;
}

export function computeTokenUtilization(memoryTokens: number, nonMemoryTokens: number): TokenUtilization {
	const total = memoryTokens + nonMemoryTokens;
	return {
		memoryTokens,
		nonMemoryTokens,
		tokenUtilization: total > 0 ? memoryTokens / total : 0,
	};
}

/** Harm rate: decisions influenced by false memory / total influenced. */
export interface HarmRate {
	falseMemoryInfluenced: number;
	totalInfluenced: number;
	harmRate: number;
}

export function computeHarmRate(falseMemoryInfluenced: number, totalInfluenced: number): HarmRate {
	return {
		falseMemoryInfluenced,
		totalInfluenced,
		harmRate: totalInfluenced > 0 ? falseMemoryInfluenced / totalInfluenced : 0,
	};
}
