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
	TerminalLaunchResult,
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
	const directory = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), "omp-herdr-"));
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

/**
 * herdr-app (desktop) terminals run in herdr-core and carry `HC_TERMINAL_ID` instead of the
 * Herdr TUI's HERDR_* pane vars, and the TUI's `herdr pane|tab` CLI cannot place surfaces in the
 * app's window. Placement goes through the window API (`herdr-app do`), which runs the child argv
 * directly — no typed shell input, so the exact command survives any shell grammar.
 *
 * The window's actions default to the focused pane/space, which need not be the invoking
 * terminal's, so the destination is the explicit target or else resolved from `HC_TERMINAL_ID`.
 */
async function launchHerdrCore(
	request: TerminalLaunchRequest,
	terminalId: string,
	runCli: TerminalLaunchCliRunner,
): Promise<TerminalLaunchResult> {
	let origin: HerdrCoreOrigin | undefined;
	const resolveOrigin = async () => {
		origin ??= await findHerdrCoreOrigin(request, terminalId, runCli);
		return origin;
	};

	let appArgv: string[];
	if (request.placement === "pane") {
		const pane = request.target ?? (await resolveOrigin()).pane;
		// `pane.split` takes no folder: the new terminal starts in the split pane's. Enter
		// request.cwd from argv instead; positional parameters keep cwd and command exact.
		const command = ["/bin/sh", "-c", 'cd -- "$1" && shift && "$@"', "omp-fork", request.cwd, ...request.command];
		appArgv = ["herdr-app", "do", "pane.split", "--direction", request.direction ?? "right", "--pane", pane];
		appArgv.push("--argv", JSON.stringify(command));
	} else {
		const space = request.target ?? (await resolveOrigin()).space;
		appArgv = ["herdr-app", "do", "tab.new", "--space", space, "--folder", request.cwd];
		appArgv.push("--argv", JSON.stringify(request.command));
		if (request.label) appArgv.push("--name", request.label);
	}
	// The new pane/tab takes focus; resolve where focus returns before anything is created.
	const returnFocusTo = request.focus === false ? (await resolveOrigin()).pane : undefined;

	const operation = request.placement === "pane" ? "pane split" : "tab create";
	const created = parseJson(request, operation, await runStep(request, operation, appArgv, request.cwd, runCli));
	const id = nestedString(created, request.placement === "pane" ? "pane" : "tab");
	if (!id) throw launchError(request, operation, `herdr-app ${operation} returned no ID.`);
	const result: TerminalLaunchResult = { multiplexer: "herdr", placement: request.placement, id };
	if (returnFocusTo) {
		const refocused = await runCli(["herdr-app", "do", "pane.focus", "--pane", returnFocusTo], request.cwd).catch(
			() => undefined,
		);
		// The child is already running: report the focus miss rather than fail its launch.
		if (refocused?.exitCode !== 0) result.warning = "Herdr kept focus on the new surface.";
	}
	return result;
}

interface HerdrCoreOrigin {
	pane: string;
	space: string;
}

/** The slice of `herdr-app ls` that maps a terminal to its pane and space; every field is unverified input. */
interface HerdrCoreListing {
	spaces?: { id?: unknown; tabs?: { terminals?: { terminal?: unknown; pane?: unknown }[] }[] }[];
}

/** Finds the pane and space showing the invoking terminal in the window's `ls`. */
async function findHerdrCoreOrigin(
	request: TerminalLaunchRequest,
	terminalId: string,
	runCli: TerminalLaunchCliRunner,
): Promise<HerdrCoreOrigin> {
	const stdout = await runStep(request, "ls", ["herdr-app", "ls"], request.cwd, runCli);
	const listing = parseJson(request, "ls", stdout) as HerdrCoreListing;
	for (const space of Array.isArray(listing.spaces) ? listing.spaces : []) {
		for (const tab of Array.isArray(space?.tabs) ? space.tabs : []) {
			for (const terminal of Array.isArray(tab?.terminals) ? tab.terminals : []) {
				if (terminal?.terminal !== terminalId) continue;
				if (typeof terminal.pane === "string" && typeof space.id === "string") {
					return { pane: terminal.pane, space: space.id };
				}
			}
		}
	}
	throw launchError(request, "target", `Herdr shows no pane for terminal ${terminalId}.`);
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
	if (!env.HERDR_PANE_ID && !env.HERDR_TAB_ID && !env.HERDR_WORKSPACE_ID && env.HC_TERMINAL_ID) {
		return launchHerdrCore(request, env.HC_TERMINAL_ID, runCli);
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
