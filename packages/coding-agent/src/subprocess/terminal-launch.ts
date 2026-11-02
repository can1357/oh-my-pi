import { terminalLaunchProviders } from "./terminal-launch/providers";
import { processCli } from "./terminal-launch/shared";
import type {
	TerminalLaunchBackendContext,
	TerminalLaunchDependencies,
	TerminalLaunchMultiplexer,
	TerminalLaunchRequest,
	TerminalLaunchRequestMap,
	TerminalLaunchResult,
} from "./terminal-launch/types";
import { validateRequest } from "./terminal-launch/validate";

export { terminalLaunchCapabilities } from "./terminal-launch/providers";
export * from "./terminal-launch/types";
export { createDefaultTerminalLaunchRequest, getTerminalLaunchPlacement } from "./terminal-launch/request";

/** Every supported provider's backend, keyed so a missing provider is a type error. */
const backends: {
	[M in TerminalLaunchMultiplexer]: {
		launch(
			request: TerminalLaunchRequestMap[M],
			context: TerminalLaunchBackendContext,
		): Promise<TerminalLaunchResult>;
	};
} = terminalLaunchProviders;

function launchWith<M extends TerminalLaunchMultiplexer>(
	multiplexer: M,
	request: TerminalLaunchRequestMap[M],
	context: TerminalLaunchBackendContext,
): Promise<TerminalLaunchResult> {
	return backends[multiplexer].launch(request, context);
}

/**
 * Create a terminal pane or multiplexer group and run a command in it.
 * Provider-specific execution, targeting, environment, focus, and shell-input
 * behavior are described by the canonical capability map and in docs/extensions.md.
 */
export function createTerminalLauncher(dependencies: TerminalLaunchDependencies = {}) {
	const runCli = dependencies.runCli ?? processCli;
	const environment = dependencies.environment ?? (() => process.env);
	const platform = dependencies.platform ?? process.platform;
	return async (request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => {
		validateRequest(request);
		return launchWith(request.multiplexer, request, { environment: environment(), platform, runCli });
	};
}

export const launchTerminal = createTerminalLauncher();
