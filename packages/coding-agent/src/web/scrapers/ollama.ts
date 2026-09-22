import { tryParseJson } from "@oh-my-pi/pi-utils";
import { formatBytes } from "@oh-my-pi/pi-tui/render/render-utils";
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
	"library",
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
	"pricing",
	"account",
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

function parseOllamaUrl(
	url: string,
): { modelRef: string; baseRef: string; pageUrl: string; shorthand: boolean } | null {
	try {
		const parsed = new URL(url);
		if (!VALID_HOSTNAMES.has(parsed.hostname)) return null;

		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length === 0) return null;

		if (parts[0] === "library" && parts.length >= 2) {
			const modelRef = decodeURIComponent(parts[1]);
			const baseRef = modelRef.split(":")[0] ?? modelRef;
			const pageUrl = `${parsed.origin}/${buildModelPath(["library", baseRef])}`;
			return { modelRef, baseRef, pageUrl, shorthand: false };
		}

		const baseRoot = parts[0].split(":")[0];
		// Single-segment shorthands (ollama.com/<model>) share the root
		// namespace with marketing routes, so a tags-first check in the
		// handler below confirms the candidate before fetching its page. A
		// missing model yields no tags match, which maps to null
		// (generic-scrape fallback).
		if (parts.length === 1 && !RESERVED_ROOTS.has(baseRoot)) {
			const modelRef = decodeURIComponent(parts[0]);
			const baseRef = modelRef.split(":")[0] ?? modelRef;
			const pageUrl = `${parsed.origin}/${buildModelPath(["library", baseRef])}`;
			return { modelRef, baseRef, pageUrl, shorthand: true };
		}

		if (parts.length >= 2 && !RESERVED_ROOTS.has(baseRoot)) {
			const namespace = decodeURIComponent(parts[0]);
			const model = decodeURIComponent(parts[1]);
			const modelBase = model.split(":")[0] ?? model;
			const modelRef = `${namespace}/${model}`;
			const baseRef = `${namespace}/${modelBase}`;
			const pageUrl = `${parsed.origin}/${buildModelPath([namespace, modelBase])}`;
			return { modelRef, baseRef, pageUrl, shorthand: false };
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

function matchTagsModels(baseRef: string, tagsIndex: OllamaTagModel[] | null): OllamaTagModel[] {
	const baseLower = baseRef.toLowerCase();
	return (tagsIndex ?? []).filter(model => {
		const name = (model.model ?? model.name ?? "").toLowerCase();
		return name === baseLower || name.startsWith(`${baseLower}:`);
	});
}

function renderOllamaModel(args: {
	url: string;
	modelRef: string;
	baseRef: string;
	fetchedAt: string;
	tagsResult: { ok: boolean };
	matchingModels: OllamaTagModel[];
	pageResult: { ok: boolean; content: string; finalUrl: string };
}) {
	const { url, modelRef, baseRef, fetchedAt, tagsResult, matchingModels, pageResult } = args;
	const html = pageResult.ok ? pageResult.content : "";
	const description = html ? extractMetaDescription(html) : null;
	const htmlParameterSizes = html ? extractParameterSizes(html) : [];
	const htmlTags = html ? extractTagsFromHtml(html, baseRef) : [];

	if (!pageResult.ok && (!tagsResult.ok || matchingModels.length === 0)) {
		return null;
	}

	const tagRef = modelRef.includes(":") ? modelRef : null;
	const selectedTag = tagRef ? matchingModels.find(model => (model.model ?? model.name ?? "") === tagRef) : null;

	const availableTagsRaw = matchingModels.map(model => model.model ?? model.name ?? "").filter(tag => tag.length > 0);
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
}

export const handleOllama: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = parseOllamaUrl(url);
		if (!parsed) return null;
		const { modelRef, baseRef, pageUrl, shorthand } = parsed;
		const fetchedAt = new Date().toISOString();

		// Ambiguous single-segment shorthands share the root namespace with
		// marketing routes, so confirm them against the small (~5 KiB) tags
		// index before spending a page fetch on paths like /turbo. Only a
		// successfully parsed index with a models array can reject; a failed
		// fetch or malformed payload falls through to the page. Canonical
		// and namespaced URLs fetch tags and page in parallel to preserve
		// the timeout budget — each loadPage gets the full allowance, so
		// awaiting tags first would double the worst-case latency there.
		const tagsUrl = "https://ollama.com/api/tags";
		const tagsOptions = { timeout, signal, headers: { Accept: "application/json" } };
		const parseTagsIndex = (tagsResult: { ok: boolean; content: string }) => {
			const tagsData = tagsResult.ok ? tryParseJson<OllamaTagsResponse>(tagsResult.content) : null;
			return Array.isArray(tagsData?.models) ? tagsData.models : null;
		};

		if (shorthand) {
			const tagsResult = await loadPage(tagsUrl, tagsOptions);
			const tagsIndex = parseTagsIndex(tagsResult);
			const matchingModels = matchTagsModels(baseRef, tagsIndex);
			if (tagsIndex && matchingModels.length === 0) return null;
			// A tagged shorthand names an exact tag; reject when the parsed
			// index lists the model but not the requested tag, instead of
			// rendering aggregate metadata under a nonexistent tag.
			const tagRef = modelRef.includes(":") ? modelRef.toLowerCase() : null;
			const tagKnown =
				!tagRef || matchingModels.some(model => (model.model ?? model.name ?? "").toLowerCase() === tagRef);
			if (tagsIndex && !tagKnown) return null;
			const pageResult = await loadPage(pageUrl, { timeout, signal });
			return renderOllamaModel({ url, modelRef, baseRef, fetchedAt, tagsResult, matchingModels, pageResult });
		}

		const [tagsResult, pageResult] = await Promise.all([
			loadPage(tagsUrl, tagsOptions),
			loadPage(pageUrl, { timeout, signal }),
		]);
		const matchingModels = matchTagsModels(baseRef, parseTagsIndex(tagsResult));
		return renderOllamaModel({ url, modelRef, baseRef, fetchedAt, tagsResult, matchingModels, pageResult });
	} catch {}

	return null;
};
