import * as fs from "node:fs/promises";
import * as os from "node:os";
import { getProjectDir, parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import {
	isValidManagedSkillName,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeManagedDescription,
} from "../autolearn/managed-skills";
import { skillCapability } from "../capability/skill";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import type { SkillsSettings } from "./settings";
import {
	type Skill as CapabilitySkill,
	isUserSourceEnabled,
	loadCapability,
	type SkillFrontmatter,
} from "../discovery";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import { allowsSkillTokens, SKILL_TOKEN_RE } from "@oh-my-pi/pi-tui/prompt/skill-tokens";
import autoloadTemplate from "../prompts/skills/autoload.md" with { type: "text" };
import userInvocationTemplate from "../prompts/skills/user-invocation.md" with { type: "text" };
import { SKILLSHARE_PROVIDER_ID } from "../discovery/skillshare";
import type { SkillPromptDetails } from "../session/messages";
import { expandTilde } from "../tools/path-utils";

export { allowsSkillTokens, SKILL_TOKEN_RE };

/** Provider id for skills loaded from `skills.customDirectories` (see `loadSkills`). */
const CUSTOM_DIR_PROVIDER_ID = "custom";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	/**
	 * When `true`, the skill is loaded and reachable via `skill://<name>` and
	 * (when enabled) `/skill:<name>`, but is excluded from the rendered system
	 * prompt's `<skills>` listing.
	 */
	hide?: boolean;
	/**
	 * Filesystem-resolved plugin root for Agent Plugin skills (spec §4.1):
	 * every `skill://` resource access must realpath-resolve within it.
	 */
	containRoot?: string;
	/** Source metadata for display */
	_source?: SourceMeta;
}

export interface SkillWarning {
	skillPath: string;
	message: string;
}

/**
 * Which rule awarded the bare name of a diagnosed skill (`resolveCollision`
 * precedence): an authored skill over a registry-installed one, a
 * custom-directory skill over a provider skill, otherwise admission order
 * (provider priority, then provider/custom-directory order).
 */
export type SkillSelectionReason = "source-order" | "custom-directory" | "authored-over-installed";

/**
 * A raw skill name that resolved into several active variants and/or left
 * redundant copies behind. Built from the final result: filtered-out skills
 * (disabled, ignored, not included) never appear. Differing variants decide
 * `reason`; redundant copies are considered only for duplicate-only groups.
 */
export interface SkillDiagnostic {
	/** Raw (pre-collision) skill name. */
	name: string;
	reason: SkillSelectionReason;
	/** Active variants of `name`: the loaded skill objects; the bare one, if included, is named `name`. */
	skills: Skill[];
	/**
	 * Distinct files not loaded because a kept skill stands for them, each with that skill:
	 * `content` when SKILL.md body and frontmatter are identical, `origin` when it is a
	 * same-origin variant hidden by `skills.dedupeSameOrigin`.
	 */
	duplicates: { skill: Skill; retained: Skill; match: SkillDuplicateMatch }[];
}

/** Why a duplicate is not loaded; see {@link SkillDiagnostic.duplicates}. */
export type SkillDuplicateMatch = "content" | "origin";

export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
	diagnostics: SkillDiagnostic[];
}

/**
 * Namespace a skill takes when its bare name is already claimed by a different
 * skill. Prefers the provider-supplied plugin identity (`_source.pluginName`,
 * set by every registry-backed provider) when present, since installed plugin
 * caches (`<marketplace>/<plugin>/<version>/skills/...`) put a version string,
 * not the plugin name, in the path segment owning `skills/` — path parsing
 * alone would namespace by version and change on every plugin update.
 * Otherwise derived from the path so every other provider gets one without
 * plumbing: the directory owning `skills/` (a plugin or package root), else
 * the directory holding the skill (a custom skills root), else the provider.
 * Dotted homes (`~/.claude/skills`) are not meaningful names.
 */
