/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A run of consecutive `read` calls shown as one transcript block.
 *
 * One file reads `Read src/a.ts:1-20`; several read `Read (N)` (natively
 * `Read N files`) over one row per file. Reads of one file in one request
 * share a row with their selectors merged (`src/a.ts:1-20,40-50`); a row's
 * status is its worst read's (error over warning over pending). A request's
 * usage hangs under the last row its reads land on. With content previews on,
 * each read with content shows it (numbered code or rendered Markdown,
 * clamped while folded) instead of a row.
 *
 * Extension presenters may draw a read as a compact row of its own or hide
 * it, and `display.toolActivity: concise` draws each read as its concise
 * activity row; a read the user opened draws in full whatever they say. The
 * full reads draw as one group at the first full read's place.
 *
 * Terminal look: `read-group` (`src/ui/styles/transcript/read-group.ts`), fed by {@link ReadGroupTerm}.
 */
import * as path from "node:path";
import { type Accessor, computed, type JSXNode, type Signal, signal } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatDuration, formatNumber, isUrlLikePath, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspCardStatus, TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { splitUrlScheme } from "../../internal-urls/url-scheme";
import type { ReadToolDetails } from "../../tools/details/read";
import { shortenPath } from "../../utils/render-utils";
import { fileHref } from "../tools/file-common";
import { ContentCode, firstSelectorLine, readLinkPath, splitTarget } from "../tools/read";
import { presenterRows } from "./figures/presented-block";
import type { HubRecentLine } from "../styles/pickers/agent-hub";
import { type CompactRow, conciseActivityLine, type ToolPresentation } from "./tool-block";

/** A read's state in the group. */
export type ReadStatus = "pending" | "success" | "warning" | "error";

/** Token usage of one request. */
export interface ReadUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/** One request's usage line, anchored under its last read. */
export interface ReadUsageRow {
	readonly ids: readonly string[];
	readonly usage: ReadUsage;
	readonly durationMs?: number;
	readonly ttftMs?: number;
	readonly timestamp?: number;
	readonly turnElapsedMs?: number;
}

/** A read as the group keeps it. */
export interface ReadEntry {
	readonly id: string;
	/** The requested path (sanitized; a suffix correction applied). */
	readonly path: string;
	/** Display paths the result split a multi-target read into. */
	readonly displayPaths?: readonly {
		readonly path: string;
		readonly linkPath?: string;
	}[];
	readonly linkPath?: string;
	readonly raw: boolean;
	readonly args?: unknown;
	readonly status: ReadStatus;
	readonly correctedFrom?: string;
	readonly conflictCount?: number;
	readonly contentText?: string;
	readonly contentType?: string;
	readonly codeStartLine?: number;
	readonly codeLineNumbers?: readonly (number | null)[];
	readonly result?: {
		readonly content: readonly unknown[];
		readonly details?: unknown;
		readonly isError?: boolean;
	};
	/** The user opened it: it draws in full, its preview unclamped. */
	readonly expanded: boolean;
	/** Wall-clock ms the model made the call (its concise row's clock). */
	readonly timestamp: number;
}

/** How extension presenters draw a read (`undefined`: in full). */
export type ReadPresenter = (block: {
	readonly type: "toolCall";
	readonly id: string;
	readonly toolName: "read";
	readonly args: unknown;
	readonly result: ReadEntry["result"];
	readonly isError: boolean;
	readonly isPartial: boolean;
}) => ToolPresentation | undefined;

/** A read result as the group receives it. */
export interface ReadResult {
	readonly content: readonly {
		readonly type: string;
		readonly text?: string;
	}[];
	readonly details?: unknown;
	readonly isError?: boolean;
}

/** Content rows a folded preview keeps. */
export const READ_PREVIEW_LINES = 3;
/** The data-first group never clamps whole files away: code is cut by line, Markdown by its own card. */
const TRIMMED_BODY_PREVIEW = { lines: 1000 } as const;

const STATUS_RANK: Record<ReadStatus, number> = {
	success: 0,
	pending: 1,
	warning: 2,
	error: 3,
};
const STATUS_TONE: Record<ReadStatus, TspTone | undefined> = {
	success: undefined,
	pending: "pending",
	warning: "warning",
	error: "error",
};

// ---------------------------------------------------------------- display targets

/** One displayed target of a read: a path with at most one selector. */
interface Target {
	readonly entry: ReadEntry;
	readonly targetPath: string;
	readonly basePath: string;
	readonly linkPath?: string;
	readonly selector?: string;
}

/** One summary row: a target, or a file's targets from one request merged. */
export interface SummaryRow {
	readonly targetPath: string;
	readonly basePath: string;
	readonly targets: readonly Target[];
}

/** `12`, `12-40`, `12-`, `12+5`: one line range. */
const LINE_RANGE = /^\d+(?:-\d*|\+\d+)?$/;

function isRangeList(chunk: string): boolean {
	const parts = chunk.split(",").map(part => part.trim());
	return parts.length > 0 && parts.every(part => LINE_RANGE.test(part));
}

