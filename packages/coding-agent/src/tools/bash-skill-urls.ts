import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveContainedPathSync } from "../discovery/contained-path";
import type { Rule } from "../capability/rule";
import type { Skill } from "../extensibility/skills";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import { validateRelativePath } from "../internal-urls/skill-protocol";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import type { ImageAttachmentEntry } from ".";
import { normalizeLocalScheme } from "./path-utils";
import { ToolError } from "./tool-errors";

/** Regex to find skill:// tokens in command text. */
const SKILL_URL_PATTERN = /'skill:\/\/[^'\s")`\\]+'|"skill:\/\/[^"\s')`\\]+"|skill:\/\/[^\s'")`\\;&|<>($]+/g;

// Unquoted URLs stop before shell syntax so expansion cannot quote an adjacent
// operator or substitution into the resolved path.
const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:skill|agent|artifact|plan|memory|rule|local|attachment):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|plan|memory|rule|local|attachment):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|plan|memory|rule|local|attachment):\/\/[^\s'")`\\;&|<>($]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\;&|<>($]+/g;

const SUPPORTED_INTERNAL_SCHEMES = [
	"skill",
	"agent",
	"artifact",
	"plan",
	"memory",
	"rule",
	"local",
	"attachment",
] as const;

type SupportedInternalScheme = (typeof SUPPORTED_INTERNAL_SCHEMES)[number];

interface InternalUrlResolver {
	canHandle(input: string): boolean;
	resolve(input: string, context?: ResolveContext): Promise<InternalResource>;
}

export interface InternalUrlExpansionOptions {
	skills: readonly Skill[];
	attachments?: readonly ImageAttachmentEntry[];
	noEscape?: boolean;
	internalRouter?: InternalUrlResolver;
	localOptions?: LocalProtocolOptions;
	cwd?: string;
	sessionFile?: string;
	ensureLocalParentDirs?: boolean;
	/** Calling session's agent-scoped applicable rules — lets rule:// resolve without process-global state. */
	rules?: readonly Rule[];
}

/**
 * Resolve a single skill:// URL to its absolute filesystem path.
 * Does NOT read file content or verify existence.
 */
export function resolveSkillUrlToPath(url: string, skills: readonly Skill[]): string {
	const parsed = /^skill:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
	if (!parsed) {
		throw new ToolError(`Invalid skill:// URL: ${url}`);
	}

	let rawSkillSegment = parsed[1];
	if (!rawSkillSegment) {
		throw new ToolError(`skill:// URL requires a skill name: ${url}`);
	}
	// Decode percent-encoded colons (%3A) used for namespaced skill names
	try {
		rawSkillSegment = decodeURIComponent(rawSkillSegment);
	} catch {
		// Leave as-is if decoding fails
	}

	// Resolve skill name by longest-prefix match against registered skills.
	// This handles namespaced skills ("plugin:skill") where the URI may also
	// carry a colon-delimited suffix (e.g., ":1-5" line range).
	const { skill, suffix } = matchSkillName(rawSkillSegment, skills);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new ToolError(`Unknown skill: ${rawSkillSegment}. Available: ${availableStr}`);
	}

	// Combine any colon suffix (line range like ":1-5") with the path segment
	const rawPath = (parsed[2] ?? "") + (suffix ? `/${suffix}` : "");
	const hasRelativePath = rawPath !== "" && rawPath !== "/";

	if (!hasRelativePath) {
		return path.resolve(skill.baseDir);
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPath.slice(1));
	} catch {
		throw new ToolError(`Invalid skill:// URL path encoding: ${url}`);
	}
	try {
		validateRelativePath(relativePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(message);
	}

	const targetPath = path.join(skill.baseDir, relativePath);
	const resolvedPath = path.resolve(targetPath);
	const resolvedBaseDir = path.resolve(skill.baseDir);
	if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
		throw new ToolError("Path traversal is not allowed in skill:// URLs");
	}
	// Agent Plugin skills (§4.1): the resource must canonically resolve within
	// the plugin root. Fail closed: a dangling or unresolvable path is rejected
	// rather than handed to bash, where writing through it could create the
	// outside target. Symlinks may target other files inside the same package.
	if (skill.containRoot) {
		const contained = resolveContainedPathSync(skill.containRoot, resolvedPath);
		if (contained.status === "outside") {
			throw new ToolError(`skill:// path resolves outside the plugin root: ${url}`);
		}
		if (contained.status === "missing") {
			throw new ToolError(`skill:// path does not exist: ${url}`);
		}
		return contained.realPath;
	}

	return resolvedPath;
}

