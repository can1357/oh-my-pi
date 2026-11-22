/**
 * What a tool card says about a run the OS sandbox contained (bash, eval):
 * the badge's title and the warnings for hosts the egress proxy refused, a
 * likely filesystem denial, and a program the Windows sandbox cannot start.
 * Pure text; the presenters (`src/ui/tools/sandbox-meta.tsx`) make nodes of it.
 */
import { plainLine } from "../../extensibility/inventory/display-text";
import type { SandboxResultMeta } from "../../sandbox/types";

/** The head badge's text on a contained run. */
export const SANDBOX_BADGE_TEXT = "sandboxed";

/** The badge's title: backend, mode and network. */
export function sandboxBadgeTitle(meta: SandboxResultMeta): string {
	return `${plainLine(meta.backend)} · ${meta.mode} · network ${meta.network}`;
}

/** Plain, sanitized warning texts: refused hosts, a likely denial, then a program that cannot start contained. */
export function sandboxNotes(meta: SandboxResultMeta | undefined): string[] {
	if (!meta) return [];
	const notes: string[] = [];
	const hosts = (meta.blockedHosts ?? []).map(plainLine).filter(host => host.length > 0);
	if (hosts.length > 0) notes.push(`blocked by sandbox: ${hosts.length === 1 ? "host" : "hosts"} ${hosts.join(", ")}`);
	if (meta.denied === true) notes.push("possible sandbox denial");
	if (meta.startFailed === true) notes.push("cannot start in the Windows sandbox");
	return notes;
}
