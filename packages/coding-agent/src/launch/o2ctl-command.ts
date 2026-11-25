/**
 * `o2ctl`: omp's control command in the embedded shell. Only the `services` namespace exists,
 * the bash tool's named services for processes a command already started: `add` adopts a
 * running process without restarting it; `ls` and `stop` are the service list and stop. Every
 * other namespace is reserved.
 */
import * as fs from "node:fs/promises";
import type { ShellCommandRequest, ShellCommandResult } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { adoptService, listServices, serviceStatus, serviceUnitLogPath, stopService } from "./services";

/** Name of the embedded shell's control command. */
export const O2CTL_COMMAND = "o2ctl";

const USAGE = `usage: o2ctl services add <name> <pid|%job>   keep a running process as service <name>, without restarting it
       o2ctl services ls                      list the services of this project
       o2ctl services stop <name>             stop service <name> and its process tree
`;

function usage(message: string): ShellCommandResult {
	return { stdout: "", stderr: `o2ctl: ${message}\n${USAGE}`, exitCode: 2 };
}

function help(): ShellCommandResult {
	return { stdout: USAGE, stderr: "", exitCode: 0 };
}

/** The pid `target` names: a decimal pid, or a job spec of the calling shell that runs a program. */
function targetPid(target: string, request: ShellCommandRequest): number {
	if (/^\d+$/.test(target)) return Number(target);
	if (target.startsWith("%")) {
		const pid = request.jobs?.[target];
		if (pid === undefined) throw new Error(`${target}: no job of this shell runs a program by that spec`);
		return pid;
	}
	throw new Error(`${target}: not a pid or a %job spec`);
}

/** Where an adopted service's output comes from, read back from its unit log link. */
async function adoptedOutput(logPath: string): Promise<string | undefined> {
	try {
		return await fs.readlink(logPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Serve one `o2ctl` invocation of the embedded shell; failures reject with their reason. */
export async function runO2ctlCommand(
	session: ToolSession,
	request: ShellCommandRequest,
	signal?: AbortSignal,
): Promise<ShellCommandResult> {
	const [namespace, ...rest] = request.argv;
	switch (namespace) {
		case "services":
			return services(session, rest, request, signal);
		case "-h":
		case "--help":
		case "help":
			return help();
		case undefined:
			return usage("missing namespace");
		default:
			return usage(`unknown namespace \`${namespace}\` (only \`services\` exists)`);
	}
}

/** `o2ctl services <action> …`: adopt, list, or stop the project's services. */
async function services(
	session: ToolSession,
	argv: readonly string[],
	request: ShellCommandRequest,
	signal: AbortSignal | undefined,
): Promise<ShellCommandResult> {
	const [action, ...rest] = argv;
	switch (action) {
		case "add": {
			if (rest.length !== 2) return usage("services add takes a service name and a pid or %job");
			const [name, target] = rest as [string, string];
			const unit = await adoptService(session, name, targetPid(target, request), signal);
			const output = await adoptedOutput(serviceUnitLogPath(unit));
			const source =
				output === undefined
					? "no output: its stdout and stderr are not regular files"
					: `output: ${output} (read proc://${name})`;
			return { stdout: `${serviceStatus(unit)}\n${source}\n`, stderr: "", exitCode: 0 };
		}
		case "ls": {
			if (rest.length !== 0) return usage("services ls takes no arguments");
			const units = await listServices(session, signal);
			const text = units.length === 0 ? "No services\n" : `${units.map(serviceStatus).join("\n")}\n`;
			return { stdout: text, stderr: "", exitCode: 0 };
		}
		case "stop": {
			if (rest.length !== 1) return usage("services stop takes a service name");
			const unit = await stopService(session, rest[0]!, signal);
			return { stdout: `${serviceStatus(unit)}\n`, stderr: "", exitCode: 0 };
		}
		case "-h":
		case "--help":
		case "help":
			return help();
		case undefined:
			return usage("services: missing subcommand");
		default:
			return usage(`services: unknown subcommand \`${action}\``);
	}
}
