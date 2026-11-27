/**
 * The status row's working row (see `WorkingKind` in ../types): which kind
 * holds it, the turn's live label, its session accent and its right-docked
 * trailer, the idle retry hint, and the idle trailer that keeps the last tok/s
 * reading on screen between turns.
 */
import { adjustHsv } from "@oh-my-pi/pi-utils";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { StatusHudModel, WorkingAccent, WorkingSpec } from "../../ui/dock";
import { sessionAccentHex } from "../../ui/status/accent";
import type { WorkingKind } from "../types";

/** The turn row's label until something more specific is set. */
export const DEFAULT_WORKING_MESSAGE = "Working…";

/** What the working rows read from the app. */
export interface WorkingHost {
	readonly status: StatusHudModel;
	/** The interrupt key id (the row's stop control), undefined when Esc would not cancel. */
	interruptKey(): string | undefined;
	/** The session title seeding the accent, undefined when accents are off or the session is unnamed. */
	accentTitle(): string | undefined;
	/** `display.shimmer` as resolved by the motion preset. */
	shimmer(): WorkingSpec["shimmer"];
	/** The turn's right-docked trailer (tok/s, the band composer's title). */
	trailer(): string | undefined;
	/** Epoch ms the viewed session's run started. */
	runStartedAt(): number | undefined;
	/** Whether the idle row should offer a retry (the last turn died on a tool call). */
	retryHintWanted(): boolean;
	retryKey(): string;
}

/** See the module docs. */
export class WorkingRows {
	readonly #host: WorkingHost;
	#kind: WorkingKind | undefined;
	#message: string | (() => string) = DEFAULT_WORKING_MESSAGE;
	/** A message set before the turn row exists; applied when it shows. */
	#pending: string | (() => string) | undefined;

	constructor(host: WorkingHost) {
		this.#host = host;
	}

	/** What holds the working row. */
	get kind(): WorkingKind | undefined {
		return this.#kind;
	}

	/** Put `spec` in the status row as `kind`, filling the app's defaults. */
	show(kind: WorkingKind, spec: WorkingSpec): void {
		this.#kind = kind;
		const accent = spec.accent ?? (() => this.#accent());
		const shimmer = spec.shimmer ?? this.#host.shimmer();
		const trailer = spec.trailer ?? (kind === "turn" ? () => this.#host.trailer() : undefined);
		this.#host.status.row.set({
			kind: "working",
			spec: {
				...spec,
				...(accent ? { accent } : {}),
				...(shimmer ? { shimmer } : {}),
				...(trailer ? { trailer } : {}),
			},
		});
	}

	/** Take the row down (only when `kind` holds it, when given); the idle retry hint may take its place. */
	clear(kind?: WorkingKind): boolean {
		if (this.#kind === undefined || (kind !== undefined && this.#kind !== kind)) return false;
		const wasTurn = this.#kind === "turn";
		this.#kind = undefined;
		this.#host.status.row.set(undefined);
		if (wasTurn) this.#message = DEFAULT_WORKING_MESSAGE;
		this.syncRetryHint();
		return true;
	}

	/** The turn's row, unless a row already shows. */
	ensureTurn(): void {
		if (this.#kind === undefined) {
			this.show("turn", {
				label: () => (typeof this.#message === "function" ? this.#message() : this.#message),
				startedAt: this.#host.runStartedAt() ?? Date.now(),
				...(this.#host.interruptKey() ? { interruptKey: this.#host.interruptKey() } : {}),
			});
		}
		this.applyPending();
	}

	/** The turn row's label (no argument: the default); kept until the row shows when none does. */
	setMessage(message?: string | (() => string)): void {
		if (message === undefined) {
			this.#pending = undefined;
			this.#message = DEFAULT_WORKING_MESSAGE;
			return;
		}
		if (this.#kind === "turn") this.#message = message;
		else this.#pending = message;
	}

	/** Apply a message set before the turn row showed. */
	applyPending(): void {
		if (this.#pending === undefined || this.#kind !== "turn") return;
		this.#message = this.#pending;
		this.#pending = undefined;
	}

	/** Show the idle "F5 to retry" row when the last turn died on a tool call and no working row holds the row. */
	syncRetryHint(): void {
		if (this.#kind !== undefined) return;
		const status = this.#host.status;
		const showing = status.row.peek()?.kind === "retry";
		const wanted = this.#host.retryHintWanted();
		if (wanted && !showing) status.row.set({ kind: "retry", retryKey: this.#host.retryKey() });
		else if (!wanted && showing) status.row.set(undefined);
	}

	/** The session accent the label shimmers in, when accents are on and the session is named. */
	#accent(): WorkingAccent | undefined {
		const title = this.#host.accentTitle();
		if (!title) return undefined;
		const theme = currentTheme();
		const main = sessionAccentHex(theme, title);
		return main ? { main, dim: adjustHsv(main, { s: 0.55, v: 0.65 }) } : undefined;
	}
}
