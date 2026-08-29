import { type } from "@oh-my-pi/omptype";
import type { VcsNumstatEntry } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { CommitAgentState, GitOverviewSnapshot } from "../../../commit/agentic/state";
import { DEFAULT_CONVENTIONAL_GENERATION_CONFIG } from "../../../commit/conventional/config";
import { extractScopeCandidates } from "../../../commit/conventional/scope";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { EXCLUDED_LOCK_FILES } from "../lock-files";

function isExcludedFile(path: string): boolean {
	const basename = path.split("/").pop() ?? path;
	return EXCLUDED_LOCK_FILES.has(basename);
}

function filterExcludedFiles(files: string[]): { filtered: string[]; excluded: string[] } {
	const filtered: string[] = [];
	const excluded: string[] = [];
	for (const file of files) {
		if (isExcludedFile(file)) {
			excluded.push(file);
		} else {
			filtered.push(file);
		}
	}
	return { filtered, excluded };
}
function renderStat(entries: VcsNumstatEntry[]): string {
	if (entries.length === 0) return "";
	let insertions = 0;
	let deletions = 0;
	const lines = entries.map(entry => {
		const added = entry.added ?? 0;
		const removed = entry.removed ?? 0;
		insertions += added;
		deletions += removed;
		return ` ${entry.path} | ${added + removed} ${"+".repeat(Math.min(added, 40))}${"-".repeat(Math.min(removed, 40))}`;
	});
	lines.push(
		` ${entries.length} file${entries.length === 1 ? "" : "s"} changed, ${insertions} insertion${insertions === 1 ? "" : "s"}(+), ${deletions} deletion${deletions === 1 ? "" : "s"}(-)`,
	);
	return `${lines.join("\n")}\n`;
}

const gitOverviewSchema = type({
	"staged?": type("boolean").describe("use staged changes (default true)"),
	"include_untracked?": type("boolean").describe("include untracked when unstaged"),
});

export function createGitOverviewTool(cwd: string, state: CommitAgentState): CustomTool<typeof gitOverviewSchema> {
	const repo = vcs.requireGit(cwd);
	return {
		name: "git_overview",
		label: "Git Overview",
		description: "Return staged files, diff stat summary, and numstat entries.",
		parameters: gitOverviewSchema,
		async execute(_toolCallId, params) {
			const staged = params.staged ?? true;
			const allFiles = await repo.changedFiles({ cached: staged });
			const { filtered: files, excluded } = filterExcludedFiles(allFiles);
			const allNumstat = await repo.numstat({ cached: staged });
			const stat = renderStat(allNumstat);
			const numstat = allNumstat
				.filter(entry => !isExcludedFile(entry.path))
				.map(entry => ({ path: entry.path, additions: entry.added ?? 0, deletions: entry.removed ?? 0 }));
			const scopeResult = extractScopeCandidates(numstat, DEFAULT_CONVENTIONAL_GENERATION_CONFIG);
			const untrackedFiles = !staged && params.include_untracked ? await repo.lsFiles(true, true) : undefined;
			const snapshot: GitOverviewSnapshot = {
				files,
				stat,
				numstat,
				scopeCandidates: scopeResult.scopeCandidates,
				isWideScope: scopeResult.isWide,
				untrackedFiles,
				excludedFiles: excluded.length > 0 ? excluded : undefined,
			};
			state.overview = snapshot;
			return {
				content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
				details: snapshot,
			};
		},
	};
}
