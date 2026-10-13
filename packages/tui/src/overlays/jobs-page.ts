/**
 * The async background jobs of a session as {@link BackgroundJobsPage}: the
 * fullscreen terminal page `/jobs` opens (the native jobs pill and native
 * terminals keep the {@link JobsSheetSource}-backed jobs sheet). It borrows the
 * Agent Hub page frame — a
 * box-chrome header/footer with a responsive two-pane body — and shows the
 * same job snapshot as the sheet: a selectable roster beside the selected
 * job's status, command, facts (cwd, pids, exit code, agent, artifact) and a
 * live, tail-following view of its captured output. The page only ever reads
 * the snapshot and cancels a running job; nothing enters the transcript.
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Component, TUI } from "../tui";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { truncateToWidth, visibleWidth } from "../utils";
import { shortenPath } from "../render/render-utils";
import { collapseCommand } from "../apps/ps-data";
import { compact } from "../native/describe";
import { ScrollView } from "../components/scroll-view";
import { Stack } from "../components/layout/stack";
import { SplitPane } from "../components/layout/split-pane";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { clampHubLine } from "./agent-hub-renderer";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import { theme, type ThemeColor } from "../theme/theme";
import { JOBS_REFRESH_MS, type JobsPanelDetail, type JobsPanelJob, type JobsSheetSource } from "./jobs-panel";
import { Row } from "../components/layout/row";

/** Narrowest terminal the body still splits into two panes (Agent Hub breakpoint shape). */
const SPLIT_MIN_WIDTH = 84;
/** Roster pane floor in the split layout. */
const ROSTER_MIN_WIDTH = 40;
/** Detail pane floor in the split layout. */
const DETAIL_MIN_WIDTH = 30;
/** Fixed frame chrome rows: top border, divider, footer, bottom border. */
const FRAME_CHROME_ROWS = 4;
/** Metadata rows the detail pane may spend before the output viewport. */
const DETAIL_META_ROWS = 2;

