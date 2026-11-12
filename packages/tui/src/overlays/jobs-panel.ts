/**
 * The async background jobs of a session as {@link JobsSheet}: the dismissable
 * sheet the native jobs pill and `/jobs` open. A master–detail split lists
 * every job of the session's agent and its subagents as a tree (see
 * {@link buildJobTree}) beside the selected one's status, command, facts
 * (cwd, live pids, exit code, artifact) and live output. A terminal without
 * the native surface renders the same source as a bounded fallback: a
 * selection-centered window of the tree, the selected job's newest output
 * (pausable) and a one-row key guide, fit within the host's row budget.
 */
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Component } from "../tui";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "../utils";
import { ScrollView } from "../components/scroll-view";
import { centeredViewportRange } from "../components/scroll-viewport";
import { collapseCommand } from "../apps/ps-data";
import { PREVIEW_LIMITS, shortenEmbeddedPaths, shortenPath } from "../render/render-utils";
import { ansi, code, col, compact, item, node, row, span, stableKey, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";
import { fgOrPlain, theme } from "../theme/theme";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import { buildJobTree, type JobTreeAgent, type JobTreeRow, jobTreeGuide } from "./job-tree";
import { describeJobWidget, type JobWidgetView, renderJobWidgetLines } from "../tools/job-widget";

/** One async job as the session snapshots it. */
export interface JobsPanelJob {
	readonly id: string;
	readonly type: string;
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly label: string;
	/** What the job is for, in the model's words; rows and the detail lead with it over a command `label`. */
	readonly intent?: string;
	/** One line on what a command does and when it ends, from the cheap model; the detail shows it under the intent. */
	readonly caption?: string;
	readonly startTime: number;
	readonly endTime?: number;
	/** Registry id of the agent that owns the job. */
	readonly ownerId?: string;
	/** Registry id of the subagent a task job runs. */
	readonly agentId?: string;
}

/** Running and recently settled jobs of an agent and its subagents. */
export interface JobsPanelSnapshot {
	readonly running: readonly JobsPanelJob[];
	readonly recent: readonly JobsPanelJob[];
	/** The agent the sheet is for: its jobs sit at the top level, and only they can be cancelled. */
	readonly rootId?: string;
	/** Subagents owning listed jobs, with the ancestors linking them to the root. */
	readonly agents?: readonly JobTreeAgent[];
}

/** What the sheet shows about the selected job beyond its row. */
export interface JobsPanelDetail {
	/** Full command line of a job that runs a process (rows show the cut label). */
	readonly command?: string;
	readonly cwd?: string;
	/** Live pids the job's command spawned. */
	readonly pids: readonly number[];
	readonly exitCode?: number;
	/** Output tail while running; the final text once settled. */
	readonly output?: string;
	/** Artifact holding the full output when `output` is cut. */
	readonly artifactId?: string;
	/** The job's live widget (frozen once it settles), drawn above the output. */
	readonly widget?: JobWidgetView;
}

/** The session behind a {@link JobsSheet}. */
export interface JobsSheetSource {
	/** Current jobs; runs once per frame. */
	load(): JobsPanelSnapshot;
	/** The selected job's detail; runs once per frame, undefined once the job is gone. */
	inspect(id: string): JobsPanelDetail | undefined;
	/**
	 * Cancel a running job. Omitted by a read-only sheet (a focused subagent
	 * view, which only watches that agent): it lists the jobs and offers no way
	 * to stop them.
	 */
	cancel?(id: string): void;
	/** Dismiss the sheet. */
	close(): void;
	/**
	 * The overlay body budget in terminal rows, supplied by the host next to
	 * its `maxHeight` option so both bound the sheet with the same number. The
	 * terminal fallback (`render`) fits its whole output — header, windowed
	 * tree, metadata and the newest output — within it, re-reading it every
	 * frame so a resize applies on the next render; the native sheet ignores
	 * it. When omitted the fallback assumes a conservative 24 rows.
	 */
	maxRows?(): number;
}

/** A job's status as the sheet names it. */
const STATUS_LABEL: Record<JobsPanelJob["status"], string> = {
	running: "Running",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

/** A job's status color: the list row's icon and the detail's status pill. */
const STATUS_TONE: Record<JobsPanelJob["status"], TspTone> = {
	running: "pending",
	completed: "success",
	failed: "error",
	cancelled: "muted",
};

/** The status pill's lead glyph; a running job's pulses. */
const STATUS_GLYPH: Record<JobsPanelJob["status"], TspSpan> = {
	running: { t: "●", fx: "pulse" },
	completed: { t: "✓" },
	failed: { t: "✕" },
	cancelled: { t: "⊘" },
};

/** The list row's icon per job type (Tern icon names); other types read as a generic job. */
const TYPE_ICON: Record<string, string> = { bash: "bash", task: "agent" };

/** Body rows the terminal fallback assumes when the host gives no {@link JobsSheetSource.maxRows}. */
const FALLBACK_MAX_ROWS = 24;

/**
 * Output rows the terminal fallback reserves ahead of the optional metadata
 * (command, facts, widget), so a short viewport clips metadata first and the
 * newest capture stays visible.
 */
const OUTPUT_RESERVE_ROWS = 3;

/** Shared empty capture: no rows until the job produces output. */
const EMPTY_CAPTURE_ROWS: readonly string[] = [];

/**
 * The jobs pill's sheet: a centred `lg` glass sheet titled Background jobs.
 * A master–detail split (it stacks in a narrow pane): the selectable job tree
 * beside the selected job's detail — a status pill with live elapsed and
 * Cancel job, its command or task, facts (agent, cwd, live pids, exit code,
 * artifact) and a tail-following output pane. With no jobs it shows an empty
 * state. It re-reads the session every frame, so the caller re-renders it on
 * a timer while it is open. ↑/↓ select, X cancels the selected running job,
 * Esc or Close dismisses; nothing enters the transcript. A source without
 * `cancel` renders read-only, and a subagent's job never offers Cancel: only
 * the root's own jobs can be stopped here.
 *
 * In a terminal without the native surface the same source renders as a
 * bounded fallback within the host's `maxRows` budget: a selection-centered
 * window of the tree, the selected job's metadata if room, its newest output
 * and a one-row key guide. The output pane follows the capture tail; Space
 * pauses on the exact rows shown (per job), PgUp/PgDn/Home scroll, End or
 * Space resumes, and each job's pane starts at its own tail.
 */
export class JobsSheet implements Component {
	readonly nativeOverlay = {
		role: "omp.overlay.jobs",
		size: "lg",
		anchor: "center",
		head: "Background jobs",
	} as const;
	readonly #source: JobsSheetSource;
	#selectedId: string | undefined;
	#native: { key: string; output: string | undefined; node: NativeNode } | undefined;
	/** The fallback output pane: a viewport over the selected job's capture rows. */
	readonly #log = new ScrollView([], {
		height: 1,
		followTail: true,
		theme: { track: t => fgOrPlain("muted", t), thumb: t => fgOrPlain("accent", t) },
	});
	/**
	 * The rows shown when Space paused the pane, keyed by job: a paused pane
	 * displays these verbatim (even when empty); every other job follows its
	 * tail. Toggled only where input is handled — never by render.
	 */
	#frozen: { id: string; lines: readonly string[] } | undefined;
	/** What the pane currently holds, so an unchanged repaint re-feeds nothing. */
	#outputView: { id: string; output: string; frozen: boolean; lines: readonly string[] } | undefined;
	/** The selected job's capture as display rows, keyed by job + text: unchanged output is never split again. */
	#capture: { id: string; output: string; lines: readonly string[] } | undefined;
	/**
	 * The selected job as last seen: its row, detail and the subagents placing
	 * it. The session evicts settled jobs on its own clock; while the user keeps
	 * one selected it stays listed with its last output, until they select another.
	 */
	#held: { job: JobsPanelJob; detail: JobsPanelDetail | undefined; agents: readonly JobTreeAgent[] } | undefined;

	constructor(source: JobsSheetSource) {
		this.#source = source;
	}

	describe(_cx: DescribeContext): NativeNode {
		const { rows, jobs, selected, cancellable } = this.#current();
		const detail = selected && this.#inspect(selected.id);
		const now = Date.now();
		// Elapsed nodes tick on their own; list values and the output pane redraw
		// when a job starts, settles, leaves or moves in the tree, gets its
		// caption (it can land after the job settles), its process changes, its
		// output grows, or (while one runs) once a second.
		const key = [
			rows
				.map(
					entry =>
						`${jobTreeGuide(entry, theme)}${entry.kind === "job" ? `${entry.job.id}:${entry.job.status}:${entry.job.caption ?? ""}` : entry.agent.id}`,
				)
				.join(","),
			selected?.id,
			detail?.pids.join(" "),
			detail?.exitCode,
			detail?.artifactId,
			detail?.widget ? `${detail.widget.updatedAt}:${detail.widget.state}` : "",
			jobs.some(job => job.status === "running") ? Math.floor(now / 1000) : "",
		].join("|");
		const output = detail?.output;
		if (this.#native?.key === key && this.#native.output === output) return this.#native.node;
		const close = actionButton("Close", "close", { keys: "escape" });
		const described = selected
			? col([
					node(
						"row",
						{ role: "omp.jobs.split" },
						[
							node("col", { role: "omp.jobs.master" }, [describeJobList(rows, selected, now)], "master"),
							describeDetail(selected, detail, now, cancellable),
						],
						"split",
					),
					actionBar([describeSummary(jobs), null, close]),
				])
			: col([describeEmpty(), actionBar([null, close])]);
		this.#native = { key, output, node: described };
		return described;
	}

	/**
	 * Rows for a terminal without the native surface, within the host's row
	 * budget: the header, a selection-centered window of the tree, the selected
	 * job's metadata if room is left after reserving the newest output, that
	 * output, and the key guide. Never more rows than the budget.
	 */
	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, Math.trunc(Number.isFinite(width) ? width : 1));
		const budget = this.#bodyBudget();
		const { rows, jobs, selected, cancellable } = this.#current();
		const running = jobs.filter(job => job.status === "running").length;
		const lines = [truncateToWidth(` Background jobs · ${running} running`, safeWidth)];
		if (!selected) {
			if (budget >= 2) lines.push(truncateToWidth(" No background jobs", safeWidth));
			if (budget >= 3) lines.push(this.#controlsLine(safeWidth, true, false));
			return lines;
		}
		const now = Date.now();
		const selectedRow = rows.findIndex(entry => entry.kind === "job" && entry.job.id === selected.id);
		if (budget === 1) return lines;
		if (budget === 2) {
			// Degrade: the header plus the selected row alone.
			const entry = rows[Math.max(0, selectedRow)];
			if (entry) lines.push(this.#treeLine(entry, selected, now, safeWidth));
			return lines;
		}
		// Header and key guide are fixed; the newest output is reserved before the
		// optional metadata and keeps the majority of what remains.
		const body = budget - 2;
		const treeRows = Math.max(1, body - OUTPUT_RESERVE_ROWS);
		const window = centeredViewportRange(Math.max(0, selectedRow), rows.length, treeRows);
		for (let index = window.start; index < window.end; index++) {
			lines.push(this.#treeLine(rows[index]!, selected, now, safeWidth));
		}
		const left = Math.max(0, body - (window.end - window.start));
		// The held job outlives its eviction from the snapshot, so read its detail through #inspect.
		const detail = this.#inspect(selected.id);
		const reserve = Math.min(left, OUTPUT_RESERVE_ROWS);
		const metadata = this.#metadataLines(selected, detail, safeWidth, Math.max(0, Math.floor((left - reserve) / 2)));
		lines.push(...metadata);
		lines.push(...this.#outputSection(selected, detail, safeWidth, left - metadata.length));
		lines.push(
			this.#controlsLine(safeWidth, this.#frozen?.id !== selected.id, cancellable && selected.status === "running"),
		);
		return lines;
	}

	invalidate(): void {
		this.#native = undefined;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) this.#source.close();
		else if (matchesSelectUp(data)) this.#move(-1);
		else if (matchesSelectDown(data)) this.#move(1);
		else if (matchesKey(data, "x")) this.#cancelSelected();
		// Terminal fallback log keys. The native sheet ignores them — they only
		// move the fallback output pane, never the native actions above.
		else if (matchesKey(data, "pageUp")) this.#scrollLog(-1);
		else if (matchesKey(data, "pageDown")) this.#scrollLog(1);
		else if (matchesKey(data, "home")) this.#scrollToLogTop();
		else if (matchesKey(data, "end")) this.#resume();
		else if (matchesKey(data, "space")) {
			const { selected } = this.#current();
			if (!selected) return;
			if (this.#frozen?.id === selected.id) this.#resume();
			else this.#pause(selected.id);
		}
	}

	/** Clicks select a row; Close and Cancel job run what Esc and X run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select" || event.type === "activate") this.#selectedId = event.item;
		else if (event.type === "action" && event.act === "close") this.#source.close();
		else if (event.type === "action" && event.act === "cancel") this.#cancelSelected();
	}

	/**
	 * The job tree, its jobs in tree order, the selected one (the first when
	 * the selection left) and whether the sheet can stop it: a job the root
	 * owns, with a source that cancels.
	 */
	#current(): {
		rows: readonly JobTreeRow<JobsPanelJob>[];
		jobs: readonly JobsPanelJob[];
		selected: JobsPanelJob | undefined;
		cancellable: boolean;
	} {
		const snapshot = this.#source.load();
		const { running, rootId } = snapshot;
		let { recent, agents = [] } = snapshot;
		// A settled job the session evicted stays listed while it is selected.
		const held = this.#held?.job.id === this.#selectedId ? this.#held : undefined;
		const evicted =
			held !== undefined &&
			held.job.status !== "running" &&
			!running.some(job => job.id === held.job.id) &&
			!recent.some(job => job.id === held.job.id);
		if (evicted) {
			recent = [...recent, held.job];
			const known = new Set(agents.map(agent => agent.id));
			agents = [...agents, ...held.agents.filter(agent => !known.has(agent.id))];
		}
		const rows = buildJobTree([...running, ...recent], agents, rootId);
		const jobs = rows.flatMap(entry => (entry.kind === "job" ? [entry.job] : []));
		const selected = jobs.find(job => job.id === this.#selectedId) ?? jobs[0];
		this.#selectedId = selected?.id;
		if (!selected) this.#held = undefined;
		else if (!evicted) {
			const detail = held?.job.id === selected.id ? held.detail : undefined;
			this.#held = { job: selected, detail, agents: snapshot.agents ?? [] };
		}
		const owned = selected?.ownerId === undefined || selected.ownerId === rootId;
		return { rows, jobs, selected, cancellable: this.#source.cancel !== undefined && owned };
	}

	/** The host's overlay body budget, or a conservative default when it supplies none. */
	#bodyBudget(): number {
		const rows = this.#source.maxRows?.();
		if (rows === undefined || !Number.isFinite(rows)) return FALLBACK_MAX_ROWS;
		return Math.max(1, Math.trunc(rows));
	}

	/** The job's detail from the source, else the last one seen while it was held. */
	#inspect(id: string): JobsPanelDetail | undefined {
		const detail = this.#source.inspect(id);
		const held = this.#held?.job.id === id ? this.#held : undefined;
		if (!held) return detail;
		if (detail) held.detail = detail;
		return held.detail;
	}

	/** One tree row: job id next to the cursor, then status, type, age, agent and what the job is for, single-line safe. */
	#treeLine(entry: JobTreeRow<JobsPanelJob>, selected: JobsPanelJob, nowMs: number, width: number): string {
		const guide = jobTreeGuide(entry, theme);
		if (entry.kind === "agent") {
			return truncateToWidth(`  ${guide}${sanitizeDisplaySingleLine(entry.agent.id)}`, width);
		}
		const { job } = entry;
		const cursor = job.id === selected.id ? ">" : " ";
		const age = formatDuration(jobAge(job, nowMs));
		const agent = entry.agent && entry.agent.id !== job.label ? `${sanitizeDisplaySingleLine(entry.agent.id)}: ` : "";
		const id = sanitizeDisplaySingleLine(job.id);
		// The intent is model-written: strip terminal controls, flatten it to one
		// row and shorten home paths like the command; the label stands in without one.
		const title = sanitizeDisplaySingleLine(
			shortenEmbeddedPaths(collapseCommand(sanitizeText(job.intent ?? job.label))),
		);
		return truncateToWidth(
			`${cursor} ${guide}${id} ${job.status}  ${sanitizeDisplaySingleLine(job.type)} ${age}  ${agent}${title}`,
			width,
		);
	}

	/** Optional metadata shares the space left after reserving output rows: caption, command, facts and widget. */
	#metadataLines(
		job: JobsPanelJob,
		detail: JobsPanelDetail | undefined,
		width: number,
		budget: number,
	): readonly string[] {
		if (budget <= 0) return [];
		const lines: string[] = [];
		// The caption is model-written: strip terminal controls and wrap it within
		// the rows metadata has, so it never pushes the reserved newest output off.
		if (job.caption) {
			const captionRows = wrapTextWithAnsi(
				shortenEmbeddedPaths(replaceTabs(sanitizeText(job.caption))),
				Math.max(1, width - 3),
			);
			const shown = Math.min(captionRows.length, budget);
			for (const line of captionRows.slice(0, shown)) {
				lines.push(truncateToWidth(`   ${fgOrPlain("muted", line)}`, width));
			}
			const hidden = captionRows.length - shown;
			if (hidden > 0 && lines.length < budget) {
				lines.push(truncateToWidth(`   … ${hidden} more caption lines`, width));
			}
		}
		if (lines.length >= budget) return lines;
		// Rows show the cut label; the selected job's command wraps here,
		// bounded so a long script never pushes the facts and output off the sheet.
		const command = detail?.command ?? (job.type === "task" ? undefined : job.label);
		if (command) {
			const commandRows = wrapTextWithAnsi(
				shortenEmbeddedPaths(replaceTabs(sanitizeText(command))),
				Math.max(1, width - 3),
			);
			const shown = Math.min(commandRows.length, PREVIEW_LIMITS.EXPANDED_LINES, budget);
			for (const line of commandRows.slice(0, shown)) lines.push(truncateToWidth(`   ${line}`, width));
			const hidden = commandRows.length - shown;
			if (hidden > 0 && lines.length < budget) {
				lines.push(truncateToWidth(`   … ${hidden} more command lines`, width));
			}
		}
		if (lines.length >= budget) return lines;
		const pids = detail?.pids ?? [];
		const facts = compact([
			detail?.cwd && `cwd ${sanitizeDisplaySingleLine(shortenPath(detail.cwd))}`,
			pids.length > 0 && `pid ${pids.join(", ")}`,
			detail?.exitCode !== undefined && `exit ${detail.exitCode}`,
			detail?.artifactId && `artifact://${sanitizeDisplaySingleLine(detail.artifactId)}`,
		]);
		if (facts.length > 0) lines.push(truncateToWidth(`   ${facts.join(" · ")}`, width));
		if (lines.length >= budget || !detail?.widget || !widgetHasData(detail.widget)) return lines;
		for (const line of renderJobWidgetLines(detail.widget, Math.max(0, width - 3), theme)) {
			if (lines.length >= budget) break;
			lines.push(truncateToWidth(`   ${line}`, width));
		}
		return lines;
	}

	/**
	 * The selected job's output under a viewport of `rows` rows. A pane paused
	 * for this job shows the rows frozen when Space stopped it — held by
	 * reference, so a capture that rolls or empties cannot shift the viewport;
	 * any other job defaults to its live tail. The pane is re-fed only when the
	 * job, the freeze, or (while live) the text changed.
	 */
	#outputSection(
		job: JobsPanelJob,
		detail: JobsPanelDetail | undefined,
		width: number,
		rows: number,
	): readonly string[] {
		if (rows <= 0) return [];
		const output = detail?.output ?? "";
		const frozen = this.#frozen;
		const paused = frozen?.id === job.id;
		const lines = paused ? frozen.lines : this.#captureLines(job.id, output);
		const shown = this.#outputView;
		if (lines.length === 0) {
			// An empty capture clears the pane once per empty spell, so no previous
			// job's rows or scroll offset survive into the next fill.
			if (shown && (shown.lines.length > 0 || shown.id !== job.id)) this.#log.setLines([]);
			this.#log.setHeight(Math.max(0, rows - 1));
			this.#outputView = { id: job.id, output, frozen: paused, lines };
			const message = job.status === "running" ? "No output yet" : "No output";
			return [truncateToWidth(` ${fgOrPlain("muted", message)}`, width)];
		}
		const head = rows >= 2 ? [truncateToWidth(` ${fgOrPlain("muted", "Output")}`, width)] : [];
		if (!shown || shown.id !== job.id || shown.frozen !== paused || (!paused && shown.output !== output)) {
			this.#log.setFollowTail(!paused);
			this.#log.setLines(lines);
			this.#outputView = { id: job.id, output, frozen: paused, lines };
			// A new job's pane starts at its own tail, never mid-history.
			if (shown?.id !== job.id) this.#log.scrollToBottom();
		}
		this.#log.setHeight(rows - head.length);
		return [...head, ...this.#log.render(width)];
	}

	/** The one-row key guide; the pause hint follows the pane's live state, X appears only when it can act. */
	#controlsLine(width: number, follow: boolean, canCancel: boolean): string {
		const hints = compact([
			"esc close",
			canCancel && "x cancel",
			"↑/↓ select",
			`space ${follow ? "pause" : "follow"}`,
			"pgup/dn log",
		]);
		return truncateToWidth(` ${fgOrPlain("dim", hints.join(" · "))}`, width);
	}

	/** Sanitized capture rows for one job, memoized by job + text: unchanged output is never split again. */
	#captureLines(id: string, output: string): readonly string[] {
		const cached = this.#capture;
		if (cached?.id === id && cached.output === output) return cached.lines;
		const lines = captureRows(output);
		this.#capture = { id, output, lines };
		return lines;
	}

	/** Freeze the rows the pane currently shows for `id` — even an empty capture — keyed by job. */
	#pause(id: string): void {
		const shown = this.#outputView;
		if (shown?.id === id) this.#frozen = { id, lines: shown.lines };
	}

	/** Drop the freeze and return to the live tail. */
	#resume(): void {
		this.#frozen = undefined;
		this.#log.scrollToBottom();
	}

	/** One page of manual log scroll; landing back at the tail resumes following. */
	#scrollLog(direction: -1 | 1): void {
		const { selected } = this.#current();
		if (!selected) return;
		this.#log.page(direction);
		if (this.#log.getScrollOffset() >= this.#log.getMaxScrollOffset()) this.#resume();
		else this.#pause(selected.id);
	}

	/** Jump to the capture head; a capture taller than the pane stops following. */
	#scrollToLogTop(): void {
		const { selected } = this.#current();
		if (!selected) return;
		this.#log.scrollToTop();
		if (this.#log.getScrollOffset() >= this.#log.getMaxScrollOffset()) this.#resume();
		else this.#pause(selected.id);
	}

	#move(delta: number): void {
		const { jobs, selected } = this.#current();
		if (!selected) return;
		const index = Math.max(0, Math.min(jobs.length - 1, jobs.indexOf(selected) + delta));
		this.#selectedId = jobs[index]?.id;
	}

	#cancelSelected(): void {
		const { selected, cancellable } = this.#current();
		if (cancellable && selected?.status === "running") this.#source.cancel?.(selected.id);
	}
}

