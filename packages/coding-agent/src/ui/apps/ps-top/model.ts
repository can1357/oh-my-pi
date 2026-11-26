/**
 * State of the `omp ps` monitor: the board (units grouped by scope, refreshed
 * by a poll and by daemon unit events), the selected unit, the open view
 * (table, info, logs), the transient status line and the pointer kill
 * confirmation. Keys and native events run through here.
 */
import { type Accessor, batch, type Signal, signal } from "@oh-my-pi/pi-tui";
import type { UnitScope, UnitSnapshot } from "../../../daemon/daemon-types";
import { type PsBoard, type PsScopeReport, type PsTarget, unitLabel, unitName } from "../../../cli/ps-model";
import type { PsTopHost, PsUnitInfo } from "../../../modes/view-model/apps/ps-top";

/** Fallback poll; unit events from the daemon refresh sooner. */
const REFRESH_MS = 2_000;
/** Coalesces bursts of unit events into one refresh. */
const EVENT_REFRESH_MS = 100;
const LOGS_POLL_MS = 1_000;
/** How long a status message stays up. */
export const STATUS_TTL_MS = 5_000;

export type PsView = "table" | "info" | "logs";
export type PsStatusTone = "success" | "warning" | "error" | "muted";

/** A unit with the scope it is listed under. */
export interface PsRow {
	readonly scope: UnitScope;
	readonly unit: UnitSnapshot;
}

export interface PsStatus {
	readonly text: string;
	readonly tone: PsStatusTone;
	readonly at: number;
}

export interface PsTopOptions extends PsTarget {
	/** Start with every scope instead of the current project and global. */
	readonly all: boolean;
	/** Screen rows (logs fetch about a screenful). */
	readonly rows: Accessor<number>;
	/** Quit the monitor. */
	onQuit(): void;
}

export class PsTopModel {
	readonly view = signal<PsView>("table");
	readonly all: Signal<boolean>;
	readonly board = signal<PsBoard | undefined>(undefined);
	/** When the board was last read (0: never). */
	readonly lastRefresh = signal(0);
	readonly selected = signal(0);
	readonly info = signal<PsUnitInfo | undefined>(undefined);
	readonly logsLines = signal<readonly string[]>([]);
	readonly logsState = signal("");
	readonly logsError = signal<string | undefined>(undefined);
	readonly status = signal<PsStatus | undefined>(undefined);
	/** Whether the status is still within its time to live. */
	readonly statusVisible = signal(false);
	/** Unit id a pointer `Kill` waits on for confirmation. */
	readonly killConfirm = signal<string | undefined>(undefined);
	readonly target: PsTarget;
	/** First table body row the terminal shows (resolved while painting). */
	tableTop = 0;
	/** First info body row the terminal shows. */
	infoTop = 0;
	readonly #host: PsTopHost;
	readonly #options: PsTopOptions;
	/** Unit id of the selection, kept across refreshes. */
	#selectedKey: string | undefined;
	#refreshing = false;
	#disposed = false;
	#timers: { refresh?: Timer; event?: Timer; logs?: Timer; status?: Timer } = {};
	#unwatch: (() => void) | undefined;

	constructor(host: PsTopHost, options: PsTopOptions) {
		this.#host = host;
		this.#options = options;
		this.all = signal(options.all);
		this.target = { dir: options.dir };
	}

	/** Screen rows the monitor fills. */
	readonly screenRows: Accessor<number> = () => this.#options.rows();

	/** Units in board order. */
	readonly rows: Accessor<PsRow[]> = () =>
		(this.board()?.reports ?? []).flatMap(report => report.units.map(unit => ({ scope: report.scope, unit })));

	readonly reports: Accessor<readonly PsScopeReport[]> = () => this.board()?.reports ?? [];

	/** The selected unit's row. */
	readonly current: Accessor<PsRow | undefined> = () => this.rows()[this.selected()];