function skillNamespace(skill: Pick<CapabilitySkill, "path" | "_source">): string {
	let root = skill._source.pluginName;
	if (root === undefined) {
		const segments = skill.path.split(/[\\/]/);
		const skillsIndex = segments.lastIndexOf("skills");
		// `<root>/skills/**/SKILL.md` → root; marketplace caches name the root
		// `<marketplace>___<plugin>___<version>` → plugin.
		// `<root>/<skill>/SKILL.md` (no `skills/` segment) → root.
		const pathRoot = skillsIndex > 0 ? segments[skillsIndex - 1] : segments[segments.length - 3];
		const cached = pathRoot?.split("___");
		root = cached?.length === 3 ? cached[1] : pathRoot;
	}
	if (!root || root.startsWith(".")) return skill._source.provider;
	// Namespaces are addressed through `/skill:<ns>/<name>` and `skill://<ns>/<name>`,
	// so they must be a single token: collapse runs of whitespace and other
	// non-name characters to `-` (a distinct root whose sanitized namespace
	// collides just resolves through the normal `~N` suffix path).
	const safe = root.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
	return safe || skill._source.provider;
}

interface AdmittedBody {
	/** Pre-collision frontmatter name. Kept explicitly because a legal raw
	 * name may itself end in `~N`, making a registered alias like
	 * `<ns>/foo~2` indistinguishable from a generated collision suffix. */
	rawName: string;
	body: string;
	/** Parsed frontmatter, compared alongside `body` for the identical-content
	 * collapse: two skills can share a body but differ in `description`,
	 * `allowed-tools`, or another field, and must not be silently merged. */
	frontmatter: SkillFrontmatter | undefined;
	namespace: string;
	/** Declared source repository (`SourceMeta.provenance`), for same-origin resolution. */
	repository: string | undefined;
	filePath: string;
	/** Canonical file location, to tell a distinct copy from a symlink to this file. */
	realPath: string;
}

interface CollisionResolution {
	name: string;
	warning?: string;
	/** Registered names the candidate makes redundant: byte-identical content it
	 * now covers under the bare name. Removed without an alias or a warning. */
	dropped: string[];
	/** The current bare holder, moved to `newName` to make room for an outranking candidate. */
	displaced?: { newName: string; warning: string };
}

/** The candidate repeats an already registered skill and is not admitted. */
interface RedundantCopy {
	/** Registered name of the identical copy or same-origin variant that stands for the candidate. */
	duplicateOf: string;
	/** Alias the candidate would receive if it were kept, used for exclusion rules. */
	name: string;
}

/** A distinct file left unloaded because `retained` stands for it. */
interface RedundantSkill {
	skill: Skill;
	retained: Skill;
	match: SkillDuplicateMatch;
}

const hasSameContent = (
	entry: Pick<AdmittedBody, "body" | "frontmatter">,
	body: string,
	frontmatter: SkillFrontmatter | undefined,
): boolean => entry.body === body && Bun.deepEquals(entry.frontmatter, frontmatter);

const isInstalledSkill = (skill: Pick<Skill, "_source"> | undefined): boolean =>
	skill?._source?.provider === SKILLSHARE_PROVIDER_ID;
const isCustomSkill = (skill: Pick<Skill, "_source"> | undefined): boolean =>
	skill?._source?.provider === CUSTOM_DIR_PROVIDER_ID;

function availableSkillAlias(
	skills: ReadonlyMap<string, Skill>,
	namespace: string,
	rawName: string,
	replacedNames?: readonly string[],
): string {
	let alias = `${namespace}/${rawName}`;
	for (let n = 2; skills.has(alias) && !replacedNames?.includes(alias); n++) {
		alias = `${namespace}/${rawName}~${n}`;
	}
	return alias;
}
/**
 * Resolve a same-name skill against what is already loaded.
 * - Precedence, when raw names collide:
 *   1. An authored skill always outranks a registry-installed package
 *      (`omp skill install`, the `skillshare` provider) — installed steps
 *      aside regardless of admission order.
 *   2. A custom-directory skill always outranks a provider skill (#7190's
 *      override contract) — the provider skill steps aside even though it
 *      was admitted first (custom directories are merged after providers).
 *   3. Otherwise, whichever was admitted first — provider-priority order for
 *      providers, array order within `skills.customDirectories` for custom
 *      directories — keeps the bare name.
 * - Registered copies equivalent to the candidate are collapsed instead of
 *   kept as aliases: identical body AND frontmatter always, and, with
 *   `sameOrigin`, any copy declaring the candidate's source repository.
 * - A candidate that outranks the bare holder always takes the bare name (the
 *   override contract is about which FILE is authoritative, not which text
 *   renders the same). Equivalent registered copies are dropped; if the bare
 *   holder itself is equivalent it is dropped too, otherwise it is namespaced
 *   as `<namespace>/<name>` (a taken slot gets a numeric `~N` suffix).
 * - Any other candidate equivalent to a registered copy → not admitted
 *   (`RedundantCopy`); a differing one is namespaced.
 */
