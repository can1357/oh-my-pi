import { ptree } from "@oh-my-pi/pi-utils";
import { isInsideHerdr, type TerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import {
	terminalLaunchCapabilities,
	TerminalLaunchError,
	type PlacementCapabilities,
	type TerminalLaunchCliResult,
	type TerminalLaunchCliRunner,
	type TerminalLaunchMultiplexer,
	type TerminalLaunchRequest,
} from "./types";

const terminalControlBytes = /[\u0000-\u001f\u007f-\u009f]/u;

export const processCli: TerminalLaunchCliRunner = async (argv, cwd) => {
	const result = await ptree.exec([...argv], { cwd, allowNonZero: true });
	return { stdout: result.stdout, exitCode: result.exitCode };
};

export function launchError(
	request: Pick<TerminalLaunchRequest, "multiplexer" | "placement">,
	operation: string,
	message: string,
	exitCode?: number | null,
): TerminalLaunchError {
	return new TerminalLaunchError(message, request.multiplexer, request.placement, operation, exitCode);
}

function invalidRequest(value: unknown, message: string): never {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const multiplexer = record.multiplexer;
		const placement = record.placement;
		if (
			typeof multiplexer === "string" &&
			Object.hasOwn(terminalLaunchCapabilities, multiplexer) &&
			(placement === "pane" || placement === "window")
		) {
			const provider = terminalLaunchCapabilities[multiplexer as TerminalMultiplexer];
			if (!provider.supported) {
				throw new TerminalLaunchError(message, multiplexer as TerminalMultiplexer, placement, "validate");
			}
			if (provider[placement]) {
				throw new TerminalLaunchError(message, multiplexer as TerminalLaunchMultiplexer, placement, "validate");
			}
		}
	}
	throw new TypeError(message);
}
/** Validate untyped extension/JavaScript requests against the same map that defines the TS request union. */
export function validateRequest(value: unknown): asserts value is TerminalLaunchRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalidRequest(value, "A terminal launch request must be an object.");
	}
	const request = value as Record<string, unknown>;
	const multiplexer = request.multiplexer;
	const placement = request.placement;
	if (typeof multiplexer !== "string" || !Object.hasOwn(terminalLaunchCapabilities, multiplexer)) {
		invalidRequest(value, "The requested terminal multiplexer is not recognized.");
	}
	if (placement !== "pane" && placement !== "window") {
		invalidRequest(value, "The requested terminal placement is not supported.");
	}

	const provider = terminalLaunchCapabilities[multiplexer as TerminalMultiplexer];
	if (!provider.supported) {
		throw new TerminalLaunchError(provider.reason, multiplexer as TerminalMultiplexer, placement, "capability");
	}
	const capabilities = provider[placement] as PlacementCapabilities | undefined;
	if (!capabilities) {
		invalidRequest(value, `${multiplexer} does not support ${placement} launches.`);
	}
	const launch = {
		multiplexer: multiplexer as TerminalLaunchMultiplexer,
		placement: placement as "pane" | "window",
	};
	const fail = (operation: string, message: string): never => {
		throw launchError(launch, operation, message);
	};

	const command = request.command;
	if (!Array.isArray(command)) {
		fail("validate", "A terminal launch requires a non-empty command.");
	}
	const commandArguments = command as unknown[];
	if (commandArguments.length === 0) {
		fail("validate", "A terminal launch requires a non-empty command.");
	}
	if (commandArguments.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
		fail("validate", "A terminal launch command contains an invalid argument.");
	}
	if (
		capabilities.shellGrammar === "posix" &&
		commandArguments.some(argument => typeof argument === "string" && terminalControlBytes.test(argument))
	) {
		fail("command", "Shell-input command arguments cannot contain terminal control bytes.");
	}
	const cwd = request.cwd;
	if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
		fail("validate", "A terminal launch requires a valid working directory.");
	}
	if (capabilities.cwdShellInput && typeof cwd === "string" && terminalControlBytes.test(cwd)) {
		fail("cwd", "CMUX split working directories cannot contain terminal control bytes.");
	}

	for (const option of ["target", "name", "label"] as const) {
		const optionValue = request[option];
		if (
			optionValue !== undefined &&
			(typeof optionValue !== "string" || optionValue.length === 0 || optionValue.includes("\0"))
		) {
			fail(option, `The terminal launch ${option} is invalid.`);
		}
	}
	if (capabilities.target === false && request.target !== undefined) {
		fail("target", `${multiplexer} ${placement} creation does not accept a target.`);
	}
	if (request.execution !== undefined && !capabilities.execution?.includes(request.execution as string)) {
		fail("options", `The requested execution mode is not supported by ${multiplexer}.`);
	}
	if (request.direction !== undefined && !capabilities.direction?.includes(request.direction as string)) {
		fail("options", `The requested direction is not supported by ${multiplexer} for ${placement} launches.`);
	}
	if (request.floating !== undefined && capabilities.floating !== true) {
		fail("options", `${multiplexer} does not support floating panes.`);
	}
	if (request.floating !== undefined && typeof request.floating !== "boolean") {
		fail("options", "The terminal launch floating option must be a boolean.");
	}
	if (
		capabilities.floatingDirectionExclusive === true &&
		request.floating === true &&
		request.direction !== undefined
	) {
		fail("options", "zellij floating panes do not support a split direction.");
	}
	if (request.focus !== undefined && (capabilities.focus !== true || typeof request.focus !== "boolean")) {
		fail("options", `${multiplexer} does not support the requested focus option.`);
	}
	for (const option of ["name", "label"] as const) {
		if (request[option] !== undefined && capabilities[option] !== true) {
			fail("options", `${multiplexer} ${placement} creation does not support ${option}.`);
		}
	}
	if (capabilities.shellGrammar === "posix") {
		if (request.shellGrammar !== "posix") {
			fail(
				"shell-grammar",
				`${multiplexer} shell-input launch requires shellGrammar: "posix" to confirm the destination shell grammar.`,
			);
		}
	} else if (request.shellGrammar !== undefined) {
		fail("shell-grammar", `${multiplexer} launch does not use a shell-grammar assertion.`);
	}
}

