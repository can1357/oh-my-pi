/**
 * Managed-skills primitives for the experimental auto-learn feature.
 *
 * Managed skills are auto-generated/enhanced `SKILL.md` files kept in an
 * isolated directory (`~/.ompk/agent/managed-skills`) separate from
 * user-authored skills (`~/.ompk/agent/skills`). They are discovered and
 * surfaced like normal skills, but every write here is confined to
 * `getManagedSkillsDir()` — auto-management can never touch authored skills.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, parseFrontmatter } from "@pk-nerdsaver-ai/pi-utils";
import { YAML } from "bun";

/** Provider id stamped on discovered managed skills (distinguishes them from authored). */
export const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the isolated managed-skills directory (`~/.ompk/agent/managed-skills`). */
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

export type ManagedSkillValidationCode =
	| "invalid_name"
	| "empty_description"
	| "empty_body"
	| "body_has_frontmatter"
	| "frontmatter_roundtrip"
	| "placeholder_content"
	| "oversized";

export interface ManagedSkillValidationIssue {
	code: ManagedSkillValidationCode;
	message: string;
	field?: "name" | "description" | "body";
}

export interface ManagedSkillValidationInput {
	name: string;
	description: string;
	body: string;
}

export interface ManagedSkillNormalizedPayload {
	name: string;
	description: string;
	body: string;
	content: string;
}

export interface ManagedSkillValidationResult {
	ok: boolean;
	issues: ManagedSkillValidationIssue[];
	/** Present when validation succeeds — ready to persist without re-serializing. */
	normalized?: ManagedSkillNormalizedPayload;
}

const PLACEHOLDER_EXACT = new Set([
	"todo",
	"tbd",
	"n/a",
	"na",
	"none",
	"placeholder",
	"lorem ipsum",
	"fix me",
	"xxx",
	"...",
	"…",
]);

/**
 * True when text is placeholder-only (TODO/TBD/placeholder), not when those
 * tokens appear inside otherwise substantive markdown/code.
 */
