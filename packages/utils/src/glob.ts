import * as path from "node:path";
import { Glob } from "bun";
import { getProjectDir } from "./dirs";

export interface GlobPathsOptions {
	/** Base directory for glob patterns. Defaults to getProjectDir(). */
	cwd?: string;
	/** Glob exclusion patterns. */
	exclude?: string[];
	/** Abort signal to cancel the glob. */
	signal?: AbortSignal;
	/** Timeout in milliseconds for the glob operation. */
	timeoutMs?: number;
	/** Include dotfiles when true. */
	dot?: boolean;
	/** Only return files (skip directories). Default: true. */
	onlyFiles?: boolean;
	/** Respect .gitignore files when true. Walks up directory tree to find all applicable .gitignore files. */
	gitignore?: boolean;
}

/** Patterns always excluded (.git is never useful in glob results). */
const ALWAYS_IGNORED = ["**/.git", "**/.git/**"];

/** node_modules exclusion patterns (skipped if pattern explicitly references node_modules). */
const NODE_MODULES_IGNORED = ["**/node_modules", "**/node_modules/**"];

/**
 * Parse a single .gitignore file and return glob-compatible exclude patterns.
 * @param content - Raw content of the .gitignore file
 * @param gitignoreDir - Absolute path to the directory containing the .gitignore
 * @param baseDir - Absolute path to the glob's cwd (for relativizing rooted patterns)
 */
function parseGitignorePatterns(content: string, gitignoreDir: string, baseDir: string): string[] {
	const patterns: string[] = [];

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		// Skip empty lines and comments
		if (!line || line.startsWith("#")) {
			continue;
		}
		// Skip negation patterns (unsupported for simple exclude)
		if (line.startsWith("!")) {
			continue;
		}

		let pattern = line;

		// Handle trailing slash (directory-only match)
		// For glob exclude, we treat it as matching the dir and its contents
		const isDirectoryOnly = pattern.endsWith("/");
		if (isDirectoryOnly) {
			pattern = pattern.slice(0, -1);
		}

		// Handle rooted patterns (start with /)
		if (pattern.startsWith("/")) {
			// Rooted pattern: relative to the .gitignore location
			const absolutePattern = path.join(gitignoreDir, pattern.slice(1));
			const relativeToBase = path.relative(baseDir, absolutePattern);
			if (relativeToBase.startsWith("..")) {
				// Pattern is outside the search directory, skip
				continue;
			}
			pattern = relativeToBase.replace(/\\/g, "/");
			if (isDirectoryOnly) {
				patterns.push(pattern);
				patterns.push(`${pattern}/**`);
			} else {
				patterns.push(pattern);
			}
		} else {
			// Unrooted pattern: match anywhere in the tree
			if (pattern.includes("/")) {
				// Contains slash: match from any directory level
				patterns.push(`**/${pattern}`);
				if (isDirectoryOnly) {
					patterns.push(`**/${pattern}/**`);
				}
			} else {
				// No slash: match file/dir name anywhere
				patterns.push(`**/${pattern}`);
				if (isDirectoryOnly) {
					patterns.push(`**/${pattern}/**`);
				}
			}
		}
	}

	return patterns;
}

/**
 * Load .gitignore patterns from a directory and its parents.
 * Walks up the directory tree to find all applicable .gitignore files.
 * Returns glob-compatible exclude patterns.
 */
export async function loadGitignorePatterns(baseDir: string): Promise<string[]> {
	const patterns: string[] = [];
	const absoluteBase = path.resolve(baseDir);

	let current = absoluteBase;
	const maxDepth = 50; // Prevent infinite loops

	for (let i = 0; i < maxDepth; i++) {
		const gitignorePath = path.join(current, ".gitignore");

		try {
			const content = await Bun.file(gitignorePath).text();
			const filePatterns = parseGitignorePatterns(content, current, absoluteBase);
			patterns.push(...filePatterns);
		} catch {
			// .gitignore doesn't exist or can't be read, continue
		}

		const parent = path.dirname(current);
		if (parent === current) {
			// Reached filesystem root
			break;
		}
		current = parent;
	}

	return patterns;
}

/**
 * Resolve filesystem paths matching glob patterns with optional exclude filters.
 * Returns paths relative to the provided cwd (or getProjectDir()).
 * Errors and abort/timeouts are surfaced to the caller.
 */
export async function globPaths(patterns: string | string[], options: GlobPathsOptions = {}): Promise<string[]> {
	const { cwd, exclude, signal, timeoutMs, dot, onlyFiles = true, gitignore } = options;

	// Build exclude list: always exclude .git, exclude node_modules unless pattern references it
	const patternArray = Array.isArray(patterns) ? patterns : [patterns];
	const mentionsNodeModules = patternArray.some(p => p.includes("node_modules"));

	const baseExclude = mentionsNodeModules ? [...ALWAYS_IGNORED] : [...ALWAYS_IGNORED, ...NODE_MODULES_IGNORED];
	let effectiveExclude = exclude ? [...baseExclude, ...exclude] : baseExclude;

	if (gitignore) {
		const gitignorePatterns = await loadGitignorePatterns(cwd ?? getProjectDir());
		effectiveExclude = [...effectiveExclude, ...gitignorePatterns];
	}

	const base = cwd ?? getProjectDir();
	const allResults: string[] = [];

	// Combine timeout and abort signals
	const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
	const combinedSignal =
		signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);

	for (const pattern of patternArray) {
		const glob = new Glob(pattern);
		const scanOptions = {
			cwd: base,
			dot,
			onlyFiles,
			throwErrorOnBrokenSymlink: false,
		};

		for await (const entry of glob.scan(scanOptions)) {
			if (combinedSignal?.aborted) {
				const reason = combinedSignal.reason;
				if (reason instanceof Error) throw reason;
				throw new DOMException("Aborted", "AbortError");
			}

			// Check exclusion patterns
			const normalized = entry.replace(/\\/g, "/");
			let excluded = false;
			for (const excludePattern of effectiveExclude) {
				const excludeGlob = new Glob(excludePattern);
				if (excludeGlob.match(normalized)) {
					excluded = true;
					break;
				}
			}
			if (!excluded) {
				allResults.push(normalized);
			}
		}
	}

	return allResults;
}
