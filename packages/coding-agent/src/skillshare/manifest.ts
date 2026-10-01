/**
 * Skillshare install manifest (`skills.json`) and lockfile (`skills.lock.json`).
 *
 * Project files live in the active project's `.omp/` directory (the same root
 * the plugin registry uses); user-global files live in the agent dir. Unpacked
 * packages live in a shared store: `<config root>/skillshare/@scope/name/<version>/`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { OmpErrors, type } from "@oh-my-pi/omptype";
import { getAgentDir, hasFsCode, isEnoent } from "@oh-my-pi/pi-utils";
import { resolveOrDefaultProjectRegistryPath } from "../discovery/helpers";
import { replaceFileAtomically } from "../utils/atomic-file";

export const SKILLS_MANIFEST_FILE = "skills.json";
export const SKILLS_LOCK_FILE = "skills.lock.json";
export const SKILLS_LOCK_VERSION = 1;

/** `skills.json`: `@scope/name` → semver range, exact version, or dist-tag. */
export interface SkillsManifest {
	skills: Record<string, string>;
}

export interface SkillsLockEntry {
	version: string;
	/** SRI `sha512-<base64>` of the tarball. */
	integrity: string;
	/** Registry-relative tarball route. */
	resolved: string;
}

/** `skills.lock.json`: exact versions installed for every manifest entry. */
export interface SkillsLock {
	version: typeof SKILLS_LOCK_VERSION;
	skills: Record<string, SkillsLockEntry>;
}

export interface SkillsInstallPaths {
	/** Directory holding the manifest and lock. */
	dir: string;
	manifest: string;
	lock: string;
}

const SKILL_ID_RE = /^@[a-z0-9][a-z0-9_]{2,31}\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Exact semver; also keeps lockfile versions from escaping the store as path segments. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const ManifestSchema = type({ "skills?": { "[string]": "string > 0" } });
const LockEntrySchema = type({ version: "string > 0", integrity: "string > 0", resolved: "string" });
const LockSchema = type({ version: "1", "skills?": { "[string]": LockEntrySchema } });

/** `@scope/name` package id. */
export function formatSkillId(scope: string, name: string): string {
	return `@${scope}/${name}`;
}

/** Split a validated `@scope/name` id; null when malformed. */
export function parseSkillId(id: string): { scope: string; name: string } | null {
	if (!SKILL_ID_RE.test(id)) return null;
	const slash = id.indexOf("/");
	return { scope: id.slice(1, slash), name: id.slice(slash + 1) };
}

/** Manifest + lock paths for the user-global install (`~/.omp/agent/`). */
export function getGlobalSkillsInstallPaths(): SkillsInstallPaths {
	return installPathsIn(getAgentDir());
}

/**
 * Manifest + lock paths for a project: the nearest `.omp/` walking up from
 * `cwd`, else the git root's `.omp/`, else `<cwd>/.omp/`. Throws when `cwd` is
 * the home directory, whose `.omp/` is the user config root, not a project.
 */
export async function getProjectSkillsInstallPaths(cwd: string): Promise<SkillsInstallPaths> {
	const registryPath = await resolveOrDefaultProjectRegistryPath(cwd);
	if (!registryPath) {
		throw new Error("The home directory is not a project; pass --global to install for your user.");
	}
	// `<root>/.omp/plugins/installed_plugins.json` → `<root>/.omp`
	return installPathsIn(path.dirname(path.dirname(registryPath)));
}

export function getSkillsInstallPaths(opts: { global: boolean; cwd: string }): Promise<SkillsInstallPaths> {
	return opts.global ? Promise.resolve(getGlobalSkillsInstallPaths()) : getProjectSkillsInstallPaths(opts.cwd);
}

function installPathsIn(dir: string): SkillsInstallPaths {
	return { dir, manifest: path.join(dir, SKILLS_MANIFEST_FILE), lock: path.join(dir, SKILLS_LOCK_FILE) };
}

