/**
 * Tool-card presentation of a run contained by the OS sandbox, shared by the
 * bash and eval renderers: the head badge, and the warnings for hosts the
 * egress proxy refused, a likely filesystem denial, and a program the
 * Windows sandbox cannot start.
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import { keyed } from "../native/describe";
import type { NativeNode } from "../native/node";
import { plainLine } from "../native/spans";
import type { Theme } from "../theme/theme";
import { noteText } from "./native-view";

/** The sandbox a run was contained by (structurally the coding agent's `SandboxResultMeta`). */
export interface ToolSandboxMeta {
	backend: string;
	mode: "workspace-write" | "read-only";
	network: "allowlist" | "deny" | "allow";
	/** Hosts the egress proxy refused during this call. */
	blockedHosts?: string[];
	/** The output looks like a filesystem denial by the sandbox. */
	denied?: boolean;
	/** Windows: a program exited with STATUS_DLL_INIT_FAILED (0xC0000142), how a program the sandbox cannot host fails to start. */
	startFailed?: boolean;
}

/** The `sandboxed` head badge; its title names backend, mode and network. */
export function sandboxBadge(meta: ToolSandboxMeta): { text: string; tone: TspTone; title: string } {
	return {
		text: "sandboxed",
		tone: "info",
		title: `${plainLine(meta.backend)} · ${meta.mode} · network ${meta.network}`,
	};
}

/** Plain, sanitized warning texts: refused hosts, a likely denial, then a program that cannot start contained. */
function sandboxNotes(meta: ToolSandboxMeta | undefined): string[] {
	if (!meta) return [];
	const notes: string[] = [];
	const hosts = (meta.blockedHosts ?? []).map(host => plainLine(host)).filter(host => host.length > 0);
	if (hosts.length > 0) notes.push(`blocked by sandbox: ${hosts.length === 1 ? "host" : "hosts"} ${hosts.join(", ")}`);
	if (meta.denied === true) notes.push("possible sandbox denial");
	if (meta.startFailed === true) notes.push("cannot start in the Windows sandbox (0xC0000142)");
	return notes;
}

/** The warnings as keyed `text` nodes for a native body. */
export function sandboxNoteNodes(meta: ToolSandboxMeta | undefined): NativeNode[] {
	return sandboxNotes(meta).map((note, index) => keyed(noteText(note, "warning"), `sandbox-${index}`));
}

/** The warnings as warning-coloured ANSI lines, wrapped to `width` (unwrapped without one, for a wrapping `Text`). */
export function sandboxNoteLines(meta: ToolSandboxMeta | undefined, uiTheme: Theme, width?: number): string[] {
	const lines: string[] = [];
	for (const note of sandboxNotes(meta)) {
		const wrapped = width === undefined ? [note] : Bun.wrapAnsi(note, Math.max(1, width), { hard: true }).split("\n");
		for (const line of wrapped) lines.push(uiTheme.fg("warning", line));
	}
	return lines;
}