	/** Start polling and following daemon events. */
	run(): void {
		void this.refresh();
		this.#timers.refresh = setInterval(() => void this.refresh(), REFRESH_MS);
		this.#unwatch = this.#host.watch(() => {
			if (this.#timers.event) return;
			this.#timers.event = setTimeout(() => {
				this.#timers.event = undefined;
				void this.refresh();
			}, EVENT_REFRESH_MS);
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#timers.refresh);
		clearTimeout(this.#timers.event);
		clearInterval(this.#timers.logs);
		clearTimeout(this.#timers.status);
		this.#unwatch?.();
		this.#host.close();
	}

	async refresh(): Promise<void> {
		if (this.#refreshing || this.#disposed) return;
		this.#refreshing = true;
		try {
			const board = await this.#host.collectBoard(this.all.peek(), this.target);
			if (this.#disposed) return;
			batch(() => {
				this.board.set(board);
				this.lastRefresh.set(Date.now());
				this.#restoreSelection();
			});
		} catch (error) {
			this.#setStatus("error", error instanceof Error ? error.message : String(error));
		} finally {
			this.#refreshing = false;
		}
	}

	#restoreSelection(): void {
		const rows = this.rows();
		const kept = this.#selectedKey === undefined ? -1 : rows.findIndex(row => row.unit.id === this.#selectedKey);
		if (kept >= 0) {
			this.selected.set(kept);
			return;
		}
		const index = Math.max(0, Math.min(this.selected.peek(), rows.length - 1));
		this.selected.set(index);
		this.#selectedKey = rows[index]?.unit.id;
	}

	#setStatus(tone: PsStatusTone, text: string): void {
		batch(() => {
			this.status.set({ text, tone, at: Date.now() });
			this.statusVisible.set(true);
		});
		clearTimeout(this.#timers.status);
		this.#timers.status = setTimeout(() => this.statusVisible.set(false), STATUS_TTL_MS);
	}

	#select(index: number): void {
		const rows = this.rows();
		if (rows.length === 0) return;
		const next = Math.max(0, Math.min(rows.length - 1, index));
		this.selected.set(next);
		this.#selectedKey = rows[next]!.unit.id;
	}

	async act(verb: "stop" | "kill" | "restart"): Promise<void> {
		const row = this.current();
		if (!row) return;
		const name = unitName(row.unit);
		this.#setStatus("warning", `${verb} ${name}…`);
		try {
			const unit = await this.#host.act(row.unit, verb);
			const done = verb === "restart" ? "Restarted" : verb === "kill" ? "Killed" : "Stopped";
			this.#setStatus("success", `${done} ${unitLabel(unit)}`);
			void this.refresh();
		} catch (error) {
			this.#setStatus("error", `${verb} ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async openInfo(): Promise<void> {
		const row = this.current();
		if (!row) return;
		try {
			const info = await this.#host.describe(row.unit);
			batch(() => {
				this.info.set(info);
				this.view.set("info");
			});
			this.infoTop = 0;
		} catch (error) {
			this.#setStatus("error", error instanceof Error ? error.message : String(error));
		}
	}

	openLogs(): void {
		if (!this.current()) return;
		batch(() => {
			this.view.set("logs");
			this.logsLines.set([]);
			this.logsState.set("");
			this.logsError.set(undefined);
		});
		const poll = async (): Promise<void> => {
			const row = this.current();
			if (this.#disposed || this.view.peek() !== "logs" || !row) return;
			try {
				const result = await this.#host.logs(row.unit, Math.max(10, this.#options.rows() - 4));
				batch(() => {
					this.logsLines.set((result.terminalOutput || result.text).replace(/\n$/, "").split("\n"));
					this.logsState.set(result.state);
					this.logsError.set(undefined);
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				batch(() => {
					this.logsError.set(message);
					this.logsLines.set([message]);
				});
			}
		};
		void poll();
		this.#timers.logs = setInterval(() => void poll(), LOGS_POLL_MS);
	}

	closeView(): void {
		clearInterval(this.#timers.logs);
		this.#timers.logs = undefined;
		batch(() => {
			this.view.set("table");
			this.info.set(undefined);
		});
	}

	toggleAll(): void {
		const all = !this.all.peek();
		this.all.set(all);
		this.#setStatus("muted", all ? "Showing all scopes" : "Showing current scope");
		void this.refresh();
	}

	/** Keys — table: ↑/↓ j/k select, ⏎/i info, l logs, s stop, x kill, r restart, a all scopes, q/Esc quit; sub-views: Esc/q back; Ctrl+C quits anywhere. */
	key(id: string): boolean {
		if (id === "ctrl+c") {
			this.#options.onQuit();
			return true;
		}
		if (this.view.peek() !== "table") {
			if (id === "escape" || id === "q") this.closeView();
			return true;
		}
		if (id === "escape" || id === "q") this.#options.onQuit();
		else if (id === "up" || id === "k") this.#select(this.selected.peek() - 1);
		else if (id === "down" || id === "j") this.#select(this.selected.peek() + 1);
		else if (id === "a") this.toggleAll();
		else if (id === "enter" || id === "i") void this.openInfo();
		else if (id === "l") this.openLogs();
		else if (id === "s") void this.act("stop");
		else if (id === "x") void this.act("kill");
		else if (id === "r") void this.act("restart");
		else return false;
		return true;
	}

	/** A list row (by item key), or the scope control (`current`/`all`). */
	select(item: string, activate: boolean, keyOf: (row: PsRow) => string): void {
		if (item === "current" || item === "all") {
			if ((item === "all") !== this.all.peek()) this.toggleAll();
			return;
		}
		if (this.view.peek() !== "table") return;
		const index = this.rows().findIndex(row => keyOf(row) === item);
		if (index < 0) return;
		batch(() => {
			this.#select(index);
			this.killConfirm.set(undefined);
		});
		if (activate) void this.openInfo();
	}

	/** The action bar: the keys' code, except that a pointer `Kill` asks first. */
	action(act: string): void {
		switch (act) {
			case "info":
				void this.openInfo();
				return;
			case "logs":
				this.openLogs();
				return;
			case "stop":
			case "restart":
				void this.act(act);
				return;
			case "kill":
				this.killConfirm.set(this.current()?.unit.id);
				return;
			case "kill-confirm":
				this.killConfirm.set(undefined);
				void this.act("kill");
				return;
			case "kill-cancel":
				this.killConfirm.set(undefined);
				return;
			case "back":
				this.closeView();
				return;
			case "quit":
				this.#options.onQuit();
				return;
		}
	}
}
