import type { TerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { terminalLaunchCapabilities } from "./providers";
import type {
	TerminalLaunchMultiplexer,
	TerminalLaunchPlacement,
	TerminalLaunchPlacementInfo,
	TerminalLaunchRequest,
} from "./types";
import { validateRequest } from "./validate";

function isSupportedMultiplexer(multiplexer: TerminalMultiplexer): multiplexer is TerminalLaunchMultiplexer {
	return terminalLaunchCapabilities[multiplexer].supported;
}

function supportedProvidersMessage(placement: TerminalLaunchPlacement): string {
	const providers = Object.values(terminalLaunchCapabilities)
		.filter(provider => provider.supported && provider[placement] !== undefined)
		.map(provider => provider.displayName);
	return providers.length > 0
		? `Supported ${placement} launch providers: ${providers.join(", ")}.`
		: `No supported ${placement} launch providers are configured.`;
}

/** Resolve the provider's support and user-facing placement metadata. */
export function getTerminalLaunchPlacement(
	multiplexer: TerminalMultiplexer | null,
	placement: TerminalLaunchPlacement,
): { error: string } | TerminalLaunchPlacementInfo {
	if (multiplexer === null) {
		return { error: `No terminal multiplexer was detected. ${supportedProvidersMessage(placement)}` };
	}

	if (!isSupportedMultiplexer(multiplexer)) {
		const unsupported = terminalLaunchCapabilities[multiplexer];
		return {
			error: `${unsupported.displayName} does not support terminal launches: ${unsupported.reason} ${supportedProvidersMessage(placement)}`,
		};
	}

	const provider = terminalLaunchCapabilities[multiplexer];
	const placementCapabilities = provider[placement];
	if (!placementCapabilities) {
		return {
			error: `${provider.displayName} does not support ${placement} launches. ${supportedProvidersMessage(placement)}`,
		};
	}

	const shellGrammar = "shellGrammar" in placementCapabilities ? placementCapabilities.shellGrammar : undefined;
	return {
		multiplexer,
		displayName: provider.displayName,
		placementLabel: placementCapabilities.displayName,
		...(shellGrammar === "posix" ? { shellGrammar } : {}),
	};
}

/** Build a provider-default request after checking the canonical provider and placement capabilities. */
export function createDefaultTerminalLaunchRequest(
	multiplexer: TerminalMultiplexer | null,
	placement: TerminalLaunchPlacement,
	command: readonly string[],
	cwd: string,
	shellGrammar?: "posix",
): { error: string } | { request: TerminalLaunchRequest } {
	const placementInfo = getTerminalLaunchPlacement(multiplexer, placement);
	if ("error" in placementInfo) return placementInfo;

	const request = {
		multiplexer: placementInfo.multiplexer,
		placement,
		command,
		cwd,
		...(shellGrammar === undefined ? {} : { shellGrammar }),
	} as TerminalLaunchRequest;

	try {
		validateRequest(request);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	return { request };
}
