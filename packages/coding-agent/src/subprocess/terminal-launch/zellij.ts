import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { launchError, oneLineId, runStep } from "./shared";
import type {
	SupportedMultiplexerCapabilities,
	TerminalLaunchBackend,
	TerminalLaunchCliRunner,
	TerminalLaunchProvider,
	TerminalLaunchRequest,
} from "./types";

const capabilities = {
	displayName: "Zellij",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["direct"],
		target: "tab",
		direction: ["right", "down"],
		floating: true,
		floatingDirectionExclusive: true,
		focus: true,
		name: true,
		minimumVersion: { focus: "0.45.0", target: "0.44.1" },
	},
	window: {
		displayName: "tab",
		execution: ["direct"],
		target: false,
		focus: true,
		name: true,
		// `new-tab -- <command>` and the printed tab ID both arrived in 0.44.0.
		minimumVersion: { launch: "0.44.0", focus: "0.45.0" },
	},
} as const satisfies SupportedMultiplexerCapabilities;

type ZellijLaunchRequest = Extract<TerminalLaunchRequest, { multiplexer: "zellij" }>;

/** Parsed `zellij --version` per CLI runner; the installed CLI does not change while omp runs. */
const zellijVersions = new WeakMap<TerminalLaunchCliRunner, readonly number[]>();

function parseVersion(text: string): readonly number[] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/u.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function isAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
	for (let index = 0; index < minimum.length; index++) {
		if (version[index] !== minimum[index]) return version[index]! > minimum[index]!;
	}
	return true;
}

// Older Zellij CLIs fail on these flags with a bare usage error; name the required version instead.
async function requireZellijVersion(
	request: ZellijLaunchRequest,
	runCli: TerminalLaunchCliRunner,
	minimum: string,
	flag: string,
): Promise<void> {
	let version = zellijVersions.get(runCli);
	if (!version) {
		version = parseVersion(await runStep(request, "--version", ["zellij", "--version"], request.cwd, runCli));
		if (version) zellijVersions.set(runCli, version);
	}
	if (!version) {
		throw launchError(
			request,
			"version",
			`zellij ${flag} requires Zellij ${minimum} or newer, and the installed version could not be determined.`,
		);
	}
	if (!isAtLeast(version, parseVersion(minimum)!)) {
		throw launchError(
			request,
			"version",
			`zellij ${flag} requires Zellij ${minimum} or newer (found ${version.join(".")}).`,
		);
	}
}

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
	request: ZellijLaunchRequest,
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

const launchZellij: TerminalLaunchBackend<"zellij", typeof capabilities> = async (request, { environment, runCli }) => {
	if (!hasTerminalMultiplexerSession("zellij", environment)) {
		throw launchError(request, "capability", "zellij launch requires an active Zellij session.");
	}
	const operation = request.placement === "pane" ? "new-pane" : "new-tab";
	if (request.placement === "window") {
		await requireZellijVersion(request, runCli, capabilities.window.minimumVersion.launch, "new-tab -- <command>");
	} else if (request.target !== undefined) {
		await requireZellijVersion(request, runCli, capabilities.pane.minimumVersion.target, "new-pane --tab-id");
	}
	if (request.focus === false) {
		const minimum = capabilities[request.placement].minimumVersion.focus;
		await requireZellijVersion(request, runCli, minimum, `${operation} --no-focus`);
	}
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
	// Zellij before 0.44.0 runs a new-pane command but prints no pane ID.
	if (!output.trim()) return { multiplexer: "zellij", placement: request.placement };
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

export const zellijLaunchProvider: TerminalLaunchProvider<"zellij", typeof capabilities> = {
	capabilities,
	launch: launchZellij,
};
