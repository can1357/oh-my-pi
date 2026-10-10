/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 * - skill://<namespace>/<name>[/<path>] - Same, for a collision-namespaced skill
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import { getActiveSkills, refreshActiveSkills, type Skill } from "../extensibility/skills";
import skillDoc from "../prompts/internal-urls/skill.md" with { type: "text" };
import {
	buildDirectoryResource,
	contentTypeForPath,
	ensureCreatableWithinRoot,
	UrlContainmentError,
	validateRelativePath,
} from "./filesystem-resource";
import type {
	InternalResource,
	InternalUrl,
	LocateOptions,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/** A skill name absent from the snapshot a lookup used. */
class UnknownSkillError extends Error {}

/**
 * A bare `skill://<name>` target missing on disk. Also the case where the
 * snapshot is merely stale, so it earns one re-discovery retry — a missing
 * sub-path does not, and stays a plain {@link Error}.
 */
class MissingSkillFileError extends Error {}

/** `<name>` with no relative sub-path addresses the skill itself. */
function isBareSkillUrl(url: InternalUrl): boolean {
	return url.pathname.length <= 1;
}

/** A lookup miss explained by a stale snapshot rather than a genuine absence. */
function isStaleSkillLookup(error: unknown): boolean {
	return error instanceof UnknownSkillError || error instanceof MissingSkillFileError;
}

/** Missing target: retryable when the skill itself is addressed, fatal for a sub-path. */
function missingSkillFile(url: InternalUrl, targetPath: string): Error {
	return isBareSkillUrl(url)
		? new MissingSkillFileError(`File not found: ${targetPath}`)
		: new Error(`File not found: ${targetPath}`);
}

/**
 * Runs `attempt` against `context`'s skill snapshot (else the process one) and,
 * when it reports a stale-snapshot miss, re-discovers skills from disk and runs
 * it once more. {@link refreshActiveSkills} returns the same array when no live
 * session registered a refresher, so the retry — and its cost — is skipped and
 * the original error surfaces.
 */
async function withFreshSkills<T>(
	context: ResolveContext | undefined,
	attempt: (skills: readonly Skill[]) => Promise<T>,
): Promise<T> {
	const snapshot = context?.skills ?? getActiveSkills();
	try {
		return await attempt(snapshot);
	} catch (error) {
		if (!isStaleSkillLookup(error)) throw error;
		const fresh = await refreshActiveSkills(snapshot);
		if (fresh === snapshot) throw error;
		return await attempt(fresh);
	}
}

/**
 * Path a skill:// URL addresses, after traversal and plugin-root containment
 * checks. A bare URL addresses the skill's instruction file, or its base
 * directory when `directory` is set. The path may not exist; with `create`, a
 * missing plugin-skill target is only returned when writing it stays in the plugin root.
 */
async function skillTargetPath(
	url: InternalUrl,
	skills: readonly Skill[],
	directory: boolean,
	create = false,
): Promise<string> {
	const skillName = url.rawHost || url.hostname;
	if (!skillName) {
		throw new Error("skill:// URL requires a skill name: skill://<name>");
	}

	let urlPath = url.pathname;
	let skill: Skill | undefined;
	if (urlPath.length > 1) {
		// A namespaced skill (`<plugin>/<name>`) spans the host and the first
		// path segment. Skill names never contain `/`, so an exact match here
		// is unambiguous and wins over reading `<name>` as a path relative to
		// a bare skill that happens to share the namespace's name.
		const slash = urlPath.indexOf("/", 1);
		const namespaced = `${skillName}/${decodeURIComponent(slash === -1 ? urlPath.slice(1) : urlPath.slice(1, slash))}`;
		skill = skills.find(s => s.name === namespaced);
		if (skill) urlPath = slash === -1 ? "" : urlPath.slice(slash);
	}
	skill ??= skills.find(s => s.name === skillName);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new UnknownSkillError(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
	}

	let resolvedPath: string;
	if (!urlPath || urlPath === "/") {
		resolvedPath = path.resolve(directory ? skill.baseDir : skill.filePath);
	} else {
		const relativePath = decodeURIComponent(urlPath.slice(1));
		validateRelativePath(relativePath, "skill");
		resolvedPath = path.resolve(skill.baseDir, relativePath);
		const resolvedBaseDir = path.resolve(skill.baseDir);
		if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
			throw new Error("Path traversal is not allowed");
		}
	}
	// Agent Plugin skills (§4.1): every target, including the bare instruction
	// file and base directory, must canonically resolve within the plugin root.
	// Symlinks may target other files inside the same package.
	if (!skill.containRoot) return resolvedPath;
	const escape = `skill:// path resolves outside the plugin root: ${url.href}`;
	const contained = await resolveContainedPath(skill.containRoot, resolvedPath);
	if (contained.status === "outside") throw new UrlContainmentError(escape);
	if (contained.status === "ok") return contained.realPath;
	if (create) {
		try {
			await ensureCreatableWithinRoot(resolvedPath, skill.containRoot, "skill", url.href);
		} catch (error) {
			// Same wording as the read path: the plugin root, not a per-skill root, bounds the package.
			throw error instanceof UrlContainmentError ? new UrlContainmentError(escape) : error;
		}
	}
	return resolvedPath;
}

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly spec: SchemeSpec = {
		backing: "file",
		selectors: "lines",
		immutable: true,
		unbounded: true,
		linkable: true,
	};

	/** Advertised only when loaded skills are readable through an active tool. */
	promptDoc(host: SchemeHost): string | undefined {
		return host.skillUriAccess ? skillDoc.trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		return await withFreshSkills(context, skills => this.#resolveAgainst(url, skills));
	}

	/** Read the skill file or directory `url` addresses from one skill snapshot. */
	async #resolveAgainst(url: InternalUrl, skills: readonly Skill[]): Promise<InternalResource> {
		const targetPath = await skillTargetPath(url, skills, false);

		let stats: fsTypes.Stats;
		try {
			stats = await fs.stat(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw missingSkillFile(url, targetPath);
			}
			throw error;
		}

		if (stats.isDirectory()) {
			return buildDirectoryResource(url.href, targetPath);
		}
		if (!stats.isFile()) {
			throw new Error(`skill:// URL must resolve to a file or directory: ${url.href}`);
		}

		const content = await Bun.file(targetPath).text();
		return {
			url: url.href,
			content,
			contentType: contentTypeForPath(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}

	/**
	 * Skill file or directory; `options.directory` maps a bare `skill://<name>` to the skill base dir.
	 * Null for a missing entry (or dangling symlink) without `create`, plugin skill or not.
	 * A miss re-discovers skills from disk once, so a skill added or moved
	 * mid-session is found without a restart.
	 */
	async locate(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		try {
			return await withFreshSkills(context, skills => this.#locateAgainst(url, skills, options));
		} catch (error) {
			// Exhausted the retry: the addressed skill really is gone.
			if (error instanceof MissingSkillFileError) return null;
			throw error;
		}
	}

	/** Resolve `url` against one skill snapshot; a bare miss throws to trigger the retry. */
	async #locateAgainst(
		url: InternalUrl,
		skills: readonly Skill[],
		options?: LocateOptions,
	): Promise<string | null> {
		const targetPath = await skillTargetPath(url, skills, options?.directory === true, options?.create === true);
		if (options?.create) return targetPath;
		try {
			await fs.stat(targetPath);
			return targetPath;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			if (isBareSkillUrl(url)) throw missingSkillFile(url, targetPath);
			return null;
		}
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveSkills().map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