function resolveCollision(
	skillMap: Map<string, Skill>,
	admitted: Map<string, AdmittedBody>,
	candidate: Skill,
	candidateBody: string,
	candidateFrontmatter: SkillFrontmatter | undefined,
	namespace: string,
	sameOrigin: boolean,
): CollisionResolution | RedundantCopy {
	const existingEntries = [...admitted.entries()].filter(([_, e]) => e.rawName === candidate.name);
	if (existingEntries.length === 0) {
		return { name: candidate.name, dropped: [] };
	}

	const bareSkill = skillMap.get(candidate.name);
	const candidateInstalled = isInstalledSkill(candidate);
	const bareInstalled = isInstalledSkill(bareSkill);
	const candidateCustom = isCustomSkill(candidate);
	const bareCustom = isCustomSkill(bareSkill);
	const candidateRepository = sameOrigin ? candidate._source?.provenance?.repository : undefined;
	const identical = existingEntries
		.filter(
			([_, e]) =>
				hasSameContent(e, candidateBody, candidateFrontmatter) ||
				(candidateRepository !== undefined && e.repository === candidateRepository),
		)
		.map(([name]) => name);

	if (bareSkill && ((bareInstalled && !candidateInstalled) || (candidateCustom && !bareCustom))) {
		if (identical.includes(candidate.name)) return { name: candidate.name, dropped: identical };
		const bareEntry = admitted.get(candidate.name)!;
		const namespacedBare = availableSkillAlias(skillMap, bareEntry.namespace, bareEntry.rawName, identical);
		return {
			name: candidate.name,
			dropped: identical,
			displaced: {
				newName: namespacedBare,
				warning: `name collision: ${bareInstalled ? "installed " : ""}"${bareEntry.rawName}" from ${bareSkill.filePath} is overridden by ${candidate.filePath}; available as "${namespacedBare}"`,
			},
		};
	}

	// Otherwise the already-admitted skill keeps the bare name (first-admitted
	// wins, or the authored skill over an installed package); only the new
	// candidate is namespaced.
	const namespaced = availableSkillAlias(skillMap, namespace, candidate.name);
	if (identical.length > 0) return { duplicateOf: identical[0], name: namespaced };
	if (bareSkill && !bareInstalled && candidateInstalled) {
		return {
			name: namespaced,
			dropped: [],
			warning: `name collision: installed "${candidate.name}" from ${candidate.filePath} is overridden by ${bareSkill.filePath}; available as "${namespaced}"`,
		};
	}
	const referencePath = existingEntries[0][1].filePath;
	return {
		name: namespaced,
		dropped: [],
		warning: `name collision: "${candidate.name}" from ${candidate.filePath} differs from ${referencePath}; available as "${namespaced}"`,
	};
}

/**
 * Highest-precedence `resolveCollision` rule separating the final variants.
 * Redundant copies only contribute when there is no differing variant.
 * Filtered-out variants cannot credit a rule.
 * ponytail: one reason per name; use per-variant reasons if needed.
 */
function selectionReason(members: readonly Skill[]): SkillSelectionReason {
	const splits = (matches: (skill: Skill) => boolean) => members.some(matches) && !members.every(matches);
	if (splits(isInstalledSkill)) return "authored-over-installed";
	if (splits(isCustomSkill)) return "custom-directory";
	return "source-order";
}

/**
 * Group the final skills by raw name. A name is reported when it kept several
 * active variants or has a redundant copy whose retained skill is active; a
 * redundancy whose retained skill was filtered out is not (nothing it could
 * be redundant with is loaded).
 */
