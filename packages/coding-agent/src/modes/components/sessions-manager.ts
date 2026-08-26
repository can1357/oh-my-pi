/**
 * `/sessions` fullscreen manager overlay.
 *
 * Lists every enumerated session (current + persisted), with keyboard-only
 * navigation and actions keyed by the durable session id/path (never the
 * display name). Data is loaded via `enumerateSessions` on open, on an
 * explicit resync (R), and on a registry change subscription — never per
 * render. A bounded 5s timer only refreshes the relative-age column.
 *
 * Columns degrade on narrow terminals: cost, then model, then cwd are dropped
 * before the name/age/state core. Every cell is sanitized and width-clamped.
 */

import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { matchesKey, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatAge, formatNumber } from "@oh-my-pi/pi-utils";
import { type CheckpointMeta, WorkspaceCheckpointService } from "../../checkpoints";
import { theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import {
	type EnumerateOptions,
	enumerateSessions,
	type SessionFilter,
	type SessionRow,
	type SessionSort,
	setArchived,
} from "../../session/session-control";
import { shortenPath } from "../../tools/render-utils";
import { sanitizeDisplayText } from "./agent-hub-renderer";
import { CheckpointListComponent } from "./checkpoint-list";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

/** Bounded cadence for the relative-age column only. */
const AGE_TICK_MS = 5_000;

/** Process-global pause gate projection the component drives. */
interface PauseGate {
	readonly paused: boolean;
	engage(): unknown;
	release(): unknown;
}

const FILTER_CYCLE: readonly SessionFilter[] = ["current", "active", "paused", "archived", "all"];
const SORT_CYCLE: readonly SessionSort[] = ["recent", "created", "cost", "agents"];

type ConfirmKind = "killCurrent" | "deleteSession";

interface ConfirmState {
	kind: ConfirmKind;
	path: string;
	display: string;
	step: number;
}

export interface SessionsManagerDeps {
	/** Interactive mode context (resume, session manager, status, ui). */
	ctx: InteractiveModeContext;
	/** Overlay host; when absent (render-only tests) navigational keys are inert. */
	ui?: TUI;
	/** Request a repaint from the host TUI. */
	requestRender: () => void;
	/** Called when the user closes the manager (Esc at top level). */
	onClose: () => void;
	/** Project working directory (default: project dir). */
	cwd?: string;
	/** Restrict enumeration to one project's session dir (default: all projects). */
	sessionDir?: string;
	/** Override enumeration (tests inject a fake). */
	enumerate?: (opts: EnumerateOptions) => Promise<SessionRow[]>;
	/** Agent registry (default: `AgentRegistry.global()`). */
	registry?: AgentRegistry;
	/** Pause gate (default: `agentPauseGate`). */
	gate?: PauseGate;
	/** Lifecycle manager for kills (default: `AgentLifecycleManager.global()`). */
	lifecycle?: AgentLifecycleManager;
	/** Checkpoint service (default: `WorkspaceCheckpointService.global()`). */
	checkpointService?: WorkspaceCheckpointService;
	/** Stats read race (ms). */
	statsTimeoutMs?: number;
}

export class SessionsManagerComponent implements Component {
	readonly #ctx: InteractiveModeContext;
	readonly #ui: TUI | undefined;
	readonly #requestRender: () => void;
	readonly #onClose: () => void;
	readonly #cwd: string;
	readonly #sessionDir: string | undefined;
	readonly #enumerate: (opts: EnumerateOptions) => Promise<SessionRow[]>;
	readonly #registry: AgentRegistry;
	readonly #gate: PauseGate;
	readonly #lifecycle: AgentLifecycleManager;
	readonly #checkpointService: WorkspaceCheckpointService;
	readonly #statsTimeoutMs: number | undefined;

	#disposed = false;
	#rows: SessionRow[] = [];
	#selected = 0;
	#filter: SessionFilter = "all";
	#sort: SessionSort = "recent";
	#detailsOpen = false;
	#detailsCheckpoints: CheckpointMeta[] | undefined;
	#confirm: ConfirmState | undefined;
	#notice: string | undefined;
	#pendingAction: Promise<void> = Promise.resolve();
	readonly #ageTimer: NodeJS.Timeout | undefined;
	readonly #unsubscribe: () => void;

	constructor(deps: SessionsManagerDeps) {
		this.#ctx = deps.ctx;
		this.#ui = deps.ui;
		this.#requestRender = deps.requestRender;
		this.#onClose = deps.onClose;
		this.#cwd = deps.cwd ?? process.cwd();
		this.#sessionDir = deps.sessionDir;
		this.#enumerate = deps.enumerate ?? ((opts: EnumerateOptions) => enumerateSessions(opts));
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#gate = deps.gate ?? (agentPauseGate as unknown as PauseGate);
		this.#lifecycle = deps.lifecycle ?? AgentLifecycleManager.global();
		this.#checkpointService = deps.checkpointService ?? WorkspaceCheckpointService.global();
		this.#statsTimeoutMs = deps.statsTimeoutMs;

		this.#unsubscribe = this.#registry.onChange(() => this.#refresh());

		if (this.#ui) {
			this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
			this.#ageTimer.unref?.();
		}

		void this.#refresh();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#ageTimer) clearInterval(this.#ageTimer);
		this.#unsubscribe();
	}

	render(width: number): readonly string[] {
		const inner = Math.max(1, width - 4);
		const lines: string[] = [];
		if (this.#detailsOpen) {
			lines.push(topBorder(width, "Session"));
			for (const line of this.#renderDetails(inner)) lines.push(row(truncateToWidth(line, inner), width));
			lines.push(divider(width));
			lines.push(row(truncateToWidth(this.#detailsFooter(inner), inner), width));
			lines.push(bottomBorder(width));
			return lines;
		}

		lines.push(topBorder(width, this.#headerTitle(inner)));
		for (const line of this.#renderRows(inner)) lines.push(row(truncateToWidth(line, inner), width));
		if (this.#confirm) lines.push(row(truncateToWidth(this.#confirmMessage(), inner), width));
		else if (this.#notice) lines.push(row(truncateToWidth(theme.fg("error", this.#notice), inner), width));
		lines.push(divider(width));
		lines.push(row(truncateToWidth(this.#footer(inner), inner), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.#detailsOpen && (matchesKey(data, "escape") || matchesAppInterrupt(data))) {
			this.#detailsOpen = false;
			this.#requestRender();
			return;
		}
		if (this.#confirm) {
			if (matchesKey(data, "y") || matchesKey(data, "enter") || data === "K") {
				this.#pendingAction = this.#confirmAction();
				return;
			}
			if (matchesKey(data, "n") || matchesKey(data, "escape")) {
				this.#confirm = undefined;
				this.#notice = undefined;
				this.#requestRender();
				return;
			}
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#close();
			return;
		}

		const key = data;
		if (key === "F") {
			this.#cycleFilter();
			return;
		}
		if (key === "S") {
			this.#cycleSort();
			return;
		}
		if (key === "D") {
			this.#toggleDetails();
			return;
		}
		if (key === "A") {
			this.#pendingAction = this.#toggleArchive();
			return;
		}
		if (key === "P") {
			this.#pendingAction = this.#togglePause();
			return;
		}
		if (key === "K") {
			this.#beginKill();
			return;
		}
		if (key === "R") {
			this.#pendingAction = this.#refresh();
			return;
		}
		if (key === "C" && this.#detailsOpen) {
			this.#openCheckpoints();
			return;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#move(1);
			return;
		}
		if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#move(-1);
			return;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			this.#pendingAction = this.#openSelected();
		}
	}

	#close(): void {
		this.dispose();
		this.#onClose();
	}

	#move(delta: number): void {
		if (this.#rows.length === 0) return;
		this.#selected = Math.max(0, Math.min(this.#selected + delta, this.#rows.length - 1));
		if (this.#detailsOpen) void this.#loadDetails();
		this.#requestRender();
	}

	#cycleFilter(): void {
		const index = FILTER_CYCLE.indexOf(this.#filter);
		this.#filter = FILTER_CYCLE[(index + 1) % FILTER_CYCLE.length]!;
		void this.#refresh();
	}

	#cycleSort(): void {
		const index = SORT_CYCLE.indexOf(this.#sort);
		this.#sort = SORT_CYCLE[(index + 1) % SORT_CYCLE.length]!;
		void this.#refresh();
	}

	#toggleDetails(): void {
		this.#detailsOpen = !this.#detailsOpen;
		if (this.#detailsOpen) void this.#loadDetails();
		this.#requestRender();
	}

	/** Fire-and-forget refresh; the in-flight tail is observable via {@link awaitSettled}. */
	#refresh(): Promise<void> {
		this.#pendingAction = this.#runRefresh();
		return this.#pendingAction;
	}

	async #runRefresh(): Promise<void> {
		if (this.#disposed) return;
		const opts: EnumerateOptions = {
			cwd: this.#cwd,
			sessionDir: this.#sessionDir,
			filter: this.#filter,
			sort: this.#sort,
			statsTimeoutMs: this.#statsTimeoutMs,
			deps: {
				registry: this.#registry,
				gate: this.#gate,
				session: { sessionFile: this.#ctx.session.sessionFile },
				currentSessionFile: this.#ctx.session.sessionFile,
			},
		};
		try {
			this.#rows = await this.#enumerate(opts);
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		}
		this.#selected = Math.min(this.#selected, Math.max(0, this.#rows.length - 1));
		if (this.#detailsOpen) void this.#loadDetails();
		this.#requestRender();
	}

	/** Resolves when the in-flight action (refresh/archive/pause/open) has landed. Test seam. */
	awaitSettled(): Promise<void> {
		return this.#pendingAction;
	}

	async #loadDetails(): Promise<void> {
		const row = this.#rows[this.#selected];
		this.#detailsCheckpoints = undefined;
		if (!row?.info.cwd) {
			this.#detailsCheckpoints = [];
			this.#requestRender();
			return;
		}
		try {
			this.#detailsCheckpoints = await this.#checkpointService.list(row.info.id, row.info.cwd);
		} catch {
			this.#detailsCheckpoints = [];
		}
		this.#requestRender();
	}

	async #toggleArchive(): Promise<void> {
		const row = this.#rows[this.#selected];
		if (!row) return;
		try {
			await setArchived(row.info.path, !row.archived);
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		}
		void this.#refresh();
	}

	async #togglePause(): Promise<void> {
		const row = this.#rows[this.#selected];
		if (!row?.isCurrent) return;
		try {
			if (this.#gate.paused) this.#gate.release();
			else this.#gate.engage();
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		}
		void this.#refresh();
	}

	#beginKill(): void {
		const row = this.#rows[this.#selected];
		if (!row) return;
		const display = sessionDisplayName(row.info);
		if (row.isCurrent) {
			this.#confirm = { kind: "killCurrent", path: row.info.path, display, step: 1 };
		} else {
			this.#confirm = { kind: "deleteSession", path: row.info.path, display, step: 1 };
		}
		this.#requestRender();
	}

	async #confirmAction(): Promise<void> {
		const confirm = this.#confirm;
		if (!confirm) return;
		if (confirm.kind === "deleteSession" && confirm.step === 1) {
			confirm.step = 2;
			this.#requestRender();
			return;
		}
		this.#confirm = undefined;
		if (confirm.kind === "killCurrent") await this.#killCurrentSubagents();
		else await this.#deleteSession(confirm.path);
	}

	async #killCurrentSubagents(): Promise<void> {
		const running = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID && ref.status === "running");
		for (const ref of running) {
			try {
				await this.#lifecycle.release(ref.id, undefined, { tombstone: true });
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
			}
		}
		void this.#refresh();
	}

	async #deleteSession(path: string): Promise<void> {
		try {
			await this.#ctx.sessionManager.dropSession(path);
			this.#notice = undefined;
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		}
		void this.#refresh();
	}

	async #openSelected(): Promise<void> {
		const row = this.#rows[this.#selected];
		if (!row) return;
		if (row.isCurrent) {
			this.#close();
			this.#ctx.showStatus("Already on this session");
			return;
		}
		this.#close();
		await this.#ctx.handleResumeSession(row.info.path);
	}

	#openCheckpoints(): void {
		if (!this.#ui) return;
		const row = this.#rows[this.#selected];
		if (!row?.info.cwd) return;
		const sessionId = row.info.id;
		const cwd = row.info.cwd;
		const ui = this.#ui;
		const component = new CheckpointListComponent({
			sessionId,
			cwd,
			ui,
			requestRender: () => this.#requestRender(),
			readOnly: true,
			service: this.#checkpointService,
			onClose: () => {
				overlay?.hide();
				ui.setFocus(component);
				this.#requestRender();
			},
		});
		const overlay = ui.showOverlay(component, { width: "100%", margin: 0, fullscreen: true });
		ui.setFocus(component);
	}

	// --- rendering ---------------------------------------------------------

	#headerTitle(width: number): string {
		const filter = theme.fg("accent", `filter:${this.#filter}`);
		const sort = theme.fg("accent", `sort:${this.#sort}`);
		const title = `Sessions   ${filter}   ${sort}`;
		return truncateToWidth(title, Math.max(1, width - 4));
	}

	#renderRows(width: number): string[] {
		const showCost = width >= 140;
		const showModel = width >= 110;
		const showCwd = width >= 80;
		const lines: string[] = [];
		if (this.#rows.length === 0) {
			lines.push(theme.fg("dim", "No sessions. Start a task or resume another session."));
			return lines;
		}
		this.#rows.forEach((row, index) => {
			lines.push(this.#renderRow(row, index === this.#selected, width, showCost, showModel, showCwd));
		});
		return lines;
	}

	#renderRow(
		row: SessionRow,
		selected: boolean,
		width: number,
		showCost: boolean,
		showModel: boolean,
		showCwd: boolean,
	): string {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const marker = row.isCurrent ? theme.fg("success", "●") : " ";
		const name = sanitizeDisplayText(sessionDisplayName(row.info));
		const leftParts = [`${cursor}${marker}`, name];
		if (showCwd && row.info.cwd) {
			leftParts.push(theme.fg("dim", shortenPath(row.info.cwd)));
		}
		if (showModel) {
			const model = row.model ?? row.profile;
			leftParts.push(theme.fg("muted", model ? sanitizeDisplayText(model) : "—"));
		}
		const left = leftParts.join(" ");

		const rightParts: string[] = [];
		if (row.isCurrent && row.agentCounts) {
			const total = row.agentCounts.running + row.agentCounts.idle + row.agentCounts.parked;
			rightParts.push(theme.fg("dim", `${total} agents`));
		}
		if (showCost) {
			rightParts.push(
				row.cost != null ? theme.fg("statusLineCost", `$${formatNumber(row.cost)}`) : theme.fg("dim", "—"),
			);
		}
		rightParts.push(theme.fg("dim", formatAge(ageSeconds(row.info.modified.getTime()))));
		rightParts.push(statusToken(row));
		if (row.archived) rightParts.push(theme.fg("muted", "archived"));
		const right = rightParts.join(theme.fg("dim", theme.sep.dot));

		const leftW = visibleWidth(left);
		const rightW = visibleWidth(right);
		if (leftW + 2 + rightW <= width) {
			return left + padding(width - leftW - rightW) + right;
		}
		return truncateToWidth(left, width);
	}

	#renderDetails(width: number): string[] {
		const row = this.#rows[this.#selected];
		if (!row) return [theme.fg("dim", "No session selected.")];
		const info = row.info;
		const sections: Array<[string, Array<[string, string]>]> = [
			[
				"Identity",
				[
					["id", info.id],
					["title", sessionDisplayName(info)],
					["cwd", info.cwd ? sanitizeDisplayText(info.cwd) : "—"],
					["created", info.created.toISOString()],
					["modified", info.modified.toISOString()],
				],
			],
			[
				"Models",
				[
					["model", row.model ?? "—"],
					["profile", row.profile ?? "—"],
				],
			],
			[
				"Agents",
				row.agentCounts
					? [
							["running", String(row.agentCounts.running)],
							["idle", String(row.agentCounts.idle)],
							["parked", String(row.agentCounts.parked)],
						]
					: [["agents", "—"]],
			],
			[
				"Usage",
				[
					["cost", row.cost != null ? `$${formatNumber(row.cost)}` : "—"],
					["tokens in", row.tokensIn != null ? formatNumber(row.tokensIn) : "—"],
					["tokens out", row.tokensOut != null ? formatNumber(row.tokensOut) : "—"],
				],
			],
			[
				"Runtime",
				[
					["branch", row.branch ?? "—"],
					["dirty", row.dirty ? `${row.dirty.staged}/${row.dirty.unstaged}/${row.dirty.untracked}` : "—"],
					["state", row.isCurrent ? (row.liveState ?? "—") : (info.status ?? "—")],
				],
			],
			[
				"Recovery",
				[
					["checkpoints", String(this.#detailsCheckpoints?.length ?? row.checkpointCount ?? "—")],
					[
						"latest",
						this.#detailsCheckpoints?.[0]
							? sanitizeDisplayText(this.#detailsCheckpoints[0].label ?? this.#detailsCheckpoints[0].reason)
							: "—",
					],
				],
			],
		];
		const lines: string[] = [];
		for (const [title, pairs] of sections) {
			lines.push(theme.bold(theme.fg("accent", title)));
			for (const [key, value] of pairs) {
				lines.push(theme.fg("muted", `${key}: `) + value);
			}
			lines.push("");
		}
		return lines.slice(0, Math.max(1, width));
	}

	#confirmMessage(): string {
		const confirm = this.#confirm!;
		const target = theme.fg("error", sanitizeDisplayText(confirm.display));
		if (confirm.kind === "killCurrent") {
			return theme.fg(
				"error",
				`Kill all running subagents of ${target}? This cannot be undone.  y:confirm  n/Esc:cancel`,
			);
		}
		if (confirm.step === 1) {
			return theme.fg(
				"error",
				`Permanently delete the history of ${target} (no checkpoint restore). Press K again to confirm.  n/Esc:cancel`,
			);
		}
		return theme.fg("error", `CONFIRM delete ${target}? This is irreversible.  y:delete  n/Esc:cancel`);
	}

	#footer(_width: number): string {
		if (this.#confirm) return this.#confirmMessage();
		if (this.#notice) return theme.fg("error", this.#notice);
		return theme.fg(
			"dim",
			"↑/↓:nav  F:filter  S:sort  Enter:open  D:details  A:archive  P:pause  K:kill  R:resync  Esc:close",
		);
	}

	#detailsFooter(_width: number): string {
		return theme.fg("dim", "↑/↓:nav  C:checkpoints  D/Esc:back");
	}
}

/** Relative age in whole seconds, floored at 1 so fresh rows don't read "0s". */
function ageSeconds(modifiedMs: number): number {
	return Math.max(1, Math.round((Date.now() - modifiedMs) / 1000));
}

/** One-line session name: title → first message → "Untitled · HH:MM". */
function sessionDisplayName(info: { title?: string; firstMessage: string; created: Date; modified: Date }): string {
	const title = info.title?.trim();
	if (title) return title;
	const first = info.firstMessage && info.firstMessage !== "(no messages)" ? info.firstMessage.trim() : undefined;
	if (first) return first;
	const ts = Number.isFinite(info.created.getTime()) ? info.created.getTime() : info.modified.getTime();
	const time = new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `Untitled · ${time}`;
}

/** Compact colored status glyph + label for a row. */
function statusToken(row: SessionRow): string {
	if (row.isCurrent) {
		switch (row.liveState) {
			case "paused":
				return theme.fg("warning", `${theme.status.pending} paused`);
			case "idle":
				return theme.fg("muted", `${theme.status.shadowed} idle`);
			case "streaming":
				return theme.fg("accent", `${theme.status.running} live`);
			default:
				return theme.fg("dim", "—");
		}
	}
	switch (row.info.status) {
		case "complete":
			return theme.fg("success", `${theme.status.success} done`);
		case "interrupted":
			return theme.fg("warning", `${theme.status.warning} int`);
		case "aborted":
			return theme.fg("muted", `${theme.status.aborted} abrt`);
		case "error":
			return theme.fg("error", `${theme.status.error} err`);
		case "pending":
			return theme.fg("accent", `${theme.status.pending} pend`);
		default:
			return theme.fg("dim", "—");
	}
}
