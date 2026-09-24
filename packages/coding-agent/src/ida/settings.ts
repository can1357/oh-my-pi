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