function buildSkillDiagnostics(
	skills: readonly Skill[],
	admitted: ReadonlyMap<string, AdmittedBody>,
	redundant: Iterable<RedundantSkill>,
): SkillDiagnostic[] {
	const groups = new Map<string, Pick<SkillDiagnostic, "skills" | "duplicates">>();
	for (const skill of skills) {
		// Managed (auto-learn) skills never pass through `admit`, so never collide.
		const rawName = admitted.get(skill.name)?.rawName;
		if (rawName === undefined) continue;
		const group = groups.get(rawName);
		if (group) group.skills.push(skill);
		else groups.set(rawName, { skills: [skill], duplicates: [] });
	}
	const active = new Set(skills);
	for (const { skill, retained, match } of redundant) {
		if (!active.has(retained)) continue;
		const rawName = admitted.get(retained.name)!.rawName;
		groups.get(rawName)?.duplicates.push({ skill, retained, match });
	}
	return [...groups]
		.filter(([, group]) => group.skills.length > 1 || group.duplicates.length > 0)
		.map(([name, group]) => ({
			name,
			reason: selectionReason(
				group.skills.length > 1
					? group.skills
					: [...group.skills, ...group.duplicates.map(duplicate => duplicate.skill)],
			),
			...group,
		}))
		.sort((a, b) => compareSkillOrder(a.name, "", b.name, ""));
}

let activeSkills: readonly Skill[] = [];

/**
 * Process-global snapshot of skills the active session loaded.
 * Read by internal URL protocol handlers (skill://).
 */
export function getActiveSkills(): readonly Skill[] {
	return activeSkills;
}

/** Replace the active skill snapshot. Called once per top-level session. */
export function setActiveSkills(value: readonly Skill[]): void {
	activeSkills = value;
}

/** Reset the active skill snapshot. Test-only. */
export function resetActiveSkillsForTests(): void {
	activeSkills = [];
}

/**
 * Whether `name` is already claimed by an active authored (non-managed) skill.
 *
 * Managed (auto-learn) skills resolve dead-last in discovery, so an authored
 * skill of the same name always wins (see `loadSkills`) and a managed skill
 * written under an authored name is silently dropped — it never surfaces.
 * `manage_skill` create consults this to refuse the write up front instead of
 * reporting a false "Created" for a skill that can never appear.
 */
export function isNameClaimedByAuthoredSkill(name: string): boolean {
	return getActiveSkills().some(
		skill => skill.name === name && skill._source?.provider !== MANAGED_SKILLS_PROVIDER_ID,
	);
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	const [rawProviderId, rawLevel] = options.source.split(":", 2);
	const providerId = rawProviderId || CUSTOM_DIR_PROVIDER_ID;
	const level: "user" | "project" = rawLevel === "project" ? "project" : "user";
	const result = await scanSkillsFromDir(
		{ cwd: getProjectDir(), home: os.homedir(), repoRoot: null },
		{
			dir: options.dir,
			providerId,
			level,
			requireDescription: true,
		},
	);

	return {
		skills: result.items.map(capSkill => ({
			name: capSkill.name,
			description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: options.source,
			...(capSkill.containRoot !== undefined && { containRoot: capSkill.containRoot }),
			hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
			_source: capSkill._source,
		})),
		warnings: (result.warnings ?? []).map(message => ({ skillPath: options.dir, message })),
		diagnostics: [],
	};
}

