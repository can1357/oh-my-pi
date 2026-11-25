/**
 * Managed-skills primitives for the experimental auto-learn feature.
 *
 * Managed skills are auto-generated/enhanced `SKILL.md` files kept in isolated
 * omp-owned directories separate from user-authored skills
 * (`~/.omp/agent/skills`, `<repo>/.omp/skills`). Two scopes exist:
 * - global: `~/.omp/agent/managed-skills`, discovered in every session;
 * - project: `~/.omp/agent/project-managed-skills/<project-key>`, discovered
 *   only for sessions in that project. The store lives under the agent dir,
 *   never inside the repository.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { encodeManagedSkillsProjectKey, resolveManagedSkillsProjectRoot } from "./project-key";

/** Provider id stamped on discovered managed skills (distinguishes them from authored). */
export const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Where a managed skill lives: every session (`global`) or one project's store (`project`). */
export type ManagedSkillScope = "global" | "project";

/** Omit scope to select the visible managed copy in cwd. Primitive calls without a location use global. */
export type ManagedSkillLocation =
	| { readonly scope: "global" }
	| { readonly scope: "project"; readonly cwd: string }
	| { readonly scope?: undefined; readonly cwd: string; getVisibleFile(name: string): Promise<string> };

const GLOBAL_MANAGED_SKILLS = { scope: "global" } as const;

/** Project discovery and unscoped mutations both require an addressable directory name. */
export async function readAddressableManagedSkill(root: string, name: string) {
	if (!isValidManagedSkillName(name)) return;
	const file = path.join(root, name, "SKILL.md");
	try {
		// Discovery can read a link, but a mutation must still pass the no-link write checks.
		if (!(await fs.stat(file)).isFile()) return;
		const { frontmatter, body } = parseFrontmatter(await Bun.file(file).text(), { source: file });
		if (frontmatter.enabled === false || !frontmatter.description) return;
		// Project-managed skills are addressed by directory name. An alias could redirect edits.
		if (frontmatter.name !== undefined && frontmatter.name !== name) return;
		return { name, path: file, content: body, frontmatter };
	} catch (err) {
		if (!isEnoent(err) && (err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
	}
}

async function resolveMutationStore(
	action: "create" | "update" | "delete",
	name: string,
	location: ManagedSkillLocation,
) {
	let scope: ManagedSkillScope = location.scope ?? "global";
	let root = getManagedSkillsDir();
	if (location.scope === "project" || (!location.scope && action !== "create")) {
		const projectRoot = getProjectManagedSkillsDir(location.cwd);
		await assertProjectManagedRootSafe(projectRoot);
		if (location.scope === "project") return { scope: location.scope, root: projectRoot };
		// Windows directories can be case-sensitive even though path.relative folds case.
		const visible = path.resolve(await location.getVisibleFile(name));
		if (visible === path.resolve(projectRoot, name, "SKILL.md")) {
			scope = "project";
			root = projectRoot;
		} else if (visible !== path.resolve(root, name, "SKILL.md")) {
			throw new Error(`The visible skill "${name}" is not in this session's managed store under that name.`);
		}
		if (!(await readAddressableManagedSkill(root, name))) {
			throw new Error(`The visible managed skill "${name}" is no longer addressable in the ${scope} scope.`);
		}
	}
	if (scope === "global") await assertGlobalManagedRootSafe(root);
	return { scope, root };
}

/** Resolve the isolated global managed-skills directory (`~/.omp/agent/managed-skills`). */
export function getManagedSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "managed-skills");
}

/** Parent of every project store (`~/.omp/agent/project-managed-skills`). */
export function getProjectManagedSkillsBaseDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "project-managed-skills");
}

/** Project store for `cwd` (`~/.omp/agent/project-managed-skills/<project-key>`). */
export function getProjectManagedSkillsDir(cwd: string, agentDir: string = getAgentDir()): string {
	return path.join(
		getProjectManagedSkillsBaseDir(agentDir),
		encodeManagedSkillsProjectKey(resolveManagedSkillsProjectRoot(cwd)),
	);
}

/**
 * Validate + normalize a managed-skill name. Throws on anything outside the
 * strict allowlist so a bad name can never escape its managed root
 * (blocks `..`, slashes, empty, and uppercase).
 */
