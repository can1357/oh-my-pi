/**
 * Remote skill index and content cache.
 *
 * - Index: discovery descriptors (`name`, `description`, pinned `commit`).
 * - Cache: read-through content at an immutable commit, so the body and every
 *   resource of one task come from the same revision.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { assertSkillRelativePath, MAX_RESOURCE_BYTES, readRemoteFile, type FetchFn } from "./source";
import {
	EMPTY_REMOTE_SKILL_INDEX,
	RemoteSkillError,
	type RemoteSkillDescriptor,
	type RemoteSkillIndex,
	type RemoteSkillSource,
} from "./types";

export const REMOTE_SKILL_INDEX_FILE = "remote-skills.json";
export const REMOTE_SKILL_INDEX_VERSION = 1;
export const REMOTE_SKILL_PROVIDER_ID = "remote";

/** In-flight fetches keyed by cache path: concurrent reads share one download. */
const inFlight = new Map<string, Promise<string>>();

/** Project index path: nearest `<dir>/.omp/remote-skills.json` walking up from `cwd`. */
export async function findProjectRemoteSkillIndex(cwd: string): Promise<string | undefined> {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".omp", REMOTE_SKILL_INDEX_FILE);
		if (await fileExists(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** User index path (`<agentDir>/remote-skills.json`). */
export function userRemoteSkillIndexPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, REMOTE_SKILL_INDEX_FILE);
}

/** Project index path used when creating one (`<cwd>/.omp/remote-skills.json`). */
export function projectRemoteSkillIndexPath(cwd: string): string {
	return path.join(path.resolve(cwd), ".omp", REMOTE_SKILL_INDEX_FILE);
}

export async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function validateDescriptor(name: string, value: unknown, file: string): RemoteSkillDescriptor {
	if (!isRecord(value)) throw new RemoteSkillError("INVALID_SKILL", `${file}: "${name}" is not an object`);
	const { origin, repository, directory, commit, ref, description } = value;
	if (origin !== "github") throw new RemoteSkillError("INVALID_SKILL", `${file}: "${name}" has an unknown origin`);
	if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
		throw new RemoteSkillError("INVALID_SKILL", `${file}: "${name}" has an invalid repository`);
	}
	if (typeof directory !== "string")
		throw new RemoteSkillError("INVALID_SKILL", `${file}: "${name}" has no directory`);
	if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
		throw new RemoteSkillError("INVALID_SKILL", `${file}: "${name}" has no pinned commit`);
	}
	if (typeof ref !== "string") throw new RemoteSkillError("INVALID_SKILL", `${file}: "${name}" has no ref`);
	if (typeof description !== "string")
		throw new RemoteSkillError("INVALID_SKILL", `${file}: "${name}" has no description`);
	return { name, origin: "github", repository, directory, commit, ref, description };
}

/** Read an index file. A missing file is an empty index; malformed JSON throws. */
export async function readRemoteSkillIndex(file: string): Promise<RemoteSkillIndex> {
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error)) return EMPTY_REMOTE_SKILL_INDEX;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new RemoteSkillError("INVALID_SKILL", `${file}: invalid JSON (${String(error)})`);
	}
	if (!isRecord(parsed) || parsed.version !== REMOTE_SKILL_INDEX_VERSION || !isRecord(parsed.skills)) {
		throw new RemoteSkillError("INVALID_SKILL", `${file}: unsupported remote skill index`);
	}
	const skills: Record<string, RemoteSkillDescriptor> = {};
	for (const [name, value] of Object.entries(parsed.skills)) {
		skills[name] = validateDescriptor(name, value, file);
	}
	return { version: REMOTE_SKILL_INDEX_VERSION, skills };
}

/** Write an index atomically; sorted keys keep diffs stable. */
export async function writeRemoteSkillIndex(file: string, index: RemoteSkillIndex): Promise<void> {
	const skills: Record<string, RemoteSkillDescriptor> = {};
	for (const name of Object.keys(index.skills).sort()) skills[name] = index.skills[name]!;
	const body = `${JSON.stringify({ version: REMOTE_SKILL_INDEX_VERSION, skills }, null, "\t")}\n`;
	await writeFileAtomic(file, body);
}

async function writeFileAtomic(file: string, body: string | Uint8Array): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		await Bun.write(tmp, body);
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

