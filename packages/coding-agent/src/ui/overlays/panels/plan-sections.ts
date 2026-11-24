/**
 * A plan's Markdown as sections: the text before the first heading (the
 * preamble, level 0) and one section per ATX heading outside code fences.
 * Each section keeps its exact source, so joining them gives the plan back.
 */

/** One section of a plan. */
export interface PlanSection {
	/** 0 for the preamble, else the heading depth (1–6). */
	readonly level: number;
	/** The heading's text without inline Markdown ("" for the preamble). */
	readonly title: string;
	/** The section's source, its heading line and trailing blank lines included. */
	readonly raw: string;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * `text` with inline Markdown (links, images, autolinks, code, emphasis,
 * strikethrough) reduced to its words, runs of blanks collapsed. With
 * `keepIntrawordUnderscores`, `_` marks emphasis only at word edges.
 */
export function stripInlineMarkdown(text: string, options: { keepIntrawordUnderscores?: boolean } = {}): string {
	let out = text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
		.replace(/<([^>\s]+)>/g, "$1")
		.replace(/`([^`]+)`/g, "$1");
	if (options.keepIntrawordUnderscores) {
		out = out
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.replace(/(?<![\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_])/gu, "$1")
			.replace(/\*(.+?)\*/g, "$1")
			.replace(/(?<![\p{L}\p{N}_])_(.+?)_(?![\p{L}\p{N}_])/gu, "$1");
	} else {
		out = out.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(\*|_)(.+?)\1/g, "$2");
	}
	return out
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** The sections of `text`; their sources joined give `text` back. */
export function parsePlanSections(text: string): PlanSection[] {
	const lines = text.split("\n");
	const heads: { start: number; level: number; title: string }[] = [];
	let fence: { char: string; length: number } | undefined;
	let offset = 0;
	for (const line of lines) {
		const start = offset;
		offset += line.length + 1;
		const run = FENCE.exec(line);
		if (fence) {
			if (run && run[1]![0] === fence.char && run[1]!.length >= fence.length && run[2]!.trim() === "")
				fence = undefined;
			continue;
		}
		if (run) {
			fence = { char: run[1]![0]!, length: run[1]!.length };
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) heads.push({ start, level: heading[1]!.length, title: stripInlineMarkdown(heading[2]!) });
	}
	const sections: PlanSection[] = [];
	const first = heads[0]?.start ?? text.length;
	if (first > 0) sections.push({ level: 0, title: "", raw: text.slice(0, first) });
	heads.forEach((head, i) => {
		sections.push({
			level: head.level,
			title: head.title,
			raw: text.slice(head.start, heads[i + 1]?.start ?? text.length),
		});
	});
	return sections;
}

/** The sections' sources joined, ending in one newline (empty stays empty). */
export function joinPlanSections(sections: readonly PlanSection[]): string {
	const joined = sections.map(section => section.raw).join("");
	return joined === "" || joined.endsWith("\n") ? joined : `${joined}\n`;
}

/** Indices removed with section `index`: it and the deeper sections under it (none for the preamble). */
export function sectionDeletionSpan(sections: readonly PlanSection[], index: number): number[] {
	const target = sections[index];
	if (!target || target.level === 0) return [];
	const span = [index];
	for (let next = index + 1; next < sections.length && sections[next]!.level > target.level; next++) span.push(next);
	return span;
}
