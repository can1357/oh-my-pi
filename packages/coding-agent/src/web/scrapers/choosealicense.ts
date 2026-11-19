import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";
import { asString } from "./utils";

const ALLOWED_HOSTS = new Set(["choosealicense.com", "www.choosealicense.com"]);
const LICENSE_PATH = /^\/licenses\/([^/]+)\/?$/i;
const APPENDIX_PATH = /^\/appendix\/?$/i;

function normalizeList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === "string")
			.map(item => item.trim())
			.filter(item => item.length > 0);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map(item => item.trim())
			.filter(item => item.length > 0);
	}
	return [];
}

function formatLabel(value: string): string {
	const cleaned = value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return value;
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function formatSection(title: string, items: string[]): string {
	let md = `## ${title}\n\n`;
	if (items.length === 0) {
		md += "- None listed\n\n";
		return md;
	}
	for (const item of items) {
		md += `- ${formatLabel(item)}\n`;
	}
	md += "\n";
	return md;
}

export const handleChooseALicense: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;

		const licenseMatch = parsed.pathname.match(LICENSE_PATH);
		const isAppendix = APPENDIX_PATH.test(parsed.pathname);
		if (!licenseMatch && !isAppendix) return null;

		const licenseSlug = licenseMatch ? decodeURIComponent(licenseMatch[1]).toLowerCase() : "appendix";
		const rawUrl = licenseMatch
			? `https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_licenses/${licenseSlug}.txt`
			: "https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_pages/appendix.md";

		const fetchedAt = new Date().toISOString();
		const result = await loadPage(rawUrl, { timeout, headers: { Accept: "text/plain" }, signal });
		if (!result.ok) return null;

		const { frontmatter, body } = parseFrontmatter(result.content, { source: rawUrl });

		const title = asString(frontmatter.title) ?? formatLabel(licenseSlug);
		const spdxId = asString(frontmatter.spdxId) ?? "Unknown";
		const description = asString(frontmatter.description);
		const permissions = normalizeList(frontmatter.permissions);
		const conditions = normalizeList(frontmatter.conditions);
		const limitations = normalizeList(frontmatter.limitations);

		let md = `# ${title}\n\n`;
		if (description) md += `${description}\n\n`;

		md += `**SPDX ID:** ${spdxId}\n`;
		md += `**Source:** https://choosealicense.com${isAppendix ? "/appendix" : `/licenses/${licenseSlug}/`}\n\n`;

		md += formatSection("Permissions", permissions);
		md += formatSection("Conditions", conditions);
		md += formatSection("Limitations", limitations);

		const licenseText = body.trim();
		if (licenseText.length > 0) {
			md += `---\n\n## License Text\n\n${licenseText}\n`;
		}

		return buildResult(md, { url, method: "choosealicense", fetchedAt, notes: ["Fetched via Choose a License"] });
	} catch {}

	return null;
};
