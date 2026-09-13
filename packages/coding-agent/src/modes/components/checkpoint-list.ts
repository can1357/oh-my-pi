/**
 * Reusable fullscreen checkpoint browser used by `/rollback` (full mode: can
 * roll back) and by the `/sessions` details pane (read-only: just inspects).
 *
 * It is a self-contained overlay Component: it owns its own list state, an
 * inline inspect view, and an inline rollback-confirmation flow. The caller
 * supplies `onRollback` (full mode only) which performs the actual
 * `WorkspaceCheckpointService.rollback` plus any notify/status side effects.
 *
 * Data is loaded once on construction (checkpoints are immutable once
 * written), so rendering never re-queries the service.
 */
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { matchesKey, padding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { formatAge, formatBytes } from "@oh-my-pi/pi-utils";
import type { CheckpointMeta } from "../../checkpoints";
import { WorkspaceCheckpointService } from "../../checkpoints";
import { theme } from "../../modes/theme/theme";
import { sanitizeDisplayText } from "./agent-hub-renderer";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

type CheckpointListMode = "list" | "inspect" | "confirm";

export interface CheckpointListViewDeps {
	/** Session whose checkpoints are listed. */
	sessionId: string;
	/** Working directory the session owns (for identity resolution). */
	cwd: string;
	/** Overlay host; when absent (render-only tests) navigational keys are inert. */
	ui?: TUI;
	/** Request a repaint from the host TUI. */
	requestRender: () => void;
	/** Called when the user cancels/backs out of the list (Esc at top level). */
	onClose: () => void;
	/**
	 * When true the list is view-only (no rollback). The `/sessions` details
	 * pane uses this; `/rollback` does not.
	 */
	readOnly?: boolean;
	/** Checkpoint service; defaults to `WorkspaceCheckpointService.global()`. */
	service?: WorkspaceCheckpointService;
	/**
	 * Performs the rollback for the selected checkpoint after the user confirms.
	 * Required in full (non-read-only) mode. Receives the chosen metadata.
	 */
	onRollback?: (meta: CheckpointMeta) => Promise<void>;
}

const AGE_TICK_MS = 5_000;

export class CheckpointListComponent implements Component {
	readonly #sessionId: string;
	readonly #cwd: string;
	readonly #ui: TUI | undefined;
	readonly #requestRender: () => void;
	readonly #onClose: () => void;
	readonly #readOnly: boolean;
	readonly #service: WorkspaceCheckpointService;
	readonly #onRollback: ((meta: CheckpointMeta) => Promise<void>) | undefined;
	readonly #ageTimer: NodeJS.Timeout | undefined;

	#disposed = false;
	#checkpoints: CheckpointMeta[] = [];
	#selected = 0;
	#mode: CheckpointListMode = "list";
	#notice: string | undefined;

	constructor(deps: CheckpointListViewDeps) {
		this.#sessionId = deps.sessionId;
		this.#cwd = deps.cwd;
		this.#ui = deps.ui;
		this.#requestRender = deps.requestRender;
		this.#onClose = deps.onClose;
		this.#readOnly = deps.readOnly ?? false;
		this.#service = deps.service ?? WorkspaceCheckpointService.global();
		this.#onRollback = deps.onRollback;

		// Load once; checkpoints are immutable once written.
		void this.#service.list(this.#sessionId, this.#cwd).then(metas => {
			if (this.#disposed) return;
			this.#checkpoints = metas;
			this.#selected = Math.min(this.#selected, Math.max(0, metas.length - 1));
			this.#requestRender();
		});

		if (this.#ui) {
			this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
			this.#ageTimer.unref?.();
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#ageTimer) clearInterval(this.#ageTimer);
	}

	render(width: number): readonly string[] {
		const inner = Math.max(1, width - 4);
		const lines: string[] = [];
		lines.push(topBorder(width, this.#readOnly ? "Checkpoints (read-only)" : "Checkpoints"));
		if (this.#checkpoints.length === 0) {
			lines.push(row(theme.fg("dim", "No checkpoints for this session."), width));
		} else if (this.#mode === "inspect") {
			for (const line of this.#renderInspect(inner)) lines.push(row(line, width));
		} else {
			for (const line of this.#renderList(inner)) lines.push(row(line, width));
		}
		lines.push(divider(width));
		lines.push(row(this.#footer(width), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.#mode === "confirm") {
			if (matchesKey(data, "y") || matchesKey(data, "enter")) {
				void this.#doRollback();
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "n")) {
				this.#mode = "list";
				this.#notice = undefined;
				this.#requestRender();
				return;
			}
			return;
		}
		if (this.#mode === "inspect") {
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
				this.#mode = "list";
				this.#requestRender();
				return;
			}
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.#close();
			return;
		}
		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			if (this.#checkpoints.length > 0) {
				this.#selected = Math.min(this.#selected + 1, this.#checkpoints.length - 1);
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			if (this.#checkpoints.length > 0) this.#selected = Math.max(this.#selected - 1, 0);
			this.#requestRender();
			return;
		}
		const selected = this.#checkpoints[this.#selected];
		if (!selected) return;
		if (matchesKey(data, "enter") || matchesKey(data, "c") || matchesKey(data, "i")) {
			this.#mode = "inspect";
			this.#requestRender();
			return;
		}
		if (!this.#readOnly && (matchesKey(data, "r") || data === "R")) {
			this.#mode = "confirm";
			this.#notice = undefined;
			this.#requestRender();
			return;
		}
	}

	#close(): void {
		this.dispose();
		this.#onClose();
	}

	async #doRollback(): Promise<void> {
		const selected = this.#checkpoints[this.#selected];
		if (!selected || !this.#onRollback) return;
		this.#mode = "list";
		this.#notice = undefined;
		try {
			await this.#onRollback(selected);
			this.dispose();
			this.#onClose();
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
			this.#requestRender();
		}
	}

	#renderList(width: number): string[] {
		const lines: string[] = [];
		if (this.#notice) {
			lines.push(theme.fg("error", truncateToWidth(this.#notice, width)));
		}
		this.#checkpoints.forEach((meta, index) => {
			const cursor = index === this.#selected ? theme.fg("accent", theme.nav.cursor) : " ";
			const id = theme.bold(index === this.#selected ? meta.id : meta.id);
			const label = meta.label ?? meta.reason;
			const age = formatAge(Math.max(1, Math.round((Date.now() - new Date(meta.createdAt).getTime()) / 1000)));
			const bytes = meta.bytesCaptured > 0 ? formatBytes(meta.bytesCaptured) : theme.fg("dim", "—");
			const left = `${cursor} ${id} ${theme.fg("dim", sanitizeDisplayText(label))}`;
			const right = theme.fg("dim", `${age}  ${bytes}`);
			const leftW = visibleWidth(left);
			const rightW = visibleWidth(right);
			if (leftW + 2 + rightW <= width) {
				lines.push(left + padding(width - leftW - rightW) + right);
			} else {
				lines.push(truncateToWidth(left, width));
			}
		});
		return lines;
	}

	#renderInspect(width: number): string[] {
		const meta = this.#checkpoints[this.#selected];
		if (!meta) return [theme.fg("dim", "No checkpoint selected.")];
		const created = new Date(meta.createdAt);
		const rows: Array<[string, string]> = [
			["id", meta.id],
			["reason", meta.reason],
			["label", meta.label ?? theme.fg("dim", "—")],
			["created", created.toISOString()],
			["age", formatAge(Math.max(1, Math.round((Date.now() - created.getTime()) / 1000)))],
			["bytes", meta.bytesCaptured > 0 ? formatBytes(meta.bytesCaptured) : "—"],
			["skipped", String(meta.skippedFiles.length)],
			["repo", sanitizeDisplayText(meta.identity.repoRoot)],
			["worktree", sanitizeDisplayText(meta.identity.worktreePath)],
			["head", meta.headShaAtCapture ?? "—"],
			["tree", meta.treeSha],
		];
		const lines: string[] = [];
		lines.push(theme.bold(theme.fg("accent", `Checkpoint ${meta.id}`)));
		for (const [key, value] of rows) {
			for (const wrapped of wrapTextWithAnsi(`${theme.fg("muted", `${key}:`)} ${value}`, width)) {
				lines.push(truncateToWidth(wrapped, width));
			}
		}
		if (!this.#readOnly) {
			lines.push("");
			lines.push(theme.fg("dim", "Press R to roll back to this checkpoint."));
		}
		lines.push(theme.fg("dim", "Esc:back"));
		return lines;
	}

	#footer(_width: number): string {
		if (this.#mode === "confirm") {
			const meta = this.#checkpoints[this.#selected];
			const label = meta ? sanitizeDisplayText(meta.label ?? meta.reason) : "";
			return theme.fg(
				"error",
				`Roll back to ${meta?.id ?? "?"} (${label})? A safety checkpoint of the current state is created first.  y:confirm  n/Esc:cancel`,
			);
		}
		if (this.#mode === "inspect") {
			return theme.fg("dim", "Enter/Esc:back");
		}
		if (this.#readOnly) {
			return theme.fg("dim", "↑/↓:nav  Enter:inspect  Esc:close");
		}
		return theme.fg("dim", "↑/↓:nav  Enter:inspect  R:rollback  Esc:close");
	}
}
