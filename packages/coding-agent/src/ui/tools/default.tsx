/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The generic card for tools without a presenter: the tool label with a
 * one-line args summary as the head target, and the result's text as raw
 * output (`ansi`), or a muted "(no output)".
 *
 * Terminal look: `default` (`src/ui/styles/tools/default.ts`), which lists the
 * args (`term.args`, set by the tool block) when expanded.
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import { argsSummaryChars, visibleArgKeys } from "./args";
import type { ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";

/** Character budget of the head's args summary. */
const SUMMARY_CHARS = 160;

/** Result details the generic card understands. */
interface DefaultDetails {
	/** A synthetic placeholder for a call skipped to service steering input. */
	readonly skipped?: boolean;
	readonly source?: string;
}

function defaultHead(args: unknown, state: ToolViewState): ToolView["head"] {
	const label = state.renderContext?.label;
	const record =
		args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
	const summary = record && visibleArgKeys(record).length > 0 ? argsSummaryChars(record, SUMMARY_CHARS) : undefined;
	return {
		...(typeof label === "string" ? { title: label } : {}),
		...(summary ? { target: summary } : {}),
		targetKind: "text",
	};
}

/** The text a result carries (text blocks joined). */
export function resultText(result: ToolResult): string {
	let out = "";
	for (const block of result.content) {
		if (block.type !== "text" || block.text === undefined) continue;
		out = out ? `${out}\n${block.text}` : block.text;
	}
	return out;
}

export const defaultPresenter: ToolPresenter = {
	call: (args, state) => ({ head: defaultHead(args, state), term: { look: "default" } }),
	result: (result, state, args) => {
		const details = (result.details ?? undefined) as DefaultDetails | undefined;
		const skipped = details?.skipped === true || details?.source === "interrupt_skipped";
		const tone: TspTone | undefined = skipped ? "info" : result.isError ? "error" : undefined;
		const output = resultText(result).trimEnd();
		return {
			head: defaultHead(args, state),
			...(tone ? { tone } : {}),
			body: output ? <ansi text={output} /> : <text spans={[{ t: "(no output)", s: "muted" }]} wrap="word" />,
			term: { look: "default" },
		};
	},
};
