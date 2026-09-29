import * as fs from "node:fs";
import * as path from "node:path";
import {
	getProjectDir,
	getProjectPromptsDir,
	getPromptsDir,
	logger,
	parseFrontmatter,
	prompt,
} from "@oh-my-pi/pi-utils";
import { jtdToTypeScript } from "../tools/jtd-to-typescript";
import { parseCommandArgs, substituteArgs } from "../utils/command-args";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "(user)", "(project)", "(project:frontend)"
}

prompt.registerHelper("jtdToTypeScript", (schema: unknown): string => {
	try {
		return jtdToTypeScript(schema);
	} catch {
		return "unknown";
	}
});

/**
 * Render a subagent output schema inside the `yield` tool's `{ data: … }`
 * argument shape so the model sees the exact call it must make, not just the
 * user-facing payload. Without this the LLM pattern-matches on the bare
 * interface and puts schema fields at the top level of the call, tripping
 * schema validation repeatedly.
 */
prompt.registerHelper("renderYieldSchema", (schema: unknown): string => {
	let ts: string;
	try {
		ts = jtdToTypeScript(schema);
	} catch {
		ts = "unknown";
	}
	const lines = ts.split("\n");
	const [first, ...rest] = lines;
	const body = rest.length === 0 ? first : `${first}\n${rest.map(l => `  ${l}`).join("\n")}`;
	return `{\n  data: ${body};\n}`;
});

const INLINE_ARG_SHELL_PATTERN = /\$(?:ARGUMENTS|@(?:\[\d+(?::\d*)?\])?|\d+)/;
const INLINE_ARG_TEMPLATE_PATTERN = /\{\{[\s\S]*?(?:\b(?:arguments|ARGUMENTS|args)\b|\barg\s+[^}]+)[\s\S]*?\}\}/;

/**
 * Keep the check source-level and cheap: if the template text contains any explicit
 * inline-arg placeholder syntax, do not append the fallback text again.
 */
export function templateUsesInlineArgPlaceholders(templateSource: string): boolean {
	return INLINE_ARG_SHELL_PATTERN.test(templateSource) || INLINE_ARG_TEMPLATE_PATTERN.test(templateSource);
}

export function appendInlineArgsFallback(
	rendered: string,
	argsText: string,
	usesInlineArgPlaceholders: boolean,
): string {
	if (argsText.length === 0 || usesInlineArgPlaceholders) return rendered;
	if (rendered.length === 0) return argsText;

	return `${rendered}\n\n${argsText}`;
}

type PromptTemplateSource = "user" | "project" | "extension";

/** Parse one markdown file into a prompt template named after the file. */
async function loadTemplateFile(fullPath: string, sourceStr: string): Promise<PromptTemplate> {
	const rawContent = await Bun.file(fullPath).text();
	const { frontmatter, body } = parseFrontmatter(rawContent, { source: fullPath });

	// Get description from frontmatter or first non-empty line
	let description = String(frontmatter.description || "");
	if (!description) {
		const firstLine = body.split("\n").find(line => line.trim());
		if (firstLine) {
			// Truncate if too long
			description = firstLine.slice(0, 60);
			if (firstLine.length > 60) description += "...";
		}
	}

	// Append source to description
	description = description ? `${description} ${sourceStr}` : sourceStr;

	return {
		name: path.basename(fullPath).slice(0, -3), // Remove .md extension
		description,
		content: body,
		source: sourceStr,
	};
}

/**
 * Recursively scan a directory for .md files (and symlinks to .md files) and load them as prompt templates.
 * Read/scan failures go to `onError` when given, otherwise to the log.
 */
