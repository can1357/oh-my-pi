/**
 * CLI handler for `omp collab list` — enumerate live local Collab hosts.
 *
 * Queries the runtime host registry (`src/collab/registry.ts`); never touches
 * the relay and never reads room secrets from disk (hosts return their URLs
 * over authenticated local IPC). Default output prints write-capable URLs.
 */
import { formatAge } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabAccessMode,
	type CollabHostSnapshot,
	type CollabListOptions,
	listCollabHosts,
} from "../collab/registry";
import { shortenPath } from "../tools/render-utils";

export interface CollabListCommandArgs {
	/** Request view-only URLs instead of write-capable URLs. */
	view: boolean;
	/** Emit deterministic machine-readable JSON. */
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

/** Versioned top-level JSON shape for `omp collab list --json`. */
export interface CollabListJsonOutput {
	version: number;
	mode: CollabAccessMode;
	hosts: CollabHostSnapshot[];
}

export async function runCollabListCommand(
	args: CollabListCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const mode: CollabAccessMode = args.view ? "view" : "write";
	const hosts = await listCollabHosts({ ...args.registry, mode });

	if (args.json) {
		const output: CollabListJsonOutput = { version: COLLAB_REGISTRY_VERSION, mode, hosts };
		print(JSON.stringify(output, null, 2));
		return;
	}

	if (hosts.length === 0) {
		print(chalk.dim("No active Collab hosts."));
		return;
	}

	const plural = hosts.length === 1 ? "host" : "hosts";
	// Same shape as the TUI adapter: green count, dim capability note.
	const note =
		mode === "write" ? "(write URLs — anyone with one can prompt and control the host agent)" : "(view-only URLs)";
	print(`${chalk.green(`${hosts.length} active Collab ${plural}`)} ${chalk.dim(note)}`);
	for (const host of hosts) {
		const label = host.mode === "write" ? chalk.yellow("write") : chalk.green("view ");
		const session = host.sessionName ? `${host.sessionName} (${host.sessionId})` : host.sessionId;
		const guests = host.participants - 1;
		const details = [
			`pid ${host.pid}`,
			`started ${formatAge(Math.round((Date.now() - host.startedAt) / 1000)) || "just now"}`,
			`${guests} ${guests === 1 ? "guest" : "guests"}`,
		].join(" · ");
		print("");
		print(`${label}  ${session}  ${chalk.dim(shortenPath(host.cwd))}`);
		print(`       ${chalk.dim(details)}`);
		print(`       ${host.url}`);
	}
}
