import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, loadPage } from "./types";

interface ModuleResponse {
	name: string;
	version: string;
	abstract?: string;
	author: string;
	distribution: string;
	release: string;
	path: string;
	pod?: string;
}

interface ReleaseResponse {
	name: string;
	version: string;
	abstract?: string;
	author: string;
	distribution: string;
	license?: string[];
	stat?: { mtime: number };
	download_url?: string;
	dependency?: Array<{
		module: string;
		version: string;
		phase: string;
		relationship: string;
	}>;
	metadata?: {
		resources?: {
			repository?: { url?: string; web?: string };
			homepage?: string;
			bugtracker?: { web?: string };
		};
	};
}

/**
 * Handle MetaCPAN URLs via fastapi.metacpan.org
 */
export const handleMetaCPAN: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "metacpan.org" && parsed.hostname !== "www.metacpan.org") return null;

		const fetchedAt = new Date().toISOString();

		// Match /pod/Module::Name pattern
		const podMatch = parsed.pathname.match(/^\/pod\/(.+?)(?:\/|$)/);
		if (podMatch) {
			const moduleName = decodeURIComponent(podMatch[1]);
			return await fetchModule(url, moduleName, timeout, fetchedAt, signal);
		}

		// Match /release/AUTHOR/Distribution pattern
		const releaseMatch = parsed.pathname.match(/^\/release\/([^/]+)\/([^/]+)/);
		if (releaseMatch) {
			const distribution = decodeURIComponent(releaseMatch[2]);
			return await fetchRelease(url, distribution, timeout, fetchedAt, signal);
		}

		// Match /release/Distribution pattern (without author)
		const simpleReleaseMatch = parsed.pathname.match(/^\/release\/([^/]+)$/);
		if (simpleReleaseMatch) {
			const distribution = decodeURIComponent(simpleReleaseMatch[1]);
			return await fetchRelease(url, distribution, timeout, fetchedAt, signal);
		}

		return null;
	} catch {}

	return null;
};

async function fetchModule(
	url: string,
	moduleName: string,
	timeout: number,
	fetchedAt: string,
	signal?: AbortSignal,
): Promise<RenderResult | null> {
	const apiUrl = `https://fastapi.metacpan.org/v1/module/${moduleName}`;
	const result = await loadPage(apiUrl, { timeout, signal });

	if (!result.ok) return null;

	const module = tryParseJson<ModuleResponse>(result.content);
	if (!module) return null;

	// Fetch additional release info for dependencies and metadata
	const releaseUrl = `https://fastapi.metacpan.org/v1/release/${module.distribution}`;
	const releaseResult = await loadPage(releaseUrl, { timeout: Math.min(timeout, 5), signal });

	let release: ReleaseResponse | null = null;
	if (releaseResult.ok) {
		release = tryParseJson<ReleaseResponse>(releaseResult.content);
	}

	const md = formatModuleMarkdown(module, release);
	return buildResult(md, { url, method: "metacpan", fetchedAt, notes: ["Fetched via MetaCPAN API"] });
}

async function fetchRelease(
	url: string,
	distribution: string,
	timeout: number,
	fetchedAt: string,
	signal?: AbortSignal,
): Promise<RenderResult | null> {
	const apiUrl = `https://fastapi.metacpan.org/v1/release/${distribution}`;
	const result = await loadPage(apiUrl, { timeout, signal });

	if (!result.ok) return null;

	const release = tryParseJson<ReleaseResponse>(result.content);
	if (!release) return null;

	const md = formatReleaseMarkdown(release);
	return buildResult(md, { url, method: "metacpan", fetchedAt, notes: ["Fetched via MetaCPAN API"] });
}

function formatModuleMarkdown(module: ModuleResponse, release: ReleaseResponse | null): string {
	let md = `# ${module.name}\n\n`;
	if (module.abstract) md += `${module.abstract}\n\n`;

	md += `**Version:** ${module.version}`;
	md += ` · **Distribution:** ${module.distribution}`;
	md += ` · **Author:** [${module.author}](https://metacpan.org/author/${module.author})\n`;

	if (release) {
		if (release.license?.length) {
			md += `**License:** ${release.license.join(", ")}\n`;
		}

		const resources = release.metadata?.resources;
		if (resources?.repository?.web || resources?.repository?.url) {
			const repoUrl = resources.repository.web || resources.repository.url;
			md += `**Repository:** ${repoUrl}\n`;
		}
		if (resources?.homepage) {
			md += `**Homepage:** ${resources.homepage}\n`;
		}
		if (resources?.bugtracker?.web) {
			md += `**Issues:** ${resources.bugtracker.web}\n`;
		}

		// Show runtime dependencies
		const runtimeDeps = release.dependency?.filter(
			d => d.phase === "runtime" && d.relationship === "requires" && d.module !== "perl",
		);
		if (runtimeDeps?.length) {
			md += `\n## Dependencies\n\n`;
			for (const dep of runtimeDeps.slice(0, 20)) {
				md += `- **${dep.module}**`;
				if (dep.version && dep.version !== "0") md += ` >= ${dep.version}`;
				md += "\n";
			}
			if (runtimeDeps.length > 20) {
				md += `\n[…${runtimeDeps.length - 20} dependencies elided…]\n`;
			}
		}
	}

	md += `\n## Installation\n\n\`\`\`bash\ncpanm ${module.name}\n\`\`\`\n`;

	return md;
}

function formatReleaseMarkdown(release: ReleaseResponse): string {
	let md = `# ${release.distribution}\n\n`;
	if (release.abstract) md += `${release.abstract}\n\n`;

	md += `**Version:** ${release.version}`;
	md += ` · **Author:** [${release.author}](https://metacpan.org/author/${release.author})\n`;

	if (release.license?.length) {
		md += `**License:** ${release.license.join(", ")}\n`;
	}

	if (release.stat?.mtime) {
		const date = formatIsoDate(release.stat.mtime * 1000);
		md += `**Released:** ${date}\n`;
	}

	const resources = release.metadata?.resources;
	if (resources?.repository?.web || resources?.repository?.url) {
		const repoUrl = resources.repository.web || resources.repository.url;
		md += `**Repository:** ${repoUrl}\n`;
	}
	if (resources?.homepage) {
		md += `**Homepage:** ${resources.homepage}\n`;
	}
	if (resources?.bugtracker?.web) {
		md += `**Issues:** ${resources.bugtracker.web}\n`;
	}

	// Show runtime dependencies
	const runtimeDeps = release.dependency?.filter(
		d => d.phase === "runtime" && d.relationship === "requires" && d.module !== "perl",
	);
	if (runtimeDeps?.length) {
		md += `\n## Dependencies\n\n`;
		for (const dep of runtimeDeps.slice(0, 20)) {
			md += `- **${dep.module}**`;
			if (dep.version && dep.version !== "0") md += ` >= ${dep.version}`;
			md += "\n";
		}
		if (runtimeDeps.length > 20) {
			md += `\n[…${runtimeDeps.length - 20} dependencies elided…]\n`;
		}
	}

	md += `\n## Installation\n\n\`\`\`bash\ncpanm ${release.distribution}\n\`\`\`\n`;

	return md;
}
