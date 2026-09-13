/**
 * CLI handlers for local Collab discovery and explicit link retrieval.
 * Listing returns metadata only; capabilities travel over authenticated IPC
 * only when a caller requests a link.
 */
import { formatAge } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostSnapshot,
	type CollabListOptions,
	type CollabResolvedLink,
	listCollabHosts,
	resolveCollabHostLink,
} from "../collab/registry";
import { sanitizeDisplayLine } from "../modes/components/extensions/display-text";
import { shortenPath } from "../tools/render-utils";

export interface CollabListCommandArgs {
	/** Emit deterministic machine-readable JSON. */
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

export interface CollabLinkCommandArgs {
	selector: string;
	/** Request a view-only link instead of control access. */
	view: boolean;
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

/** Versioned top-level JSON shape for `omp collab list --json`. */
export interface CollabListJsonOutput {
	version: number;
	hosts: CollabHostSnapshot[];
}

/** Versioned capability response for `omp collab link --json`. */
export interface CollabLinkJsonOutput extends CollabResolvedLink {
	version: number;
}

export async function runCollabListCommand(
	args: CollabListCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const hosts = await listCollabHosts(args.registry);
	if (args.json) {
		const output: CollabListJsonOutput = { version: COLLAB_REGISTRY_VERSION, hosts };
		print(JSON.stringify(output, null, 2));
		return;
	}

	if (hosts.length === 0) {
		print(chalk.dim("No active Collab hosts."));
		return;
	}

	print(chalk.green(`${hosts.length} active Collab ${hosts.length === 1 ? "host" : "hosts"}`));
	for (const host of hosts) {
		// Session names and POSIX paths come from other processes and may carry
		// tabs, newlines, or escape bytes; keep each on one clean line.
		const name = host.sessionName ? sanitizeDisplayLine(host.sessionName) : "";
		const session = name ? `${name} (${host.sessionId})` : host.sessionId;
		const cwd = sanitizeDisplayLine(shortenPath(host.cwd));
		const guests = host.participants - 1;
		const details = [
			`pid ${host.pid}`,
			`gen ${host.generation}`,
			host.model ? `${host.model.provider}/${host.model.id}` : "no model",
			`started ${formatAge(Math.round((Date.now() - host.startedAt) / 1000)) || "just now"}`,
			`${guests} ${guests === 1 ? "guest" : "guests"}`,
			host.access,
			`relay ${host.relayConnected ? "connected" : "reconnecting"}`,
		];
		if (host.inputRequired) details.push("input required");
		print("");
		print(`${host.instanceId}  ${session}  ${chalk.dim(cwd)}`);
		print(`  ${chalk.dim(details.join(" · "))}`);
	}
	print(chalk.dim("Get a link: omp collab link <instanceId|pid> [--view]"));
}

export async function runCollabLinkCommand(
	args: CollabLinkCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const link = await resolveCollabHostLink(args.selector, args.view ? "view" : "control", args.registry);
	if (args.json) {
		const output: CollabLinkJsonOutput = { version: COLLAB_REGISTRY_VERSION, ...link };
		print(JSON.stringify(output, null, 2));
		return;
	}
	print(link.url);
}