/** How long a job ran, or has been running. */
function jobAge(job: JobsPanelJob, nowMs: number): number {
	return Math.max(0, (job.endTime ?? nowMs) - job.startTime);
}

/** Whether a widget draws more than its title: one without data only repeats the job's heading. */
function widgetHasData(widget: JobWidgetView): boolean {
	return widget.blocks.length > 0 || widget.headline !== undefined || Boolean(widget.stage);
}

/**
 * A job's captured output as display rows: ANSI and control characters are
 * stripped (the capture is untrusted), the trailing newline removed and each
 * row indented under the detail block. Split only when the job's text changes.
 */
function captureRows(output: string): readonly string[] {
	const clean = sanitizeText(output).trimEnd();
	if (clean.length === 0) return EMPTY_CAPTURE_ROWS;
	return clean.split("\n").map(line => `   ${line}`);
}

/**
 * The master list: the job tree, connectors leading each label. A subagent
 * without a listed task job heads its jobs as a quiet label (a plain text
 * child: no row behavior, so ↑/↓ and clicks pass it by).
 */
function describeJobList(rows: readonly JobTreeRow<JobsPanelJob>[], selected: JobsPanelJob, nowMs: number): NativeNode {
	const children: NativeChild[] = rows.map(entry => {
		const guide = jobTreeGuide(entry, theme);
		if (entry.kind === "job") return describeJobItem(entry.job, entry.agent?.id, guide, nowMs);
		return node(
			"text",
			{
				role: "omp.jobs.group",
				spans: compact([guide !== "" && span(guide, "mono dim"), span(entry.agent.id)]),
				wrap: "none",
			},
			undefined,
			`agent-${stableKey(entry.agent.id)}`,
		);
	});
	return selectList("jobs", children, { selected: selected.id, max: { lines: 12 } });
}

