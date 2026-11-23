/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

/** Binary Ninja install directory holding the core library; blank auto-detects. */
export const cfgBinjaInstallDir = register({
	id: "binja.installDir",
	type: "string",
	default: "",
	ui: {
		tab: "tools",
		group: "Binary Ninja",
		label: "Binary Ninja Install Dir",
		description:
			"Directory containing the Binary Ninja core library, or the macOS .app bundle; empty uses $BN_INSTALL_DIR, the lastrun file in the Binary Ninja user folder, then the default install locations",
	},
});

/** Python interpreter that runs the Binary Ninja worker; blank auto-detects. */
export const cfgBinjaPython = register({
	id: "binja.python",
	type: "string",
	default: "",
	ui: {
		tab: "tools",
		group: "Binary Ninja",
		label: "Binary Ninja Python",
		description:
			"Python 3 interpreter that can load the Binary Ninja API from the install's python directory; empty auto-detects",
	},
});