function isPlaceholderOnly(text: string): boolean {
	const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
	if (!normalized) return true;
	if (PLACEHOLDER_EXACT.has(normalized)) return true;
	const literal = normalized.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
	if (PLACEHOLDER_EXACT.has(literal)) return true;
	if (/^(todo|tbd|placeholder)\s*[:.!?-]?\s*$/.test(normalized)) return true;
	if (/^#+\s*(todo|tbd|placeholder)\s*[:.!?-]?\s*$/.test(normalized)) return true;
	return false;
}

function bodyLooksLikeFrontmatter(body: string): boolean {
	const normalized = body.trimStart().replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---")) return false;
	if (/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.test(normalized)) return true;
	// Preserve a Markdown thematic break (`---` followed by blank prose), but
	// reject an unterminated YAML-looking header before it can be persisted.
	return /^---[ \t]*\n(?:[ \t]*\n|[ \t]*#[^\n]*\n)*(?:name|description)\s*:/m.test(normalized);
}

/** Join validation issues into one actionable tool/error message. */
export function formatManagedSkillValidationIssues(issues: ManagedSkillValidationIssue[]): string {
	return issues.map(issue => issue.message).join(" ");
}

/**
 * Pure structural validation for a managed-skill create/update payload.
 * Does not touch the filesystem — safe for dry-run checks from tools and tests.
 * Proves generated frontmatter round-trips, name/description/body meet discovery
 * requirements, body has no frontmatter, and rejects placeholder-only content
 * while allowing legitimate markdown/code that merely mentions TODO.
 */
export function validateManagedSkillPayload(input: ManagedSkillValidationInput): ManagedSkillValidationResult {
	const issues: ManagedSkillValidationIssue[] = [];

	let name: string | undefined;
	try {
		name = sanitizeSkillName(input.name);
	} catch (err) {
		issues.push({
			code: "invalid_name",
			field: "name",
			message: err instanceof Error ? err.message : String(err),
		});
	}

	const description = sanitizeManagedDescription(input.description);
	if (!description) {
		issues.push({
			code: "empty_description",
			field: "description",
			message: `Managed skill${name ? ` "${name}"` : ""} needs a non-empty description.`,
		});
	} else if (isPlaceholderOnly(description)) {
		issues.push({
			code: "placeholder_content",
			field: "description",
			message: `Managed skill${name ? ` "${name}"` : ""} description looks like a placeholder (TODO/TBD/placeholder). Provide a concrete discovery description.`,
		});
	}

	const body = input.body.trim();
	if (!body) {
		issues.push({
			code: "empty_body",
			field: "body",
			message: `Managed skill${name ? ` "${name}"` : ""} needs a non-empty body.`,
		});
	} else {
		if (bodyLooksLikeFrontmatter(body)) {
			issues.push({
				code: "body_has_frontmatter",
				field: "body",
				message: `Managed skill${name ? ` "${name}"` : ""} body must not include frontmatter; pass markdown body only (frontmatter is generated from name and description).`,
			});
		}
		if (isPlaceholderOnly(body)) {
			issues.push({
				code: "placeholder_content",
				field: "body",
				message: `Managed skill${name ? ` "${name}"` : ""} body looks like a placeholder (TODO/TBD/placeholder-only). Include tested, reproducible steps.`,
			});
		}
	}

	if (issues.length > 0 || name === undefined || !description || !body) {
		return { ok: false, issues };
	}

	const content = `${toSkillFrontmatter(name, description)}\n${body}\n`;
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_MANAGED_SKILL_BYTES) {
		return {
			ok: false,
			issues: [
				{
					code: "oversized",
					message: `Managed skill is ${bytes} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}. Trim the body or description.`,
				},
			],
		};
	}

	const { frontmatter, body: parsedBody } = parseFrontmatter(content, {
		source: `managed-skill:${name}`,
		level: "off",
	});
	if (frontmatter.name !== name) {
		issues.push({
			code: "frontmatter_roundtrip",
			field: "name",
			message: `Managed skill "${name}" frontmatter name did not round-trip through the skill parser.`,
		});
	}
	const parsedDescription =
		typeof frontmatter.description === "string" ? sanitizeManagedDescription(frontmatter.description) : "";
	if (parsedDescription !== description) {
		issues.push({
			code: "frontmatter_roundtrip",
			field: "description",
			message: `Managed skill "${name}" frontmatter description did not round-trip through the skill parser.`,
		});
	}
	if (parsedBody.trim() !== body) {
		issues.push({
			code: "frontmatter_roundtrip",
			field: "body",
			message: `Managed skill "${name}" body did not round-trip through the skill parser.`,
		});
	}

	if (issues.length > 0) {
		return { ok: false, issues };
	}

	return {
		ok: true,
		issues: [],
		normalized: { name, description, body, content },
	};
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
 * Reject when the managed-skills root itself is a symlink. lstat on a child
 * follows intermediate components, so a symlinked root would let an otherwise
 * valid name write/delete outside the isolated directory (e.g. onto authored
 * skills). Checked before composing any child path.
 */
async function assertManagedRootSafe(): Promise<void> {
	const rootStat = await fs.lstat(getManagedSkillsDir()).catch(err => {
		if (isEnoent(err)) return null;
		throw err;
	});
	if (rootStat?.isSymbolicLink()) {
		throw new Error("The managed-skills root is a symlink; refusing to operate outside the managed directory.");
	}
}

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

/** Create or update a managed `SKILL.md`. Returns the resolved file path. */
export async function writeManagedSkill(input: WriteManagedSkillInput): Promise<{ path: string }> {
	// Structural validation runs before any disk mutation (and is reusable dry-run).
	const validation = validateManagedSkillPayload(input);
	if (!validation.ok || !validation.normalized) {
		throw new Error(formatManagedSkillValidationIssues(validation.issues));
	}
	const { name, content } = validation.normalized;
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
		// update: validate the existing managed file, then replace it atomically
		// with a fully written temporary file in the same directory. A failed or
		// interrupted write leaves the previous SKILL.md intact.
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
		const tempFile = path.join(dir, `.SKILL.md.${Bun.randomUUIDv7()}.tmp`);
		let tempCreated = false;
		try {
			const handle = await fs.open(tempFile, "wx", 0o600);
			tempCreated = true;
			try {
				await handle.writeFile(content);
				await handle.sync();
			} finally {
				await handle.close();
			}
			const currentStat = await fs.lstat(file);
			if (currentStat.isSymbolicLink()) {
				throw new Error(`Managed skill "${name}" SKILL.md became a symlink; refusing to replace it.`);
			}
			assertManagedSkillFileSafeForUpdate(name, currentStat);
			await fs.rename(tempFile, file);
			tempCreated = false;
		} finally {
			if (tempCreated) await fs.rm(tempFile, { force: true });
		}
		return { path: file };
	});
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
