import * as path from "node:path";
import type { TerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { terminalLaunchCapabilities } from "./providers";
import { launchError } from "./shared";
import {
	type PlacementCapabilities,
	TerminalLaunchError,
	type TerminalLaunchMultiplexer,
	type TerminalLaunchRequest,
} from "./types";

const terminalControlBytes = /[\u0000-\u001f\u007f-\u009f]/u;

/** Validate untyped extension/JavaScript requests against the same map that defines the TS request union. */
export function validateRequest(value: unknown): asserts value is TerminalLaunchRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("A terminal launch request must be an object.");
	}
	const request = value as Record<string, unknown>;
	const multiplexer = request.multiplexer;
	const placement = request.placement;
	if (typeof multiplexer !== "string" || !Object.hasOwn(terminalLaunchCapabilities, multiplexer)) {
		throw new TypeError("The requested terminal multiplexer is not recognized.");
	}
	if (placement !== "pane" && placement !== "window") {
		throw new TypeError("The requested terminal placement is not supported.");
	}

	const provider = terminalLaunchCapabilities[multiplexer as TerminalMultiplexer];
	if (!provider.supported) {
		throw new TerminalLaunchError(provider.reason, multiplexer as TerminalMultiplexer, placement, "capability");
	}
	const capabilities = provider[placement] as PlacementCapabilities | undefined;
	if (!capabilities) {
		throw new TerminalLaunchError(
			`${multiplexer} does not support ${placement} launches.`,
			multiplexer as TerminalMultiplexer,
			placement,
			"capability",
		);
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
	// Backends pass cwd to the CLI and also run the CLI there; a relative path would resolve twice.
	if (!path.isAbsolute(cwd as string)) {
		fail("validate", "A terminal launch working directory must be an absolute path.");
	}
	if (capabilities.cwdShellInput && typeof cwd === "string" && terminalControlBytes.test(cwd)) {
		fail("cwd", "Shell-input launch working directories cannot contain terminal control bytes.");
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
