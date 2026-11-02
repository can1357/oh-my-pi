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
import { isEnoent, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import {
	findStaleSkillStandIn,
	getActiveSkills,
	isSkillSuperseded,
	rediscoverSkills,
	type Skill,
	type SkillRediscoveryHost,
} from "../extensibility/skills";
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
 * Most an unknown `skill://` name waits for MCP (deferred startup included) to advertise it: long
 * enough for a healthy handshake, short enough that a hung server or its reconnect ladder cannot
 * hold a read of a typo'd or disabled skill name for the rest of the turn.
 */
const UNKNOWN_SKILL_MCP_WAIT_MS = 5_000;

/** A skill:// URL's target path and the loaded skill that owns it. */
interface SkillTarget {
	skill: Skill;
	path: string;
}

/** The loaded skill a skill:// URL names, and the URL path inside that skill. */
interface UrlSkill {
	skill: Skill;
	urlPath: string;
}

/** The loaded skill in `skills` that a skill:// URL names. */
function findUrlSkill(url: InternalUrl, skills: readonly Skill[]): UrlSkill {
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
	return { skill, urlPath };
}

/**
 * Path `urlPath` addresses inside `skill`, after traversal and plugin-root containment
 * checks. An empty path addresses the skill's instruction file, or its base
 * directory when `directory` is set. The path may not exist; with `create`, a
 * missing plugin-skill target is only returned when writing it stays in the plugin root.
 */
async function skillTargetPath(
	url: InternalUrl,
	{ skill, urlPath }: UrlSkill,
	directory: boolean,
	create = false,
	contain = false,
): Promise<SkillTarget> {
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
	if (!skill.containRoot && !contain) return { skill, path: resolvedPath };
	const containRoot = skill.containRoot ?? (await fs.realpath(skill.baseDir));
	// Local skill roots may themselves be links. Rebase their lexical children
	// onto the real root before the shared helper checks descendant links.
	const containmentPath = skill.containRoot
		? resolvedPath
		: path.resolve(containRoot, path.relative(path.resolve(skill.baseDir), resolvedPath));
	const escape = `skill:// path resolves outside the ${skill.containRoot ? "plugin" : "skill"} root: ${url.href}`;
	const contained = await resolveContainedPath(containRoot, containmentPath);
	if (contained.status === "outside") throw new UrlContainmentError(escape);
	if (contained.status === "ok") return { skill, path: contained.realPath };
	if (create) {
		try {
			await ensureCreatableWithinRoot(containmentPath, containRoot, "skill", url.href);
		} catch (error) {
			// Same wording as the read path: the plugin root, not a per-skill root, bounds the package.
			throw error instanceof UrlContainmentError ? new UrlContainmentError(escape) : error;
		}
	}
	return { skill, path: resolvedPath };
}

async function statIfExists(filePath: string): Promise<fsTypes.Stats | null> {
	try {
		return await fs.stat(filePath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/**
 * The calling tool session's own {@link SkillRediscoveryHost} (which stores what it rediscovers and
 * shares one pass among concurrent misses), or one built from the context when the session offers
 * none; without a session, the process snapshot.
 */
function contextRediscoveryHost(skills: readonly Skill[], context: ResolveContext | undefined): SkillRediscoveryHost {
	const session = context?.session;
	const sessionHost = session?.skillRediscoveryHost?.();
	if (sessionHost) return sessionHost;
	const refresh = session?.refreshSkills;
	return {
		skills,
		refreshSkills:
			session && refresh
				? async () => {
						await refresh();
						return session.skills ?? [];
					}
				: undefined,
		settings: context?.settings ?? session?.settings,
		cwd: session?.cwd ?? context?.cwd,
		extensionRoots: session?.effectiveExtensionRoots?.(),
	};
}

/** A located skill:// target; `stats` is null when it does not exist. */
interface LocatedSkillTarget {
	path: string;
	stats: fsTypes.Stats | null;
}

/**
 * Whether `target` must be resolved again: it is missing and so is its skill's own file, or the
 * holder follows the plugin registries and they now install the skill's plugin elsewhere.
 */
async function isStaleTarget(
	target: SkillTarget,
	stats: fsTypes.Stats | null,
	host: SkillRediscoveryHost,
): Promise<boolean> {
	if (!stats && !(await statIfExists(target.skill.filePath))) return true;
	return isSkillSuperseded(target.skill, host);
}

/**
 * {@link skillTargetPath}, resolved once more when the skill that owns the target is stale. Its
 * stand-in is the same skill of the same plugin ({@link findStaleSkillStandIn}), which a collision
 * can list under another name, at the same path inside it: first from the holder's current list,
 * when it moved on since `context.skills` was taken (a copied tool session, a read that began
 * before a rediscovery), and only if that is stale too from rediscovered skills
 * ({@link rediscoverSkills}).
 */
async function locateSkillTarget(
	url: InternalUrl,
	context: ResolveContext | undefined,
	directory: boolean,
	create = false,
	contain = false,
): Promise<LocatedSkillTarget> {
	const skills = context?.skills ?? getActiveSkills();
	const named = findUrlSkill(url, skills);
	let target = await skillTargetPath(url, named, directory, create, contain);
	let stats = await statIfExists(target.path);
	const host = contextRediscoveryHost(skills, context);
	if (await isStaleTarget(target, stats, host)) {
		const held = host.skills !== skills ? findStaleSkillStandIn(named.skill, host.skills) : undefined;
		if (held) {
			const heldTarget = await skillTargetPath(
				url,
				{ skill: held, urlPath: named.urlPath },
				directory,
				create,
				contain,
			);
			const heldStats = await statIfExists(heldTarget.path);
			if (!(await isStaleTarget(heldTarget, heldStats, host))) return { path: heldTarget.path, stats: heldStats };
		}
		const rediscovered = findStaleSkillStandIn(named.skill, await rediscoverSkills(host));
		// Not an UnknownSkillError: when an upgrade dropped the skill, another plugin's colliding skill
		// can own its name now, and neither an MCP server nor a second lookup (`resolve` after `locate`
		// defers) may answer for the dropped one with it.
		if (!rediscovered) throw new Error(`Unknown skill: ${named.skill.name}`);
		target = await skillTargetPath(url, { skill: rediscovered, urlPath: named.urlPath }, directory, create, contain);
		stats = await statIfExists(target.path);
	}
	return { path: target.path, stats };
}

/** The file or directory resource at a located target; a target removed since it was located rejects with ENOENT. */
async function readSkillTarget(url: InternalUrl, target: LocatedSkillTarget): Promise<InternalResource> {
	const { path: targetPath, stats } = target;
	if (!stats) throw new Error(`File not found: ${targetPath}`);

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
		let target: LocatedSkillTarget;
		try {
			target = await locateSkillTarget(url, context, false);
		} catch (error) {
			if (!(error instanceof UnknownSkillError)) throw error;
			// Loaded skills always win; otherwise serve the resource an MCP server advertises under
			// exactly this URI (Figma's `skill://figma/figma-use/SKILL.md`). Templates stay behind `mcp://`.
			// A deferred MCP startup that fails cannot change the diagnosis: the skill is still unknown.
			// Most such names are not MCP resources at all, so one budget caps deferred startup (which
			// never returns while a handshake hangs and the startup window is 0) plus the catalog wait.
			const deadline = Date.now() + UNKNOWN_SKILL_MCP_WAIT_MS;
			let mcpManager: MCPManager | undefined;
			try {
				mcpManager = await withTimeout(
					MCPManager.load(),
					UNKNOWN_SKILL_MCP_WAIT_MS,
					"MCP startup outlasted the unknown-skill wait",
					context?.signal,
				);
			} catch (loadError) {
				if (context?.signal?.aborted) throw loadError;
				logger.debug("MCP startup failed while resolving an unknown skill", { url: url.href, error: loadError });
				throw error;
			}
			const resource =
				mcpManager &&
				(await readMcpResource(mcpManager, url, {
					exact: true,
					waitMs: Math.max(0, deadline - Date.now()),
					signal: context?.signal,
				}));
			if (!resource) throw error;
			// The server, not a loaded skill, sizes this text: keep `read`'s normal result limits.
			return { ...resource, unbounded: false };
		}

		try {
			return await readSkillTarget(url, target);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			// The target was removed after it was located: an upgrade published the plugin's new
			// version and deleted the old directory between the check and the read. Locate it again,
			// which now finds the old skill gone and rediscovers it.
			return readSkillTarget(url, await locateSkillTarget(url, context, false));
		}
	}

	/**
	 * Skill file or directory; `options.directory` maps a bare `skill://<name>` to the skill base dir.
	 * Null for a missing entry (or dangling symlink) without `create`, plugin skill or not, and for a
	 * name no loaded skill owns while MCP is available unless `options.localOnly`: an MCP server may
	 * advertise the URL, which {@link resolve} settles (its servers may still be connecting).
	 */
	async locate(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		let target: LocatedSkillTarget;
		try {
			target = await locateSkillTarget(
				url,
				context,
				options?.directory === true,
				options?.create === true,
				context?.containSkillPaths === true,
			);
		} catch (error) {
			if (error instanceof UnknownSkillError && !options?.localOnly && MCPManager.available()) return null;
			throw error;
		}
		return options?.create || target.stats ? target.path : null;
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveSkills().map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
