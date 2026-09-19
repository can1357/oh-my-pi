/**
 * Typed handoff from RLM semantic worker → frontier root (EvidencePacketV1).
 * No giant prose summary — facts + citations + optional range hints only.
 */

export type EvidencePacketStatus = "sufficient" | "partial" | "abstain";

export interface EvidenceCitationV1 {
	handle: string;
	start: number;
	end: number;
	revision?: string;
}

export interface EvidenceClaimV1 {
	fact: string;
	citations: EvidenceCitationV1[];
	confidence: number;
}

export interface EvidenceContradictionV1 {
	left: string;
	right: string;
}

export interface EvidenceRelevantRangeV1 {
	handle: string;
	start: number;
	end: number;
	reason: string;
}

export interface EvidencePacketV1 {
	status: EvidencePacketStatus;
	claims: EvidenceClaimV1[];
	contradictions: EvidenceContradictionV1[];
	missingEvidence: string[];
	relevantRanges: EvidenceRelevantRangeV1[];
}

/** JSON Schema for provider structured output / forced tool args. */
export const EVIDENCE_PACKET_V1_JSON_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["status", "claims", "contradictions", "missingEvidence", "relevantRanges"],
	properties: {
		status: { type: "string", enum: ["sufficient", "partial", "abstain"] },
		claims: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["fact", "citations", "confidence"],
				properties: {
					fact: { type: "string" },
					confidence: { type: "number", minimum: 0, maximum: 1 },
					citations: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["handle", "start", "end"],
							properties: {
								handle: { type: "string" },
								start: { type: "number" },
								end: { type: "number" },
								revision: { type: "string" },
							},
						},
					},
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
					left: { type: "string" },
					right: { type: "string" },
				},
			},
		},
		missingEvidence: { type: "array", items: { type: "string" } },
		relevantRanges: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["handle", "start", "end", "reason"],
				properties: {
					handle: { type: "string" },
					start: { type: "number" },
					end: { type: "number" },
					reason: { type: "string" },
				},
			},
		},
	},
};

/** Stable static worker instructions (prefix-cache friendly). */
export const EVIDENCE_WORKER_STATIC_SYSTEM =
	"You are an isolated RLM evidence worker. Transform ONLY the granted excerpts into a typed EvidencePacketV1. " +
	"You have no tools, no root transcript, and no access outside the grants. " +
	"Cite handle byte ranges for every claim. If evidence is insufficient, set status=abstain or partial honestly. " +
	"Never invent facts not supported by the excerpts. No prose summary field — only structured claims.";

export function emptyEvidencePacket(status: EvidencePacketStatus = "abstain"): EvidencePacketV1 {
	return {
		status,
		claims: [],
		contradictions: [],
		missingEvidence: [],
		relevantRanges: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCitation(raw: unknown): EvidenceCitationV1 | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.handle !== "string" || typeof raw.start !== "number" || typeof raw.end !== "number") return null;
	return {
		handle: raw.handle,
		start: raw.start,
		end: raw.end,
		revision: typeof raw.revision === "string" ? raw.revision : undefined,
	};
}

/** Best-effort parse + normalize; throws on invalid shape. */
export function parseEvidencePacketV1(raw: unknown): EvidencePacketV1 {
	if (!isRecord(raw)) throw new Error("EvidencePacket must be an object");
	const status = raw.status;
	if (status !== "sufficient" && status !== "partial" && status !== "abstain") {
		throw new Error("EvidencePacket.status must be sufficient|partial|abstain");
	}
	const claimsRaw = Array.isArray(raw.claims) ? raw.claims : [];
	const claims: EvidenceClaimV1[] = [];
	for (const item of claimsRaw) {
		if (!isRecord(item) || typeof item.fact !== "string") continue;
		const confidence = typeof item.confidence === "number" ? item.confidence : 0;
		const citationsRaw = Array.isArray(item.citations) ? item.citations : [];
		const citations = citationsRaw.map(parseCitation).filter((c): c is EvidenceCitationV1 => c !== null);
		claims.push({ fact: item.fact, confidence, citations });
	}
	const contradictions: EvidenceContradictionV1[] = [];
	for (const item of Array.isArray(raw.contradictions) ? raw.contradictions : []) {
		if (!isRecord(item) || typeof item.left !== "string" || typeof item.right !== "string") continue;
		contradictions.push({ left: item.left, right: item.right });
	}
	const missingEvidence = (Array.isArray(raw.missingEvidence) ? raw.missingEvidence : []).filter(
		(x): x is string => typeof x === "string",
	);
	const relevantRanges: EvidenceRelevantRangeV1[] = [];
	for (const item of Array.isArray(raw.relevantRanges) ? raw.relevantRanges : []) {
		if (
			!isRecord(item) ||
			typeof item.handle !== "string" ||
			typeof item.start !== "number" ||
			typeof item.end !== "number" ||
			typeof item.reason !== "string"
		) {
			continue;
		}
		relevantRanges.push({
			handle: item.handle,
			start: item.start,
			end: item.end,
			reason: item.reason,
		});
	}
	return { status, claims, contradictions, missingEvidence, relevantRanges };
}

export function tryParseEvidencePacketJson(text: string): EvidencePacketV1 {
	const trimmed = text.trim();
	const jsonStart = trimmed.indexOf("{");
	const jsonEnd = trimmed.lastIndexOf("}");
	const slice = jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
	return parseEvidencePacketV1(JSON.parse(slice));
}

/** Compact text for root/tool result — not the full corpus. */
export function formatEvidencePacketForRoot(packet: EvidencePacketV1): string {
	const lines: string[] = [`status=${packet.status}`];
	for (const claim of packet.claims) {
		const cites = claim.citations.map(c => `${c.handle}[${c.start}:${c.end}]`).join("; ");
		lines.push(`- claim(conf=${claim.confidence.toFixed(2)}): ${claim.fact}${cites ? ` (${cites})` : ""}`);
	}
	for (const c of packet.contradictions) {
		lines.push(`- contradiction: ${c.left} <> ${c.right}`);
	}
	for (const m of packet.missingEvidence) lines.push(`- missing: ${m}`);
	for (const r of packet.relevantRanges) {
		lines.push(`- range: ${r.handle}[${r.start}:${r.end}] ${r.reason}`);
	}
	return lines.join("\n");
}

export function evidencePacketByteSize(packet: EvidencePacketV1): number {
	return Buffer.byteLength(formatEvidencePacketForRoot(packet), "utf8");
}
