/**
 * P0.2 semantic codec rubric — atom/relation retention separate from derived claims.
 */

import {
	allPacketCitations,
	type EvidencePacketV2,
} from "../../../src/rlm/evidence-packet-v2";
import { citationWithinGrant, resolveCitationText, type EvidenceValidationResult } from "../../../src/rlm/evidence-validator";
import type { RlmStore } from "../../../src/rlm/store";
import type { RlmView } from "../../../src/rlm/view";
import type { LiveFixture } from "./live-groq-common";

export interface CodecMetrics {
	atomRecall: number;
	relationRecall: number;
	citationValidity: number;
	structuralValid: boolean;
	semanticRetention: number;
	compressionRatio: number;
	contradictionValid: boolean;
}

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

function atomMatchesSpec(
	atom: { key: string; value: string; citations: { handle: string; start: number; end: number }[] },
	spec: NonNullable<LiveFixture["requiredAtoms"]>[number],
	store: RlmStore,
	view: RlmView,
): boolean {
	if (!atom.citations.every(c => citationWithinGrant(view, store, c))) return false;
	const citedTexts = atom.citations
		.map(c => resolveCitationText(store, c))
		.filter((t): t is string => typeof t === "string");
	const grantOk = spec.grantTextPattern ? citedTexts.some(t => spec.grantTextPattern!.test(t)) : true;
	const keyOk = normalizeKey(atom.key) === normalizeKey(spec.key) || normalizeKey(atom.key).includes(normalizeKey(spec.key));
	if (!grantOk && !keyOk) return false;
	if (spec.valuePattern && !spec.valuePattern.test(atom.value) && !citedTexts.some(t => spec.valuePattern!.test(t))) {
		return false;
	}
	return grantOk || keyOk;
}

export function scoreAtomRecall(
	packet: EvidencePacketV2 | undefined,
	fixture: LiveFixture,
	store: RlmStore,
	view: RlmView,
): number {
	const specs = fixture.requiredAtoms ?? [];
	if (specs.length === 0) return 1;
	if (!packet) return 0;
	let matched = 0;
	for (const spec of specs) {
		if (packet.atoms.some(a => atomMatchesSpec(a, spec, store, view))) matched += 1;
	}
	return matched / specs.length;
}

export function scoreRelationRecall(
	packet: EvidencePacketV2 | undefined,
	fixture: LiveFixture,
): number {
	const specs = fixture.requiredRelations ?? [];
	if (specs.length === 0) return 1;
	if (!packet) return 0;
	let matched = 0;
	for (const spec of specs) {
		const keys = new Set(spec.atomKeys.map(normalizeKey));
		const atomKeysPresent = new Set(packet.atoms.filter(a => keys.has(normalizeKey(a.key))).map(a => a.id));
		const claimSupports = packet.claims.some(
			c =>
				spec.atomKeys.every(k => c.supports.some(s => normalizeKey(s) === normalizeKey(k) || atomKeysPresent.has(s))) ||
				(spec.pattern ? spec.pattern.test(c.fact) : false),
		);
		const causalAtoms = spec.atomKeys.every(k => packet.atoms.some(a => normalizeKey(a.key) === normalizeKey(k)));
		if (claimSupports || (causalAtoms && packet.claims.some(c => (spec.pattern ? spec.pattern.test(c.fact) : c.supports.length >= 2)))) {
			matched += 1;
		}
	}
	return matched / specs.length;
}

export function scoreContradictionValid(
	packet: EvidencePacketV2 | undefined,
	fixture: LiveFixture,
	store: RlmStore,
	view: RlmView,
): boolean {
	if (!fixture.requiredContradiction || !packet) return false;
	const { leftGrantPattern, rightGrantPattern } = fixture.requiredContradiction;
	for (const c of packet.contradictions) {
		const leftTexts = c.left.citations.map(x => resolveCitationText(store, x)).filter(Boolean) as string[];
		const rightTexts = c.right.citations.map(x => resolveCitationText(store, x)).filter(Boolean) as string[];
		if (!leftTexts.some(t => leftGrantPattern.test(t))) continue;
		if (!rightTexts.some(t => rightGrantPattern.test(t))) continue;
		if (c.left.value.trim().toLowerCase() === c.right.value.trim().toLowerCase()) continue;
		if (!c.left.citations.every(x => citationWithinGrant(view, store, x))) continue;
		if (!c.right.citations.every(x => citationWithinGrant(view, store, x))) continue;
		return true;
	}
	return false;
}

export function scoreCitationValidity(
	packet: EvidencePacketV2 | undefined,
	store: RlmStore,
	view: RlmView,
): number {
	if (!packet) return 0;
	const cites = allPacketCitations(packet);
	if (cites.length === 0) return 1;
	const valid = cites.filter(c => citationWithinGrant(view, store, c)).length;
	return valid / cites.length;
}