export interface LoadSkillsOptions extends SkillsSettings {
	/** Working directory for project-local skills. Default: getProjectDir() */
	cwd?: string;
	/** Disabled extension ids (`disabledExtensions`); `skill:<name>` entries hide those skills. */
	disabledExtensions?: string[];
	/**
	 * Session-local extension roots. Post-startup reloads pass their live
	 * session value so explicit roots, discovery mode, and configured
	 * extensions all survive outside the construction-time invocation scope.
	 */
	extensionRoots?: EffectiveExtensionRoots;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		enabled = true,
		enableCodexUser = false,
		enableClaudeUser = false,
		enableClaudeProject = true,
		enablePiUser = true,
		enablePiProject = true,
		enableAgentsUser = true,
		enableAgentsProject = true,
		customDirectories = [],
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
		extensionRoots,
		dedupeSameOrigin = false,
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [], diagnostics: [] };
	}
	function isSourceEnabled(source: SourceMeta): boolean {
		const { provider, level } = source;
		// Managed skills (auto-learn) are OMP-native and discovered unconditionally
		// — third-party CLI toggles must never silently hide them (cf. #2401). The
		// master `enabled` flag above still gates them.
		if (provider === MANAGED_SKILLS_PROVIDER_ID) return true;
		if (provider === "codex" && level === "user") return enableCodexUser || isUserSourceEnabled("codex");
		if (provider === "claude" && level === "user") return enableClaudeUser || isUserSourceEnabled("claude");
		if (provider === "claude" && level === "project") return enableClaudeProject;
		if (provider === "native" && level === "user") return enablePiUser;
		if (provider === "native" && level === "project") return enablePiProject;
		if (provider === "agents" && level === "user") return enableAgentsUser;
		if (provider === "agents" && level === "project") return enableAgentsProject;
		// User-scope claude-plugins skills carry the root's origin (#10743). omp's
		// own installs (`omp` registry, `--plugin-dir`) are not the foreign
		// ~/.claude/plugins tree, so the foreign opt-in gate applies only to
		// claude-origin roots — parity with allowedRoots() in
		// discovery/claude-plugins.ts. Without this, #10666's root-level fix is
		// re-dropped here for every user-level claude-plugins skill.
		if (provider === "claude-plugins" && source.origin !== undefined && source.origin !== "claude") return true;
		if (level === "user") return isUserSourceEnabled(provider);
		return true;
	}

	// Use capability API to load all skills
	const result = await loadCapability<CapabilitySkill>(skillCapability.id, {
		cwd,
		disabledExtensions,
		extensionRoots,
	});

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	/** Admission per registered skill name; identical raw name + body collapses silently. */
	const admitted = new Map<string, AdmittedBody>();
	const collisionWarnings: SkillWarning[] = [];
	/** Distinct files left unloaded because identical content is kept, by realpath; see `buildSkillDiagnostics`. */
	const redundant = new Map<string, RedundantSkill>();

	// Check if skill name matches any of the include patterns
	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	// Check if skill name matches any of the ignore patterns
	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);
	// Select authored skills from the pre-dedup superset. `loadCapability`
	// dedupes before source toggles, so a disabled high-priority provider must
	// not hide an enabled lower-priority provider with the same skill name.
	// Same-name candidates survive here; `admit` below resolves them by content
	// (identical → dropped) or namespace (different → `<ns>/<name>`). Exclusions
	// apply to the raw name so a namespaced alias cannot bypass them; include
	// patterns are matched against the final name the user actually sees.
	const filteredSkills = result.all.filter(capSkill => {
		if (capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID) return false;
		if (disabledSkillNames.has(capSkill.name)) return false;
		if (!isSourceEnabled(capSkill._source)) return false;
		return !matchesIgnorePatterns(capSkill.name);
	});

	/**
	 * Resolve the skill's final name, apply the exclusion filters to it, and
	 * store it. Returns the stored name, or undefined when the skill was a
	 * duplicate, excluded, or rejected. Include patterns run once every name is
	 * final (see the end of this function): filtering here would drop the bare
	 * skill and leave a namespaced candidate with nothing to collide against.
	 *
	 * Every authored skill — any provider, any custom directory — is admitted
	 * here, which makes this the one place to reserve `/` and `\`: they belong
	 * to the `<namespace>/<name>` form and `skill://<name>/<path>` resolution,
	 * so a raw name (frontmatter is untrusted for registry installs) must never
	 * claim a namespaced address.
	 */
	function admit(
		skill: Skill,
		body: string,
		frontmatter: SkillFrontmatter | undefined,
		namespace: string,
		realPath: string,
	): string | undefined {
		if (/[\\/]/.test(skill.name)) {
			collisionWarnings.push({
				skillPath: skill.filePath,
				message: `Skill name "${skill.name}" contains a path separator, skipping: ${skill.filePath}`,
			});
			return undefined;
		}
		const rawName = skill.name;
		const repository = skill._source?.provenance?.repository;
		const resolved = resolveCollision(skillMap, admitted, skill, body, frontmatter, namespace, dedupeSameOrigin);
		if ("duplicateOf" in resolved) {
			if (disabledSkillNames.has(resolved.name) || matchesIgnorePatterns(resolved.name)) return undefined;
			// Keyed by realpath: a symlink to a redundant file is that file again, not another copy.
			if (!redundant.has(realPath)) {
				const match = hasSameContent(admitted.get(resolved.duplicateOf)!, body, frontmatter) ? "content" : "origin";
				redundant.set(realPath, { skill, retained: skillMap.get(resolved.duplicateOf)!, match });
			}
			return undefined;
		}
		const { name, warning, dropped, displaced } = resolved;
		if (disabledSkillNames.has(name) || matchesIgnorePatterns(name)) return undefined;

		for (const droppedName of dropped) {
			const droppedSkill = skillMap.get(droppedName)!;
			const droppedEntry = admitted.get(droppedName)!;
			const droppedPath = droppedEntry.realPath;
			const droppedMatch: SkillDuplicateMatch = hasSameContent(droppedEntry, body, frontmatter)
				? "content"
				: "origin";
			const excludedName =
				droppedName === rawName
					? availableSkillAlias(skillMap, droppedEntry.namespace, rawName, dropped)
					: droppedName;
			skillMap.delete(droppedName);
			admitted.delete(droppedName);
			// The candidate now stands for the dropped file, and for every copy it stood for;
			// a copy stays a content match only through an unbroken chain of identical content.
			for (const entry of redundant.values()) {
				if (entry.retained !== droppedSkill) continue;
				entry.retained = skill;
				if (droppedMatch === "origin") entry.match = "origin";
			}
			droppedSkill.name = rawName;
			if (!disabledSkillNames.has(excludedName) && !matchesIgnorePatterns(excludedName)) {
				redundant.set(droppedPath, { skill: droppedSkill, retained: skill, match: droppedMatch });
			}
			// The alias no longer exists: retract the warning that advertised it.
			const stale = collisionWarnings.findIndex(w => w.message.endsWith(`available as "${droppedName}"`));
			if (stale !== -1) collisionWarnings.splice(stale, 1);
		}
		if (displaced) {
			// The bare holder; `name` is overwritten by the candidate below.
			const displacedSkill = skillMap.get(name)!;
			const displacedEntry = admitted.get(name)!;
			displacedSkill.name = displaced.newName;
			if (!disabledSkillNames.has(displaced.newName) && !matchesIgnorePatterns(displaced.newName)) {
				skillMap.set(displaced.newName, displacedSkill);
				admitted.set(displaced.newName, displacedEntry);
			}
			collisionWarnings.push({ skillPath: displacedSkill.filePath, message: displaced.warning });
		}

		if (warning) collisionWarnings.push({ skillPath: skill.filePath, message: warning });
		skill.name = name;
		skillMap.set(name, skill);
		admitted.set(name, { rawName, body, frontmatter, namespace, repository, filePath: skill.filePath, realPath });
		// Loaded now, so no longer a redundant copy of anything (e.g. a custom directory reaching it by symlink).
		redundant.delete(realPath);
		return name;
	}

	// Batch resolve all real paths in parallel
	const realPaths = await Promise.all(
		filteredSkills.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	// Process skills with resolved paths
	for (let i = 0; i < filteredSkills.length; i++) {
		const capSkill = filteredSkills[i];
		const resolvedPath = realPaths[i];

		// Skip silently if we've already loaded this exact file (via symlink)
		if (realPathSet.has(resolvedPath)) {
			continue;
		}

		const skill: Skill = {
			name: capSkill.name,
			description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: `${capSkill._source.provider}:${capSkill.level}`,
			...(capSkill.containRoot !== undefined && { containRoot: capSkill.containRoot }),
			hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
			_source: capSkill._source,
		};
		if (admit(skill, capSkill.content, capSkill.frontmatter, skillNamespace(capSkill), resolvedPath) !== undefined)
			realPathSet.add(resolvedPath);
	}

	const customDirectoryResults = await Promise.all(
		customDirectories.map(async dir => {
			const expandedDir = expandTilde(dir);
			const scanResult = await scanSkillsFromDir(
				{ cwd, home: os.homedir(), repoRoot: null },
				{
					dir: expandedDir,
					providerId: CUSTOM_DIR_PROVIDER_ID,
					level: "user",
					requireDescription: true,
				},
			);
			return { expandedDir, scanResult };
		}),
	);

	const allCustomSkills: Array<{
		skill: Skill;
		path: string;
		body: string;
		frontmatter: SkillFrontmatter | undefined;
		namespace: string;
	}> = [];
	for (const { expandedDir, scanResult } of customDirectoryResults) {
		for (const capSkill of scanResult.items) {
			if (disabledSkillNames.has(capSkill.name)) continue;
			if (matchesIgnorePatterns(capSkill.name)) continue;
			allCustomSkills.push({
				skill: {
					name: capSkill.name,
					description:
						typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
					filePath: capSkill.path,
					baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
					source: "custom:user",
					...(capSkill.containRoot !== undefined && { containRoot: capSkill.containRoot }),
					hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
					_source: { ...capSkill._source, providerName: "Custom" },
				},
				path: capSkill.path,
				body: capSkill.content,
				frontmatter: capSkill.frontmatter,
				namespace: skillNamespace(capSkill),
			});
		}
		collisionWarnings.push(...(scanResult.warnings ?? []).map(message => ({ skillPath: expandedDir, message })));
	}

	const customRealPaths = await Promise.all(
		allCustomSkills.map(async ({ path }) => {
			try {
				return await fs.realpath(path);
			} catch {
				return path;
			}
		}),
	);

	for (let i = 0; i < allCustomSkills.length; i++) {
		const { skill, body, frontmatter, namespace } = allCustomSkills[i];
		const resolvedPath = customRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;
		if (admit(skill, body, frontmatter, namespace, resolvedPath) !== undefined) realPathSet.add(resolvedPath);
	}

	// Managed (auto-learn) skills resolve dead-last with first-wins. Source from
	// result.all (pre-dedup): capability-level dedup runs BEFORE isSourceEnabled,
	// so a managed skill can be shadowed by a higher-priority authored skill that
	// is itself disabled here — managed must stay visible regardless of toggles.
	// Validate the on-disk name (a hand-placed managed file could carry an unsafe
	// frontmatter name) and re-sanitize the description on read. Descriptions and
	// names both render unescaped into the system prompt.
	const managedCandidates = result.all.filter(
		capSkill =>
			capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID &&
			isValidManagedSkillName(capSkill.name) &&
			!disabledSkillNames.has(capSkill.name) &&
			!matchesIgnorePatterns(capSkill.name) &&
			matchesIncludePatterns(capSkill.name),
	);
	// Names claimed by any ENABLED authored skill (from the pre-dedup superset).
	// Managed defers to these even when capability dedup hid an enabled authored
	// skill behind a disabled higher-priority one, so managed never masks it.
	const enabledAuthoredNames = new Set(
		result.all
			.filter(
				capSkill => capSkill._source.provider !== MANAGED_SKILLS_PROVIDER_ID && isSourceEnabled(capSkill._source),
			)
			.map(capSkill => capSkill.name),
	);
	const managedRealPaths = await Promise.all(
		managedCandidates.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);
	for (let i = 0; i < managedCandidates.length; i++) {
		const capSkill = managedCandidates[i];
		const resolvedPath = managedRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;
		if (enabledAuthoredNames.has(capSkill.name)) continue; // an enabled authored skill owns this name
		// Already claimed — e.g. by a custom-directory skill. LOAD-BEARING: custom
		// dirs never enter `result.all`, so they are absent from `enabledAuthoredNames`
		// above; this map check is the ONLY veto that lets a custom-dir authored skill
		// win over a same-named managed one. The custom-dir loop (which populates
		// skillMap, ~30 lines up) MUST run before this block — do not reorder.
		if (skillMap.has(capSkill.name)) continue;
		const rawDescription =
			typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "";
		skillMap.set(capSkill.name, {
			name: capSkill.name,
			description: sanitizeManagedDescription(rawDescription),
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: `${capSkill._source.provider}:${capSkill.level}`,
			...(capSkill.containRoot !== undefined && { containRoot: capSkill.containRoot }),
			hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
			_source: capSkill._source,
		});
		realPathSet.add(resolvedPath);
	}

	const skills = Array.from(skillMap.values()).filter(skill => matchesIncludePatterns(skill.name));
	// Deterministic ordering for prompt stability (case-insensitive, then exact name, then path).
	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
	return {
		skills,
		warnings: [...(result.warnings ?? []).map(w => ({ skillPath: "", message: w })), ...collisionWarnings],
		diagnostics: buildSkillDiagnostics(skills, admitted, redundant.values()),
	};
}

