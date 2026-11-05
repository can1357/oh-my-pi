/**
 * Tool runs (`display.groupToolCalls`): back-to-back tool blocks with nothing
 * visible between them fold into one summary row drawn by the run's first
 * block. The transcript links members each frame; every member stays its own
 * transcript block and only asks its run what to draw.
 *
 *   ✓ 6 tool calls  Read ×3 · Grep · Bash ×2   (ctrl+o to expand)
 */
import type { Component } from "../tui";
import { theme } from "../theme";
import { truncateToWidth } from "../utils";
import { isNativeRendering } from "../native/state";
import { expandKeyHint, formatStatusIcon } from "../render/render-utils";
import { chatTranscriptDisplayPreferences } from "./display-preferences";
import { sharedSpinnerFrame } from "../spinner-clock";

export type ToolRunStatus = "pending" | "running" | "success" | "warning" | "error";

/** One call as a run summary counts it. */
export interface ToolRunCall {
	readonly label: string;
	readonly detail?: string;
	readonly status: ToolRunStatus;
}

/** A transcript block a tool run can fold. */
export interface ToolRunMember {
	/**
	 * Calls this block adds to a run. `undefined` keeps the block out of runs
	 * (it shows on its own and breaks the run); empty means the run absorbs the
	 * block without counting it (a usage row) and never starts a run with it.
	 */
	toolRunCalls(): readonly ToolRunCall[] | undefined;
	/** Ctrl+O expansion: an expanded head shows the whole run as separate blocks. */
	isToolRunExpanded(): boolean;
	/** Own lifecycle, as the transcript reads it; a head also waits on the rest of its run. */
	isTranscriptBlockFinalized?(): boolean;
}

export type ToolRunMemberBlock = Component & ToolRunMember;

const EMPTY_ROWS: readonly string[] = [];
const CLICK_PREFIX = "@omp:tool-run:";
const runOfMember = new WeakMap<Component, ToolRun>();
const runsByClickId = new Map<string, WeakRef<ToolRun>>();
let nextRunId = 0;

export function asToolRunMember(component: Component): ToolRunMemberBlock | undefined {
	return typeof (component as Partial<ToolRunMember>).toolRunCalls === "function"
		? (component as ToolRunMemberBlock)
		: undefined;
}

export function toolRunOf(member: Component): ToolRun | undefined {
	return runOfMember.get(member);
}

/** Take `member` out of whatever run it was linked into, so it draws on its own. */
export function leaveToolRun(member: Component): void {
	const run = runOfMember.get(member);
	run?.link(run.members.filter(other => other !== member));
}

export function isToolRunClickId(id: string): boolean {
	return id.startsWith(CLICK_PREFIX);
}

/** Flip one run between its summary row and its separate blocks. False when the run is gone. */
export function toggleToolRun(clickId: string): boolean {
	const run = runsByClickId.get(clickId)?.deref();
	if (run === undefined) {
		runsByClickId.delete(clickId);
		return false;
	}
	run.toggleOpen();
	return true;
}

const STATUS_RANK: Record<ToolRunStatus, number> = { success: 0, warning: 1, error: 2, pending: 3, running: 3 };

export class ToolRun {
	readonly clickId = `${CLICK_PREFIX}${++nextRunId}`;
	#members: ToolRunMemberBlock[] = [];
	#open = false;
	// The head left the live viewport for native history; its summary is final.
	#frozen = false;

	constructor() {
		runsByClickId.set(this.clickId, new WeakRef(this));
	}

	get head(): ToolRunMemberBlock | undefined {
		return this.#members[0];
	}

	get members(): readonly ToolRunMemberBlock[] {
		return this.#members;
	}

	get frozen(): boolean {
		return this.#frozen;
	}

	/** Replace the membership the transcript linked this frame; the first member is the head. */
	link(members: readonly ToolRunMemberBlock[]): void {
		for (const member of this.#members) {
			if (runOfMember.get(member) === this && !members.includes(member)) runOfMember.delete(member);
		}
		this.#members = [...members];
		for (const member of members) runOfMember.set(member, this);
	}

	freezeIfHead(component: Component): void {
		if (component === this.head) this.#frozen = true;
	}

	toggleOpen(): void {
		this.#open = !this.#open;
	}

	/** Whether the run draws as one summary row right now. */
	collapsed(): boolean {
		const prefs = chatTranscriptDisplayPreferences;
		if (!prefs.groupToolCalls || prefs.hideToolActivity || isNativeRendering()) return false;
		const head = this.head;
		if (this.#open || head === undefined || head.isToolRunExpanded()) return false;
		return this.#calls().length >= 2;
	}

	/** Whether a click on the run's rows toggles it (expanded by Ctrl+O leaves nothing to toggle). */
	clickable(): boolean {
		const prefs = chatTranscriptDisplayPreferences;
		if (!prefs.groupToolCalls || prefs.hideToolActivity || isNativeRendering()) return false;
		const head = this.head;
		return head !== undefined && !head.isToolRunExpanded() && this.#calls().length >= 2;
	}

	/** Rows `member` draws while collapsed: the summary for the head, nothing for the rest. */
	rowsFor(member: Component, width: number, maxRows = Number.POSITIVE_INFINITY): readonly string[] | undefined {
		if (!this.collapsed()) return undefined;
		if (member !== this.head) return EMPTY_ROWS;
		const rows = this.#summary(width);
		return rows.length > maxRows ? rows.slice(0, Math.max(1, maxRows)) : rows;
	}

	/**
	 * Whether every member after the head settled. The head stays live until
	 * then: once it retires, its summary row is frozen in native history and
	 * cannot count a late result.
	 */
	tailFinalized(member: Component): boolean {
		if (member !== this.head) return true;
		for (let index = 1; index < this.#members.length; index++) {
			if (this.#members[index]!.isTranscriptBlockFinalized?.() === false) return false;
		}
		return true;
	}

	#calls(): ToolRunCall[] {
		return this.#members.flatMap(member => member.toolRunCalls() ?? []);
	}

	#summary(width: number): string[] {
		const calls = this.#calls();
		let status: ToolRunStatus = "success";
		let failed = 0;
		const counts = new Map<string, number>();
		let live: ToolRunCall | undefined;
		for (const call of calls) {
			if (STATUS_RANK[call.status] > STATUS_RANK[status]) status = call.status;
			if (call.status === "error") failed++;
			if (call.status === "running" || call.status === "pending") live = call;
			counts.set(call.label, (counts.get(call.label) ?? 0) + 1);
		}
		const tally = [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(" · ");
		const glyph =
			status === "pending" || status === "running"
				? formatStatusIcon("running", theme, sharedSpinnerFrame(theme.spinnerFrames.length))
				: formatStatusIcon(status, theme);
		const failure = failed > 0 ? theme.fg("error", ` · ${failed} failed`) : "";
		const head =
			`${glyph} ${theme.fg("toolTitle", theme.bold(`${calls.length} tool calls`))}  ` +
			`${theme.fg("muted", tally)}${failure}  ${theme.fg("dim", `(${expandKeyHint()} to expand)`)}`;
		const rows = [truncateToWidth(head, width)];
		if (live !== undefined) {
			const detail = live.detail ? ` · ${live.detail}` : "";
			rows.push(truncateToWidth(theme.fg("muted", `  ${theme.tree.last} ${live.label}${detail}`), width));
		}
		return rows;
	}
}