/**
 * Match a raw skill segment against registered skills using longest-prefix match.
 * Handles colons in both skill names (namespacing) and suffixes (line ranges).
 *
 * For "superpowers:brainstorming:1-5" with skill "superpowers:brainstorming":
 *   -> skill = superpowers:brainstorming, suffix = "1-5"
 * For "brainstorming" with skill "brainstorming":
 *   -> skill = brainstorming, suffix = undefined
 */
function matchSkillName(
	rawSegment: string,
	skills: readonly Skill[],
): { skill: Skill | undefined; suffix: string | undefined } {
	// Exact match first (most common case)
	const exact = skills.find(s => s.name === rawSegment);
	if (exact) return { skill: exact, suffix: undefined };

	// Try stripping colon-delimited suffixes from the right
	let candidate = rawSegment;
	while (true) {
		const lastColon = candidate.lastIndexOf(":");
		if (lastColon <= 0) break;
		candidate = candidate.slice(0, lastColon);
		const match = skills.find(s => s.name === candidate);
		if (match) {
			const suffix = rawSegment.slice(lastColon + 1);
			return { skill: match, suffix };
		}
	}

	return { skill: undefined, suffix: undefined };
}

function extractScheme(url: string): SupportedInternalScheme | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (!match) return undefined;
	const scheme = match[1].toLowerCase();
	if (!SUPPORTED_INTERNAL_SCHEMES.includes(scheme as SupportedInternalScheme)) return undefined;
	return scheme as SupportedInternalScheme;
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

