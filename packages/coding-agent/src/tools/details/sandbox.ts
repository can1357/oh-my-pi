/**
 * What a tool card says about a run the OS sandbox contained (bash, eval):
 * the badge's title and the warnings for hosts the egress proxy refused, a
 * network that is off, a likely filesystem denial, and a program the Windows
 * sandbox cannot start.
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

/**
 * Plain, sanitized warning texts, in the order of the notice the model gets (`sandbox/denial-notice.ts`):
 * refused hosts, a network that is off, a likely filesystem denial, then a program that cannot start
 * contained. Hosts refused to the call's own processes (`ownBlockedHosts`) are named whether or not the
 * call `failed`; those attributed only by time (`blockedHosts`) only when it did.
 */
export function sandboxNotes(meta: SandboxResultMeta | undefined, failed: boolean): string[] {
	if (!meta) return [];
	const notes: string[] = [];
	const refused = failed
		? [...(meta.ownBlockedHosts ?? []), ...(meta.blockedHosts ?? [])]
		: (meta.ownBlockedHosts ?? []);
	const hosts = [...new Set(refused.map(plainLine).filter(host => host.length > 0))];
	if (hosts.length > 0) notes.push(`blocked by sandbox: ${hosts.length === 1 ? "host" : "hosts"} ${hosts.join(", ")}`);
	if (meta.networkOff === true) notes.push("network is off in the sandbox: this failure likely comes from it");
	if (meta.denied === true) notes.push("possible sandbox denial");
	if (meta.startFailed === true) notes.push("cannot start in the Windows sandbox");
	return notes;
}

/** Whether `line` is the sandbox notice the tools append to a result (`[OS sandbox: …]`, one line). */
export function isSandboxNoticeLine(line: string): boolean {
	return line.startsWith("[OS sandbox:") && line.endsWith("]");
}
