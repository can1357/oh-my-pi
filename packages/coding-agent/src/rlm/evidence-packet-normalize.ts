/**
 * Deterministic citation normalization before EvidencePacketV2 validation.
 * Repairs common worker mistakes (handle aliases, excerpt-relative offsets).
 */

import { allPacketCitations, type EvidenceCitationV2, type EvidencePacketV2 } from "./evidence-packet-v2";
import { normalizeHandle } from "./store";
import type { RlmView } from "./view";

function grantsForHandle(view: RlmView, handle: string): RlmView["grants"] {
	const target = normalizeHandle(handle);
	return view.grants.filter(g => normalizeHandle(g.handle) === target);
}

function resolveGrantHandle(cite: EvidenceCitationV2, view: RlmView): void {
	if (grantsForHandle(view, cite.handle).length > 0) return;
	for (const grant of view.grants) {
		if (normalizeHandle(cite.handle) === normalizeHandle(grant.handle)) {
			cite.handle = grant.handle;
			return;
		}
	}
	const idMatch = /(?:^|\/)h\/([^[\]/]+)/.exec(cite.handle)?.[1];
	if (!idMatch) return;
	const target = normalizeHandle(idMatch);
	for (const grant of view.grants) {
		if (normalizeHandle(grant.recordId) === target || normalizeHandle(grant.handle) === target) {
			cite.handle = grant.handle;
			return;
		}
	}
}

function citationWithinAnyGrant(view: RlmView, cite: EvidenceCitationV2): boolean {
	return grantsForHandle(view, cite.handle).some(g => cite.start >= g.start && cite.end <= g.end && cite.start < cite.end);
}

/** Shift excerpt-relative [0:len] citations to absolute record offsets when they fit a grant excerpt. */
function normalizeCitationOffsets(cite: EvidenceCitationV2, view: RlmView): void {
	if (citationWithinAnyGrant(view, cite)) return;
	const grants = grantsForHandle(view, cite.handle);
	if (grants.length === 0) return;
	const span = cite.end - cite.start;
	if (span <= 0) return;

	for (const grant of grants) {
		const excerptLen = grant.end - grant.start;
		if (cite.start === 0 && cite.end <= excerptLen) {
			cite.start += grant.start;
			cite.end += grant.start;
			return;
		}
		if (cite.start >= 0 && cite.end <= excerptLen) {
			cite.start += grant.start;
			cite.end += grant.start;
			return;
		}
	}
}

/** Normalize handles and citation byte ranges against a resolved view. */
export function normalizeEvidencePacketCitations(packet: EvidencePacketV2, view: RlmView): EvidencePacketV2 {
	const next: EvidencePacketV2 = {
		status: packet.status,
		atoms: packet.atoms.map(atom => ({
			...atom,
			citations: atom.citations.map(c => ({ ...c })),
		})),
		claims: packet.claims.map(claim => ({
			...claim,
			citations: claim.citations.map(c => ({ ...c })),
			supports: [...claim.supports],
		})),
		contradictions: packet.contradictions.map(c => ({
			...c,
			left: { value: c.left.value, citations: c.left.citations.map(x => ({ ...x })) },
			right: { value: c.right.value, citations: c.right.citations.map(x => ({ ...x })) },
		})),
		missingEvidence: [...packet.missingEvidence],
	};

	for (const cite of allPacketCitations(next)) {
		resolveGrantHandle(cite, view);
		normalizeCitationOffsets(cite, view);
	}
	return next;
}
