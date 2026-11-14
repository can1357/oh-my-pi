import { launchError, nestedString, parseJson, runStep } from "./shared";
import type {
	SupportedMultiplexerCapabilities,
	TerminalLaunchBackend,
	TerminalLaunchCliResult,
	TerminalLaunchProvider,
	TerminalLaunchRequest,
} from "./types";

const capabilities = {
	displayName: "Herdr Core",
	supported: true,
	pane: { displayName: "pane", execution: ["direct"], target: "pane", direction: ["right", "down"], focus: true },
	window: { displayName: "tab", execution: ["direct"], target: "space", focus: true },
} as const satisfies SupportedMultiplexerCapabilities;

type DesktopLocation = { pane: string; space: string };

function desktopFailure(request: TerminalLaunchRequest, operation: string, result: TerminalLaunchCliResult): Error {
	const output = `${result.stderr ?? ""}\n${result.stdout}`;
	let detail = "Inspect Herdr Desktop logs for details; check whether a terminal was created before retrying.";
	if (/permission denied/i.test(output)) {
		detail = "Desktop permission denied; check its socket permissions.";
	} else if (/connection refused/i.test(output)) {
		detail = "Desktop connection refused; check that its window is running.";
	} else if (/\bpane\b.{0,80}\bnot found\b/i.test(output)) {
		detail = "The Desktop pane no longer exists; inspect the current Desktop layout.";
	} else if (/\bspace\b.{0,80}\bnot found\b/i.test(output)) {
		detail = "The Desktop space no longer exists; inspect the current Desktop layout.";
	}
	const exit = result.exitCode === null ? "did not exit successfully" : `failed (exit ${result.exitCode})`;
	return launchError(request, operation, `herdr-core ${operation} ${exit}. ${detail}`, result.exitCode);
}

function locations(
	request: TerminalLaunchRequest,
	stdout: string,
	terminalId: string,
	target?: string,
): { matches: DesktopLocation[]; targetMachines: (string | null)[] } {
	const payload = parseJson(request, "desktop list", stdout);
	const invalid = () => launchError(request, "desktop list", "Herdr Desktop returned an invalid terminal listing.");
	if (!Array.isArray(payload.spaces)) throw invalid();
	const matches: DesktopLocation[] = [];
	const targetMachines: (string | null)[] = [];
	for (const space of payload.spaces) {
		if (typeof space !== "object" || space === null || Array.isArray(space)) throw invalid();
		if (
			typeof space.id !== "string" ||
			!space.id.trim() ||
			(space.machine !== null && typeof space.machine !== "string")
		) {
			throw invalid();
		}
		if (!Array.isArray(space.tabs)) throw invalid();
		if (request.placement === "window" && target === space.id) targetMachines.push(space.machine);
		for (const tab of space.tabs) {
			if (typeof tab !== "object" || tab === null || Array.isArray(tab)) throw invalid();
			if (typeof tab.id !== "string" || !tab.id.trim() || !Array.isArray(tab.terminals)) throw invalid();
			for (const terminal of tab.terminals) {
				if (typeof terminal !== "object" || terminal === null || Array.isArray(terminal)) throw invalid();
				if (
					typeof terminal.terminal !== "string" ||
					!terminal.terminal.trim() ||
					typeof terminal.pane !== "string" ||
					!terminal.pane.trim()
				) {
					throw invalid();
				}
				if (request.placement === "pane" && target === terminal.pane) targetMachines.push(space.machine);
				if (space.machine === null && terminal.terminal === terminalId) {
					matches.push({ pane: terminal.pane, space: space.id });
				}
			}
		}
	}
	return { matches, targetMachines };
}

