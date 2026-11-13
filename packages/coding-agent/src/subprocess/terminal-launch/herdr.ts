import * as fs from "node:fs/promises";
import * as path from "node:path";
import { mkdtempInTempRoot } from "@oh-my-pi/pi-utils";
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
 * Typing only `/bin/sh` and the absolute path of a self-deleting script keeps argv exact in any
 * shell; invoking it through `/bin/sh` works even when the temp mount is `noexec`. The script is
 * written before the Herdr surface exists so a local failure leaves no orphaned pane or tab.
 */
async function prepareLaunchScript(request: TerminalLaunchRequest): Promise<{ directory: string; typed: string }> {
	const directory = await mkdtempInTempRoot("herdr-");
	try {
		const script = path.join(directory, "launch");
		if (!shellNeutralWord.test(script)) {
			throw launchError(
				request,
				"launch script",
				"Herdr launch needs a temporary directory path made of letters, digits, and ./_- only.",
			);
		}
		// No `exec`: it would parse a command name starting with `-` as an option.
		await Bun.write(script, `rm -rf -- ${quotePosixArgument(directory)}\n${quotePosixArgv(request.command)}\n`);
		return { directory, typed: `/bin/sh ${script}` };
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/** Creates the Herdr surface, then types the prepared launch line into its pane; returns the surface ID. */
async function launchInNewSurface(
	request: TerminalLaunchRequest,
	runCli: TerminalLaunchCliRunner,
	createSurface: () => Promise<{ id: string; paneId: string }>,
): Promise<string> {
	const { directory, typed } = await prepareLaunchScript(request);
	try {
		const { id, paneId } = await createSurface();
		await runStep(request, "pane run", ["herdr", "pane", "run", paneId, typed], request.cwd, runCli);
		return id;
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
		const id = await launchInNewSurface(request, runCli, async () => {
			const created = parseJson(
				request,
				"pane split",
				await runStep(request, "pane split", createArgv, request.cwd, runCli),
			);
			const paneId = nestedString(created, "result", "pane", "pane_id");
			if (!paneId) throw launchError(request, "pane split", "Herdr pane split returned no pane ID.");
			return { id: paneId, paneId };
		});
		return { multiplexer: "herdr", placement: "pane", id };
	}

	const workspace = request.target ?? env.HERDR_WORKSPACE_ID;
	if (!workspace) throw launchError(request, "target", "Herdr tab launch requires a workspace ID.");
	const createArgv = ["herdr", "tab", "create", "--workspace", workspace, "--cwd", request.cwd];
	if (request.label) createArgv.push("--label", request.label);
	createArgv.push(...focusArgs);
	const id = await launchInNewSurface(request, runCli, async () => {
		const created = parseJson(
			request,
			"tab create",
			await runStep(request, "tab create", createArgv, request.cwd, runCli),
		);
		const tabId = nestedString(created, "result", "tab", "tab_id");
		const paneId = nestedString(created, "result", "root_pane", "pane_id");
		if (!tabId || !paneId) throw launchError(request, "tab create", "Herdr tab create returned incomplete IDs.");
		return { id: tabId, paneId };
	});
	return { multiplexer: "herdr", placement: "window", id };
};

export const herdrLaunchProvider: TerminalLaunchProvider<"herdr", typeof capabilities> = {
	capabilities,
	launch: launchHerdr,
};
