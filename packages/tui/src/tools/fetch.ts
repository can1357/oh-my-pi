import { isReadableUrlPath, readSelectorRangeStart } from "./read";
import type { Component } from "../tui";
import { Text } from "../components/text";
import type { RenderResultOptions } from "./renderer";
import { type Theme, theme } from "../theme/theme";
import type { OutputMeta } from "./output-meta";
import { truncate } from "@oh-my-pi/pi-utils";
import { renderStatusLine, urlHyperlink } from "../render";
import { framedToolCard } from "../render/tool-card";
import { formatExpandHint, getDomain, sanitizeDisplayLines } from "../render/render-utils";
import { applyListLimit } from "./list-limit";
import { formatStyledArtifactReference } from "./output-meta";

/** Display metadata for fetch tool results. */
export interface ReadUrlToolDetails {
	kind: "url";
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	meta?: OutputMeta;
}

// =============================================================================
// TUI Rendering
// =============================================================================

/** Restore the double slash in a collapsed HTTP URL scheme. */
export function repairCollapsedScheme(value: string): string {
	const m = value.match(/^(https?):\/(?!\/)/i);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

/** Recognize a valid raw, tail, or line-range URL selector token. */
function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	if (/^-\d+$/.test(token)) return Number.parseInt(token.slice(1), 10) > 0;
	return readSelectorRangeStart(token) !== undefined;
}

/**
 * Peel one or more selector tokens off the right of a URL string. Walks back through
 * trailing `:tok` segments while each token (a) looks like a selector and (b) leaves
 * behind a string that still parses as a URL. Returns selectors left-to-right so callers
 * can apply them in source order.
 */
