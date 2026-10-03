import { launchError, oneLineId, runStep } from "./shared";
import type { TerminalLaunchBackend, TerminalLaunchCliRunner, TerminalLaunchRequest } from "./types";

function isTabInformation(value: unknown): value is { tab_id: string | number } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"tab_id" in value &&
		(typeof value.tab_id === "number" || typeof value.tab_id === "string")
	);
}

// Zellij can silently create in the active tab when --tab-id names no existing tab.
async function requireExistingTargetTab(
	request: Extract<TerminalLaunchRequest, { multiplexer: "zellij" }>,
	target: string,
	runCli: TerminalLaunchCliRunner,
): Promise<void> {
	const operation = "action list-tabs";
	const output = await runStep(request, operation, ["zellij", "action", "list-tabs", "--json"], request.cwd, runCli);
	let tabs: unknown;
	try {
		tabs = JSON.parse(output);
	} catch {
		throw launchError(request, operation, "zellij action list-tabs returned invalid JSON.");
	}
	if (!Array.isArray(tabs) || !tabs.every(isTabInformation)) {
		throw launchError(request, operation, "zellij action list-tabs returned invalid tab information.");
	}
	if (!tabs.some(tab => String(tab.tab_id) === target)) {
		throw launchError(request, "action new-pane", "zellij new-pane target tab does not exist.");
	}
}

export const launchZellij: TerminalLaunchBackend<"zellij"> = async (request, { runCli }) => {
	const operation = request.placement === "pane" ? "new-pane" : "new-tab";
	const argv = ["zellij", "action", operation];
	if (request.placement === "pane") {
		if (request.floating) argv.push("--floating");
		else argv.push("--direction", request.direction ?? "right");
		if (request.target !== undefined) {
			await requireExistingTargetTab(request, request.target, runCli);
			argv.push("--tab-id", request.target);
		}
	} else if (request.name) {
		argv.push("--name", request.name);
	}
	if (request.placement === "pane" && request.name) argv.push("--name", request.name);
	argv.push("--cwd", request.cwd);
	if (request.focus === false) argv.push("--no-focus");
	argv.push("--", ...request.command);
	const output = await runStep(request, `action ${operation}`, argv, request.cwd, runCli);
	const id = oneLineId(request, `action ${operation}`, output);
	if (request.placement === "pane") {
		if (!/^(?:terminal_)?[0-9]+$/u.test(id)) {
			throw launchError(request, `action ${operation}`, `zellij ${operation} returned an invalid ID.`);
		}
		return {
			multiplexer: "zellij",
			placement: request.placement,
			id: id.startsWith("terminal_") ? id : `terminal_${id}`,
		};
	}
	if (!/^[0-9]+$/u.test(id)) {
		throw launchError(request, `action ${operation}`, `zellij ${operation} returned an invalid ID.`);
	}
	return { multiplexer: "zellij", placement: request.placement, id };
};
