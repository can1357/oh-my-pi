import * as fs from "node:fs";
import * as path from "node:path";

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
			if (typeof record.title === "string" && record.title.trim()) return true;
			if (record.type === "compaction" && typeof record.shortSummary === "string" && record.shortSummary.trim()) {
				return true;
			}
			if (record.type !== "message" || !record.message) return false;
			if (record.message.role === "assistant") return true;
			return (
				(record.message.role === "user" || record.message.role === "developer") &&
				hasDisplayText(record.message.content)
			);
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
		return { created, resumable: pending.trim().length > 0 && inspect(pending.trim()) };
	} catch {
		return { created, resumable: false };
	} finally {
		if (file !== undefined) fs.closeSync(file);
	}
}

/** Synchronous, dependency-light form of the canonical recent nonempty-session selector. */
export function findMostRecentNonEmptySessionSync(sessionDir: string): string | undefined {
	try {
		return fs
			.readdirSync(sessionDir, { withFileTypes: true })
			.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
			.flatMap(entry => {
				const sessionFile = path.join(sessionDir, entry.name);
				const inspected = inspectSessionFileSync(sessionFile);
				if (!inspected.resumable) return [];
				return [
					{
						path: sessionFile,
						modified: fs.statSync(sessionFile).mtime,
						created: inspected.created,
					},
				];
			})
			.sort(compareSessionRecency)[0]?.path;
	} catch {
		return undefined;
	}
}
