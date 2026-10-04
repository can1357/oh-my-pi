import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { MailboxPeer } from "./service";

/** Safe, single-line peer roster row shared by the slash command and CLI. */
export function formatPeerRow(peer: MailboxPeer, width = TRUNCATE_LENGTHS.LINE): string {
	return truncateToWidth(
		`${sanitizeDisplayLine(peer.address)}${peer.alias ? ` (${sanitizeDisplayLine(peer.alias)})` : ""}  ${shortenPath(sanitizeDisplayLine(peer.cwd))}${peer.title ? `  "${sanitizeDisplayLine(peer.title)}"` : ""}  ${peer.busy ? "busy" : "idle"}`,
		width,
	);
}