/**
 * One list row: the type icon tinted by status, the tree connector, the
 * subagent a task job runs, the one-line label (what the job is for when the
 * model said, else a process job's command in mono or a task's work in prose)
 * and how long it ran.
 */
function describeJobItem(job: JobsPanelJob, agentName: string | undefined, guide: string, nowMs: number): NativeNode {
	const status = STATUS_LABEL[job.status];
	const age = formatDuration(jobAge(job, nowMs));
	return item(job.id, {
		label: compact([
			guide !== "" && span(guide, "mono dim"),
			agentName !== undefined && agentName !== job.label && span(`${agentName} `, "strong"),
			job.intent
				? span(job.intent)
				: job.type === "task"
					? span(job.label)
					: span(collapseCommand(job.label), "mono"),
		]),
		value: [span(age, "mono")],
		icon: TYPE_ICON[job.type] ?? "job",
		tone: STATUS_TONE[job.status],
		title: `${job.intent ? `${job.intent}\n` : ""}${job.caption ? `${job.caption}\n` : ""}${job.label}\n${status} · ${job.type} · ${job.id}`,
		aria: `${job.intent ?? job.label}, ${status.toLowerCase()}, ${age}`,
	});
}

/** The footer's at-a-glance count. */
function describeSummary(jobs: readonly JobsPanelJob[]): NativeNode {
	const running = jobs.filter(job => job.status === "running").length;
	const parts = compact([
		running > 0 && `${running} running`,
		jobs.length > running && `${jobs.length - running} recent`,
	]);
	return node("text", { role: "omp.jobs.summary", text: parts.join(" · "), wrap: "none" }, undefined, "summary");
}

