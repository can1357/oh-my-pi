import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { CustomTool } from "../../../extensibility/custom-tools/types";

const recentCommitsSchema = type({
	"count?": type("1 <= number <= 50").describe("commit count"),
});

interface RecentCommitStats {
	scopeUsagePercent: number;
	commonVerbs: Record<string, number>;
	summaryLength: { min: number; max: number; average: number };
	lowercaseSummaryPercent: number;
	topScopes: Record<string, number>;
}

function extractSummary(subject: string): string {
	const match = subject.match(/^[a-z]+(?:\([^)]+\))?:\s+(.*)$/i);
	if (match?.[1]) return match[1].trim();
	return subject.trim();
}

function extractScope(subject: string): string | null {
	const match = subject.match(/^[a-z]+\(([^)]+)\):/i);
	return match?.[1]?.trim() ?? null;
}

export function createRecentCommitsTool(cwd: string): CustomTool<typeof recentCommitsSchema> {
	const repo = vcs.require(cwd);
	return {
		name: "recent_commits",
		label: "Recent Commits",
		description: "Return recent commit subjects with style statistics.",
		parameters: recentCommitsSchema,
		async execute(_toolCallId, params) {
			const count = params.count ?? 8;
			const commits = await repo.logSubjects(count);
			const verbs: Record<string, number> = {};
			const scopes: Record<string, number> = {};
			const lengths: number[] = [];
			let scopeCount = 0;
			let lowercaseCount = 0;

			for (const subject of commits) {
				const summary = extractSummary(subject);
				const scope = extractScope(subject);
				if (scope) {
					scopeCount += 1;
					scopes[scope] = (scopes[scope] ?? 0) + 1;
				}
				if (summary[0] && summary[0] === summary[0].toLowerCase()) {
					lowercaseCount += 1;
				}
				const firstWord = summary.split(/\s+/)[0]?.toLowerCase();
				if (firstWord) {
					verbs[firstWord] = (verbs[firstWord] ?? 0) + 1;
				}
				lengths.push(summary.length);
			}

			const min = lengths.length > 0 ? Math.min(...lengths) : 0;
			const max = lengths.length > 0 ? Math.max(...lengths) : 0;
			const average = lengths.length > 0 ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0;
			const scopeUsagePercent = commits.length > 0 ? Math.round((scopeCount / commits.length) * 100) : 0;
			const lowercaseSummaryPercent = commits.length > 0 ? Math.round((lowercaseCount / commits.length) * 100) : 0;

			const stats: RecentCommitStats = {
				scopeUsagePercent,
				commonVerbs: verbs,
				summaryLength: { min, max, average: Number(average.toFixed(1)) },
				lowercaseSummaryPercent,
				topScopes: scopes,
			};

			const payload = { commits, stats };
			return {
				content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
				details: payload,
			};
		},
	};
}
