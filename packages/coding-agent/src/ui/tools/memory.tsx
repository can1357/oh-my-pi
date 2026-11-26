/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Memory tools: `retain` (the memories being stored, as a list), `recall`
 * (the query and what was found) and `reflect` (the query and the answer as
 * markdown). Each head is the tool name with its query and outcome.
 *
 * Terminal look: `memory` (`src/ui/styles/tools/memory.ts`).
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { ToolPresenter, ToolResult, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

/** Terminal facts of the `memory` look. */
export type MemoryTerm = {
	readonly look: "memory";
	readonly result?: boolean;
	/** `Retain`, `Recall`, `Reflect`. */
	readonly title: string;
	readonly query?: string;
	/** The outcome after the query (`3 found`, `no matches`, `9 memories stored`). */
	readonly outcome?: string;
	/** Retained memories. */
	readonly items?: readonly string[];
	/** Recalled or reflected lines. */
	readonly lines?: readonly string[];
	/** Lines shown while collapsed (recall: none, reflect: three). */
	readonly collapsedLines?: number;
	/** Lines shown expanded before `… N more lines`. */
	readonly expandedLines?: number;
	readonly error?: string;
};

/** Retain args. */
export interface RetainArgs {
	readonly items?: readonly { readonly content?: string }[];
}

/** Recall / reflect args. */
export interface QueryArgs {
	readonly query?: string;
}

/** Body rows shown while collapsed. */
const RETAIN_PREVIEW = 8;
const REFLECT_PREVIEW = 3;
/** Reflect answer lines the native view carries; the rest stay in the terminal's expanded view. */
const REFLECT_NATIVE_LINES = 5;
const REFLECT_EXPANDED_LINES = 10;

function label(title: string, ...parts: (string | undefined)[]): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: title }];
	for (const part of parts) if (part) spans.push({ t: " " }, { s: "muted", t: part });
	return spans;
}

function queryOf(args: QueryArgs | undefined): string | undefined {
	const query = args?.query?.trim();
	return query ? replaceTabs(query) : undefined;
}

function errorView(title: string, result: ToolResult, query: string | undefined): ToolView {
	const message = resultText(result).trim() || `${title} failed`;
	return {
		label: label(title, query),
		tone: "error",
		body: <text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />,
		term: {
			look: "memory",
			result: true,
			title,
			query,
			error: message,
		} satisfies MemoryTerm,
	};
}

function retainItems(args: RetainArgs | undefined): string[] {
	const items: string[] = [];
	for (const item of args?.items ?? []) {
		const content = item?.content?.trim();
		if (content) items.push(replaceTabs(content));
	}
	return items;
}

function retainView(args: RetainArgs | undefined, outcome: string | undefined, result: boolean): ToolView {
	const items = retainItems(args);
	return {
		label: label("Retain", outcome),
		preview: { lines: RETAIN_PREVIEW },
		body:
			items.length > 0 ? (
				<list>
					{items.map((item, i) => (
						<item key={String(i)} label={item} />
					))}
				</list>
			) : undefined,
		term: {
			look: "memory",
			result,
			title: "Retain",
			outcome,
			items,
		} satisfies MemoryTerm,
	};
}

export const retainPresenter: ToolPresenter<RetainArgs> = {
	inline: true,
	merge: true,
	call: args => retainView(args, undefined, false),
	result(result, _state, args) {
		if (result.isError) return errorView("Retain", result, undefined);
		const text = resultText(result).trim().replace(/\.$/, "");
		return retainView(args, text || undefined, true);
	},
};

const FOUND = /^Found (\d+) relevant memor(?:y|ies)/;

export const recallPresenter: ToolPresenter<QueryArgs> = {
	inline: true,
	merge: true,
	call: args => {
		const query = queryOf(args);
		return {
			label: label("Recall", query),
			term: { look: "memory", title: "Recall", query } satisfies MemoryTerm,
		};
	},
	result(result, _state, args): ToolView {
		const query = queryOf(args);
		if (result.isError) return errorView("Recall", result, query);
		const text = resultText(result).trim();
		const found = FOUND.exec(text);
		if (!found) {
			return {
				label: label("Recall", query, "no matches"),
				tone: "warning",
				term: {
					look: "memory",
					result: true,
					title: "Recall",
					query,
					outcome: "no matches",
				} satisfies MemoryTerm,
			};
		}
		const outcome = `${found[1]} found`;
		const lines = text
			.split("\n")
			.slice(1)
			.filter(line => line.trim() !== "")
			.map(replaceTabs);
		return {
			label: label("Recall", query, outcome),
			preview: { lines: 0 },
			body: <text spans={[{ s: "muted", t: lines.join("\n") }]} wrap="word" />,
			term: {
				look: "memory",
				result: true,
				title: "Recall",
				query,
				outcome,
				lines,
				collapsedLines: 0,
			} satisfies MemoryTerm,
		};
	},
};

/** The answer cut after its `count`-th non-blank line. */
function firstLines(text: string, count: number): string {
	const lines = text.split("\n");
	let seen = 0;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() === "") continue;
		seen++;
		if (seen === count) return lines.slice(0, i + 1).join("\n");
	}
	return text;
}

export const reflectPresenter: ToolPresenter<QueryArgs> = {
	inline: true,
	merge: true,
	call: args => {
		const query = queryOf(args);
		return {
			label: label("Reflect", query),
			term: { look: "memory", title: "Reflect", query } satisfies MemoryTerm,
		};
	},
	result(result, _state, args): ToolView {
		const query = queryOf(args);
		if (result.isError) return errorView("Reflect", result, query);
		const text = resultText(result).trim();
		const lines = text
			.split("\n")
			.filter(line => line.trim() !== "")
			.map(replaceTabs);
		return {
			label: label("Reflect", query),
			preview: { lines: REFLECT_PREVIEW },
			body: text ? <md role="omp.memory.reflect" text={firstLines(text, REFLECT_NATIVE_LINES)} /> : undefined,
			term: {
				look: "memory",
				result: true,
				title: "Reflect",
				query,
				lines,
				collapsedLines: REFLECT_PREVIEW,
				expandedLines: REFLECT_EXPANDED_LINES,
			} satisfies MemoryTerm,
		};
	},
};

registerToolPresenter("retain", retainPresenter);
registerToolPresenter("recall", recallPresenter);
registerToolPresenter("reflect", reflectPresenter);
