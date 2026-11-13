import { getProjectPromptsDir, getPromptsDir, isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { sanitizeDisplayText } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { type PromptTemplate, promptTemplateCommandName, templateUsesInlineArgPlaceholders } from "./prompt-templates";

/** Where a snippet file lives: the user's agent dir (global) or the project's `.omp/prompts`. */
export type SnippetScope = "user" | "project";

/** Letter, then letters/digits/_/-. Doubles as the path-traversal guard. */
const SNIPPET_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;
export const NO_SNIPPETS_MESSAGE = "No snippets saved. Use /snippets save <name> [text] to create one.";
export const SNIPPETS_USAGE =
	"Usage: /snippets [save <name> [--scope user|project] [--force] [text] | delete <name> [--scope user|project]]";

const SAVE_USAGE = "Usage: /snippets save <name> [--scope user|project] [--force] [text]";
const DELETE_USAGE = "Usage: /snippets delete <name> [--scope user|project]";
const SCOPE_ERROR = "--scope must be user or project";

function invalidNameError(name: string): { error: string } | undefined {
	return SNIPPET_NAME_PATTERN.test(name)
		? undefined
		: { error: `Invalid snippet name "${name}": use a letter, then letters, digits, - or _` };
}

/**
 * Prompts directory a snippet scope writes to. `agentDir` is the session's configured agent
 * directory (not the process default), so a profile-scoped session saves where it loads from.
 */
export function snippetsDir(scope: SnippetScope, cwd: string, agentDir: string): string {
	return scope === "user" ? getPromptsDir(agentDir) : getProjectPromptsDir(cwd);
}

/** `<dir>/<name>.md`; throws on a name that is not a plain identifier, so it cannot escape `dir`. */
export function snippetPath(dir: string, name: string): string {
	if (!SNIPPET_NAME_PATTERN.test(name)) throw new Error(`Invalid snippet name "${name}"`);
	return path.join(dir, `${name}.md`);
}

/** Parsed `/snippets save` arguments, or the usage/validation error to show. */
export type SaveArgs = { name: string; scope: SnippetScope; force: boolean; text: string } | { error: string };

/**
 * Parse the text after `/snippets save`: `<name> [--scope user|project] [--force] [text]`. Options are
 * consumed by index so the remaining text keeps its newlines; the first non-option token starts the text.
 */
export function parseSaveArgs(rest: string): SaveArgs {
	const tokenPattern = /\s*(\S+)/y;
	let position = 0;
	const next = (): string | undefined => {
		tokenPattern.lastIndex = position;
		const match = tokenPattern.exec(rest);
		if (!match) return undefined;
		position = tokenPattern.lastIndex;
		return match[1];
	};

	const name = next();
	if (!name) return { error: SAVE_USAGE };
	const invalid = invalidNameError(name);
	if (invalid) return invalid;

	let scope: SnippetScope = "user";
	let force = false;
	for (;;) {
		const before = position;
		const token = next();
		if (token === "--force") {
			force = true;
		} else if (token === "--scope") {
			const value = next();
			if (value !== "user" && value !== "project") return { error: SCOPE_ERROR };
			scope = value;
		} else {
			position = before;
			break;
		}
	}
	return { name, scope, force, text: rest.slice(position).trim() };
}

/** Parsed `/snippets delete` arguments, or the usage/validation error to show. `scope` is unset when omitted. */
export type DeleteArgs = { name: string; scope?: SnippetScope } | { error: string };

/** Parse the text after `/snippets delete`: `<name> [--scope user|project]`. */
export function parseDeleteArgs(rest: string): DeleteArgs {
	const tokens = rest.split(/\s+/).filter(Boolean);
	const name = tokens[0];
	if (!name) return { error: DELETE_USAGE };
	const invalid = invalidNameError(name);
	if (invalid) return invalid;

	let scope: SnippetScope | undefined;
	for (let i = 1; i < tokens.length;) {
		const token = tokens[i]!;
		if (token !== "--scope") return { error: `Unknown option: ${token}` };
		const value = tokens[i + 1];
		if (value !== "user" && value !== "project") return { error: SCOPE_ERROR };
		scope = value;
		i += 2;
	}
	return scope ? { name, scope } : { name };
}

/** Text to save: the inline text when given, else the last of `userMessages`; `undefined` when both are blank. */
export function resolveSnippetText(inline: string, userMessages: ReadonlyArray<{ text: string }>): string | undefined {
	const trimmed = inline.trim();
	if (trimmed) return trimmed;
	return userMessages.at(-1)?.text.trim() || undefined;
}

function deriveDescription(text: string): string {
	const firstLine = text.split("\n").find(line => line.trim()) ?? "";
	return truncateToWidth(firstLine.replace(/\s+/g, " ").trim(), TRUNCATE_LENGTHS.CONTENT);
}

/** `exists` means the file was already there and `force` was not set; nothing was written. */
export type SaveResult = { kind: "saved"; path: string } | { kind: "exists"; path: string };

/**
 * Write `text` as `<dir>/<name>.md` prompt-template file. Without `force` an existing entry (including a
 * symlink) is never touched. With `force` the entry is replaced by renaming a temp file over it, so a
 * symlinked snippet is swapped out rather than followed and its target left alone.
 */
export async function saveSnippet(options: {
	dir: string;
	name: string;
	text: string;
	force: boolean;
}): Promise<SaveResult> {
	const file = snippetPath(options.dir, options.name);
	const body = options.text.trim();
	// Frontmatter is always written: a body that itself starts with `---` would otherwise be parsed as frontmatter.
	const content = `---\ndescription: ${JSON.stringify(deriveDescription(body))}\n---\n${body}\n`;
	await fs.mkdir(options.dir, { recursive: true });
	if (!options.force) {
		try {
			await fs.writeFile(file, content, { flag: "wx" });
		} catch (err) {
			if (isEexist(err)) return { kind: "exists", path: file };
			throw err;
		}
	} else {
		await writeFileAtomically(file, content, 0o666 & ~process.umask());
	}
	return { kind: "saved", path: file };
}

/** Delete `<dir>/<name>.md`; a symlink is removed itself, never its target. */
export async function deleteSnippet(dir: string, name: string): Promise<"deleted" | "missing"> {
	try {
		await fs.rm(snippetPath(dir, name));
		return "deleted";
	} catch (err) {
		if (isEnoent(err)) return "missing";
		throw err;
	}
}

/** Whether `<dir>/<name>.md` exists as a directory entry; a dangling symlink counts (`lstat`, not a followed stat). */
export async function snippetExists(dir: string, name: string): Promise<boolean> {
	try {
		await fs.lstat(snippetPath(dir, name));
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/** One picker row: `label` is what the picker returns, `description` its preview, `insertText` what goes in the editor. */
export interface SnippetChoice {
	label: string;
	description: string;
	insertText: string;
}

/** Where and how a picked snippet will be inserted, which decides whether its `/snippet:<name>` form is usable. */
export interface SnippetInsertContext {
	/** The cursor sits at the very start of the draft: the one place a slash command expands. */
	atDraftStart: boolean;
	/** Command tokens an extension, custom, or file command already owns; those run before a template does. */
	reservedCommands: ReadonlySet<string>;
}

export function buildSnippetChoices(
	templates: readonly PromptTemplate[],
	context: SnippetInsertContext,
): SnippetChoice[] {
	const counts = new Map<string, number>();
	for (const template of templates) counts.set(template.name, (counts.get(template.name) ?? 0) + 1);

	const sorted = [...templates].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
	// The picker returns only the label, so labels must stay unique even when different raw names clean up alike.
	const usedLabels = new Set<string>();
	return sorted.map(template => {
		const { content } = template;
		const name = sanitizeStatusText(template.name);
		const source = sanitizeStatusText(template.source);
		const duplicated = (counts.get(template.name) ?? 0) > 1;
		const commandName = promptTemplateCommandName(template);
		// A name the display cleanup altered, or one with whitespace, cannot be typed back as a command token.
		const invocation =
			context.atDraftStart &&
			!duplicated &&
			name === template.name &&
			/^\S+$/.test(name) &&
			// `findPromptTemplate` prefers an exact raw name, so a template literally named `snippet:<name>` would win.
			!counts.has(commandName) &&
			!context.reservedCommands.has(commandName) &&
			templateUsesInlineArgPlaceholders(content);
		const command = `/${commandName}`;
		const preview = truncateToWidth(sanitizeStatusText(content), TRUNCATE_LENGTHS.RECAP);
		const hint = invocation ? `takes arguments, inserts ${command} · ` : "";
		const baseLabel = duplicated ? `${name} ${source}` : name;
		let label = baseLabel;
		for (let n = 2; usedLabels.has(label); n++) label = `${baseLabel} (${n})`;
		usedLabels.add(label);
		return {
			label,
			description: `${source} · ${hint}${preview}`,
			// The editor's programmatic insert does not strip controls or tabs the way typing and paste do.
			insertText: invocation ? `${command} ` : sanitizeDisplayText(content),
		};
	});
}
