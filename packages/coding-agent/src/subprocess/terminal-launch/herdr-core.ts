import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { launchError, nestedString, parseJson, runStep } from "./shared";
import type { SupportedMultiplexerCapabilities, TerminalLaunchBackend, TerminalLaunchProvider } from "./types";

/**
 * The Herdr app (herdr-core, CLI `hc`) creates tabs itself; `hc` can only start a terminal,
 * which the app shows as a pane in the space and tab its labels name.
 */
const capabilities = {
	displayName: "Herdr app",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["direct"],
		target: false,
		name: true,
	},
} as const satisfies SupportedMultiplexerCapabilities;

/** herdr-core terminal names: 1-32 characters of `a-z`, `0-9`, `-`, `_`. */
const terminalName = /^[a-z0-9_-]{1,32}$/;

const launchHerdrCore: TerminalLaunchBackend<"herdr-core", typeof capabilities> = async (
	request,
	{ environment: env, platform, runCli },
) => {
	if (platform === "win32") {
		throw launchError(request, "capability", "Herdr app launches are not supported on Windows.");
	}
	const terminal = env.HC_TERMINAL_ID?.trim();
	if (!terminal || !hasTerminalMultiplexerSession("herdr-core", env)) {
		throw launchError(request, "capability", "Herdr app launch requires an active Herdr app terminal.");
	}
	if (request.name !== undefined && !terminalName.test(request.name)) {
		throw launchError(
			request,
			"name",
			"Herdr app terminal names must be 1-32 characters of lowercase letters, digits, '-' and '_'.",
		);
	}
	// A terminal carrying the app's space and tab labels shows up in that tab; without them it
	// still starts as a child of this terminal.
	const current = parseJson(
		request,
		"get",
		await runStep(request, "get", ["hc", "get", terminal, "--json"], request.cwd, runCli),
	);
	const space = nestedString(current, "labels", "herdr.space");
	const tab = nestedString(current, "labels", "herdr.tab");
	const labelArgs = space && tab ? ["--label", `herdr.space=${space}`, "--label", `herdr.tab=${tab}`] : [];

	// `--no-notify` keeps hc from typing an exit note into this agent, which would start a turn;
	// `--outlive-parent` keeps the launched program running after this one exits.
	const argv = [
		"hc",
		"run",
		"--bg",
		"--json",
		"--no-notify",
		"--outlive-parent",
		"--cwd",
		request.cwd,
		...labelArgs,
		...(request.name === undefined ? [] : ["--name", request.name]),
		"--",
		...request.command,
	];
	const started = parseJson(request, "run", await runStep(request, "run", argv, request.cwd, runCli));
	const id = nestedString(started, "address");
	if (!id) throw launchError(request, "run", "Herdr app hc run returned no terminal address.");
	return { multiplexer: "herdr-core", placement: "pane", id };
};

export const herdrCoreLaunchProvider: TerminalLaunchProvider<"herdr-core", typeof capabilities> = {
	capabilities,
	launch: launchHerdrCore,
};