export interface BuiltSkillPromptMessage {
	message: string;
	details: SkillPromptDetails;
}

export function getSkillSlashCommandName(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

/**
 * Parsed `/skill:<name>` invocation: either at the start of the draft (the
 * traditional slash-command position) or as a `/skill:<name>` token embedded
 * mid-prompt. For the mid-prompt form the surrounding prose is threaded
 * through as `args` so the skill sees the full user request.
 */
export interface ParsedSkillInvocation {
	/** Bare skill name without the leading `skill:` prefix. */
	name: string;
	/** User-supplied arguments (everything outside the `/skill:<name>` token). */
	args: string;
	/** The draft as submitted (trimmed), token in place — drives the transcript layout. */
	prompt: string;
}

/**
 * Detect a `/skill:<name>` invocation in a user draft.
 *
 * Returns `undefined` when the text contains no skill token. Otherwise:
 *   - Leading form (`/skill:foo bar baz`): name=`foo`, args=`bar baz`.
 *   - Mid-prompt form (`fix the bug /skill:foo focus on auth`): name=`foo`,
 *     args=`fix the bug focus on auth` — the surrounding prose collapsed
 *     into a single args string.
 *
 * Mid-prompt detection is gated by {@link allowsSkillTokens}.
 */
export function parseSkillInvocation(text: string): ParsedSkillInvocation | undefined {
	const trimmedStart = text.trimStart();
	const prompt = trimmedStart.trimEnd();
	if (trimmedStart.startsWith("/skill:")) {
		const spaceIndex = trimmedStart.search(/\s/);
		const name =
			spaceIndex === -1 ? trimmedStart.slice("/skill:".length) : trimmedStart.slice("/skill:".length, spaceIndex);
		if (!name) return undefined;
		const args = spaceIndex === -1 ? "" : trimmedStart.slice(spaceIndex + 1).trim();
		return { name, args, prompt };
	}
	if (!allowsSkillTokens(trimmedStart)) return undefined;
	SKILL_TOKEN_RE.lastIndex = 0;
	const match = SKILL_TOKEN_RE.exec(text);
	if (!match) return undefined;
	const tokenStart = match.index + match[1].length;
	const tokenEnd = match.index + match[0].length;
	const name = match[2];
	const before = text.slice(0, tokenStart).trimEnd();
	const after = text.slice(tokenEnd).trimStart();
	const args = [before, after]
		.filter(part => part.length > 0)
		.join(" ")
		.trim();
	return { name, args, prompt };
}

export type SkillInvocationKind = "user" | "autoload";

/** What the user typed around a skill token: `args` feed the template, `prompt` only the transcript. */
export type SkillPromptInput = Pick<ParsedSkillInvocation, "args"> & Partial<Pick<ParsedSkillInvocation, "prompt">>;

export async function buildSkillPromptMessage(
	skill: Pick<Skill, "name" | "filePath" | "baseDir">,
	input: SkillPromptInput,
	invocation: SkillInvocationKind = "user",
): Promise<BuiltSkillPromptMessage> {
	const content = await Bun.file(skill.filePath).text();
	// Only the body is used: keep HTML comments (`repair: false`) and leave YAML
	// diagnostics to the loader, which already parsed this frontmatter.
	const body = parseFrontmatter(content, { source: skill.filePath, repair: false, level: "off" }).body.trim();
	const trimmedArgs = input.args.trim();
	let message: string;
	if (invocation === "user") {
		// User-invoked skills announce themselves and expose their skill directory
		// so the model resolves the skill's own relative paths (scripts/, templates/).
		message = prompt
			.render(userInvocationTemplate, {
				name: skill.name,
				body,
				baseDir: skill.baseDir,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	} else {
		// Autoload skills are hidden, non-user context — they MUST NOT claim the
		// user invoked them; this keeps the minimal provenance-only format.
		message = prompt
			.render(autoloadTemplate, {
				body,
				filePath: skill.filePath,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	}
	return {
		message,
		details: {
			name: skill.name,
			path: skill.filePath,
			args: trimmedArgs || undefined,
			prompt: input.prompt,
			lineCount: body ? body.split("\n").length : 0,
		},
	};
}