/** A selector's display parts: a range list (`1-5,10-20`, or one side of `a:b`) split into one selector each. */
function selectorParts(sel: string | undefined): (string | undefined)[] {
	if (!sel) return [undefined];
	const chunks = sel.split(":");
	const split = (list: string): string[] =>
		list
			.split(",")
			.map(chunk => chunk.trim())
			.filter(chunk => chunk.length > 0);
	if (chunks.length === 1) return isRangeList(sel) && sel.includes(",") ? split(sel) : [sel];
	if (chunks.length === 2) {
		const [left, right] = chunks as [string, string];
		if (isRangeList(left) && left.includes(",")) return split(left).map(chunk => `${chunk}:${right}`);
		if (isRangeList(right) && right.includes(",")) return split(right).map(chunk => `${left}:${chunk}`);
	}
	return [sel];
}

/**
 * The paths a multi-target read names (`a.ts:1-5,b.ts:3`): split at top-level
 * `,`/`;` outside braces, a comma inside a line-range list kept; only when
 * every part has a selector (else one path).
 */
function pathSpecs(raw: string): string[] {
	const text = raw.trim();
	if (!text || splitUrlScheme(text)) return [raw];
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") depth = Math.max(0, depth - 1);
		if (depth > 0 || (ch !== "," && ch !== ";")) continue;
		// A comma inside the part's line selector (`a.ts:1-5,10-20`, `a.ts:20:40,85:100`) continues it:
		// the part through the next token still splits before this comma.
		if (ch === ",") {
			const next = text.slice(i + 1).split(/[,;]/, 1)[0]!;
			const split = splitTarget(text.slice(start, i + 1 + next.length));
			if (split.sel !== undefined && split.path.length < i - start) continue;
		}
		parts.push(text.slice(start, i).trim());
		start = i + 1;
	}
	parts.push(text.slice(start).trim());
	const clean = parts.filter(part => part.length > 0);
	if (clean.length <= 1) return [raw];
	return clean.every(part => splitTarget(part).sel !== undefined) ? clean : [raw];
}

function targetsOf(entries: readonly ReadEntry[]): Target[] {
	const targets: Target[] = [];
	for (const entry of entries) {
		const specs = entry.displayPaths ?? pathSpecs(entry.path).map(spec => ({ path: spec }));
		for (const spec of specs) {
			const split = splitTarget(spec.path);
			const link =
				(spec as { linkPath?: string }).linkPath ??
				(specs.length === 1 ? entry.linkPath : undefined) ??
				(path.isAbsolute(split.path) ? split.path : undefined);
			for (const selector of selectorParts(split.sel)) {
				targets.push({
					entry,
					targetPath: selector ? `${split.path}:${selector}` : spec.path,
					basePath: split.path,
					...(link ? { linkPath: link } : {}),
					...(selector ? { selector } : {}),
				});
			}
		}
	}
	return targets;
}

/** `a,b,c`, or `first,second,…,last` past three. */
function mergedSelectors(selectors: readonly string[]): string {
	if (selectors.length <= 3) return selectors.join(",");
	return `${selectors[0]},${selectors[1]},…,${selectors[selectors.length - 1]}`;
}

/** Rows of targets: a file's selector targets from one request (usage batch) share a row. */
function summaryRows(targets: readonly Target[], batchOf: (id: string) => string | undefined): SummaryRow[] {
	const groups = new Map<string, Target[]>();
	for (const target of targets) {
		if (!target.selector || !target.basePath) continue;
		const key = `${target.basePath}\u0000${batchOf(target.entry.id) ?? ""}`;
		const list = groups.get(key);
		if (list) list.push(target);
		else groups.set(key, [target]);
	}
	const merged = new Map<Target, Target[]>();
	for (const list of groups.values()) if (list.length > 1) for (const target of list) merged.set(target, list);
	const emitted = new Set<Target[]>();
	const rows: SummaryRow[] = [];
	for (const target of targets) {
		const list = merged.get(target);
		if (!list) {
			rows.push({
				targetPath: target.targetPath,
				basePath: target.basePath,
				targets: [target],
			});
			continue;
		}
		if (emitted.has(list)) continue;
		emitted.add(list);
		rows.push({
			targetPath: `${target.basePath}:${mergedSelectors(list.map(item => item.selector!))}`,
			basePath: target.basePath,
			targets: list,
		});
	}
	return rows;
}

function rowStatus(row: SummaryRow): ReadStatus {
	let status: ReadStatus = "success";
	for (const target of row.targets)
		if (STATUS_RANK[target.entry.status] > STATUS_RANK[status]) status = target.entry.status;
	return status;
}

function rowCorrectedFrom(row: SummaryRow): string | undefined {
	return row.targets.find(target => target.entry.correctedFrom)?.entry.correctedFrom;
}

function rowConflicts(row: SummaryRow): number | undefined {
	let max = 0;
	for (const target of row.targets) max = Math.max(max, target.entry.conflictCount ?? 0);
	return max > 0 ? max : undefined;
}

function rowLink(row: SummaryRow): string | undefined {
	return row.targets.find(target => target.linkPath)?.linkPath;
}

/** A row's path split from its selector (merged selectors do not parse back out of the target). */
function rowSplit(row: SummaryRow): { path: string; sel?: string } {
	if (row.targetPath.startsWith(`${row.basePath}:`) && row.basePath)
		return {
			path: row.basePath,
			sel: row.targetPath.slice(row.basePath.length + 1),
		};
	return splitTarget(row.targetPath);
}

