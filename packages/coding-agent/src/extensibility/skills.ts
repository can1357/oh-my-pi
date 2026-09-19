import * as fs from "node:fs/promises";
import * as os from "node:os";
import { getProjectDir, prompt } from "@oh-my-pi/pi-utils";
import {
	isValidManagedSkillName,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeManagedDescription,
} from "../autolearn/managed-skills";
import { skillCapability } from "../capability/skill";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { type Skill as CapabilitySkill, isUserSourceEnabled, loadCapability } from "../discovery";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import { allowsSkillTokens, SKILL_TOKEN_RE } from "@oh-my-pi/pi-tui/prompt/skill-tokens";
import autoloadTemplate from "../prompts/skills/autoload.md" with { type: "text" };
import userInvocationTemplate from "../prompts/skills/user-invocation.md" with { type: "text" };
import type { SkillPromptDetails } from "../session/messages";
import { expandTilde } from "../tools/path-utils";

export { allowsSkillTokens, SKILL_TOKEN_RE };

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

export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
}

/**
 * Namespace a skill takes when its bare name is already claimed by a different
 * skill. Derived from the path so every provider gets one without plumbing:
 * the directory owning `skills/` (a plugin or package root), else the
 * directory holding the skill (a custom skills root), else the provider.
 * Dotted homes (`~/.claude/skills`) are not meaningful names.
 */
function skillNamespace(skill: Pick<CapabilitySkill, "path" | "_source">): string {
	const segments = skill.path.split(/[\\/]/);
	const skillsIndex = segments.lastIndexOf("skills");
	// `<root>/skills/**/SKILL.md` → root; marketplace caches name the root
	// `<marketplace>___<plugin>___<version>` → plugin.
	// `<root>/<skill>/SKILL.md` (no `skills/` segment) → root.
	const root = skillsIndex > 0 ? segments[skillsIndex - 1] : segments[segments.length - 3];
	const cached = root?.split("___");
	const namespace = cached?.length === 3 ? cached[1] : root;
	if (!namespace || namespace.startsWith(".")) return skill._source.provider;
	// Namespaces are addressed through `/skill:<ns>/<name>` and `skill://<ns>/<name>`,
	// so they must be a single token: collapse runs of whitespace and other
	// non-name characters to `-` (a distinct root whose sanitized namespace
	// collides just resolves through the normal `~N` suffix path).
	const safe = namespace.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
	return safe || skill._source.provider;
}

interface AdmittedBody {
	/** Pre-collision frontmatter name. Kept explicitly because a legal raw
	 * name may itself end in `~N`, making a registered alias like
	 * `<ns>/foo~2` indistinguishable from a generated collision suffix. */
	rawName: string;
	body: string;
	namespace: string;
	filePath: string;
}

interface CollisionResolution {
	name: string;
	warning?: string;
	displaced?: {
		skill: Skill;
		newName: string;
		warning: string;
	};
}

/**
 * Resolve a same-name skill against what is already loaded.
 * - Identical body to any admitted instance of this raw name → silently drop.
 * - Different body → every variant receives a `<namespace>/<name>` prefix so
 *   neither is ambiguous; a taken namespaced slot gets a numeric suffix.
 */
function resolveCollision(
	skillMap: Map<string, Skill>,
	admitted: Map<string, AdmittedBody>,
	candidate: Skill,
	candidateBody: string,
	namespace: string,
): CollisionResolution | undefined {
	for (const entry of admitted.values()) {
		if (entry.rawName === candidate.name && entry.body === candidateBody) return undefined;
	}
	const existingEntries = [...admitted.entries()].filter(([_, e]) => e.rawName === candidate.name);
	if (existingEntries.length === 0) {
		return { name: candidate.name };
	}

	let displaced: CollisionResolution["displaced"] | undefined;
	const bareSkill = skillMap.get(candidate.name);
	if (bareSkill) {
		const bareEntry = admitted.get(candidate.name)!;
		let namespacedBare = `${bareEntry.namespace}/${bareEntry.rawName}`;
		for (let n = 2; skillMap.has(namespacedBare) || namespacedBare === `${namespace}/${candidate.name}`; n++) {
			namespacedBare = `${bareEntry.namespace}/${bareEntry.rawName}~${n}`;
		}
		displaced = {
			skill: bareSkill,
			newName: namespacedBare,
			warning: `name collision: "${bareEntry.rawName}" from ${bareSkill.filePath} differs from ${candidate.filePath}; available as "${namespacedBare}"`,
		};
	}

	let namespaced = `${namespace}/${candidate.name}`;
	for (let n = 2; skillMap.has(namespaced) || (displaced && displaced.newName === namespaced); n++) {
		namespaced = `${namespace}/${candidate.name}~${n}`;
	}
	const referencePath = existingEntries[0][1].filePath;
	return {
		name: namespaced,
		warning: `name collision: "${candidate.name}" from ${candidate.filePath} differs from ${referencePath}; available as "${namespaced}"`,
		displaced,
	};
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
	const providerId = rawProviderId || "custom";
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
	};
}

export interface LoadSkillsOptions extends SkillsSettings {
	/** Working directory for project-local skills. Default: getProjectDir() */
	cwd?: string;
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
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
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
	 * duplicate or excluded. Include patterns run once every name is final (see
	 * the end of this function): filtering here would drop the bare skill and
	 * leave a namespaced candidate with nothing to collide against.
	 */
	function admit(skill: Skill, body: string, namespace: string): string | undefined {
		const resolved = resolveCollision(skillMap, admitted, skill, body, namespace);
		if (!resolved) return undefined;
		const { name, warning, displaced } = resolved;
		if (disabledSkillNames.has(name) || matchesIgnorePatterns(name)) return undefined;

		if (displaced) {
			skillMap.delete(displaced.skill.name);
			const displacedEntry = admitted.get(displaced.skill.name)!;
			admitted.delete(displaced.skill.name);
			displaced.skill.name = displaced.newName;
			if (!disabledSkillNames.has(displaced.newName) && !matchesIgnorePatterns(displaced.newName)) {
				skillMap.set(displaced.newName, displaced.skill);
				admitted.set(displaced.newName, displacedEntry);
			}
			collisionWarnings.push({ skillPath: displaced.skill.filePath, message: displaced.warning });
		}

		if (warning) collisionWarnings.push({ skillPath: skill.filePath, message: warning });
		const rawName = skill.name;
		skill.name = name;
		skillMap.set(name, skill);
		admitted.set(name, { rawName, body, namespace, filePath: skill.filePath });
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
		if (admit(skill, capSkill.content, skillNamespace(capSkill)) !== undefined) realPathSet.add(resolvedPath);
	}

	const customDirectoryResults = await Promise.all(
		customDirectories.map(async dir => {
			const expandedDir = expandTilde(dir);
			const scanResult = await scanSkillsFromDir(
				{ cwd, home: os.homedir(), repoRoot: null },
				{
					dir: expandedDir,
					providerId: "custom",
					level: "user",
					requireDescription: true,
				},
			);
			return { expandedDir, scanResult };
		}),
	);

	const allCustomSkills: Array<{ skill: Skill; path: string; body: string; namespace: string }> = [];
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
		const { skill, body, namespace } = allCustomSkills[i];
		const resolvedPath = customRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;
		if (admit(skill, body, namespace) !== undefined) realPathSet.add(resolvedPath);
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
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
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
