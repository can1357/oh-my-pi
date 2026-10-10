/**
 * List running session hosts (`omp --mode host`) from the local registry, or attach this terminal to one:
 * `omp attach <host id | session id | session path>` opens the TUI as a client of that host, starting a host for a
 * session none runs.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs, reportCliUsageError } from "../cli/args";
import { attachHelp as commandHelp } from "../cli/command-help";
import { runRootCommand } from "../main";
import { formatHostTable } from "../session-host/host-row";
import { listSessionHosts } from "../session-host/registry";

export default class Attach extends Command {
	static description = commandHelp.description;

	static args = {
		target: Args.string({
			description: "Host id, session id, or session path; omit to list running hosts",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Print hosts as JSON" }),
	};

	static examples = ["omp attach", "omp attach --json", "omp attach <hostId>", "omp attach <sessionId>"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Attach);
		if (args.target !== undefined) {
			if (flags.json) throw new CliUsageError("--json lists session hosts and takes no target");
			await this.#attach(args.target);
			return;
		}
		// The registry token is a bearer credential: never print it.
		const hosts = (await listSessionHosts()).map(({ token: _token, ...rest }) => rest);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(hosts)}\n`);
			return;
		}
		if (hosts.length === 0) {
			process.stdout.write("No session hosts running.\n");
			return;
		}
		for (const line of formatHostTable(hosts)) process.stdout.write(`${line}\n`);
	}

	async #attach(target: string): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			process.stderr.write(`${APP_NAME} attach <target> requires an interactive terminal\n`);
			process.exitCode = 1;
			return;
		}
		const parsed = parseArgs([]);
		parsed.attach = target;
		try {
			await runRootCommand(parsed, []);
		} catch (error) {
			// Startup failures may leave live handles (theme watcher, stores): exit instead of draining.
			if (reportCliUsageError(error)) process.exit(2);
			throw error;
		}
	}
}
