import { fetchGitHubApi } from "./github";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult } from "./types";

/**
 * Handle GitHub Gist URLs via GitHub API
 */
export const handleGitHubGist: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "gist.github.com") return null;

		// Extract gist ID from /username/gistId or just /gistId
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length === 0) return null;

		// Gist ID is always the last path segment (or only segment for anonymous gists)
		const gistId = parts[parts.length - 1];
		if (!gistId || !/^[a-f0-9]+$/i.test(gistId)) return null;

		const fetchedAt = new Date().toISOString();

		// Fetch via GitHub API
		const result = await fetchGitHubApi(`/gists/${gistId}`, timeout, signal);
		if (!result.ok || !result.data) return null;

		const gist = result.data as {
			description: string | null;
			owner?: { login: string };
			created_at: string;
			updated_at: string;
			files: Record<string, { filename: string; language: string | null; size: number; content: string }>;
			html_url: string;
		};

		const files = Object.values(gist.files);
		const owner = gist.owner?.login || "anonymous";

		let md = `# Gist by ${owner}\n\n`;
		if (gist.description) md += `${gist.description}\n\n`;
		md += `**Created:** ${gist.created_at} · **Updated:** ${gist.updated_at}\n`;
		md += `**Files:** ${files.length}\n\n`;

		for (const file of files) {
			const lang = file.language?.toLowerCase() || "";
			md += `---\n\n## ${file.filename}\n\n`;
			md += `\`\`\`${lang}\n${file.content}\n\`\`\`\n\n`;
		}

		return buildResult(md, { url, method: "github-gist", fetchedAt, notes: ["Fetched via GitHub API"] });
	} catch {}

	return null;
};
