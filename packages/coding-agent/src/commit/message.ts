import type { ConventionalAnalysis } from "./types";

export function formatCommitMessage(analysis: ConventionalAnalysis, summary: string): string {
	const scopePart = analysis.scope ? `(${analysis.scope})` : "";
	const header = `${analysis.type}${scopePart}: ${summary}`;
	const bodyLines = analysis.details.map(detail => `- ${detail.text.trim()}`);
	if (bodyLines.length === 0) {
		return header;
	}
	return `${header}\n\n${bodyLines.join("\n")}`;
}
