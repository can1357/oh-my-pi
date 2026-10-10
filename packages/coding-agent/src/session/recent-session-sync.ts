import * as fs from "node:fs";
import * as path from "node:path";
import { isSessionDisplayMessageRole, isSessionResumabilityEmpty } from "./session-resumability";

interface SessionRecency {
	readonly path: string;
	readonly modified: Date;
	readonly created: Date;
}

/** Newest-first ordering shared by live resume selection and synchronous prepaint. */
export function compareSessionRecency(a: SessionRecency, b: SessionRecency): number {
	return (
		b.modified.getTime() - a.modified.getTime() ||
		b.created.getTime() - a.created.getTime() ||
		b.path.localeCompare(a.path)
	);
}

function hasDisplayText(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some(part => {
		if (!part || typeof part !== "object") return false;
		const text = (part as { text?: unknown }).text;
		return typeof text === "string" && text.trim().length > 0;
	});
}

function inspectSessionFileSync(sessionFile: string): { created: Date; resumable: boolean } {
	let file: number | undefined;
	let created = new Date(0);
	let hasHeader = false;
	let hasResumableContent = false;
	try {
		file = fs.openSync(sessionFile, "r");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const decoder = new TextDecoder();
		let pending = "";
		const inspect = (line: string): boolean => {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				return false;
			}
			if (!entry || typeof entry !== "object") return false;
			const record = entry as {
				type?: unknown;
				timestamp?: unknown;
				title?: unknown;
				shortSummary?: unknown;
				message?: { role?: unknown; content?: unknown };
			};
			if (record.type === "session" && typeof record.timestamp === "string") {
				const timestamp = new Date(record.timestamp);
				if (Number.isFinite(timestamp.getTime())) created = timestamp;
			}
			if (record.type === "session") hasHeader = true;
			if (
				!isSessionResumabilityEmpty({
					assistantTurns: 0,
					title:
						typeof record.title === "string"
							? record.title
							: record.type === "compaction" && typeof record.shortSummary === "string"
								? record.shortSummary
								: undefined,
				})
			) {
				hasResumableContent = true;
				return hasHeader;
			}
			if (record.type !== "message" || !record.message) return hasHeader && hasResumableContent;
			const hasDisplayMessage =
				isSessionDisplayMessageRole(record.message.role) && hasDisplayText(record.message.content);
			hasResumableContent ||= !isSessionResumabilityEmpty({
				assistantTurns: record.message.role === "assistant" ? 1 : 0,
				firstMessage: hasDisplayMessage ? "display message" : undefined,
			});
			return hasHeader && hasResumableContent;
		};

		for (;;) {
			const bytes = fs.readSync(file, buffer, 0, buffer.length, null);
			if (bytes === 0) break;
			pending += decoder.decode(buffer.subarray(0, bytes), { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				if (inspect(pending.slice(0, newline).trim())) return { created, resumable: true };
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		}
		pending += decoder.decode();
		if (pending.trim().length > 0) inspect(pending.trim());
		return { created, resumable: hasHeader && hasResumableContent };
	} catch {
		return { created, resumable: false };
	} finally {
		if (file !== undefined) fs.closeSync(file);
	}
}

/** Synchronous, dependency-light form of the canonical recent nonempty-session selector. */
export function findMostRecentNonEmptySessionSync(sessionDir: string): string | undefined {
	try {
		const entries = fs.readdirSync(sessionDir, { withFileTypes: true }).filter(entry => entry.isFile());
		const primaries = new Set(entries.filter(entry => entry.name.endsWith(".jsonl")).map(entry => entry.name));
		const recoverableBackups = new Map<string, { file: string; modified: Date }>();
		for (const entry of entries) {
			if (!entry.name.endsWith(".bak")) continue;
			const trimmed = entry.name.slice(0, -".bak".length);
			const suffix = trimmed.lastIndexOf(".");
			if (suffix <= 0) continue;
			const primaryName = trimmed.slice(0, suffix);
			if (!primaryName.endsWith(".jsonl") || primaries.has(primaryName)) continue;
			const file = path.join(sessionDir, entry.name);
			const modified = fs.statSync(file).mtime;
			const existing = recoverableBackups.get(primaryName);
			if (!existing || modified.getTime() > existing.modified.getTime()) {
				recoverableBackups.set(primaryName, { file, modified });
			}
		}
		const candidates = [
			...entries
				.filter(entry => entry.name.endsWith(".jsonl"))
				.map(entry => ({
					file: path.join(sessionDir, entry.name),
					path: path.join(sessionDir, entry.name),
					modified: undefined as Date | undefined,
				})),
			...[...recoverableBackups].map(([primaryName, backup]) => ({
				file: backup.file,
				path: path.join(sessionDir, primaryName),
				modified: backup.modified,
			})),
		];
		return candidates
			.flatMap(candidate => {
				const inspected = inspectSessionFileSync(candidate.file);
				if (!inspected.resumable) return [];
				return [
					{
						path: candidate.path,
						modified: candidate.modified ?? fs.statSync(candidate.file).mtime,
						created: inspected.created,
					},
				];
			})
			.sort(compareSessionRecency)[0]?.path;
	} catch {
		return undefined;
	}
}