function isInsideShellQuote(command: string, index: number): boolean {
	type ShellQuote = "'" | '"' | undefined;
	interface CommandSubstitution {
		/** `$(` … `)` tracks paren depth; `` ` `` … `` ` `` is a plain toggle. */
		kind: "dollar" | "backtick";
		outerQuote: ShellQuote;
		depth: number;
	}

	let quote: ShellQuote;
	const substitutions: CommandSubstitution[] = [];
	for (let i = 0; i < index; i++) {
		const char = command[i];
		// Inside a backtick substitution nested in double quotes, bash treats `\"`
		// as a quote delimiter for the inner command, not as an escaped literal.
		if (
			char === "\\" &&
			command[i + 1] === '"' &&
			quote !== "'" &&
			substitutions.at(-1)?.kind === "backtick" &&
			substitutions.at(-1)?.outerQuote === '"'
		) {
			quote = quote === '"' ? undefined : '"';
			i++;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (char === "'" && quote !== '"') {
			quote = quote === "'" ? undefined : "'";
			continue;
		}
		if (char === '"' && quote !== "'") {
			quote = quote === '"' ? undefined : '"';
			continue;
		}
		if (char === "$" && command[i + 1] === "(" && quote !== "'") {
			substitutions.push({ kind: "dollar", outerQuote: quote, depth: 1 });
			quote = undefined;
			i++;
			continue;
		}
		if (char === "`" && quote !== "'") {
			const top = substitutions.at(-1);
			if (top?.kind === "backtick") {
				substitutions.pop();
				quote = top.outerQuote;
			} else {
				substitutions.push({ kind: "backtick", outerQuote: quote, depth: 0 });
				quote = undefined;
			}
			continue;
		}
		if (quote !== undefined) continue;

		const substitution = substitutions.at(-1);
		if (substitution?.kind !== "dollar") continue;
		if (char === "(") {
			substitution.depth++;
		} else if (char === ")") {
			substitution.depth--;
			if (substitution.depth === 0) {
				quote = substitutions.pop()?.outerQuote;
			}
		}
	}
	return quote !== undefined;
}

function isEmbeddedInQuotedText(command: string, token: string, index: number): boolean {
	if (token.startsWith("'") || token.startsWith('"')) return false;
	return isInsideShellQuote(command, index);
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[],
	attachments: readonly ImageAttachmentEntry[],
	internalRouter?: InternalUrlResolver,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
	cwd?: string,
	sessionFile?: string,
	rules?: readonly Rule[],
): Promise<string> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = extractScheme(url);
	if (!scheme) {
		throw new ToolError(`Unsupported internal URL in bash command: ${url}`);
	}

	if (scheme === "skill") {
		return resolveSkillUrlToPath(url, skills);
	}

	if (scheme === "attachment") {
		const attachment = attachments.find(entry => entry.uri === url);
		if (!attachment) {
			throw new ToolError(`Unknown attachment URL in bash command: ${url}`);
		}
		return path.resolve(attachment.sourcePath);
	}

	if (scheme === "local") {
		if (!localOptions) {
			throw new ToolError(
				"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
			);
		}
		const resolvedLocalPath = resolveLocalUrlToPath(url, localOptions);
		if (ensureLocalParentDirs) {
			await fs.mkdir(path.dirname(resolvedLocalPath), { recursive: true });
		}
		return resolvedLocalPath;
	}

	if (!internalRouter?.canHandle(url)) {
		throw new ToolError(
			`Cannot resolve ${scheme}:// URL in bash command: ${url}\n` +
				"Internal URL router is unavailable for this protocol in the current session.",
		);
	}

	let resource: InternalResource;
	try {
		resource = await internalRouter.resolve(url, { cwd, pathOnly: true, sessionFile, rules });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Failed to resolve ${scheme}:// URL in bash command: ${url}\n${message}`);
	}

	if (!resource.sourcePath) {
		throw new ToolError(`${scheme}:// URL resolved without a filesystem path and cannot be used in bash: ${url}`);
	}

	return path.resolve(resource.sourcePath);
}

/**
 * Expand all skill:// URIs in a bash command string.
 * Returns the command with URIs replaced by shell-escaped absolute paths.
 * Throws ToolError if any URI cannot be resolved.
 */
export function expandSkillUrls(command: string, skills: readonly Skill[]): string {
	if (skills.length === 0 || !command.includes("skill://")) {
		return command;
	}

	return command.replace(SKILL_URL_PATTERN, token => {
		const url = unquoteToken(token);
		const resolvedPath = resolveSkillUrlToPath(url, skills);
		return shellEscape(resolvedPath);
	});
}

/**
 * Expand supported internal URLs in a bash command string to shell-escaped absolute paths.
 * Unresolvable URLs and literal mentions inside larger quoted text are left unchanged.
 * Supported schemes: skill://, agent://, artifact://, memory://, rule://, local://, attachment://
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes("://") && !command.includes("local:/")) return command;

	const matches = Array.from(command.matchAll(INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL));
	if (matches.length === 0) return command;

	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		if (isEmbeddedInQuotedText(command, token, index)) continue;

		const rawUrl = unquoteToken(token);
		const url = normalizeLocalScheme(rawUrl);
		let resolvedPath: string;
		try {
			resolvedPath = await resolveInternalUrlToPath(
				url,
				options.skills,
				options.attachments ?? [],
				options.internalRouter,
				options.localOptions,
				options.ensureLocalParentDirs,
				options.cwd,
				options.sessionFile,
				options.rules,
			);
		} catch {
			continue;
		}
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
