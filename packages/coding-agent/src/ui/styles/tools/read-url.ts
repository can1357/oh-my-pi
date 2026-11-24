/**
 * `read-url`: a URL read. Pending: one status row (`⏳ Read: domain /path`).
 * Settled: a frame headed by the outcome, a `Metadata` section (content
 * type, method, final URL, size, truncation, notes) and a `Content Preview`
 * of the first non-empty lines (3 collapsed, 12 expanded). Errors: an
 * error-tinted frame over the message.
 *
 * Reads {@link ReadUrlTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { formatFullOutputReference } from "../../../tools/output-meta-format";
import type { ReadUrlTerm } from "../../tools/read-url";
import { webLink } from "./file-common";
import { expandHint, frameRows, outcomeBg, statusIcon, statusLine } from "./frame";
import { defineToolLook, isExpanded, toolProps } from "./look";

/** Display lines of untrusted text: CR progress collapsed to its last segment, tabs expanded. */
function displayLines(text: string): string[] {
	return text.split(/\r?\n/).map(line => {
		const at = line.lastIndexOf("\r");
		return replaceTabs(sanitizeText(at < 0 ? line : line.slice(at + 1)));
	});
}

function paintReadUrl(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as Partial<ReadUrlTerm> | undefined;
	const theme = cx.theme;
	const width = cx.width;
	const description = term?.description ? webLink(cx, term.description, term.link) : undefined;
	if (!term || term.phase === "call") {
		const line = statusLine(theme, {
			glyph: statusIcon(cx, "pending"),
			title: "Read",
			...(description ? { description } : {}),
			...(term?.raw ? { meta: ["raw"] } : {}),
		});
		return { rows: wrap(line, width) };
	}
	if (term.phase === "error") {
		return {
			rows: frameRows(theme, width, {
				head: statusLine(theme, {
					glyph: statusIcon(cx, "error"),
					title: "Read",
					...(description ? { description } : {}),
				}),
				sections: [{ lines: displayLines(term.error ?? "").map(line => theme.fg("error", line)) }],
				border: "error",
				bg: outcomeBg("error"),
			}),
		};
	}
	const truncated = term.truncated === true;
	const muted = (text: string): string => theme.fg("muted", text);
	const metadata = [`${muted("Content-Type:")} ${term.contentType}`, `${muted("Method:")} ${term.method}`];
	if (term.redirected)
		metadata.push(`${muted("Final URL:")} ${webLink(cx, theme.fg("mdLinkUrl", term.finalUrl ?? ""), term.finalUrl)}`);
	const lineCount = term.lineCount ?? 0;
	metadata.push(`${muted("Lines:")} ${lineCount} line${lineCount === 1 ? "" : "s"}`);
	metadata.push(`${muted("Chars:")} ${term.charCount ?? 0}`);
	if (truncated) {
		metadata.push(`${statusIcon(cx, "warning")} ${theme.fg("warning", "Output truncated")}`);
		if (term.artifactId) metadata.push(theme.fg("warning", formatFullOutputReference(term.artifactId)));
	}
	if (term.notes && term.notes.length > 0) metadata.push(`${muted("Notes:")} ${term.notes.join("; ")}`);
	const expanded = isExpanded(props);
	const lines = term.lines ?? [];
	const limit = expanded ? 12 : 3;
	const shown = lines
		.slice(0, limit)
		.flatMap(displayLines)
		.map(line => line.trimEnd());
	const preview = shown.length > 0 ? shown.map(line => theme.fg("dim", line)) : [theme.fg("dim", "(no content)")];
	const remaining = Math.max(0, lines.length - Math.min(lines.length, limit));
	if (remaining > 0) preview.push(muted(`… ${remaining} more lines${expanded ? "" : ` ${expandHint(theme)}`}`));
	return {
		rows: frameRows(theme, width, {
			head: statusLine(theme, {
				glyph: statusIcon(cx, truncated ? "warning" : "success"),
				title: "Read",
				...(description ? { description } : {}),
			}),
			sections: [
				{ label: theme.fg("toolTitle", "Metadata"), lines: metadata },
				{ label: theme.fg("toolTitle", "Content Preview"), lines: preview },
			],
			border: truncated ? "warning" : "dim",
		}),
	};
}

defineToolLook("read-url", { paint: paintReadUrl, margin: true });
