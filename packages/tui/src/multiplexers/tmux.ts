import type { TerminalMultiplexerModule } from "./types";

/** Wrap a control sequence in tmux's DCS passthrough envelope. */
export function wrapTmuxPassthrough(payload: string): string {
	return `\x1bPtmux;${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

export const tmuxMultiplexer = {
	id: "tmux",
	precedence: "session",
	sessionEnvKeys: ["TMUX"],
	termPrefix: "tmux",
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.TMUX);
	},
	notifier: {
		tier: "inBand",
		// tmux swallows bare OSCs; passthrough preserves the toast and BEL flags
		// the pane. Bell notifications already provide that signal. One write
		// keeps a concurrent renderer from interleaving between the two.
		send({ sequence, write }) {
			if (sequence === null) return false;
			write(`${wrapTmuxPassthrough(sequence)}\x07`);
			return true;
		},
	},
	// tmux 3.4 stores OSC 8 as a cell attribute and forwards it to outer
	// terminals whose `terminal-features` include `hyperlinks`; it self-reports
	// via TERM_PROGRAM/TERM_PROGRAM_VERSION since 3.2a.
	hyperlinks: { forward: { termProgram: "tmux", major: 3, minor: 4 } },
	// An explicit appearance refresh passes OSC 11 to the outer terminal, then
	// re-reads tmux's cache once it has consumed the reply.
	backgroundColorCache: { passthrough: wrapTmuxPassthrough, settleMs: 100 },
	expandsRepPadding: true,
	// tmux expires synchronized output after one second.
	expiresSynchronizedOutput: true,
	altRestoreEndsSynchronizedOutput: true,
	growsBeforeSigwinch: true,
} as const satisfies TerminalMultiplexerModule;
