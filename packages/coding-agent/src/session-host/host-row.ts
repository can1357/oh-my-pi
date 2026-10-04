import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type { SessionHostEntry } from "./registry";

/**
 * One line per live host, for `omp attach` and the `/attach` selector. `title`, `sessionFile`, and `cwd` come from an
 * entry another process wrote: control sequences and newlines are stripped so a hostile entry cannot forge rows.
 */
export function formatHostRow(
	host: Pick<SessionHostEntry, "hostId" | "clients" | "busy" | "cwd" | "title" | "sessionFile">,
): string {
	const label = sanitizeDisplayLine(host.title ?? host.sessionFile ?? "(new session)");
	const cwd = sanitizeDisplayLine(host.cwd);
	return `${host.hostId}  ${host.clients}  ${host.busy ? "busy" : "idle"}  ${cwd}  ${label}`;
}
