import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { CommitAgentState } from "../../../commit/agentic/state";
import type { CustomTool } from "../../../extensibility/custom-tools/types";

const TARGET_TOKENS = 30000;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const TRUNCATE_THRESHOLD_LINES = 30;
const KEEP_HEAD_LINES = 15;
const KEEP_TAIL_LINES = 10;

const HIGH_PRIORITY_EXTENSIONS = new Set([
	".rs",
	".go",
	".py",
	".js",
	".ts",
	".tsx",
	".jsx",
	".java",
	".c",
	".cpp",
	".h",
	".hpp",
]);
const SHELL_SQL_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".sql"]);
const MANIFEST_FILES = new Set([
	"Cargo.toml",
	"package.json",
	"go.mod",
	"pyproject.toml",
	"requirements.txt",
	"Gemfile",
	"build.gradle",
	"pom.xml",
]);
const LOW_PRIORITY_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv"]);
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".ico",
	".woff",
	".woff2",
	".ttf",
	".eot",
	".pdf",
	".zip",
	".tar",
	".gz",
	".exe",
	".dll",
	".so",
	".dylib",
]);
const TEST_PATTERNS = ["/test/", "/tests/", "/__tests__/", "_test.", ".test.", ".spec.", "_spec."];

export function getFilePriority(filename: string): number {
	const basename = filename.split("/").pop() ?? filename;
	const ext = basename.includes(".") ? `.${basename.split(".").pop()}` : "";

	if (BINARY_EXTENSIONS.has(ext)) return -100;

	const lowerPath = filename.toLowerCase();
	for (const pattern of TEST_PATTERNS) {
		if (lowerPath.includes(pattern)) return 10;
	}

	if (LOW_PRIORITY_EXTENSIONS.has(ext) && !MANIFEST_FILES.has(basename)) return 20;
	if (MANIFEST_FILES.has(basename)) return 70;
	if (SHELL_SQL_EXTENSIONS.has(ext)) return 80;
	if (HIGH_PRIORITY_EXTENSIONS.has(ext)) return 100;

	return 50;
}

function truncateDiffContent(diff: string): { content: string; truncated: boolean } {
	const lines = diff.split("\n");
	if (lines.length <= TRUNCATE_THRESHOLD_LINES) {
		return { content: diff, truncated: false };
	}

	const head = lines.slice(0, KEEP_HEAD_LINES);
	const tail = lines.slice(-KEEP_TAIL_LINES);
	const truncatedCount = lines.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;

	return {
		content: [...head, `\n[…${truncatedCount}ln elided…]\n`, ...tail].join("\n"),
		truncated: true,
	};
}

function processDiffs(files: string[], diffs: Map<string, string>): { result: string; truncatedFiles: string[] } {
	const sortedFiles = [...files].sort((a, b) => getFilePriority(b) - getFilePriority(a));

	const truncatedFiles: string[] = [];
	const parts: string[] = [];
	let totalChars = 0;

	for (const file of sortedFiles) {
		const diff = diffs.get(file);
		if (!diff) continue;

		const remaining = MAX_CHARS - totalChars;
		if (remaining <= 0) {
			truncatedFiles.push(file);
			continue;
		}

		let content = diff;
		if (content.length > remaining || content.split("\n").length > TRUNCATE_THRESHOLD_LINES) {
			const { content: truncated, truncated: wasTruncated } = truncateDiffContent(content);
			if (wasTruncated) {
				truncatedFiles.push(file);
			}
			content = truncated;
			if (content.length > remaining) {
				content = `${content.slice(0, remaining)}\n[…${content.length - remaining}ch elided…]`;
				if (!truncatedFiles.includes(file)) {
					truncatedFiles.push(file);
				}
			}
		}

		parts.push(`=== ${file} ===\n${content}`);
		totalChars += content.length;
	}

	return { result: parts.join("\n\n"), truncatedFiles };
}

const gitFileDiffSchema = type({
	files: type("string").describe("file to diff").array().atLeastLength(1).atMostLength(10),
	"staged?": type("boolean").describe("use staged changes (default true)"),
});

export function createGitFileDiffTool(cwd: string, state: CommitAgentState): CustomTool<typeof gitFileDiffSchema> {
	const repo = vcs.requireGit(cwd);
	return {
		name: "git_file_diff",
		label: "Git File Diff",
		description: "Return the diff for specific files.",
		parameters: gitFileDiffSchema,
		async execute(_toolCallId, params) {
			const staged = params.staged ?? true;
			const cacheKey = (file: string) => `${file}:${staged}`;

			if (!state.diffCache) {
				state.diffCache = new Map();
			}

			const diffs = new Map<string, string>();
			const uncachedFiles: string[] = [];

			for (const file of params.files) {
				const cached = state.diffCache.get(cacheKey(file));
				if (cached !== undefined) {
					diffs.set(file, cached);
				} else {
					uncachedFiles.push(file);
				}
			}

			if (uncachedFiles.length > 0) {
				for (const file of uncachedFiles) {
					const diff = await repo.diffText({ cached: staged, files: [file] });
					if (diff) {
						diffs.set(file, diff);
						state.diffCache.set(cacheKey(file), diff);
					} else {
						state.diffCache.set(cacheKey(file), "");
					}
				}
			}

			const { result, truncatedFiles } = processDiffs(params.files, diffs);
			const output = result || "(no diff)";

			return {
				content: [{ type: "text", text: output }],
				details: {
					files: params.files,
					staged,
					truncatedFiles: truncatedFiles.length > 0 ? truncatedFiles : undefined,
					cacheHits: params.files.length - uncachedFiles.length,
				},
			};
		},
	};
}
