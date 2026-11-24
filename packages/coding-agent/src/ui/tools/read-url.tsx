/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `read` tool's view of an http(s) URL: the head links `domain /path`;
 * the result previews the page's non-empty lines over one quiet stats line
 * (content type, method, size, notes) and a truncation notice.
 *
 * Terminal look: `read-url` (`src/ui/styles/tools/read-url.ts`), fed by {@link ReadUrlTerm}.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { TspText } from "@oh-my-pi/pi-wire";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { parseLineRanges } from "../../tools/line-ranges";
import { formatFullOutputReference, type OutputMeta } from "../../tools/output-meta-format";
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { NoteText } from "./run";

/** Read-of-URL result details. */
export interface ReadUrlDetails {
	readonly kind: "url";
	readonly url: string;
	readonly finalUrl: string;
	readonly contentType: string;
	readonly method: string;
	readonly raw?: boolean;
	readonly truncated: boolean;
	readonly notes: readonly string[];
	readonly meta?: OutputMeta;
}

interface ReadUrlArgs {
	readonly path?: string;
	readonly url?: string;
	readonly raw?: boolean;
}

/** Terminal-only facts of a URL read (`term`). */
export interface ReadUrlTerm {
	readonly look: "read-url";
	/** `domain /path` (path cut to 50 cells) of the head. */
	readonly description: string;
	/** The URL the description links to. */
	readonly link?: string;
	readonly phase: "call" | "error" | "result";
	readonly raw?: boolean;
	/** The error's message lines. */
	readonly error?: string;
	readonly truncated?: boolean;
	readonly redirected?: boolean;
	readonly finalUrl?: string;
	readonly contentType?: string;
	readonly method?: string;
	readonly lineCount?: number;
	readonly charCount?: number;
	readonly artifactId?: string;
	readonly notes?: readonly string[];
	/** Non-empty content lines. */
	readonly lines?: readonly string[];
}

/** Lines the preview text shows. */
const PREVIEW_LINES = 12;

/** Whether `value` reads as an http(s) URL (`https://…`, `www.…`). */
export function isReadableUrlPath(value: string): boolean {
	return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

/** Restore the double slash of a collapsed `http:/x` scheme. */
function repairScheme(value: string): string {
	const match = value.match(/^(https?):\/(?!\/)/i);
	return match ? `${match[1]}://${value.slice(match[0].length)}` : value;
}

function isSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	if (/^-\d+$/.test(token)) return Number.parseInt(token.slice(1), 10) > 0;
	try {
		const start = parseLineRanges(token)?.[0].startLine;
		return start !== undefined && Number.isFinite(start);
	} catch {
		return false;
	}
}

/** Trailing `:selector` tokens of a URL path (`raw`, `-20`, `10-20`), left to right. */
function embeddedSelectors(value: string): { path: string; sels: string[] } | undefined {
	let base = value;
	const sels: string[] = [];
	while (true) {
		const at = base.lastIndexOf(":");
		if (at <= 0) break;
		const token = base.slice(at + 1);
		const rest = base.slice(0, at);
		if (!isReadableUrlPath(rest) || !isSelectorToken(token)) break;
		try {
			new URL(rest.startsWith("http://") || rest.startsWith("https://") ? rest : `https://${rest}`);
		} catch {
			break;
		}
		sels.unshift(token);
		base = rest;
	}
	return sels.length > 0 ? { path: base, sels } : undefined;
}

/** The URL a read targets (selectors peeled off unless several real ones apply). */
function linkTarget(input: string): string {
	const repaired = repairScheme(input);
	const embedded = embeddedSelectors(repaired);
	if (embedded && embedded.sels.filter(token => token.toLowerCase() !== "raw").length > 1) return input;
	return embedded?.path ?? repaired;
}

