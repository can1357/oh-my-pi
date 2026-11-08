import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { quotePosixArgv } from "../../utils/shell-quote";
import { launchError, oneLineId, runStep } from "./shared";
import type { SupportedMultiplexerCapabilities, TerminalLaunchBackend, TerminalLaunchProvider } from "./types";

const capabilities = {
	displayName: "tmux",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["direct", "shell"],
		target: "pane",
		direction: ["right", "down"],
		focus: true,
	},
	window: {
		displayName: "window",
		execution: ["direct", "shell"],
		target: "session",
		focus: true,
	},
} as const satisfies SupportedMultiplexerCapabilities;

function escapeTmuxArgument(value: string): string {
	// tmux consumes the escape before a trailing separator; retain existing backslashes.
	const trailingSemicolon = /(\\*);$/u.exec(value);
	if (!trailingSemicolon) return value;
	const backslashes = trailingSemicolon[1]!.length;
	return `${value.slice(0, -backslashes - 1)}${"\\".repeat(backslashes + 1)};`;
}

const launchTmux: TerminalLaunchBackend<"tmux", typeof capabilities> = async (
	request,
	{ environment: env, runCli },
) => {
	const inTmux = hasTerminalMultiplexerSession("tmux", env);
	if (!inTmux && !request.target) {
		throw launchError(request, "capability", "tmux launch requires an active TMUX session or an explicit target.");
	}
	const operation = request.placement === "pane" ? "split-window" : "new-window";
	let target: string | undefined;
	if (request.placement === "pane") {
		target = request.target ?? env.TMUX_PANE;
		if (!target) throw launchError(request, "target", "tmux split-window requires a target pane ID or TMUX_PANE.");
	} else {
		target = request.target;
	}
	if (request.placement === "window" && request.target && /^[%@]/u.test(request.target)) {
		throw launchError(
			request,
			"target",
			"tmux new-window target must be a session ID or name, not a pane or window ID.",
		);
	}

	const argv = ["tmux", operation];
	if (request.placement === "pane") argv.push(request.direction === "down" ? "-v" : "-h");
	if (request.focus === false) argv.push("-d");
	// tmux format-expands the -c start directory (`#{...}`, `#S`, `#(cmd)`); `##` is a literal `#`.
	argv.push("-c", escapeTmuxArgument(request.cwd.replaceAll("#", "##")));
	if (target) argv.push("-t", escapeTmuxArgument(target));
	argv.push("-P", "-F", request.placement === "pane" ? "#{pane_id}" : "#{window_id}", "--");

	// tmux execs a multi-argument command directly but runs a single argument
	// through its configured `default-shell -c`, which may not use POSIX grammar.
	let commandArgs: readonly string[];
	if (request.execution === "shell") {
		commandArgs = ["/bin/sh", "-c", quotePosixArgv(request.command)];
	} else if (request.command.length === 1) {
		const executable = request.command[0]!;
		if (executable.includes("=")) {
			throw launchError(
				request,
				"command",
				"tmux direct execution cannot safely run a single executable name containing '='.",
			);
		}
		// env turns a one-element command into a multi-argument direct launch
		// instead of default-shell text.
		commandArgs = ["/usr/bin/env", "--", executable];
	} else {
		commandArgs = request.command;
	}
	argv.push(...commandArgs.map(escapeTmuxArgument));
	const stdout = await runStep(request, operation, argv, request.cwd, runCli);
	const id = oneLineId(request, operation, stdout);
	const validId = request.placement === "pane" ? /^%\d+$/u.test(id) : /^@\d+$/u.test(id);
	if (!validId) throw launchError(request, operation, `tmux ${operation} returned an invalid ID.`);
	return { multiplexer: "tmux", placement: request.placement, id };
};

export const tmuxLaunchProvider: TerminalLaunchProvider<"tmux", typeof capabilities> = {
	capabilities,
	launch: launchTmux,
};
