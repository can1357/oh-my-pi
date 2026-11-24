/**
 * How the dialog lays a form out as questions: the intro (sections of
 * context alone before the first question, shown above every question) and
 * the question groups, one per `<fieldset>` holding fields and one per field
 * of loose content between fieldsets, each with the context before it.
 * Later sections of context alone join the next group, or the last one when
 * nothing follows.
 */
import type { FormBlock, FormField, HtmlForm } from "../../../tools/html-form/parse";
import { spansText } from "../../../tools/html-form/parse";

/** Blocks `start` up to `end` (exclusive) of one form section. */
export interface FormPart {
	readonly section: number;
	readonly start: number;
	readonly end: number;
}

/** A question group: the section parts it shows while open, and its fields (by form index). */
export interface FormGroup {
	readonly index: number;
	readonly parts: readonly FormPart[];
	readonly fields: readonly number[];
}

/** A form as the dialog shows it. */
export interface FormLayout {
	/** Context above every question group. */
	readonly intro: readonly FormPart[];
	readonly groups: readonly FormGroup[];
}

/** Lay `form` out as its intro and question groups. */
export function formLayout(form: HtmlForm): FormLayout {
	const intro: FormPart[] = [];
	const groups: { parts: FormPart[]; fields: number[] }[] = [];
	let lead: FormPart[] = [];
	form.sections.forEach((section, index) => {
		const end = section.blocks.length;
		if (!section.blocks.some(block => block.kind === "field")) {
			(groups.length === 0 ? intro : lead).push({ section: index, start: 0, end });
			return;
		}
		// Where each question of this section ends: after each loose field, the last one at the section's
		// end. A group's question also keeps the text between its options, unless its options straddle the
		// next field: then that field keeps the context before it. A field the keyboard cannot reach (only
		// disabled options) is no question of its own: it joins the next one.
		const fieldBlocks = section.blocks.flatMap((block, at) =>
			block.kind === "field" ? [{ at, through: Math.max(at + 1, block.optionsEnd ?? 0), field: block.field }] : [],
		);
		const cuts = section.fieldset
			? []
			: fieldBlocks.flatMap(({ at, through, field }, nth) => {
					// A text field, or a choice with an enabled option or an Other answer.
					const reachable = field.kind === "text" || field.other || field.options.some(option => !option.disabled);
					if (!reachable) return [];
					return [through <= (fieldBlocks[nth + 1]?.at ?? end) ? through : at + 1];
				});
		if (cuts.length === 0) cuts.push(end);
		else cuts[cuts.length - 1] = end;
		let start = 0;
		for (const cut of cuts) {
			const fields = section.blocks
				.slice(start, cut)
				.flatMap(block => (block.kind === "field" ? [form.fields.indexOf(block.field)] : []));
			groups.push({ parts: [...lead, { section: index, start, end: cut }], fields });
			lead = [];
			start = cut;
		}
	});
	groups.at(-1)?.parts.push(...lead);
	return { intro, groups: groups.map((group, index) => ({ index, ...group })) };
}

/**
 * Whether `blocks[at]` is the caption of a folded field right after it (`question` gives a field's
 * question): the field shows it as its question, so drawn above it too it would read twice.
 */
export function isFoldCaption(
	blocks: readonly FormBlock[],
	at: number,
	focused: FormField | undefined,
	question: (field: FormField) => string | undefined,
): boolean {
	const block = blocks[at];
	const next = blocks[at + 1];
	return (
		block?.kind === "text" &&
		next?.kind === "field" &&
		next.field !== focused &&
		question(next.field) === spansText(block.spans).replace(/\s+/g, " ").trim()
	);
}
