import * as crypto from "node:crypto";
import type { WikigraphDbHandle } from "./db";

export interface AtomicFactInput {
	sectionId: string;
	path: string;
	lineStart: number;
	lineEnd: number;
	body: string;
	factsPerSection: number;
	minConfidence: number;
}

export interface AtomicFactResult {
	inserted: number;
	rejected: number;
}

function hash(input: string): string {
	return crypto.createHash("sha1").update(input).digest("hex");
}

function sentenceFacts(body: string, limit: number): string[] {
	return body
		.replace(/```[\s\S]*?```/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map(sentence => sentence.replace(/\s+/g, " ").trim())
		.filter(sentence => sentence.length >= 24 && sentence.length <= 120 && !sentence.includes("```"))
		.slice(0, limit);
}

export function extractAtomicFacts(db: WikigraphDbHandle, input: AtomicFactInput): AtomicFactResult {
	if (!input.path || input.lineStart <= 0 || input.lineEnd < input.lineStart) return { inserted: 0, rejected: 1 };
	const now = Date.now();
	let inserted = 0;
	let rejected = 0;
	const tx = db.db.transaction(() => {
		for (const summary of sentenceFacts(input.body, input.factsPerSection)) {
			if (summary.includes("\n```")) {
				rejected++;
				continue;
			}
			const id = hash(`fact:${input.sectionId}:${summary}`);
			db.prepare<unknown>(`
INSERT INTO nodes (id, kind, title, summary, path, anchor, line_start, line_end, status, source_hash, confidence, valid_from, valid_to, superseded_by, created_at, updated_at)
VALUES (?, 'fact', ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, NULL, NULL, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	summary = excluded.summary,
	confidence = excluded.confidence,
	updated_at = excluded.updated_at
`).run(
				id,
				summary,
				summary,
				input.path,
				`L${input.lineStart}-L${input.lineEnd}`,
				input.lineStart,
				input.lineEnd,
				hash(input.body),
				input.minConfidence,
				now,
				now,
				now,
			);
			db.prepare<unknown>(`
INSERT INTO edges (from_id, to_id, kind, weight, evidence, created_at)
VALUES (?, ?, 'extracted_from', 1.0, ?, ?)
ON CONFLICT(from_id, to_id, kind) DO UPDATE SET evidence = excluded.evidence, created_at = excluded.created_at
`).run(id, input.sectionId, summary, now);
			inserted++;
		}
	});
	tx();
	return { inserted, rejected };
}
