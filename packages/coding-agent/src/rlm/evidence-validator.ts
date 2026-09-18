/**
 * Deterministic post-validator for EvidencePacketV2 before root handoff.
 */

import {
	allPacketCitations,
	EVIDENCE_PACKET_MAX_OUTPUT_BYTES,
	evidencePacketByteSize,
	type EvidenceCitationV2,
	type EvidenceContradictionV2,
	type EvidencePacketV2,
} from "./evidence-packet-v2";
import { formatHandle, normalizeHandle, type RlmStore } from "./store";
import type { RlmView } from "./view";

export interface EvidenceValidationViolation {
	kind:
		| "ungranted_handle"
		| "citation_out_of_grant"
		| "atom_missing_citation"
		| "claim_missing_support"
		| "unknown_atom_id"
		| "contradiction_missing_citation"
		| "contradiction_identical_sides"
		| "status_inconsistent"
		| "packet_too_large";
	detail: string;
}

export interface EvidenceValidationResult {
	ok: boolean;
	structuralValid: boolean;
	citationValidity: number;
	violations: EvidenceValidationViolation[];
	validCitationCount: number;
	totalCitationCount: number;
}

export interface EvidenceValidationOptions {
	maxOutputBytes?: number;
}

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function grantsForHandle(view: RlmView, handle: string) {
	const id = normalizeHandle(handle);
	return view.grants.filter(g => normalizeHandle(g.handle) === id || normalizeHandle(g.recordId) === id);
}

function findGrant(view: RlmView, handle: string) {
	return grantsForHandle(view, handle)[0];
}

/** Resolve cited substring from store (full record bytes, not capped excerpt). */
export function resolveCitationText(store: RlmStore, cite: EvidenceCitationV2): string | null {
	const rec = store.get(cite.handle);
	if (!rec) return null;
	if (cite.start < 0 || cite.end > rec.text.length || cite.start >= cite.end) return null;
	return rec.text.slice(cite.start, cite.end);
}

export function citationWithinGrant(view: RlmView, store: RlmStore, cite: EvidenceCitationV2): boolean {
	const grants = grantsForHandle(view, cite.handle);
	if (grants.length === 0) return false;
	const rec = store.get(grants[0]!.handle);
	if (!rec) return false;
	if (cite.start < 0 || cite.end > rec.text.length || cite.start >= cite.end) return false;
	return grants.some(g => cite.start >= g.start && cite.end <= g.end);
}

function sideHasValidCitation(
	side: EvidenceContradictionV2["left"],
	view: RlmView,
	store: RlmStore,
): boolean {
	return side.citations.length > 0 && side.citations.every(c => citationWithinGrant(view, store, c));
}

