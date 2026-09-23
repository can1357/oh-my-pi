import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { parseDiffHunks } from "../../../commit/git/diff";
import type { DiffHunk, FileHunks } from "../../../commit/types";
import type { CustomTool } from "../../../extensibility/custom-tools/types";

const hunkIndexType = type("number").describe("1-based hunk index");

const gitHunkSchema = type({
	file: type("string").describe("file path"),
	"hunks?": hunkIndexType.array().atLeastLength(1),
	"staged?": type("boolean").describe("use staged changes (default true)"),
});

function selectHunks(fileHunks: FileHunks, requested?: number[]): DiffHunk[] {
	if (!requested || requested.length === 0) return fileHunks.hunks;
	const wanted = new Set(requested.map(value => Math.max(1, Math.floor(value))));
	return fileHunks.hunks.filter(hunk => wanted.has(hunk.index + 1));
}

export function createGitHunkTool(cwd: string): CustomTool<typeof gitHunkSchema> {
	const repo = vcs.requireGit(cwd);
	return {
		name: "git_hunk",
		label: "Git Hunk",
		description: "Return specific hunks from a file diff.",
		parameters: gitHunkSchema,
		async execute(_toolCallId, params) {
			const staged = params.staged ?? true;
			const hunks = parseDiffHunks(await repo.diffText({ cached: staged, files: [params.file] }));
			const fileHunks = hunks.find(entry => entry.filename === params.file) ?? {
				filename: params.file,
				isBinary: false,
				hunks: [],
			};
			if (fileHunks.isBinary) {
				return {
					content: [{ type: "text", text: "Binary file diff; no hunks available." }],
					details: { file: params.file, staged, hunks: [] },
				};
			}
			const selected = selectHunks(fileHunks, params.hunks);
			const text = selected.length ? selected.map(hunk => hunk.content).join("\n\n") : "(no matching hunks)";
			return {
				content: [{ type: "text", text }],
				details: {
					file: params.file,
					staged,
					hunks: selected,
				},
			};
		},
	};
}
