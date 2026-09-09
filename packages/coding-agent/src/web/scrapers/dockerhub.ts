import { tryParseJson } from "@oh-my-pi/pi-utils";
import { formatBytes } from "../../tools/render-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, formatNumber, loadPage } from "./types";

interface DockerHubRepo {
	name: string;
	namespace: string;
	description?: string;
	star_count?: number;
	pull_count?: number;
	last_updated?: string;
	is_official?: boolean;
	is_automated?: boolean;
	user?: string;
}

interface DockerHubTag {
	name: string;
	last_updated?: string;
	full_size?: number;
	digest?: string;
	images?: Array<{
		architecture?: string;
		os?: string;
		size?: number;
	}>;
}

interface DockerHubTagsResponse {
	results?: DockerHubTag[];
}

/**
 * Handle Docker Hub URLs via API
 */
export const handleDockerHub: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("hub.docker.com")) return null;

		let namespace: string;
		let repository: string;

		// Official images: /_ /{image}
		const officialMatch = parsed.pathname.match(/^\/_\/([^/]+)/);
		if (officialMatch) {
			namespace = "library";
			repository = officialMatch[1];
		} else {
			// Regular images: /r/{namespace}/{repository}
			const repoMatch = parsed.pathname.match(/^\/r\/([^/]+)\/([^/]+)/);
			if (!repoMatch) return null;
			namespace = repoMatch[1];
			repository = repoMatch[2];
		}

		const fetchedAt = new Date().toISOString();

		// Fetch repository info and tags in parallel
		const repoUrl = `https://hub.docker.com/v2/repositories/${namespace}/${repository}/`;
		const tagsUrl = `https://hub.docker.com/v2/repositories/${namespace}/${repository}/tags/?page_size=10`;

		const [repoResult, tagsResult] = await Promise.all([
			loadPage(repoUrl, { timeout, headers: { Accept: "application/json" }, signal }),
			loadPage(tagsUrl, { timeout: Math.min(timeout, 10), headers: { Accept: "application/json" }, signal }),
		]);

		if (!repoResult.ok) return null;

		const repo = tryParseJson<DockerHubRepo>(repoResult.content);
		if (!repo) return null;

		// Parse tags
		let tags: DockerHubTag[] = [];
		if (tagsResult.ok) {
			const tagsData = tryParseJson<DockerHubTagsResponse>(tagsResult.content);
			if (tagsData?.results) tags = tagsData.results;
		}

		// Build markdown output
		const fullName = namespace === "library" ? repo.name : `${namespace}/${repo.name}`;
		let md = `# ${fullName}\n\n`;

		if (repo.description) {
			md += `${repo.description}\n\n`;
		}

		// Stats line
		const stats: string[] = [];
		if (repo.pull_count !== undefined) stats.push(`**Pulls:** ${formatNumber(repo.pull_count)}`);
		if (repo.star_count !== undefined) stats.push(`**Stars:** ${formatNumber(repo.star_count)}`);
		if (repo.is_official) stats.push("**Official Image**");
		if (repo.is_automated) stats.push("**Automated Build**");
		if (stats.length > 0) {
			md += `${stats.join(" · ")}\n`;
		}

		if (repo.last_updated) {
			md += `**Last Updated:** ${formatIsoDate(repo.last_updated)}\n`;
		}

		md += "\n";

		// Docker pull command
		md += "## Quick Start\n\n";
		md += "```bash\n";
		md += `docker pull ${fullName}\n`;
		md += "```\n\n";

		// Tags
		if (tags.length > 0) {
			md += "## Recent Tags\n\n";
			md += "| Tag | Size | Architectures | Updated |\n";
			md += "|-----|------|---------------|--------|\n";

			for (const tag of tags) {
				const size = tag.full_size ? formatBytes(tag.full_size) : "-";
				const archs =
					tag.images
						?.map(img => img.architecture)
						.filter(Boolean)
						.join(", ") || "-";
				const updated = tag.last_updated ? formatIsoDate(tag.last_updated) : "-";
				md += `| \`${tag.name}\` | ${size} | ${archs} | ${updated} |\n`;
			}
			md += "\n";
		}

		return buildResult(md, { url, method: "dockerhub", fetchedAt, notes: ["Fetched via Docker Hub API"] });
	} catch {}

	return null;
};
