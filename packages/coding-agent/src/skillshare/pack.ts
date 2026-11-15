/**
 * Build a publishable Skillshare package from a skill directory.
 *
 * `packSkill` validates SKILL.md (Agent Skills spec + registry rules), walks
 * the directory honoring `SKILL_DEFAULT_IGNORES` and `.skillignore`, enforces
 * `SKILL_LIMITS`, and produces the deterministic `.tgz`, its SRI integrity and
 * a report of credential-shaped strings. `bumpVersion` edits only the
 * `metadata.version` line of SKILL.md.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { SKILL_DEFAULT_IGNORES, SKILL_LIMITS, SKILL_NAME_MAX, SKILL_NAME_RE } from "@oh-my-pi/pi-wire/skillshare";
import { validateAgentSkillFrontmatter } from "../discovery/agent-plugin-format";
import { CREDENTIAL_PATTERNS } from "../secrets/patterns";
import { type TarEntry, writeTar } from "./tar";

export interface PackedFile {
	path: string;
	size: number;
	executable: boolean;
}

export interface SecretFinding {
	path: string;
	/** 1-based line of the match start. */
	line: number;
	/** Credential pattern name, e.g. `AWSAccessKey`, `PrivateKey`. */
	kind: string;
}

export interface PackResult {
	/** The scope is the publisher's; a pack never carries one. */
	scope?: undefined;
	name: string;
	version: string;
	description: string;
	files: PackedFile[];
	/** Owns a plain `ArrayBuffer` so it feeds `Bun.gunzipSync`/`fetch` bodies directly. */
	tgz: Uint8Array<ArrayBuffer>;
	integrity: string;
	/** Ships executables or anything under `scripts/`. */
	hasScripts: boolean;
	secrets: SecretFinding[];
}

/** Strict SemVer 2.0.0 (semver.org regex). */
export const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const SKILL_FILE = "SKILL.md";
const IGNORE_FILE = ".skillignore";
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// SKILL.md
// ---------------------------------------------------------------------------

async function readSkillFile(dir: string): Promise<string> {
	try {
		return await Bun.file(path.join(dir, SKILL_FILE)).text();
	} catch (error) {
		if (isEnoent(error)) throw new Error(`no ${SKILL_FILE} in ${dir}`);
		throw error;
	}
}

