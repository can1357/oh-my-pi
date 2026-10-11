/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 * - skill://<namespace>/<name>[/<path>] - Same, for a collision-namespaced skill
 * - Any skill:// URI an MCP server advertises, when no loaded skill owns it - Reads that MCP resource
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import { getActiveSkills, type Skill } from "../extensibility/skills";
import { MCPManager } from "../mcp/manager";
import skillDoc from "../prompts/internal-urls/skill.md" with { type: "text" };
import {
	buildDirectoryResource,
	contentTypeForPath,
	ensureCreatableWithinRoot,
	UrlContainmentError,
	validateRelativePath,
} from "./filesystem-resource";
import { readMcpResource } from "./mcp-protocol";
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

/** No loaded skill owns the URL's name; the only miss an MCP server may fill. */
class UnknownSkillError extends Error {}

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
		let targetPath: string;
		try {
			targetPath = await skillTargetPath(url, context?.skills ?? getActiveSkills(), false);
		} catch (error) {
			if (!(error instanceof UnknownSkillError)) throw error;
			// Loaded skills always win; otherwise serve the resource an MCP server advertises under
			// exactly this URI (Figma's `skill://figma/figma-use/SKILL.md`). Templates stay behind `mcp://`.
			// A deferred MCP startup that fails cannot change the diagnosis: the skill is still unknown.
			let mcpManager: MCPManager | undefined;
			try {
				mcpManager = await MCPManager.load();
			} catch (loadError) {
				if (context?.signal?.aborted) throw loadError;
				logger.debug("MCP startup failed while resolving an unknown skill", { url: url.href, error: loadError });
				throw error;
			}
			const resource =
				mcpManager && (await readMcpResource(mcpManager, url, { exact: true, signal: context?.signal }));
			if (!resource) throw error;
			// The server, not a loaded skill, sizes this text: keep `read`'s normal result limits.
			return { ...resource, unbounded: false };
		}

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

	/**
	 * Skill file or directory; `options.directory` maps a bare `skill://<name>` to the skill base dir.
	 * Null for a missing entry (or dangling symlink) without `create`, plugin skill or not, and for a
	 * name no loaded skill owns while MCP is available unless `options.localOnly`: an MCP server may
	 * advertise the URL, which {@link resolve} settles (its servers may still be connecting).
	 */
	async locate(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		const skills = context?.skills ?? getActiveSkills();
		let targetPath: string;
		try {
			targetPath = await skillTargetPath(url, skills, options?.directory === true, options?.create === true);
		} catch (error) {
			if (error instanceof UnknownSkillError && !options?.localOnly && MCPManager.available()) return null;
			throw error;
		}
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
