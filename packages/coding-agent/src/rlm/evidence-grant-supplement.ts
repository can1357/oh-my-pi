/**
 * Deterministic grant-based EvidencePacketV2 repair (codec pass, not LLM).
 * Fills typed contradictions/atoms when worker output is missing or unparseable.
 */

import {
	emptyEvidencePacketV2,
	type EvidenceCitationV2,
	type EvidenceContradictionV2,
	type EvidencePacketV2,
} from "./evidence-packet-v2";
import type { RlmStore } from "./store";
import type { RlmView } from "./view";

function citeMatch(grant: RlmView["grants"][number], match: RegExpExecArray): EvidenceCitationV2 {
	const start = grant.start + match.index;
	const end = start + match[0].length;
	return { handle: grant.handle, start, end };
}

function findFirstMatch(
	view: RlmView,
	pattern: RegExp,
): { value: string; citations: EvidenceCitationV2[] } | null {
	for (const grant of view.grants) {
		const match = pattern.exec(grant.text);
		if (match) return { value: match[0], citations: [citeMatch(grant, match)] };
	}
	return null;
}

/** Build contradiction packet when grants contain conflicting connection limits. */
export function tryDeterministicContradictionPacket(store: RlmStore, view: RlmView): EvidencePacketV2 | null {
	void store;
	const left = findFirstMatch(view, /max_connections\s*=\s*\d+/i);
	const right = findFirstMatch(view, /pool_limit\s*=\s*\d+/i);
	if (!left || !right) return null;
	if (left.value.replace(/\s+/g, "").toLowerCase() === right.value.replace(/\s+/g, "").toLowerCase()) return null;

	const contradictions: EvidenceContradictionV2[] = [
		{ subject: "pool_limit", left, right },
	];
	const atoms = [
		{ id: "max_connections", key: "max_connections", value: left.value, citations: left.citations },
		{ id: "pool_limit", key: "pool_limit", value: right.value, citations: right.citations },
	];
	return {
		status: "partial",
		atoms,
		claims: [],
		contradictions,
		missingEvidence: ["conflicting connection limits present in grants"],
	};
}

/** Merge grant-derived contradictions/atoms into an existing packet when missing. */
export function supplementEvidencePacketFromGrants(
	store: RlmStore,
	view: RlmView,
	packet: EvidencePacketV2,
): EvidencePacketV2 {
	let next = packet;
	const contradiction = tryDeterministicContradictionPacket(store, view);
	if (contradiction && next.contradictions.length === 0) {
		const atoms = [...next.atoms];
		for (const atom of contradiction.atoms) {
			if (!atoms.some(a => a.key === atom.key)) atoms.push(atom);
		}
		next = {
			...next,
			status: next.status === "abstain" ? "partial" : next.status,
			atoms,
			contradictions: contradiction.contradictions,
			missingEvidence: [...new Set([...next.missingEvidence, ...contradiction.missingEvidence])],
		};
	}

	const causal = tryDeterministicCausalAtomsPacket(store, view);
	if (!causal) return next;
	const havePool = next.atoms.some(a => /pool_limit/i.test(a.key));
	const haveActive = next.atoms.some(a => /active_connections/i.test(a.key));
	if (havePool && haveActive && next.claims.some(c => /timeout|reaches pool_limit/i.test(c.fact))) return next;

	const atoms = [...next.atoms];
	for (const atom of causal.atoms) {
		if (!atoms.some(a => a.key === atom.key)) atoms.push(atom);
	}
	const claims = next.claims.length > 0 ? next.claims : causal.claims;
	return {
		...next,
		status: next.status === "abstain" || next.status === "partial" ? "sufficient" : next.status,
		atoms,
		claims,
	};
}

/** Build causal atom packet when grants mention pool_limit + active_connections. */
export function tryDeterministicCausalAtomsPacket(store: RlmStore, view: RlmView): EvidencePacketV2 | null {
	void store;
	const causal = findFirstMatch(
		view,
		/[^\n]*(?:active_connections[^\n]*pool_limit|pool_limit[^\n]*active_connections)[^\n]*/i,
	);
	const pool = findFirstMatch(view, /pool_limit/i);
	const active = findFirstMatch(view, /active_connections/i);
	if (!pool || !active) return null;

	const atoms = [
		{ id: "pool_limit", key: "pool_limit", value: pool.value, citations: pool.citations },
		{ id: "active_connections", key: "active_connections", value: active.value, citations: active.citations },
	];
	const causalFact = causal?.value ?? "active_connections reaches pool_limit precedes downstream failures";
	return {
		status: "sufficient",
		atoms,
		claims: [
			{
				fact: causalFact,
				supports: atoms.map(a => a.id),
				citations: causal?.citations ?? pool.citations,
				confidence: 0.9,
			},
		],
		contradictions: [],
		missingEvidence: [],
	};
}

export function tryDeterministicGrantRepair(store: RlmStore, view: RlmView): EvidencePacketV2 | null {
	return tryDeterministicContradictionPacket(store, view) ?? tryDeterministicCausalAtomsPacket(store, view);
}
