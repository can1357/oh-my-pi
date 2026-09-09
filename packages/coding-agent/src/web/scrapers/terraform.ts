import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

interface TerraformModule {
	id: string;
	namespace: string;
	name: string;
	provider: string;
	version: string;
	description?: string;
	source?: string;
	published_at?: string;
	downloads: number;
	verified?: boolean;
	root?: {
		inputs?: Array<{
			name: string;
			type?: string;
			description?: string;
			default?: unknown;
			required?: boolean;
		}>;
		outputs?: Array<{
			name: string;
			description?: string;
		}>;
		dependencies?: Array<{
			name: string;
			source: string;
			version?: string;
		}>;
		resources?: Array<{
			name: string;
			type: string;
		}>;
	};
	submodules?: Array<{
		path: string;
		name: string;
	}>;
}

interface TerraformProvider {
	id: string;
	namespace: string;
	name: string;
	alias?: string;
	version: string;
	description?: string;
	source?: string;
	published_at?: string;
	downloads: number;
	tier?: string;
	logo_url?: string;
	docs?: Array<{
		id: string;
		title: string;
		path: string;
		slug: string;
		category: string;
	}>;
}

/**
 * Handle Terraform Registry URLs via API
 */
export const handleTerraform: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("registry.terraform.io")) return null;

		const fetchedAt = new Date().toISOString();

		// Match module URL: /modules/{namespace}/{name}/{provider}
		const moduleMatch = parsed.pathname.match(/^\/modules\/([^/]+)\/([^/]+)\/([^/]+)/);
		if (moduleMatch) {
			const [, namespace, name, provider] = moduleMatch;
			return await handleModuleUrl(url, namespace, name, provider, timeout, signal, fetchedAt);
		}

		// Match provider URL: /providers/{namespace}/{type}
		const providerMatch = parsed.pathname.match(/^\/providers\/([^/]+)\/([^/]+)/);
		if (providerMatch) {
			const [, namespace, type] = providerMatch;
			return await handleProviderUrl(url, namespace, type, timeout, signal, fetchedAt);
		}

		return null;
	} catch {}

	return null;
};

async function handleModuleUrl(
	url: string,
	namespace: string,
	name: string,
	provider: string,
	timeout: number,
	signal: AbortSignal | undefined,
	fetchedAt: string,
): Promise<RenderResult | null> {
	const apiUrl = `https://registry.terraform.io/v1/modules/${namespace}/${name}/${provider}`;
	const result = await loadPage(apiUrl, {
		timeout,
		signal,
		headers: { Accept: "application/json" },
	});

	if (!result.ok) return null;

	const mod = tryParseJson<TerraformModule>(result.content);
	if (!mod) return null;

	let md = `# ${mod.namespace}/${mod.name}/${mod.provider}\n\n`;

	if (mod.description) md += `${mod.description}\n\n`;

	// Metadata line
	md += `**Version:** ${mod.version}`;
	if (mod.verified) md += " ✓ Verified";
	md += `\n`;
	md += `**Downloads:** ${formatNumber(mod.downloads)}\n`;
	if (mod.published_at) {
		md += `**Published:** ${new Date(mod.published_at).toLocaleDateString()}\n`;
	}
	if (mod.source) {
		md += `**Source:** ${mod.source}\n`;
	}
	md += "\n";

	// Usage example
	md += `## Usage\n\n\`\`\`hcl\nmodule "${mod.name}" {\n  source  = "${mod.namespace}/${mod.name}/${mod.provider}"\n  version = "${mod.version}"\n}\n\`\`\`\n\n`;

	// Inputs
	const inputs = mod.root?.inputs;
	if (inputs && inputs.length > 0) {
		md += `## Inputs (${inputs.length})\n\n`;
		md += "| Name | Type | Required | Description |\n";
		md += "|------|------|----------|-------------|\n";
		for (const input of inputs.slice(0, 30)) {
			const required = (input.required ?? input.default === undefined) ? "Yes" : "No";
			const type = input.type ?? "any";
			const desc = (input.description ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 80);
			md += `| ${input.name} | \`${type}\` | ${required} | ${desc} |\n`;
		}
		if (inputs.length > 30) {
			md += `\n[…${inputs.length - 30} inputs elided…]\n`;
		}
		md += "\n";
	}

	// Outputs
	const outputs = mod.root?.outputs;
	if (outputs && outputs.length > 0) {
		md += `## Outputs (${outputs.length})\n\n`;
		for (const output of outputs.slice(0, 20)) {
			md += `- **${output.name}**`;
			if (output.description) md += `: ${output.description.replace(/\n/g, " ").slice(0, 100)}`;
			md += "\n";
		}
		if (outputs.length > 20) {
			md += `\n[…${outputs.length - 20} outputs elided…]\n`;
		}
		md += "\n";
	}

	// Dependencies
	const deps = mod.root?.dependencies;
	if (deps && deps.length > 0) {
		md += `## Dependencies (${deps.length})\n\n`;
		for (const dep of deps.slice(0, 15)) {
			md += `- **${dep.name}**: ${dep.source}`;
			if (dep.version) md += ` (${dep.version})`;
			md += "\n";
		}
		if (deps.length > 15) {
			md += `\n[…${deps.length - 15} dependencies elided…]\n`;
		}
		md += "\n";
	}

	// Resources
	const resources = mod.root?.resources;
	if (resources && resources.length > 0) {
		md += `## Resources (${resources.length})\n\n`;
		for (const res of resources.slice(0, 20)) {
			md += `- \`${res.type}\` (${res.name})\n`;
		}
		if (resources.length > 20) {
			md += `\n[…${resources.length - 20} resources elided…]\n`;
		}
		md += "\n";
	}

	// Submodules
	if (mod.submodules && mod.submodules.length > 0) {
		md += `## Submodules (${mod.submodules.length})\n\n`;
		for (const sub of mod.submodules.slice(0, 10)) {
			md += `- **${sub.name}**: \`${sub.path}\`\n`;
		}
		if (mod.submodules.length > 10) {
			md += `\n[…${mod.submodules.length - 10} submodules elided…]\n`;
		}
	}

	return buildResult(md, { url, method: "terraform", fetchedAt, notes: ["Fetched via Terraform Registry API"] });
}

