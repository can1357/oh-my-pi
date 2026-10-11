import type { TerminalNotification } from "../terminal-capabilities";

/**
 * Classification tier. `session` markers outrank the TERM fallback; `outerApp`
 * hosts rank below it so a multiplexer nested inside them still wins.
 */
export type TerminalMultiplexerPrecedence = "session" | "outerApp";

/**
 * Notification delivery tier, tried in this order so the innermost target wins:
 * a `pane` notifier addresses the exact pane through the multiplexer's CLI, a
 * `surface` notifier addresses the containing app surface, and an `inBand`
 * notifier rewrites the terminal's own notification sequence.
 */
export type TerminalMultiplexerNotificationTier = "pane" | "surface" | "inBand";

/** One notification offered to a multiplexer notifier. */
export interface TerminalMultiplexerNotificationRequest {
	readonly message: string | TerminalNotification;
	readonly env: NodeJS.ProcessEnv;
	/** The host terminal's formatted OSC notification, or `null` when it notifies with a bare BEL. */
	readonly sequence: string | null;
	/** Write a sequence through the active terminal. */
	write(data: string): void;
}

export interface TerminalMultiplexerNotifier {
	readonly tier: TerminalMultiplexerNotificationTier;
	/** Deliver the notification. `false` leaves it to the next notifier and then the terminal fallback. */
	send(request: TerminalMultiplexerNotificationRequest): boolean;
}

/**
 * OSC 8 handling inside a multiplexer session:
 * - `render`: the multiplexer draws and opens links itself, so links work
 *   whatever the outer terminal supports, unless another session with a
 *   hyperlink policy sits in the path.
 * - `drop`: never forwards OSC 8; its session anywhere in the path disables links.
 * - `forward`: forwards OSC 8 once it self-reports (`TERM_PROGRAM`/`TERM_PROGRAM_VERSION`)
 *   at least `major.minor`; older or unreported versions stay off.
 */
export type TerminalMultiplexerHyperlinks =
	| "render"
	| "drop"
	| {
			readonly forward: {
				/** Lowercase `TERM_PROGRAM` the multiplexer sets inside its panes. */
				readonly termProgram: string;
				readonly major: number;
				readonly minor: number;
			};
	  };

/** A multiplexer that answers OSC 11 from a cached copy of the outer terminal's background color. */
export interface TerminalMultiplexerBackgroundColorCache {
	/** Wrap a query so it reaches the outer terminal and refreshes the cache. */
	passthrough(query: string): string;
	/** How long the multiplexer needs to store the outer reply before the cache is re-read. */
	readonly settleMs: number;
}

/** Everything omp needs to recognize one terminal multiplexer and adapt to it. */
export interface TerminalMultiplexerModule<Id extends string = string> {
	readonly id: Id;
	readonly precedence: TerminalMultiplexerPrecedence;
	/** Every environment variable `isInside()` reads. */
	readonly sessionEnvKeys: readonly string[];
	/** Lowercase TERM prefix that identifies the multiplexer when its session markers were stripped. */
	readonly termPrefix?: string;
	/**
	 * Whether the multiplexer owns the screen grid. When true, rendering takes the
	 * multiplexer path (no scrollback rebuild, anchored resize, skipped probes).
	 */
	readonly ownsScreenGrid: boolean;
	isInside(env?: NodeJS.ProcessEnv): boolean;
	/** Routes notifications the multiplexer would otherwise swallow. */
	readonly notifier?: TerminalMultiplexerNotifier;
	/** OSC 8 policy inside a session; unset defers to the outer terminal. */
	readonly hyperlinks?: TerminalMultiplexerHyperlinks;
	/**
	 * The pane's VTE honors DEC 2026 even when DECRQM is unanswered or reports
	 * the mode unrecognized (status 0): synchronized output starts on inside a
	 * session, and an unrecognized report does not turn it off.
	 */
	readonly honorsSynchronizedOutput?: boolean;
	/**
	 * The session does not reveal whether its client renders graphics while
	 * outer-terminal identity variables leak in, so images and Kitty
	 * placeholders stay off unless the user forces them.
	 */
	readonly imagesRequireOverride?: boolean;
	/** Platforms where the multiplexer breaks OSC 11 passthrough, so host appearance is used instead. */
	readonly backgroundQueryBrokenOn?: readonly NodeJS.Platform[];
	/** Present when OSC 11 replies come from a cache an explicit refresh must update first. */
	readonly backgroundColorCache?: TerminalMultiplexerBackgroundColorCache;
	/** Expands REP into identical styled cells, so destructive replays REP-encode their padding. */
	readonly expandsRepPadding?: boolean;
	/** Expires a synchronized update after a deadline, so large rebuild replays renew DEC 2026 as they stream. */
	readonly expiresSynchronizedOutput?: boolean;
	/**
	 * Restoring the alternate buffer schedules a redraw that ends a synchronized
	 * update early, so a synchronized resize rebuild stays on the main buffer.
	 */
	readonly altRestoreEndsSynchronizedOutput?: boolean;
	/**
	 * May grow its grid before SIGWINCH reaches the app, so a rebuild-mode grow
	 * whose full viewport no longer reaches the bottom replays history.
	 */
	readonly growsBeforeSigwinch?: boolean;
}
