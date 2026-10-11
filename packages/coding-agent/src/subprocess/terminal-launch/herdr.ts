import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { quotePosixArgv } from "../../utils/shell-quote";
import { launchError, nestedString, parseJson, runStep } from "./shared";
import type { SupportedMultiplexerCapabilities, TerminalLaunchBackend, TerminalLaunchProvider } from "./types";

const capabilities = {
	displayName: "Herdr",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["shell-input"],
		target: "pane",
		direction: ["right", "down"],
		focus: true,
		shellGrammar: "posix",
	},
	window: {
		displayName: "tab",
		execution: ["shell-input"],
		target: "workspace",
		focus: true,
		label: true,
		shellGrammar: "posix",
	},
} as const satisfies SupportedMultiplexerCapabilities;

const launchHerdr: TerminalLaunchBackend<"herdr", typeof capabilities> = async (
	request,
	{ environment: env, runCli },
) => {
	if (!hasTerminalMultiplexerSession("herdr", env)) {
		throw launchError(request, "capability", "Herdr launch requires an active Herdr pane or workspace.");
	}
	const shellCommand = quotePosixArgv(request.command);
	const focusArgs = request.focus === undefined ? [] : [request.focus ? "--focus" : "--no-focus"];
	if (request.placement === "pane") {
		const target = request.target ?? env.HERDR_PANE_ID;
		if (!target) throw launchError(request, "target", "Herdr pane launch requires a pane ID.");
		const createArgv = [
			"herdr",
			"pane",
			"split",
			target,
			"--direction",
			request.direction ?? "right",
			"--cwd",
			request.cwd,
			...focusArgs,
		];
		const created = parseJson(
			request,
			"pane split",
			await runStep(request, "pane split", createArgv, request.cwd, runCli),
		);
		const paneId = nestedString(created, "result", "pane", "pane_id");
		if (!paneId) throw launchError(request, "pane split", "Herdr pane split returned no pane ID.");
		await runStep(request, "pane run", ["herdr", "pane", "run", paneId, shellCommand], request.cwd, runCli);
		return { multiplexer: "herdr", placement: "pane", id: paneId };
	}

	const workspace = request.target ?? env.HERDR_WORKSPACE_ID;
	if (!workspace) throw launchError(request, "target", "Herdr tab launch requires a workspace ID.");
	const createArgv = ["herdr", "tab", "create", "--workspace", workspace, "--cwd", request.cwd];
	if (request.label) createArgv.push("--label", request.label);
	createArgv.push(...focusArgs);
	const created = parseJson(
		request,
		"tab create",
		await runStep(request, "tab create", createArgv, request.cwd, runCli),
	);
	const tabId = nestedString(created, "result", "tab", "tab_id");
	const paneId = nestedString(created, "result", "root_pane", "pane_id");
	if (!tabId || !paneId) throw launchError(request, "tab create", "Herdr tab create returned incomplete IDs.");
	await runStep(request, "pane run", ["herdr", "pane", "run", paneId, shellCommand], request.cwd, runCli);
	return { multiplexer: "herdr", placement: "window", id: tabId };
};

export const herdrLaunchProvider: TerminalLaunchProvider<"herdr", typeof capabilities> = {
	capabilities,
	launch: launchHerdr,
};
