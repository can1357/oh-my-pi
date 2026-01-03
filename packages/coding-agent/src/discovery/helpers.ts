/**
 * Shared helpers for discovery providers.
 */

import { join, resolve } from "node:path";
import { parse as parseYAML } from "yaml";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

/**
 * Standard paths for each config source.
 */
export const SOURCE_PATHS = {
	native: {
		userBase: ".omp",
		userAgent: ".omp/agent",
		projectDir: ".omp",
		aliases: [".pi"], // .pi is an alias for backwards compat
	},
	claude: {
		userBase: ".claude",
		userAgent: ".claude",
		projectDir: ".claude",
	},
	codex: {
		userBase: ".codex",
		userAgent: ".codex",
		projectDir: ".codex",
	},
	gemini: {
		userBase: ".gemini",
		userAgent: ".gemini",
		projectDir: ".gemini",
	},
	cursor: {
		userBase: ".cursor",
		userAgent: ".cursor",
		projectDir: ".cursor",
	},
	windsurf: {
		userBase: ".codeium/windsurf",
		userAgent: ".codeium/windsurf",
		projectDir: ".windsurf",
	},
	cline: {
		userBase: ".cline",
		userAgent: ".cline",
		projectDir: null, // Cline uses root-level .clinerules
	},
	github: {
		userBase: null,
		userAgent: null,
		projectDir: ".github",
	},
	vscode: {
		userBase: ".vscode",
		userAgent: ".vscode",
		projectDir: ".vscode",
	},
} as const;

export type SourceId = keyof typeof SOURCE_PATHS;

/**
 * Get user-level path for a source.
 */
export function getUserPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	const paths = SOURCE_PATHS[source];
	if (!paths.userAgent) return null;
	return join(ctx.home, paths.userAgent, subpath);
}

/**
 * Get project-level path for a source (walks up from cwd).
 */
export function getProjectPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	const paths = SOURCE_PATHS[source];
	if (!paths.projectDir) return null;

	const found = ctx.fs.walkUp(paths.projectDir, { dir: true });
	if (!found) return null;

	return join(found, subpath);
}

/**
 * Create source metadata for an item.
 */
export function createSourceMeta(provider: string, path: string, level: "user" | "project"): SourceMeta {
	return {
		provider,
		providerName: "", // Filled in by registry
		path: resolve(path),
		level,
	};
}

/**
 * Strip YAML frontmatter from content.
 * Returns { frontmatter, body, raw }
 */
export function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
	raw: string;
} {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter: {}, body: normalized, raw: "" };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: normalized, raw: "" };
	}

	const raw = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	try {
		const frontmatter = parseYAML(raw) as Record<string, unknown> | null;
		return { frontmatter: frontmatter ?? {}, body, raw };
	} catch {
		// Fallback to empty frontmatter on parse error
		return { frontmatter: {}, body, raw };
	}
}

/**
 * Expand environment variables in a string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
export function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
	return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, varName: string, defaultValue?: string) => {
		const envValue = extraEnv?.[varName] ?? process.env[varName];
		if (envValue !== undefined) return envValue;
		if (defaultValue !== undefined) return defaultValue;
		return `\${${varName}}`;
	});
}

/**
 * Recursively expand environment variables in an object.
 */
export function expandEnvVarsDeep<T>(obj: T, extraEnv?: Record<string, string>): T {
	if (typeof obj === "string") {
		return expandEnvVars(obj, extraEnv) as T;
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => expandEnvVarsDeep(item, extraEnv)) as T;
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expandEnvVarsDeep(value, extraEnv);
		}
		return result as T;
	}
	return obj;
}

/**
 * Load files from a directory matching a pattern.
 */
export function loadFilesFromDir<T>(
	ctx: LoadContext,
	dir: string,
	provider: string,
	level: "user" | "project",
	options: {
		/** File extensions to match (without dot) */
		extensions?: string[];
		/** Transform file to item (return null to skip) */
		transform: (name: string, content: string, path: string, source: SourceMeta) => T | null;
		/** Whether to recurse into subdirectories */
		recursive?: boolean;
	},
): LoadResult<T> {
	const items: T[] = [];
	const warnings: string[] = [];

	if (!ctx.fs.isDir(dir)) {
		return { items, warnings };
	}

	const files = ctx.fs.readDir(dir);

	for (const name of files) {
		if (name.startsWith(".")) continue;

		const path = join(dir, name);

		if (options.recursive && ctx.fs.isDir(path)) {
			const subResult = loadFilesFromDir(ctx, path, provider, level, options);
			items.push(...subResult.items);
			if (subResult.warnings) warnings.push(...subResult.warnings);
			continue;
		}

		if (!ctx.fs.isFile(path)) continue;

		// Check extension
		if (options.extensions) {
			const hasMatch = options.extensions.some((ext) => name.endsWith(`.${ext}`));
			if (!hasMatch) continue;
		}

		const content = ctx.fs.readFile(path);
		if (content === null) {
			warnings.push(`Failed to read file: ${path}`);
			continue;
		}

		const source = createSourceMeta(provider, path, level);

		try {
			const item = options.transform(name, content, path, source);
			if (item !== null) {
				items.push(item);
			}
		} catch (err) {
			warnings.push(`Failed to parse ${path}: ${err}`);
		}
	}

	return { items, warnings };
}

/**
 * Parse JSON safely.
 */
export function parseJSON<T>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Calculate depth of target directory relative to current working directory.
 * Depth is the number of directory levels from cwd to target.
 * - Positive depth: target is above cwd (parent/ancestor)
 * - Zero depth: target is cwd
 * - This uses path splitting to count directory levels
 */
export function calculateDepth(cwd: string, targetDir: string, separator: string): number {
	return cwd.split(separator).length - targetDir.split(separator).length;
}
