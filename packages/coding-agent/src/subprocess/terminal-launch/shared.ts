import { ptree } from "@oh-my-pi/pi-utils";
import {
	TerminalLaunchError,
	type TerminalLaunchCliResult,
	type TerminalLaunchCliRunner,
	type TerminalLaunchRequest,
} from "./types";

export const processCli: TerminalLaunchCliRunner = async (argv, cwd, env) => {
	const result = await ptree.exec([...argv], { cwd, env, allowNonZero: true });
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

export async function runStep(
	request: TerminalLaunchRequest,
	operation: string,
	argv: readonly string[],
	cwd: string,
	runCli: TerminalLaunchCliRunner,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	let result: TerminalLaunchCliResult;
	try {
		result = await runCli(argv, cwd, env);
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
