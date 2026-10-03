import { assertNever, processCli, validateRequest } from "./terminal-launch/shared";
import { launchCmux } from "./terminal-launch/cmux";
import { launchHerdr } from "./terminal-launch/herdr";
import { launchTmux } from "./terminal-launch/tmux";
import { launchZellij } from "./terminal-launch/zellij";
import type { TerminalLaunchDependencies, TerminalLaunchRequest, TerminalLaunchResult } from "./terminal-launch/types";

export * from "./terminal-launch/types";

/**
 * Create a terminal pane or multiplexer group and run a command in it.
 * Provider-specific execution, targeting, environment, focus, and shell-input
 * behavior are described by the canonical capability map and in docs/extensions.md.
 */
export function createTerminalLauncher(dependencies: TerminalLaunchDependencies = {}) {
	const runCli = dependencies.runCli ?? processCli;
	const environment = dependencies.environment ?? (() => process.env);
	return async (request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => {
		validateRequest(request);
		const context = { environment: environment(), runCli };
		switch (request.multiplexer) {
			case "tmux":
				return launchTmux(request, context);
			case "zellij":
				return launchZellij(request, context);
			case "herdr":
				return launchHerdr(request, context);
			case "cmux":
				return launchCmux(request, context);
			default:
				return assertNever(request);
		}
	};
}

export const launchTerminal = createTerminalLauncher();
