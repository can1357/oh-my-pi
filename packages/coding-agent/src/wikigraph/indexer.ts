import * as crypto from "node:crypto";
import * as path from "node:path";
import { parseFrontmatter } from "@pk-nerdsaver-ai/pi-utils";
import type { WikigraphDbHandle } from "./db";
import type { WikiEdgeKind, WikiNodeKind, WikiNodeRow, WikiNodeStatus } from "./types";

interface MarkdownSection {
	heading: string;
	level: number;
	lineStart: number;
	lineEnd: number;
	body: string;
}

interface ParsedMarkdownFile {
	frontmatter: Record<string, unknown>;
	body: string;
	lines: string[];
	title: string;
	summary: string;
	sections: MarkdownSection[];
}

export interface IndexedFileResult {
	added: number;
	updated: number;
	removed: number;
	warnings: string[];
}

function sha1(input: string): string {
	return crypto.createHash("sha1").update(input).digest("hex");
}

export function wikigraphNodeId(kind: "doc" | "section" | "external", relPathOrUrl: string, anchor?: string): string {
	if (kind === "external") return sha1(`external:${relPathOrUrl}`);
	return sha1(`${kind}:${relPathOrUrl}${anchor ? `#${anchor}` : ""}`);
}

export function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function truncate(value: string, max: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function parseMarkdown(content: string, filePath: string): ParsedMarkdownFile {
	const parsed = parseFrontmatter(content, { source: filePath, level: "off" });
	const lines = parsed.body.split(/\r?\n/);
	const firstHeading = lines.find(line => /^#\s+/.test(line));
	const title = firstHeading?.replace(/^#\s+/, "").trim() || path.basename(filePath, path.extname(filePath));
	const firstHeadingIndex = firstHeading ? lines.indexOf(firstHeading) : -1;
	const summaryLine = lines.slice(firstHeadingIndex + 1).find(line => {
		const trimmed = line.trim();
		return trimmed.length > 0 && !trimmed.startsWith("#");
	});
	const sections: MarkdownSection[] = [];
	for (let index = 0; index < lines.length; index++) {
		const match = lines[index].match(/^(#{2,6})\s+(.+)$/);
		if (!match) continue;
		const level = match[1].length;
		let end = lines.length;
		for (let next = index + 1; next < lines.length; next++) {
			const nextMatch = lines[next].match(/^(#{2,6})\s+(.+)$/);
			if (nextMatch && nextMatch[1].length <= level) {
				end = next;
				break;
			}
		}
		sections.push({
			heading: match[2].trim(),
			level,
			lineStart: index + 1,
			lineEnd: end,
			body: lines.slice(index, end).join("\n"),
		});
	}
	return {
		frontmatter: parsed.frontmatter,
		body: parsed.body,
		lines,
		title,
		summary: truncate(summaryLine || title, 240),
		sections,
	};
}

function upsertNode(db: WikigraphDbHandle, row: WikiNodeRow): boolean {
	const existing = db
		.prepare<{ source_hash: string }, [string]>("SELECT source_hash FROM nodes WHERE id = ?")
		.get(row.id);
	db.prepare<unknown>(`
INSERT INTO nodes (id, kind, title, summary, path, anchor, line_start, line_end, status, source_hash, confidence, valid_from, valid_to, superseded_by, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	kind = excluded.kind,
	title = excluded.title,
	summary = excluded.summary,
	path = excluded.path,
	anchor = excluded.anchor,
	line_start = excluded.line_start,
	line_end = excluded.line_end,
	status = excluded.status,
	source_hash = excluded.source_hash,
	confidence = excluded.confidence,
	valid_from = excluded.valid_from,
	valid_to = excluded.valid_to,
	superseded_by = excluded.superseded_by,
	updated_at = excluded.updated_at
`).run(
		row.id,
		row.kind,
		row.title,
		row.summary,
		row.path,
		row.anchor,
		row.line_start,
		row.line_end,
		row.status,
		row.source_hash,
		row.confidence,
		row.valid_from,
		row.valid_to,
		row.superseded_by,
		row.created_at,
		row.updated_at,
	);
	return !existing || existing.source_hash !== row.source_hash;
}

function upsertEdge(
	db: WikigraphDbHandle,
	fromId: string,
	toId: string,
	kind: WikiEdgeKind,
	createdAt: number,
	evidence: string | null = null,
): void {
	db.prepare<unknown>(`
INSERT INTO edges (from_id, to_id, kind, weight, evidence, created_at)
VALUES (?, ?, ?, 1.0, ?, ?)
ON CONFLICT(from_id, to_id, kind) DO UPDATE SET
	weight = excluded.weight,
	evidence = excluded.evidence,
	created_at = excluded.created_at
`).run(fromId, toId, kind, evidence, createdAt);
}

function updateFts(db: WikigraphDbHandle, id: string, title: string, summary: string, body: string): void {
	const row = db.prepare<{ rowid: number }, [string]>("SELECT rowid FROM nodes WHERE id = ?").get(id);
	if (!row) return;
	db.prepare<unknown, [number]>("DELETE FROM nodes_fts WHERE rowid = ?").run(row.rowid);
	db.prepare<unknown>("INSERT INTO nodes_fts(rowid, title, summary, body) VALUES (?, ?, ?, ?)").run(
		row.rowid,
		title,
		summary,
		body,
	);
}

function resolveMarkdownLink(
	fromFile: string,
	target: string,
	root: string,
): { id: string; path: string; warning?: string } {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
		return { id: wikigraphNodeId("external", target), path: target };
	}
	const [targetPath, targetAnchor] = target.split("#", 2);
	const absolute = path.resolve(path.dirname(fromFile), decodeURIComponent(targetPath));
	const rel = path.relative(root, absolute).replace(/\\/g, "/");
	const id = targetAnchor ? wikigraphNodeId("section", rel, slugify(targetAnchor)) : wikigraphNodeId("doc", rel);
	return { id, path: absolute, warning: targetPath.endsWith(".md") ? undefined : `warning: broken link to ${target}` };
}

export async function indexMarkdownFile(
	db: WikigraphDbHandle,
	filePath: string,
	root: string,
): Promise<IndexedFileResult> {
	const warnings: string[] = [];
	const now = Date.now();
	const absolutePath = path.resolve(filePath);
	const relPath = path.relative(root, absolutePath).replace(/\\/g, "/");
	const content = await Bun.file(absolutePath).text();
	const parsed = parseMarkdown(content, absolutePath);
	const added = 0;
	let updated = 0;
	const docId = wikigraphNodeId("doc", relPath);
	const tx = db.db.transaction(() => {
		const changed = upsertNode(db, {
			id: docId,
			kind: "doc",
			title: parsed.title,
			summary: parsed.summary,
			path: absolutePath,
			anchor: null,
			line_start: 1,
			line_end: parsed.lines.length,
			status: "current",
			source_hash: sha1(content),
			confidence: 1,
			valid_from: now,
			valid_to: null,
			superseded_by: null,
			created_at: now,
			updated_at: now,
		});
		if (changed) updated++;
		if (changed) updateFts(db, docId, parsed.title, parsed.summary, parsed.body);
		for (const section of parsed.sections) {
			const anchor = slugify(section.heading);
			const sectionId = wikigraphNodeId("section", relPath, anchor);
			const sectionChanged = upsertNode(db, {
				id: sectionId,
				kind: "section",
				title: section.heading,
				summary: truncate(section.body.replace(/^#{2,6}\s+.+/, ""), 240) || section.heading,
				path: absolutePath,
				anchor,
				line_start: section.lineStart,
				line_end: section.lineEnd,
				status: "current",
				source_hash: sha1(section.body),
				confidence: 1,
				valid_from: now,
				valid_to: null,
				superseded_by: null,
				created_at: now,
				updated_at: now,
			});
			if (sectionChanged) updated++;
			if (sectionChanged) updateFts(db, sectionId, section.heading, truncate(section.body, 240), section.body);
			upsertEdge(db, docId, sectionId, "related", now, `section: ${section.heading}`);
		}
		const supersedes = parsed.frontmatter.supersedes;
		const supersededId =
			typeof supersedes === "string" || typeof supersedes === "number" ? String(supersedes).trim() : "";
		if (supersededId) {
			upsertEdge(db, docId, supersededId, "supersedes", now, "frontmatter supersedes");
			upsertEdge(db, supersededId, docId, "superseded_by", now, "frontmatter supersedes");
			db.prepare<unknown>(
				"UPDATE nodes SET status = 'superseded', valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?",
			).run(now, docId, now, supersededId);
		}
		const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
		for (const match of parsed.body.matchAll(linkPattern)) {
			const target = resolveMarkdownLink(absolutePath, match[1], root);
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target.path)) {
				upsertNode(db, {
					id: target.id,
					kind: "doc" as WikiNodeKind,
					title: target.path,
					summary: truncate(target.path, 240),
					path: target.path,
					anchor: null,
					line_start: null,
					line_end: null,
					status: "current" as WikiNodeStatus,
					source_hash: sha1(target.path),
					confidence: 1,
					valid_from: now,
					valid_to: null,
					superseded_by: null,
					created_at: now,
					updated_at: now,
				});
			}
			if (target.warning) warnings.push(target.warning);
			upsertEdge(db, docId, target.id, "links_to", now, truncate(match[0], 200));
		}
	});
	tx();
	return { added, updated, removed: 0, warnings };
}