async function handleProviderUrl(
	url: string,
	namespace: string,
	type: string,
	timeout: number,
	signal: AbortSignal | undefined,
	fetchedAt: string,
): Promise<RenderResult | null> {
	const apiUrl = `https://registry.terraform.io/v1/providers/${namespace}/${type}`;
	const result = await loadPage(apiUrl, {
		timeout,
		signal,
		headers: { Accept: "application/json" },
	});

	if (!result.ok) return null;

	const provider = tryParseJson<TerraformProvider>(result.content);
	if (!provider) return null;

	let md = `# ${provider.namespace}/${provider.name}\n\n`;

	if (provider.description) md += `${provider.description}\n\n`;

	// Metadata
	md += `**Version:** ${provider.version}\n`;
	if (provider.tier) md += `**Tier:** ${provider.tier}\n`;
	md += `**Downloads:** ${formatNumber(provider.downloads)}\n`;
	if (provider.published_at) {
		md += `**Published:** ${new Date(provider.published_at).toLocaleDateString()}\n`;
	}
	if (provider.source) {
		md += `**Source:** ${provider.source}\n`;
	}
	md += "\n";

	// Usage example
	md += `## Usage\n\n\`\`\`hcl\nterraform {\n  required_providers {\n    ${provider.name} = {\n      source  = "${provider.namespace}/${provider.name}"\n      version = "~> ${provider.version}"\n    }\n  }\n}\n\nprovider "${provider.name}" {\n  # Configuration options\n}\n\`\`\`\n\n`;

	// Documentation summary
	if (provider.docs && provider.docs.length > 0) {
		const categories = new Map<string, typeof provider.docs>();
		for (const doc of provider.docs) {
			const cat = doc.category || "other";
			if (!categories.has(cat)) categories.set(cat, []);
			categories.get(cat)!.push(doc);
		}

		md += `## Documentation\n\n`;
		for (const [category, docs] of categories) {
			md += `### ${category.charAt(0).toUpperCase() + category.slice(1)} (${docs.length})\n\n`;
			for (const doc of docs.slice(0, 15)) {
				md += `- [${doc.title}](https://registry.terraform.io/providers/${namespace}/${type}/latest/docs/${doc.category}/${doc.slug})\n`;
			}
			if (docs.length > 15) {
				md += `\n[…${docs.length - 15} documents elided…]\n`;
			}
			md += "\n";
		}
	}

	return buildResult(md, { url, method: "terraform", fetchedAt, notes: ["Fetched via Terraform Registry API"] });
}