/** A job's status as the page names it. */
const STATUS_LABEL: Record<JobsPanelJob["status"], string> = {
	running: "Running",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

/** A job's status tint, shared by the roster row and the detail status line. */
const STATUS_TONE: Record<JobsPanelJob["status"], TspTone & ThemeColor> = {
	running: "accent",
	completed: "success",
	failed: "error",
	cancelled: "muted",
};

/** The status line's lead glyph. */
const STATUS_GLYPH: Record<JobsPanelJob["status"], string> = {
	running: "●",
	completed: "✓",
	failed: "✕",
	cancelled: "⊘",
};

/** One roster entry: a quiet group heading or a selectable job. */
interface RosterEntry {
	readonly head?: string;
	readonly job?: JobsPanelJob;
}

/** A cached, sanitized capture of one job's output, keyed by job id + text. */
interface OutputCache {
	readonly id: string;
	readonly output: string;
	readonly lines: readonly string[];
}

/** The rows that were on screen when follow was paused, held stable across capture churn. */
interface FrozenOutput {
	readonly id: string;
	readonly lines: readonly string[];
}

/** One snapshot: the jobs the roster shows, the selected one, and how many the filter hides. */
interface JobsSample {
	readonly jobs: readonly JobsPanelJob[];
	readonly selected: JobsPanelJob | undefined;
	/** Jobs the current filter hides (0 when showing all or nothing is hidden). */
	readonly hidden: number;
}

/** What the output viewport currently holds, so an unchanged repaint never re-copies the capture. */
interface OutputViewport {
	readonly id: string;
	readonly output: string;
	readonly frozen: boolean;
	/** The exact rows on screen — the pause freeze keeps this reference, never a copy. */
	readonly lines: readonly string[];
}

/**
 * The fullscreen Background jobs page. It re-reads the session every frame and
 * owns a {@link JOBS_REFRESH_MS} repaint timer (unref'd, cleared on
 * {@link dispose}) so a running job's output and pids stay live. Wide terminals
 * split into roster + selected detail; narrow terminals show the roster alone
 * until Tab/Enter opens the selected job's log, and Enter on a wide split
 * expands the log to the full body. ↑/↓ (or j/k) select on the roster and
 * scroll the log when it is focused, PgUp/PgDn page the log, Space toggles
 * tail-follow (a manual scroll pauses it; End or Space resumes), X cancels the
 * selected running job, `a` toggles the roster between bash jobs only (the
 * default) and every job, and Esc returns from the log to the roster, then
 * closes. While paused the shown rows are frozen, so a rolling capture — the
 * session appending *or* dropping leading rows — never shifts the viewport;
 * status, command and facts keep refreshing.
 */
export class BackgroundJobsPage implements Component {
	readonly #ui: TUI;
	readonly #source: JobsSheetSource;
	/** One session snapshot per render, shared by the frame and both panes. */
	#sample: JobsSample | undefined;
	#selectedId: string | undefined;
	/** Whether the roster lists every job type (`a` toggles) or only bash jobs — the default. */
	#showAll = false;
	/** Whether the log/detail surface is open: the log on a wide split, the detail pane when narrow. */
	#detailsOpen = false;
	#follow = true;
	#outputCache: OutputCache | undefined;
	/** The rows that were on screen when following stopped, so a rolling or emptied capture cannot shift the paused viewport. */
	#frozen: FrozenOutput | undefined;
	/** What the viewport currently holds, so an unchanged repaint never re-splits the capture. */
	#outputView: OutputViewport | undefined;
	readonly #output = new ScrollView([], { height: 1, followTail: true, anchor: "start" });
	readonly #split: SplitPane;
	readonly #fullLog = new Row({
		children: [{ content: (width, height) => this.#renderLog(width, height ?? this.#bodyRows), grow: 1 }],
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});
	readonly #frameTop = new PanelRows();
	readonly #frameDivider = new PanelRows();
	readonly #frameFooter = new PanelRows();
	readonly #frameBottom = new PanelRows();
	readonly #frame: Stack;
	readonly #timer: NodeJS.Timeout;
	/** Body rows from the last render; the fallback when a layout child is measured without a height. */
	#bodyRows = 1;
	#disposed = false;

	constructor(ui: TUI, source: JobsSheetSource) {
		this.#ui = ui;
		this.#source = source;
		this.#split = new SplitPane({
			left: (width, height) => this.#renderRoster(width, height ?? this.#bodyRows),
			right: (width, height) => this.#renderDetail(width, height ?? this.#bodyRows),
			leftSize: { ratio: 0.58, min: ROSTER_MIN_WIDTH },
			rightMinWidth: DETAIL_MIN_WIDTH,
			splitAt: SPLIT_MIN_WIDTH,
			narrowPane: "left",
			prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
			divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
			suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
		});
		this.#frame = new Stack({
			children: [
				{ content: this.#frameTop, height: 1 },
				{ content: (width, height) => this.#renderBody(width, height ?? this.#bodyRows), grow: 1 },
				{ content: this.#frameDivider, height: 1 },
				{ content: this.#frameFooter, height: 1 },
				{ content: this.#frameBottom, height: 1 },
			],
		});
		this.#timer = setInterval(() => this.#ui.requestRender(), JOBS_REFRESH_MS);
		this.#timer.unref?.();
	}

	/** Stop the refresh timer and release the viewport. Idempotent. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#timer);
		this.#output.dispose();
		this.#frame.dispose();
		this.#fullLog.dispose();
		this.#split.dispose();
	}

	invalidate(): void {
		this.#frame.invalidate();
		this.#split.invalidate();
		this.#output.invalidate();
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, Number.isFinite(width) ? Math.trunc(width) : 1);
		const termHeight = Math.max(1, this.#ui.terminal?.rows || process.stdout.rows || 40);
		const contentRows = Math.max(1, termHeight - FRAME_CHROME_ROWS);
		this.#bodyRows = contentRows;

		const sample = this.#current();
		this.#sample = sample;
		const geometry = this.#split.measure(safeWidth);
		const splitMode = geometry.mode === "split";
		// The two-pane chrome is only drawn when the split is actually rendered; the
		// wide full-body log replaces it with a single pane.
		const showSplit = splitMode && !this.#detailsOpen;
		this.#split.setHeight(contentRows);
		this.#split.setNarrowPane(splitMode ? "left" : this.#detailsOpen ? "right" : "left");

		// The roster title carries the filter mode and the live running count of
		// the visible jobs; the log title keeps the selected job's identity.
		let runningCount = 0;
		for (const job of sample.jobs) if (job.status === "running") runningCount++;
		const rosterTitle = `Background jobs · ${this.#showAll ? "all" : "bash"} · ${runningCount} running`;
		const title =
			this.#detailsOpen && sample.selected
				? `Background jobs · ${sanitizeDisplaySingleLine(sample.selected.id)}`
				: rosterTitle;
		this.#frameTop.setLines([
			showSplit ? topBorderSplit(safeWidth, title, geometry.left?.width ?? 0) : topBorder(safeWidth, title),
		]);
		this.#frameDivider.setLines([
			showSplit && geometry.left ? dividerSplit(safeWidth, geometry.left.width) : divider(safeWidth),
		]);
		this.#frameFooter.setLines([row(this.#footer(splitMode, Math.max(1, safeWidth - 4)), safeWidth)]);
		this.#frameBottom.setLines([bottomBorder(safeWidth)]);
		this.#frame.setHeight(contentRows + FRAME_CHROME_ROWS);

		return this.#clampFrame(this.#frame.render(safeWidth), safeWidth, termHeight);
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) {
			this.#back();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.#toggleDetails();
			return;
		}
		if (matchesKey(data, "space")) {
			this.#setFollow(!this.#follow);
			return;
		}
		const focusesRoster = !this.#detailsOpen;
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			if (focusesRoster) this.#move(-1);
			else this.#scrollOutput("up");
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			if (focusesRoster) this.#move(1);
			else this.#scrollOutput("down");
			return;
		}
		if (matchesKey(data, "pageUp")) this.#scrollOutput("pageUp");
		else if (matchesKey(data, "pageDown")) this.#scrollOutput("pageDown");
		else if (matchesKey(data, "home")) this.#scrollOutput("top");
		else if (matchesKey(data, "end")) this.#setFollow(true);
		else if (matchesKey(data, "x")) this.#cancelSelected();
		else if (matchesKey(data, "a")) this.#toggleAll();
	}

	/** Esc closes from the roster, or returns from the open log/detail surface first. */
	#back(): void {
		if (this.#detailsOpen) this.#detailsOpen = false;
		else this.#source.close();
	}

	#toggleDetails(): void {
		// Without a selected job there is nothing to expand: Tab/Enter leave the
		// (empty) roster page as it is instead of opening a blank log surface.
		if (this.#current().selected === undefined) return;
		this.#detailsOpen = !this.#detailsOpen;
		if (!this.#detailsOpen) this.#setFollow(true);
	}

	/** Apply the filter immediately so subsequent keys see the new selection and detail state. */
	#toggleAll(): void {
		this.#showAll = !this.#showAll;
		this.#sample = this.#current();
	}

	#setFollow(follow: boolean): void {
		this.#follow = follow;
		this.#output.setFollowTail(follow);
		if (follow) {
			// Resuming drops the frozen buffer so the next frame shows the current
			// snapshot; the trailing edge is restored here.
			this.#frozen = undefined;
			this.#output.scrollToBottom();
		} else {
			// Pausing freezes the rows that are on screen right now — the last
			// displayed capture, by reference — not the next inspected snapshot: a
			// capture that rolls or empties before the next frame cannot move the
			// viewport. (Keeps a reference, never a copy of the log.)
			const displayed = this.#outputView;
			if (displayed && displayed.lines.length > 0) {
				this.#frozen = { id: displayed.id, lines: displayed.lines };
			}
		}
	}

	#scrollOutput(action: "up" | "down" | "pageUp" | "pageDown" | "top"): void {
		if (action === "up") this.#output.scroll(-1);
		else if (action === "down") this.#output.scroll(1);
		else if (action === "pageUp") this.#output.page(-1);
		else if (action === "pageDown") this.#output.page(1);
		else this.#output.scrollToTop();
		// A manual scroll pauses following; returning to the tail resumes it.
		this.#setFollow(this.#output.getScrollOffset() >= this.#output.getMaxScrollOffset());
	}

	/** The body: a wide split, a wide full-body log, or the narrow roster/detail toggle. */
	#renderBody(width: number, height: number): readonly string[] {
		const geometry = this.#split.measure(width);
		if (geometry.mode === "split" && this.#detailsOpen) {
			this.#fullLog.setHeight(height);
			return this.#fullLog.render(width);
		}
		this.#split.setHeight(height);
		return this.#split.render(width);
	}

	/** The roster pane: Running then Recent, the selectable rows windowed around the selection. */
	#renderRoster(width: number, height: number): readonly string[] {
		const { jobs, selected, hidden } = this.#sample ?? this.#current();
		if (jobs.length === 0) {
			if (height <= 0) return [];
			// The bash filter can empty the roster while other jobs still exist:
			// say so, and how to widen the list.
			if (hidden > 0) {
				return [truncateToWidth(` ${theme.fg("muted", `No bash jobs · ${hidden} hidden · a:all`)}`, width)];
			}
			return [truncateToWidth(` ${theme.fg("muted", "No background jobs")}`, width)];
		}
		const entries = rosterEntries(jobs);
		const selectedIndex = entries.findIndex(entry => entry.job?.id === selected?.id);
		const rows = Math.max(0, Math.floor(height));
		const start = Math.max(0, Math.min(selectedIndex - Math.floor((rows - 1) / 2), entries.length - rows));
		const lines: string[] = [];
		for (let index = start; index < Math.min(entries.length, start + rows); index++) {
			const entry = entries[index]!;
			lines.push(
				entry.head !== undefined
					? truncateToWidth(` ${theme.fg("dim", entry.head)}`, width)
					: this.#jobLine(entry.job!, entry.job!.id === selected?.id, width),
			);
		}
		return lines;
	}

	/** The detail pane: status, then command/facts when there is room, then the output viewport. */
	#renderDetail(width: number, height: number): readonly string[] {
		const { selected } = this.#sample ?? this.#current();
		if (!selected || height <= 0) return [];
		const detail = this.#source.inspect(selected.id);
		const lines = [this.#statusLine(selected, width)];
		const remaining = height - lines.length;
		const metaBudget = Math.min(DETAIL_META_ROWS, Math.max(0, remaining - 2));
		const command = this.#commandLine(selected, detail, width);
		if (command && metaBudget > 0) lines.push(command);
		const facts = this.#factsLine(selected, detail, width);
		if (facts && lines.length - 1 < metaBudget) lines.push(facts);
		lines.push(...this.#renderOutput(width, height - lines.length, selected, detail));
		return lines;
	}

	/** The wide full-body log view: a status line over the whole output viewport. */
	#renderLog(width: number, height: number): readonly string[] {
		const { selected } = this.#sample ?? this.#current();
		if (!selected || height <= 0) return [];
		const detail = this.#source.inspect(selected.id);
		const lines = [this.#statusLine(selected, width)];
		lines.push(...this.#renderOutput(width, height - lines.length, selected, detail));
		return lines;
	}

	/**
	 * The output viewport: an `Output` header over the captured tail, or the
	 * newest shown captured line alone when a single row is available. A paused
	 * frame shows its frozen capture outright — while it matches, the live text
	 * is not sanitized or split at all — and the viewport is
	 * only re-filled when the shown job, the follow state, or (while live) the
	 * text changed, so an unchanged 250 ms repaint re-copies nothing. An empty
	 * capture clears the viewport instead, so no previous job's rows or scroll
	 * offset survive into the next fill.
	 */
	#renderOutput(
		width: number,
		rows: number,
		job: JobsPanelJob,
		detail: JobsPanelDetail | undefined,
	): readonly string[] {
		if (rows <= 0) return [];
		const output = detail?.output ?? "";
		// While following, the viewport tracks the live capture. Once paused, the
		// rows stay on the buffer that was on screen when following stopped, so the
		// source appending, rolling or emptying the capture never shifts the
		// viewport; End or Space resumes the current snapshot. Only a frame without
		// a matching freeze parses the live capture.
		const frozen = !this.#follow ? this.#frozen : undefined;
		const matched = frozen !== undefined && frozen.id === job.id;
		const lines = frozen && matched ? frozen.lines : this.#outputLines(job.id, output);
		if (!this.#follow && !matched) this.#frozen = { id: job.id, lines };
		const shown = this.#outputView;
		if (lines.length === 0) {
			const message = job.status === "running" ? "No output yet" : "No output";
			// An empty capture must not leave the previous job's rows, height or
			// scroll offset inside the reusable viewport: a later `setLines` would
			// reconcile from that stale offset and open the new capture at a
			// foreign middle segment. Clear it once per empty spell — an unchanged
			// repaint re-copies nothing — and keep the height current for the
			// next fill.
			if (shown && (shown.lines.length > 0 || shown.id !== job.id)) this.#output.setLines([]);
			this.#output.setHeight(rows - 1);
			this.#outputView = { id: job.id, output, frozen: !this.#follow, lines: [] };
			return [truncateToWidth(` ${theme.fg("muted", message)}`, width)];
		}
		// A single output row keeps the same viewport at height 1 and only drops the
		// `Output` header, so PgUp can still page back through the capture.
		const header = rows === 1 ? [] : [truncateToWidth(` ${theme.fg("muted", "Output")}`, width)];
		// The frozen rows are stable, so output churn must not re-copy them; only a
		// job switch, a follow toggle, or (while live) new text replaces the
		// viewport rows.
		if (shown?.id !== job.id || shown.frozen !== matched || (!matched && shown.output !== output)) {
			this.#output.setLines(lines);
			this.#outputView = { id: job.id, output, frozen: matched, lines };
		}
		this.#output.setHeight(rows - header.length);
		return [...header, ...this.#output.render(width)];
	}

	/** One roster row: cursor, id, status tint, type, age and the (cut) label. */
	#jobLine(job: JobsPanelJob, active: boolean, width: number): string {
		const cursor = active ? theme.fg("accent", theme.nav.cursor) : " ";
		const age = formatDuration(Math.max(0, (job.endTime ?? Date.now()) - job.startTime));
		const id = theme.fg("dim", sanitizeDisplaySingleLine(job.id));
		const type = theme.fg("muted", sanitizeDisplaySingleLine(job.type));
		const label = collapseCommand(sanitizeDisplaySingleLine(job.label));
		return truncateToWidth(
			` ${cursor} ${id} ${theme.fg(STATUS_TONE[job.status], job.status)} ${type} ${theme.fg("dim", age)} ${label}`,
			width,
		);
	}

	/** The selected job's status line: glyph, status, live age, type · id. */
	#statusLine(job: JobsPanelJob, width: number): string {
		const tone = STATUS_TONE[job.status];
		const age = formatDuration(Math.max(0, (job.endTime ?? Date.now()) - job.startTime));
		const identity = sanitizeDisplaySingleLine(`${job.type} · ${job.id}`);
		const line =
			` ${theme.fg(tone, STATUS_GLYPH[job.status])} ${theme.fg(tone, STATUS_LABEL[job.status])} ` +
			`${theme.fg("dim", age)}  ${theme.fg("dim", identity)}`;
		return truncateToWidth(line, width);
	}

	/** The selected job's command (a process job) as one sanitized line, or undefined. */
	#commandLine(job: JobsPanelJob, detail: JobsPanelDetail | undefined, width: number): string | undefined {
		const command = detail?.command ?? (job.type === "task" ? undefined : job.label);
		if (!command) return undefined;
		const safe = collapseCommand(sanitizeDisplaySingleLine(command));
		return truncateToWidth(` ${theme.fg("dim", "$")} ${theme.fg("muted", safe)}`, width);
	}

	/** The selected job's facts — agent, cwd, pids, exit code, artifact — as one sanitized line. */
	#factsLine(job: JobsPanelJob, detail: JobsPanelDetail | undefined, width: number): string | undefined {
		const pids = detail?.pids ?? [];
		const exit = detail?.exitCode;
		const facts = compact([
			job.agentId && `agent ${sanitizeDisplaySingleLine(job.agentId)}`,
			detail?.cwd && `cwd ${sanitizeDisplaySingleLine(shortenPath(detail.cwd))}`,
			pids.length > 0 && `${pids.length > 1 ? "pids" : "pid"} ${pids.join(", ")}`,
			exit !== undefined && `exit ${exit}`,
			detail?.artifactId && `artifact://${sanitizeDisplaySingleLine(detail.artifactId)}`,
		]);
		if (facts.length === 0) return undefined;
		return truncateToWidth(` ${theme.fg("dim", facts.join(" · "))}`, width);
	}

	#footer(isSplit: boolean, width: number): string {
		const state = this.#follow ? "following" : "paused";
		// The filter toggle stays visible on every layout: the compact line drops
		// the state word, then the logs/tail hint, before the primary
		// filter/back/cancel hints would overflow the frame (40-column floor).
		const filter = `${formatKeyHint("a")}:${this.#showAll ? "bash" : "all"}`;
		if (width < 96) {
			const back = `${formatKeyHint("escape")}:${this.#detailsOpen ? "back" : "close"}`;
			const view = this.#detailsOpen
				? `${formatKeyHint("end")}:tail`
				: `${formatKeyHint(isSplit ? "enter" : "tab")}:logs`;
			const cancel = `${formatKeyHint("x")}:cancel`;
			let footer = `${filter} ${back} ${view} ${state} ${cancel}`;
			if (visibleWidth(footer) > width) footer = `${filter} ${back} ${view} ${cancel}`;
			if (visibleWidth(footer) > width) footer = `${filter} ${back} ${cancel}`;
			return theme.fg("dim", footer);
		}
		const scroll = `${formatKeyHints(["pageUp", "pageDown"])}:scroll`;
		const follow = `${formatKeyHint("space")}:follow`;
		const cancel = `${formatKeyHint("x")}:cancel`;
		const back = `${formatKeyHint("escape")}:${this.#detailsOpen ? "back" : "close"}`;
		// `·  state` is the least valuable segment of the wide line: only appended
		// when the rest of the hints leave room for it.
		const tail = `  ·  ${state}`;
		let footer = this.#detailsOpen
			? `${scroll}  ${filter}  ${formatKeyHint("end")}:tail  ${follow}  ${cancel}  ${back}`
			: `${formatKeyHints(["j", "k"])}:select  ${filter}  ` +
				`${formatKeyHint(isSplit ? "enter" : "tab")}:logs  ${scroll}  ${follow}  ${cancel}  ${back}`;
		if (visibleWidth(footer) + visibleWidth(tail) <= width) footer += tail;
		return theme.fg("dim", footer);
	}

	#current(): JobsSample {
		const { running, recent } = this.#source.load();
		// Filter into a fresh roster without mutating or copying the source arrays.
		const jobs: JobsPanelJob[] = [];
		for (const job of running) if (this.#showAll || job.type === "bash") jobs.push(job);
		for (const job of recent) if (this.#showAll || job.type === "bash") jobs.push(job);
		const hidden = running.length + recent.length - jobs.length;
		const previous = this.#selectedId;
		const selected = jobs.find(job => job.id === previous) ?? jobs[0];
		this.#selectedId = selected?.id;
		// The selection can vanish (job evicted, or hidden by the bash filter) or
		// arrive from nothing; when that changes the identity, treat it like an
		// explicit move so a paused viewport follows the new job's newest output
		// instead of keeping a stale freeze. A selection that stays visible keeps
		// its paused viewport across filter toggles.
		if (selected?.id !== previous) this.#setFollow(true);
		// With no jobs left there is nothing to show in the log surface: fall back
		// to the (empty) roster page rather than a blank expanded body. The page
		// itself stays mounted; closing stays with Esc on the roster.
		if (!selected && this.#detailsOpen) this.#detailsOpen = false;
		return { jobs, selected, hidden };
	}

	#move(delta: number): void {
		const { jobs, selected } = this.#current();
		if (!selected) return;
		const index = Math.max(0, Math.min(jobs.length - 1, jobs.indexOf(selected) + delta));
		const next = jobs[index]?.id;
		if (next === undefined || next === this.#selectedId) return;
		// A different job starts fresh at its own tail (the frozen buffer belonged
		// to the previous job).
		this.#selectedId = next;
		this.#setFollow(true);
	}

	#cancelSelected(): void {
		const { selected } = this.#current();
		if (selected?.status === "running") this.#source.cancel(selected.id);
	}

	/** Sanitized output rows for one job, memoized by id + text so repaints never re-split it. */
	#outputLines(id: string, output: string): readonly string[] {
		const cached = this.#outputCache;
		if (cached?.id === id && cached.output === output) return cached.lines;
		const lines = splitOutput(output);
		this.#outputCache = { id, output, lines };
		return lines;
	}

	/**
	 * Bound the frame to the terminal: one row per line (already width-fit by the
	 * layout), never more than the terminal's rows. A tiny terminal keeps the
	 * title and footer visible instead of spilling into scrollback.
	 */
	#clampFrame(lines: readonly string[], width: number, termHeight: number): readonly string[] {
		const frame = lines.map(line => clampHubLine(line, width));
		if (frame.length <= termHeight) return frame;
		const footerLines = Math.min(3, frame.length);
		const bodyEnd = Math.max(0, termHeight - footerLines);
		return [...frame.slice(0, bodyEnd), ...frame.slice(-footerLines)].slice(0, termHeight);
	}
}

/** Running jobs first, then recent, each under a quiet group heading. */
function rosterEntries(jobs: readonly JobsPanelJob[]): RosterEntry[] {
	const entries: RosterEntry[] = [];
	const running = jobs.filter(job => job.status === "running");
	const recent = jobs.filter(job => job.status !== "running");
	if (running.length > 0) {
		entries.push({ head: "Running" });
		for (const job of running) entries.push({ job });
	}
	if (recent.length > 0) {
		entries.push({ head: "Recent" });
		for (const job of recent) entries.push({ job });
	}
	return entries;
}

/**
 * A job's captured output as sanitized, line-oriented rows: ANSI and control
 * characters are stripped (the capture is untrusted) and the trailing newline
 * removed. Tabs and over-long rows are bounded by the viewport at render time.
 */
function splitOutput(output: string): readonly string[] {
	if (output.length === 0) return [];
	const clean = sanitizeText(output).trimEnd();
	if (clean.length === 0) return [];
	return clean.split("\n");
}
