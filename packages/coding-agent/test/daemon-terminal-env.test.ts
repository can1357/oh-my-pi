import { describe, expect, test } from "bun:test";
import { clientTerminalEnvSnapshot } from "../src/daemon/terminal-bridge";

describe("clientTerminalEnvSnapshot", () => {
	test("forwards only terminal-identity env, never secrets", () => {
		const snapshot = clientTerminalEnvSnapshot({
			TERM: "xterm-256color",
			TERM_PROGRAM: "WezTerm",
			TMUX: "/tmp/tmux-1000/default,123,0",
			TMUX_PANE: "%1",
			KITTY_WINDOW_ID: "4",
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/run/herdr.sock",
			HERDR_PANE_ID: "pane-7",
			HERDR_OMP_IDLE_DEBOUNCE_MS: "100",
			// Never forwarded: secrets, credentials, lookalike names.
			OPENAI_API_KEY: "sk-secret",
			SECRET: "hush",
			TERMINAL_TOKEN: "nope",
			HERDR_SECRET: "nope",
			SSH_AUTH_SOCK: "/run/ssh-agent",
			HOME: "/home/user",
			UNSET: undefined,
		});
		expect(snapshot).toEqual({
			TERM: "xterm-256color",
			TERM_PROGRAM: "WezTerm",
			TMUX: "/tmp/tmux-1000/default,123,0",
			TMUX_PANE: "%1",
			KITTY_WINDOW_ID: "4",
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/run/herdr.sock",
			HERDR_PANE_ID: "pane-7",
			HERDR_OMP_IDLE_DEBOUNCE_MS: "100",
		});
	});
});