function parseSkillFrontmatter(text: string, source: string): Record<string, unknown> {
	try {
		return parseFrontmatter(text, { source, level: "fatal", repair: false, rawKeys: true }).frontmatter;
	} catch (error) {
		throw new Error(
			`${SKILL_FILE}: malformed YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

interface RegistryFrontmatter {
	name: string;
	version: string;
	description: string;
}

/** Agent Skills spec validation plus the registry's stricter rules (see `@oh-my-pi/pi-wire/skillshare`). */
function validateRegistryFrontmatter(frontmatter: Record<string, unknown>): RegistryFrontmatter {
	const rawName = typeof frontmatter.name === "string" ? frontmatter.name : "";
	// The package id comes from `name`, not the checkout directory (CI clones
	// into the repository name), so the spec's directory match is checked
	// against the name itself.
	const violation = validateAgentSkillFrontmatter(frontmatter, rawName.trim());
	if (violation !== null) throw new Error(`${SKILL_FILE}: ${violation}`);
	if (!SKILL_NAME_RE.test(rawName) || rawName.length > SKILL_NAME_MAX) {
		throw new Error(
			`${SKILL_FILE}: registry names must be ASCII kebab-case (a-z, 0-9, single hyphens), at most ${SKILL_NAME_MAX} characters; got ${JSON.stringify(rawName)}`,
		);
	}
	const description = frontmatter.description as string;
	if (description.length > SKILL_LIMITS.descriptionLength) {
		throw new Error(`${SKILL_FILE}: "description" exceeds ${SKILL_LIMITS.descriptionLength} characters`);
	}

	const metadata = (frontmatter.metadata ?? {}) as Record<string, string>;
	const version = metadata.version;
	if (version === undefined) {
		throw new Error(
			`${SKILL_FILE}: "metadata.version" is required to publish (set it with \`omp skill version patch\`)`,
		);
	}
	if (!SEMVER_RE.test(version)) {
		throw new Error(
			`${SKILL_FILE}: "metadata.version" must be a semantic version (x.y.z); got ${JSON.stringify(version)}`,
		);
	}

	if (metadata.keywords !== undefined) {
		const keywords = metadata.keywords
			.split(",")
			.map(keyword => keyword.trim())
			.filter(keyword => keyword.length > 0);
		if (keywords.length > SKILL_LIMITS.keywords) {
			throw new Error(`${SKILL_FILE}: "metadata.keywords" lists more than ${SKILL_LIMITS.keywords} keywords`);
		}
		for (const keyword of keywords) {
			if (keyword.length > SKILL_LIMITS.keywordLength) {
				throw new Error(
					`${SKILL_FILE}: keyword ${JSON.stringify(keyword)} exceeds ${SKILL_LIMITS.keywordLength} characters`,
				);
			}
		}
	}

	for (const key of ["repository", "homepage"] as const) {
		const value = metadata[key];
		if (value === undefined) continue;
		let url: URL | undefined;
		try {
			url = new URL(value);
		} catch {
			url = undefined;
		}
		if (url?.protocol !== "https:") {
			throw new Error(`${SKILL_FILE}: "metadata.${key}" must be an https URL; got ${JSON.stringify(value)}`);
		}
	}

	return { name: rawName, version, description };
}

// ---------------------------------------------------------------------------
// Ignore rules (gitignore subset)
// ---------------------------------------------------------------------------

interface IgnoreRule {
	regex: RegExp;
	negate: boolean;
	dirOnly: boolean;
	/** Contains a `/`: matched against the full relative path; otherwise against the basename. */
	anchored: boolean;
}

function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*" && (i === 0 || glob[i - 1] === "/")) {
				if (glob[i + 2] === "/") {
					source += "(?:.*/)?";
					i += 2;
					continue;
				}
				if (i + 2 === glob.length) {
					source += ".*";
					i += 1;
					continue;
				}
			}
			source += "[^/]*";
			while (glob[i + 1] === "*") i++;
		} else if (char === "?") {
			source += "[^/]";
		} else if (char === "[") {
			const close = glob.indexOf("]", i + 2);
			if (close === -1) {
				source += "\\[";
				continue;
			}
			let body = glob.slice(i + 1, close);
			if (body.startsWith("!")) body = `^${body.slice(1)}`;
			source += `[${body}]`;
			i = close;
		} else if (char === "\\" && i + 1 < glob.length) {
			i++;
			source += glob[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		} else {
			source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

/** Parse gitignore-style lines: `#` comments, `!` negation, trailing `/` = directories only, `/` anchors. */
export function parseIgnoreRules(lines: readonly string[]): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const raw of lines) {
		let line = raw.replace(/\r$/, "").replace(/(?<!\\)\s+$/, "");
		if (line === "" || line.startsWith("#")) continue;
		let negate = false;
		if (line.startsWith("!")) {
			negate = true;
			line = line.slice(1);
		} else if (line.startsWith("\\!") || line.startsWith("\\#")) {
			line = line.slice(1);
		}
		let dirOnly = false;
		while (line.endsWith("/")) {
			dirOnly = true;
			line = line.slice(0, -1);
		}
		if (line === "") continue;
		const anchored = line.includes("/");
		while (line.startsWith("/")) line = line.slice(1);
		rules.push({ regex: globToRegExp(line), negate, dirOnly, anchored });
	}
	return rules;
}

function isIgnored(rules: readonly IgnoreRule[], relPath: string, baseName: string, isDirectory: boolean): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.dirOnly && !isDirectory) continue;
		if (rule.regex.test(rule.anchored ? relPath : baseName)) ignored = !rule.negate;
	}
	return ignored;
}

