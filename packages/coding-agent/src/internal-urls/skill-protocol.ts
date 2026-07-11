/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * - skill:// - Lists skill names only (compact index)
 * - skill://?q=<keywords> - Searches skill names/descriptions
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import { getActiveSkills, type Skill } from "../extensibility/skills";
import { buildDirectoryResource } from "./filesystem-resource";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	return "text/plain";
}

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}

const DEFAULT_SKILL_INDEX_LIMIT = 50;
const DEFAULT_SKILL_SEARCH_LIMIT = 8;
const MAX_SKILL_LOOKUP_LIMIT = 50;

interface RankedSkill {
	readonly skill: Skill;
	readonly score: number;
}

interface SkillSearchRequest {
	readonly query: string;
	readonly limit: number;
}

function getSkillQuery(searchParams: URLSearchParams): string {
	return (searchParams.get("q") ?? searchParams.get("query") ?? "").trim();
}

function parseLimit(searchParams: URLSearchParams, fallback: number): number {
	const raw = searchParams.get("limit");
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, MAX_SKILL_LOOKUP_LIMIT);
}

function splitQueryTerms(query: string): readonly string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(term => term.length > 0);
}

function scoreSkill(skill: Skill, query: string, terms: readonly string[]): number {
	const name = skill.name.toLowerCase();
	const description = skill.description.toLowerCase();
	const fullQuery = query.toLowerCase();
	let score = 0;

	if (name === fullQuery) score += 200;
	else if (name.startsWith(fullQuery)) score += 120;
	else if (name.includes(fullQuery)) score += 80;
	else if (description.includes(fullQuery)) score += 40;

	for (const term of terms) {
		if (name === term) score += 50;
		else if (name.startsWith(term)) score += 35;
		else if (name.includes(term)) score += 20;
		else if (description.includes(term)) score += 8;
	}

	return score;
}

function searchSkills(skills: readonly Skill[], query: string, limit: number): readonly Skill[] {
	const terms = splitQueryTerms(query);
	if (terms.length === 0) return [];
	return skills
		.map((skill): RankedSkill => ({ skill, score: scoreSkill(skill, query, terms) }))
		.filter(ranked => ranked.score > 0)
		.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
		.slice(0, limit)
		.map(ranked => ranked.skill);
}

function formatSkillDescription(skill: Skill): string {
	return `- ${skill.name}: ${skill.description || "(no description)"}`;
}

/** Compact markdown index for bare `skill://` reads. Hidden skills stay opt-in. */
function listSkillsResource(href: string, skills: readonly Skill[], limit: number): InternalResource {
	const listed = skills.filter(skill => skill.hide !== true);
	const shown = listed.slice(0, limit);
	const lines = shown.length > 0 ? shown.map(skill => `- ${skill.name}`) : ["(no skills available)"];
	const truncated = listed.length > shown.length;
	const content = [
		`# Skills (${listed.length})`,
		"",
		"Use `skill://?q=<keywords>` to search skill descriptions. Read `skill://<name>` for full instructions.",
		"",
		...lines,
		...(truncated ? ["", `Showing ${shown.length} of ${listed.length}. Narrow with \`skill://?q=<keywords>\`.`] : []),
		"",
	].join("\n");
	return {
		url: href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [],
	};
}

/** Focused markdown search for `skill://?q=...` reads. */
function searchSkillsResource(href: string, skills: readonly Skill[], request: SkillSearchRequest): InternalResource {
	const listed = skills.filter(skill => skill.hide !== true);
	const matches = searchSkills(listed, request.query, request.limit);
	const lines = matches.length > 0 ? matches.map(formatSkillDescription) : ["(no matching skills)"];
	const content = [
		`# Skill Search: ${request.query}`,
		"",
		`Matches (${matches.length} of ${listed.length}; limit ${request.limit})`,
		"",
		...lines,
		"",
		"Read `skill://<name>` for a skill's full instructions.",
		"",
	].join("\n");
	return {
		url: href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [],
	};
}

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const skills = context?.skills ?? getActiveSkills();

		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			const query = getSkillQuery(url.searchParams);
			const limit = parseLimit(url.searchParams, query ? DEFAULT_SKILL_SEARCH_LIMIT : DEFAULT_SKILL_INDEX_LIMIT);
			return query
				? searchSkillsResource(url.href, skills, { query, limit })
				: listSkillsResource(url.href, skills, limit);
		}

		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const suggestions = searchSkills(
				skills.filter(s => s.hide !== true),
				skillName,
				5,
			).map(s => s.name);
			const suggestionText =
				suggestions.length > 0
					? `\nClosest matches: ${suggestions.join(", ")}`
					: "\nSearch with skill://?q=<keywords>.";
			throw new Error(`Unknown skill: ${skillName}${suggestionText}`);
		}

		let targetPath: string;
		const urlPath = url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		// Embedded skills have no auxiliary files — reject any sub-path immediately.
		if (hasRelativePath && skill.embeddedContent !== undefined) {
			throw new Error("embedded builtin skill has no auxiliary files");
		}

		if (hasRelativePath) {
			const relativePath = decodeURIComponent(urlPath.slice(1));
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);

			const resolvedPath = path.resolve(targetPath);
			const resolvedBaseDir = path.resolve(skill.baseDir);
			if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
				throw new Error("Path traversal is not allowed");
			}
		} else {
			targetPath = skill.filePath;
		}

		// Serve embedded content directly when no disk path is available.
		if (skill.embeddedContent !== undefined) {
			return {
				url: url.href,
				content: skill.embeddedContent,
				contentType: "text/markdown",
				size: Buffer.byteLength(skill.embeddedContent, "utf-8"),
				sourcePath: skill.filePath,
				notes: [],
			};
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
