/**
 * Managed-skills primitives for the experimental auto-learn feature.
 *
 * Managed skills are auto-generated/enhanced `SKILL.md` files kept in an
 * isolated directory (`~/.omp/agent/managed-skills`) separate from
 * user-authored skills (`~/.omp/agent/skills`). They are discovered and
 * surfaced like normal skills, but every write here is confined to
 * `getManagedSkillsDir()` — auto-management can never touch authored skills.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Provider id stamped on discovered managed skills (distinguishes them from authored). */
export const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the isolated managed-skills directory (`~/.omp/agent/managed-skills`). */
export function getManagedSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "managed-skills");
}

/**
 * Validate + normalize a managed-skill name. Throws on anything outside the
 * strict allowlist so a bad name can never escape `getManagedSkillsDir()`
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
 * Frontmatter key holding a managed skill's provenance. Namespaced (`x-omp-`)
 * so it never collides with Agent Skills fields; read with `rawKeys` because the
 * default frontmatter parse camel-cases it to `xOmpProvenance`. Provenance is
 * never rendered into the system prompt — only `name`/`description` are.
 */
export const MANAGED_SKILL_PROVENANCE_KEY = "x-omp-provenance";

/** Most recent contributing sessions/projects kept per managed skill. */
export const MAX_PROVENANCE_ENTRIES = 20;

/** Tool that wrote a managed skill. */
export type ManagedSkillGenerator = "manage_skill" | "learn";

/**
 * Where a managed skill came from: the writing tool, when it was created and
 * last updated, and the sessions/projects whose work produced it (oldest
 * first, capped at {@link MAX_PROVENANCE_ENTRIES}). Session ids are the source
 * episodes a reviewer resumes to see why the skill exists; several projects
 * mark a procedure learned in more than one context.
 */
export interface ManagedSkillProvenance {
	generator: ManagedSkillGenerator;
	/** Absent when the skill predates provenance stamping. */
	created?: string;
	updated: string;
	sessions: string[];
	projects: string[];
}

/** Identity of one managed-skill write, merged into the stored provenance. */
export interface ManagedSkillOrigin {
	generator: ManagedSkillGenerator;
	sessionId?: string | null;
	project?: string;
}

function isGenerator(value: unknown): value is ManagedSkillGenerator {
	return value === "manage_skill" || value === "learn";
}

/** Single-line, control-free string from an on-disk provenance value; empty when not a string. */
function provenanceString(value: unknown): string {
	return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
}

function provenanceList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(provenanceString).filter(entry => entry.length > 0);
}

/**
 * Parse the provenance block from raw-keyed frontmatter. Returns undefined when
 * absent or unusable (hand-placed or pre-provenance skills).
 */
