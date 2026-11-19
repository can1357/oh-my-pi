import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, formatNumber, loadPage } from "./types";

interface ArtifactHubMaintainer {
	name: string;
	email?: string;
}

interface ArtifactHubLink {
	name: string;
	url: string;
}

interface ArtifactHubRepository {
	name: string;
	display_name?: string;
	url: string;
	organization_name?: string;
	organization_display_name?: string;
}

interface ArtifactHubPackage {
	package_id: string;
	name: string;
	normalized_name: string;
	display_name?: string;
	description?: string;
	version: string;
	app_version?: string;
	license?: string;
	home_url?: string;
	readme?: string;
	install?: string;
	keywords?: string[];
	maintainers?: ArtifactHubMaintainer[];
	links?: ArtifactHubLink[];
	repository: ArtifactHubRepository;
	ts: number;
	created_at: number;
	stars?: number;
	official?: boolean;
	signed?: boolean;
	security_report_summary?: {
		low?: number;
		medium?: number;
		high?: number;
		critical?: number;
	};
	available_versions?: Array<{ version: string; ts: number }>;
}

/**
 * Handle Artifact Hub URLs via API
 * Supports Helm charts, OLM operators, Falco rules, OPA policies, etc.
 */
export const handleArtifactHub: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "artifacthub.io" && parsed.hostname !== "www.artifacthub.io") return null;

		// Extract kind, repo, and package name from /packages/{kind}/{repo}/{name}
		const match = parsed.pathname.match(/^\/packages\/([^/]+)\/([^/]+)\/([^/]+)/);
		if (!match) return null;

		const [, kind, repo, name] = match;
		const fetchedAt = new Date().toISOString();

		// Fetch from Artifact Hub API
		const apiUrl = `https://artifacthub.io/api/v1/packages/${kind}/${repo}/${name}`;
		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) return null;

		const pkg = tryParseJson<ArtifactHubPackage>(result.content);
		if (!pkg) return null;

		const displayName = pkg.display_name || pkg.name;
		const kindLabel = formatKindLabel(kind);

		let md = `# ${displayName}\n\n`;
		if (pkg.description) md += `${pkg.description}\n\n`;

		// Basic info line
		md += `**Type:** ${kindLabel}`;
		md += ` · **Version:** ${pkg.version}`;
		if (pkg.app_version) md += ` · **App Version:** ${pkg.app_version}`;
		if (pkg.license) md += ` · **License:** ${pkg.license}`;
		md += "\n";

		// Stats and badges
		const badges: string[] = [];
		if (pkg.official) badges.push("Official");
		if (pkg.signed) badges.push("Signed");
		if (pkg.stars) badges.push(`${formatNumber(pkg.stars)} stars`);
		if (badges.length > 0) md += `**${badges.join(" · ")}**\n`;
		md += "\n";

		// Repository info
		const repoDisplay =
			pkg.repository.organization_display_name || pkg.repository.display_name || pkg.repository.name;
		md += `**Repository:** ${repoDisplay}`;
		if (pkg.repository.url) md += ` ([${pkg.repository.url}](${pkg.repository.url}))`;
		md += "\n";

		if (pkg.home_url) md += `**Homepage:** ${pkg.home_url}\n`;
		if (pkg.keywords?.length) md += `**Keywords:** ${pkg.keywords.join(", ")}\n`;

		// Maintainers
		if (pkg.maintainers?.length) {
			const maintainerNames = pkg.maintainers.map(m => m.name).join(", ");
			md += `**Maintainers:** ${maintainerNames}\n`;
		}

		// Security report summary
		if (pkg.security_report_summary) {
			const sec = pkg.security_report_summary;
			const parts: string[] = [];
			if (sec.critical) parts.push(`${sec.critical} critical`);
			if (sec.high) parts.push(`${sec.high} high`);
			if (sec.medium) parts.push(`${sec.medium} medium`);
			if (sec.low) parts.push(`${sec.low} low`);
			if (parts.length > 0) {
				md += `**Security:** ${parts.join(", ")}\n`;
			}
		}

		// Links
		if (pkg.links?.length) {
			md += `\n## Links\n\n`;
			for (const link of pkg.links) {
				md += `- [${link.name}](${link.url})\n`;
			}
		}

		// Install instructions
		if (pkg.install) {
			md += `\n## Installation\n\n\`\`\`bash\n${pkg.install.trim()}\n\`\`\`\n`;
		}

		// Recent versions
		if (pkg.available_versions?.length) {
			md += `\n## Recent Versions\n\n`;
			for (const ver of pkg.available_versions.slice(0, 5)) {
				const date = formatIsoDate(ver.ts * 1000);
				md += `- **${ver.version}** (${date})\n`;
			}
		}

		// README
		if (pkg.readme) {
			md += `\n---\n\n## README\n\n${pkg.readme}\n`;
		}

		return buildResult(md, {
			url,
			method: "artifacthub",
			fetchedAt,
			notes: [`Fetched via Artifact Hub API (${kindLabel})`],
		});
	} catch {}

	return null;
};

/**
 * Convert kind slug to display label
 */
function formatKindLabel(kind: string): string {
	const labels: Record<string, string> = {
		helm: "Helm Chart",
		"helm-plugin": "Helm Plugin",
		falco: "Falco Rules",
		opa: "OPA Policy",
		olm: "OLM Operator",
		tbaction: "Tinkerbell Action",
		krew: "Krew Plugin",
		tekton: "Tekton Task",
		"tekton-pipeline": "Tekton Pipeline",
		keda: "KEDA Scaler",
		coredns: "CoreDNS Plugin",
		keptn: "Keptn Integration",
		container: "Container Image",
		kubewarden: "Kubewarden Policy",
		gatekeeper: "Gatekeeper Policy",
		kyverno: "Kyverno Policy",
		"knative-client": "Knative Client Plugin",
		backstage: "Backstage Plugin",
		argo: "Argo Template",
		kubearmor: "KubeArmor Policy",
		kcl: "KCL Module",
		headlamp: "Headlamp Plugin",
		inspektor: "Inspektor Gadget",
		"meshery-design": "Meshery Design",
		"opencost-plugin": "OpenCost Plugin",
		radius: "Radius Recipe",
	};
	return labels[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);
}