/** The failure message of a row's failed read, `Error:` dropped. */
function rowError(row: SummaryRow): string {
	return entryError(row.targets.find(target => target.entry.status === "error")?.entry);
}

/** The failure message of a failed read, `Error:` dropped. */
function entryError(entry: ReadEntry | undefined): string {
	return (entry?.contentText ?? "").replace(/^Error:\s*/, "").trim() || "Read failed";
}

/** Whether a read previews as rendered Markdown (tagged Markdown, not asked raw). */
export function previewsMarkdown(entry: ReadEntry): boolean {
	if (entry.contentType !== "text/markdown" || entry.raw) return false;
	return (
		splitTarget(entry.path)
			.sel?.split(":")
			.some(chunk => chunk.toLowerCase() === "raw") !== true
	);
}

function urlHref(target: string): string | undefined {
	const candidate = /^www\./i.test(target) ? `https://${target}` : target;
	return /^https?:\/\/\S+$/i.test(candidate) ? candidate : undefined;
}

// ---------------------------------------------------------------- usage

/** `Δ 5.0s  ⤵ 10  ⤴ 20  ⏱ 0.3s  ⚡ 16.7/s`. */
export function usageLine(row: ReadUsageRow): string {
	const symbol = (key: string): string => currentTheme().symbols.symbol(key);
	const parts: string[] = [];
	const { usage, timestamp, turnElapsedMs, ttftMs, durationMs } = row;
	if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0) {
		const d = new Date(timestamp);
		const pad = (n: number): string => String(n).padStart(2, "0");
		parts.push(
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
		);
	}
	if (turnElapsedMs !== undefined && turnElapsedMs > 0) parts.push(`Δ ${formatDuration(Math.round(turnElapsedMs))}`);
	parts.push(`${symbol("icon.input")} ${formatNumber(usage.input + usage.cacheWrite)}`);
	parts.push(`${symbol("icon.output")} ${formatNumber(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`${symbol("icon.cache")} ${formatNumber(usage.cacheRead)}`);
	if (ttftMs && ttftMs > 0) parts.push(`${symbol("icon.time")} ${(ttftMs / 1000).toFixed(1)}s`);
	if (durationMs && durationMs > 100 && usage.output > 0)
		parts.push(`${symbol("icon.throughput")} ${((usage.output / durationMs) * 1000).toFixed(1)}/s`);
	return parts.join("  ");
}

/** Usage rows per summary row: each under the last row holding one of its reads. */
function usageByRow(rows: readonly SummaryRow[], usage: readonly ReadUsageRow[]): Map<number, ReadUsageRow[]> {
	const lastRow = new Map<string, number>();
	rows.forEach((row, index) => {
		for (const target of row.targets) lastRow.set(target.entry.id, index);
	});
	const out = new Map<number, ReadUsageRow[]>();
	for (const item of usage) {
		let at: number | undefined;
		for (const id of item.ids) {
			const index = lastRow.get(id);
			if (index !== undefined && (at === undefined || index > at)) at = index;
		}
		if (at === undefined) continue;
		const list = out.get(at);
		if (list) list.push(item);
		else out.set(at, [item]);
	}
	return out;
}

// ---------------------------------------------------------------- the model

/** Options of a read group. */
export interface ReadGroupOptions {
	/** Show each read's content under the group. */
	readonly showContentPreview?: boolean;
}

/** A read run's state: its reads, their usage, expansion, visibility and presenters. */
export class ReadGroup {
	readonly showContentPreview: boolean;
	readonly #entries: Signal<readonly ReadEntry[]> = signal<readonly ReadEntry[]>([]);
	/** Usage rows by anchor read id. */
	readonly #usage: Signal<ReadonlyMap<string, ReadUsageRow>> = signal<ReadonlyMap<string, ReadUsageRow>>(new Map());
	/** The usage anchor of each attached read. */
	readonly #batch: Signal<ReadonlyMap<string, string>> = signal<ReadonlyMap<string, string>>(new Map());
	readonly #expanded = signal(false);
	readonly #activityVisible = signal(true);
	readonly #sealed = signal(false);
	readonly #presenter: Signal<ReadPresenter | undefined> = signal<ReadPresenter | undefined>(undefined);
	/** Bumped to ask presenters again. */
	readonly #presentationEpoch = signal(0);

	constructor(options: ReadGroupOptions = {}) {
		this.showContentPreview = options.showContentPreview ?? false;
	}

	readonly entries: Accessor<readonly ReadEntry[]> = () => this.#entries();
	/** Reads every source the drawing depends on (components run untracked). */
	readonly track = (): void => {
		this.#entries();
		this.#usage();
		this.#batch();
		this.#activityVisible();
		this.#sealed();
		this.#presenter();
		this.#presentationEpoch();
	};
	readonly activityVisible: Accessor<boolean> = () => this.#activityVisible();
	readonly sealed: Accessor<boolean> = () => this.#sealed();
	/** Every read draws compact or hidden: the group's block packs against compact neighbours. */
	readonly compact: Accessor<boolean> = computed(() => {
		const entries = this.#entries();
		return entries.length > 0 && entries.every(entry => this.presentation(entry) !== "full");
	});

	#update(id: string, change: (entry: ReadEntry) => ReadEntry): void {
		this.#entries.set(this.#entries().map(entry => (entry.id === id ? change(entry) : entry)));
	}

	/** A read's args streamed in (adds the read when new, made at `timestamp`, default now). */
	updateArgs(
		args: {
			readonly path?: unknown;
			readonly file_path?: unknown;
			readonly raw?: unknown;
		},
		id: string,
		timestamp?: number,
	): void {
		const raw = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const fields = {
			path: sanitizeText(raw),
			raw: args.raw === true,
			args,
			// The file, not its selector: `/abs/a.ts:5-9` links `/abs/a.ts` (at line 5).
			...(path.isAbsolute(raw) ? { linkPath: splitTarget(raw).path } : {}),
		};
		const existing = this.#entries().find(entry => entry.id === id);
		if (existing) {
			this.#update(id, entry => {
				const { linkPath: _linkPath, ...rest } = entry;
				return { ...rest, ...fields };
			});
			return;
		}
		const entries = this.#entries();
		// A read joining an open group opens too.
		const expanded = entries.length === 0 ? this.#expanded() : entries.some(entry => entry.expanded);
		this.#entries.set([
			...entries,
			{ id, status: "pending", expanded, timestamp: timestamp ?? Date.now(), ...fields },
		]);
	}

	/** Re-key a read whose streamed id changed (order kept; no-op on a collision). */
	renameEntry(oldId: string, newId: string): void {
		if (oldId === newId || !newId) return;
		const entries = this.#entries();
		if (!entries.some(entry => entry.id === oldId) || entries.some(entry => entry.id === newId)) return;
		this.#entries.set(entries.map(entry => (entry.id === oldId ? { ...entry, id: newId } : entry)));
	}

	/** Drop a read; true when the group is empty. */
	removeEntry(id: string): boolean {
		const entries = this.#entries();
		const rest = entries.filter(entry => entry.id !== id);
		if (rest.length !== entries.length) this.#entries.set(rest);
		return rest.length === 0;
	}

	/** A read's final result (partial results are ignored). */
	updateResult(result: ReadResult, isPartial: boolean, id: string): void {
		if (isPartial || !this.#entries().some(entry => entry.id === id)) return;
		const details = result.details as ReadToolDetails | undefined;
		const suffix =
			typeof details?.suffixResolution?.from === "string" && typeof details.suffixResolution.to === "string"
				? details.suffixResolution
				: undefined;
		const targets = Array.isArray(details?.displayReadTargets)
			? details.displayReadTargets.flatMap((raw, index) => {
					if (typeof raw !== "string" || !raw.trim()) return [];
					const link = details.displayReadTargetLinks?.[index];
					return [
						{
							path: sanitizeText(raw.trim()),
							...(typeof link === "string" && link ? { linkPath: link } : {}),
						},
					];
				})
			: [];
		const conflicts =
			typeof details?.conflictCount === "number" && details.conflictCount > 0 ? details.conflictCount : undefined;
		const text = result.content.find(block => block.type === "text")?.text;
		const display = details?.displayContent;
		this.#update(id, entry => {
			const link = readLinkPath(details) ?? entry.linkPath;
			let shownPath = entry.path;
			if (suffix) {
				const sel = splitTarget(entry.path).sel;
				shownPath = sanitizeText(!sel || splitTarget(suffix.to).sel ? suffix.to : `${suffix.to}:${sel}`);
			}
			const {
				displayPaths: _paths,
				correctedFrom: _from,
				conflictCount: _conflicts,
				contentText: _text,
				codeStartLine: _start,
				codeLineNumbers: _numbers,
				linkPath: _link,
				contentType: _type,
				...rest
			} = entry;
			const hasContent = display !== undefined || text !== undefined;
			return {
				...rest,
				path: shownPath,
				...(link ? { linkPath: link } : {}),
				...(suffix ? { correctedFrom: suffix.from } : targets.length > 0 ? { displayPaths: targets } : {}),
				...(conflicts ? { conflictCount: conflicts } : {}),
				status: result.isError ? "error" : suffix ? "warning" : "success",
				result: {
					content: result.content,
					details: result.details,
					...(result.isError ? { isError: true } : {}),
				},
				...(details?.contentType ? { contentType: details.contentType } : {}),
				...(hasContent
					? {
							contentText: display?.text ?? text,
							...(display?.startLine !== undefined ? { codeStartLine: display.startLine } : {}),
							...(display?.lineNumbers ? { codeLineNumbers: display.lineNumbers } : {}),
						}
					: {
							...(entry.contentText !== undefined ? { contentText: entry.contentText } : {}),
							...(entry.codeStartLine !== undefined ? { codeStartLine: entry.codeStartLine } : {}),
							...(entry.codeLineNumbers ? { codeLineNumbers: entry.codeLineNumbers } : {}),
						}),
			};
		});
	}

	/** One request's usage, under the last of its reads in the group. */
	attachUsage(
		ids: readonly string[],
		usage: ReadUsage,
		durationMs?: number,
		ttftMs?: number,
		timestamp?: number,
		turnElapsedMs?: number,
	): boolean {
		const present = new Set(this.#entries().map(entry => entry.id));
		const attached = ids.filter(id => present.has(id));
		const anchor = attached[attached.length - 1];
		if (!anchor) return false;
		const batch = new Map(this.#batch());
		for (const id of attached) batch.set(id, anchor);
		this.#batch.set(batch);
		const rows = new Map(this.#usage());
		rows.set(anchor, {
			ids: attached,
			usage,
			durationMs,
			ttftMs,
			timestamp,
			turnElapsedMs,
		});
		this.#usage.set(rows);
		return true;
	}

	/** Ctrl+O: every read opens or folds. */
	setExpanded(expanded: boolean): void {
		this.#expanded.set(expanded);
		// Untracked: an effect pushing the transcript's expand state must not rerun on every read.
		this.#entries.set(
			this.#entries.peek().map(entry => (entry.expanded === expanded ? entry : { ...entry, expanded })),
		);
	}

	setActivityVisible(visible: boolean): void {
		this.#activityVisible.set(visible);
	}

	/** The turn ended: a still-pending read is cancelled. */
	seal(): void {
		this.#sealed.set(true);
	}

	/** The extension presenters (undefined: every read in full). */
	setPresenter(presenter: ReadPresenter | undefined): void {
		this.#presenter.set(presenter);
	}

	/** Ask the presenters again. */
	refreshPresentation(): void {
		this.#presentationEpoch.set(this.#presentationEpoch() + 1);
	}

	/**
	 * A native toggle: the root (`""`) is Ctrl+O; `full` opens or folds the
	 * full reads; `c<id>` opens a compact read; `p<id>`/`m<id>` a preview.
	 */
	toggle(key: string, collapsed: boolean): void {
		if (key === "") {
			this.setExpanded(!collapsed);
			return;
		}
		if (key === "full") {
			const open = !collapsed;
			const ids = new Set(
				this.#entries()
					.filter(entry => this.presentation(entry) === "full" && entry.expanded !== open)
					.map(entry => entry.id),
			);
			if (ids.size > 0)
				this.#entries.set(this.#entries().map(entry => (ids.has(entry.id) ? { ...entry, expanded: open } : entry)));
			return;
		}
		const id = key.slice(1);
		if (key.startsWith("c")) {
			if (!collapsed) this.#update(id, entry => ({ ...entry, expanded: true }));
			return;
		}
		if (key.startsWith("p") || key.startsWith("m")) this.#update(id, entry => ({ ...entry, expanded: !collapsed }));
	}

	/** How a read draws: in full when the user opened it, else as presenters say. */
	presentation(entry: ReadEntry): ToolPresentation {
		this.#presentationEpoch();
		if (entry.expanded) return "full";
		const presenter = this.#presenter();
		return (
			presenter?.({
				type: "toolCall",
				id: entry.id,
				toolName: "read",
				args: entry.args,
				result: entry.result,
				isError: entry.status === "error",
				isPartial: entry.status === "pending",
			}) ?? "full"
		);
	}

	/** Summary rows of `entries` (merged per file and request). */
	rows(entries: readonly ReadEntry[]): SummaryRow[] {
		const batch = this.#batch();
		return summaryRows(targetsOf(entries), id => batch.get(id));
	}

	/** Usage rows per summary row of `rows`. */
	usageFor(rows: readonly SummaryRow[]): Map<number, ReadUsageRow[]> {
		return usageByRow(rows, [...this.#usage().values()]);
	}

	/** The usage anchored on a read. */
	usageOf(id: string): ReadUsageRow | undefined {
		return this.#usage().get(id);
	}

	/** Whether a read shows its content. */
	previews(entry: ReadEntry): boolean {
		return this.showContentPreview && entry.contentText !== undefined;
	}

	/** The group's status: error, else running (cancelled once sealed) while a read is pending, else done. */
	status(entries: readonly ReadEntry[]): TspCardStatus {
		let rank = 0;
		for (const entry of entries) rank = Math.max(rank, STATUS_RANK[entry.status]);
		if (rank === STATUS_RANK.error) return "error";
		if (rank === STATUS_RANK.pending) return this.#sealed() ? "cancelled" : "running";
		return "done";
	}
}

// ---------------------------------------------------------------- terminal facts

/** One row of a terminal summary. */
export interface ReadTermRow {
	readonly status: ReadStatus;
	/** The path (without selector), a URL whole. */
	readonly path: string;
	readonly url: boolean;
	/** `?q` queries and `:sel` after the path. */
	readonly selectors: string;
	readonly correctedFrom?: string;
	readonly conflicts?: number;
	readonly usage: readonly string[];
	/** Where the path links: the file read (at its first selected line), else a web URL. */
	readonly link?: { readonly file?: string; readonly url?: string; readonly line?: number };
}

/** One content preview. */
export interface ReadTermPreview {
	readonly status: ReadStatus;
	readonly head: ReadTermRow;
	readonly markdown: boolean;
	readonly text: string;
	/** The file path (language source). */
	readonly path: string;
	readonly expanded: boolean;
	readonly startLine?: number;
	readonly lineNumbers?: readonly (number | null)[];
	readonly usage?: string;
}

/** Terminal-only facts of a read group (`term`). */
export type ReadGroupTerm = {
	readonly look: "read-group";
	/** A presenter's compact row of one read. */
	readonly presented?: {
		readonly status: ReadStatus;
		/** The read's concise row (`display.toolActivity: concise`). */
		readonly activityLine?: HubRecentLine;
		/** The presenter's label, else the read's path after `Read`. */
		readonly label?: TspText;
		readonly path: string;
		/** The presenter's rows as `presenterRows` spans. */
		readonly rows: readonly TspSpan[];
	};
	/** Every displayed row (rows 0: ` • Read`; one: `Read <path>`; several: `Read (N)` and a tree). */
	readonly count?: number;
	/** The single row's head, when there is one row and it is not previewed. */
	readonly single?: ReadTermRow;
	/** Tree rows (several rows), previews left out. */
	readonly tree?: readonly ReadTermRow[];
	readonly previews?: readonly ReadTermPreview[];
};

/** A path's display parts: `?q=…` queries read like selectors, after the path. */
function pathParts(row: SummaryRow): {
	path: string;
	url: boolean;
	selectors: string;
} {
	const split = rowSplit(row);
	const base = split.sel ? split.path : row.targetPath;
	const q = base.indexOf("?");
	const file = q >= 0 && !isUrlLikePath(base) ? base.slice(0, q) : base;
	const query = q >= 0 && !isUrlLikePath(base) ? base.slice(q) : "";
	return {
		path: shortenPath(file),
		url: isUrlLikePath(file),
		selectors: split.sel ? `${query}:${split.sel}` : query,
	};
}

/** A row's link: the file its reads resolved to, opened at the lowest first selected line; else its web URL. */
function termLink(row: SummaryRow): ReadTermRow["link"] {
	const file = rowLink(row);
	if (!file) {
		const url = urlHref(rowSplit(row).path);
		return url ? { url } : undefined;
	}
	let line: number | undefined;
	for (const target of row.targets) {
		const first = firstSelectorLine(target.selector);
		if (first !== undefined && (line === undefined || first < line)) line = first;
	}
	return line === undefined ? { file } : { file, line };
}

function termRow(row: SummaryRow, usage: readonly ReadUsageRow[]): ReadTermRow {
	const corrected = rowCorrectedFrom(row);
	const conflicts = rowConflicts(row);
	const link = termLink(row);
	return {
		status: rowStatus(row),
		...pathParts(row),
		...(corrected ? { correctedFrom: shortenPath(corrected) } : {}),
		...(conflicts ? { conflicts } : {}),
		usage: usage.map(usageLine),
		...(link ? { link } : {}),
	};
}

// ---------------------------------------------------------------- native view

function FileRow(props: { readonly row: SummaryRow }): JSXNode {
	const { row } = props;
	const split = rowSplit(row);
	const status = rowStatus(row);
	const corrected = rowCorrectedFrom(row);
	const conflicts = rowConflicts(row);
	const error = status === "error" ? rowError(row) : undefined;
	const filePath = shortenPath(split.sel ? split.path : row.targetPath);
	const href = fileHref(rowLink(row)) ?? urlHref(split.path);
	const cut =
		urlHref(filePath) === undefined
			? filePath.lastIndexOf("/", filePath.endsWith("/") ? filePath.length - 2 : undefined) + 1
			: 0;
	const spans: TspSpan[] = [];
	if (cut > 0) spans.push({ s: "dim", t: filePath.slice(0, cut) });
	spans.push(
		href ? { s: "strong", t: filePath.slice(cut) || "…", href } : { s: "strong", t: filePath.slice(cut) || "…" },
	);
	if (split.sel) spans.push({ s: "muted", t: `:${split.sel}` });
	const tone = STATUS_TONE[status];
	const detail: TspText | undefined =
		error !== undefined
			? [{ s: "error", t: `— ${error.split("\n", 1)[0]}` }]
			: corrected
				? [{ s: "muted", t: `corrected from ${shortenPath(corrected)}` }]
				: undefined;
	return (
		<row key={row.targetPath} role="omp.tool.file" tone={tone}>
			<icon name={status === "error" ? "x-circle" : filePath.endsWith("/") ? "folder" : "file"} tone={tone} />
			<text spans={spans} lines={1} truncate="middle" shrink={1} title={error ?? filePath} />
			{conflicts ? <badge text={`${conflicts} conflict${conflicts === 1 ? "" : "s"}`} /> : undefined}
			{detail ? <text spans={detail} lines={1} truncate="end" shrink={1} /> : undefined}
		</row>
	);
}

function UsageText(props: { readonly usage: ReadUsageRow; readonly nodeKey: string }): JSXNode {
	return (
		<text propKey={props.nodeKey} spans={[{ s: "dim", t: usageLine(props.usage) }]} wrap="word" role="omp.usage" />
	);
}

/** One read's content: rendered Markdown in its own folding card, else numbered code clamped while folded. */
function Preview(props: { readonly entry: ReadEntry; readonly group: ReadGroup }): JSXNode {
	const { entry } = props;
	if (previewsMarkdown(entry))
		return (
			<card
				key={`m${entry.id}`}
				variant="bare"
				collapsible
				collapsed={!entry.expanded}
				preview={{ lines: READ_PREVIEW_LINES }}
				onToggle={collapsed => props.group.toggle(`m${entry.id}`, collapsed)}
			>
				<md text={entry.contentText ?? ""} />
			</card>
		);
	const split = splitTarget(entry.path);
	const lines = (entry.contentText ?? "").split("\n");
	const shown = entry.expanded ? lines.length : Math.min(lines.length, READ_PREVIEW_LINES);
	const hidden = lines.length - shown;
	return [
		<ContentCode
			content={lines.slice(0, shown).join("\n")}
			start={entry.codeStartLine ?? firstSelectorLine(split.sel) ?? 1}
			numbers={entry.codeLineNumbers?.slice(0, shown)}
			path={split.path}
		/>,
		hidden > 0 && (
			<text
				key="more"
				spans={[{ s: "muted", t: `${hidden} more line${hidden === 1 ? "" : "s"}` }]}
				role="omp.tool.stats"
			/>
		),
	];
}

interface GroupNodeProps {
	readonly group: ReadGroup;
	readonly entries: readonly ReadEntry[];
	readonly nodeKey?: string;
	readonly hidden?: boolean;
	/** A presenter's compact presentation of the (single) read. */
	readonly compact?: CompactRow;
	/** The (single) read's concise row. */
	readonly activityLine?: HubRecentLine;
	readonly onToggle: (collapsed: boolean) => void;
}

/**
 * The reads as one inline `tool`: one file heads `Read path:13-36` (a
 * failure's message after it); several `Read N files` over a row per file
 * and a section per previewed read.
 */
function GroupNode(props: GroupNodeProps): JSXNode {
	const { group, entries } = props;
	const rows = group.rows(entries);
	const status = group.status(entries);
	const previews = entries.filter(entry => entry.status !== "error" && group.previews(entry));
	const body: JSXNode[] = [];
	let collapsible = previews.length > 0;
	let head: {
		target: string;
		targetKind: "path" | "text";
		href?: string;
		meta?: TspText[];
		badges?: { text: string; tone: TspTone }[];
	};
	if (rows.length <= 1) {
		const row = rows[0];
		head = { target: "…", targetKind: "path" };
		if (row) {
			const split = rowSplit(row);
			const filePath = shortenPath(split.sel ? split.path : row.targetPath);
			const corrected = rowCorrectedFrom(row);
			const conflicts = rowConflicts(row);
			const href = fileHref(rowLink(row)) ?? urlHref(split.path);
			head = {
				target: filePath ? `${filePath}${split.sel ? `:${split.sel}` : ""}` : "…",
				targetKind: "path",
				...(href ? { href } : {}),
				...(corrected ? { meta: [`corrected from ${shortenPath(corrected)}`] } : {}),
				...(conflicts
					? {
							badges: [
								{
									text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}`,
									tone: "warning",
								},
							],
						}
					: {}),
			};
			if (rowStatus(row) === "error") {
				const full = rowError(row);
				const first = full.split("\n", 1)[0]!.trim();
				const gist = first.length > 120 ? `${first.slice(0, 119)}…` : first;
				head = {
					...head,
					meta: [...(head.meta ?? []), [{ s: "muted", t: `— ${gist}` }]],
				};
				if (gist !== full) {
					body.push(<text spans={[{ s: "error", t: full }]} wrap="word" role="omp.tool.error" />);
					collapsible = true;
				}
			}
		}
		for (const entry of previews) body.push(<Preview entry={entry} group={group} />);
		(group.usageFor(rows).get(0) ?? []).forEach((usage, i) => {
			body.push(<UsageText usage={usage} nodeKey={`u${i}`} />);
		});
	} else {
		head = { target: `${rows.length} files`, targetKind: "text" };
		const listed = group.rows(entries.filter(entry => !previews.includes(entry)));
		const usage = group.usageFor(listed);
		listed.forEach((row, index) => {
			body.push(<FileRow row={row} />);
			(usage.get(index) ?? []).forEach((item, i) => {
				body.push(<UsageText usage={item} nodeKey={`u${index}.${i}`} />);
			});
		});
		for (const entry of previews) {
			const split = splitTarget(entry.path);
			const sectionHead: TspSpan[] = [{ s: "path", t: shortenPath(split.path) || "…" }];
			if (split.sel) sectionHead.push({ s: "muted", t: `:${split.sel}` });
			body.push(
				<section
					key={`p${entry.id}`}
					head={sectionHead}
					onToggle={collapsed => group.toggle(`p${entry.id}`, collapsed)}
				>
					<Preview entry={entry} group={group} />
				</section>,
			);
			const own = group.usageOf(entry.id);
			if (own) body.push(<UsageText usage={own} nodeKey={`u${entry.id}`} />);
		}
	}
	const compact = props.compact;
	const term = groupTerm(group, entries, compact, props.activityLine);
	if (compact) {
		const compactRows = compact.rows ?? [];
		return (
			<tool
				key={props.nodeKey}
				name="read"
				title="Read"
				status={status}
				frame="inline"
				collapsible
				collapsed
				role="omp.tool.read"
				target={compact.label ?? head.target}
				targetKind={compact.label !== undefined ? "text" : head.targetKind}
				href={compact.label !== undefined ? undefined : head.href}
				meta={head.meta}
				badges={head.badges}
				preview={compactRows.length > 0 ? { lines: compactRows.length } : "none"}
				tone={status === "error" ? "error" : undefined}
				hidden={props.hidden}
				term={term}
				onToggle={props.onToggle}
			>
				{compactRows.length > 0 ? <text spans={presenterRows(compactRows)} wrap="none" /> : body}
			</tool>
		);
	}
	return (
		<tool
			key={props.nodeKey}
			name="read"
			title="Read"
			status={status}
			frame="inline"
			collapsible={collapsible}
			collapsed={collapsible ? !entries.some(entry => entry.expanded) : undefined}
			preview={collapsible ? TRIMMED_BODY_PREVIEW : undefined}
			role="omp.tool.read"
			target={head.target}
			targetKind={head.targetKind}
			href={head.href}
			meta={head.meta}
			badges={head.badges}
			tone={status === "error" ? "error" : undefined}
			hidden={props.hidden}
			term={term}
			onToggle={props.onToggle}
		>
			{body}
		</tool>
	);
}

