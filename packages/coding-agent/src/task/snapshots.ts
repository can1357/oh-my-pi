/*
 * Saves completed task-child branches under their parent session.
 * Validates the frozen transcript before each independent child fork.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import { loadSessionFile } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";

export interface TaskSnapshot {
	id: string;
	label: string;
	agentName: string;
	agentId: string;
	sourceSessionId: string;
	filePath: string;
	checksum: string;
	leafId: string;
	createdAt: string;
	cwd: string;
	systemPrompt: string;
	agentPrompt?: string;
	tools: string[];
	resolvedModel?: string;
}

interface SnapshotManifest extends TaskSnapshot {
	artifacts: Record<string, string>;
}

export interface PublishTaskSnapshotOptions {
	parentSessionFile: string;
	sourceSessionFile: string;
	label: string;
	agentName: string;
	agentId: string;
	agentPrompt?: string;
}

export interface LoadTaskSnapshotOptions {
	parentSessionFile: string;
	reference: string;
}

// Stores task snapshots beside the parent session, so they survive a process restart.
function snapshotRoot(parentSessionFile: string): string {
	if (!path.isAbsolute(parentSessionFile) || !parentSessionFile.endsWith(".jsonl")) {
		throw new Error("A persisted parent session file is required for task snapshots");
	}
	return path.join(parentSessionFile.slice(0, -".jsonl".length), "task-snapshots");
}

// Maps a label to one safe directory name without changing its display value.
function labelDirectory(label: string): string {
	if (!label || label.trim() !== label || Buffer.byteLength(label) > 120 || /[\x00-\x1f\x7f]/.test(label)) {
		throw new Error(
			"Task snapshot label must be a non-empty, trimmed string of at most 120 bytes without control characters",
		);
	}
	return Buffer.from(label, "utf8").toString("base64url");
}

// Hashes bytes from disk before publication and before every fork.
function hashFile(file: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const hash = crypto.createHash("sha256");
	const stream = fs.createReadStream(file);
	stream.on("error", reject);
	stream.on("data", chunk => hash.update(chunk));
	stream.on("end", () => resolve(hash.digest("hex")));
	return promise;
}

/** Record every regular artifact's hash; reject links so a snapshot cannot point outside its immutable directory. */
async function artifactHashes(directory: string): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	// Visits each copied artifact and records its checksum.
	async function visit(current: string, prefix: string): Promise<void> {
		const entries = await fs.promises.readdir(current, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const file = path.join(current, entry.name);
			if (entry.isDirectory()) await visit(file, relative);
			else if (entry.isFile()) hashes[relative] = await hashFile(file);
			else throw new Error(`Unsupported task snapshot artifact: ${relative}`);
		}
	}
	await visit(directory, "");
	return hashes;
}

// Keeps only the active branch and requires its last turn to have a terminal yield.
function completedBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (!entry.id || byId.has(entry.id)) throw new Error("Source session has duplicate or missing entry ids");
		byId.set(entry.id, entry);
	}
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = entries.at(-1);
	while (current) {
		if (seen.has(current.id)) throw new Error("Source session branch contains a cycle");
		seen.add(current.id);
		branch.push(current);
		if (current.parentId && !byId.has(current.parentId))
			throw new Error("Source session branch has a missing parent");
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	let lastMessage: SessionEntry | undefined;
	const calls = new Set<string>();
	let lastYield: { status?: string; type?: unknown } | undefined;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		lastMessage = entry;
		if (entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type === "toolCall" && block.name === "yield") calls.add(block.id);
			}
		} else if (entry.message.role === "toolResult" && entry.message.toolName === "yield") {
			if (!calls.has(entry.message.toolCallId)) throw new Error("Source session has an unpaired yield result");
			lastYield = entry.message.details as { status?: string; type?: unknown } | undefined;
		}
	}
	if (
		lastYield?.status !== "success" ||
		Array.isArray(lastYield.type) ||
		lastMessage?.type !== "message" ||
		lastMessage.message.role !== "toolResult" ||
		lastMessage.message.toolName !== "yield"
	) {
		throw new Error("Source session has no completed terminal yield");
	}
	return branch;
}

