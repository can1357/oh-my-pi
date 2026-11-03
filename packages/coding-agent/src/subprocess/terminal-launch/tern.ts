import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { launchError, parseJson, runStep } from "./shared";
import type { SupportedMultiplexerCapabilities, TerminalLaunchBackend, TerminalLaunchProvider } from "./types";

const capabilities = {
	displayName: "Tern",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["direct"],
		target: "block",
		direction: ["right", "down"],
	},
	window: {
		displayName: "tab",
		execution: ["direct"],
		target: "session",
	},
} as const satisfies SupportedMultiplexerCapabilities;

const launchTern: TerminalLaunchBackend<"tern", typeof capabilities> = async (
	request,
	{ environment: env, runCli },
) => {
	if (!hasTerminalMultiplexerSession("tern", env)) {
		throw launchError(request, "capability", "Tern launch requires an active Tern pane and daemon socket.");
	}
	const executable = env.TERN_EXE?.trim() || "tern";
	let target = request.target ?? (request.placement === "pane" ? env.TERN_PANE?.trim() : undefined);
	if (request.placement === "window" && target === undefined) {
		// `new tab` otherwise uses the visible session, which may not contain this pane.
		const state = parseJson(
			request,
			"inspect",
			await runStep(request, "inspect", [executable, "inspect", "--json"], request.cwd, runCli, env),
		);
		const sessions = state.sessions as { id: number; tabs: { blocks: { id: number }[] }[] }[] | undefined;
		const session = sessions?.find(session =>
			session.tabs.some(tab => tab.blocks.some(block => String(block.id) === env.TERN_PANE?.trim())),
		);
		if (!session) throw launchError(request, "target", "Tern could not find the session containing this pane.");
		target = String(session.id);
	}
	if (target !== undefined && (!/^\d+$/.test(target) || !Number.isSafeInteger(Number(target)))) {
		throw launchError(request, "target", "Tern launch requires a numeric block or session ID.");
	}
	const operation = request.placement === "pane" ? "split" : "new tab";
	const argv = [executable];
	if (request.placement === "pane") {
		argv.push("split", target!, request.direction ?? "right");
	} else {
		argv.push("new", "tab");
		if (target !== undefined) argv.push(target);
	}
	argv.push("--json", "--cwd", request.cwd, "--", ...request.command);
	const created = parseJson(request, operation, await runStep(request, operation, argv, request.cwd, runCli, env));
	const id = request.placement === "pane" ? created.block : created.tab;
	if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
		throw launchError(
			request,
			operation,
			`Tern ${operation} returned no valid ${capabilities[request.placement].displayName} ID.`,
		);
	}
	return { multiplexer: "tern", placement: request.placement, id: String(id) };
};

export const ternLaunchProvider: TerminalLaunchProvider<"tern", typeof capabilities> = {
	capabilities,
	launch: launchTern,
};