async function loadIgnoreRules(dir: string): Promise<IgnoreRule[]> {
	let custom: string[] = [];
	try {
		custom = (await Bun.file(path.join(dir, IGNORE_FILE)).text()).split("\n");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return parseIgnoreRules([...SKILL_DEFAULT_IGNORES, ...custom]);
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

interface WalkedFile extends PackedFile {
	absolute: string;
}

interface WalkState {
	root: string;
	rules: IgnoreRule[];
	files: WalkedFile[];
	unpackedBytes: number;
}

async function walk(state: WalkState, relDir: string): Promise<void> {
	const absoluteDir = relDir ? path.join(state.root, relDir) : state.root;
	const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
		const isDirectory = entry.isDirectory();
		if (isIgnored(state.rules, relPath, entry.name, isDirectory)) continue;
		if (entry.isSymbolicLink()) {
			throw new Error(`symlinks are not allowed in skill packages: ${relPath}`);
		}
		if (isDirectory) {
			await walk(state, relPath);
			continue;
		}
		if (!entry.isFile()) throw new Error(`unsupported file type in skill package: ${relPath}`);
		if (entry.name.includes("\\")) throw new Error(`file names may not contain backslashes: ${relPath}`);
		if (encoder.encode(relPath).length > SKILL_LIMITS.pathLength) {
			throw new Error(`path exceeds ${SKILL_LIMITS.pathLength} bytes: ${relPath}`);
		}
		const absolute = path.join(absoluteDir, entry.name);
		const stat = await fs.lstat(absolute);
		state.files.push({ path: relPath, absolute, size: stat.size, executable: (stat.mode & 0o111) !== 0 });
		if (state.files.length > SKILL_LIMITS.files) {
			throw new Error(`skill package exceeds ${SKILL_LIMITS.files} files`);
		}
		state.unpackedBytes += stat.size;
		if (state.unpackedBytes > SKILL_LIMITS.unpackedBytes) {
			throw new Error(`skill package exceeds ${SKILL_LIMITS.unpackedBytes} bytes unpacked`);
		}
	}
}

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = CREDENTIAL_PATTERNS.map(pattern => ({
	kind: pattern.name,
	regex: new RegExp(pattern.source, pattern.flags?.includes("g") ? pattern.flags : `${pattern.flags ?? ""}g`),
}));

/** Report credential-shaped strings (vendor tokens, JWTs, private keys) in a text file. */
function scanSecrets(filePath: string, content: Uint8Array, findings: SecretFinding[]): void {
	if (content.subarray(0, 8000).includes(0)) return;
	const text = new TextDecoder().decode(content);
	const seen = new Set<string>();
	for (const { kind, regex } of SECRET_PATTERNS) {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			let line = 1;
			for (let i = text.indexOf("\n"); i !== -1 && i < match.index; i = text.indexOf("\n", i + 1)) line++;
			const key = `${line}:${kind}`;
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({ path: filePath, line, kind });
		}
	}
}

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