export function scoreSemanticRetention(metrics: Pick<CodecMetrics, "atomRecall" | "relationRecall">): number {
	return (metrics.atomRecall + metrics.relationRecall) / 2;
}

/** C-arm (prose) quality — same atom/relation specs as packet rubric, text-only. */
export function scoreProseAtomRecall(text: string, fixture: LiveFixture): number {
	const specs = fixture.requiredAtoms ?? [];
	if (specs.length === 0) {
		if (fixture.requiredFacts.length === 0) return 1;
		const lower = text.toLowerCase();
		const matched = fixture.requiredFacts.filter(f => lower.includes(f.toLowerCase())).length;
		return matched / fixture.requiredFacts.length;
	}
	const lower = text.toLowerCase();
	let matched = 0;
	for (const spec of specs) {
		const key = normalizeKey(spec.key);
		const keyHit = lower.includes(key) || lower.includes(key.replace(/_/g, " "));
		const patternHit = spec.grantTextPattern?.test(text) ?? false;
		const valueHit = spec.valuePattern?.test(text) ?? false;
		if (patternHit || (keyHit && (valueHit || !spec.valuePattern))) matched += 1;
	}
	return matched / specs.length;
}

export function scoreProseRelationRecall(text: string, fixture: LiveFixture): number {
	const specs = fixture.requiredRelations ?? [];
	if (specs.length === 0) return 1;
	let matched = 0;
	for (const spec of specs) {
		const keysPresent = spec.atomKeys.every(k => text.toLowerCase().includes(k.toLowerCase()));
		const patternHit = spec.pattern?.test(text) ?? false;
		if (patternHit || (keysPresent && spec.pattern === undefined)) matched += 1;
	}
	return matched / specs.length;
}

export function scoreProseContradictionValid(text: string, fixture: LiveFixture): boolean {
	if (!fixture.requiredContradiction) return true;
	const { leftGrantPattern, rightGrantPattern } = fixture.requiredContradiction;
	if (!leftGrantPattern.test(text) || !rightGrantPattern.test(text)) return false;
	const left = text.match(leftGrantPattern)?.[0]?.trim().toLowerCase();
	const right = text.match(rightGrantPattern)?.[0]?.trim().toLowerCase();
	return Boolean(left && right && left !== right);
}

export function computeProseMetrics(text: string, fixture: LiveFixture, grantedBytes: number): CodecMetrics {
	const atomRecall = scoreProseAtomRecall(text, fixture);
	const relationRecall = scoreProseRelationRecall(text, fixture);
	const semanticRetention = scoreSemanticRetention({ atomRecall, relationRecall });
	const answerBytes = Buffer.byteLength(text, "utf8");
	const compressionRatio = answerBytes > 0 ? grantedBytes / answerBytes : grantedBytes;
	const contradictionValid = scoreProseContradictionValid(text, fixture);
	return {
		atomRecall,
		relationRecall,
		citationValidity: 1,
		structuralValid: true,
		semanticRetention,
		compressionRatio,
		contradictionValid,
	};
}

export function computeCodecMetrics(
	packet: EvidencePacketV2 | undefined,
	fixture: LiveFixture,
	store: RlmStore,
	view: RlmView,
	validation: EvidenceValidationResult | undefined,
	grantedBytes: number,
): CodecMetrics {
	const atomRecall = scoreAtomRecall(packet, fixture, store, view);
	const relationRecall = scoreRelationRecall(packet, fixture);
	const citationValidity = validation?.citationValidity ?? scoreCitationValidity(packet, store, view);
	const structuralValid = validation?.structuralValid ?? false;
	const semanticRetention = scoreSemanticRetention({ atomRecall, relationRecall });
	const packetBytes = packet ? Buffer.byteLength(JSON.stringify(packet), "utf8") : 0;
	const compressionRatio = packetBytes > 0 ? grantedBytes / packetBytes : grantedBytes;
	const contradictionValid = fixture.requiredContradiction
		? scoreContradictionValid(packet, fixture, store, view)
		: true;
	return { atomRecall, relationRecall, citationValidity, structuralValid, semanticRetention, compressionRatio, contradictionValid };
}

/** P0.1 baseline (pre atom-rubric) for before/after reporting. */
export const P01_SMOKE_BASELINE: Record<
	string,
	{ semanticRetention: number; atomRecall: number; relationRecall: number; label: string }
> = {
	S1_sufficient_causal: { semanticRetention: 0, atomRecall: 0, relationRecall: 0, label: "MISSED_EVIDENCE" },
	S2_contradictory: { semanticRetention: 1, atomRecall: 1, relationRecall: 0, label: "UNSUPPORTED" },
	S3_insufficient: { semanticRetention: 1, atomRecall: 1, relationRecall: 1, label: "PARTIAL_OK" },
	coding_log_diagnosis: { semanticRetention: 1, atomRecall: 1, relationRecall: 1, label: "SUPPORTED" },
};