export function readManagedSkillProvenance(frontmatter: Record<string, unknown>): ManagedSkillProvenance | undefined {
	const raw = frontmatter[MANAGED_SKILL_PROVENANCE_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const updated = provenanceString(record.updated);
	if (!isGenerator(record.generator) || !updated) return undefined;
	const created = provenanceString(record.created);
	return {
		generator: record.generator,
		...(created ? { created } : {}),
		updated,
		sessions: provenanceList(record.sessions),
		projects: provenanceList(record.projects),
	};
}

function appendRecent(list: readonly string[], value: string | null | undefined): string[] {
	const next = list.filter(entry => entry !== value);
	if (value) next.push(value);
	return next.slice(-MAX_PROVENANCE_ENTRIES);
}

/**
 * Fold one write into the prior provenance: `created` survives updates, the
 * writer's session/project move to the most-recent end of their lists.
 */
function nextProvenance(
	action: WriteManagedSkillInput["action"],
	prior: ManagedSkillProvenance | undefined,
	origin: ManagedSkillOrigin,
	now: string,
): ManagedSkillProvenance {
	const created = action === "create" ? now : prior?.created;
	return {
		generator: origin.generator,
		...(created ? { created } : {}),
		updated: now,
		sessions: appendRecent(prior?.sessions ?? [], origin.sessionId),
		projects: appendRecent(prior?.projects ?? [], origin.project),
	};
}

/**
 * Serialize the `name`/`description` frontmatter block (plus provenance when
 * given) via the repo's YAML helper (round-trips through `parseFrontmatter`).
 */
export function toSkillFrontmatter(name: string, description: string, provenance?: ManagedSkillProvenance): string {
	const frontmatter = YAML.stringify(
		{
			name,
			description: sanitizeManagedDescription(description),
			...(provenance ? { [MANAGED_SKILL_PROVENANCE_KEY]: provenance } : {}),
		},
		null,
		2,
	).trimEnd();
	return `---\n${frontmatter}\n---\n`;
}

/**
 * `create` needs both fields. `update` needs at least one: a missing field keeps
 * what the stored skill already has, so a one-line change need not resend a
 * long body.
 */
export interface WriteManagedSkillInput {
	action: "create" | "update";
	name: string;
	description?: string;
	body?: string;
	/** Who is writing; stamped into the skill's provenance. */
	origin: ManagedSkillOrigin;
}

const LEADING_FRONTMATTER = /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Strip the `---` frontmatter blocks a body leads with. Callers often include one
 * although the tool generates it, which would leave the stored file with two.
 * Only a block that parses as a YAML mapping carrying a skill metadata key
 * (`name`, `description`, or the provenance key) counts, so a body opening with
 * a horizontal rule (even one followed by a `Key: value` Setext heading) keeps
 * it. The stripped blocks' values are discarded: the explicit `name` and
 * `description` (or the stored ones on `update`) always win.
 */
export function stripBodyFrontmatter(raw: string): string {
	let body = raw;
	for (;;) {
		const match = LEADING_FRONTMATTER.exec(body);
		if (!match) break;
		let parsed: unknown;
		try {
			parsed = YAML.parse(match[1]);
		} catch {
			break;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) break;
		if (!("name" in parsed || "description" in parsed || MANAGED_SKILL_PROVENANCE_KEY in parsed)) break;
		body = body.slice(match[0].length);
	}
	return body;
}

/**
 * Serialize create/update/delete on the same skill name. Both tools are
 * non-exclusive, so a parallel tool batch in one turn can run two mutations on
 * the same skill at once (e.g. an update observing the file mid-delete). This
 * per-name promise chain runs same-skill mutations in submission order while
 * different names still proceed in parallel. In-process only; cross-process
 * races are out of scope.
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

/**
 * Validate the managed-skills root before composing any child path. A symlinked
 * root is allowed when it resolves to an existing directory: the operator may
 * point the store at the shared skills tree (`~/.omp/agent/managed-skills` ->
 * `~/meta/notes/omp-skills`). Child paths stay inside that target because a
 * skill name is one safe path segment and a child directory symlink is rejected
 * at the mutation itself. A broken link or a link to a non-directory has no
 * defined write target, so it is refused.
 */
async function assertManagedRootSafe(): Promise<void> {
	const root = getManagedSkillsDir();
	const rootStat = await fs.lstat(root).catch(err => {
		if (isEnoent(err)) return null;
		throw err;
	});
	if (!rootStat?.isSymbolicLink()) return;
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

const UPDATE_FILE_OPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;

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

/** Create or update a managed `SKILL.md`. Returns the resolved file path. */
export async function writeManagedSkill(input: WriteManagedSkillInput): Promise<{ path: string }> {
	const name = sanitizeSkillName(input.name);
	const strippedBody = input.body === undefined ? undefined : stripBodyFrontmatter(input.body);
	const description = input.description;
	if (input.action === "create" && (description === undefined || strippedBody === undefined)) {
		throw new Error(`Creating managed skill "${name}" requires both a description and a body.`);
	}
	if (description === undefined && strippedBody === undefined) {
		throw new Error(`Updating managed skill "${name}" requires a description, a body, or both.`);
	}
	const render = (rawDescription: string, rawBody: string, prior: ManagedSkillProvenance | undefined): Buffer => {
		const sanitizedDescription = sanitizeManagedDescription(rawDescription);
		const body = rawBody.trim();
		// Reject empty content: an all-whitespace/control description sanitizes to ""
		// and the `requireDescription` discovery scan then silently drops the skill,
		// so the tool would report success for a skill that never appears.
		if (!sanitizedDescription) {
			throw new Error(`Managed skill "${name}" needs a non-empty description.`);
		}
		if (!body) {
			throw new Error(`Managed skill "${name}" needs a non-empty body.`);
		}
		const provenance = nextProvenance(input.action, prior, input.origin, new Date().toISOString());
		const content = Buffer.from(`${toSkillFrontmatter(name, sanitizedDescription, provenance)}\n${body}\n`, "utf8");
		// Cap the UTF-8 byte size of the FINAL file (body + description + frontmatter),
		// not the UTF-16 code-unit length of the body alone.
		if (content.byteLength > MAX_MANAGED_SKILL_BYTES) {
			throw new Error(
				`Managed skill is ${content.byteLength} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}. Trim the body or description.`,
			);
		}
		return content;
	};
	// Fail an empty or oversized create/update before touching the filesystem; an
	// update re-renders below once the stored skill (provenance and any field the
	// call left out) is known.
	if (description !== undefined && strippedBody !== undefined) render(description, strippedBody, undefined);
	return serializeSkillMutation(name, async () => {
		await assertManagedRootSafe();
		const dir = path.join(getManagedSkillsDir(), name);
		const file = path.join(dir, "SKILL.md");
		// Reject a symlinked skill directory: an intermediate symlink would let the
		// write escape the isolated managed root. lstat does not follow the final
		// component, so a symlinked `dir` is caught here.
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(
				`Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`,
			);
		}
		if (input.action === "create") {
			// Unreachable after the checks above; narrows both fields for the compiler.
			if (description === undefined || strippedBody === undefined) {
				throw new Error(`Creating managed skill "${name}" requires both a description and a body.`);
			}
			const content = render(description, strippedBody, undefined);
			await fs.mkdir(dir, { recursive: true });
			// O_CREAT|O_EXCL ("wx"): atomic create that fails if the file already
			// exists (closing the check-then-write race) and refuses a symlinked SKILL.md.
			try {
				await fs.writeFile(file, content, { flag: "wx" });
			} catch (err) {
				if ((err as { code?: string }).code === "EEXIST") {
					throw new Error(`Managed skill "${name}" already exists. Use action "update" to change it.`);
				}
				throw err;
			}
			return { path: file };
		}
		// update: the file must already exist, be a plain managed file, and must
		// not share an inode with a user-authored file via hard link. Open the
		// checked file handle before truncating so a path swap after lstat cannot
		// redirect the write into a symlink or newly hard-linked target.
		const fileStat = await fs.lstat(file).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (fileStat === null) {
			throw new Error(`Managed skill "${name}" does not exist. Use action "create" to add it.`);
		}
		if (fileStat.isSymbolicLink()) {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		assertManagedSkillFileSafeForUpdate(name, fileStat);
		const handle = await openManagedSkillFileForUpdate(name, file);
		try {
			const openStat = await handle.stat();
			assertManagedSkillFileSafeForUpdate(name, openStat);
			// Carry the stored provenance forward (created date, contributing sessions/projects)
			// and keep any field the call left out. Read through the checked handle so a path
			// swap cannot feed it another file.
			// `normalize: false` keeps the stored body's line endings byte-for-byte when
			// it is carried forward unchanged.
			const stored = parseFrontmatter(await handle.readFile({ encoding: "utf8" }), {
				source: file,
				rawKeys: true,
				level: "off",
				normalize: false,
			});
			const storedDescription = stored.frontmatter.description;
			const content = render(
				description ?? (typeof storedDescription === "string" ? storedDescription : ""),
				strippedBody ?? stored.body,
				readManagedSkillProvenance(stored.frontmatter),
			);
			await handle.truncate(0);
			// Positional writes: the read above advanced the handle's file position.
			let offset = 0;
			while (offset < content.byteLength) {
				const { bytesWritten } = await handle.write(content, offset, content.byteLength - offset, offset);
				offset += bytesWritten;
			}
		} finally {
			await handle.close();
		}
		return { path: file };
	});
}

/** A managed skill as stored on disk, for review listings. */
export interface ManagedSkillEntry {
	name: string;
	description: string;
	path: string;
	provenance?: ManagedSkillProvenance;
}

/**
 * List every managed skill on disk (including ones an authored skill shadows),
 * most recently updated first. Symlinked or invalidly named entries are skipped
 * — the same entries the write/delete primitives refuse to touch.
 */
export async function listManagedSkills(): Promise<ManagedSkillEntry[]> {
	const root = getManagedSkillsDir();
	const dirents = await fs.readdir(root, { withFileTypes: true }).catch(err => {
		if (isEnoent(err)) return [];
		throw err;
	});
	const entries = await Promise.all(
		dirents
			.filter(dirent => dirent.isDirectory() && isValidManagedSkillName(dirent.name))
			.map(async (dirent): Promise<ManagedSkillEntry | null> => {
				const file = path.join(root, dirent.name, "SKILL.md");
				const content = await fs.readFile(file, "utf8").catch(err => {
					if (isEnoent(err)) return null;
					throw err;
				});
				if (content === null) return null;
				const { frontmatter } = parseFrontmatter(content, { source: file, rawKeys: true, level: "off" });
				const provenance = readManagedSkillProvenance(frontmatter);
				return {
					name: dirent.name,
					description: sanitizeManagedDescription(provenanceString(frontmatter.description)),
					path: file,
					...(provenance ? { provenance } : {}),
				};
			}),
	);
	return entries
		.filter((entry): entry is ManagedSkillEntry => entry !== null)
		.sort(
			(a, b) =>
				(b.provenance?.updated ?? "").localeCompare(a.provenance?.updated ?? "") || a.name.localeCompare(b.name),
		);
}

/** Delete a managed skill directory. Throws when it does not exist. */
export async function deleteManagedSkill(name: string): Promise<void> {
	const safe = sanitizeSkillName(name);
	await serializeSkillMutation(safe, async () => {
		await assertManagedRootSafe();
		const dir = path.join(getManagedSkillsDir(), safe);
		// Refuse to follow a symlinked skill directory (rm would delete the target).
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(`Managed skill "${safe}" is a symlink; refusing to delete outside the managed directory.`);
		}
		try {
			await fs.rm(dir, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`Managed skill "${safe}" does not exist.`);
			}
			throw err;
		}
	});
}