const launchHerdrCore: TerminalLaunchBackend<"herdr-core", typeof capabilities> = async (
	request,
	{ environment, platform, runCli },
) => {
	const terminalId = environment.HC_TERMINAL_ID;
	if (!terminalId?.trim()) {
		throw launchError(request, "target", "Herdr Core launch requires HC_TERMINAL_ID.");
	}
	if (platform === "win32") {
		throw launchError(request, "capability", "Herdr Core terminal launches are not supported on Windows.");
	}
	let listing: TerminalLaunchCliResult | undefined;
	try {
		listing = await runCli(["herdr-app", "ls"], request.cwd);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw launchError(request, "desktop list", "Herdr Desktop listing could not start its CLI.");
		}
	}
	let matches: DesktopLocation[] = [];
	let targetMachines: (string | null)[] = [];
	if (listing) {
		if (listing.exitCode === 0) {
			({ matches, targetMachines } = locations(request, listing.stdout, terminalId, request.target));
		} else if (
			!(
				listing.exitCode === 2 &&
				!listing.stdout.trim() &&
				(/^herdr-app: no Herdr window at [^:\r\n]+: No such file or directory(?: \(os error 2\))?\s*$/.test(
					listing.stderr ?? "",
				) ||
					/^herdr-app: no Herdr window at [^:\r\n]+: Connection refused \(os error (?:61|111)\)\s*$/.test(
						listing.stderr ?? "",
					))
			)
		) {
			throw desktopFailure(request, "desktop list", listing);
		}
	}
	if (request.target !== undefined) {
		if (!listing || listing.exitCode !== 0) {
			throw launchError(request, "target", "An explicit Herdr Desktop target requires a running Desktop window.");
		}
		if (targetMachines.length === 0) {
			throw launchError(request, "target", "The Herdr Desktop target was not found in the listing.");
		}
		if (targetMachines.length > 1) {
			throw launchError(request, "target", "The Herdr Desktop target matched multiple locations in the listing.");
		}
		if (targetMachines[0] !== null) {
			throw launchError(request, "target", "Herdr Desktop targets must belong to a local space.");
		}
	} else if (matches.length > 1) {
		throw launchError(request, "desktop list", "Herdr Desktop listing matched multiple panes for HC_TERMINAL_ID.");
	}

	const location = request.target === undefined ? matches[0] : { pane: request.target, space: request.target };
	if (request.command[0]?.includes("=") && request.command[0].startsWith("-")) {
		throw launchError(
			request,
			"command",
			"Herdr Core cannot safely run an executable beginning with '-' and containing '='.",
		);
	}
	const command = request.command[0]?.includes("=")
		? ["/bin/sh", "-c", 'exec "$@"', "herdr-core", ...request.command]
		: request.command;
	if (!location) {
		if (request.focus !== undefined) {
			throw launchError(request, "focus", "Explicit focus requires a visible Herdr Desktop source pane.");
		}
		// A leading env makes even a one-element argv an explicit program, not hc's shell-line form.
		const argv = [
			"hc",
			"run",
			"--json",
			"--bg",
			"--no-notify",
			"--outlive-parent",
			"--cwd",
			request.cwd,
			"--",
			"/usr/bin/env",
			"--",
			...command,
		];
		const output = parseJson(request, "core run", await runStep(request, "core run", argv, request.cwd, runCli));
		const id = nestedString(output, "address");
		if (!id) throw launchError(request, "core run", "Herdr Core run returned no terminal address.");
		if (!/^t[0-9a-z]+$/.test(id))
			throw launchError(
				request,
				"core run",
				"Herdr Core run returned an invalid terminal address; check existing terminals before retrying.",
			);
		return {
			multiplexer: "herdr-core",
			placement: request.placement,
			id,
			warning: `Herdr Core created a headless terminal; no visible ${request.placement === "pane" ? "pane" : "tab"} was created. Program startup was not confirmed; attach with hc attach ${id}.`,
		};
	}

	let focusArgs: { pane: string } | { terminal: string } | undefined;
	if (request.focus === false) {
		const status = parseJson(
			request,
			"desktop status",
			await runStep(request, "desktop status", ["herdr-app", "status"], request.cwd, runCli, undefined, result =>
				desktopFailure(request, "desktop status", result),
			),
		);
		const pane = nestedString(status, "focused_pane");
		if (!pane || /[\s\u0000-\u001f\u007f-\u009f]/u.test(pane)) {
			throw launchError(request, "desktop status", "Herdr Desktop status returned no valid focused pane.");
		}
		focusArgs = { pane };
	}

	const operation = request.placement === "pane" ? "pane.split" : "tab.new";
	// pane.split has no folder option; pass cwd and command as literal shell arguments.
	const args =
		request.placement === "pane"
			? {
					pane: location.pane,
					direction: request.direction ?? "right",
					argv: [
						"/bin/sh",
						"-c",
						'CDPATH= cd -P -- "$1" || exit; shift; exec -- "$@"',
						"herdr-core",
						request.cwd,
						...request.command,
					],
				}
			: { space: location.space, folder: request.cwd, argv: request.command };
	const output = parseJson(
		request,
		operation,
		await runStep(
			request,
			operation,
			["herdr-app", "do", operation, JSON.stringify(args)],
			request.cwd,
			runCli,
			undefined,
			result => desktopFailure(request, operation, result),
		),
	);
	const id = nestedString(output, request.placement === "pane" ? "pane" : "tab");
	const terminal = nestedString(output, "terminal");
	if (!id || !terminal) {
		throw launchError(request, operation, `Herdr Desktop ${operation} returned incomplete IDs.`);
	}
	if (request.focus === true) focusArgs = { terminal };
	let warning = "Herdr Desktop created the terminal, but program startup was not confirmed.";
	if (request.focus === false && focusArgs && "pane" in focusArgs) {
		try {
			let createdPane = id;
			if (request.placement === "window") {
				const listing = await runCli(["herdr-app", "ls"], request.cwd);
				if (listing.exitCode !== 0) throw new Error("Desktop listing failed");
				const { matches } = locations(request, listing.stdout, terminal);
				if (matches.length !== 1 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(matches[0]!.pane)) {
					throw new Error("Invalid created pane");
				}
				createdPane = matches[0]!.pane;
			}
			const result = await runCli(["herdr-app", "status"], request.cwd);
			if (result.exitCode !== 0) throw new Error("Desktop status failed");
			const status = parseJson(request, "desktop status", result.stdout);
			const currentPane = nestedString(status, "focused_pane");
			if (!currentPane || /[\s\u0000-\u001f\u007f-\u009f]/u.test(currentPane)) {
				throw new Error("Invalid focused pane");
			}
			if (currentPane === focusArgs.pane) {
				focusArgs = undefined;
			} else {
				if (currentPane !== createdPane) {
					focusArgs = undefined;
					warning += " Focus changed during creation; restoration was skipped.";
					if (request.placement === "window") warning += " Inspect the Desktop layout.";
				}
			}
		} catch {
			focusArgs = undefined;
			warning +=
				" Could not check Desktop focus after creation; restoration was skipped. Inspect the Desktop layout and logs.";
		}
	}
	if (focusArgs) {
		let focusFailed = false;
		try {
			const result = await runCli(["herdr-app", "do", "pane.focus", JSON.stringify(focusArgs)], request.cwd);
			focusFailed = result.exitCode !== 0;
		} catch {
			focusFailed = true;
		}
		if (focusFailed) {
			warning += request.focus
				? " Could not focus the created terminal. Inspect the Desktop layout and logs."
				: " Could not restore the previously focused pane. Inspect the Desktop layout and logs.";
		}
	}
	return {
		multiplexer: "herdr-core",
		placement: request.placement,
		id,
		warning,
	};
};

export const herdrCoreLaunchProvider: TerminalLaunchProvider<"herdr-core", typeof capabilities> = {
	capabilities,
	launch: launchHerdrCore,
};
