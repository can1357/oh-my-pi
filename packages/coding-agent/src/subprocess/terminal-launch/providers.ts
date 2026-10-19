import type { TerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { cmuxLaunchProvider } from "./cmux";
import { herdrLaunchProvider } from "./herdr";
import { orcaLaunchProvider } from "./orca";
import { tmuxLaunchProvider } from "./tmux";
import type { SupportedMultiplexerCapabilities, UnsupportedMultiplexerCapabilities } from "./types";
import { zellijLaunchProvider } from "./zellij";

/**
 * Launch provider for every recognized multiplexer. Supported entries carry the
 * capability metadata that drives request construction and user-facing names
 * plus their backend; unsupported entries stay explicit so adding a multiplexer
 * requires an intentional launch decision.
 */
export const terminalLaunchProviders = {
	herdr: herdrLaunchProvider,
	tmux: tmuxLaunchProvider,
	screen: {
		capabilities: {
			displayName: "screen",
			supported: false,
			reason: "screen has no supported native launch command.",
		},
	},
	zellij: zellijLaunchProvider,
	cmux: cmuxLaunchProvider,
	wmux: {
		capabilities: {
			displayName: "wmux",
			supported: false,
			reason: "wmux launch is not implemented by this API.",
		},
	},
	orca: orcaLaunchProvider,
} as const satisfies Record<
	TerminalMultiplexer,
	{ capabilities: SupportedMultiplexerCapabilities | UnsupportedMultiplexerCapabilities }
>;

/** Canonical multiplexer launch capabilities and presentation metadata, keyed by multiplexer. */
export const terminalLaunchCapabilities = Object.fromEntries(
	Object.entries(terminalLaunchProviders).map(([multiplexer, provider]) => [multiplexer, provider.capabilities]),
) as { [M in TerminalMultiplexer]: (typeof terminalLaunchProviders)[M]["capabilities"] };
