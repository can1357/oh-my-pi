/** @jsxImportSource @oh-my-pi/pi-tui */
import {
	type HistorySearchEntry,
	HistorySearch,
	type HistorySource,
} from "../../../../src/ui/overlays/pickers/history-search";
import { type Driver, pickerSuite } from "./harness";

const NOW = 1_800_000_000;
const BASE: HistorySearchEntry[] = [
	{ id: 1, prompt: "fix the failing test in parser", created_at: NOW - 30, cwd: "/home/u/src/parser" },
	{ id: 2, prompt: "write docs for\nthe new API\n\twith tabs", created_at: NOW - 3600 },
	{
		id: 3,
		prompt: "ünïcödé 日本語 prompt that is long enough to be truncated at most widths, surely",
		created_at: NOW - 86400 * 3,
		cwd: "/tmp",
	},
	...Array.from({ length: 14 }, (_, i) => ({
		id: 10 + i,
		prompt: `prompt number ${i} about parser things`,
		created_at: NOW - 86400 * 40 - i,
	})),
];

function source(): HistorySource {
	let entries = BASE.map(entry => ({ ...entry }));
	return {
		search: (query, limit) =>
			entries
				.filter(entry =>
					query
						.toLowerCase()
						.split(/\s+/)
						.every(token => entry.prompt.toLowerCase().includes(token)),
				)
				.slice(0, limit),
		getRecent: limit => entries.slice(0, limit),
		delete: id => {
			entries = entries.filter(entry => entry.id !== id);
		},
	};
}
const EMPTY: HistorySource = { search: () => [], getRecent: () => [], delete() {} };
const noop = (): void => {};

pickerSuite({
	dir: "overlays/history-search",
	mount(caseName) {
		let pending: (() => void) | undefined;
		const schedule =
			caseName === "debounced"
				? (run: () => void) => {
						pending = run;
						return () => {
							if (pending === run) pending = undefined;
						};
					}
				: undefined;
		return {
			view: () => (
				<HistorySearch
					source={caseName === "empty" ? EMPTY : source()}
					onSelect={noop}
					onCancel={noop}
					now={() => NOW * 1000}
					schedule={schedule}
				/>
			),
			steps: {
				"native list select": noop,
				"picker select": (d: Driver) =>
					void d.emit({
						type: "select",
						key: "picker",
						item: `${NOW - 3600}-${Bun.hash(BASE[1]!.prompt).toString(36)}`,
					}),
				"picker clear": d => void d.emit({ type: "action", key: "picker", act: "clear", mods: [] }),
				"picker other act": d => void d.emit({ type: "action", key: "picker", act: "nope", mods: [] }),
				type: d => {
					for (const ch of "parser") d.press(ch);
				},
				settle: () => pending?.(),
				"type more": d => d.press("x"),
				"down flushes": d => d.press("\x1b[B"),
			},
		};
	},
});
