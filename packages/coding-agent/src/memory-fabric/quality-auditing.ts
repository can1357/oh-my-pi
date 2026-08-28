/**
 * Quality controls & auditing.
 *
 * Cross-cutting quality primitives for the memory fabric:
 * - time-based confidence decay per verification tier
 * - contradiction detection between active records in the same project
 * - audit log formatting (JSON/JSONL) — callers own any file IO
 * - provenance string formatting for diagnostics
 * - quota & rate-limit enforcement with an injectable clock
 *
 * Pure and deterministic: no filesystem, no network, no ambient clock —
 * `QuotaEnforcer` takes its clock as a constructor port so hosts and tests
 * control time.
 */

import type { MemoryRecord, MemoryVerification } from "./types";

/**
 * Structural view of a journal event accepted by the audit-log formatter.
 * Matches the persistence layer's `JournalEvent` shape without importing it,
 * so this module stays free of storage dependencies.
 */
export interface AuditableEvent {
	seq: number;
	type: string;
	recordId?: string;
	timestamp: string;
	payload: Record<string, unknown>;
}

/** Half-life in days for each verification tier of the decay curve. */
export const VERIFICATION_HALF_LIVES_DAYS: Record<MemoryVerification, number> = {
	observed: 30,
	"user-confirmed": 180,
	"model-proposed": 7,
	superseded: 3,
	contradicted: 1,
	archived: 90,
};

/**
 * Exponential confidence decay: half of the original confidence remains after
 * one half-life. Output is rounded to 4 decimals and clamped to [0.01, 1] so
 * a decayed record never reaches exactly zero (it stays rankable for review).
 * Non-finite or negative ages are treated as zero age.
 */
export function computeDecayedConfidence(
	originalConfidence: number,
	verification: MemoryVerification,
	ageDays: number,
): number {
	const halfLifeDays = VERIFICATION_HALF_LIVES_DAYS[verification];
	const age = Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0;
	const decayed = originalConfidence * Math.exp((-Math.LN2 / halfLifeDays) * age);
	return Math.max(0.01, Math.min(1, Number(decayed.toFixed(4))));
}

/** A detected contradiction between two records on a shared topic. */
export interface ContradictionFinding {
	recordA: MemoryRecord;
	recordB: MemoryRecord;
	reason: string;
	confidence: number;
}

/** Verification states already resolved — excluded from contradiction scans. */
const INACTIVE_VERIFICATIONS: ReadonlySet<MemoryVerification> = new Set(["superseded", "contradicted", "archived"]);

/**
 * Opposing directive pairs. Word-boundary regexes prevent substring false
 * positives ("disable" contains "enable" as a substring); a text counts as
 * *positive* only when it does not also match the negative form, so two
 * "must not" records never flag each other.
 */
const OPPOSING_DIRECTIVES: ReadonlyArray<{ positive: RegExp; negative: RegExp }> = [
	{ positive: /\benable\b/, negative: /\bdisable\b/ },
	{ positive: /\bmust\b/, negative: /\bmust not\b/ },
	{ positive: /\balways\b/, negative: /\bnever\b/ },
	{ positive: /\buse\b/, negative: /\bdo not use\b/ },
];

function hasOpposingDirectives(textA: string, textB: string): boolean {
	for (const { positive, negative } of OPPOSING_DIRECTIVES) {
		const aNegative = negative.test(textA);
		const bNegative = negative.test(textB);
		const aPositive = positive.test(textA) && !aNegative;
		const bPositive = positive.test(textB) && !bNegative;
		if ((aPositive && bNegative) || (aNegative && bPositive)) return true;
	}
	return false;
}

function significantWords(text: string): Set<string> {
	return new Set(text.split(/\s+/).filter(word => word.length > 3));
}

/**
 * Scan records for contradictory directives on a shared topic. Symmetric: a
 * pair is flagged regardless of which record carries the negated form. Pairs
 * are only compared within the same project, and records whose verification
 * is already resolved (superseded/contradicted/archived) are skipped.
 */
