import { tryParseJson } from "@oh-my-pi/pi-utils";
import { formatBytes } from "../../tools/render-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, decodeHtmlEntities, loadPage } from "./types";

interface OllamaTagDetails {
	parent_model?: string;
	format?: string;
	family?: string;
	families?: string[] | null;
	parameter_size?: string;
	quantization_level?: string;
}

interface OllamaTagModel {
	name?: string;
	model?: string;
	modified_at?: string;
	size?: number;
	digest?: string;
	details?: OllamaTagDetails;
}

interface OllamaTagsResponse {
	models?: OllamaTagModel[];
}

const VALID_HOSTNAMES = new Set(["ollama.com", "www.ollama.com"]);
const RESERVED_ROOTS = new Set([
	"models",
	"blog",
	"docs",
	"download",
	"cloud",
	"signin",
	"signout",
	"search",
	"api",
	"terms",
	"privacy",
	"license",
	"settings",
]);

function extractMetaDescription(html: string): string | null {
	const patterns = [
		/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i,
		/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
		/<meta[^>]+property=["']twitter:description["'][^>]*content=["']([^"']+)["']/i,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) {
			return decodeHtmlEntities(match[1].trim());
		}
	}

	return null;
}

function extractParameterSizes(html: string): string[] {
	const sizes = new Set<string>();
	const pattern = /x-test-size[^>]*>([^<]+)<\/span>/gi;
	let match = pattern.exec(html);
	while (match) {
		const raw = match[1]?.trim();
		if (raw) {
			sizes.add(raw.toUpperCase());
		}
		match = pattern.exec(html);
	}

	return Array.from(sizes);
}

function extractTagsFromHtml(html: string, baseRef: string): string[] {
	const tags = new Set<string>();
	const pattern = /href=["']\/library\/([^"']+)["']/gi;
	let match = pattern.exec(html);
	while (match) {
		const raw = match[1]?.trim();
		if (raw) {
			const decoded = decodeHtmlEntities(raw);
			if (decoded === baseRef || decoded.startsWith(`${baseRef}:`)) {
				tags.add(decoded);
			}
		}
		match = pattern.exec(html);
	}

	return Array.from(tags);
}

function buildModelPath(parts: string[]): string {
	return parts.map(part => encodeURIComponent(part)).join("/");
}

function parseOllamaUrl(url: string): { modelRef: string; baseRef: string; pageUrl: string } | null {
	try {
		const parsed = new URL(url);
		if (!VALID_HOSTNAMES.has(parsed.hostname)) return null;

		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length === 0) return null;

		if (parts[0] === "library" && parts.length >= 2) {
			const modelRef = decodeURIComponent(parts[1]);
			const baseRef = modelRef.split(":")[0] ?? modelRef;
			const pageUrl = `${parsed.origin}/${buildModelPath(["library", baseRef])}`;
			return { modelRef, baseRef, pageUrl };
		}

		if (parts.length >= 2 && !RESERVED_ROOTS.has(parts[0])) {
			const namespace = decodeURIComponent(parts[0]);
			const model = decodeURIComponent(parts[1]);
			const modelBase = model.split(":")[0] ?? model;
			const modelRef = `${namespace}/${model}`;
			const baseRef = `${namespace}/${modelBase}`;
			const pageUrl = `${parsed.origin}/${buildModelPath([namespace, modelBase])}`;
			return { modelRef, baseRef, pageUrl };
		}
	} catch {}

	return null;
}

function sortTags(tags: string[]): string[] {
	return tags.sort((a, b) => {
		const aLatest = a.endsWith(":latest");
		const bLatest = b.endsWith(":latest");
		if (aLatest && !bLatest) return -1;
		if (!aLatest && bLatest) return 1;
		return a.localeCompare(b);
	});
}

function formatTagList(tags: string[], maxItems: number): string {
	const limited = tags.slice(0, maxItems);
	const formatted = limited.map(tag => `\`${tag}\``).join(", ");
	if (tags.length > maxItems) {
		return `${formatted} […${tags.length - maxItems} tags elided…]`;
	}
	return formatted;
}

function collectParameterSizes(models: OllamaTagModel[], htmlSizes: string[]): string[] {
	const sizes = new Set<string>();
	for (const model of models) {
		const param = model.details?.parameter_size?.trim();
		if (param) sizes.add(param.toUpperCase());
	}
	for (const size of htmlSizes) {
		sizes.add(size);
	}
	return Array.from(sizes);
}

export const handleOllama: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = parseOllamaUrl(url);
		if (!parsed) return null;

		const { modelRef, baseRef, pageUrl } = parsed;
		const fetchedAt = new Date().toISOString();

		const tagsUrl = "https://ollama.com/api/tags";
		const [tagsResult, pageResult] = await Promise.all([
			loadPage(tagsUrl, { timeout, signal, headers: { Accept: "application/json" } }),
			loadPage(pageUrl, { timeout, signal }),
		]);

		const tagsData = tagsResult.ok ? tryParseJson<OllamaTagsResponse>(tagsResult.content) : null;

		const html = pageResult.ok ? pageResult.content : "";
		const description = html ? extractMetaDescription(html) : null;
		const htmlParameterSizes = html ? extractParameterSizes(html) : [];
		const htmlTags = html ? extractTagsFromHtml(html, baseRef) : [];

		const baseLower = baseRef.toLowerCase();
		const models = tagsData?.models ?? [];
		const matchingModels = models.filter(model => {
			const name = (model.model ?? model.name ?? "").toLowerCase();
			return name === baseLower || name.startsWith(`${baseLower}:`);
		});

		const tagRef = modelRef.includes(":") ? modelRef : null;
		const selectedTag = tagRef ? matchingModels.find(model => (model.model ?? model.name ?? "") === tagRef) : null;

		const availableTagsRaw = matchingModels
			.map(model => model.model ?? model.name ?? "")
			.filter(tag => tag.length > 0);
		const availableTags = sortTags(Array.from(new Set(availableTagsRaw)));

		const fallbackTags = sortTags(Array.from(new Set(htmlTags)));
		const tagsToUse = availableTags.length > 0 ? availableTags : fallbackTags;

		const parameterSizes = collectParameterSizes(selectedTag ? [selectedTag] : matchingModels, htmlParameterSizes);

		const sizes = matchingModels.map(model => model.size).filter((size): size is number => typeof size === "number");
		let sizeLine: string | null = null;

		if (selectedTag?.size) {
			sizeLine = formatBytes(selectedTag.size);
		} else if (sizes.length > 0) {
			const minSize = Math.min(...sizes);
			const maxSize = Math.max(...sizes);
			sizeLine = minSize === maxSize ? formatBytes(minSize) : `${formatBytes(minSize)} - ${formatBytes(maxSize)}`;
		}

		let md = `# ${baseRef}\n\n`;
		if (description) md += `${description}\n\n`;

		md += `**Model:** ${baseRef}\n`;
		if (tagRef) md += `**Tag:** ${tagRef}\n`;
		if (parameterSizes.length > 0) md += `**Parameters:** ${parameterSizes.join(", ")}\n`;
		if (sizeLine) {
			const label = sizeLine.includes(" - ") ? "Size Range" : "Size";
			md += `**${label}:** ${sizeLine}\n`;
		}
		if (tagsToUse.length > 0) {
			md += `**Available Tags:** ${formatTagList(tagsToUse, 40)}\n`;
		}

		return buildResult(md, {
			url,
			finalUrl: pageResult.ok ? pageResult.finalUrl : url,
			method: "ollama",
			fetchedAt,
			notes: ["Fetched via Ollama API"],
		});
	} catch {}

	return null;
};
