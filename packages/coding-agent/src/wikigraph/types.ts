export type WikiNodeKind = "doc" | "section" | "fact" | "decision" | "procedure" | "symbol" | "project" | "person";
export type WikiNodeStatus = "current" | "superseded" | "stale";
export type WikiEdgeKind =
	| "links_to"
	| "mentions"
	| "supersedes"
	| "superseded_by"
	| "caused_by"
	| "fixes"
	| "depends_on"
	| "same_as"
	| "related"
	| "conflicts_with"
	| "extracted_from";

export interface WikiNode {
	id: string;
	kind: WikiNodeKind;
	title: string;
	summary: string;
	path: string;
	anchor: string | null;
	lineStart: number | null;
	lineEnd: number | null;
	status: WikiNodeStatus;
	sourceHash: string;
	confidence: number;
	validFrom: number;
	validTo: number | null;
	supersededBy: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface WikiEdge {
	fromId: string;
	toId: string;
	kind: WikiEdgeKind;
	weight: number;
	evidence: string | null;
	createdAt: number;
}

export interface WikiFact extends WikiNode {
	kind: "fact";
}

export interface WikiNodeRow {
	id: string;
	kind: WikiNodeKind;
	title: string;
	summary: string;
	path: string;
	anchor: string | null;
	line_start: number | null;
	line_end: number | null;
	status: WikiNodeStatus;
	source_hash: string;
	confidence: number;
	valid_from: number;
	valid_to: number | null;
	superseded_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface WikiEdgeRow {
	from_id: string;
	to_id: string;
	kind: WikiEdgeKind;
	weight: number;
	evidence: string | null;
	created_at: number;
}

export interface WikigraphRefreshResult {
	added: number;
	updated: number;
	removed: number;
	warnings: string[];
}
