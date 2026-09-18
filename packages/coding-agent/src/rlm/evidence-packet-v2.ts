/**
 * EvidencePacketV2 — evidence-preserving semantic codec (atoms + cited claims/contradictions).
 * V1 remains for legacy; production worker path uses V2 (see evidence-query.ts).
 */

import type { EvidencePacketStatus } from "./evidence-packet";
import evidenceWorkerSystem from "./prompts/evidence-worker-system.md" with { type: "text" };

export type { EvidencePacketStatus };

export interface EvidenceCitationV2 {
	handle: string;
	start: number;
	end: number;
	revision?: string;
}

export interface EvidenceAtomV2 {
	id: string;
	key: string;
	value: string;
	citations: EvidenceCitationV2[];
}

export interface EvidenceClaimV2 {
	fact: string;
	supports: string[];
	citations: EvidenceCitationV2[];
	confidence: number;
}

export interface EvidenceContradictionSideV2 {
	value: string;
	citations: EvidenceCitationV2[];
}

export interface EvidenceContradictionV2 {
	subject?: string;
	left: EvidenceContradictionSideV2;
	right: EvidenceContradictionSideV2;
}

export interface EvidencePacketV2 {
	status: EvidencePacketStatus;
	atoms: EvidenceAtomV2[];
	claims: EvidenceClaimV2[];
	contradictions: EvidenceContradictionV2[];
	missingEvidence: string[];
}

/** Default max formatted packet size forwarded to root (UTF-8 bytes). */
export const EVIDENCE_PACKET_MAX_OUTPUT_BYTES = 4_096;

const CITATION_JSON_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["handle", "start", "end"],
	properties: {
		handle: { type: "string" },
		start: { type: "number" },
		end: { type: "number" },
		revision: { type: "string" },
	},
};

const CONTRADICTION_SIDE_JSON_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["value", "citations"],
	properties: {
		value: { type: "string" },
		citations: { type: "array", minItems: 1, items: CITATION_JSON_SCHEMA },
	},
};

/** JSON Schema for provider structured output / forced tool args. */
export const EVIDENCE_PACKET_V2_JSON_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["status", "atoms", "claims", "contradictions", "missingEvidence"],
	properties: {
		status: { type: "string", enum: ["sufficient", "partial", "abstain"] },
		atoms: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "key", "value", "citations"],
				properties: {
					id: { type: "string" },
					key: { type: "string" },
					value: { type: "string" },
					citations: { type: "array", minItems: 1, items: CITATION_JSON_SCHEMA },
				},
			},
		},
		claims: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["fact", "supports", "citations", "confidence"],
				properties: {
					fact: { type: "string" },
					supports: { type: "array", items: { type: "string" } },
					confidence: { type: "number", minimum: 0, maximum: 1 },
					citations: { type: "array", items: CITATION_JSON_SCHEMA },
				},
			},
		},
		contradictions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["left", "right"],
				properties: {
					subject: { type: "string" },
					left: CONTRADICTION_SIDE_JSON_SCHEMA,
					right: CONTRADICTION_SIDE_JSON_SCHEMA,
				},
			},
		},
		missingEvidence: { type: "array", items: { type: "string" } },
	},
};

/** Stable static worker instructions (prefix-cache friendly). */
export const EVIDENCE_WORKER_STATIC_SYSTEM = evidenceWorkerSystem.trim();

export function emptyEvidencePacketV2(status: EvidencePacketStatus = "abstain"): EvidencePacketV2 {
	return { status, atoms: [], claims: [], contradictions: [], missingEvidence: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCitation(raw: unknown): EvidenceCitationV2 | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.handle !== "string" || typeof raw.start !== "number" || typeof raw.end !== "number") return null;
	return {
		handle: raw.handle,
		start: raw.start,
		end: raw.end,
		revision: typeof raw.revision === "string" ? raw.revision : undefined,
	};
}

function parseSide(raw: unknown): EvidenceContradictionSideV2 | null {
	if (!isRecord(raw) || typeof raw.value !== "string") return null;
	const citationsRaw = Array.isArray(raw.citations) ? raw.citations : [];
	const citations = citationsRaw.map(parseCitation).filter((c): c is EvidenceCitationV2 => c !== null);
	return { value: raw.value, citations };
}

