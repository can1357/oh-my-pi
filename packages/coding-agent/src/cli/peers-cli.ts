/** One-shot peer discovery and messaging without publishing a receiver. */
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { LocalEndpointRegistry } from "../ipc/local-endpoint-registry";
import { formatPeerRow } from "../mailbox/peer-rows";
import { MailboxService } from "../mailbox/service";
import { AgentRegistry } from "../registry/agent-registry";

export type PeersCommandArgs = ({ action: "list"; json: boolean } | { action: "send"; to: string; body: string }) & {
	/** Registry override for endpoint-backed tests. */
	registry?: LocalEndpointRegistry;
};

export async function runPeersCommand(
	args: PeersCommandArgs,
	print: (line: string) => void = line => console.log(line),
	printError: (line: string) => void = line => process.stderr.write(`${line}\n`),
): Promise<number> {
	const service = new MailboxService({ agentRegistry: new AgentRegistry(), registry: args.registry });
	try {
		service.initialize(getProjectDir());
		service.bindTarget({
			agentId: "Main",
			conversation: null,
			settings: Settings.isolated({ "irc.crossProcess": true }),
			receive: false,
			describe: () => ({ title: null, busy: false }),
		});
		await service.whenSettled();
		if (args.action === "list") {
			const peers = await service.listPeers();
			if (args.json) {
				print(JSON.stringify(peers, null, 2));
			} else if (peers.length === 0) {
				print("No other omp processes have peers on.");
			} else {
				for (const peer of peers) print(formatPeerRow(peer));
			}
			return 0;
		}

		const receipt = await service.send({
			id: Bun.randomUUIDv7(),
			ts: Date.now(),
			from: "Main",
			to: args.to,
			body: args.body,
		});
		if (receipt.outcome === "failed") {
			printError(sanitizeDisplayLine(receipt.error ?? `Delivery to ${args.to} failed.`));
			return 1;
		}
		print(`Delivered to ${sanitizeDisplayLine(args.to)} (${receipt.outcome}).`);
		return 0;
	} finally {
		await service.close();
	}
}