/** Validate and pack the skill at `dir` into a publishable `.tgz`. Throws with a user-facing message on any violation. */
export async function packSkill(dir: string): Promise<PackResult> {
	const root = path.resolve(dir);
	const text = await readSkillFile(root);
	const { name, version, description } = validateRegistryFrontmatter(
		parseSkillFrontmatter(text, path.join(root, SKILL_FILE)),
	);

	const state: WalkState = { root, rules: await loadIgnoreRules(root), files: [], unpackedBytes: 0 };
	await walk(state, "");
	if (!state.files.some(file => file.path === SKILL_FILE)) {
		throw new Error(`${SKILL_FILE} is excluded by ${IGNORE_FILE}; it must be part of the package`);
	}

	const entries: TarEntry[] = [];
	const secrets: SecretFinding[] = [];
	for (const file of state.files) {
		const content = await Bun.file(file.absolute).bytes();
		entries.push({ path: file.path, content, executable: file.executable });
		scanSecrets(file.path, content, secrets);
	}
	const tgz = Bun.gzipSync(writeTar(entries));
	if (tgz.length > SKILL_LIMITS.tarballBytes) {
		throw new Error(`skill package is ${tgz.length} bytes compressed; the limit is ${SKILL_LIMITS.tarballBytes}`);
	}

	const files = state.files
		.map(({ path: filePath, size, executable }) => ({ path: filePath, size, executable }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return {
		name,
		version,
		description,
		files,
		tgz,
		integrity: `sha512-${new Bun.CryptoHasher("sha512").update(tgz).digest("base64")}`,
		hasScripts: files.some(file => file.executable || file.path.startsWith("scripts/")),
		secrets,
	};
}

// ---------------------------------------------------------------------------
// Version bump
// ---------------------------------------------------------------------------

function nextVersion(current: string | undefined, kind: string): string {
	if (kind !== "patch" && kind !== "minor" && kind !== "major") {
		const explicit = kind.startsWith("v") ? kind.slice(1) : kind;
		if (!SEMVER_RE.test(explicit)) {
			throw new Error(`expected patch, minor, major, or a semantic version; got ${JSON.stringify(kind)}`);
		}
		if (current !== undefined && SEMVER_RE.test(current) && Bun.semver.order(explicit, current) <= 0) {
			throw new Error(`new version ${explicit} must be greater than the current ${current}`);
		}
		return explicit;
	}
	if (current === undefined) return kind === "patch" ? "0.0.1" : kind === "minor" ? "0.1.0" : "1.0.0";
	const match = SEMVER_RE.exec(current);
	if (!match) throw new Error(`current "metadata.version" is not a semantic version: ${JSON.stringify(current)}`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	const prerelease = match[4] !== undefined;
	// npm semantics: a prerelease bumps to its own release when the bumped field is the highest non-zero one.
	if (kind === "major") return prerelease && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
	if (kind === "minor") return prerelease && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
	return prerelease ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
}

interface FrontmatterLine {
	start: number;
	/** Line text without its `\n` / `\r\n`. */
	text: string;
	/** Offset of the following line. */
	next: number;
}

/**
 * Set `metadata.version` in `<dir>/SKILL.md` to the bumped (`patch`/`minor`/
 * `major`) or explicit version and return it. Only the `version:` line inside
 * the frontmatter `metadata:` block changes (it is inserted, with a `metadata:`
 * block if needed); every other byte is preserved.
 */
export async function bumpVersion(dir: string, kind: "patch" | "minor" | "major" | string): Promise<string> {
	const root = path.resolve(dir);
	const skillPath = path.join(root, SKILL_FILE);
	const text = await readSkillFile(root);
	const open = /^---\r?\n/.exec(text);
	if (!open) throw new Error(`${SKILL_FILE} has no YAML frontmatter`);
	const eol = open[0].endsWith("\r\n") ? "\r\n" : "\n";

	const lines: FrontmatterLine[] = [];
	let closeStart = -1;
	for (let pos = open[0].length; pos < text.length;) {
		const newline = text.indexOf("\n", pos);
		const end = newline === -1 ? text.length : newline;
		const lineText = text.slice(pos, end).replace(/\r$/, "");
		if (lineText === "---") {
			closeStart = pos;
			break;
		}
		const next = newline === -1 ? text.length : newline + 1;
		lines.push({ start: pos, text: lineText, next });
		pos = next;
	}
	if (closeStart === -1) throw new Error(`${SKILL_FILE}: unterminated YAML frontmatter`);

	const frontmatter = parseSkillFrontmatter(text, skillPath);
	const metadata = frontmatter.metadata;
	if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
		throw new Error(`${SKILL_FILE}: "metadata" must be a map`);
	}
	const currentRaw = (metadata as Record<string, unknown> | undefined)?.version;
	if (currentRaw !== undefined && typeof currentRaw !== "string") {
		throw new Error(`${SKILL_FILE}: "metadata.version" must be a string`);
	}
	const version = nextVersion(currentRaw, kind);

	let updated: string;
	const metadataIndex = lines.findIndex(line => /^metadata\s*:/.test(line.text));
	if (metadataIndex === -1) {
		updated = `${text.slice(0, closeStart)}metadata:${eol}  version: ${version}${eol}${text.slice(closeStart)}`;
	} else {
		const metadataLine = lines[metadataIndex];
		const inline = metadataLine.text.slice(metadataLine.text.indexOf(":") + 1).trim();
		if (inline !== "" && !inline.startsWith("#")) {
			throw new Error(`${SKILL_FILE}: "metadata" must be a block mapping to set its version`);
		}
		let childIndent: string | undefined;
		let versionLine: FrontmatterLine | undefined;
		for (let i = metadataIndex + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.text.trim() === "") continue;
			const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
			if (indent === "") break;
			childIndent ??= indent;
			if (indent === childIndent && /^version\s*:/.test(line.text.slice(indent.length))) {
				versionLine = line;
				break;
			}
		}
		if (versionLine) {
			const indent = childIndent ?? "";
			const match = /^(version\s*:\s*)(["']?)(.*?)\2(\s*(?:#.*)?)$/.exec(versionLine.text.slice(indent.length));
			if (!match) throw new Error(`${SKILL_FILE}: cannot parse the "metadata.version" line`);
			const replacement = `${indent}${match[1]}${match[2]}${version}${match[2]}${match[4]}`;
			updated =
				text.slice(0, versionLine.start) + replacement + text.slice(versionLine.start + versionLine.text.length);
		} else {
			const insertion = `${childIndent ?? "  "}version: ${version}${eol}`;
			updated = text.slice(0, metadataLine.next) + insertion + text.slice(metadataLine.next);
		}
	}

	const check = parseSkillFrontmatter(updated, skillPath).metadata as Record<string, unknown> | undefined;
	if (check?.version !== version) {
		throw new Error(`${SKILL_FILE}: could not rewrite "metadata.version" (unexpected frontmatter layout)`);
	}
	await Bun.write(skillPath, updated);
	return version;
}
