/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import { getActiveSkills, type Skill } from "../extensibility/skills";
import skillDoc from "../prompts/internal-urls/skill.md" with { type: "text" };
import {
	buildDirectoryResource,
	contentTypeForPath,
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

/**
 * Would-be path for a missing plugin-skill target: the nearest existing
 * ancestor must canonically resolve inside the plugin root, and no entry on
 * the way may be a dangling symlink a write would follow out of the package.
 */
async function containedCreatePath(containRoot: string, target: string, href: string): Promise<string> {
	for (let current = target; ; current = path.dirname(current)) {
		const contained = await resolveContainedPath(containRoot, current);
		if (contained.status === "outside") {
			throw new UrlContainmentError(`skill:// path resolves outside the plugin root: ${href}`);
		}
		if (contained.status === "ok") return target;
		try {
			await fs.lstat(current);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			if (path.dirname(current) === current) return target;
			continue;
		}
		throw new UrlContainmentError(`skill:// path goes through a dangling symlink: ${href}`);
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

	const skill = skills.find(s => s.name === skillName);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new Error(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
	}

	const urlPath = url.pathname;
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
	const contained = await resolveContainedPath(skill.containRoot, resolvedPath);
	if (contained.status === "outside") {
		throw new UrlContainmentError(`skill:// path resolves outside the plugin root: ${url.href}`);
	}
	if (contained.status === "ok") return contained.realPath;
	return create ? containedCreatePath(skill.containRoot, resolvedPath, url.href) : resolvedPath;
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
		const targetPath = await skillTargetPath(url, context?.skills ?? getActiveSkills(), false);

		let stats: fsTypes.Stats;
		try {
			stats = await fs.stat(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`File not found: ${targetPath}`);
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

	/** Skill file or directory; `options.directory` maps a bare `skill://<name>` to the skill base dir. */
	async locate(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		const targetPath = await skillTargetPath(
			url,
			context?.skills ?? getActiveSkills(),
			options?.directory === true,
			options?.create === true,
		);
		if (options?.create) return targetPath;
		try {
			await fs.stat(targetPath);
			return targetPath;
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveSkills().map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
