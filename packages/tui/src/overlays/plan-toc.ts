/**
 * Pure heading/section parser for the plan-review overlay. It splits a plan's
 * markdown into a flat list of sections — a leading preamble (text before the
 * first heading) followed by one entry per ATX heading — preserving the exact
 * source bytes of each section so the overlay can render, reorder-free delete,
 * and round-trip the document without a full markdown re-render.
 *
 * No TUI dependencies: this module is unit-tested in isolation.
 */

/** ATX heading: 1-6 `#`, required whitespace, a title, optional closing `#`s. */
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** Opening/closing code fence run (``` or ~~~), allowing up to 3 lead spaces. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface PlanSection {
	/** `0` = preamble (no heading, no ToC entry); `1..6` = heading depth. */
	level: number;
	/** Plain-text heading label with inline markdown lightly stripped. */
	title: string;
	/** Exact source slice for this section, including its trailing newline(s). */
	raw: string;
}

/**
 * Collapse inline markdown emphasis/link/code syntax to readable text. This is
 * a deliberately light strip (not a full markdown render) just so ToC entries
 * read cleanly — `**Goal** & [docs](x)` becomes `Goal & docs`.
 */
export function stripInlineMarkdown(text: string): string {
	let out = text;
	// Images first (so the link pass below does not eat the `(url)`), then links.
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
	// Autolinks `<https://…>` keep their URL as the readable text.
	out = out.replace(/<([^>\s]+)>/g, "$1");
	// Inline code, then bold/italic/strikethrough emphasis runs.
	out = out.replace(/`([^`]+)`/g, "$1");
	out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
	out = out.replace(/(\*|_)(.+?)\1/g, "$2");
	out = out.replace(/~~(.+?)~~/g, "$1");
	return out.replace(/\s+/g, " ").trim();
}

/**
 * Split `text` into preamble + heading sections. `#` characters inside fenced
 * code blocks are never treated as headings. Concatenating every section's
 * `raw` reproduces the original text exactly.
 */
export function parsePlanSections(text: string): PlanSection[] {
	const lines = text.split("\n");
	// Character offset of each line start so section `raw` can slice the source.
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const offsets: number[] = new Array(lines.length);
	let cursor = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets[i] = cursor;
		cursor += lines[i]!.length + 1; // +1 for the "\n" join separator
	}

	// Heading line indices (start of each heading section), with metadata.
	const heads: { line: number; level: number; title: string }[] = [];
	let fenceChar: string | null = null;
	let fenceLen = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE_RE.exec(line);
		if (fenceChar === null) {
			if (fence) {
				fenceChar = fence[1]![0]!;
				fenceLen = fence[1]!.length;
			}
			// Opening-fence lines are body, not headings.
			if (fence) continue;
		} else {
			// Inside a fence: only a matching-or-longer run of the same char closes.
			if (fence && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLen && fence[2]!.trim() === "") {
				fenceChar = null;
				fenceLen = 0;
			}
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) {
			heads.push({ line: i, level: heading[1]!.length, title: stripInlineMarkdown(heading[2]!) });
		}
	}

	const sections: PlanSection[] = [];
	const sliceRaw = (startLine: number, endLine: number): string => {
		const startOffset = offsets[startLine]!;
		const endOffset = endLine < lines.length ? offsets[endLine]! : text.length;
		return text.slice(startOffset, endOffset);
	};

	// Preamble: everything before the first heading (only when non-empty).
	const firstHeadLine = heads.length > 0 ? heads[0]!.line : lines.length;
	if (firstHeadLine > 0) {
		const raw = sliceRaw(0, firstHeadLine);
		if (raw.length > 0) sections.push({ level: 0, title: "", raw });
	}

	for (let h = 0; h < heads.length; h++) {
		const head = heads[h]!;
		const endLine = h + 1 < heads.length ? heads[h + 1]!.line : lines.length;
		sections.push({ level: head.level, title: head.title, raw: sliceRaw(head.line, endLine) });
	}

	return sections;
}

/**
 * Concatenate every section's `raw` back into a single document and guarantee a
 * single trailing newline. Inverse of {@link parsePlanSections} for any input
 * that already ends with a newline.
 */
export function joinPlanSections(sections: readonly PlanSection[]): string {
	let joined = "";
	for (const section of sections) joined += section.raw;
	if (joined.length === 0) return "";
	return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/**
 * Indices to remove when deleting `sections[index]`: the heading itself plus
 * every following section nested deeper than it (its sub-headings). The
 * preamble (level 0) is never a deletion target and yields an empty span.
 */
export function sectionDeletionSpan(sections: readonly PlanSection[], index: number): number[] {
	const target = sections[index];
	if (!target || target.level === 0) return [];
	const span = [index];
	for (let j = index + 1; j < sections.length; j++) {
		if (sections[j]!.level > target.level) span.push(j);
		else break;
	}
	return span;
}