/** The terminal facts of `entries` drawn as one group (or one compact read). */
function groupTerm(
	group: ReadGroup,
	entries: readonly ReadEntry[],
	compact: CompactRow | undefined,
	activityLine: HubRecentLine | undefined,
): ReadGroupTerm {
	if (compact) {
		const entry = entries[0]!;
		return {
			look: "read-group",
			presented: {
				status: entry.status,
				...(activityLine ? { activityLine } : {}),
				...(compact.label !== undefined ? { label: compact.label } : {}),
				path: shortenPath(entry.path),
				rows: presenterRows(compact.rows ?? []),
			},
		};
	}
	const rows = group.rows(entries);
	const previewed = entries.filter(entry => group.previews(entry));
	const previews: ReadTermPreview[] = previewed.map(entry => {
		const split = splitTarget(entry.path);
		const linkPath = entry.linkPath ?? (path.isAbsolute(split.path) ? split.path : undefined);
		const head = termRow(
			{
				targetPath: entry.path,
				basePath: split.path,
				targets: [
					{
						entry,
						targetPath: entry.path,
						basePath: split.path,
						...(linkPath ? { linkPath } : {}),
						...(split.sel ? { selector: split.sel } : {}),
					},
				],
			},
			[],
		);
		const usage = group.usageOf(entry.id);
		return {
			status: entry.status,
			head,
			markdown: previewsMarkdown(entry),
			text: entry.contentText ?? "",
			path: split.path,
			expanded: entry.expanded,
			...(entry.codeStartLine !== undefined ? { startLine: entry.codeStartLine } : {}),
			...(entry.codeLineNumbers ? { lineNumbers: entry.codeLineNumbers } : {}),
			...(usage ? { usage: usageLine(usage) } : {}),
		};
	});
	if (rows.length === 1) {
		const row = rows[0]!;
		const rowPreviews = previews.filter((_, i) => row.targets.some(target => target.entry === previewed[i]));
		const single = rowPreviews.length > 0 ? undefined : termRow(row, group.usageFor(rows).get(0) ?? []);
		return {
			look: "read-group",
			count: 1,
			...(single ? { single } : {}),
			previews: rowPreviews,
		};
	}
	const listed = group.rows(entries.filter(entry => !group.previews(entry)));
	const usage = group.usageFor(listed);
	return {
		look: "read-group",
		count: rows.length,
		tree: listed.map((row, index) => termRow(row, usage.get(index) ?? [])),
		previews,
	};
}

