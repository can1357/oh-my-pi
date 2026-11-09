/** `ask` — an HTML form posed to the user mid-run, answered with its form data. */
import type { ReactNode } from "react";
import { Badge, InvalidArg, Note, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, str, truncate } from "../util";

/** One named field's question and its answer text, as the TUI records them. */
interface AskAnswer {
	question: string;
	answer: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Text content of an HTML fragment: tags dropped, common entities decoded, whitespace folded. */
function htmlText(fragment: string): string {
	const decoded = fragment
		.replace(/<[^>]*>?/g, " ")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
			if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? entity;
			const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
			return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
		});
	return normalizeWs(decoded);
}

/**
 * Coarse outline of a (possibly still streaming) form without a DOM: fieldset
 * legends, else the captions and labels before its first control, plus how
 * many distinct named controls it has.
 */
function formOutline(html: string): { headings: string[]; fields: number } {
	const names = new Set<string>();
	for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>?/gi)) {
		const attrs = match[2] ?? "";
		if (/\btype\s*=\s*["']?(hidden|submit|button|reset|image)\b/i.test(attrs)) continue;
		const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
		const value = name?.[1] ?? name?.[2] ?? name?.[3];
		if (value) names.add(value);
	}
	const legends = [...html.matchAll(/<legend\b[^>]*>([\s\S]*?)(?:<\/legend>|$)/gi)]
		.map(match => htmlText(match[1] ?? ""))
		.filter(Boolean);
	if (legends.length > 0) return { headings: legends, fields: names.size };
	const first = /<(?:p|label|h[1-6])\b[^>]*>([\s\S]*?)(?:<(?:input|select|textarea|\/p|\/label|\/h[1-6])\b|$)/i.exec(
		html,
	);
	const caption = first ? htmlText(first[1] ?? "") : "";
	return { headings: caption ? [caption] : [], fields: names.size };
}

/** Answers from `result.details`; null when the result carries none (error, cancel, older sessions). */
function answersOf(details: Record<string, unknown> | null): AskAnswer[] | null {
	if (!details || !Array.isArray(details.answers)) return null;
	const out: AskAnswer[] = [];
	for (const entry of details.answers) {
		if (!isRecord(entry)) continue;
		const question = str(entry.question);
		const answer = str(entry.answer);
		if (question !== null && answer !== null) out.push({ question, answer });
	}
	return out;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const html = str(args.html);
	const answers = answersOf(detailsRecord(result));
	const outline = html ? formOutline(html) : { headings: [], fields: 0 };
	const first = answers?.[0]?.question ?? outline.headings[0];
	if (!first) return html === null && !result ? <InvalidArg what="html" /> : null;
	const count = answers ? answers.length : outline.fields;
	return (
		<>
			<span>{truncate(normalizeWs(first), 70)}</span>
			{count > 1 && <Badge>{count} fields</Badge>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const answers = answersOf(details);
	if (answers) {
		return (
			<>
				<div className="tv-list">
					{answers.map((entry, i) => (
						<div key={i}>
							<Row>{entry.question}</Row>
							{entry.answer ? (
								<Row k={<span className="tv-ok-text">✓</span>}>
									<span>{entry.answer}</span>
								</Row>
							) : (
								<Row k="—">
									<span className="tv-faint">(no answer)</span>
								</Row>
							)}
						</div>
					))}
				</div>
				{details?.timedOut === true && <Note tone="warn">auto-selected after timeout — not a user choice</Note>}
			</>
		);
	}
	if (result) return <ResultText result={result} maxLines={10} />;
	const html = str(args.html);
	if (html === null) return <InvalidArg what="html" />;
	const { headings } = formOutline(html);
	return (
		<div className="tv-list">
			{headings.map((heading, i) => (
				<Row key={i}>{heading}</Row>
			))}
		</div>
	);
}

export const askRenderer: ToolRenderer = { Summary, Body };
