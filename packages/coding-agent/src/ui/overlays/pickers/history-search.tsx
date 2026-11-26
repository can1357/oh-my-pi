/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Prompt history search: past prompts, newest first, filtered as you type
 * (each word must appear), with query hits marked. Enter (or `insert`, or a
 * second click) puts the prompt in the editor; ⌦ at the end of the query
 * deletes the selected prompt from history.
 *
 * When the host gives a scheduler, query edits search after a quiet period;
 * navigation and picks run a pending search first so they act on the
 * current query's results.
 */
import { batch, type JSXNode, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { shortenHome } from "@oh-my-pi/pi-tui/text/sanitize";
import type { TspPickerAction, TspPickerItem } from "@oh-my-pi/pi-wire";
import "../../styles/pickers/history";
import type { HistoryLookTerm } from "../../styles/pickers/history";
import { tokenHits } from "../../styles/pickers/common";
import { editLine, type LineState } from "../settings/line-edit";
import { pickerAge, pickerDate } from "./format";
import { PICKER_KEY, pickerAction } from "./select-sheet";
import { matchesAppInterrupt, selectKeyId } from "../../../config/keybindings/matchers";
import { cancelKbd, confirmKbd } from "../../keys/hints";

/** A past prompt the search shows. */
export interface HistorySearchEntry {
	readonly id: number;
	readonly prompt: string;
	/** Unix seconds of its latest submission. */
	readonly created_at: number;
	readonly cwd?: string;
}

/** Searchable prompt history. */
export interface HistorySource {
	search(query: string, limit: number): readonly HistorySearchEntry[];
	getRecent(limit: number): readonly HistorySearchEntry[];
	delete(id: number): void;
}

export interface HistorySearchProps {
	readonly source: HistorySource;
	onSelect(prompt: string): void;
	onCancel(): void;
	/** The clock ages are measured against (default `Date.now`). */
	now?(): number;
	/** Run `search` after `ms` of quiet; returns its cancel. Absent: every edit searches at once. */
	schedule?(search: () => void, ms: number): () => void;
}

const RESULT_LIMIT = 100;
const DEBOUNCE_MS = 100;
const actions = (): TspPickerAction[] => [
	pickerAction("insert", "Insert", confirmKbd(), { primary: true }),
	pickerAction("close", "Close", cancelKbd(), { end: true }),
];

/** Query words as the history store splits them. */
function queryTokens(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(token => token.length > 0);
}

/** A key-path safe id stable across queries (prompts may hold `/` and newlines). */
function entryKey(entry: HistorySearchEntry): string {
	return `${entry.created_at}-${Bun.hash(entry.prompt).toString(36)}`;
}

/** Keys ({@link selectKeyId}) the query field never takes: they move through results. */
const NAVIGATION: Readonly<Record<string, true>> = {
	up: true,
	down: true,
	pageUp: true,
	pageDown: true,
	home: true,
	end: true,
	enter: true,
};

export function HistorySearch(props: HistorySearchProps): JSXNode {
	const now = (): number => props.now?.() ?? Date.now();
	const line = signal<LineState>({ text: "", cursor: 0 });
	const results = signal<readonly HistorySearchEntry[]>([]);
	/** The trimmed query `results` belong to. */
	const resultsQuery = signal("");
	const selected = signal<string | null>(null);
	let cancelPending: (() => void) | undefined;

	const update = (): void => {
		cancelPending?.();
		cancelPending = undefined;
		const query = line().text.trim();
		const found = query ? props.source.search(query, RESULT_LIMIT) : props.source.getRecent(RESULT_LIMIT);
		batch(() => {
			resultsQuery.set(query);
			results.set(found);
			selected.set(found[0] ? entryKey(found[0]) : null);
		});
	};
	const flush = (): void => {
		if (cancelPending) update();
	};
	const schedule = (): void => {
		const query = line().text.trim();
		if (query === resultsQuery()) {
			cancelPending?.();
			cancelPending = undefined;
			return;
		}
		if (!query || !props.schedule) {
			update();
			return;
		}
		cancelPending?.();
		cancelPending = props.schedule(() => {
			cancelPending = undefined;
			update();
		}, DEBOUNCE_MS);
	};
	update();

	const entryById = (id: string): HistorySearchEntry | undefined => results().find(entry => entryKey(entry) === id);
	const insert = (): void => {
		flush();
		const entry = entryById(selected() ?? "");
		if (entry) {
			cancelPending?.();
			props.onSelect(entry.prompt);
		}
	};
	const onKey = (key: KeyEvent): boolean => {
		if (matchesAppInterrupt(key)) {
			cancelPending?.();
			props.onCancel();
			return true;
		}
		if (NAVIGATION[selectKeyId(key)]) {
			// The widget moves through (or picks from) the current query's results.
			flush();
			return false;
		}
		if (key.id === "delete" && line().cursor === line().text.length) {
			flush();
			const entry = entryById(selected() ?? "");
			if (entry) {
				props.source.delete(entry.id);
				update();
			}
			return true;
		}
		const next = editLine(line(), key);
		if (!next) return false;
		line.set(next);
		schedule();
		return true;
	};

	const items = (): TspPickerItem[] => {
		const tokens = queryTokens(resultsQuery());
		const at = now();
		return results().map(entry => {
			const label = entry.prompt.trim().split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
			const hits = tokenHits(label, tokens);
			return {
				id: entryKey(entry),
				label,
				...(entry.cwd ? { detail: shortenHome(entry.cwd) } : {}),
				facts: { when: pickerAge(entry.created_at * 1000, at) },
				...(hits.length > 0 ? { hits } : {}),
				title: pickerDate(entry.created_at * 1000),
			};
		});
	};
	const term = (): HistoryLookTerm => {
		const prompts: Record<string, string> = {};
		for (const entry of results()) prompts[entryKey(entry)] = entry.prompt.replace(/\s+/g, " ").trim();
		const query = resultsQuery();
		return {
			look: "omp.history",
			title: "History",
			field: line(),
			prompts,
			tokens: queryTokens(query),
			searched: query.length > 0,
			wrap: false,
		};
	};

	return (
		<col>
			<picker
				key={PICKER_KEY}
				title="History"
				icon="history"
				noun="prompts"
				size="md"
				layout="rows"
				preview="none"
				query={() => line().text}
				cursor={() => line().cursor}
				placeholder="Search prompts…"
				columns={[{ id: "when", format: "time" }]}
				items={items}
				selected={selected}
				empty="No history yet"
				actions={actions}
				term={term}
				onKey={onKey}
				onSelect={id => {
					flush();
					if (entryById(id)) selected.set(id);
				}}
				onActivate={id => {
					flush();
					const entry = entryById(id);
					if (!entry) return;
					selected.set(id);
					props.onSelect(entry.prompt);
				}}
				onAction={act => {
					if (act === "close") {
						cancelPending?.();
						props.onCancel();
					} else if (act === "insert") insert();
					else if (act === "clear") {
						line.set({ text: "", cursor: 0 });
						update();
					}
				}}
			/>
		</col>
	);
}