/** A read's concise row: a still-pending read of a sealed group was cancelled. */
function readActivityLine(group: ReadGroup, entry: ReadEntry): HubRecentLine {
	const error = entry.status === "error";
	return conciseActivityLine({
		name: "read",
		args: entry.args,
		timestamp: entry.timestamp,
		status: entry.status === "pending" ? (group.sealed() ? "aborted" : "pending") : error ? "error" : "success",
		...(error ? { error: entryError(entry) } : {}),
	});
}

/** The group's block: one `tool` when every read draws in full, else a column of compact reads and the full group. */
export function ReadGroupBlock(props: { readonly group: ReadGroup }): Accessor<JSXNode> {
	const { group } = props;
	return computed(() => {
		group.track();
		const entries = group.entries();
		const hidden = !group.activityVisible() ? true : undefined;
		const toggle = (key: string) => (collapsed: boolean) => group.toggle(key, collapsed);
		const shown = entries.map(entry => group.presentation(entry));
		const full = entries.filter((_, i) => shown[i] === "full");
		if (full.length === entries.length)
			return <GroupNode group={group} entries={full} hidden={hidden} onToggle={toggle("")} />;
		const visible = entries.filter((_, i) => shown[i] !== "hidden");
		if (visible.length === 0) return <GroupNode group={group} entries={entries} hidden onToggle={toggle("")} />;
		const children: JSXNode[] = [];
		let fullDrawn = false;
		entries.forEach((entry, i) => {
			const presentation = shown[i]!;
			if (presentation === "hidden") return;
			if (presentation !== "full") {
				const spec = typeof presentation === "object" ? presentation.compact : {};
				children.push(
					<GroupNode
						group={group}
						entries={[entry]}
						nodeKey={`c${entry.id}`}
						compact={spec}
						{...(presentation === "concise" ? { activityLine: readActivityLine(group, entry) } : {})}
						onToggle={toggle(`c${entry.id}`)}
					/>,
				);
			} else if (!fullDrawn) {
				fullDrawn = true;
				children.push(<GroupNode group={group} entries={full} nodeKey="full" onToggle={toggle("full")} />);
			}
		});
		return (
			<col role="omp.tool.read" hidden={hidden}>
				{children}
			</col>
		);
	});
}