/** Root of the remote skill content cache. */
export function remoteSkillCacheRoot(agentDir: string = getAgentDir()): string {
	return path.join(path.dirname(agentDir), "cache", "remote-skills");
}

/**
 * Cached path of one resource. The commit segment makes a task's reads
 * independent of later `sync` runs.
 */
export function remoteSkillCachePath(
	source: RemoteSkillSource,
	relativePath: string,
	agentDir: string = getAgentDir(),
): string {
	const safeRelative = assertSkillRelativePath(relativePath);
	return path.join(
		remoteSkillCacheRoot(agentDir),
		...source.repository.split("/"),
		source.commit,
		...source.directory.split("/").filter(Boolean),
		...safeRelative.split("/"),
	);
}

export interface EnsureRemoteResourceOptions {
	fetch?: FetchFn;
	signal?: AbortSignal;
	agentDir?: string;
	maxBytes?: number;
}

/**
 * Return a local path for one resource of a remote skill, fetching it on first
 * use. Concurrent requests for the same revision/path share one download, and
 * a failed download never leaves a cache hit behind.
 */
export function ensureRemoteSkillResource(
	source: RemoteSkillSource,
	relativePath: string,
	options: EnsureRemoteResourceOptions = {},
): Promise<string> {
	const target = remoteSkillCachePath(source, relativePath, options.agentDir);
	const pending = inFlight.get(target);
	if (pending) return pending;
	const run = (async () => {
		if (await fileExists(target)) return target;
		const repositoryPath = source.directory === "" ? relativePath : `${source.directory}/${relativePath}`;
		let bytes: Uint8Array | null;
		try {
			bytes = await readRemoteFile(source.repository, source.commit, repositoryPath, {
				fetch: options.fetch,
				signal: options.signal,
				maxBytes: options.maxBytes ?? MAX_RESOURCE_BYTES,
			});
		} catch (error) {
			if (error instanceof RemoteSkillError && (error.code === "NETWORK" || error.code === "RATE_LIMITED")) {
				throw new RemoteSkillError(
					"OFFLINE_RESOURCE_MISSING",
					`${source.repository}@${source.commit}:${repositoryPath} is not cached and the source is unreachable (${error.message})`,
					{ cause: error },
				);
			}
			throw error;
		}
		if (bytes === null) {
			throw new RemoteSkillError("NOT_FOUND", `${source.repository}@${source.commit}:${repositoryPath}`);
		}
		await fs.mkdir(path.dirname(target), { recursive: true });
		const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
		try {
			await Bun.write(tmp, bytes);
			await fs.rename(tmp, target);
		} catch (error) {
			await fs.rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
		return target;
	})().finally(() => {
		inFlight.delete(target);
	});
	inFlight.set(target, run);
	return run;
}

/** One registered descriptor plus the scope it came from. */
export interface RemoteSkillIndexEntry {
	descriptor: RemoteSkillDescriptor;
	level: "user" | "project";
	indexFile: string;
}

/** Merge project and user indexes; the project entry wins a name collision. */
export async function loadRemoteSkillDescriptors(
	cwd: string,
	agentDir: string = getAgentDir(),
): Promise<RemoteSkillIndexEntry[]> {
	const out: RemoteSkillIndexEntry[] = [];
	const projectFile = await findProjectRemoteSkillIndex(cwd);
	const userFile = userRemoteSkillIndexPath(agentDir);
	const [project, user] = await Promise.all([
		projectFile ? readRemoteSkillIndex(projectFile).catch(rethrowWithLog) : EMPTY_REMOTE_SKILL_INDEX,
		readRemoteSkillIndex(userFile).catch(rethrowWithLog),
	]);
	for (const descriptor of Object.values(user.skills)) {
		out.push({ descriptor, level: "user", indexFile: userFile });
	}
	if (projectFile) {
		for (const [name, descriptor] of Object.entries(project.skills)) {
			const existing = out.findIndex(entry => entry.descriptor.name === name);
			const entry = { descriptor, level: "project" as const, indexFile: projectFile };
			if (existing === -1) out.push(entry);
			else out[existing] = entry;
		}
	}
	return out;
}

function rethrowWithLog(error: unknown): never {
	logger.warn("remote skill index is invalid and was skipped", { error: String(error) });
	throw error;
}
