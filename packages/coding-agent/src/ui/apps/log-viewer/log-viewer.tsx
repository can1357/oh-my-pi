/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/debug logs`: recent log entries as a picker sheet. The filter is its
 * query, one row per entry (message, fields, time, pid, level dot) with the
 * session boundary as a group head, the range selection checked, the entry
 * under the cursor pretty-printed below, and the keys' actions in the bar.
 *
 * The terminal shows the classic framed viewer instead (the `omp.app.logs`
 * look): raw lines with fold markers, a summary and filter line above, the
 * status and key hints below. Keys behave the same on both.
 */
import { computed, type JSXNode } from "@oh-my-pi/pi-tui";
import type { TspPickerGroup, TspPickerItem, TspPickerProps, TspTone } from "@oh-my-pi/pi-wire";
import { isRecord } from "@oh-my-pi/pi-utils";
import "../../styles/apps/log-viewer/look";
import { displayLine, type LogViewerModel } from "./model";

const OLDER_ITEM = "older";

const LEVEL_TONES: Readonly<Record<string, TspTone>> = {
	error: "error",
	warn: "warning",
	info: "info",
	debug: "muted",
};

const oneLine = (text: string): string => displayLine(text).replace(/\s+/g, " ");

/** `HH:MM:SS` local time. */
function clockTime(date: Date): string {
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}

/** One entry as a picker row: the message, the other fields as `key=value`, time and pid facts, the level dot. */
function logItem(id: string, rawLine: string): TspPickerItem {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawLine);
	} catch {}
	if (!isRecord(parsed)) return { id, label: oneLine(rawLine), mono: true };
	const { timestamp, level, pid, message, ...rest } = parsed;
	const detail = Object.entries(rest)
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(" ");
	const time = typeof timestamp === "string" ? new Date(timestamp) : undefined;
	return {
		id,
		label: oneLine(typeof message === "string" ? message : rawLine),
		detail: detail ? oneLine(detail) : undefined,
		dot: typeof level === "string" ? LEVEL_TONES[level] : undefined,
		facts: {
			time: time && Number.isFinite(time.getTime()) ? clockTime(time) : "",
			pid: typeof pid === "number" ? String(pid) : "",
		},
	};
}

/** Case-insensitive occurrences of `needle` in `label` as UTF-16 ranges. */
function hitRanges(label: string, needle: string): [number, number][] {
	const lower = label.toLowerCase();
	const ranges: [number, number][] = [];
	for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
		ranges.push([at, at + needle.length]);
	}
	return ranges;
}

/** The picker's props for the model's current state. */
function pickerProps(model: LogViewerModel): TspPickerProps {
	model.version();
	const entries = model.entries;
	const query = model.filter;
	const needle = query.toLowerCase();
	const selected = entries.selected();
	const items: TspPickerItem[] = [];
	const order: (string | TspPickerGroup)[] = [];
	const hits: Record<string, [number, number][]> = {};
	for (const row of entries.rows) {
		if (row.kind === "warning") {
			order.push({ group: "session", label: "This session" });
			continue;
		}
		if (row.kind === "load-older") {
			items.push({ id: OLDER_ITEM, label: "Load older entries", tone: "muted" });
			order.push(OLDER_ITEM);
			continue;
		}
		const item = logItem(`l${row.logIndex}`, entries.rawLine(row.logIndex));
		items.push(item);
		order.push(item.id);
		if (needle && typeof item.label === "string") {
			const found = hitRanges(item.label, needle);
			if (found.length > 0) hits[item.id] = found;
		}
	}
	const cursorLog = entries.cursorLogIndex;
	const subtitle = [
		`${entries.visibleCount}/${entries.count} entries`,
		selected.length > 1 ? `${selected.length} selected` : undefined,
		entries.historyLimitReached ? "history limit reached" : undefined,
		model.loading ? "loading older…" : undefined,
	]
		.filter(part => part !== undefined)
		.join(" · ");
	return {
		title: "Recent logs",
		subtitle,
		noun: "entries",
		size: "lg",
		layout: "rows",
		preview: cursorLog === undefined ? "none" : "below",
		query,
		cursor: query.length,
		placeholder: "Filter logs…",
		columns: [
			{ id: "pid", format: "dim", priority: 0 },
			{ id: "time", format: "dim", priority: 1 },
		],
		items,
		order,
		hits,
		selected:
			entries.cursorRow?.kind === "load-older" ? OLDER_ITEM : cursorLog === undefined ? null : `l${cursorLog}`,
		current: selected.length > 1 ? selected.map(index => `l${index}`) : [],
		total: entries.count,
		empty: query ? "No matching log entries" : "No log entries",
		message: model.status,
		actions: [
			{ id: "copy", label: "Copy", keys: ["ctrl", "c"], primary: true },
			{ id: "all", label: "Select all", keys: ["ctrl", "a"] },
			{ id: "pid", label: "This process", keys: ["ctrl", "p"], on: entries.processOnly },
			{
				id: "older",
				label: "Load older",
				keys: ["ctrl", "o"],
				disabled: entries.canLoadOlder()
					? undefined
					: entries.historyLimitReached
						? "Log history limit reached"
						: "No older log entries",
			},
			{ id: "close", label: "Close", keys: ["esc"], end: true },
		],
	};
}

/** The entry under the cursor, pretty-printed. */
function Preview(props: { readonly model: LogViewerModel }): JSXNode {
	return () => {
		props.model.version();
		const index = props.model.entries.cursorLogIndex;
		if (index === undefined) return null;
		const raw = props.model.entries.rawLine(index);
		let text: string;
		let lang: string | undefined;
		try {
			text = JSON.stringify(JSON.parse(raw), null, 2);
			lang = "json";
		} catch {
			text = displayLine(raw);
		}
		return <code key={`entry:${index}`} text={text} lang={lang} wrap />;
	};
}

export function LogViewer(props: { readonly model: LogViewerModel }): JSXNode {
	const model = props.model;
	const p = computed(() => pickerProps(model));
	return (
		<picker
			title={() => p().title}
			subtitle={() => p().subtitle}
			noun={() => p().noun}
			size={() => p().size}
			layout={() => p().layout}
			preview={() => p().preview}
			query={() => p().query}
			cursor={() => p().cursor}
			placeholder={() => p().placeholder}
			columns={() => p().columns}
			items={() => p().items}
			order={() => p().order}
			hits={() => p().hits}
			selected={() => p().selected}
			current={() => p().current}
			total={() => p().total}
			empty={() => p().empty}
			message={() => p().message}
			actions={() => p().actions}
			term={{ role: "omp.app.logs", viewer: model }}
			onKey={key => model.key(key.id, key.text)}
			onSelect={item => model.select(item, false)}
			onActivate={item => model.select(item, true)}
			onAction={act => model.action(act)}
		>
			<Preview model={model} />
		</picker>
	);
}