export function detectContradictions(records: ReadonlyArray<MemoryRecord>): ContradictionFinding[] {
	const findings: ContradictionFinding[] = [];
	for (let i = 0; i < records.length; i++) {
		const a = records[i];
		if (!a || INACTIVE_VERIFICATIONS.has(a.verification)) continue;
		const textA = a.content.toLowerCase();
		const wordsA = significantWords(textA);
		for (let j = i + 1; j < records.length; j++) {
			const b = records[j];
			if (!b || INACTIVE_VERIFICATIONS.has(b.verification)) continue;
			if (a.projectId !== b.projectId) continue;
			const textB = b.content.toLowerCase();
			if (!hasOpposingDirectives(textA, textB)) continue;
			let sharedTerms = 0;
			for (const word of significantWords(textB)) {
				if (wordsA.has(word)) sharedTerms++;
			}
			if (sharedTerms >= 2) {
				findings.push({
					recordA: a,
					recordB: b,
					reason: `Contradictory directives detected on shared topic (shared terms: ${sharedTerms})`,
					confidence: 0.85,
				});
			}
		}
	}
	return findings;
}

/** Serialization format for audit-log export. */
export type AuditLogFormat = "json" | "jsonl";

/**
 * Format journal events for audit export. Pure string transform — the caller
 * decides where the output goes (file, stream, response body).
 */
export function formatAuditLog(events: ReadonlyArray<AuditableEvent>, format: AuditLogFormat): string {
	if (format === "json") return JSON.stringify(events, null, 2);
	return events.map(event => JSON.stringify(event)).join("\n");
}

/** One-line provenance summary per record, joined for diagnostics output. */
export function formatProvenanceString(records: ReadonlyArray<MemoryRecord>): string {
	if (records.length === 0) return "";
	return records.map(r => `${r.id}=>${r.verification} | ${r.type} | ${r.tags.join(",")}`).join(" ; ");
}

/** Quota limits applied per project scope. */
export interface QuotaConfig {
	maxRecordsPerProject: number;
	maxSizeBytesPerProject: number;
	maxWritesPerMinute: number;
}

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = {
	maxRecordsPerProject: 10000,
	maxSizeBytesPerProject: 100 * 1024 * 1024,
	maxWritesPerMinute: 300,
};

/** Outcome of a quota check. `reason` is present only when denied. */
export interface QuotaDecision {
	allowed: boolean;
	reason?: string;
}

const RATE_WINDOW_MS = 60000;

/**
 * Quota & rate-limit gate for record writes. The clock is injected so hosts
 * and tests control time; only permitted writes consume rate-window slots.
 */
export class QuotaEnforcer {
	readonly #config: QuotaConfig;
	readonly #now: () => number;
	#writeTimestamps: number[] = [];

	constructor(config: Partial<QuotaConfig> = {}, now: () => number = Date.now) {
		this.#config = { ...DEFAULT_QUOTA_CONFIG, ...config };
		this.#now = now;
	}

	/** Check whether one more record write is permitted right now. */
	checkQuota(currentRecordCount: number, estimatedStorageBytes: number): QuotaDecision {
		const now = this.#now();
		this.#writeTimestamps = this.#writeTimestamps.filter(t => now - t < RATE_WINDOW_MS);

		if (this.#writeTimestamps.length >= this.#config.maxWritesPerMinute) {
			return {
				allowed: false,
				reason: `Rate limit exceeded: max ${this.#config.maxWritesPerMinute} writes per minute`,
			};
		}
		if (currentRecordCount >= this.#config.maxRecordsPerProject) {
			return {
				allowed: false,
				reason: `Record count quota exceeded: max ${this.#config.maxRecordsPerProject} records per project`,
			};
		}
		if (estimatedStorageBytes >= this.#config.maxSizeBytesPerProject) {
			return {
				allowed: false,
				reason: `Storage quota exceeded: max ${this.#config.maxSizeBytesPerProject} bytes per project`,
			};
		}

		this.#writeTimestamps.push(now);
		return { allowed: true };
	}
}
