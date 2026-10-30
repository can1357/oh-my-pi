/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

/** Whether `read` opens executables in IDA Pro and the `ida` tool is enabled. */
export const cfgIdaEnabled = register({
	id: "ida.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "IDA Pro",
		description:
			"Open executables read with `read` in IDA Pro (idalib) and enable the `ida` tool; inert when no IDA install is found",
	},
});

/** Python interpreter that can import ida_domain and idapro; blank auto-detects. */
export const cfgIdaPython = register({
	id: "ida.python",
	type: "string",
	default: "",
	ui: {
		tab: "tools",
		group: "IDA Pro",
		label: "IDA Python",
		description: "Python interpreter that can import ida_domain and idapro; empty auto-detects",
	},
});

/** IDA install directory containing libidalib; blank auto-detects. */
export const cfgIdaInstallDir = register({
	id: "ida.installDir",
	type: "string",
	default: "",
	ui: {
		tab: "tools",
		group: "IDA Pro",
		label: "IDA Install Dir",
		description:
			"Directory containing libidalib, exported as IDADIR; empty auto-detects ($IDADIR, ida-config.json, standard install paths)",
	},
});

/** Most IDA host daemons open at once per project; opening another evicts the least recently used idle one. */
export const cfgIdaMaxOpen = register({
	id: "ida.maxOpen",
	type: "number",
	default: 4,
	ui: {
		tab: "tools",
		group: "IDA Pro",
		label: "IDA Max Open Databases",
		description:
			"Most IDA databases (omp.ida.* daemons in omp ps) open at once per project; opening another saves and closes the least recently used idle one",
		options: [
			{ value: "2", label: "2" },
			{ value: "4", label: "4" },
			{ value: "8", label: "8" },
			{ value: "16", label: "16" },
		],
	},
});

/** Idle seconds after which an IDA database is saved and closed; 0 keeps it open. */
export const cfgIdaIdleCloseSec = register({
	id: "ida.idleCloseSec",
	type: "number",
	default: 900,
	ui: {
		tab: "tools",
		group: "IDA Pro",
		label: "IDA Idle Close Timeout",
		description:
			"Save and close IDA databases idle longer than this many seconds (0 = never); the exec namespace resets on reopen",
		options: [
			{ value: "0", label: "Never" },
			{ value: "300", label: "5 minutes" },
			{ value: "900", label: "15 minutes" },
			{ value: "1800", label: "30 minutes" },
			{ value: "3600", label: "1 hour" },
		],
	},
});
