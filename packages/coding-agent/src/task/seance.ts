import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionFilesFromDisk } from "../internal-urls/registry-helpers";
import { buildSessionContext, getRestorableSessionModels } from "../session/session-context";
import { type SessionEntry } from "../session/session-entries";
import { FileSessionStorage, type SessionStorage } from "../session/session-storage";
import { SessionManager } from "../session/session-manager";
import { loadSessionFile, visitEntriesFromFileStream } from "../session/session-loader";

export interface ResolvedSeanceSource {
	file: string;
	id: string;
	/** Active saved model-role selector, then the saved default fallback. */
	modelSelectors: string[];
}

function safeSourceLabel(source: string): string {
	return source
		.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
		.trim()
		.slice(0, 100);
}

function chooseId<T extends { id: string }>(matches: T[], selector: string): T | undefined {
	const normalized = selector.toLowerCase();
	const exact = matches.filter(match => match.id.toLowerCase() === normalized);
	const candidates = exact.length > 0 ? exact : matches.filter(match => match.id.toLowerCase().startsWith(normalized));
	if (candidates.length > 1) throw new Error(`Session selector "${safeSourceLabel(selector)}" is ambiguous.`);
	return candidates[0];
}

function savedModelSelectors(entries: SessionEntry[]): string[] {
	const leaf = entries.at(-1);
	if (!leaf) return [];
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	let lastModelChangeRole: string | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "model_change") {
			lastModelChangeRole = entry.role;
			break;
		}
	}
	const context = buildSessionContext(entries, leaf.id);
	return getRestorableSessionModels(context.models, lastModelChangeRole);
}

async function validateSourceFile(file: string, storage: SessionStorage): Promise<ResolvedSeanceSource> {
	let loaded;
	try {
		loaded = await loadSessionFile(file, storage, { throwIfMissing: true });
	} catch {
		throw new Error("Unable to read the selected session.");
	}
	const header = loaded.entries[0];
	if (loaded.invalidHeader || !header || header.type !== "session" || !header.id) {
		throw new Error("The selected file does not contain a valid session header.");
	}
	const entries = loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	return { file, id: header.id, modelSelectors: savedModelSelectors(entries) };
}

/** Resolve an explicit session path or an unambiguous stored session id without opening its writer. */
export async function resolveSeanceSource(
	selector: string,
	options: {
		cwd: string;
		sessionDirHint?: string;
		artifactsDirHint?: string;
		storage?: SessionStorage;
	},
): Promise<ResolvedSeanceSource> {
	const source = selector.trim();
	if (!source) throw new Error("A source session is required.");
	const storage = options.storage ?? new FileSessionStorage();
	if (source.includes("/") || source.includes("\\") || source.endsWith(".jsonl")) {
		const file = path.resolve(options.cwd, source);
		try {
			const stat = await fs.stat(file);
			if (!stat.isFile()) throw new Error("The selected path is not a session file.");
		} catch (error) {
			if (error instanceof Error && error.message === "The selected path is not a session file.") throw error;
			throw new Error("The selected session file was not found or could not be accessed.");
		}
		return validateSourceFile(file, storage);
	}

	const label = safeSourceLabel(source);
	if (options.artifactsDirHint) {
		const files = await sessionFilesFromDisk(options.artifactsDirHint, { onlyPreferred: true });
		const matches = [...files].filter(([id]) => id.toLowerCase().startsWith(source.toLowerCase()));
		const exact = matches.filter(([id]) => id.toLowerCase() === source.toLowerCase());
		const candidates = exact.length > 0 ? exact : matches;
		if (candidates.length > 1) throw new Error(`Session selector "${label}" is ambiguous.`);
		const match = candidates[0];
		if (match) return validateSourceFile(match[1], storage);
	}
	if (options.sessionDirHint) {
		const local = await SessionManager.list(options.cwd, options.sessionDirHint, storage);
		const match = chooseId(local, source);
		if (match) return validateSourceFile(match.path, storage);
	}
	const global = await SessionManager.listAll(storage);
	const match = chooseId(global, source);
	if (match) return validateSourceFile(match.path, storage);
	throw new Error(`Session "${label}" was not found.`);
}

/** Read only the first session record; the shared stream parser skips title-slot preambles. */
async function hasSeanceForkHeader(file: string): Promise<boolean> {
	let seanceFork = false;
	try {
		await visitEntriesFromFileStream(
			file,
			entry => {
				seanceFork = entry.type === "session" && entry.seanceFork === true;
				return false;
			},
			{ maxRecords: 1 },
		);
	} catch {
		return false;
	}
	return seanceFork;
}

/** True only for a persisted seance fork, never by agent display or init name. */
export async function isSeanceSessionFile(file: string): Promise<boolean> {
	return hasSeanceForkHeader(file);
}