/** No jobs: what the sheet is for, in place of the split. */
function describeEmpty(): NativeNode {
	return node(
		"col",
		{ role: "omp.jobs.empty", align: "center" },
		[
			node("icon", { name: "jobs" }),
			text("No background jobs", { role: "omp.jobs.empty.title" }),
			text("Commands and subagent tasks started in the background show up here while they run.", {
				role: "omp.jobs.empty.note",
				wrap: "word",
			}),
		],
		"empty",
	);
}

/**
 * The selected job: a status line (pill, live elapsed, type · id, Cancel job
 * when `cancellable`), what it is for, what its command does (the cheap
 * model's caption), its full command, facts, its widget
 * when it has data to draw and the output pane (or its empty state).
 */
function describeDetail(
	job: JobsPanelJob,
	detail: JobsPanelDetail | undefined,
	nowMs: number,
	cancellable: boolean,
): NativeNode {
	const settled = job.status !== "running";
	const exit = detail?.exitCode;
	const age = Math.round(jobAge(job, nowMs));
	const command = detail?.command ?? (job.type === "task" ? undefined : job.label);
	const title = job.intent ?? (command ? undefined : job.label);
	const pids = detail?.pids ?? [];
	const facts = compact([
		job.agentId ? { k: "Agent", v: [span(job.agentId, "mono")] } : undefined,
		detail?.cwd ? { k: "Directory", v: [span(detail.cwd, "path")] } : undefined,
		pids.length > 0 && { k: pids.length > 1 ? "PIDs" : "PID", v: [span(pids.join(", "), "num")] },
		exit !== undefined && { k: "Exit code", v: [span(String(exit), exit === 0 ? "success" : "error")] },
		detail?.artifactId ? { k: "Full output", v: [span(`artifact://${detail.artifactId}`, "mono")] } : undefined,
	]);
	const children = compact<NativeChild>([
		row(
			compact<NativeChild>([
				text([STATUS_GLYPH[job.status], span(` ${STATUS_LABEL[job.status]}`)], {
					role: "omp.jobs.state",
					tone: STATUS_TONE[job.status],
					wrap: "none",
				}),
				node("elapsed", {
					age,
					...(settled ? { stopped: age } : {}),
					format: "short",
					role: "omp.jobs.age",
					title: settled ? "Ran for" : "Running for",
				}),
				text([span(`${job.type} · ${job.id}`, "mono")], { role: "omp.jobs.id", wrap: "none", truncate: "end" }),
				node("spacer", { grow: 1 }),
				cancellable && !settled && actionButton("Cancel job", "cancel", { keys: "x", tone: "error" }),
			]),
			{ role: "omp.jobs.status", gap: "sm", align: "center" },
		),
		title ? text(title, { role: "omp.jobs.title", wrap: "word" }) : undefined,
		job.caption ? text([span(job.caption, "muted")], { role: "omp.jobs.caption", wrap: "word" }) : undefined,
		command
			? code(command, { lang: "bash", wrap: true, preview: { lines: 4 }, role: "omp.jobs.command" })
			: undefined,
		facts.length > 0 && node("kv", { items: facts, role: "omp.jobs.facts" }),
		detail?.widget &&
			widgetHasData(detail.widget) &&
			node("col", { role: "omp.jobs.widget" }, [describeJobWidget(detail.widget)], "widget"),
		node(
			"col",
			{ role: "omp.jobs.out", gap: "sm" },
			[
				text("Output", { role: "omp.jobs.label" }),
				detail?.output
					? ansi(detail.output, { follow: !settled, role: "omp.jobs.output", max: { h: "16lines" } })
					: text(settled ? "No output" : "No output yet", { role: "omp.jobs.nooutput" }),
			],
			"out",
		),
	]);
	return node("col", { role: "omp.jobs.detail" }, children, stableKey(job.id));
}