export function sanitizeSkillName(raw: string): string {
	const name = raw.trim().toLowerCase();
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).`,
		);
	}
	return name;
}

/**
 * Whether `name` is a safe managed-skill name (the exact post-sanitize shape).
 * Used to validate names read from disk at discovery time — a managed
 * `SKILL.md` whose `frontmatter.name` was not produced by `sanitizeSkillName`
 * (e.g. hand-placed) must not render unescaped into the system prompt.
 */
export function isValidManagedSkillName(name: string): boolean {
	return SKILL_NAME_PATTERN.test(name);
}

/**
 * Neutralize a machine-generated managed-skill description so it cannot break
 * out of the system prompt's `<skills>` listing. Managed descriptions are
 * generated from prior task content and persist across sessions, so this is a
 * trust boundary: strip control/format chars, angle brackets (`<system-directive>`
 * / `</skills>`), and Markdown fence delimiters (backticks, `~~~`), then collapse
 * to a single line. Applied on BOTH write and read so existing files are safe too.
 */
export function sanitizeManagedDescription(raw: string): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Serialize the minimal `name`/`description` frontmatter block via the repo's
 * YAML helper (round-trips through `parseFrontmatter`).
 */
export function toSkillFrontmatter(name: string, description: string): string {
	const frontmatter = YAML.stringify(
		{ name, description: sanitizeManagedDescription(description) },
		null,
		2,
	).trimEnd();
	return `---\n${frontmatter}\n---\n`;
}

export interface WriteManagedSkillInput {
	action: "create" | "update";
	name: string;
	description: string;
	body: string;
}

/**
 * Serialize create/update/delete on the same skill. Both tools are
 * non-exclusive, so a parallel tool batch in one turn can run two mutations on
 * the same skill at once (e.g. an update observing the file mid-delete). This
 * per-name chain includes scope lookup: an unscoped operation can target either
 * store. Other names proceed independently. The queue is in-process only.
 */
const skillMutationChains = new Map<string, Promise<unknown>>();
function serializeSkillMutation<T>(name: string, op: () => Promise<T>): Promise<T> {
	const prev = skillMutationChains.get(name) ?? Promise.resolve();
	const run = prev.then(op, op);
	const guarded = run.catch(() => {});
	skillMutationChains.set(name, guarded);
	void guarded.finally(() => {
		if (skillMutationChains.get(name) === guarded) skillMutationChains.delete(name);
	});
	return run;
}

async function lstatIfPresent(file: string): Promise<Stats | null> {
	try {
		return await fs.lstat(file);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

export async function assertProjectManagedRootSafe(root: string): Promise<void> {
	if ((await lstatIfPresent(path.dirname(root)))?.isSymbolicLink()) {
		throw new Error("The project-managed-skills parent is a symlink; refusing to use it.");
	}
	if ((await lstatIfPresent(root))?.isSymbolicLink()) {
		throw new Error("The project-managed-skills root is a symlink; refusing to use it.");
	}
}

async function assertGlobalManagedRootSafe(root: string): Promise<void> {
	if (!(await lstatIfPresent(root))?.isSymbolicLink()) return;
	// Operators may deliberately link only the global root to an existing directory.
	const targetStat = await fs.stat(root).catch(err => {
		if (isEnoent(err)) {
			throw new Error(`The managed-skills root ${root} is a broken symlink; refusing to write.`);
		}
		throw err;
	});
	if (!targetStat.isDirectory()) {
		throw new Error(`The managed-skills root ${root} links to a non-directory; refusing to write.`);
	}
}

const UPDATE_FILE_OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;

function assertManagedSkillFileSafeForUpdate(name: string, fileStat: Stats): void {
	if (!fileStat.isFile()) {
		throw new Error(`Managed skill "${name}" SKILL.md is not a regular file; refusing to overwrite it.`);
	}
	if (fileStat.nlink > 1) {
		throw new Error(
			`Managed skill "${name}" SKILL.md has ${fileStat.nlink} hard links; refusing to overwrite a file that may be user-authored elsewhere.`,
		);
	}
}

async function openManagedSkillFileForUpdate(name: string, file: string) {
	try {
		return await fs.open(file, UPDATE_FILE_OPEN_FLAGS);
	} catch (err) {
		if ((err as { code?: string }).code === "ELOOP") {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		throw err;
	}
}

interface ManagedSkillWriteResult {
	path: string;
	scope: ManagedSkillScope;
}

/** Create or update a managed skill and report the store that changed. */
export function writeManagedSkill(
	input: WriteManagedSkillInput,
	location?: ManagedSkillLocation,
): Promise<ManagedSkillWriteResult>;
/** Reserve the name now. A queued predicate can wait for lesson storage or decline the write. */
export function writeManagedSkill(
	input: WriteManagedSkillInput,
	location: ManagedSkillLocation,
	shouldWrite: (name: string) => Promise<boolean>,
): Promise<ManagedSkillWriteResult | null>;
export async function writeManagedSkill(
	input: WriteManagedSkillInput,
	location: ManagedSkillLocation = GLOBAL_MANAGED_SKILLS,
	shouldWrite?: (name: string) => Promise<boolean>,
): Promise<ManagedSkillWriteResult | null> {
	const name = sanitizeSkillName(input.name);
	return serializeSkillMutation(name, async () => {
		if (shouldWrite && !(await shouldWrite(name))) return null;
		const description = sanitizeManagedDescription(input.description);
		const body = input.body.trim();
		// Discovery drops skills without a description. Do not report a successful write.
		if (!description) {
			throw new Error(`Managed skill "${name}" needs a non-empty description.`);
		}
		if (!body) {
			throw new Error(`Managed skill "${name}" needs a non-empty body.`);
		}
		const content = `${toSkillFrontmatter(name, description)}\n${body}\n`;
		// Cap the UTF-8 byte size of the final file, not the UTF-16 length of the body.
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_MANAGED_SKILL_BYTES) {
			throw new Error(
				`Managed skill is ${bytes} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}. Trim the body or description.`,
			);
		}
		const { scope, root } = await resolveMutationStore(input.action, name, location);
		const dir = path.join(root, name);
		const file = path.join(dir, "SKILL.md");
		// Reject a symlinked skill directory: an intermediate symlink would let the
		// write escape the isolated managed root. lstat does not follow the final
		// component, so a symlinked `dir` is caught here.
		const dirStat = await lstatIfPresent(dir);
		if (dirStat?.isSymbolicLink()) {
			throw new Error(
				`Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`,
			);
		}
		if (input.action === "create") {
			await fs.mkdir(dir, { recursive: true });
			// O_CREAT|O_EXCL ("wx"): atomic create that fails if the file already
			// exists (closing the check-then-write race) and refuses a symlinked SKILL.md.
			try {
				await fs.writeFile(file, content, { flag: "wx" });
			} catch (err) {
				if ((err as { code?: string }).code === "EEXIST") {
					throw new Error(
						`Managed skill "${name}" already exists in the ${scope} scope. Use action "update" to change it.`,
					);
				}
				throw err;
			}
			return { path: file, scope };
		}
		// update: the file must already exist, be a plain managed file, and must
		// not share an inode with a user-authored file via hard link. Open the
		// checked file handle before truncating so a path swap after lstat cannot
		// redirect the write into a symlink or newly hard-linked target.
		const fileStat = await lstatIfPresent(file);
		if (fileStat === null) {
			throw new Error(
				`Managed skill "${name}" does not exist in the ${scope} scope. Use action "create" to add it.`,
			);
		}
		if (fileStat.isSymbolicLink()) {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		assertManagedSkillFileSafeForUpdate(name, fileStat);
		const handle = await openManagedSkillFileForUpdate(name, file);
		try {
			const openStat = await handle.stat();
			assertManagedSkillFileSafeForUpdate(name, openStat);
			await handle.truncate(0);
			await handle.writeFile(content);
		} finally {
			await handle.close();
		}
		return { path: file, scope };
	});
}

/** Delete a managed skill directory from `location` (default: global). Throws when it does not exist. */
export async function deleteManagedSkill(
	name: string,
	location: ManagedSkillLocation = GLOBAL_MANAGED_SKILLS,
): Promise<ManagedSkillScope> {
	const safe = sanitizeSkillName(name);
	return serializeSkillMutation(safe, async () => {
		const { scope, root } = await resolveMutationStore("delete", safe, location);
		const dir = path.join(root, safe);
		const dirStat = await lstatIfPresent(dir);
		if (dirStat?.isSymbolicLink()) {
			throw new Error(`Managed skill "${safe}" is a symlink; refusing to delete outside the managed directory.`);
		}
		if ((await lstatIfPresent(path.join(dir, "SKILL.md")))?.isSymbolicLink()) {
			throw new Error(`Managed skill "${safe}" SKILL.md is a symlink; refusing to delete it.`);
		}
		try {
			await fs.rm(dir, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`Managed skill "${safe}" does not exist in the ${scope} scope.`);
			}
			throw err;
		}
		return scope;
	});
}