async function loadTemplatesFromDir(
	dir: string,
	source: PromptTemplateSource,
	subdir: string = "",
	onError?: (message: string) => void,
): Promise<PromptTemplate[]> {
	const templates: PromptTemplate[] = [];
	try {
		const glob = new Bun.Glob("**/*");
		const entries = [];
		for await (const entry of glob.scan({ cwd: dir, absolute: false, onlyFiles: false })) {
			entries.push(entry);
		}

		// Group by path depth to process directories before deeply nested files
		entries.sort((a, b) => a.split("/").length - b.split("/").length);

		for (const entry of entries) {
			const fullPath = path.join(dir, entry);

			try {
				if (!entry.endsWith(".md") || !(await Bun.file(fullPath).exists())) continue;

				// Build source string based on subdirectory structure
				const entryDir = entry.includes("/") ? entry.split("/").slice(0, -1).join(":") : "";
				const fullSubdir = subdir && entryDir ? `${subdir}:${entryDir}` : entryDir || subdir;
				const sourceStr = fullSubdir ? `(${source}:${fullSubdir})` : `(${source})`;

				templates.push(await loadTemplateFile(fullPath, sourceStr));
			} catch (error) {
				if (onError) onError(`Failed to load prompt template ${fullPath}: ${String(error)}`);
				else logger.warn("Failed to load prompt template", { path: fullPath, error: String(error) });
			}
		}
	} catch (error) {
		if (!fs.existsSync(dir)) {
			return [];
		}
		if (onError) onError(`Failed to scan prompt templates directory ${dir}: ${String(error)}`);
		else logger.warn("Failed to scan prompt templates directory", { dir, error: String(error) });
	}

	return templates;
}

/** A prompt-template read/scan failure under one contributed path. */
export interface PromptTemplatePathError {
	/** The contributed path (as passed in) whose scan produced the failure. */
	path: string;
	message: string;
}

/**
 * Load extension-contributed prompt templates (`resources_discover` `promptPaths`).
 * Each path is an absolute directory (scanned recursively like `prompts/`) or a
 * single `.md` file, told apart by its stat; templates carry the `(extension)` source
 * label. Unreadable entries are skipped and returned as errors keyed by the
 * contributed path so callers can attribute them.
 */
export async function loadPromptTemplatesFromPaths(
	paths: readonly string[],
): Promise<{ templates: PromptTemplate[]; errors: PromptTemplatePathError[] }> {
	const templates: PromptTemplate[] = [];
	const errors: PromptTemplatePathError[] = [];
	for (const templatePath of paths) {
		const report = (message: string) => errors.push({ path: templatePath, message });
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(templatePath);
		} catch (error) {
			report(`Cannot read prompt path ${templatePath}: ${String(error)}`);
			continue;
		}
		if (stat.isDirectory()) {
			templates.push(...(await loadTemplatesFromDir(templatePath, "extension", "", report)));
			continue;
		}
		if (!stat.isFile() || !templatePath.toLowerCase().endsWith(".md")) {
			report(`Ignoring prompt path ${templatePath}: expected a directory or a .md file`);
			continue;
		}
		try {
			templates.push(await loadTemplateFile(templatePath, "(extension)"));
		} catch (error) {
			report(`Failed to load prompt template ${templatePath}: ${String(error)}`);
		}
	}
	return { templates, errors };
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory for global templates. Default: from getPromptsDir() */
	agentDir?: string;
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/.omp/prompts/
 */
export async function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): Promise<PromptTemplate[]> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();

	const templates: PromptTemplate[] = [];

	// 1. Load global templates from agentDir/prompts/
	// Note: if agentDir is provided, it should be the agent dir, not the prompts dir
	const globalPromptsDir = options.agentDir ? path.join(options.agentDir, "prompts") : resolvedAgentDir;
	templates.push(...(await loadTemplatesFromDir(globalPromptsDir, "user")));

	// 2. Load project templates from cwd/.omp/prompts/
	const projectPromptsDir = getProjectPromptsDir(resolvedCwd);
	templates.push(...(await loadTemplatesFromDir(projectPromptsDir, "project")));

	return templates;
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const template = templates.find(t => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		const argsText = args.join(" ");
		const usesInlineArgPlaceholders = templateUsesInlineArgPlaceholders(template.content);
		const substituted = substituteArgs(template.content, args);
		const rendered = prompt.render(substituted, { args, ARGUMENTS: argsText, arguments: argsText });
		return appendInlineArgsFallback(rendered, argsText, usesInlineArgPlaceholders);
	}

	return text;
}