/** Publish an exclusive, branch-only child snapshot under the parent's artifact directory. */
export async function publishTaskSnapshot(options: PublishTaskSnapshotOptions): Promise<TaskSnapshot> {
	const { parentSessionFile, sourceSessionFile, label, agentName, agentId } = options;
	const root = snapshotRoot(parentSessionFile);
	const dir = path.join(root, labelDirectory(label));
	if (!path.isAbsolute(sourceSessionFile) || !sourceSessionFile.endsWith(".jsonl")) {
		throw new Error("A persisted child session file is required for task snapshots");
	}
	const loaded = await loadSessionFile(sourceSessionFile, undefined, { throwIfMissing: true });
	if (loaded.invalidHeader || loaded.malformedRecords || loaded.entries[0]?.type !== "session") {
		throw new Error("Source session is missing or corrupt");
	}
	const header = loaded.entries[0] as SessionHeader;
	const branch = completedBranch(loaded.entries.slice(1) as SessionEntry[]);
	const init = branch.findLast(entry => entry.type === "session_init");
	const peek = await SessionManager.peekSessionInit(sourceSessionFile);
	if (!init || init.type !== "session_init" || !peek?.init || peek.init.systemPrompt !== init.systemPrompt) {
		throw new Error("Source session lacks a valid branch session_init contract");
	}
	const retained: SessionEntry[] = [];
	for (const entry of branch) {
		if (entry.type === "session_init") continue;
		retained.push({ ...entry, parentId: retained.at(-1)?.id ?? null });
	}
	const filePath = path.join(dir, "session.jsonl");
	const snapshot: Omit<TaskSnapshot, "checksum"> = {
		id: Bun.randomUUIDv7(),
		label,
		agentName,
		agentId,
		sourceSessionId: header.id,
		filePath,
		leafId: retained.at(-1)?.id ?? "",
		createdAt: new Date().toISOString(),
		cwd: header.cwd,
		systemPrompt: init.systemPrompt,
		tools: [...init.tools],
		...(options.agentPrompt !== undefined ? { agentPrompt: options.agentPrompt } : {}),
		...(init.resolvedModel !== undefined ? { resolvedModel: init.resolvedModel } : {}),
	};
	if (!snapshot.leafId || !snapshot.cwd) throw new Error("Source session branch or cwd is missing");
	await fs.promises.mkdir(root, { recursive: true });
	try {
		await fs.promises.mkdir(dir);
	} catch (error) {
		if (isEexist(error)) throw new Error(`Task snapshot label already exists: ${label}`);
		throw error;
	}
	try {
		const contents = [JSON.stringify(header), ...retained.map(entry => JSON.stringify(entry))].join("\n") + "\n";
		await Bun.write(filePath, contents);
		const sourceArtifacts = sourceSessionFile.slice(0, -".jsonl".length);
		const destinationArtifacts = filePath.slice(0, -".jsonl".length);
		try {
			const stat = await fs.promises.lstat(sourceArtifacts);
			if (!stat.isDirectory()) throw new Error("Source artifact path is not a directory");
			await fs.promises.cp(sourceArtifacts, destinationArtifacts, { recursive: true });
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const artifacts = await fs.promises.stat(destinationArtifacts).then(
			() => artifactHashes(destinationArtifacts),
			error => {
				if (isEnoent(error)) return {};
				throw error;
			},
		);
		const manifest: SnapshotManifest = { ...snapshot, checksum: await hashFile(filePath), artifacts };
		// The manifest is the commit marker: no reader sees a published snapshot before rename.
		await Bun.write(path.join(dir, "manifest.pending"), JSON.stringify(manifest));
		await fs.promises.rename(path.join(dir, "manifest.pending"), path.join(dir, "manifest.json"));
		const { artifacts: _artifacts, ...published } = manifest;
		return published;
	} catch (error) {
		await fs.promises.rm(dir, { recursive: true, force: true });
		throw error;
	}
}

/** Resolve a snapshot by label or id, rejecting incomplete or altered copies. */
export async function loadTaskSnapshot(options: LoadTaskSnapshotOptions): Promise<TaskSnapshot> {
	const { parentSessionFile, reference } = options;
	const root = snapshotRoot(parentSessionFile);
	let directories: string[];
	try {
		directories = await fs.promises.readdir(root);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Task snapshot not found: ${reference}`);
		throw error;
	}
	const named = labelDirectory(reference);
	const ordered = directories.includes(named) ? [named] : directories;
	for (const name of ordered) {
		if (name === "." || name === "..") continue;
		const dir = path.join(root, name);
		let manifest: SnapshotManifest;
		try {
			manifest = (await Bun.file(path.join(dir, "manifest.json")).json()) as SnapshotManifest;
		} catch (error) {
			if (name !== named) continue;
			throw new Error(`Task snapshot is incomplete or corrupt: ${name}`, { cause: error });
		}
		if (typeof manifest !== "object" || manifest === null) {
			if (name !== named) continue;
			throw new Error(`Task snapshot metadata is corrupt: ${reference}`);
		}
		if (manifest.id !== reference && manifest.label !== reference) continue;
		if (
			typeof manifest.label !== "string" ||
			name !== labelDirectory(manifest.label) ||
			manifest.filePath !== path.join(dir, "session.jsonl")
		) {
			throw new Error(`Task snapshot metadata is corrupt: ${reference}`);
		}
		try {
			if ((await hashFile(manifest.filePath)) !== manifest.checksum) throw new Error("Session checksum mismatch");
			const artifactsDir = manifest.filePath.slice(0, -".jsonl".length);
			const actual = await fs.promises.stat(artifactsDir).then(
				() => artifactHashes(artifactsDir),
				error => {
					if (isEnoent(error)) return {};
					throw error;
				},
			);
			if (JSON.stringify(actual) !== JSON.stringify(manifest.artifacts))
				throw new Error("Artifact checksum mismatch");
		} catch (error) {
			throw new Error(`Task snapshot is missing or corrupt: ${reference}`, { cause: error });
		}
		const { artifacts: _artifacts, ...snapshot } = manifest;
		return snapshot;
	}
	throw new Error(`Task snapshot not found: ${reference}`);
}
