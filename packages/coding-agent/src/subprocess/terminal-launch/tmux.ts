import { quotePosixArgv } from "../../utils/shell-quote";
import { launchError, oneLineId, runStep } from "./shared";
import type { TerminalLaunchBackend } from "./types";

function escapeTmuxArgument(value: string): string {
	// tmux consumes the escape before a trailing separator; retain existing backslashes.
	const trailingSemicolon = /(\\*);$/u.exec(value);
	if (!trailingSemicolon) return value;
	const backslashes = trailingSemicolon[1]!.length;
	return `${value.slice(0, -backslashes - 1)}${"\\".repeat(backslashes + 1)};`;
}

export const launchTmux: TerminalLaunchBackend<"tmux"> = async (request, { environment: env, runCli }) => {
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
	argv.push("-c", escapeTmuxArgument(request.cwd));
	if (target) argv.push("-t", escapeTmuxArgument(target));
	argv.push("-P", "-F", request.placement === "pane" ? "#{pane_id}" : "#{window_id}", "--");

	let commandArgs: readonly string[];
	if (request.execution === "shell") {
		commandArgs = [quotePosixArgv(request.command)];
	} else if (request.command.length === 1) {
		const executable = request.command[0]!;
		if (executable.includes("=")) {
			throw launchError(
				request,
				"command",
				"tmux direct execution cannot safely run a single executable name containing '='.",
			);
		}
		// tmux uses sh -c for its command field. env makes a one-element command
		// a direct argv launch instead of executable shell text.
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
