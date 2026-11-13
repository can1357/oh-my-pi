import { launchError, nestedString, parseJson, runStep } from "./shared";
import type {
	SupportedMultiplexerCapabilities,
	TerminalLaunchBackend,
	TerminalLaunchCliResult,
	TerminalLaunchCliRunner,
	TerminalLaunchProvider,
	TerminalLaunchRequest,
} from "./types";

const capabilities = {
	displayName: "Herdr Core",
	supported: true,
	pane: { displayName: "pane", execution: ["direct"], target: false, direction: ["right", "down"] },
	window: { displayName: "tab", execution: ["direct"], target: false },
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

async function desktopStep(
	request: TerminalLaunchRequest,
	operation: string,
	argv: readonly string[],
	runCli: TerminalLaunchCliRunner,
): Promise<string> {
	let result: TerminalLaunchCliResult;
	try {
		result = await runCli(argv, request.cwd);
	} catch {
		throw launchError(request, operation, `herdr-core ${operation} could not start its CLI.`);
	}
	if (result.exitCode !== 0) throw desktopFailure(request, operation, result);
	return result.stdout;
}

function locations(request: TerminalLaunchRequest, stdout: string, terminalId: string): DesktopLocation[] {
	const payload = parseJson(request, "desktop list", stdout);
	const invalid = () => launchError(request, "desktop list", "Herdr Desktop returned an invalid terminal listing.");
	if (!Array.isArray(payload.spaces)) throw invalid();
	const matches: DesktopLocation[] = [];
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
				if (space.machine === null && terminal.terminal === terminalId) {
					matches.push({ pane: terminal.pane, space: space.id });
				}
			}
		}
	}
	return matches;
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
	if (listing) {
		if (listing.exitCode === 0) {
			matches = locations(request, listing.stdout, terminalId);
		} else if (
			!(
				listing.exitCode === 2 &&
				!listing.stdout.trim() &&
				(/^herdr-app: no Herdr window at [^:\r\n]+: No such file or directory(?: \(os error 2\))?\s*$/.test(
					listing.stderr ?? "",
				) ||
					(platform === "darwin" &&
						/^herdr-app: no Herdr window at [^:\r\n]+: Connection refused \(os error 61\)\s*$/.test(
							listing.stderr ?? "",
						)) ||
					(platform === "linux" &&
						/^herdr-app: no Herdr window at [^:\r\n]+: Connection refused \(os error 111\)\s*$/.test(
							listing.stderr ?? "",
						)))
			)
		) {
			throw desktopFailure(request, "desktop list", listing);
		}
	}
	if (matches.length > 1) {
		throw launchError(request, "desktop list", "Herdr Desktop listing matched multiple panes for HC_TERMINAL_ID.");
	}

	const location = matches[0];
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
		if (!/^t[0-9]+$/.test(id))
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

	const operation = request.placement === "pane" ? "pane.split" : "tab.new";
	// pane.split has an explicit pane but no folder option. env changes cwd without shell interpolation.
	const args =
		request.placement === "pane"
			? {
					pane: location.pane,
					direction: request.direction ?? "right",
					argv: ["/usr/bin/env", "-C", request.cwd, "--", ...command],
				}
			: { space: location.space, folder: request.cwd, argv: request.command };
	const output = parseJson(
		request,
		operation,
		await desktopStep(request, operation, ["herdr-app", "do", operation, JSON.stringify(args)], runCli),
	);
	const id = nestedString(output, request.placement === "pane" ? "pane" : "tab");
	if (!id || !nestedString(output, "terminal")) {
		throw launchError(request, operation, `Herdr Desktop ${operation} returned incomplete IDs.`);
	}
	return {
		multiplexer: "herdr-core",
		placement: request.placement,
		id,
		warning: "Herdr Desktop created the terminal, but program startup was not confirmed.",
	};
};

export const herdrCoreLaunchProvider: TerminalLaunchProvider<"herdr-core", typeof capabilities> = {
	capabilities,
	launch: launchHerdrCore,
};
