import { tryParseJson } from "@oh-my-pi/pi-utils";
import { buildResult, loadPage, type RenderResult, type SpecialHandler } from "./types";

interface RepologyPackage {
	repo: string;
	subrepo?: string;
	srcname?: string;
	binname?: string;
	visiblename?: string;
	version: string;
	origversion?: string;
	status:
		| "newest"
		| "devel"
		| "unique"
		| "outdated"
		| "legacy"
		| "rolling"
		| "noscheme"
		| "incorrect"
		| "untrusted"
		| "ignored";
	summary?: string;
	categories?: string[];
	licenses?: string[];
	maintainers?: string[];
}

/**
 * Get emoji indicator for version status
 */
function statusIndicator(status: string): string {
	switch (status) {
		case "newest":
			return "✅"; // green check
		case "devel":
			return "🚧"; // construction
		case "unique":
			return "🔵"; // blue circle
		case "outdated":
			return "🔴"; // red circle
		case "legacy":
			return "⚠\uFE0F"; // warning
		case "rolling":
			return "🔄"; // arrows
		default:
			return "➖"; // minus
	}
}

/**
 * Prettify repository name
 */
function prettifyRepo(repo: string): string {
	const mapping: Record<string, string> = {
		arch: "Arch Linux",
		aur: "AUR",
		debian_unstable: "Debian Unstable",
		debian_stable: "Debian Stable",
		ubuntu_24_04: "Ubuntu 24.04",
		ubuntu_22_04: "Ubuntu 22.04",
		fedora_rawhide: "Fedora Rawhide",
		fedora_40: "Fedora 40",
		gentoo: "Gentoo",
		nix_unstable: "Nixpkgs Unstable",
		nix_stable: "Nixpkgs Stable",
		homebrew: "Homebrew",
		macports: "MacPorts",
		alpine_edge: "Alpine Edge",
		freebsd: "FreeBSD",
		openbsd: "OpenBSD",
		void_x86_64: "Void Linux",
		opensuse_tumbleweed: "openSUSE Tumbleweed",
		msys2_mingw: "MSYS2",
		chocolatey: "Chocolatey",
		winget: "Winget",
		scoop: "Scoop",
		conda_main: "Conda",
		pypi: "PyPI",
		crates_io: "Crates.io",
		npm: "npm",
		rubygems: "RubyGems",
		cpan: "CPAN",
		hackage: "Hackage",
	};

	// Check exact match first
	if (mapping[repo]) return mapping[repo];

	// Check partial matches
	for (const [key, value] of Object.entries(mapping)) {
		if (repo.startsWith(key)) return value;
	}

	// Fallback: titlecase with underscores replaced
	return repo
		.split("_")
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/**
 * Handle Repology URLs via API
 */
export const handleRepology: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "repology.org" && parsed.hostname !== "www.repology.org") return null;

		// Extract package name from /project/{name}/versions or /project/{name}/information
		const match = parsed.pathname.match(/^\/project\/([^/]+)/);
		if (!match) return null;

		const packageName = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();

		// Fetch from Repology API
		const apiUrl = `https://repology.org/api/v1/project/${encodeURIComponent(packageName)}`;
		const result = await loadPage(apiUrl, {
			timeout,
			headers: {
				Accept: "application/json",
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
			signal,
		});

		if (!result.ok) return null;

		const packages = tryParseJson<RepologyPackage[]>(result.content);
		if (!packages) return null;

		// Empty response means package not found
		if (!Array.isArray(packages) || packages.length === 0) return null;

		// Find newest version(s) and extract metadata
		const newestVersions = new Set<string>();
		let summary: string | undefined;
		let licenses: string[] = [];
		const categories = new Set<string>();

		for (const pkg of packages) {
			if (pkg.status === "newest" || pkg.status === "unique") {
				newestVersions.add(pkg.version);
			}
			if (!summary && pkg.summary) summary = pkg.summary;
			if (pkg.licenses?.length && !licenses.length) licenses = pkg.licenses;
			if (pkg.categories) {
				for (const cat of pkg.categories) categories.add(cat);
			}
		}

		// If no newest found, find the highest version
		if (newestVersions.size === 0) {
			const versions = packages.map(p => p.version);
			if (versions.length > 0) newestVersions.add(versions[0]);
		}

		// Group packages by status for counting
		const statusCounts: Record<string, number> = {};
		for (const pkg of packages) {
			statusCounts[pkg.status] = (statusCounts[pkg.status] || 0) + 1;
		}

		// Build markdown
		let md = `# ${packageName}\n\n`;
		if (summary) md += `${summary}\n\n`;

		md += `**Newest Version:** ${Array.from(newestVersions).join(", ") || "unknown"}\n`;
		md += `**Repositories:** ${packages.length}\n`;
		if (licenses.length) md += `**License:** ${licenses.join(", ")}\n`;
		if (categories.size) md += `**Categories:** ${Array.from(categories).join(", ")}\n`;
		md += "\n";

		// Status summary
		md += "## Version Status Summary\n\n";
		const statusOrder = [
			"newest",
			"unique",
			"devel",
			"rolling",
			"outdated",
			"legacy",
			"noscheme",
			"incorrect",
			"untrusted",
			"ignored",
		];
		for (const status of statusOrder) {
			if (statusCounts[status]) {
				md += `- ${statusIndicator(status)} **${status}**: ${statusCounts[status]} repos\n`;
			}
		}
		md += "\n";

		// Sort packages: newest first, then by repo name
		const sortedPackages = [...packages].sort((a, b) => {
			const statusPriority: Record<string, number> = {
				newest: 0,
				unique: 1,
				devel: 2,
				rolling: 3,
				outdated: 4,
				legacy: 5,
				noscheme: 6,
				incorrect: 7,
				untrusted: 8,
				ignored: 9,
			};
			const aPriority = statusPriority[a.status] ?? 10;
			const bPriority = statusPriority[b.status] ?? 10;
			if (aPriority !== bPriority) return aPriority - bPriority;
			return a.repo.localeCompare(b.repo);
		});

		// Show top repositories (up to 15)
		md += "## Package Versions by Repository\n\n";
		md += "| Repository | Version | Status |\n";
		md += "|------------|---------|--------|\n";

		const shownRepos = new Set<string>();
		let count = 0;
		for (const pkg of sortedPackages) {
			// Skip duplicate repos (some have multiple entries)
			const repoKey = pkg.subrepo ? `${pkg.repo}/${pkg.subrepo}` : pkg.repo;
			if (shownRepos.has(repoKey)) continue;
			shownRepos.add(repoKey);

			const repoName = prettifyRepo(pkg.repo);
			const version = pkg.origversion || pkg.version;
			md += `| ${repoName} | \`${version}\` | ${statusIndicator(pkg.status)} ${pkg.status} |\n`;

			count++;
			if (count >= 15) break;
		}

		if (packages.length > 15) {
			md += `\n[…${packages.length - 15} repositories elided…]\n`;
		}

		md += `\n---\n\n[View on Repology](${url})\n`;

		return buildResult(md, { url, method: "repology", fetchedAt, notes: ["Fetched via Repology API"] });
	} catch {}

	return null;
};
