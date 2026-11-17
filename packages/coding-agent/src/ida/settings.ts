/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

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
