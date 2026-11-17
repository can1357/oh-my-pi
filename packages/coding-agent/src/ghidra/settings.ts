import { register } from "../config/registry";

/** Ghidra 12+ install override; blank discovers an install or provisions the managed release. */
export const cfgGhidraInstallDir = register({
	id: "ghidra.installDir",
	type: "string",
	default: "",
	ui: {
		tab: "tools",
		group: "Ghidra",
		label: "Ghidra Install Dir",
		description:
			"Ghidra 12+ install directory (contains Ghidra/application.properties); empty uses $GHIDRA_INSTALL_DIR, Homebrew, else a managed download under ~/.omp/ghidra",
	},
});

/** Python override that imports PyGhidra; blank provisions a venv from the install's wheels. */
export const cfgGhidraPython = register({
	id: "ghidra.python",
	type: "string",
	default: "",
	ui: {
		tab: "tools",
		group: "Ghidra",
		label: "Ghidra Python",
		description:
			"Python interpreter that can import pyghidra; empty uses a managed venv built from the install's bundled wheels",
	},
});
