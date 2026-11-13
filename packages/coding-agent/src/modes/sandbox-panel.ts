/**
 * The `/sandbox` panel's data and writes, and the host-approval prompt, kept
 * apart from the controllers so they run against any {@link Settings}.
 *
 * Writes go to the global layer through the settings API `/settings` uses.
 * Scope and the lists are read from (and edited against) the operator layers
 * only: a project-supplied entry is never promoted to global config.
 */
import type { SettingProvenance, Settings } from "../config/settings";
import type { ExtensionApprovalAnswer, ExtensionApprovalPrompt } from "../extensibility/extensions/types";
import { readSandboxConfig, type ResolvedFsPolicy } from "../sandbox/policy";
import {
	type HostApproval,
	type SandboxAccessRequest,
	type SandboxRuntime,
	type SandboxStatus,
	sandboxAccessEffect,
} from "../sandbox/runtime";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowRead,
	cfgSandboxAllowWrite,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
	cfgSandboxReadScope,
	cfgSandboxScope,
} from "../sandbox/settings";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type {
	SandboxConfigModel,
	SandboxListId,
	SandboxSettingChange,
	SandboxSettingId,
} from "@oh-my-pi/pi-tui/overlays/sandbox-config";
import type { SandboxAccessView } from "@oh-my-pi/pi-tui/overlays/sandbox-access-dialog";

/** The list settings the panel edits. */
const LIST_SETTINGS = {
	allowWrite: cfgSandboxAllowWrite,
	allowRead: cfgSandboxAllowRead,
	denyRead: cfgSandboxDenyRead,
	allowedHosts: cfgSandboxAllowedHosts,
} as const satisfies Record<SandboxListId, unknown>;

/** The non-list settings the panel edits (scope is a multi-choice). */
const VALUE_SETTINGS = {
	enabled: cfgSandboxEnabled,
	mode: cfgSandboxMode,
	scope: cfgSandboxScope,
	fallback: cfgSandboxFallback,
	readScope: cfgSandboxReadScope,
	networkMode: cfgSandboxNetworkMode,
} as const satisfies Record<SandboxSettingId, unknown>;

const LOCK_TIGHTENED = "Tightened by project config";

/** How a settings layer is named in user-facing text. */
export function sandboxLayerName(provenance: SettingProvenance): string {
	switch (provenance) {
		case "env":
			return "$PI_SANDBOX";
		case "runtime":
			return "a session override";
		case "overlay":
			return "the --config file";
		case "project":
			return "project config";
		case "global":
			return "your config";
		case "default":
			return "the default";
	}
}

/**
 * The panel's data: effective scalars (after the project-may-only-tighten rule), scope and the
 * lists as the operator layers hold them, the settings this panel cannot change here, and the
 * runtime's view. RPC's `get_sandbox` snapshot is built from it too.
 */
export function sandboxPanelModel(
	settings: Settings,
	runtime: Pick<SandboxRuntime, "status" | "effectivePolicy" | "blockedHosts" | "sessionPaths">,
): SandboxConfigModel & { readonly status: SandboxStatus; readonly effective: ResolvedFsPolicy } {
	const config = readSandboxConfig(settings);
	const operator = settings.grantAuthority();
	const locked: Partial<Record<SandboxSettingId | SandboxListId, string>> = {};
	const every = { ...VALUE_SETTINGS, ...LIST_SETTINGS };
	for (const id of Object.keys(every) as (keyof typeof every)[]) {
		// A global write is shadowed by these layers: the panel edit would be a silent no-op.
		const provenance = every[id].provenance(settings);
		if (provenance === "env" || provenance === "runtime" || provenance === "overlay") {
			locked[id] = `Set by ${sandboxLayerName(provenance)}`;
		}
	}
	for (const id of ["enabled", "mode", "fallback", "readScope", "networkMode"] as const) {
		if (!locked[id] && VALUE_SETTINGS[id].get(operator) !== config[id]) locked[id] = LOCK_TIGHTENED;
	}
	const lists = {
		allowWrite: cfgSandboxAllowWrite.get(operator),
		allowRead: cfgSandboxAllowRead.get(operator),
		denyRead: cfgSandboxDenyRead.get(operator),
		allowedHosts: cfgSandboxAllowedHosts.get(operator),
	};
	const listNotes: Partial<Record<SandboxListId, string>> = {};
	for (const list of ["allowWrite", "allowRead", "allowedHosts"] as const) {
		const dropped = lists[list].length - config[list].length;
		if (dropped > 0) {
			listNotes[list] =
				`Project config narrows this list here: ${dropped} ${dropped === 1 ? "entry does" : "entries do"} not apply.`;
		}
	}
	const added = config.denyRead.length - lists.denyRead.length;
	if (added > 0) listNotes.denyRead = `Project config denies ${added} more path${added === 1 ? "" : "s"} here.`;
	return {
		status: runtime.status(),
		enabled: config.enabled,
		mode: config.mode,
		fallback: config.fallback,
		readScope: config.readScope,
		networkMode: config.networkMode,
		scope: cfgSandboxScope.get(operator),
		...lists,
		ignored: config.ignored,
		locked,
		listNotes,
		effective: runtime.effectivePolicy(),
		blockedHosts: runtime.blockedHosts(),
		sessionPaths: runtime.sessionPaths(),
	};
}