export function requireCapability(request: TerminalLaunchRequest, env: NodeJS.ProcessEnv): void {
	switch (request.multiplexer) {
		case "tmux":
			if (!env.TMUX && !request.target) {
				throw launchError(
					request,
					"capability",
					"tmux launch requires an active TMUX session or an explicit target.",
				);
			}
			if (request.placement === "pane" && !(request.target ?? (env.TMUX ? env.TMUX_PANE : undefined))) {
				throw launchError(request, "target", "tmux split-window requires a target pane ID or TMUX_PANE.");
			}
			return;
		case "zellij":
			if (!env.ZELLIJ) throw launchError(request, "capability", "zellij launch requires an active Zellij session.");
			return;
		case "herdr":
			if (!isInsideHerdr(env)) {
				throw launchError(request, "capability", "Herdr launch requires an active Herdr pane or workspace.");
			}
			return;
		case "cmux":
			if (!env.CMUX_WORKSPACE_ID && !env.CMUX_SURFACE_ID && !request.target) {
				throw launchError(request, "capability", "CMUX launch requires a CMUX context or explicit target ID.");
			}
			return;
		default:
			return assertNever(request);
	}
}

export async function runStep(
	request: TerminalLaunchRequest,
	operation: string,
	argv: readonly string[],
	cwd: string,
	runCli: TerminalLaunchCliRunner,
): Promise<string> {
	let result: TerminalLaunchCliResult;
	try {
		result = await runCli(argv, cwd);
	} catch {
		throw launchError(request, operation, `${request.multiplexer} ${operation} could not start its CLI.`);
	}
	if (result.exitCode !== 0) {
		const exit = result.exitCode === null ? "did not exit successfully" : `failed (exit ${result.exitCode})`;
		throw launchError(request, operation, `${request.multiplexer} ${operation} ${exit}.`, result.exitCode);
	}
	return result.stdout;
}

export function oneLineId(request: TerminalLaunchRequest, operation: string, stdout: string): string {
	const trimmed = stdout.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) {
		throw launchError(request, operation, `${request.multiplexer} ${operation} did not return a valid ID.`);
	}
	return trimmed;
}

export function parseJson(request: TerminalLaunchRequest, operation: string, stdout: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(stdout);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw launchError(request, operation, `${request.multiplexer} ${operation} returned invalid JSON.`);
	}
}

export function nestedString(value: unknown, ...keys: string[]): string | undefined {
	let current: unknown = value;
	for (const key of keys) {
		if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" && current.trim() ? current : undefined;
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled terminal launch provider: ${String(value)}`);
}
