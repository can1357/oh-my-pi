/**
 * Whether a launch from inside an omp tool process may run headless by accident.
 *
 * `OMPCODE=1` marks the bash tool's shell and the eval kernels. Without a terminal
 * on stdin, `omp <words>` there runs like `-p` with the words as the prompt: an
 * unattended agent with the session's cwd, environment and credentials, which a
 * command meant for another program (observed in the field with Bun's shell
 * resolving `bun` to the omp executable) can start without anyone asking for it.
 * Such a launch is refused unless it says `-p`/`--print` or picks a `--mode`;
 * an explicit print run from a tool shell stays allowed, as people script it.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";

export interface ToolShellLaunch {
	env: Record<string, string | undefined>;
	/** `-p`/`--print` given. */
	print: boolean | undefined;
	/** `--mode` given (rpc, acp, json, …); these own stdin. */
	mode: string | undefined;
	stdinIsTerminal: boolean;
}

/** The refusal to print and exit with, or undefined when the launch may proceed. */
export function refuseToolShellAutoPrint(launch: ToolShellLaunch): string | undefined {
	if (launch.env.OMPCODE !== "1") return undefined;
	if (launch.print || launch.mode !== undefined || launch.stdinIsTerminal) return undefined;
	return (
		`Error: ${APP_NAME} was started from an ${APP_NAME} tool shell without a terminal, so a positional or piped prompt would start a headless agent.\n` +
		`To do that on purpose, pass the prompt with \`${APP_NAME} -p "…"\`.\n`
	);
}