export function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sels: string[] } | null {
	let basePath = readPath;
	const sels: string[] = [];
	while (true) {
		const lastColonIndex = basePath.lastIndexOf(":");
		if (lastColonIndex <= 0) break;

		const candidate = basePath.slice(lastColonIndex + 1);
		const remainder = basePath.slice(0, lastColonIndex);
		if (!isReadableUrlPath(remainder)) break;
		if (!isUrlSelectorToken(candidate)) break;

		try {
			new URL(
				remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`,
			);
		} catch {
			break;
		}

		sels.unshift(candidate);
		basePath = remainder;
	}
	if (sels.length === 0) return null;
	return { path: basePath, sels };
}

/** Count non-empty lines */
function countNonEmptyLines(text: string): number {
	return text.split("\n").filter(l => l.trim()).length;
}

function readUrlLinkTarget(input: string): string {
	try {
		const repaired = repairCollapsedScheme(input);
		const embedded = tryExtractEmbeddedUrlSelector(repaired);
		if (embedded && embedded.sels.filter(token => token.toLowerCase() !== "raw").length > 1) return input;
		return embedded?.path ?? repaired;
	} catch {
		return input;
	}
}

function formatReadUrlDescription(input: string): string {
	const target = readUrlLinkTarget(input);
	const displayUrl = target.match(/^www\./i) ? `https://${target}` : target;
	const domain = getDomain(displayUrl);
	const urlPath = truncate(displayUrl.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	const label = `${domain}${urlPath ? ` ${urlPath}` : ""}`.trim();
	return urlHyperlink(target, label);
}

function formatReadUrlMetadataValue(url: string, uiTheme: Theme): string {
	return urlHyperlink(url, uiTheme.fg("mdLinkUrl", url));
}

/** Render URL read call (URL preview) */
export function renderReadUrlCall(
	args: { path?: string; url?: string; raw?: boolean },
	_options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const url = args.path ?? args.url ?? "";
	const description = formatReadUrlDescription(url);
	const meta: string[] = [];
	if (args.raw) meta.push("raw");
	const text = renderStatusLine({ icon: "pending", title: "Read", description, meta }, uiTheme);
	return new Text(text, 0, 0);
}

/** Render URL read result with tree-based layout */
export function renderReadUrlResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ReadUrlToolDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const details = result.details;

	if (result.isError || !details) {
		const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
		const errorText = (rawErrorText || "No response data").replace(/^Error:\s*/, "");
		const urlText = details?.finalUrl ?? details?.url ?? "";
		const description = urlText ? formatReadUrlDescription(urlText) : undefined;
		const header = renderStatusLine({ icon: "error", title: "Read", description }, uiTheme);
		const errorLines = sanitizeDisplayLines(errorText).map(line => uiTheme.fg("error", line));
		return framedToolCard(uiTheme, () => ({
			header,
			phase: "error",
			sections: [{ content: errorLines }],
		}));
	}

	const description = formatReadUrlDescription(details.finalUrl);
	const hasRedirect = details.url !== details.finalUrl;
	const hasNotes = details.notes.length > 0;
	const truncation = details.meta?.truncation;
	const truncated = Boolean(details.truncated || truncation);

	const header = renderStatusLine(
		{
			icon: truncated ? "warning" : "success",
			title: "Read",
			description,
		},
		uiTheme,
	);

	const contentText = result.content[0]?.text ?? "";
	const contentBody = contentText.includes("---\n\n")
		? contentText.split("---\n\n").slice(1).join("---\n\n")
		: contentText;
	const lineCount = countNonEmptyLines(contentBody);
	const charCount = contentBody.trim().length;
	const contentLines = contentBody.split("\n").filter(l => l.trim());

	const metadataLines: string[] = [
		`${uiTheme.fg("muted", "Content-Type:")} ${details.contentType || "unknown"}`,
		`${uiTheme.fg("muted", "Method:")} ${details.method}`,
	];
	if (hasRedirect) {
		metadataLines.push(
			`${uiTheme.fg("muted", "Final URL:")} ${formatReadUrlMetadataValue(details.finalUrl, uiTheme)}`,
		);
	}
	const lineLabel = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
	metadataLines.push(`${uiTheme.fg("muted", "Lines:")} ${lineLabel}`);
	metadataLines.push(`${uiTheme.fg("muted", "Chars:")} ${charCount}`);
	if (truncated) {
		metadataLines.push(uiTheme.fg("warning", `${uiTheme.status.warning} Output truncated`));
		if (truncation?.artifactId) metadataLines.push(formatStyledArtifactReference(truncation.artifactId, uiTheme));
	}
	if (hasNotes) {
		metadataLines.push(`${uiTheme.fg("muted", "Notes:")} ${details.notes.join("; ")}`);
	}

	let lastExpanded: boolean | undefined;
	let contentPreviewLines: string[] | undefined;
	return framedToolCard(
		uiTheme,
		() => {
			const { expanded } = options;

			if (contentPreviewLines === undefined || lastExpanded !== expanded) {
				const previewLimit = expanded ? 12 : 3;
				const previewList = applyListLimit(contentLines, { headLimit: previewLimit });
				const previewLines = previewList.items
					.flatMap(line => sanitizeDisplayLines(line))
					.map(line => line.trimEnd());
				const remaining = Math.max(0, contentLines.length - previewList.items.length);
				contentPreviewLines =
					previewLines.length > 0
						? previewLines.map(line => uiTheme.fg("dim", line))
						: [uiTheme.fg("dim", "(no content)")];
				if (remaining > 0) {
					const hint = formatExpandHint(uiTheme, expanded, true);
					contentPreviewLines.push(uiTheme.fg("muted", `… ${remaining} more lines${hint ? ` ${hint}` : ""}`));
				}
				lastExpanded = expanded;
			}

			return {
				header,
				phase: truncated ? "warning" : "success",
				sections: [
					{ label: uiTheme.fg("toolTitle", "Metadata"), content: metadataLines },
					{ label: uiTheme.fg("toolTitle", "Content Preview"), content: contentPreviewLines },
				],
				applyBg: false,
			};
		},
		{
			onInvalidate: () => {
				lastExpanded = undefined;
				contentPreviewLines = undefined;
			},
		},
	);
}
