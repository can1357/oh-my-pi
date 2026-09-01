import { isRecord } from "@oh-my-pi/pi-utils";
import { CURRENT_SESSION_VERSION, type SessionEntry, type SessionHeader } from "./session-entries";

export const PORTABLE_SESSION_FORMAT = "omp-session";
export const PORTABLE_SESSION_FORMAT_VERSION = 1;

/** Logical, storage-independent snapshot of one OMP session journal. */
export interface PortableSessionSnapshot {
	format: typeof PORTABLE_SESSION_FORMAT;
	formatVersion: typeof PORTABLE_SESSION_FORMAT_VERSION;
	header: SessionHeader;
	entries: SessionEntry[];
	leafId: string | null;
}

function invalidPortableSession(reason: string): never {
	throw new Error(`Invalid portable OMP session: ${reason}`);
}

function parseHeader(value: unknown): SessionHeader {
	if (!isRecord(value) || value.type !== "session") invalidPortableSession("header is missing");
	if (typeof value.id !== "string" || value.id.length === 0) invalidPortableSession("header id is missing");
	if (typeof value.timestamp !== "string" || value.timestamp.length === 0) {
		invalidPortableSession("header timestamp is missing");
	}
	if (typeof value.cwd !== "string" || value.cwd.length === 0) invalidPortableSession("header cwd is missing");
	if (
		value.version !== undefined &&
		(!Number.isInteger(value.version) ||
			(value.version as number) < 1 ||
			(value.version as number) > CURRENT_SESSION_VERSION)
	) {
		invalidPortableSession(`unsupported session version ${String(value.version)}`);
	}
	return structuredClone(value) as unknown as SessionHeader;
}

function parseEntries(value: unknown): SessionEntry[] {
	if (!Array.isArray(value)) invalidPortableSession("entries must be an array");

	const entries: SessionEntry[] = [];
	const parents = new Map<string, string | null>();
	for (const [index, candidate] of value.entries()) {
		if (!isRecord(candidate)) invalidPortableSession(`entry ${index} is not an object`);
		if (typeof candidate.type !== "string" || candidate.type.length === 0) {
			invalidPortableSession(`entry ${index} has no type`);
		}
		if (typeof candidate.id !== "string" || candidate.id.length === 0) {
			invalidPortableSession(`entry ${index} has no id`);
		}
		if (candidate.parentId !== null && typeof candidate.parentId !== "string") {
			invalidPortableSession(`entry ${candidate.id} has an invalid parentId`);
		}
		if (typeof candidate.timestamp !== "string" || candidate.timestamp.length === 0) {
			invalidPortableSession(`entry ${candidate.id} has no timestamp`);
		}
		if (parents.has(candidate.id)) invalidPortableSession(`duplicate entry id ${candidate.id}`);
		parents.set(candidate.id, candidate.parentId);
		entries.push(structuredClone(candidate) as unknown as SessionEntry);
	}

	for (const [id, parentId] of parents) {
		if (parentId === id) invalidPortableSession(`entry ${id} is its own parent`);
		if (parentId !== null && !parents.has(parentId)) {
			invalidPortableSession(`entry ${id} references missing parent ${parentId}`);
		}
	}

	const states = new Map<string, "visiting" | "visited">();
	for (const id of parents.keys()) {
		if (states.get(id) === "visited") continue;
		const path: string[] = [];
		let cursor: string | null = id;
		while (cursor !== null && states.get(cursor) !== "visited") {
			if (states.get(cursor) === "visiting") invalidPortableSession(`entry ancestry contains a cycle at ${cursor}`);
			states.set(cursor, "visiting");
			path.push(cursor);
			cursor = parents.get(cursor) ?? null;
		}
		for (const pathId of path) states.set(pathId, "visited");
	}

	return entries;
}

/** Parse and validate an untrusted portable-session payload. */
export function parsePortableSessionSnapshot(value: unknown): PortableSessionSnapshot {
	if (!isRecord(value)) invalidPortableSession("payload must be an object");
	if (value.format !== PORTABLE_SESSION_FORMAT) invalidPortableSession(`unsupported format ${String(value.format)}`);
	if (value.formatVersion !== PORTABLE_SESSION_FORMAT_VERSION) {
		invalidPortableSession(`unsupported format version ${String(value.formatVersion)}`);
	}

	const header = parseHeader(value.header);
	const entries = parseEntries(value.entries);
	const leafId = value.leafId;
	if (leafId !== null && typeof leafId !== "string") invalidPortableSession("leafId must be a string or null");
	if (leafId !== null && !entries.some(entry => entry.id === leafId)) {
		invalidPortableSession(`leaf ${leafId} does not exist`);
	}

	return {
		format: PORTABLE_SESSION_FORMAT,
		formatVersion: PORTABLE_SESSION_FORMAT_VERSION,
		header,
		entries,
		leafId,
	};
}

/** Build a detached portable snapshot from an already-loaded session. */
export function createPortableSessionSnapshot(
	header: SessionHeader,
	entries: readonly SessionEntry[],
	leafId: string | null,
): PortableSessionSnapshot {
	const portableHeader = structuredClone(header);
	delete portableHeader.previousSessionFiles;
	return {
		format: PORTABLE_SESSION_FORMAT,
		formatVersion: PORTABLE_SESSION_FORMAT_VERSION,
		header: portableHeader,
		entries: structuredClone(entries) as SessionEntry[],
		leafId,
	};
}