/** Root of the unpacked package store, next to the agent dir. */
export function getSkillshareStoreDir(): string {
	return path.join(path.dirname(getAgentDir()), "skillshare");
}

/** Unpacked directory of one installed version. Throws on ids or versions that are not path-safe. */
export function getSkillStorePath(scope: string, name: string, version: string): string {
	if (!parseSkillId(formatSkillId(scope, name)) || !SEMVER_RE.test(version) || version.includes("..")) {
		throw new Error(`Invalid skill store coordinates: @${scope}/${name}@${version}`);
	}
	return path.join(getSkillshareStoreDir(), `@${scope}`, name, version);
}

/** Hidden file inside every store dir recording the verified tarball integrity; written last. */
export const STORE_INTEGRITY_FILE = ".skillshare-integrity";

/**
 * Integrity a store dir was unpacked from; null when the dir (or its marker)
 * is missing, i.e. the unpack never completed.
 */
export async function readStoredIntegrity(dir: string): Promise<string | null> {
	try {
		return (await fs.readFile(path.join(dir, STORE_INTEGRITY_FILE), "utf8")).trim();
	} catch (error) {
		if (isEnoent(error) || hasFsCode(error, "ENOTDIR")) return null;
		throw error;
	}
}

function parseJson(text: string, file: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
}

function assertSkillIds(ids: Record<string, unknown>, file: string): void {
	for (const id in ids) {
		if (!parseSkillId(id)) throw new Error(`${file}: invalid skill id "${id}" (expected @scope/name)`);
	}
}

/** Parse `skills.json` text; throws with the file path on malformed content. */
export function parseSkillsManifest(text: string, file: string): SkillsManifest {
	const checked = ManifestSchema(parseJson(text, file));
	if (checked instanceof OmpErrors) throw new Error(`${file}: ${checked.summary}`);
	const skills = checked.skills ?? {};
	assertSkillIds(skills, file);
	return { skills };
}

/** Parse `skills.lock.json` text; throws with the file path on malformed content. */
export function parseSkillsLock(text: string, file: string): SkillsLock {
	const checked = LockSchema(parseJson(text, file));
	if (checked instanceof OmpErrors) throw new Error(`${file}: ${checked.summary}`);
	const skills = checked.skills ?? {};
	assertSkillIds(skills, file);
	for (const id in skills) {
		const { version } = skills[id]!;
		if (!SEMVER_RE.test(version)) throw new Error(`${file}: "${id}" has invalid version "${version}"`);
	}
	return { version: SKILLS_LOCK_VERSION, skills };
}

async function readText(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** Read `skills.json`; a missing file is an empty manifest. */
export async function readSkillsManifest(file: string): Promise<SkillsManifest> {
	const text = await readText(file);
	return text === null ? { skills: {} } : parseSkillsManifest(text, file);
}

/** Read `skills.lock.json`; a missing file is an empty lock. */
export async function readSkillsLock(file: string): Promise<SkillsLock> {
	const text = await readText(file);
	return text === null ? { version: SKILLS_LOCK_VERSION, skills: {} } : parseSkillsLock(text, file);
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) out[key] = record[key]!;
	return out;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tempPath = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(tempPath, `${JSON.stringify(value, null, 2)}\n`);
		await replaceFileAtomically(tempPath, file);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
}

/** Write `skills.json` with keys sorted for stable diffs. */
export function writeSkillsManifest(file: string, manifest: SkillsManifest): Promise<void> {
	return writeJsonAtomic(file, { skills: sortedRecord(manifest.skills) });
}

/** Write `skills.lock.json` with keys sorted for stable diffs. */
export function writeSkillsLock(file: string, lock: SkillsLock): Promise<void> {
	const skills: Record<string, SkillsLockEntry> = {};
	for (const id of Object.keys(lock.skills).sort()) {
		const { version, integrity, resolved } = lock.skills[id]!;
		skills[id] = { version, integrity, resolved };
	}
	return writeJsonAtomic(file, { version: SKILLS_LOCK_VERSION, skills });
}