/** Write one scalar change to the global layer. */
export function applySandboxChange(settings: Settings, change: SandboxSettingChange): void {
	switch (change.id) {
		case "enabled":
			cfgSandboxEnabled.set(settings, change.value);
			return;
		case "mode":
			cfgSandboxMode.set(settings, change.value);
			return;
		case "scope":
			cfgSandboxScope.set(settings, [...change.value]);
			return;
		case "fallback":
			cfgSandboxFallback.set(settings, change.value);
			return;
		case "readScope":
			cfgSandboxReadScope.set(settings, change.value);
			return;
		case "networkMode":
			cfgSandboxNetworkMode.set(settings, change.value);
			return;
	}
}

/** Drop the global value of `id`, so another layer or the default applies. */
export function resetSandboxSetting(settings: Settings, id: SandboxSettingId | SandboxListId): void {
	if (Object.hasOwn(LIST_SETTINGS, id)) LIST_SETTINGS[id as SandboxListId].unset(settings);
	else VALUE_SETTINGS[id as SandboxSettingId].unset(settings);
}

/** Replace the global value of `list` with `entries`. */
export function setSandboxList(settings: Settings, list: SandboxListId, entries: readonly string[]): void {
	LIST_SETTINGS[list].set(settings, [...entries]);
}

/** Add (`member`) or remove `entry` in the global value of `list`; a no-op change writes nothing. */
export function setSandboxListMember(settings: Settings, list: SandboxListId, entry: string, member: boolean): void {
	LIST_SETTINGS[list].setMember(settings, entry, { member });
}

/** The approval prompt for a contained command connecting to a host off the allowlist. */
export function sandboxHostPrompt(host: string, port: number): ExtensionApprovalPrompt {
	const name = sanitizeDisplayLine(host);
	const headline = `A sandboxed command wants to connect to ${name}:${port}, which is not on the network allowlist.`;
	return {
		full: headline,
		compact: headline,
		grants: [{ scope: "target", label: `Allow ${name} for this session`, alwaysLabel: `Always allow ${name}` }],
	};
}

/**
 * What the access dialog shows for `request`: its fields (untrusted; the dialog sanitizes and
 * bounds them) and the effect sentence omp computes, never the agent's.
 */
export function sandboxAccessView(request: SandboxAccessRequest): SandboxAccessView {
	return {
		kind: request.kind,
		target: request.target,
		intent: request.intent,
		command: request.command,
		alternative: request.alternative,
		effect: sandboxAccessEffect(request.kind, request.target),
		canAlways: request.canAlways,
	};
}

/** The runtime's answer for an approval-dialog answer: the grant remembers for the session or always. */
export function hostApprovalFor(answer: ExtensionApprovalAnswer): HostApproval {
	if (answer === "once" || answer === "session") return answer;
	if (typeof answer === "object") return answer.always ? "always" : "session";
	return "deny";
}