export function validateEvidencePacket(
	store: RlmStore,
	view: RlmView,
	packet: EvidencePacketV2,
	options?: EvidenceValidationOptions,
): EvidenceValidationResult {
	const violations: EvidenceValidationViolation[] = [];
	const maxBytes = options?.maxOutputBytes ?? EVIDENCE_PACKET_MAX_OUTPUT_BYTES;
	const atomIds = new Set(packet.atoms.map(a => a.id));

	let validCitationCount = 0;
	let totalCitationCount = 0;

	const checkCitation = (cite: EvidenceCitationV2, context: string): void => {
		totalCitationCount += 1;
		const grants = grantsForHandle(view, cite.handle);
		if (grants.length === 0) {
			violations.push({
				kind: "ungranted_handle",
				detail: `${context}: ungranted handle ${formatHandle(normalizeHandle(cite.handle))}`,
			});
			return;
		}
		if (!citationWithinGrant(view, store, cite)) {
			violations.push({
				kind: "citation_out_of_grant",
				detail: `${context}: citation ${cite.handle}[${cite.start}:${cite.end}] outside granted range`,
			});
			return;
		}
		validCitationCount += 1;
	};

	for (const atom of packet.atoms) {
		if (atom.citations.length === 0) {
			violations.push({ kind: "atom_missing_citation", detail: `atom ${atom.id} has no citations` });
		}
		for (const cite of atom.citations) checkCitation(cite, `atom ${atom.id}`);
	}

	for (const claim of packet.claims) {
		for (const cite of claim.citations) checkCitation(cite, `claim`);
		for (const supportId of claim.supports) {
			if (!atomIds.has(supportId)) {
				violations.push({ kind: "unknown_atom_id", detail: `claim references unknown atom id ${supportId}` });
			}
		}
		if (claim.citations.length === 0 && claim.supports.length === 0) {
			violations.push({ kind: "claim_missing_support", detail: "claim has neither citations nor supports" });
		}
	}

	for (const [i, contradiction] of packet.contradictions.entries()) {
		if (!sideHasValidCitation(contradiction.left, view, store)) {
			violations.push({
				kind: "contradiction_missing_citation",
				detail: `contradiction[${i}] left side missing valid citation`,
			});
		}
		if (!sideHasValidCitation(contradiction.right, view, store)) {
			violations.push({
				kind: "contradiction_missing_citation",
				detail: `contradiction[${i}] right side missing valid citation`,
			});
		}
		if (normalizeText(contradiction.left.value) === normalizeText(contradiction.right.value)) {
			violations.push({
				kind: "contradiction_identical_sides",
				detail: `contradiction[${i}] left/right values are identical after normalization`,
			});
		}
		for (const cite of contradiction.left.citations) checkCitation(cite, `contradiction[${i}].left`);
		for (const cite of contradiction.right.citations) checkCitation(cite, `contradiction[${i}].right`);
	}
	const hasUsefulEvidence =
		packet.atoms.some(a => a.citations.length > 0) ||
		packet.claims.some(c => c.citations.length > 0 || c.supports.length > 0);

	if (packet.status === "sufficient" && !hasUsefulEvidence) {
		violations.push({
			kind: "status_inconsistent",
			detail: "status=sufficient but packet contains no useful cited atoms/claims",
		});
	}

	if (packet.status === "abstain") {
		const strongClaims = packet.claims.filter(c => c.confidence >= 0.7);
		if (strongClaims.length > 0) {
			violations.push({
				kind: "status_inconsistent",
				detail: "status=abstain but high-confidence positive claims present",
			});
		}
	}

	if (packet.status === "partial" && packet.missingEvidence.length === 0 && !hasUsefulEvidence) {
		violations.push({
			kind: "status_inconsistent",
			detail: "status=partial without missingEvidence or useful evidence",
		});
	}

	const bytes = evidencePacketByteSize(packet);
	if (bytes > maxBytes) {
		violations.push({
			kind: "packet_too_large",
			detail: `packet ${bytes} bytes exceeds max ${maxBytes}`,
		});
	}

	const citationValidity = totalCitationCount === 0 ? 1 : validCitationCount / totalCitationCount;
	const structuralValid = !violations.some(v =>
		[
			"ungranted_handle",
			"citation_out_of_grant",
			"atom_missing_citation",
			"claim_missing_support",
			"unknown_atom_id",
			"contradiction_missing_citation",
			"contradiction_identical_sides",
			"packet_too_large",
		].includes(v.kind),
	);

	return {
		ok: violations.length === 0,
		structuralValid,
		citationValidity,
		violations,
		validCitationCount,
		totalCitationCount,
	};
}

/** Apply validation failure → honest partial packet (fail-open contract). */
export function rejectInvalidEvidencePacket(
	packet: EvidencePacketV2,
	validation: EvidenceValidationResult,
	store?: RlmStore,
	view?: RlmView,
): EvidencePacketV2 {
	const validContradictions =
		store && view
			? packet.contradictions.filter(c => sideHasValidCitation(c.left, view, store) && sideHasValidCitation(c.right, view, store))
			: [];
	return {
		status: "partial",
		atoms: packet.atoms,
		claims: [],
		contradictions: validContradictions,
		missingEvidence: [
			...packet.missingEvidence,
			...validation.violations.map(v => `validation: ${v.detail}`),
		],
	};
}
