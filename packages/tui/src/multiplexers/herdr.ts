import { DEFAULT_NOTIFICATION_TITLE, notificationTitleAndBody, spawnNotifier } from "./notify";
import type { TerminalMultiplexerModule } from "./types";

const HERDR_PANE_ID_PATTERN = /^[0-9A-Za-z:_-]{1,64}$/u;
/**
 * `herdr notification show` takes the title as its first positional and reads
 * exactly these three values there as a help request; it has no `--`
 * terminator. Any other text, including one starting with `-`, is a title.
 */
const HERDR_USAGE_TOKENS: Record<string, true> = { help: true, "--help": true, "-h": true };

export const herdrMultiplexer = {
	id: "herdr",
	precedence: "session",
	sessionEnvKeys: ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"],
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		// Identity vars survive env-sanitizing launchers that drop HERDR_ENV.
		// Client-only socket, binary, session, and config overrides are not proof
		// that this process runs inside a pane.
		return env.HERDR_ENV === "1" || Boolean(env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID);
	},
	/**
	 * Herdr multiplexes panes like tmux but swallows bare OSC 9 / OSC 99 and has
	 * no DCS passthrough envelope, and its bell relay does not flag a
	 * backgrounded tab — so without its CLI a backgrounded pane gets no signal
	 * at all that the agent finished or is waiting for input.
	 *
	 * `sound` maps the notification kind onto what Herdr offers: a question
	 * waiting on the user and a turn that stopped with an error both need the
	 * human and ring `request`, a settled turn rings `done`, anything else stays
	 * silent. The exact pane ID addresses the CLI call; without a valid one, or
	 * without the binary, delivery falls through.
	 */
	notifier: {
		tier: "pane",
		send({ message, env }) {
			const paneId = env.HERDR_PANE_ID?.trim();
			if (!paneId || !HERDR_PANE_ID_PATTERN.test(paneId)) return false;

			const parsed = notificationTitleAndBody(message);
			const title = Object.hasOwn(HERDR_USAGE_TOKENS, parsed.title) ? DEFAULT_NOTIFICATION_TITLE : parsed.title;
			const kinds = typeof message === "string" ? [] : [message.type ?? []].flat();
			const sound =
				kinds.includes("ask") || kinds.includes("error")
					? "request"
					: kinds.includes("completion")
						? "done"
						: "none";
			return spawnNotifier(["herdr", "notification", "show", title, "--body", parsed.body, "--sound", sound]);
		},
	},
	// Herdr hides the outer terminal (`TERM=xterm-256color`, no `TERM_PROGRAM`),
	// but renders OSC 8 in its own grid and opens links itself on Ctrl+click.
	hyperlinks: "render",
	// The pane VTE is libghostty and suppresses compositing while DEC 2026 is
	// set. Without sync, CUP-diff paints and split write(2) chunks composite as
	// dirty-row patches: the live viewport tears, its top frozen while only the
	// bottom refreshes.
	honorsSynchronizedOutput: true,
	// The pane marker does not prove the client enabled Herdr's experimental
	// Kitty renderer, and leaked outer-terminal identities cannot either.
	imagesRequireOverride: true,
} as const satisfies TerminalMultiplexerModule;
