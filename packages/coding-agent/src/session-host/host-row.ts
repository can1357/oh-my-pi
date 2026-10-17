import { renderTableRow, type TableColumn, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type { SessionHostEntry } from "./registry";

type HostRowFields = Pick<SessionHostEntry, "hostId" | "clients" | "busy" | "cwd" | "title" | "sessionFile">;

const HOST_TABLE_HEADER = ["HOST ID", "CLIENTS", "STATE", "DIRECTORY", "SESSION"] as const;

/**
 * The cells of one live host. `title`, `sessionFile`, and `cwd` come from an entry another process wrote: control
 * sequences and newlines are stripped so a hostile entry cannot forge rows.
 */
function hostCells(host: HostRowFields): string[] {
	return [
		host.hostId,
		String(host.clients),
		host.busy ? "busy" : "idle",
		sanitizeDisplayLine(host.cwd),
		sanitizeDisplayLine(host.title ?? host.sessionFile ?? "(new session)"),
	];
}

/** One line per live host, for the `/attach` selector. */
export function formatHostRow(host: HostRowFields): string {
	return hostCells(host).join("  ");
}

/** `omp attach`: a header line, then one aligned line per live host. */
export function formatHostTable(hosts: readonly HostRowFields[]): string[] {
	const rows: (readonly string[])[] = [HOST_TABLE_HEADER, ...hosts.map(hostCells)];
	const last = HOST_TABLE_HEADER.length - 1;
	const columns: TableColumn[] = HOST_TABLE_HEADER.map((_, index) => ({
		// The last column is never padded, so lines carry no trailing spaces.
		width: index === last ? 0 : Math.max(...rows.map(row => visibleWidth(row[index]))),
		align: index === 1 ? "right" : "left",
		overflow: "allow",
	}));
	return rows.map(row =>
		renderTableRow(
			row.map(text => ({ text })),
			columns,
			undefined,
			{ gap: "  ", fit: false },
		),
	);
}
