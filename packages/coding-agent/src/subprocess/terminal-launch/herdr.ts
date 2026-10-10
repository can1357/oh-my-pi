import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { quotePosixArgument, quotePosixArgv } from "../../utils/shell-quote";
import { launchError, nestedString, parseJson, runStep } from "./shared";
import type {
	SupportedMultiplexerCapabilities,
	TerminalLaunchBackend,
	TerminalLaunchCliRunner,
	TerminalLaunchProvider,
	TerminalLaunchRequest,
} from "./types";

const capabilities = {
	displayName: "Herdr",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["shell-input"],
		target: "pane",
		direction: ["right", "down"],
		focus: true,
	},
	window: {
		displayName: "tab",
		execution: ["shell-input"],
		target: "workspace",
		focus: true,
		label: true,
	},
} as const satisfies SupportedMultiplexerCapabilities;

const shellNeutralWord = /^[A-Za-z0-9_./-]+$/;

/**
 * `herdr pane run` types text into the pane's interactive shell, whose grammar is unknown.
 * Typing only the absolute path of a self-deleting `/bin/sh` script keeps argv exact in any shell.
 */
async function runInPane(
	request: TerminalLaunchRequest,
	paneId: string,
	runCli: TerminalLaunchCliRunner,
): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-herdr-"));
	try {
		const script = path.join(directory, "launch");
		if (!shellNeutralWord.test(script)) {
			throw launchError(
				request,
				"launch script",
				"Herdr launch needs a temporary directory path made of letters, digits, and ./_- only.",
			);
		}
		await fs.writeFile(
			script,
			`#!/bin/sh\nrm -rf -- ${quotePosixArgument(directory)}\nexec ${quotePosixArgv(request.command)}\n`,
			{ mode: 0o700 },
		);
		await runStep(request, "pane run", ["herdr", "pane", "run", paneId, script], request.cwd, runCli);
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
}

const launchHerdr: TerminalLaunchBackend<"herdr", typeof capabilities> = async (
	request,
	{ environment: env, platform, runCli },
) => {
	if (platform === "win32") {
		throw launchError(request, "capability", "Herdr launches are not supported on Windows.");
	}
	if (!hasTerminalMultiplexerSession("herdr", env)) {
		throw launchError(request, "capability", "Herdr launch requires an active Herdr pane or workspace.");
	}
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
		await runInPane(request, paneId, runCli);
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
	await runInPane(request, paneId, runCli);
	return { multiplexer: "herdr", placement: "window", id: tabId };
};

export const herdrLaunchProvider: TerminalLaunchProvider<"herdr", typeof capabilities> = {
	capabilities,
	launch: launchHerdr,
};