/** Best-effort parse + normalize; throws on invalid shape. */
export function parseEvidencePacketV2(raw: unknown): EvidencePacketV2 {
	if (!isRecord(raw)) throw new Error("EvidencePacketV2 must be an object");
	const status = raw.status;
	if (status !== "sufficient" && status !== "partial" && status !== "abstain") {
		throw new Error("EvidencePacketV2.status must be sufficient|partial|abstain");
	}

	const atoms: EvidenceAtomV2[] = [];
	for (const item of Array.isArray(raw.atoms) ? raw.atoms : []) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.key !== "string" || typeof item.value !== "string") {
			continue;
		}
		const citations = (Array.isArray(item.citations) ? item.citations : [])
			.map(parseCitation)
			.filter((c): c is EvidenceCitationV2 => c !== null);
		atoms.push({ id: item.id, key: item.key, value: item.value, citations });
	}

	const claims: EvidenceClaimV2[] = [];
	for (const item of Array.isArray(raw.claims) ? raw.claims : []) {
		if (!isRecord(item) || typeof item.fact !== "string") continue;
		const confidence = typeof item.confidence === "number" ? item.confidence : 0;
		const supports = (Array.isArray(item.supports) ? item.supports : []).filter((x): x is string => typeof x === "string");
		const citations = (Array.isArray(item.citations) ? item.citations : [])
			.map(parseCitation)
			.filter((c): c is EvidenceCitationV2 => c !== null);
		claims.push({ fact: item.fact, supports, citations, confidence });
	}

	const contradictions: EvidenceContradictionV2[] = [];
	for (const item of Array.isArray(raw.contradictions) ? raw.contradictions : []) {
		if (!isRecord(item)) continue;
		const left = parseSide(item.left);
		const right = parseSide(item.right);
		if (!left || !right) continue;
		contradictions.push({
			subject: typeof item.subject === "string" ? item.subject : undefined,
			left,
			right,
		});
	}

	const missingEvidence = (Array.isArray(raw.missingEvidence) ? raw.missingEvidence : []).filter(
		(x): x is string => typeof x === "string",
	);

	return { status, atoms, claims, contradictions, missingEvidence };
}

export function tryParseEvidencePacketV2Json(text: string): EvidencePacketV2 {
	const trimmed = text.trim();
	const jsonStart = trimmed.indexOf("{");
	const jsonEnd = trimmed.lastIndexOf("}");
	const slice = jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
	return parseEvidencePacketV2(JSON.parse(slice));
}

/** Compact text for root/tool result — not the full corpus. */
export function formatEvidencePacketForRoot(packet: EvidencePacketV2): string {
	const lines: string[] = [`status=${packet.status}`];
	for (const atom of packet.atoms) {
		const cites = atom.citations.map(c => `${c.handle}[${c.start}:${c.end}]`).join("; ");
		lines.push(`- atom ${atom.id} ${atom.key}=${atom.value}${cites ? ` (${cites})` : ""}`);
	}
	for (const claim of packet.claims) {
		const cites = claim.citations.map(c => `${c.handle}[${c.start}:${c.end}]`).join("; ");
		const sup = claim.supports.length > 0 ? ` supports=[${claim.supports.join(",")}]` : "";
		lines.push(`- claim(conf=${claim.confidence.toFixed(2)}): ${claim.fact}${sup}${cites ? ` (${cites})` : ""}`);
	}
	for (const c of packet.contradictions) {
		const l = c.left.citations.map(x => `${x.handle}[${x.start}:${x.end}]`).join(";");
		const r = c.right.citations.map(x => `${x.handle}[${x.start}:${x.end}]`).join(";");
		lines.push(`- contradiction${c.subject ? ` (${c.subject})` : ""}: ${c.left.value} <> ${c.right.value} (${l} vs ${r})`);
	}
	for (const m of packet.missingEvidence) lines.push(`- missing: ${m}`);
	return lines.join("\n");
}

export function evidencePacketByteSize(packet: EvidencePacketV2): number {
	return Buffer.byteLength(formatEvidencePacketForRoot(packet), "utf8");
}

/** Collect every citation in a V2 packet (atoms, claims, contradictions). */
export function allPacketCitations(packet: EvidencePacketV2): EvidenceCitationV2[] {
	const out: EvidenceCitationV2[] = [];
	for (const atom of packet.atoms) out.push(...atom.citations);
	for (const claim of packet.claims) out.push(...claim.citations);
	for (const c of packet.contradictions) {
		out.push(...c.left.citations, ...c.right.citations);
	}
	return out;
}