/** A URL's host without `www.` (the input when it does not parse). */
export function urlDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function plain(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** `domain /path`, the path cut to `maxPath` characters (none: whole). */
function urlLabel(input: string, maxPath?: number): { label: string; target: string } {
	const target = linkTarget(input);
	const display = /^www\./i.test(target) ? `https://${target}` : target;
	let path = display.replace(/^https?:\/\/[^/]+/, "");
	if (maxPath !== undefined && path.length > maxPath) path = `${path.slice(0, maxPath - 1)}…`;
	return { label: `${urlDomain(display)}${path ? ` ${path}` : ""}`.trim(), target };
}

/** The terminal head's `domain /path` (path cut to 50) and the URL it links to. */
function termLabel(input: string): Pick<ReadUrlTerm, "description" | "link"> {
	const { label, target } = urlLabel(input, 50);
	return target ? { description: label, link: target } : { description: label };
}

function urlHead(input: string, meta: readonly string[] = []): ToolHead {
	const link = input ? urlLabel(input) : undefined;
	const label = link ? plain(link.label) || link.target : "";
	return {
		title: "Read",
		...(label ? { target: label } : {}),
		targetKind: "text",
		...(link ? { href: link.target } : {}),
		...(meta.length > 0 ? { meta } : {}),
	};
}

function ErrorText(props: { readonly message: string }): JSXNode {
	const body = plain(props.message).trim();
	if (body.includes("\n") && /^[{[]/.test(body))
		return <code text={body} lang="json" tone="error" role="omp.tool.error" />;
	return <text spans={[{ t: body, s: "error" }]} wrap="word" role="omp.tool.error" />;
}

/** The page body after a `---` front block, when there is one. */
function contentBody(text: string): string {
	return text.includes("---\n\n") ? text.split("---\n\n").slice(1).join("---\n\n") : text;
}

export const readUrlPresenter: ToolPresenter<ReadUrlArgs, ReadUrlDetails> = {
	call(args): ToolView {
		const input = args.path ?? args.url ?? "";
		return {
			head: urlHead(input, args.raw ? ["raw"] : []),
			inline: true,
			term: {
				look: "read-url",
				phase: "call",
				...termLabel(input),
				...(args.raw ? { raw: true } : {}),
			} satisfies ReadUrlTerm,
		};
	},
	result(result): ToolView {
		const details = result.details;
		if (result.isError || !details) {
			const url = details?.finalUrl ?? details?.url ?? "";
			const raw = result.content.find(block => block.type === "text")?.text ?? "";
			const message = (raw || "No response data").replace(/^Error:\s*/, "");
			return {
				head: urlHead(url),
				tone: "error",
				body: (
					<ErrorText
						message={
							plain(resultText(result) || "No response data")
								.replace(/^Error:\s*/, "")
								.trim() || "Read failed"
						}
					/>
				),
				term: {
					look: "read-url",
					phase: "error",
					...(url ? termLabel(url) : { description: "" }),
					error: message,
				} satisfies ReadUrlTerm,
			};
		}
		const truncation = details.meta?.truncation;
		const truncated = Boolean(details.truncated || truncation);
		const body = contentBody(result.content[0]?.text ?? "");
		const lines = body.split("\n").filter(line => line.trim());
		const shown = lines.slice(0, PREVIEW_LINES);
		const hidden = lines.length - shown.length;
		const redirected = details.url !== details.finalUrl;
		const stats = [
			plain(details.contentType || "unknown"),
			details.method ? plain(details.method) : "",
			`${lines.length} line${lines.length === 1 ? "" : "s"}`,
			`${body.trim().length} chars`,
			hidden > 0 ? `… ${hidden} more ${hidden === 1 ? "line" : "lines"}` : "",
			...details.notes.map(note => plain(note)),
		].filter(Boolean);
		const notice: TspText | undefined = truncated
			? truncation?.artifactId
				? `Output truncated · ${formatFullOutputReference(truncation.artifactId)}`
				: "Output truncated"
			: undefined;
		return {
			head: urlHead(details.finalUrl, redirected ? [`from ${plain(urlDomain(details.url))}`] : []),
			...(truncated ? { tone: "warning" as const } : {}),
			body: [
				shown.length > 0 ? (
					<text spans={[{ t: plain(shown.map(line => line.trimEnd()).join("\n")), s: "dim" }]} wrap="word" />
				) : (
					<NoteText text="(no content)" />
				),
				stats.length > 0 && (
					<text spans={[{ t: stats.join(" · "), s: "muted" }]} wrap="word" role="omp.tool.stats" />
				),
				notice !== undefined && (
					<text spans={[{ t: notice as string, s: "warning" }]} wrap="word" role="omp.tool.notice" />
				),
			],
			term: {
				look: "read-url",
				phase: "result",
				...termLabel(details.finalUrl),
				truncated,
				redirected,
				finalUrl: details.finalUrl,
				contentType: details.contentType || "unknown",
				method: details.method,
				lineCount: lines.length,
				charCount: body.trim().length,
				...(truncation?.artifactId ? { artifactId: truncation.artifactId } : {}),
				notes: details.notes,
				lines,
			} satisfies ReadUrlTerm,
		};
	},
};
