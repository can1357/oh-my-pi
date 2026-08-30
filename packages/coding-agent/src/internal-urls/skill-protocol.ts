/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill:// - Lists active skills
 * - skill://?q=<term> - Searches active skill names and descriptions
 * - skill://?id=<sha256> - Reads a skill whose name cannot fit a bounded host route
 * - skill://?id=<sha256>&path=<relative> - Reads a relative resource through a bounded alias
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */

import { createHash } from "node:crypto";
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import { compareSkillOrder } from "../discovery/helpers";
import { getActiveSkills, type Skill } from "../extensibility/skills";
import { isMarkdownPath } from "../utils/lang-from-path";
import { buildDirectoryResource } from "./filesystem-resource";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

function getContentType(filePath: string): InternalResource["contentType"] {
	if (isMarkdownPath(filePath)) return "text/markdown";
	return "text/plain";
}

const SKILL_CATALOG_LIMIT = 50;
const SKILL_DESCRIPTION_LIMIT = 200;
const SKILL_QUERY_DISPLAY_LIMIT = 100;
const SKILL_NAME_LIMIT = 64;

interface SkillCatalogEntry {
	skill: Skill;
	description: string;
	route: string;
	searchDescription: string;
}

function sanitizeOneLine(value: string): string {
	return sanitizeText(value)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function skillAliasId(name: string): string {
	return createHash("sha256").update(Buffer.from(name, "utf16le")).digest("hex");
}

function skillUrl(name: string): string {
	if (Array.from(name).length <= SKILL_NAME_LIMIT) {
		try {
			return `skill://${encodeURIComponent(name)}`;
		} catch {
			// Fall through to a bounded exact alias.
		}
	}
	return `skill://?id=${skillAliasId(name)}`;
}

function buildSkillCatalog(url: InternalUrl, skills: readonly Skill[], rawQuery: string | null): InternalResource {
	const query = sanitizeOneLine(rawQuery ?? "");
	const normalizedQuery = query.toLowerCase();
	const entries: SkillCatalogEntry[] = skills
		.map(skill => {
			const description = sanitizeOneLine(skill.description);
			return {
				skill,
				route: skillUrl(skill.name),
				description: truncate(description, SKILL_DESCRIPTION_LIMIT),
				searchDescription: description.toLowerCase(),
			};
		})
		.filter(
			entry =>
				normalizedQuery.length === 0 ||
				entry.skill.name.toLowerCase().includes(normalizedQuery) ||
				entry.searchDescription.includes(normalizedQuery),
		)
		.sort((a, b) => compareSkillOrder(a.skill.name, a.skill.filePath, b.skill.name, b.skill.filePath));
	const visible = entries.slice(0, SKILL_CATALOG_LIMIT);
	const lines =
		normalizedQuery.length === 0
			? [`Active skills (${visible.length} of ${entries.length})`, "Search with skill://?q=<term>."]
			: [
					`Active skills matching "${truncate(query, SKILL_QUERY_DISPLAY_LIMIT)}" (${visible.length} of ${entries.length})`,
				];

	if (visible.length > 0) {
		lines.push(
			"",
			...visible.map(entry => (entry.description ? `${entry.route} — ${entry.description}` : entry.route)),
		);
	} else {
		lines.push("", "No active skills matched. Try a different term with skill://?q=<term>.");
	}

	if (visible.some(entry => entry.route.startsWith("skill://?id="))) {
		lines.push("", "Alias resources: append &path=<encoded-relative> to the emitted skill://?id=<sha256> route.");
	}

	if (entries.length > visible.length) {
		lines.push("", `Results truncated at ${SKILL_CATALOG_LIMIT}. Refine with a narrower skill://?q=<term> search.`);
	}

	const content = `${lines.join("\n")}\n`;
	return {
		url: url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [],
	};
}

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (
		relativePath.split(/[\\/]/).includes("..") ||
		normalized.startsWith("..") ||
		normalized.includes("/../") ||
		normalized.includes("/..")
	) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const skills = context?.skills ?? getActiveSkills();
		const queryKeys = [...url.searchParams.keys()];
		const skillName = url.rawHost || url.hostname;
		const aliasIds = url.searchParams.getAll("id");
		const aliasPaths = url.searchParams.getAll("path");
		let skill: Skill | undefined;
		let relativePath: string | undefined;

		if (skillName) {
			if (queryKeys.length > 0) {
				throw new Error("skill:// search queries are only valid on the catalog root: skill://?q=<term>.");
			}
			skill = skills.find(candidate => candidate.name === skillName);
			const urlPath = url.pathname;
			if (urlPath && urlPath !== "/") relativePath = decodeURIComponent(urlPath.slice(1));
		} else if (aliasIds.length > 0) {
			if (
				queryKeys.some(key => key !== "id" && key !== "path") ||
				aliasIds.length !== 1 ||
				aliasPaths.length > 1 ||
				!/^[0-9a-f]{64}$/u.test(aliasIds[0] ?? "")
			) {
				throw new Error("Invalid skill alias. Use the exact skill://?id=<sha256> route emitted by discovery.");
			}
			const aliasId = aliasIds[0];
			skill = skills.find(candidate => skillAliasId(candidate.name) === aliasId);
			relativePath = aliasPaths[0];
		} else {
			if (queryKeys.some(key => key !== "q") || url.searchParams.getAll("q").length > 1 || aliasPaths.length > 0) {
				throw new Error("Invalid skill:// query. Use skill://?q=<term>.");
			}
			return buildSkillCatalog(
				url,
				skills.filter(candidate => candidate.hide !== true),
				url.searchParams.get("q"),
			);
		}

		if (!skill) {
			const displayName = skillName
				? truncate(sanitizeOneLine(skillName), SKILL_QUERY_DISPLAY_LIMIT)
				: `alias ${aliasIds[0]}`;
			throw new Error(`Unknown skill: ${displayName}\nSearch active skills with skill://?q=<term>`);
		}

		let targetPath: string;

		if (relativePath !== undefined && relativePath !== "") {
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);

			const resolvedPath = path.resolve(targetPath);
			const resolvedBaseDir = path.resolve(skill.baseDir);
			if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
				throw new Error("Path traversal is not allowed");
			}
			// Agent Plugin skills (§4.1): the resource must canonically resolve
			// within the plugin root; a dangling or unresolvable path fails closed.
			// Symlinks may target other files inside the same package.
			if (skill.containRoot) {
				const contained = await resolveContainedPath(skill.containRoot, resolvedPath);
				if (contained.status === "outside") {
					throw new Error(`skill:// path resolves outside the plugin root: ${url.href}`);
				}
				if (contained.status === "missing") {
					throw new Error(`File not found: ${resolvedPath}`);
				}
				targetPath = contained.realPath;
			}
		} else {
			targetPath = context?.pathOnly === true ? skill.baseDir : skill.filePath;
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
			contentType: getContentType(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveSkills().map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
